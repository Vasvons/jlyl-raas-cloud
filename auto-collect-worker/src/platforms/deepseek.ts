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
   *  DeepSeek 访问 /chat 时会自动恢复上一次对话，URL 变为 /a/chat/s/{id}，
   *  旧对话页面的输入框可能未正确加载，导致"输入框未找到"。
   *  解决方案（按优先级）：
   *    1. 通过 JS 在页面内查找并点击所有可能的"新建对话"按钮（绕过 isVisible 检查，因为按钮可能被折叠侧边栏隐藏）
   *    2. 如果点击失败，清除 localStorage 中所有可能存储会话信息的键
   *    3. 重新导航到 /chat（清除后不会自动恢复旧对话）
   */
  protected async afterNavigate(page: Page): Promise<void> {
    const currentUrl = page.url();

    // 情况1: URL 是 /a/chat/s/{id}（DeepSeek 自动恢复了上一次对话）
    if (currentUrl.includes('/a/chat/s/')) {
      console.log(`[DeepSeek] 检测到自动恢复的旧对话 ${currentUrl}，尝试创建新对话`);

      // 策略1: 通过 JS 在页面内查找并点击所有可能的"新建对话"按钮
      // 不依赖 isVisible（按钮可能被折叠侧边栏隐藏），直接强制 click
      const clicked = await page.evaluate(() => {
        // 文本匹配：优先级最高的"新建对话"按钮
        const newChatTexts = ['新建对话', 'New Chat', 'New chat', '新对话', 'Start New Chat'];
        const clickableSelectors = 'button, a, [role="button"], [class*="new-chat"], [class*="newChat"], [class*="create-chat"]';
        const elements = Array.from(document.querySelectorAll(clickableSelectors));
        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (newChatTexts.some(nt => text === nt || text.includes(nt))) {
            (el as HTMLElement).click();
            return true;
          }
        }
        // class/属性匹配
        const selElements = Array.from(document.querySelectorAll(
          '[class*="new-chat"], [class*="newChat"], [class*="create-chat"], [aria-label*="new" i], [aria-label*="New"], [data-testid*="new-chat"]'
        ));
        for (const el of selElements) {
          (el as HTMLElement).click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (clicked) {
        await page.waitForTimeout(2500);
        const afterClickUrl = page.url();
        if (!afterClickUrl.includes('/a/chat/s/')) {
          console.log(`[DeepSeek] 点击新建对话成功，新 URL=${afterClickUrl}`);
          return;
        }
      }

      // 策略2: 通过 SPA 路由跳转到 /chat
      // DeepSeek 是 React SPA，可以通过 history.pushState + popstate 事件触发路由切换
      const routed = await page.evaluate(() => {
        try {
          // 尝试通过 history API 切换到新对话路由
          window.history.pushState({}, '', '/chat');
          window.dispatchEvent(new PopStateEvent('popstate'));
          return true;
        } catch {
          return false;
        }
      }).catch(() => false);

      if (routed) {
        await page.waitForTimeout(2500);
        const afterRouteUrl = page.url();
        if (!afterRouteUrl.includes('/a/chat/s/')) {
          console.log(`[DeepSeek] SPA 路由跳转成功，新 URL=${afterRouteUrl}`);
          return;
        }
      }

      // 策略3: 清除 localStorage 中所有键，然后重新 goto /chat
      // DeepSeek 通过 localStorage 保存上次对话ID，清除后不会自动恢复
      console.log(`[DeepSeek] 点击和路由跳转均未生效，清除 localStorage 后重新导航`);
      await page.evaluate(() => {
        try {
          // 清除所有可能的会话相关键
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (
              key.toLowerCase().includes('chat') ||
              key.toLowerCase().includes('conversation') ||
              key.toLowerCase().includes('session') ||
              key.toLowerCase().includes('last') ||
              key.toLowerCase().includes('recent')
            )) {
              keysToRemove.push(key);
            }
          }
          // 如果没找到明确的会话键，清除全部 localStorage（保守起见只清除会话相关的）
          if (keysToRemove.length === 0) {
            localStorage.clear();
            console.log('[DeepSeek] localStorage 已全部清除');
          } else {
            keysToRemove.forEach(k => localStorage.removeItem(k));
            console.log(`[DeepSeek] 已清除 ${keysToRemove.length} 个会话相关 localStorage 键: ${keysToRemove.join(', ')}`);
          }
        } catch {
          // 继续
        }
      }).catch(() => {});

      // 清除后重新导航到 /chat
      try {
        await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const finalUrl = page.url();
        console.log(`[DeepSeek] 清除 localStorage 后重新导航，最终 URL=${finalUrl}`);
      } catch (e: any) {
        console.log(`[DeepSeek] 重新导航失败: ${e.message}`);
      }
    }

    // 情况2: 被重定向到首页（chat.deepseek.com/ 末尾无 /chat）
    // 此场景通常表示账号未登录或被强制跳到营销页
    if (currentUrl === 'https://chat.deepseek.com/' || currentUrl === 'https://chat.deepseek.com') {
      console.log(`[DeepSeek] 检测到被重定向到首页，尝试导航到 /chat`);
      try {
        await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        // 递归处理：如果导航后又被自动恢复到 /a/chat/s/，应用上面的逻辑
        const newUrl = page.url();
        if (newUrl.includes('/a/chat/s/')) {
          // 递归调用一次（最多一层）
          await this.afterNavigate(page);
        }
      } catch (e: any) {
        console.log(`[DeepSeek] 从首页导航到 /chat 失败: ${e.message}`);
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
