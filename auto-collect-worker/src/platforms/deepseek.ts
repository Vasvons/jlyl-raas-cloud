import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 优先导航到根域名 https://chat.deepseek.com/（不是 /chat），避免 SPA 自动恢复旧对话
 * - 输入框选择器使用 div[class] textarea（DeepSeek 使用 CSS Module 哈希类名如 _24fad49）
 * - 响应选择器使用 .ds-markdown
 *
 * fallback 策略：
 * - 根域名有时会显示营销页（title="DeepSeek - Into the Unknown"），找不到输入框
 * - 此时降级导航到 /chat（会自动恢复旧对话，但旧对话也能正常输入）
 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  // 优先使用根域名：避免 SPA 自动恢复旧对话（URL 变为 /a/chat/s/{id}）
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  // 输入框选择器：参考 auth helper 的 ._24fad49 textarea
  // DeepSeek 使用 CSS Module 哈希类名，用通配符 div[class] textarea
  protected inputSelector = 'div[class] textarea, textarea, #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  // 响应选择器：参考 auth helper 的 .ds-markdown
  protected responseSelector = '.ds-markdown, .ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  // 停止按钮：参考 auth helper 的 //div[@class="ds-flex _0a3d93b"]
  protected stopButtonSelector = 'div.ds-flex._0a3d93b, .stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  /** DeepSeek 导航后处理：
   *  1. 等待 SPA 渲染完成
   *  2. 快速检测输入框是否存在（3秒超时）
   *  3. 如果找不到输入框（可能遇到了"Into the Unknown"营销页），降级导航到 /chat
   *  4. /chat 会自动恢复旧对话（URL 变为 /a/chat/s/{id}），但旧对话也能正常输入
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('sign_in')) {
      return; // 未登录，交给 checkLoginStatus 处理
    }

    const title = await page.title().catch(() => '');

    // 快速检测输入框是否存在（3秒超时，比 baseAdapter 的 5 秒更快）
    const hasInput = await page.$(this.inputSelector).catch(() => null);

    if (hasInput) {
      // 根域名正常找到输入框，无需降级
      return;
    }

    // 根域名找不到输入框，可能遇到了营销页（如 "DeepSeek - Into the Unknown"）
    console.log(`[DeepSeek] 根域名未找到输入框 (title=${title})，降级导航到 /chat`);

    try {
      await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // /chat 通常会自动恢复旧对话，URL 变为 /a/chat/s/{id}
      // 旧对话页面也能正常输入，不需要强制创建新对话
      const newUrl = page.url();
      const newTitle = await page.title().catch(() => '');
      console.log(`[DeepSeek] 降级到 /chat 后: URL=${newUrl}, title=${newTitle}`);

      // 如果 /chat 也找不到输入框，尝试点击"新建对话"按钮
      const hasInputAfterFallback = await page.$(this.inputSelector).catch(() => null);
      if (!hasInputAfterFallback && newUrl.includes('/a/chat/s/')) {
        console.log(`[DeepSeek] /chat 恢复了旧对话但未找到输入框，尝试点击"新建对话"`);
        await this.tryClickNewChat(page);
      }
    } catch (e: any) {
      console.log(`[DeepSeek] 降级导航到 /chat 失败: ${e.message}`);
    }
  }

  /** 尝试点击"新建对话"按钮（通过 JS evaluate 绕过 isVisible 检查） */
  private async tryClickNewChat(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const newChatTexts = ['新建对话', 'New Chat', 'New chat', '新对话'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (newChatTexts.some(nt => text === nt || text.includes(nt))) {
          (el as HTMLElement).click();
          return true;
        }
      }
      const selElements = Array.from(document.querySelectorAll(
        '[class*="new-chat"], [class*="newChat"], [class*="create-chat"]'
      ));
      for (const el of selElements) {
        (el as HTMLElement).click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(2500);
    }
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
