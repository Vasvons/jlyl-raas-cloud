import { Page } from 'playwright';
import * as logger from '../logger';
import { BasePlatformAdapter } from './baseAdapter';
import { smartFindLongestContent } from '../indexedInteractor';

/**
 * v3.21.6: Node 侧按 page 捕获的豆包宿主签名 query。
 *
 * 页面内 XHR hook 有两个致命盲区：注入时机晚于页面加载期请求、iframe 内请求拦截不到。
 * Node 侧 page.on('request') 天然覆盖所有 frame 的所有请求，且查询发送阶段的
 * /im/ 业务请求（建会话/发消息，均带宿主签名）发生在 afterNavigate 之后，必被捕获。
 */
const doubaoSignByPage = new WeakMap<Page, string>();

/**
 * v3.21.7: Node 侧按 page 捕获的豆包正式会话 ID 列表（新的在前，最多 5 个）。
 *
 * 实地日志（2026-08-21 22:02）：Worker 页面 URL 停留在 /chat/local_xxx（客户端临时会话），
 * share_token API 接受 local_ ID 但 save API 返回 621000001 系统内部错误——
 * save 需要服务端正式会话 ID（发消息后由服务端创建，前端通过 /im/ API 响应返回）。
 * 从两个来源捕获正式 ID：
 *   1. /im/ 请求 URL query 里的 conversation_id/conv_id（消息同步请求会带）
 *   2. /im/ POST 响应体里的 conversation_id/conv_id 字段
 * 只保留非 local_ 开头的值；extractShareLink 时逐候选试 save。
 */
const doubaoConvIdsByPage = new WeakMap<Page, string[]>();

/** 豆包适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 输入框：textarea.semi-input-textarea 或 textarea[data-testid="chat_input_input"]
 * - 发送按钮：div.send-btn-wrapper button（需要点击发送，而非按Enter）
 * - 停止按钮：div[class*="break-btn"]（圆形break按钮）
 */
export class DoubaoAdapter extends BasePlatformAdapter {
  platformName = '豆包';
  loginUrl = 'https://www.doubao.com/';
  chatUrl = 'https://www.doubao.com/chat/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 XPath
  protected inputSelector = 'textarea.semi-input-textarea, textarea[data-testid="chat_input_input"], [data-testid="chat_input"] textarea, [class*="chat-input"] textarea, [class*="input-area"] textarea, textarea';
  // 响应选择器：豆包的消息内容容器
  // 历史问题：[data-testid="message_text_content"] 偶发匹配不到，走兜底被截断到 10000
  // 改进：覆盖更多选择器，加上 [class*="flow-markdown"] 和 div[data-testid] 的通用匹配
  // 如果都匹配不到，baseAdapter 的兜底会用 smartFindLongestContent 找最长文本
  protected responseSelector = '[data-testid="receive_message"], [class*="receive-message"], [class*="message-content"], [class*="message_text"], [data-testid="message_text_content"], [class*="answer"], [class*="bubble-content"], [class*="chat-content"], [class*="flow-markdown"], [class*="markdown-body"], [class*="render-content"], div[class*="content-wrapper"]';
  // 停止按钮：参考 auth helper 的 div[class*="break-btn"]
  protected stopButtonSelector = '[class*="break-btn"], [data-testid="stop_button"], .stop-btn, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'login';

