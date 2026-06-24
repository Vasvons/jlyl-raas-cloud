import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  chatUrl = 'https://yiyan.baidu.com/';
  supportsShare = true;
  // 扩展选择器：覆盖文心一言可能的页面改版
  protected inputSelector = 'textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"]';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"]';
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
