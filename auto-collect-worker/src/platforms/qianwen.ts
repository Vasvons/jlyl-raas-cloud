import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 通义千问适配器 */
export class QianwenAdapter extends BasePlatformAdapter {
  platformName = '通义千问';
  loginUrl = 'https://www.qianwen.com';
  chatUrl = 'https://www.qianwen.com/';
  supportsShare = true;
  protected inputSelector = 'textarea, [contenteditable="true"], #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea';
  protected responseSelector = '.answer-area, .markdown-body, [class*="answer"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 通义千问：分享按钮在消息操作栏，点击后弹出对话框
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], [class*="Share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    return url || this.getCurrentPageShareUrl(page);
  }
}
