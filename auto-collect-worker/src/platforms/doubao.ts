import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 豆包适配器 */
export class DoubaoAdapter extends BasePlatformAdapter {
  platformName = '豆包';
  loginUrl = 'https://www.doubao.com/';
  chatUrl = 'https://www.doubao.com/chat/';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '[data-testid="message_text_content"], .message-content, .receive-message';
  protected stopButtonSelector = '[data-testid="stop_button"], .stop-btn';
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
