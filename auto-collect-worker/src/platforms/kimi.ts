import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** Kimi 适配器 */
export class KimiAdapter extends BasePlatformAdapter {
  platformName = 'Kimi';
  loginUrl = 'https://www.kimi.com/login';
  // Kimi 域名已从 kimi.moonshot.cn 迁移到 www.kimi.com
  // 旧域名会被重定向到新域名根路径，导致重定向检测误判
  chatUrl = 'https://www.kimi.com/chat';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.chat-content-item-assistant, [class*="assistant"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // Kimi 分享链接格式：https://www.kimi.com/share/{shareId}
    // 必须通过点击分享按钮获取，不 fallback 到当前对话 URL
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="share-text"]):not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
    ];
    const dialogSelectors = [
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        // Kimi 分享链接必须包含 /share/ 才是公开可访问的
        if (url && url.includes('/share/')) return url;
      }
    }
    return null;
  }
}
