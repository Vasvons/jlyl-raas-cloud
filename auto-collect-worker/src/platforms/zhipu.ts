import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 智谱AI适配器 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  chatUrl = 'https://chatglm.cn/chat/';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.markdown-body, [class*="message"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
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
