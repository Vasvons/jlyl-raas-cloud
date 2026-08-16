import { Page } from 'playwright';
import * as logger from '../logger';
import { BasePlatformAdapter } from './baseAdapter';

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
    const snapshot = (): Promise<string> => {
      const parts: string[] = [];
      // 主文档
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
    // 阶段1: 等待回答开始生成（文本变化）
    const deadline1 = Date.now() + 30000;
    let changed = false;
    while (Date.now() < deadline1) {
      await page.waitForTimeout(3000);
      const cur = await snapshot();
      if (cur && cur !== baseline && Math.abs(cur.length - baseline.length) > 30) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      // 30 秒无回答文本变化：转储 main 区域文本开头 + iframe 数量，辅助定位回答渲染位置
      try {
        const diag = await page.evaluate(() => {
          const main = document.querySelector('main') || document.body;
          const iframes = document.querySelectorAll('iframe').length;
          const shadowHosts = document.querySelectorAll('*').length;
          return `mainTextHead="${((main as HTMLElement).innerText || '').replace(/\s+/g, ' ').slice(0, 150)}" iframes=${iframes} domNodes=${shadowHosts}`;
        }).catch(() => '');
        logger.warn(`[豆包] 30秒内未检测到回答文本变化（可能未真正发送或回答在特殊容器），诊断: ${diag}`);
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
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 先尝试从 iframe 中提取（page.frames() 可访问跨域 iframe）
    try {
      const frames = page.frames().filter(f => f !== page.mainFrame());
      for (const frame of frames) {
        try {
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
        } catch { /* 继续下一个 frame */ }
      }
    } catch { /* 忽略 */ }
    // iframe 提取失败，回退基类
    return await super.extractContent(page);
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 豆包分享链接格式：https://www.doubao.com/share/{token}
    // 实地探查（2026-07-12）：分享是会话级别（非单条消息），在回答操作栏或会话菜单中
    // 流程：hover 回答/会话 → 操作栏出现 → 点击分享按钮 → 弹窗 → 复制链接

    // 步骤1: 注入 clipboard + execCommand 拦截
    await this.injectClipboardInterceptor(page, ['/share/', 'doubao.com']);

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    // v1.9 修复：hover 成功一个元素后立即停止——之前会继续 hover 兜底选择器（main 等），
    // 鼠标被移走导致已显示的操作栏消失，分享按钮永远找不到
    const answerSelectors = [
      '[class*="receive-message"]',
      '[class*="message-content"]',
      '[class*="answer"]',
      '[class*="bubble-content"]',
      '[class*="flow-markdown"]',
      // 兜底
      'main', '[class*="chat"]', '[class*="conversation"]',
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
            await page.waitForTimeout(1500);
            hoveredAny = true;
            break;
          }
        }
      } catch { /* 继续 */ }
    }

    // 步骤3: 健壮地查找并点击分享按钮
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
      '[class*="share"]:not([class*="shared"])',
      '[class*="share-conversation"]',
    ], ['分享', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：hover 消息后重新扫描（v1.9.5: 最多尝试 5 条，避免遍历全部消息浪费数分钟）
      logger.info('[豆包] 首次扫描未找到分享按钮，尝试 hover 消息区域后重新扫描（最多5条）...');
      const allMessages = await page.$$('[class*="message"], [class*="receive"], [class*="bubble"]');
      let attempts = 0;
      for (let i = allMessages.length - 1; i >= 0 && attempts < 5; i--) {
        try {
          const visible = await allMessages[i].isVisible().catch(() => false);
          if (!visible) continue;
          attempts++;
          await allMessages[i].hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(800);
          const clicked = await this.findAndClickShareButton(page, [], ['分享', 'Share', 'share']);
          if (clicked) break;
        } catch { /* 继续 */ }
      }
      const captured = await this.getCapturedShareUrl(page, '/share/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    // 步骤4: 查找并点击"复制链接"按钮（如果有）
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      'button:has-text("Copy")',
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
          console.log(`[豆包] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
    if (capturedUrl) {
      console.log(`[豆包] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
    if (dialogUrl) return dialogUrl;

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[豆包] 未能提取到分享链接');
    return null;
  }
}
