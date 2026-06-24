import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  // 使用具体的聊天页 URL，避免被重定向到首页
  chatUrl = 'https://yiyan.baidu.com/chat';
  supportsShare = true;
  // 扩展选择器：覆盖文心一言可能的页面改版
  protected inputSelector = 'textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], [class*="Share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    return url || this.getCurrentPageShareUrl(page);
  }
}
