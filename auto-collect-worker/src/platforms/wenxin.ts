import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  // 使用具体的聊天页 URL，避免被重定向到首页
  chatUrl = 'https://yiyan.baidu.com/chat';
  // 文心一言主要支持图片分享，URL分享仅限artifact
  // supportsShare=true 但 extractShareLink 只从当前URL提取，不点击分享按钮
  supportsShare = true;
  // 扩展选择器：覆盖文心一言首页和聊天页的输入框
  // 首页（ERNIE）输入框可能是 textarea 或 contenteditable div，class 含 chat-input/prompt/editor
  protected inputSelector = 'textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea, [class*="prompt"] textarea, [class*="editor"] textarea, [class*="chat-input"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言主要支持图片分享，URL分享仅限artifact
    // 只从当前URL提取（匹配 /chat/{id} 或 /artifactShare/{短码}），不点击分享按钮
    return this.getCurrentPageShareUrl(page);
  }

  /** 文心一言导航后特殊处理：
   *  chatUrl 配置为 /chat，但导航后常被重定向回首页 yiyan.baidu.com/，
   *  因为文心一言的 ERNIE 首页会强制未登录或新会话用户先看营销页。
   *  解决方案（按优先级）：
   *    1. 通过 JS 在页面内查找并点击所有可能的入口按钮（绕过 isVisible 检查）
   *    2. 通过 SPA 路由跳转到 /chat
   *    3. 通过 window.location.href 强制跳转
   *    4. 重新 page.goto('/chat')
   */
  protected async afterNavigate(page: Page): Promise<void> {
    const currentUrl = page.url();

    // 仅在 URL 是首页时执行（/chat 已成功时不处理）
    const isHomePage = currentUrl === 'https://yiyan.baidu.com/' ||
                       currentUrl === 'https://yiyan.baidu.com' ||
                       currentUrl.endsWith('yiyan.baidu.com');

    if (!isHomePage) {
      return;
    }

    console.log(`[文心一言] 检测到被重定向到首页 ${currentUrl}，尝试进入聊天页`);

    // 策略1: 通过 JS 在页面内查找并点击所有可能的入口按钮
    // 不依赖 isVisible，直接强制 click（按钮可能被遮挡或折叠）
    const clicked = await page.evaluate(() => {
      const entryTexts = ['开始对话', '立即体验', '开始使用', '新建对话', '开始聊天', '立即开始', '开始', '体验'];
      const clickableSelectors = 'button, a, [role="button"], [class*="start"], [class*="entry"], [class*="new-chat"], [class*="newChat"], [class*="create-chat"], [class*="hero"] [class*="button"], [class*="banner"] [class*="button"], [class*="welcome"] [class*="button"]';
      const elements = Array.from(document.querySelectorAll(clickableSelectors));
      // 优先匹配明确的入口文本
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text === nt)) {
          (el as HTMLElement).click();
          return { clicked: true, text };
        }
      }
      // 模糊匹配（包含）
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text.includes(nt) && text.length < 20)) {
          (el as HTMLElement).click();
          return { clicked: true, text };
        }
      }
      // class/属性匹配
      const selElements = Array.from(document.querySelectorAll(
        '[class*="start"], [class*="entry"], [class*="new-chat"], [class*="newChat"], [class*="create-chat"], [href*="/chat"]'
      ));
      for (const el of selElements) {
        (el as HTMLElement).click();
        return { clicked: true, text: 'class-selector' };
      }
      return { clicked: false, text: '' };
    }).catch(() => ({ clicked: false, text: '' }));

    if (clicked?.clicked) {
      await page.waitForTimeout(3000);
      const afterClickUrl = page.url();
      if (afterClickUrl.includes('/chat')) {
        console.log(`[文心一言] 点击入口按钮成功（${clicked.text}），新 URL=${afterClickUrl}`);
        return;
      }
    }

    // 策略2: 通过 SPA 路由跳转到 /chat
    // 文心一言是 React SPA，可以通过 history.pushState + popstate 事件触发路由切换
    const routed = await page.evaluate(() => {
      try {
        window.history.pushState({}, '', '/chat');
        window.dispatchEvent(new PopStateEvent('popstate'));
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);

    if (routed) {
      await page.waitForTimeout(3000);
      const afterRouteUrl = page.url();
      if (afterRouteUrl.includes('/chat')) {
        console.log(`[文心一言] SPA 路由跳转成功，新 URL=${afterRouteUrl}`);
        return;
      }
    }

    // 策略3: 通过 window.location.href 强制跳转
    // 这会触发完整页面加载，绕过 SPA 路由守卫
    console.log(`[文心一言] 点击和 SPA 路由均未生效，通过 window.location.href 强制跳转`);
    const jumped = await page.evaluate(() => {
      try {
        window.location.href = '/chat';
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);

    if (jumped) {
      // 等待页面加载
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      } catch {
        // 继续
      }
      await page.waitForTimeout(3000);
      const afterJumpUrl = page.url();
      console.log(`[文心一言] window.location.href 跳转后，URL=${afterJumpUrl}`);
      if (afterJumpUrl.includes('/chat')) {
        return;
      }
    }

    // 策略4: 直接 page.goto('/chat')（兜底）
    try {
      await page.goto('https://yiyan.baidu.com/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      const finalUrl = page.url();
      console.log(`[文心一言] 兜底 page.goto 后，最终 URL=${finalUrl}`);
    } catch (e: any) {
      console.log(`[文心一言] 兜底导航失败: ${e.message}`);
    }
  }
}
