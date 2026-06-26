import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 豆包适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 输入框：textarea.semi-input-textarea 或 textarea[data-testid="chat_input_input"]
 * - 发送按钮：div.send-btn-wrapper button（需要点击发送，而非按Enter）
 * - 停止按钮：div[class*="break-btn"]（圆形break按钮）
 */
export class DoubaoAdapter extends BasePlatformAdapter {
  platformName = '豆包';
  loginUrl = 'https://www.doubao.com/';
  chatUrl = 'https://www.doubao.com/chat/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 XPath
  protected inputSelector = 'textarea.semi-input-textarea, textarea[data-testid="chat_input_input"], [data-testid="chat_input"] textarea, [class*="chat-input"] textarea, [class*="input-area"] textarea, textarea';
  // 响应选择器：豆包的消息内容容器
  // 之前用 [data-testid="message_text_content"] 匹配不到，导致走兜底逻辑被截断到10000
  // 改用更通用的选择器，参考 auth helper 的滚动容器定位思路
  protected responseSelector = '[class*="receive-message"], [class*="message-content"], [class*="message_text"], [data-testid="message_text_content"], [class*="answer"], [class*="bubble-content"], [class*="chat-content"]';
  // 停止按钮：参考 auth helper 的 div[class*="break-btn"]
  protected stopButtonSelector = '[class*="break-btn"], [data-testid="stop_button"], .stop-btn, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 豆包分享链接必须通过点击分享按钮获取
    // 不 fallback 到 getCurrentPageShareUrl：对话 URL 是私有的
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="shared"])',
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
        if (url) return url;
      }
    }
    return null;
  }
}
