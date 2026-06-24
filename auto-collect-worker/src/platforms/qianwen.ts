import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 通义千问适配器 */
export class QianwenAdapter extends BasePlatformAdapter {
  platformName = '通义千问';
  loginUrl = 'https://tongyi.aliyun.com/qianwen';
  chatUrl = 'https://tongyi.aliyun.com/qianwen/';
  supportsShare = true;
  protected inputSelector = 'textarea, [contenteditable="true"]';
  protected responseSelector = '.answer-area, .markdown-body, [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    try {
      // 通义千问分享按钮通常在消息操作栏
      const shareBtn = await page.$('[class*="share"], [class*="Share"], button:has-text("分享"), [data-testid*="share"]');
      if (shareBtn) {
        await shareBtn.click();
        await page.waitForTimeout(1500);
        // 分享弹窗中的链接输入框或复制按钮
        const linkInput = await page.$('input[class*="share"], input[class*="link"], [class*="share-url"], input[readonly]');
        if (linkInput) {
          const url = await linkInput.inputValue();
          if (url && url.startsWith('http')) return url;
        }
        // 尝试从剪贴板获取（部分平台点分享后直接复制到剪贴板）
        const clipText = await page.evaluate(() => navigator.clipboard?.readText?.() || '').catch(() => '');
        if (clipText && clipText.startsWith('http')) return clipText;
      }
      return null;
    } catch {
      return null;
    }
  }
}
