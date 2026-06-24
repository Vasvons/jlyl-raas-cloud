import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  protected inputSelector = 'textarea, #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea';
  protected responseSelector = '.ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  protected stopButtonSelector = '.stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  async extractShareLink(page: Page): Promise<string | null> {
    // DeepSeek: 分享按钮在消息操作栏，点击后弹出对话框
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    // DeepSeek 发送消息后 URL 会变为 /chat/<conversation_id>，本身就是分享链接
    return url || this.getCurrentPageShareUrl(page);
  }
}
