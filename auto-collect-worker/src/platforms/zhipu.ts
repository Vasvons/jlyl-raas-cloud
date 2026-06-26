import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 智谱AI适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - URL：https://chatglm.cn/（根域名）
 * - 输入框：.input-box-inner textarea
 * - 响应选择器：.answer-content .flex1
 * - 停止按钮：div.enter.is-main-chat.searching
 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  chatUrl = 'https://chatglm.cn/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 .input-box-inner textarea
  protected inputSelector = '.input-box-inner textarea, textarea, [class*="input-box"] textarea, [class*="chat-input"] textarea';
  // 响应选择器：参考 auth helper 的 .answer-content .flex1
  // 之前用 [class*="message"] 匹配到了错误的小元素（如侧边栏标签），导致内容长度只有12
  protected responseSelector = '.answer-content .flex1, .answer-content, [class*="answer-content"], .markdown-body';
  // 停止按钮：参考 auth helper 的 div.enter.is-main-chat.searching
  protected stopButtonSelector = 'div.enter.is-main-chat.searching, [class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 智谱清言分享链接格式：https://chatglm.cn/share/{8位短码}
    // 策略1: 点击分享按钮，从弹窗提取链接
    const shareBtnSelectors = [
      '[class*="share"]',
      '[class*="Share"]',
      'button:has-text("分享")',
      'button:has-text("Share")',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
      '[class*="operation"] [class*="share"]',
      '[class*="action"] [class*="share"]',
      // 智谱可能在消息气泡上有分享图标
      '[class*="message"] [class*="share"]',
      '[class*="bubble"] [class*="share"]',
    ];
    const dialogSelectors = [
      '[class*="dialog"]',
      '[class*="modal"]',
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="share-popup"]',
      '[class*="share-content"]',
    ];

    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }

    // 策略2: 点击分享按钮后，可能弹出"复制链接"按钮，点击后再从URL提取
    try {
      const copyBtn = await page.$('button:has-text("复制链接"), button:has-text("复制"), [class*="copy"]');
      if (copyBtn) {
        await copyBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch {
      // 继续
    }

    // 策略3: 从当前页面URL提取 /share/{短码} 格式
    const currentUrl = await this.getCurrentPageShareUrl(page);
    if (currentUrl) return currentUrl;

    return null;
  }
}
