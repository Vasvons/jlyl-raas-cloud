import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 腾讯元宝适配器 */
export class YuanbaoAdapter extends BasePlatformAdapter {
  platformName = '腾讯元宝';
  loginUrl = 'https://yuanbao.tencent.com/';
  chatUrl = 'https://yuanbao.tencent.com/chat/';
  supportsShare = true;
  // 扩展选择器：覆盖腾讯元宝可能的页面改版
  protected inputSelector = 'textarea, .chat-input textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.agent-chat__msg__content, [class*="chat-content"], .markdown-body, [class*="response"], [class*="answer"]';
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
