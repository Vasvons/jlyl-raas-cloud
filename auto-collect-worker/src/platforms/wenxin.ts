import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  // 使用具体的聊天页 URL，避免被重定向到首页
  chatUrl = 'https://yiyan.baidu.com/chat';
  // 文心一言主要支持图片分享，URL分享仅限artifact
  // supportsShare=true 但 extractShareLink 只从当前URL提取，不点击分享按钮
  supportsShare = true;
  // 扩展选择器：覆盖文心一言首页和聊天页的输入框
  // 首页（ERNIE）输入框可能是 textarea 或 contenteditable div，class 含 chat-input/prompt/editor
  protected inputSelector = 'textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea, [class*="prompt"] textarea, [class*="editor"] textarea, [class*="chat-input"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言主要支持图片分享，URL分享仅限artifact
    // 只从当前URL提取（匹配 /chat/{id} 或 /artifactShare/{短码}），不点击分享按钮
    return this.getCurrentPageShareUrl(page);
  }

  /** 文心一言导航后特殊处理：可能停在首页，需要点击"开始对话"或等待输入框渲染 */
  protected async afterNavigate(page: Page): Promise<void> {
    const currentUrl = page.url();
    // 如果被重定向到首页（yiyan.baidu.com/ 末尾无 /chat），尝试点击入口按钮进入聊天页
    if (currentUrl === 'https://yiyan.baidu.com/' || currentUrl === 'https://yiyan.baidu.com') {
      // 扩展选择器：覆盖文心一言/ERNIE 首页各种可能的入口按钮
      const entrySelectors = [
        // 文本按钮
        'button:has-text("开始对话")',
        'button:has-text("立即体验")',
        'button:has-text("开始使用")',
        'button:has-text("新建对话")',
        'button:has-text("开始聊天")',
        'a:has-text("开始对话")',
        'a:has-text("立即体验")',
        'a:has-text("开始使用")',
        'a:has-text("新建对话")',
        'a:has-text("开始聊天")',
        // class/属性选择器
        '[class*="start"]',
        '[class*="entry"]',
        '[class*="new-chat"]',
        '[class*="newChat"]',
        '[class*="create-chat"]',
        '[class*="createChat"]',
        // ERNIE 首页常见的"开始体验"大按钮
        '[class*="hero"] [class*="button"]',
        '[class*="banner"] [class*="button"]',
        '[class*="welcome"] [class*="button"]',
      ];
      for (const sel of entrySelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2000);
            // 点击后检查 URL 是否已跳转到 /chat
            const newUrl = page.url();
            if (newUrl.includes('/chat')) break;
          }
        } catch {
          // 继续
        }
      }

      // 如果点击入口按钮后仍未跳转，尝试直接导航到 /chat 路径
      const postClickUrl = page.url();
      if (!postClickUrl.includes('/chat')) {
        try {
          await page.goto('https://yiyan.baidu.com/chat', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
        } catch {
          // 导航失败，继续（后续检查会处理）
        }
      }
    }
  }
}
