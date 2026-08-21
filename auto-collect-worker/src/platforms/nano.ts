import { Page } from 'playwright';
import * as logger from '../logger';
import { BasePlatformAdapter } from './baseAdapter';

/** 纳米搜索适配器
 *
 * 纳米搜索（n.cn）是 360 出品的 AI 搜索引擎，返回搜索结果 + AI 总结
 *
 * v1.4.4 修复"内容只有 139 字符"问题：
 *   之前 bug：responseSelector 用模糊的 [class*="answer"] 匹配到侧边栏简短摘要
 *   修复策略：重写 extractContent，用多策略精确提取 AI 总结正文
 *   1. 优先匹配 .answer-content / .ai-summary 等明确容器
 *   2. 兜底用 smartFindLongestContent 找最长文本块
 *   3. 限制最少 200 字符，过短则继续等待或走兜底
 *
 * v1.9: 支持分享链接提取（supportsShare=true），提取失败时由云端生成静态页
 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  // v1.9: n.cn 支持分享（分享链接格式 https://www.n.cn/share/{type}?id={shareId}）
  // 之前 supportsShare=false 导致从未尝试提取分享链接，一直走静态页
  supportsShare = true;
  protected inputSelector = 'div[contenteditable="true"], textarea, input[type="text"]';
  // v1.9.2 实地诊断（2026-08-16）：n.cn 消息列表为 li.js-message-item（data-testid="msg-xxx"）
  // 旧选择器（.answer-content/.ai-summary）全部失效，导致抓智能体广场/框架文本入库
  protected responseSelector = 'li.js-message-item, [data-testid^="msg-"], .answer-content, .ai-summary, [class*="ai-summary"], [class*="answer-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
  // v1.9.4: 纳米侧边栏/广场污染标记——实地诊断（2026-08-17）登录后停留智能体广场，
  // 抓到"像素化你的人生...1474人聊过..."等广场文本入库（609字符，能绕过长度检查）
  // 命中 2 个以上广场/框架标记即判定污染，抛错不入库
  protected sidebarMarkers = ['人聊过', '首页', '大模型', '智能体', '知识库', 'AI写作', 'AI修图', '新对话'];

  /**
   * v1.9.4: 纳米发送修复
   * 实地日志（2026-08-17）：Enter 提交后输入框文本未清空——纳米的 contenteditable
   * 输入框 Enter 不发送（历史 1756 条记录全是广场文本，说明从未真正发送过）。
   * 策略：Enter → 常见发送按钮 → Ctrl+Enter，每步后检查输入框是否清空；
   * 全部失败时转储输入框周边按钮结构到日志，便于下轮精确定位发送按钮。
   */
  protected async submitInput(page: Page, activeSelector: string): Promise<void> {
    // 尝试1: Enter
    await page.press(activeSelector, 'Enter');
    await page.waitForTimeout(2500);
    let v = await this.readInputValue(page, activeSelector);
    if (!v || !v.trim()) return;

    // 尝试2: 常见发送按钮选择器
    const sendSelectors = [
      'button[class*="send"]',
      '[class*="send-btn"]',
      '[class*="sendBtn"]',
      '[data-testid*="send"]',
      'button[aria-label*="发送"]',
      'button[title*="发送"]',
      'button[type="submit"]',
    ];
    for (const sel of sendSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          const enabled = await btn.isEnabled().catch(() => true);
          if (visible && enabled) {
            await btn.click({ timeout: 3000 });
            await page.waitForTimeout(2500);
            v = await this.readInputValue(page, activeSelector);
            if (!v || !v.trim()) {
              logger.info(`[纳米] 点击发送按钮成功: ${sel}`);
              return;
            }
          }
        }
      } catch { /* 继续尝试下一个选择器 */ }
    }

    // 尝试3: Ctrl+Enter（部分平台快捷键发送）
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(2500);
    v = await this.readInputValue(page, activeSelector);
    if (!v || !v.trim()) {
      logger.info('[纳米] Ctrl+Enter 发送成功');
      return;
    }

    // 尝试4 (v1.9.6): 遍历输入框周边的所有可点击元素（button/a/[role]/div 图标），
    // 逐个点击并检查输入框是否清空——纳米发送按钮可能不是标准 button（图标 div 或 SVG 按钮）
    try {
      const clickedSel = await page.evaluate((sel: string) => {
        const input = document.querySelector(sel);
        if (!input) return '';
        // 从输入框向上找容器，收集周边可点击元素
        let container: HTMLElement | null = input.parentElement;
        const clickables: HTMLElement[] = [];
        for (let i = 0; i < 5 && container; i++) {
          const els = Array.from(container.querySelectorAll<HTMLElement>(
            'button, a[href], [role="button"], [class*="btn"], [class*="send"], [class*="send-btn"], [class*="submit"], svg[class*="icon"], [data-testid*="send"], [data-testid*="submit"]'
          ));
          for (const el of els) {
            if (!clickables.includes(el)) clickables.push(el);
          }
          container = container.parentElement;
        }
        // 排除输入框自身
        const filtered = clickables.filter(el => el !== input && !el.contains(input) && !(el as HTMLElement).isContentEditable);
        // 按离输入框距离排序（近的优先）
        const inputRect = input.getBoundingClientRect();
        filtered.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const da = Math.abs(ra.left - inputRect.left) + Math.abs(ra.top - inputRect.top);
          const db = Math.abs(rb.left - inputRect.left) + Math.abs(rb.top - inputRect.top);
          return da - db;
        });
        // 返回前 5 个可见元素的描述（供外层逐个点击）
        return filtered.slice(0, 5).map(el => {
          const r = el.getBoundingClientRect();
          return `${el.tagName.toLowerCase()}|${(el.className || '').toString().slice(0, 40)}|${el.getAttribute('aria-label') || ''}|${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
        }).join('||');
      }, activeSelector).catch(() => '');
      if (clickedSel) {
        const candidates = clickedSel.split('||').filter(Boolean);
        logger.warn(`[纳米] 发送按钮选择器全部失败，遍历周边可点击元素（${candidates.length}个）: ${clickedSel}`);
        for (const cand of candidates) {
          const [tag, cls, aria] = cand.split('|');
          // v1.9.6: cls 可能含空格（多 class），取第一个无空格 token 构造选择器，
          // 否则 [class="a b c"] 是无效选择器永远匹配不到。
          const firstToken = (cls || '').split(' ')[0];
          try {
            const el = await page.$(`button[class*="${firstToken}"], [class*="${firstToken}"]`).catch(() => null);
            if (el) {
              const visible = await el.isVisible().catch(() => false);
              // v1.9.6: 不强制 enabled——纳米发送按钮在输入后可能仍显示 disabled 样式，
              // 但点击实际生效（实测 cursor-not-allowed 按钮点击成功发送）。
              if (visible) {
                await el.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(2500);
                v = await this.readInputValue(page, activeSelector);
                if (!v || !v.trim()) {
                  logger.info(`[纳米] 遍历点击成功: ${cls || aria || tag}`);
                  return;
                }
              }
            }
          } catch { /* 继续 */ }
        }
      }
    } catch { /* 忽略 */ }

    // 全部失败：转储输入框周边按钮，便于下轮定位发送按钮
    try {
      const dump = await page.evaluate((sel: string) => {
        const input = document.querySelector(sel);
        if (!input) return '';
        let container: HTMLElement | null = input.parentElement;
        for (let i = 0; i < 4 && container; i++) {
          const btns = container.querySelectorAll('button, [role="button"]');
          if (btns.length > 0) {
            return Array.from(btns).slice(0, 8).map((b) => {
              const r = (b as HTMLElement).getBoundingClientRect();
              return `<${b.tagName.toLowerCase()} class="${((b as HTMLElement).className || '').toString().slice(0, 60)}" aria="${b.getAttribute('aria-label') || ''}" title="${b.getAttribute('title') || ''}" tid="${b.getAttribute('data-testid') || ''}" txt="${(b.textContent || '').trim().slice(0, 10)}" pos=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)})`;
            }).join(' | ');
          }
          container = container.parentElement;
        }
        return '';
      }, activeSelector).catch(() => '');
      if (dump) logger.warn(`[纳米] 发送失败，输入框周边按钮转储: ${dump}`);
    } catch { /* 忽略 */ }

    // 最终兜底：再按一次 Enter（由 base 的 verifySubmission 做最终校验并报错）
    await page.press(activeSelector, 'Enter');
  }

  /**
   * v1.9.9: 纳米回答为流式生成，基类 stop 按钮等待不可靠（[class*="stop"] 常不匹配）。
   * 增加「文本稳定」等待：消息列表区域文本连续两次不变视为生成完成。
   */
  async waitForResponse(page: Page): Promise<void> {
    // 先尝试基类的 stop 按钮等待（快速路径）
    try {
      await super.waitForResponse(page);
    } catch { /* 忽略 */ }
    // 再做文本稳定检测（兜底，确保回答完整生成后再提取）
    try {
      const snapshot = (): Promise<string> =>
        page.evaluate(() => {
          const sel = 'li.js-message-item, [data-testid^="msg-"], main, [class*="chat"]';
          const el = document.querySelector(sel) || document.body;
          return ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(-8000);
        }).catch(() => '');
      const deadline = Date.now() + 40000;
      let last = await snapshot();
      let stable = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const cur = await snapshot();
        if (cur === last) {
          stable++;
          if (stable >= 2) break;
        } else {
          stable = 0;
        }
        last = cur;
      }
      logger.info('[纳米] 回答文本稳定，生成完成');
    } catch { /* 忽略 */ }
  }

  /**
   * v1.9: 纳米分享链接提取
   *
   * 流程：hover AI 总结区域 → 操作栏/顶部出现"分享"按钮 → 点击 → 复制链接到剪贴板 或 弹窗显示链接
   * 拦截 pattern 只匹配 /share/（n.cn 分享路径）
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 clipboard + execCommand 拦截
    await this.injectClipboardInterceptor(page, ['/share/']);

    // 步骤2: 先 hover 回答区域触发操作栏（首次扫描常因操作栏未显示而找不到分享按钮）
    const answerSelectors = [
      '.answer-content', '.ai-summary', '[class*="ai-summary"]', '[class*="answer-content"]',
      '[class*="answer"]', 'li.js-message-item', '[data-testid^="msg-"]', 'main', '[class*="chat"]',
    ];
    let hoveredAny = false;
    for (const sel of answerSelectors) {
      if (hoveredAny) break;
      try {
        const elements = await page.$$(sel);
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

    // 步骤3: 健壮地查找并点击分享按钮（文字"分享"按钮优先，纳米分享入口是文案按钮而非纯图标）
    //   v3.19.x：上轮把纳米套成 hover 图标探针（hoverAndClickShareIcon），实测"未找到图标候选"
    //   说明纳米分享不是纯图标操作栏，改回 findAndClickShareButton（含文字/aria/title 匹配）。
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[title*="分享"]',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
    ], ['分享', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：hover 图标探针（若纳米新版把分享改成图标按钮）
      const barResult = await this.hoverAndClickShareIcon(page, {
        answerSelectors,
        urlPattern: '/share/',
        maxIcons: 10,
      });
      if (typeof barResult === 'string' && barResult !== '__SHARE_PANEL__') {
        console.log(`[纳米] 从操作栏图标捕获到分享链接: ${barResult}`);
        return barResult;
      }
      if (barResult !== '__SHARE_PANEL__') {
        // 未点出分享面板，检查是否已有剪贴板捕获，否则退出
        const preCaptured = await this.getCapturedShareUrl(page, '/share/');
        if (preCaptured) return preCaptured;
        // v3.21.6: 转储最后一条消息的操作栏结构（按钮/图标/aria/title），
        // 供下轮定位纳米真实分享入口（hover 探针找不到图标候选说明操作栏
        // 可能不在消息条目内，需要消息条目内全部可交互元素数据）
        try {
          const msgDump = await page.evaluate(() => {
            // v3.21.7: 先转储页面位置诊断——实地日志（2026-08-21 22:06）「无消息条目」
            // 说明消息选择器全落空，需确认页面停在聊天页还是智能体广场（登录态异常时停留广场）
            const url = location.href;
            const bodyHead = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const items = document.querySelectorAll('li.js-message-item, [data-testid^="msg-"]');
            const last = items[items.length - 1] as HTMLElement | undefined;
            let detail = '';
            if (last) {
              const els = last.querySelectorAll('button, [role="button"], [class*="btn"], [class*="icon"], svg, [aria-label], [title]');
              const parts: string[] = [];
              for (let i = 0; i < els.length && parts.length < 15; i++) {
                const el = els[i] as HTMLElement;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const cls = (el.getAttribute('class') || '').toString().slice(0, 40);
                const aria = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const txt = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 10);
                parts.push(`<${el.tagName.toLowerCase()} class="${cls}" aria="${aria.slice(0, 16)}" title="${title.slice(0, 16)}" txt="${txt}" pos=(${Math.round(r.left)},${Math.round(r.top)})`);
              }
              detail = parts.length ? parts.join(' | ') : '消息条目内无可交互元素';
            } else {
              detail = `无消息条目(li.js-message-item/[data-testid^="msg-"]均未命中, 共${document.querySelectorAll('*').length}个DOM节点)`;
            }
            return `url=${url} | body开头="${bodyHead}" | ${detail}`;
          }).catch(() => '');
          logger.warn(`[纳米] 分享未找到，页面诊断: ${msgDump}`);
          // v3.21.8: 新版 /chathome 结构探针——转储全部 data-testid 分布 +
          // 最后一条用户消息（含查询关键词的元素）的祖先容器链 class，
          // 供下轮编写新版消息容器/操作栏精确选择器（旧 li.js-message-item 已失效）
          try {
            const structProbe = await page.evaluate(() => {
              const parts: string[] = [];
              // 1. 全部 data-testid（去重统计）
              const tids = new Map<string, number>();
              document.querySelectorAll('[data-testid]').forEach(el => {
                const t = el.getAttribute('data-testid') || '';
                tids.set(t, (tids.get(t) || 0) + 1);
              });
              const tidStr = Array.from(tids.entries()).slice(0, 30).map(([t, n]) => `${t}x${n}`).join(', ');
              parts.push(`testids=[${tidStr || '无'}]`);
              // 2. 含"聚量引力"或长文本（>100字符）元素的容器链——AI 回答容器特征是长文本
              const longEls = Array.from(document.querySelectorAll('div, section, article, li'))
                .filter(el => {
                  const t = (el as HTMLElement).innerText || '';
                  return t.length > 150 && t.length < 5000 && el.children.length > 0;
                })
                .slice(0, 5)
                .map(el => {
                  const cls = (el.getAttribute('class') || '').toString().slice(0, 50);
                  const tid = el.getAttribute('data-testid') || '';
                  const len = ((el as HTMLElement).innerText || '').length;
                  return `<${el.tagName.toLowerCase()} class="${cls}" tid="${tid}" 文本${len}字符>`;
                });
              parts.push(`长文本容器=${longEls.join(' | ') || '无'}`);
              return parts.join('\n');
            }).catch(() => '');
            if (structProbe) logger.warn(`[纳米] chathome 结构探针:\n${structProbe}`);
          } catch { /* 忽略 */ }
        } catch { /* 忽略 */ }
        console.log('[纳米] 未定位到分享按钮');
        return null;
      }
    } else {
      // 分享按钮点击成功，尝试二次菜单（复制链接）
      await this.clickShareMenuItem(page);
      const menuCaptured = await this.getCapturedShareUrl(page, '/share/');
      if (menuCaptured) {
        logger.info(`[纳米] 二次菜单命中，捕获分享链接: ${menuCaptured}`);
        return menuCaptured;
      }
    }

    // 步骤4: 分享面板出现后，点击"复制链接"按钮（如果有）
    await page.waitForTimeout(1000);
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      '[class*="copy-link"]',
    ];
    for (const sel of copyBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[纳米] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
    if (capturedUrl) {
      console.log(`[纳米] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
    if (dialogUrl) return dialogUrl;

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[纳米] 未能提取到分享链接');
    return null;
  }

  /**
   * 重写 extractContent：精确提取纳米 AI 总结正文
   *
   * 纳米页面结构：
   *   - 顶部：搜索结果列表（简短摘要，每个 ~100-200 字符）
   *   - 中部：AI 总结（完整回答，通常 500+ 字符）
   *   - 侧边栏：相关问题、推荐等
   *
   * 之前 bug：[class*="answer"] 匹配到顶部简短摘要，导致只提取 139 字符
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载
    await this.scrollToBottom(page);

    // 纳米页面结构（2026-07-12 实地观察）：
    // - 顶部：搜索框
    // - 左侧栏：推荐智能体列表（"首页大模型智能体知识库AI写作AI修图..."）
    // - 中部：AI 回答（含 markdown 格式，有 <p> 标签）
    // - 底部：相关搜索推荐
    // 之前 bug：smartFindLongestContent 抓到左侧栏（3.4K 字符）而非 AI 回答（1-2K 字符）
    // 修复：跳过自有 extractContent，直接用 baseAdapter 的评分版 extractContent
    // （baseAdapter 现在会优先选择含 <p> 标签的散文内容）
    return await super.extractContent(page);
  }
}
