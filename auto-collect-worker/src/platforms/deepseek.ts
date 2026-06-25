import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 导航到根域名 https://chat.deepseek.com/（不是 /chat），避免 SPA 自动恢复旧对话
 * - 输入框选择器使用 div[class] textarea（DeepSeek 使用 CSS Module 哈希类名如 _24fad49）
 * - 响应选择器使用 .ds-markdown
 * - 停止按钮使用 XPath //div[@class="ds-flex _0a3d93b"]
 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  // 使用根域名而非 /chat：避免 DeepSeek SPA 自动恢复上次对话（URL 变为 /a/chat/s/{id}）
  // 导航到根域名时，SPA 会显示新的聊天界面，不会恢复旧对话
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  // 输入框选择器：参考 auth helper 的 ._24fad49 textarea
  // DeepSeek 使用 CSS Module 哈希类名，无法精确匹配，用通配符 div[class] textarea
  protected inputSelector = 'div[class] textarea, textarea, #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  // 响应选择器：参考 auth helper 的 .ds-markdown
  protected responseSelector = '.ds-markdown, .ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  // 停止按钮：参考 auth helper 的 //div[@class="ds-flex _0a3d93b"]
  protected stopButtonSelector = 'div.ds-flex._0a3d93b, .stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  /** DeepSeek 导航后处理：
   *  导航到根域名后，SPA 会自动渲染聊天界面。
   *  不需要点击"新建对话"或处理自动恢复的旧对话。
   *  只需等待页面完全渲染即可。
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成（DeepSeek 是 React SPA，需要额外时间渲染输入框）
    await page.waitForTimeout(2000);

    // 如果被重定向到登录页，说明未登录（checkLoginStatus 会处理）
    const currentUrl = page.url();
    if (currentUrl.includes('sign_in')) {
      return;
    }

    // 如果 URL 变为 /a/chat/s/{id}（SPA 自动恢复了旧对话），
    // 旧对话页面也能正常输入，不需要强制创建新对话
    // auth helper 软件也是直接在恢复的对话页面上输入，不点击"新建对话"
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // DeepSeek: 分享按钮在消息操作栏，点击后弹出对话框
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    // DeepSeek 发送消息后 URL 会变为 /chat/<conversation_id>，本身就是分享链接
    return url || this.getCurrentPageShareUrl(page);
  }
}
