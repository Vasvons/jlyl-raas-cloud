import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 优先导航到根域名 https://chat.deepseek.com/（不是 /chat），避免 SPA 自动恢复旧对话
 * - 输入框选择器使用 div[class] textarea（DeepSeek 使用 CSS Module 哈希类名如 _24fad49）
 * - 响应选择器使用 .ds-markdown
 *
 * 已知问题：
 * - 根域名有时显示营销页（title="DeepSeek - Into the Unknown"），没有自动跳转到聊天界面
 * - 这种情况下页面可能停留几分钟才跳转，导致"输入框未找到"超时
 *
 * 解决方案：
 * - 导航到根域名后，如果 URL 没有自动跳转到 /chat 或 /a/chat/，主动导航到 /chat
 * - /chat 会自动恢复旧对话（URL 变为 /a/chat/s/{id}），但旧对话也能正常输入
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
   *  2. 检查 URL 是否停留在根域名（没有自动跳转到 /chat 或 /a/chat/）
   *  3. 如果停留在根域名（遇到了营销页），主动导航到 /chat
   *  4. 如果 /chat 找不到可见输入框，尝试点击"新建对话"按钮
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成（DeepSeek 是 React SPA，渲染需要时间）
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    if (currentUrl.includes('sign_in')) {
      return; // 未登录，交给 checkLoginStatus 处理
    }

    const title = await page.title().catch(() => '');
    console.log(`[DeepSeek] 导航后: URL=${currentUrl}, title=${title}`);

    // 如果 URL 停留在根域名（没有自动跳转到 /chat 或 /a/chat/），
    // 说明遇到了营销页（title 通常是 "DeepSeek - Into the Unknown"）
    // 此时主动导航到 /chat 强制进入聊天界面
    const isOnRoot = currentUrl === 'https://chat.deepseek.com/' ||
                     currentUrl === 'https://chat.deepseek.com' ||
                     currentUrl.endsWith('chat.deepseek.com/');
    const hasChatPath = currentUrl.includes('/chat') || currentUrl.includes('/a/chat/');

    if (isOnRoot && !hasChatPath) {
      console.log(`[DeepSeek] URL 停留在根域名 (title=${title})，主动导航到 /chat`);
      try {
        await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        const newUrl = page.url();
        const newTitle = await page.title().catch(() => '');
        console.log(`[DeepSeek] 主动导航到 /chat 后: URL=${newUrl}, title=${newTitle}`);
        currentUrl = newUrl;
      } catch (e: any) {
        console.log(`[DeepSeek] 主动导航到 /chat 失败: ${e.message}`);
      }
    }

    // 检查是否有可见输入框
    const hasVisibleInput = await this.hasVisibleInput(page);

    if (!hasVisibleInput) {
      console.log(`[DeepSeek] 未找到可见输入框 (URL=${currentUrl})，尝试点击"新建对话"按钮`);
      await this.tryClickNewChat(page);

      // 再次检查
      const hasInputAfterClick = await this.hasVisibleInput(page);
      if (!hasInputAfterClick) {
        // 最终诊断：输出页面信息辅助排查
        const diagInfo = await page.evaluate(() => {
          const textareas = Array.from(document.querySelectorAll('textarea'));
          const inputs = Array.from(document.querySelectorAll('input'));
          const contentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
          return {
            url: window.location.href,
            title: document.title,
            textareaCount: textareas.length,
            textareaInfo: textareas.slice(0, 3).map(t => ({
              placeholder: t.placeholder,
              className: t.className.substring(0, 50),
              visible: t.offsetWidth > 0 && t.offsetHeight > 0,
              rect: { w: t.offsetWidth, h: t.offsetHeight }
            })),
            inputCount: inputs.length,
            contentEditableCount: contentEditables.length,
            bodyTextStart: (document.body.textContent || '').substring(0, 200)
          };
        }).catch(() => null);
        console.log(`[DeepSeek] 诊断信息: ${JSON.stringify(diagInfo)}`);
      }
    }
  }

  /** 检测页面是否存在可见的输入框 */
  private async hasVisibleInput(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 2000, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  /** 尝试点击"新建对话"按钮 */
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
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    return url || this.getCurrentPageShareUrl(page);
  }
}
