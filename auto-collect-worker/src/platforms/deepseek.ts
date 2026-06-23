import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.ds-message--content';
  protected stopButtonSelector = '.stop-button';
  protected loginUrlPattern = 'sign_in';

  async extractShareLink(page: Page): Promise<string | null> {
    try {
      // 尝试点击分享按钮
      const shareBtn = await page.$('[class*="share"], button:has-text("分享")');
      if (shareBtn) {
        await shareBtn.click();
        await page.waitForTimeout(1000);
        // 尝试获取分享链接
        const linkInput = await page.$('input[class*="share"], [class*="share-url"]');
        if (linkInput) {
          return await linkInput.inputValue();
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
