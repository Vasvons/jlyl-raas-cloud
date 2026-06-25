import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  // 使用 /chat 路径，避免访问根路径时显示营销页
  chatUrl = 'https://chat.deepseek.com/chat';
  supportsShare = true;
  protected inputSelector = 'textarea, #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  protected stopButtonSelector = '.stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  /** DeepSeek 导航后特殊处理：
   *  1. 如果被重定向到首页，尝试点击入口按钮进入聊天页
   *  2. 如果 URL 是 /a/chat/s/{id}（DeepSeek 自动恢复上一次对话），点击"新建对话"创建新对话
   *     因为恢复的旧对话页面可能输入框未正确加载，导致"输入框未找到"
   */
  protected async afterNavigate(page: Page): Promise<void> {
    const currentUrl = page.url();

    // 情况1: 被重定向到首页（chat.deepseek.com/ 末尾无 /chat）
    if (currentUrl === 'https://chat.deepseek.com/' || currentUrl === 'https://chat.deepseek.com') {
      const entrySelectors = [
        'button:has-text("开始对话")',
        'button:has-text("Start")',
        'button:has-text("New Chat")',
        'button:has-text("新建对话")',
        'a:has-text("开始对话")',
        'a[href*="/chat"]',
        '[class*="start"]',
        '[class*="new-chat"]',
        '[class*="newChat"]',
      ];
      for (const sel of entrySelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2000);
            const newUrl = page.url();
            if (newUrl.includes('/chat')) break;
          }
        } catch {
          // 继续
        }
      }

      // 如果点击入口按钮后仍未跳转，尝试直接导航到 /chat
      const postClickUrl = page.url();
      if (!postClickUrl.includes('/chat')) {
        try {
          await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
        } catch {
          // 导航失败，继续（后续检查会处理）
        }
      }
    }

    // 情况2: URL 是 /a/chat/s/{id}（DeepSeek 自动恢复了上一次对话）
    // 此时需要点击"新建对话"按钮，创建新的空对话，确保输入框可用
    if (currentUrl.includes('/a/chat/s/')) {
      const newChatSelectors = [
        // DeepSeek 侧边栏的"新建对话"按钮
        '[class*="new-chat"]',
        '[class*="newChat"]',
        '[class*="create-chat"]',
        'button:has-text("新建对话")',
        'button:has-text("New Chat")',
        'button:has-text("New chat")',
        // 可能的图标按钮
        '[aria-label*="new"]',
        '[aria-label*="New"]',
        '[data-testid*="new-chat"]',
      ];
      for (const sel of newChatSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            const isVisible = await btn.isVisible().catch(() => false);
            if (isVisible) {
              await btn.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(2000);
              // 点击后检查 URL 是否变化（新对话的 URL 通常是 /chat 或 /a/chat/）
              const newUrl = page.url();
              if (!newUrl.includes('/a/chat/s/')) break;
            }
          }
        } catch {
          // 继续
        }
      }
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
