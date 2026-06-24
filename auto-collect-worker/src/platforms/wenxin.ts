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
    // 如果被重定向到首页（yiyan.baidu.com/ 末尾无 /chat），尝试点击"开始对话"按钮
    if (currentUrl === 'https://yiyan.baidu.com/' || currentUrl === 'https://yiyan.baidu.com') {
      // 尝试点击"开始对话"/"立即体验"/"开始使用"等入口按钮
      const entrySelectors = [
        'button:has-text("开始对话")',
        'button:has-text("立即体验")',
        'button:has-text("开始使用")',
        'a:has-text("开始对话")',
        'a:has-text("立即体验")',
        '[class*="start"]',
        '[class*="entry"]',
      ];
      for (const sel of entrySelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        } catch {
          // 继续
        }
      }
    }
  }
}
