import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** Kimi 适配器 */
export class KimiAdapter extends BasePlatformAdapter {
  platformName = 'Kimi';
  loginUrl = 'https://kimi.moonshot.cn/login';
  chatUrl = 'https://kimi.moonshot.cn/chat';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.chat-content-item-assistant, [class*="assistant"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // Kimi: 分享按钮在对话完成后出现，点击后弹出分享对话框
    const url = await this.extractShareLinkFromDialog(
      page,
      'button:has-text("分享"), [class*="share"]:not([class*="share-text"]), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    return url || this.getCurrentPageShareUrl(page);
  }
}
