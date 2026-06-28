import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';
import { smartFindLongestContent } from '../indexedInteractor';

/** 文心一言适配器
 *
 * 2026年6月25日0时起，文心一言官网提问入口升级，迁移至百度文心网站。
 * 原地址 yiyan.baidu.com 首页变为服务升级公告页，不再提供聊天功能。
 *
 * 新地址：https://wenxin.baidu.com/
 *
 * v1.4.4 修复"内容 7 万字符"问题：
 *   之前 bug：[class*="answer"] 等模糊选择器匹配到整个对话容器父元素，
 *   innerHTML 包含图片/UI/侧边栏，导致 7 万字符 + 静态页充满乱码
 *   修复策略：重写 extractContent，用多策略精确提取 AI 回答正文
 *   1. 优先匹配 .markdown-body / #answer_text_id 等明确容器
 *   2. 限制最大长度 50000 字符（超过的可能是抓到容器）
 *   3. 强制清理 HTML（移除 img/script/svg/button/nav 等）
 *   4. 兜底用 smartFindLongestContent
 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://wenxin.baidu.com/';
  chatUrl = 'https://wenxin.baidu.com/';
  supportsShare = true;
  protected inputSelector = 'div[data-slate-node="element"], textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea, [class*="prompt"] textarea, [class*="editor"] textarea, [class*="chat-input"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], [role="textbox"]';
  // 保留选择器用于 waitForSelector，实际提取在 extractContent 中重写
  protected responseSelector = '#answer_text_id, .markdown-body, .answer-content, .answer-text, .bot-reply, .ai-reply, .reply-content, .message-text, .response-text, [class*="answer-text"], [class*="reply-content"], [class*="bot-reply"], [class*="ai-reply"], [class*="message-text"], [class*="response-text"]';
  protected stopButtonSelector = '.pause__ZJpNwrGC, [class*="pause"], [class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  /**
   * 重写 extractContent：精确提取文心一言 AI 回答正文
   *
   * v1.4.4 关键改进：
   *   1. 限制最大长度 50000 字符（防止抓到整个容器）
   *   2. 强制清理 HTML（移除非内容元素）
   *   3. 优先匹配明确的回答容器，避免匹配到父容器
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    await this.scrollToBottom(page);

    // 策略1：优先匹配明确的回答容器（按优先级排序）
    const preciseSelectors = [
      '#answer_text_id',           // 文心一言官方回答 ID
      '.markdown-body',            // Markdown 渲染容器（最常见）
      '.answer-content',
      '.answer-text',
      '.bot-reply',
      '.ai-reply',
      '.reply-content',
      '.message-text',
      '.response-text',
      '[class*="answer-text"]',
      '[class*="reply-content"]',
      '[class*="bot-reply"]',
      '[class*="ai-reply"]',
      '[class*="message-text"]',
      '[class*="response-text"]',
    ];

    const MAX_CONTENT_LENGTH = 50000; // 限制最大长度，防止抓到整个容器

    for (const sel of preciseSelectors) {
      try {
        const elements = await page.$$(sel);
        // 从后往前找（最新的回答通常在后面）
        for (let i = elements.length - 1; i >= 0; i--) {
          const text = (await elements[i].textContent()) || '';
          const trimmedText = text.trim();
          // 只接受 100-50000 字符的内容（过短可能是摘要，过长可能是容器）
          if (trimmedText.length > 100 && trimmedText.length < MAX_CONTENT_LENGTH) {
            // 清理 HTML：移除图片、脚本、按钮等非内容元素
            const cleanedHtml = await elements[i].evaluate((node: HTMLElement) => {
              const clone = node.cloneNode(true) as HTMLElement;
              const removeSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
                'img', 'video', 'audio', 'source',
                'button', 'input', 'textarea', 'select', 'form',
                '.btn', '.button', '.action', '.toolbar', '.menu', '.sidebar',
                '.navigation', '.nav', '.header', '.footer',
                '[class*="btn"]', '[class*="button"]', '[class*="action"]',
                '[class*="toolbar"]', '[class*="menu"]', '[class*="sidebar"]',
                '[class*="navigation"]', '[class*="nav-"]', '[class*="header"]',
                '[class*="footer"]', '[class*="copy"]', '[class*="share"]',
                '[class*="like"]', '[class*="feedback"]', '[class*="rating"]',
                '[role="button"]', '[role="navigation"]', '[role="toolbar"]',
                '[aria-hidden="true"]',
              ];
              for (const r of removeSelectors) {
                clone.querySelectorAll(r).forEach(e => e.remove());
              }
              return clone.innerHTML;
            }).catch(() => '');
            console.log(`[文心一言] 精确选择器 ${sel} 提取成功: ${trimmedText.length} 字符`);
            return { text: trimmedText, html: cleanedHtml || `<div>${trimmedText}</div>` };
          }
        }
      } catch {}
    }

    // 策略2：用 smartFindLongestContent 找最长文本块（兜底）
    try {
      const smart = await smartFindLongestContent(page, 100);
      if (smart && smart.text.length > 100 && smart.text.length < MAX_CONTENT_LENGTH) {
        console.log(`[文心一言] smartFindLongestContent 兜底提取: ${smart.text.length} 字符`);
        return smart;
      }
      // 如果 smartFind 找到的内容超过 50000，截断
      if (smart && smart.text.length >= MAX_CONTENT_LENGTH) {
        const truncated = smart.text.substring(0, MAX_CONTENT_LENGTH);
        console.log(`[文心一言] smartFindLongestContent 截断: ${smart.text.length} -> ${truncated.length} 字符`);
        return { text: truncated, html: `<div>${truncated}</div>` };
      }
    } catch (e: any) {
      console.log(`[文心一言] smartFindLongestContent 失败: ${e.message}`);
    }

    // 策略3：最终降级，取 body 文本（限制长度）
    try {
      const text = await page.evaluate(() => document.body.textContent || '');
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        const truncated = trimmed.length > MAX_CONTENT_LENGTH
          ? trimmed.substring(0, MAX_CONTENT_LENGTH)
          : trimmed;
        console.log(`[文心一言] body.textContent 兜底: ${trimmed.length} -> ${truncated.length} 字符`);
        return { text: truncated, html: `<div>${truncated}</div>` };
      }
    } catch {}

    return { text: '', html: '' };
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言分享链接必须通过点击分享按钮获取
    // 不 fallback 到 getCurrentPageShareUrl：对话 URL 是私有的
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
    ];
    const dialogSelectors = [
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }
    return null;
  }

  protected async afterNavigate(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      return;
    }

    const hasVisibleInput = await this.hasVisibleInput(page);
    if (hasVisibleInput) {
      return;
    }

    console.log(`[文心一言] 未找到可见输入框，尝试点击"开启新对话"按钮`);
    await this.tryClickEntryButton(page);
  }

  private async hasVisibleInput(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 2000, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  private async tryClickEntryButton(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const entryTexts = ['开启新对话', '开始对话', '立即体验', '开始使用', '新建对话', '开始聊天', '立即开始'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text === nt)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text.includes(nt) && text.length < 20)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(3000);
    }
  }
}
