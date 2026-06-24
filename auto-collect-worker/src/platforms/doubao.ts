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
    try {
      const shareBtn = await page.$('[class*="share"], [class*="Share"], button:has-text("分享"), [data-testid*="share"]');
      if (shareBtn) {
        await shareBtn.click();
        await page.waitForTimeout(1500);
        const linkInput = await page.$('input[class*="share"], input[class*="link"], [class*="share-url"], input[readonly]');
        if (linkInput) {
          const url = await linkInput.inputValue();
          if (url && url.startsWith('http')) return url;
        }
        const clipText = await page.evaluate(() => navigator.clipboard?.readText?.() || '').catch(() => '');
        if (clipText && clipText.startsWith('http')) return clipText;
      }
      return null;
    } catch {
      return null;
    }
  }
}