  /**
   * v3.20.x: 导航到聊天页后注入签名捕获 hook。
   *
   * 豆包分享 API（/im/message/share/share_token、/share/save）必须在 URL query 带上
   * 宿主签名（device_id/web_id/tea_uuid/aid/version_code/web_tab_id 等），否则返回"参数非法"。
   * 这些签名参数在豆包自身所有 /im/ 业务请求的 URL query 里都存在。
   * 这里注入 XHR open 拦截：捕获任何 /im/ 请求 URL 的 query，存到 window.__dbSignQuery
   * 和 localStorage['__db_sign']，供 createDoubaoShareLinkViaApi 复用。
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // v3.21.6: Node 侧 page.on('request') 捕获签名（主通道，最可靠）。
    // 查询发送阶段的 /im/ 业务请求（建会话/发消息）都带宿主签名 query，
    // 这些请求发生在 afterNavigate 之后（输入→提交阶段），listener 必然覆盖；
    // 且 page.on('request') 天然覆盖所有 frame（含 iframe），无注入时机/跨 frame 问题。
    // 捕获条件放宽到「任意含 version_code= 的 doubao 请求」——宿主签名是全局级的，
    // 实测（2026-08-21）任意业务请求的 query 复用即可通过 share API 校验。
    try {
      page.on('request', (req: any) => {
        try {
          const u: string = req.url() || '';
          if (u.includes('version_code=') && (u.includes('/im/') || u.includes('/samantha/') || u.includes('/alice/'))) {
            const q = u.slice(u.indexOf('?') + 1);
            if (q) doubaoSignByPage.set(page, q);
          }
          // v3.21.7: 从 /im/ 请求 URL query 捕获正式会话 ID（消息同步请求会带）
          const m = u.match(/[?&](?:conversation_id|conv_id)=([A-Za-z0-9_-]{10,})/);
          if (m && !m[1].startsWith('local_')) {
            const arr = doubaoConvIdsByPage.get(page) || [];
            if (!arr.includes(m[1])) {
              arr.unshift(m[1]);
              if (arr.length > 5) arr.pop();
              doubaoConvIdsByPage.set(page, arr);
            }
          }
        } catch { /* 忽略 */ }
      });
    } catch { /* 忽略 */ }

    // v3.21.7: 从 /im/ POST 响应体捕获正式会话 ID（发消息的响应里带服务端生成的真实 ID）
    try {
      page.on('response', async (resp: any) => {
        try {
          const req = resp.request();
          if (req.method() !== 'POST') return;
          const u: string = resp.url() || '';
          if (!u.includes('/im/')) return;
          const t: string = await resp.text().catch(() => '');
          if (!t || t.length < 10) return;
          const head = t.slice(0, 20000);
          const ids = Array.from(head.matchAll(/"(?:conversation_id|conv_id)"\s*:\s*"?([A-Za-z0-9_-]{10,})"?/g)).map(mm => mm[1]);
          const real = ids.find(x => !x.startsWith('local_'));
          if (real) {
            const arr = doubaoConvIdsByPage.get(page) || [];
            if (!arr.includes(real)) {
              arr.unshift(real);
              if (arr.length > 5) arr.pop();
              doubaoConvIdsByPage.set(page, arr);
            }
          }
        } catch { /* 忽略 */ }
      });
    } catch { /* 忽略 */ }

    try {
      await page.evaluate(() => {
        const capture = () => {
          const _open = XMLHttpRequest.prototype.open;
          (XMLHttpRequest.prototype as any).open = function (this: any, m: string, u: string) {
            try {
              if (typeof u === 'string' && u.indexOf('/im/') >= 0 && u.indexOf('version_code=') >= 0) {
                const q = u.indexOf('?') >= 0 ? u.substring(u.indexOf('?') + 1) : '';
                if (q && q !== (window as any).__dbSignQuery) {
                  (window as any).__dbSignQuery = q;
                  try { localStorage.setItem('__db_sign', q); } catch { /* 忽略 */ }
                }
              }
            } catch { /* 忽略 */ }
            return _open.apply(this, arguments as any);
          };
        };
        // 从已存的签名恢复（避免导航后丢失）
        try {
          const saved = localStorage.getItem('__db_sign');
          if (saved) (window as any).__dbSignQuery = saved;
        } catch { /* 忽略 */ }
        capture();
      }).catch(() => {});
      logger.info('[豆包] 已注入分享签名捕获 hook（afterNavigate，含 Node 侧 request 监听）');
    } catch (e: any) {
      logger.warn(`[豆包] 注入签名捕获 hook 失败: ${e.message}`);
    }
  }

  /**
   * v1.9.3 实地诊断（2026-08-16）：豆包按 Enter 不发送查询（实测 45 秒后聊天区只有
   * 用户问题、无 AI 回答，body 全是侧边栏文本），必须点击发送按钮。
   * 参考 auth helper 实测：发送按钮为 div.send-btn-wrapper button
   */
  protected async submitInput(page: Page, _activeSelector: string): Promise<void> {
    const sendSelectors = [
      'div.send-btn-wrapper button',
      '[data-testid="chat_input_send_button"]',
      '[data-testid="send_button"]',
      'button[aria-label*="发送"]',
      '[class*="send-btn"] button',
      '[class*="sendBtn"]',
    ];
    for (const sel of sendSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          const enabled = await btn.isEnabled().catch(() => true);
          if (visible && enabled) {
            await btn.click({ timeout: 3000 });
            logger.info(`[豆包] 点击发送按钮: ${sel}`);
            return;
          }
        }
      } catch { /* 继续尝试下一个选择器 */ }
    }
    // 未找到已知发送按钮：转储输入区周边按钮结构，便于下轮精确定位
    try {
      const dump = await page.evaluate(() => {
        const editor = document.querySelector('div[aria="doc_editor"]') || document.querySelector('textarea');
        let container: HTMLElement | null = editor ? (editor as HTMLElement).parentElement : null;
        for (let i = 0; i < 4 && container; i++) {
          const btns = container.querySelectorAll('button, [role="button"]');
          if (btns.length > 0) {
            return Array.from(btns).slice(0, 8).map((b) => {
              const r = (b as HTMLElement).getBoundingClientRect();
              return `<${b.tagName.toLowerCase()} class="${((b as HTMLElement).className || '').toString().slice(0, 60)}" aria="${b.getAttribute('aria-label') || ''}" tid="${b.getAttribute('data-testid') || ''}" pos=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)})`;
            }).join(' | ');
          }
          container = container.parentElement;
        }
        return '';
      }).catch(() => '');
      if (dump) logger.warn(`[豆包] 未找到发送按钮，输入区周边按钮转储: ${dump}`);
    } catch { /* 忽略 */ }
    // 兜底：所有发送按钮选择器失败时回退 Enter
    logger.warn('[豆包] 未找到可点击的发送按钮，回退 Enter 提交');
    await page.keyboard.press('Enter');
  }

  /**
   * v1.9.4 重写：停止按钮等待不可靠（[class*="stop"] 误匹配无关 class，等待立即通过），
   * 导致 AI 回答还没生成就开始提取、抓到侧边栏文本被污染拦截。
   * 改为「文本变化检测」：
   *   阶段1: 轮询等待主区域文本相对基线变化（回答开始生成），30 秒超时
   *   阶段2: 轮询等待文本稳定（连续 2 次不变 = 生成完成），60 秒上限
   */
  async waitForResponse(page: Page): Promise<void> {
    // v1.9.6: 豆包回答可能渲染在 iframe 中（诊断日志 iframes=1，主文档 main 只有侧边栏）。
    // 用 page.frames() 遍历（可访问跨域 iframe，比 contentDocument 可靠）。
    // v1.9.10: 豆包使用 semi 设计系统，回答可能渲染在 shadow root 内（domNodes=821 很低，
    // innerText 读不到 shadow 内文本）。改为深度遍历 shadow DOM 提取文本。
    const deepText = (): Promise<string> =>
      page.evaluate(() => {
        const texts: string[] = [];
        const walk = (root: Document | ShadowRoot | Element) => {
          const all = (root as Document).querySelectorAll ? Array.from((root as Document).querySelectorAll('*')) : [];
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as HTMLElement;
            // 文本节点
            if (el.childNodes) {
              for (let k = 0; k < el.childNodes.length; k++) {
                const cn = el.childNodes[k];
                if (cn.nodeType === 3 && cn.textContent && cn.textContent.trim()) {
                  texts.push(cn.textContent.trim());
                }
              }
            }
            // 穿透 open shadow root
            if ((el as any).shadowRoot) walk((el as any).shadowRoot as ShadowRoot);
          }
        };
        walk(document);
        return texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 30000);
      }).catch(() => '');

    const snapshot = (): Promise<string> => {
      const parts: string[] = [];
      return page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        if (main) {
          return ((main as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
        }
        return '';
      }).catch(() => '').then(async (mainText) => {
        if (mainText) parts.push(mainText);
        // 所有子 frame（含跨域）
        const frames = page.frames().filter(f => f !== page.mainFrame());
        for (const f of frames) {
          try {
            const bodyText = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (bodyText && bodyText.trim()) {
              parts.push(bodyText.replace(/\s+/g, ' ').trim().slice(0, 20000));
            }
          } catch { /* 跨域限制忽略 */ }
        }
        return parts.filter(Boolean).join(' | ').slice(0, 30000);
      });
    };
    const baseline = await snapshot();
    // v1.9.10: 深度文本（含 shadow DOM）也加入基线/比较，捕获渲染在 shadow 内的回答
    const baselineDeep = await deepText();
    // 阶段1: 等待回答开始生成（文本变化）
    // v1.9.9: 30s → 45s（豆包回答队列可能较长，30s 内未开始生成就提取会抓到侧边栏）
    const deadline1 = Date.now() + 45000;
    let changed = false;
    while (Date.now() < deadline1) {
      await page.waitForTimeout(3000);
      const cur = await snapshot();
      if (cur && cur !== baseline && Math.abs(cur.length - baseline.length) > 30) {
        changed = true;
        break;
      }
      // v1.9.10: 主文档/iframe innerText 无变化时，检查深度文本（shadow DOM）是否出现新内容
      const curDeep = await deepText();
      if (baselineDeep && curDeep && curDeep.length > baselineDeep.length + 100) {
        changed = true;
        logger.info('[豆包] 深度文本检测到回答变化（shadow DOM 内）');
        break;
      }
    }
    if (!changed) {
      // 30 秒无回答文本变化：转储发送结果诊断（v3.21.8 增强版）
      // 实地日志（2026-08-21 22:24-22:33）：发送按钮点击后输入框已清空（verifySubmission 通过），
      // 但 30 秒无回答变化 + domNodes=863 恒定空壳 + mainTextHead 开头为关键词。
      // 需区分三种根因：
      //   a. 消息已发送（用户消息出现）但 AI 未生成（平台风控静默处理）
      //   b. 发送了空消息（evaluate 注入未触发 React state，点击发送发出空内容）
      //   c. 回答在 iframe 但 snapshot 未捕获
      try {
        const diag = await page.evaluate(() => {
          const main = document.querySelector('main') || document.body;
          const iframes = document.querySelectorAll('iframe').length;
          const domNodes = document.querySelectorAll('*').length;
          // 用户消息 vs AI 消息计数（data-testid 是豆包标准消息标识）
          const userMsgs = document.querySelectorAll('[data-testid^="send_message"], [class*="send-message"]').length;
          const aiMsgs = document.querySelectorAll('[data-testid^="receive_message"], [class*="receive-message"]').length;
          // 输入框当前值（发送成功应已清空）
          const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
          const inputVal = ta ? (ta.value || '').slice(0, 40) : '(无textarea)';
          // 登录态：豆包已登录有用户头像（img[data-testid*="avatar"] 或含 avatar class 的 img）
          const avatar = document.querySelector('img[class*="avatar"], img[data-testid*="avatar"], [class*="user-avatar"]');
          return `mainTextHead="${((main as HTMLElement).innerText || '').replace(/\s+/g, ' ').slice(0, 150)}" iframes=${iframes} domNodes=${domNodes} 用户消息=${userMsgs} AI消息=${aiMsgs} 输入框="${inputVal}" 登录头像=${avatar ? '有' : '无'}`;
        }).catch(() => '');
        logger.warn(`[豆包] 30秒内未检测到回答文本变化（可能未真正发送或回答在特殊容器），诊断: ${diag} URL=${page.url()}`);
        // v3.21.8: 逐 iframe 转储消息命中情况（回答在 iframe 时主文档计数全为 0）
        try {
          const frameDiag: string[] = [];
          for (const f of page.frames()) {
            const label = f === page.mainFrame() ? 'main' : `iframe(${(f.url() || '').slice(0, 60)})`;
            const counts = await f.evaluate(() => {
              const u = document.querySelectorAll('[data-testid^="send_message"], [class*="send-message"]').length;
              const a = document.querySelectorAll('[data-testid^="receive_message"], [class*="receive-message"]').length;
              const bodyHead = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
              return `用户=${u} AI=${a} body="${bodyHead}"`;
            }).catch(() => 'evaluate失败');
            frameDiag.push(`[${label}] ${counts}`);
          }
          logger.warn(`[豆包] 逐frame消息诊断: ${frameDiag.join(' | ')}`);
        } catch { /* 忽略 */ }
      } catch { /* 忽略 */ }
      return;
    }
    // 阶段2: 等待流式生成完成（文本稳定）
    const deadline2 = Date.now() + 60000;
    let last = '';
    let stable = 0;
    while (Date.now() < deadline2) {
      await page.waitForTimeout(4000);
      const cur = await snapshot();
      if (cur === last) {
        stable++;
        if (stable >= 2) {
          logger.info('[豆包] 回答文本已稳定，生成完成');
          return;
        }
      } else {
        stable = 0;
      }
      last = cur;
    }
  }

  /**
   * v1.9.6: 豆包回答渲染在 iframe 中（诊断日志 iframes=1），baseAdapter 的 extractContent
   * 只用 page.$$ 查主文档 frame，抓不到 iframe 内的回答 → 抓到侧边栏文本被污染拦截。
   * 重写：优先从 iframe 内按 responseSelector 提取，失败再回退主文档。
   * v1.9.11: 增加「标记感知 + shadow DOM 穿透」深度提取——先扫主文档、再扫 iframe，
   * 递归穿透 shadow root 收集文本块，过滤命中 2+ 侧边栏标记/导航容器的块，取最长回答。
   * （实地日志 2026-08-17 16:06：waitForResponse 已检测到"回答文本稳定"但 extractContent
   * 仍抓到 715 字符侧边栏，说明回答在深层 DOM/shadow 中，旧提取方式漏掉）
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 深度提取助手：穿透 shadow DOM + 过滤侧边栏污染，返回最长回答块
    const markers = this.sidebarMarkers;
    const deepExtract = async (frame: any): Promise<{ text: string; html: string } | null> => {
      try {
        const result = await frame.evaluate((mks: string[]) => {
          const navPatterns = /sidebar|side-bar|sidenav|side-nav|navigation|nav-bar|navbar|menu|aside|left-bar|leftbar|right-bar|rightbar|history|conversation-list|chat-list|session|sider/i;
          const markerCount = (t: string) => mks.filter((m) => t.includes(m)).length;
          let best = '';
          let bestHtml = '';
          const walk = (root: any) => {
            const all = root.querySelectorAll
              ? Array.from(root.querySelectorAll('div, section, article, [class*="answer"], [class*="message"], [class*="markdown"], [class*="content"], [class*="response"]'))
              : [];
            for (let i = 0; i < all.length; i++) {
              const el = all[i] as HTMLElement;
              const cls = (el.getAttribute('class') || '').toString();
              // 跳过导航/侧边栏容器
              if (navPatterns.test(cls)) continue;
              const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
              if (t.length < 100) continue;
              // 命中 2 个以上侧边栏标记的块视为污染，跳过
              if (markerCount(t) >= 2) continue;
              if (t.length > best.length) {
                best = t;
                bestHtml = el.innerHTML || '';
              }
              if ((el as any).shadowRoot) walk((el as any).shadowRoot);
            }
          };
          walk(document);
          return { text: best, html: bestHtml };
        }, markers).catch(() => null);
        if (result && result.text && result.text.length > 150) return result;
        return null;
      } catch { return null; }
    };

    // 1. 主文档深度提取（回答可能直接在 main 文档的深层 DOM/shadow 内）
    // v3.21.7: 阈值 150 → 400——实地日志（2026-08-21 21:57 / 22:03）两轮不同关键词
    // 均提取到恒定 257 字符（框架/导航文本而非真实回答，不同关键词回答长度不可能恒等），
    // 257 直接 return 导致真实回答（iframe 内）从未被提取。400 以下继续走 iframe 路径。
    const mainDeep = await deepExtract(page).catch(() => null);
    if (mainDeep && mainDeep.text && mainDeep.text.length >= 400) {
      logger.info(`[豆包] 主文档深度提取到回答: ${mainDeep.text.length} 字符`);
      return { text: mainDeep.text, html: mainDeep.html || `<div>${mainDeep.text}</div>` };
    }
    if (mainDeep && mainDeep.text && mainDeep.text.length > 0) {
      logger.warn(`[豆包] 主文档深度提取仅 ${mainDeep.text.length} 字符（<400，疑似框架文本），继续尝试 iframe`);
    }

    // 2. iframe 内提取（原逻辑 + 深度提取兜底）
    try {
      const frames = page.frames().filter(f => f !== page.mainFrame());
      for (const frame of frames) {
        try {
          // v1.9.9: 先按 responseSelector 精确匹配
          const hasContent = await frame.$(this.responseSelector).catch(() => null);
          if (hasContent) {
            const el = await frame.$(this.responseSelector);
            const text = el ? await el.textContent().catch(() => '') : '';
            if (text && text.trim().length > 100 && el) {
              const html = await el.evaluate((node: HTMLElement) => node.innerHTML).catch(() => '');
              logger.info(`[豆包] 从 iframe 提取到回答: ${text.trim().length} 字符`);
              return { text: text.trim(), html: html || `<div>${text.trim()}</div>` };
            }
          }
          // v1.9.9: responseSelector 匹配不到/内容过短时，用 smartFindLongestContent
          const smart = await smartFindLongestContent(frame as any, 80).catch(() => null);
          if (smart && smart.text && smart.text.trim().length > 150) {
            logger.info(`[豆包] 从 iframe smartFindLongestContent 提取到回答: ${smart.text.trim().length} 字符`);
            return { text: smart.text.trim(), html: smart.html || `<div>${smart.text.trim()}</div>` };
          }
          // v1.9.11: iframe 内标记感知深度提取（穿透 shadow DOM）
          const frameDeep = await deepExtract(frame).catch(() => null);
          if (frameDeep && frameDeep.text && frameDeep.text.length > 150) {
            logger.info(`[豆包] 从 iframe 深度提取到回答: ${frameDeep.text.length} 字符`);
            return { text: frameDeep.text, html: frameDeep.html || `<div>${frameDeep.text}</div>` };
          }
        } catch { /* 继续下一个 frame */ }
      }
    } catch { /* 忽略 */ }
    // iframe 提取失败，回退基类
    return await super.extractContent(page);
  }

  /**
   * v3.20.x: 通过豆包分享 API 直调生成分享链接（绕过 UI 按钮/shadow DOM）
   *
   * 豆包分享纯后端 API，不依赖前端按钮。实现：
   * 1. 从 page.url() 的 /chat/{conversation_id} 提取会话 ID
   * 2. 复用签名 query（afterNavigate 注入的 __dbSignQuery / localStorage['__db_sign']，
   *    即豆包自身业务请求的宿主签名 device_id/web_id/tea_uuid/aid 等）
   * 3. POST /share/share_token{?sign} body {"conversation_id":xxx} → share_token(JWT)
   * 4. POST /share/save{?sign} body {"conv_id","message_index_list":[1,2],"share_token"} → share_url
   * 5. 返回 data.share_url（https://www.doubao.com/thread/{share_id}）
   * 实测（2026-08-21 实地）：带完整签名 query 的 fetch 直调成功返回 share_url。
   */
  private async createDoubaoShareLinkViaApi(page: Page): Promise<string | null> {
    try {
      // 1. 提取 conversation_id（支持数字 ID 和 local_ 前缀的非数字会话 ID）
      const url = page.url();
      const m = url.match(/\/chat\/([A-Za-z0-9_-]+)/);
      if (!m) {
        logger.warn(`[豆包] API直调失败: 对话 URL 不含 conversation_id (url=${url})`);
        return null;
      }
      const convId = m[1];

      // 2. 获取签名 query（v3.21.6 四级恢复：Node侧捕获 → window → localStorage → performance）
      let sign = doubaoSignByPage.get(page) || '';
      if (!sign) {
        sign = await page.evaluate(() => (window as any).__dbSignQuery || '').catch(() => '');
      }
      if (!sign) {
        sign = await page.evaluate(() => {
          try { return localStorage.getItem('__db_sign') || ''; } catch { return ''; }
        }).catch(() => '');
      }
      if (!sign) {
        // Performance API 恢复：页面加载期的业务请求已结束，页面内 hook 注入再早也会错过，
        // 但 performance.getEntriesByType('resource') 记录了全部请求 URL（含 fetch/XHR；
        // iframe 的请求记录在各自 frame 的 performance 中，需逐 frame 扫描）。
        const perfRecover = async (frame: any): Promise<string> =>
          frame.evaluate(() => {
            try {
              const entries = performance.getEntriesByType('resource');
              for (let i = entries.length - 1; i >= 0; i--) {
                const n: string = (entries[i] as any).name || '';
                if (n.indexOf('/im/') >= 0 && n.indexOf('version_code=') >= 0) {
                  const q = n.indexOf('?') >= 0 ? n.substring(n.indexOf('?') + 1) : '';
                  if (q) return q;
                }
              }
            } catch { /* 忽略 */ }
            return '';
          }).catch(() => '');
        sign = await perfRecover(page);
        if (!sign) {
          for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            sign = await perfRecover(f);
            if (sign) break;
          }
        }
        if (sign) logger.info('[豆包] API直调: 从 performance entries 恢复签名 query');
      }
      // sign 若以 ? 开头则去掉
      sign = sign.replace(/^\?/, '');
      logger.info(`[豆包] API直调: 签名query=${sign ? `已捕获(${sign.length}字符)` : '未捕获(走无签名尝试)'}`);

      // 请求封装：sign 直接拼到 path 的 query 上，相对路径走页面同源 + 自动带 cookie
      const callShare = async (path: string, body: Record<string, unknown>, withSign: boolean): Promise<any> => {
        const qs = withSign && sign ? '?' + sign : '';
        return await page.evaluate(
          ({ url, body: b }) => fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          }).then(r => r.text()).then(t => { try { return JSON.parse(t); } catch { return { raw: t }; } }),
          { url: path + qs, body }
        );
      };

      // v3.21.7: 会话 ID 候选列表——Node 侧捕获的正式 ID 优先（save 对 local_ 临时 ID
      // 报 621000001 系统内部错误，正式 ID 是发消息后服务端创建的），URL 里的 ID 兜底
      const capturedIds = doubaoConvIdsByPage.get(page) || [];
      const candidates = [...new Set([...capturedIds.slice(0, 3), convId].filter(Boolean))];
      logger.info(`[豆包] API直调: 会话ID候选=${JSON.stringify(candidates)} (URL=${convId}, Node侧捕获=${capturedIds.length}个)`);

      let preShareId = '';
      // 逐候选尝试：带签名 token+save（签名已捕获时），否则无签名
      for (const cid of candidates) {
        const tok = await callShare('/im/message/share/share_token', { conversation_id: cid }, !!sign);
        const token = (tok && tok.data && tok.data.share_token) || '';
        if (tok && tok.data && tok.data.pre_share_id) preShareId = tok.data.pre_share_id;
        if (!token) {
          logger.warn(`[豆包] API直调: cid=${cid} share_token 未返回 (resp=${JSON.stringify(tok).slice(0, 150)})`);
          continue;
        }
        const saved = await callShare('/im/message/share/save', {
          conv_id: cid, message_index_list: [1, 2], share_token: token,
        }, !!sign);
        const shareUrl = (saved && saved.data && saved.data.share_url) || '';
        if (shareUrl && shareUrl.includes('/thread/')) {
          logger.info(`[豆包] API直调成功: cid=${cid} share_url=${shareUrl}`);
          return shareUrl;
        }
        logger.warn(`[豆包] API直调: cid=${cid} save 未返回 thread 链接 (resp=${JSON.stringify(saved).slice(0, 150)})`);
      }

      // 最终兜底: share_token 响应的 pre_share_id 直接拼 thread 链接
      // （不确定 pre_share_id 是否就是最终 share_id，由 verifyShareLinkPublic 公开性验证兜底，
      //   链接无效时自动降级静态页，无副作用）
      if (preShareId) {
        const guess = `https://www.doubao.com/thread/${preShareId}`;
        logger.info(`[豆包] API直调: save 全部失败，尝试 pre_share_id 拼接链接: ${guess}`);
        return guess;
      }
      return null;
    } catch (e: any) {
      logger.warn(`[豆包] API直调异常: ${e.message}`);
      return null;
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // v3.20.x 实地探查（2026-08-21）：豆包分享链接格式为 https://www.doubao.com/thread/{share_id}
    //
    // 【优先路径 v3.20.x】API 直调分享（推荐，绕过 UI 按钮/shadow DOM）：
    //   豆包分享是纯后端 API 生成链接，不依赖前端按钮。对话 URL 形如 /chat/{conversation_id}，
    //   可用页面会话直接调（带完整签名 query——device_id/web_id/aid 等宿主级参数，从任意 XHR URL 复用）。
    //   实测（2026-08-21 实地）：fetch POST 需带 siwent mock 的签名 query，否则返回"参数非法"；
    //   带上完整 signature query 后成功返回 share_url:
    //   1. POST /im/message/share/share_token{?sign} body {"conversation_id":xxx} → share_token(JWT)
    //   2. POST /im/message/share/save{?sign} body {"conv_id":xxx,"message_index_list":[1,2],"share_token":token}
    //      → data.share_url: https://www.doubao.com/thread/{share_id}
    //   signature query 复用页面内任意 XHR 的 URL query（injectShareSignatureCapture 捕获宿主签名）
    const viaApi = await this.createDoubaoShareLinkViaApi(page);
    if (viaApi) {
      logger.info(`[豆包] 通过 API 直调生成分享链接: ${viaApi}`);
      return viaApi;
    }

    // 【兜底路径】UI 点击分享（仅当 API 直调失败时，网页按钮可定位的场景）
    // 分享按钮在回答气泡底部操作栏 .message-action-button-main 内（hover 回答后显示，
    // 无 share class/aria/title，旧 [class*="share"] 选择器匹配不到）。
    // 点击"复制链接"会调用两个 API 生成链接（不走标准剪贴板——React 闭包缓存了原生
    // writeText 引用，injectClipboardInterceptor 拦截不到）：
    //   1. POST /im/message/share/share_token body {"conversation_id":xxx} → pre_share_id + share_token
    //   2. POST /im/message/share/save body {"conv_id":xxx,"message_index_list":[...],"share_token":token}
    //      → 返回 data.share_url: https://www.doubao.com/thread/{share_id}
    // 真实分享链接必须从 save API 响应中提取（XHR 拦截），剪贴板只作兜底。

    // 步骤1: 注入 XHR 响应拦截，捕获 save 响应的 share_url
    await this.injectShareApiInterceptor(page, '/share/save', 'share_url');
    // v3.20.x: 注入剪贴板+XHR+fetch 拦截作为双保险（save 响应 + 剪贴板都扫）
    await this.injectClipboardInterceptor(page, ['/thread/']);

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    // v1.9 修复：hover 成功一个元素后立即停止——之前会继续 hover 兜底选择器（main 等），
    // 鼠标被移走导致已显示的操作栏消失，分享按钮永远找不到
    // v3.20.x：豆包回答渲染在 iframe（巡检日志 iframes=2、主文档 main 无回答），
    //   操作栏跟随回答也在 iframe，必须遍历主文档+所有子 frame 分别 hover。
    const answerSelectors = [
      // v3.20.x：豆包操作栏 .message-action-bar 跟随回答容器，hover 它或回答文本都能显示
      '[class*="message-action-bar"]',
      '[class*="receive-message"]',
      '[class*="message-content"]',
      '[class*="bubble-content"]',
      '[class*="flow-markdown"]',
      '[class*="markdown"]',
      // 兜底
      'main', '[class*="chat"]', '[class*="conversation"]',
    ];
    const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];

    let hoveredAny = false;
    for (const frame of frames) {
      if (hoveredAny) break;
      for (const sel of answerSelectors) {
        if (hoveredAny) break;
        try {
          const elements = await frame.$$(sel);
          for (let i = elements.length - 1; i >= 0; i--) {
            const visible = await elements[i].isVisible().catch(() => false);
            if (visible) {
              await elements[i].hover({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1200);
              hoveredAny = true;
              break;
            }
          }
        } catch { /* 继续 */ }
      }
    }
    if (hoveredAny) logger.info('[豆包] hover 回答区域成功（触发操作栏）');

    // 步骤3: 点击分享按钮（操作栏内 tooltip 为"分享"的图标按钮）
    let shareBtnClicked = await this.clickDoubaoShareButton(page);
    if (!shareBtnClicked) {
      // 兜底：hover 消息后重新扫描（v1.9.5: 最多尝试 5 条，避免遍历全部消息浪费数分钟）
      logger.info('[豆包] 首次扫描未找到分享按钮，尝试 hover 消息区域后重新扫描（最多5条）...');
      let allMessages: any[] = [];
      for (const frame of frames) {
        try {
          allMessages = allMessages.concat(await frame.$$('[class*="message"], [class*="receive"], [class*="bubble"], [class*="answer"]'));
        } catch { /* 继续 */ }
      }
      let attempts = 0;
      for (let i = allMessages.length - 1; i >= 0 && attempts < 5; i--) {
        try {
          const visible = await allMessages[i].isVisible().catch(() => false);
          if (!visible) continue;
          attempts++;
          await allMessages[i].hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(800);
          shareBtnClicked = await this.clickDoubaoShareButton(page);
          if (shareBtnClicked) break;
        } catch { /* 继续 */ }
      }
      if (!shareBtnClicked) {
        const captured = await this.getCapturedShareUrl(page, '/thread/');
        if (captured) return captured;
        await page.keyboard.press('Escape').catch(() => {});
        return null;
      }
    }

    // 步骤4: 点击"复制链接"按钮（豆包分享面板默认已全选消息，跳过全选避免误取消勾选）
    await this.clickDoubaoCopyLink(page);

    // 步骤5: 从 save API 响应拦截到的 share_url 提取（豆包链接为 /thread/ 格式）
    const capturedUrl = await this.getCapturedShareUrl(page, '/thread/');
    if (capturedUrl) {
      logger.info(`[豆包] 从 save API 响应捕获分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 剪贴板拦截兜底（部分版本可能仍走剪贴板）
    const clipUrl = await this.getCapturedShareUrl(page, '/thread/');
    if (clipUrl) {
      logger.info(`[豆包] 从剪贴板捕获分享链接: ${clipUrl}`);
      return clipUrl;
    }

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[豆包] 未能提取到分享链接');
    return null;
  }

  /**
   * v3.20.x: 定位并点击豆包分享按钮
   *
   * 豆包分享按钮无 class/aria/title 特征（class 是通用 flex 图标类），
   * 只能靠 hover 后出现的 tooltip 文本（"分享"）识别。
   * 策略：
   *   1. 遍历操作栏 .message-action-button-main 内按钮，逐个 hover 读取 tooltip，命中"分享"即点击；
   *   2. tooltip 全失败（Worker 环境 tooltip class 可能不同）时，逐个点击按钮并验证是否弹出
   *      分享面板（.share-header-ui 或文本"复制链接"），弹出即成功——不依赖 tooltip。
   */
  private async clickDoubaoShareButton(page: Page): Promise<boolean> {
    const btnSelector = '[class*="message-action-button-main"] > button';
    const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
    const panelCheck = async (): Promise<boolean> => {
      for (const f of frames) {
        const r = await f.evaluate(() => {
          if (document.querySelector('[class*="share-header-ui"]')) return true;
          const bodyTxt = (document.body.innerText || '');
          return bodyTxt.includes('复制链接') && bodyTxt.includes('分享对话');
        }).catch(() => false);
        if (r) return true;
      }
      return false;
    };

    // 策略0: 坐标点击——穿透 shadow DOM 定位操作栏按钮
    // Worker 环境豆包回答可能渲染在 shadow root 内（domNodes 很低），常规
    // document.querySelectorAll 查不到 shadow 内元素，必须深度遍历 shadow root。
    // 收集操作栏按钮坐标，逐个点击并验证是否弹出分享面板。
    for (const frame of frames) {
      const btns = await frame.evaluate(() => {
        const out: Array<{ x: number; y: number }> = [];
        const walk = (root: any) => {
          const all = root.querySelectorAll
            ? Array.from(root.querySelectorAll('[class*="message-action-button-main"] button, [class*="message-action-button"] button'))
            : [];
          for (const el of all) {
            const r = (el as HTMLElement).getBoundingClientRect();
            const s = window.getComputedStyle(el as HTMLElement);
            if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
              out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
            }
          }
          // 穿透 open shadow root
          for (const el of (root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [])) {
            const shadow = (el as any).shadowRoot as ShadowRoot | undefined;
            if (shadow) walk(shadow);
          }
        };
        walk(document);
        return out;
      }).catch(() => [] as Array<{ x: number; y: number }>);

      if (btns.length > 0) {
        // 分享按钮在操作栏最右侧附近（复制/朗读/喜欢/不喜欢/分享/重新生成/更多），
        // 从右往左试（最多试右侧 5 个），每点一个验证是否弹出分享面板
        for (let i = btns.length - 1; i >= Math.max(0, btns.length - 5); i--) {
          try {
            await page.mouse.click(btns[i].x, btns[i].y).catch(() => {});
            await page.waitForTimeout(1200);
            if (await panelCheck()) {
              logger.info(`[豆包] 通过坐标点击操作栏按钮 (shadow, frame=${frame === page.mainFrame() ? 'main' : 'iframe'}, idx=${i})，分享面板已出现`);
              return true;
            }
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(500);
          } catch { /* 继续 */ }
        }
      }
    }

    // 策略1: tooltip 识别（遍历主文档 + iframe，非 shadow 场景）
    for (const frame of frames) {
      const btnCount = await frame.evaluate((sel: string) => document.querySelectorAll(sel).length, btnSelector).catch(() => 0);
      if (!btnCount) continue;
      for (let i = 0; i < btnCount; i++) {
        try {
          const btn = (await frame.$$(btnSelector))[i];
          if (!btn) continue;
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(600);
          const tip = await frame.evaluate(() => {
            const nodes = document.querySelectorAll('[class*="tooltip"], [data-tooltip]');
            for (let k = 0; k < nodes.length; k++) {
              const t = (nodes[k].textContent || '').trim();
              if (t && t.length <= 10) return t;
            }
            return '';
          }).catch(() => '');
          if (tip.includes('分享')) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1500);
            logger.info(`[豆包] 通过 tooltip"${tip}"定位分享按钮 (frame=${frame === page.mainFrame() ? 'main' : 'iframe'}, index=${i})`);
            return true;
          }
          // 移开鼠标，避免 tooltip 残留干扰下一轮识别
          await page.mouse.move(5, 5).catch(() => {});
          await page.waitForTimeout(400);
        } catch { /* 继续下一个 */ }
      }
    }

    // 策略2: 逐个点击验证面板（Worker 环境 tooltip 不可靠时的兜底，遍历 frames）
    // 分享按钮在操作栏相对位置固定（复制/朗读/喜欢/不喜欢/分享/重新生成/更多），
    // 从最右侧开始逐个点击，检查是否弹出分享面板（出现"复制链接"/"分享对话"即命中）
    for (const frame of frames) {
      const btnCount2 = await frame.evaluate((sel: string) => document.querySelectorAll(sel).length, btnSelector).catch(() => 0);
      if (!btnCount2) continue;
      // 从右侧开始（分享/重新生成在操作栏右侧），最多试前 5 个
      const start = Math.max(0, btnCount2 - 5);
      for (let i = btnCount2 - 1; i >= start; i--) {
        try {
          const btn = (await frame.$$(btnSelector))[i];
          if (!btn) continue;
          await btn.click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(1200);
          if (await panelCheck()) {
            logger.info(`[豆包] 通过位置点击分享按钮 (frame=${frame === page.mainFrame() ? 'main' : 'iframe'}, index=${i})，分享面板已出现`);
            return true;
          }
          // 未弹出面板则关闭可能的浮层后继续
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(500);
        } catch { /* 继续 */ }
      }
    }
    logger.warn('[豆包] 操作栏内未找到分享按钮（shadow + tooltip + 位置点击均失败）');
    return false;
  }

  /**
   * v3.20.x: 点击豆包分享面板的"复制链接"按钮
   *
   * 豆包分享面板结构（实地确认）：.share-header-ui 内底部有文本精确为"复制链接"的按钮，
   * 消息 checkbox 默认已全选，无需（也不能）再点"全选"——点了反而取消勾选。
   * 点击后触发 share_token + save 两个 API，save 响应返回 share_url。
   * v3.20.x：面板可能在 iframe，遍历主文档 + 所有子 frame。
   */
  private async clickDoubaoCopyLink(page: Page): Promise<boolean> {
    const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
    const selectors = [
      'button:has-text("复制链接")',
      ':text-is("复制链接")',
      '[class*="share"] :text-is("复制链接")',
      '[class*="share-bar"] :text-is("复制链接")',
      '[class*="share-header"] :text-is("复制链接")',
    ];
    for (const frame of frames) {
      for (const sel of selectors) {
        try {
          const el = await frame.$(sel);
          if (el) {
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            await el.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(2000);
            logger.info(`[豆包] 点击分享面板"复制链接": ${sel} (frame=${frame === page.mainFrame() ? 'main' : 'iframe'})`);
            return true;
          }
        } catch { /* 继续 */ }
      }
    }
    // 兜底：evaluate 扫描文本精确为"复制链接"的 button（遍历 frames）
    for (const frame of frames) {
      try {
        const clicked = await frame.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const target = btns.find(b => (b.textContent || '').trim() === '复制链接');
          if (target) { (target as HTMLButtonElement).click(); return true; }
          return false;
        }).catch(() => false);
        if (clicked) {
          await page.waitForTimeout(2000);
          logger.info('[豆包] 通过 evaluate 点击"复制链接"成功');
          return true;
        }
      } catch { /* 忽略 */ }
    }
    return false;
  }
}
