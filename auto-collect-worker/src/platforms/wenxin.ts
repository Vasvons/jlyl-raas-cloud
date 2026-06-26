import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 优先导航到根域名 https://yiyan.baidu.com/（不是 /chat）
 * - 输入框使用 Slate.js 编辑器：div[data-slate-node="element"]（不是 textarea！）
 * - 停止按钮：.pause__ZJpNwrGC
 * - 响应选择器：#answer_text_id
 *
 * fallback 策略：
 * - 根域名有时不显示输入框（可能是账号未登录或首页渲染问题）
 * - 此时降级导航到 /chat，再尝试点击"开始对话"按钮
 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  // 优先使用根域名：auth helper 软件也是导航到根域名
  chatUrl = 'https://yiyan.baidu.com/';
  supportsShare = true;
  // 输入框选择器：参考 auth helper 的 //div[@data-slate-node="element"]
  // 文心一言使用 Slate.js 富文本编辑器，不是普通 textarea
  protected inputSelector = 'div[data-slate-node="element"], textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea, [class*="prompt"] textarea, [class*="editor"] textarea, [class*="chat-input"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], [role="textbox"]';
  // 响应选择器：参考 auth helper 的 //div[@id="answer_text_id"]
  protected responseSelector = '#answer_text_id, .answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  // 停止按钮：参考 auth helper 的 .pause__ZJpNwrGC
  protected stopButtonSelector = '.pause__ZJpNwrGC, [class*="pause"], [class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言主要支持图片分享，URL分享仅限artifact
    return this.getCurrentPageShareUrl(page);
  }

  /** 文心一言导航后处理：
   *  1. 等待 SPA 渲染完成
   *  2. 快速检测"可见的"输入框是否存在（避免匹配到隐藏的textarea）
   *  3. 如果找不到可见输入框，降级导航到 /chat
   *  4. 如果 /chat 也找不到，尝试点击"开始对话"按钮
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      return; // 未登录，交给 checkLoginStatus 处理
    }

    // 快速检测"可见的"输入框是否存在
    // 注意：不能用 page.$（不检查可见性，会匹配到首页搜索框等隐藏textarea）
    const hasVisibleInput = await this.hasVisibleInput(page);

    if (hasVisibleInput) {
      // 根域名正常找到可见输入框，无需降级
      return;
    }

    // 根域名找不到可见输入框，降级导航到 /chat
    console.log(`[文心一言] 根域名未找到可见输入框，降级导航到 /chat`);

    try {
      await page.goto('https://yiyan.baidu.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      const newUrl = page.url();
      console.log(`[文心一言] 降级到 /chat 后: URL=${newUrl}`);

      // 如果 /chat 也找不到可见输入框，尝试点击"开始对话"按钮
      const hasVisibleInputAfterFallback = await this.hasVisibleInput(page);
      if (!hasVisibleInputAfterFallback) {
        console.log(`[文心一言] /chat 也未找到可见输入框，尝试点击入口按钮`);
        await this.tryClickEntryButton(page);
      }
    } catch (e: any) {
      console.log(`[文心一言] 降级导航到 /chat 失败: ${e.message}`);
    }
  }

  /** 检测页面是否存在可见的输入框（避免匹配到隐藏的textarea） */
  private async hasVisibleInput(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 2000, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  /** 尝试点击入口按钮（通过 JS evaluate 绕过 isVisible 检查） */
  private async tryClickEntryButton(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const entryTexts = ['开始对话', '立即体验', '开始使用', '新建对话', '开始聊天', '立即开始'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      // 优先精确匹配
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text === nt)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // 模糊匹配
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text.includes(nt) && text.length < 20)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(3000);
    }
  }
}
