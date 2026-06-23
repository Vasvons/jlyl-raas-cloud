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
    try {
      // Kimi 的分享按钮通常在对话完成后出现
      const shareBtn = await page.$('button:has-text("分享"), [class*="share"]:not([class*="share-text"])');
      if (shareBtn) {
        await shareBtn.click();
        await page.waitForTimeout(1500);
        // 尝试从弹窗中获取链接
        const linkEl = await page.$('input[readonly], [class*="share-link"], [class*="link-input"]');
        if (linkEl) {
          const val = await linkEl.inputValue().catch(() => null);
          if (val) return val;
          const text = await linkEl.textContent();
          if (text && text.startsWith('http')) return text.trim();
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
