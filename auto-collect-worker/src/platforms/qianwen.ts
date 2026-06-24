import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 通义千问适配器 */
export class QianwenAdapter extends BasePlatformAdapter {
  platformName = '通义千问';
  loginUrl = 'https://www.qianwen.com';
  chatUrl = 'https://www.qianwen.com/';
  supportsShare = true;
  protected inputSelector = 'textarea, [contenteditable="true"], #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea';
  protected responseSelector = '.answer-area, .markdown-body, [class*="answer"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  /**
   * 通义千问分享链接提取
   *
   * 注意：通义千问发送消息后页面URL为 https://www.qianwen.com/chat/{conversationId}，
   * 这是私有对话URL，非登录用户访问会提示"对话不存在"。
   * 真正的公开分享链接格式为 https://tongyi.aliyun.com/qianwen/share?shareId={UUID}，
   * 必须通过点击分享按钮获取，不能用当前页面URL作为分享链接。
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 策略1：点击分享按钮，从弹窗中提取分享链接
    const shareUrl = await this.extractShareLinkFromDialog(
      page,
      // 分享按钮选择器（消息操作栏中的分享图标/按钮）
      '[class*="share"], [class*="Share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"], [class*="action"] [class*="share"], [class*="toolbar"] [class*="share"], [class*="message-action"] [class*="share"], svg[class*="share"], [class*="icon-share"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );

    if (shareUrl) {
      return shareUrl;
    }

    // 策略2：尝试点击"生成分享链接"或"复制链接"按钮
    try {
      const genBtn = await page.$('button:has-text("生成分享链接"), button:has-text("复制链接"), button:has-text("创建分享"), [class*="generate-share"], [class*="copy-link"]');
      if (genBtn) {
        await genBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1500);
        // 重新尝试从弹窗提取
        const url2 = await this.extractShareLinkFromDialog(
          page,
          '[class*="share"]',
          '[class*="dialog"], [class*="modal"], [role="dialog"], [class*="popup"]'
        );
        if (url2) return url2;
      }
    } catch {}

    // 策略3：从页面URL中提取 shareId 参数（部分场景URL会变为分享链接）
    try {
      const currentUrl = page.url();
      const shareIdMatch = currentUrl.match(/[?&]shareId=([a-zA-Z0-9-]{8,})/);
      if (shareIdMatch) {
        // 确保返回的是分享链接格式（优先用旧域名，兼容性更好）
        return `https://tongyi.aliyun.com/qianwen/share?shareId=${shareIdMatch[1]}`;
      }
    } catch {}

    // 不 fallback 到 getCurrentPageShareUrl，因为通义千问的对话URL是私有的
    return null;
  }
}
