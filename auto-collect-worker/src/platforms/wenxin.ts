import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 导航到根域名 https://yiyan.baidu.com/（不是 /chat），避免被重定向回首页的问题
 * - 输入框使用 Slate.js 编辑器：div[data-slate-node="element"]（不是 textarea！）
 * - 停止按钮：.pause__ZJpNwrGC
 * - 响应选择器：#answer_text_id
 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  // 使用根域名：auth helper 软件也是导航到根域名 https://yiyan.baidu.com/
  // 导航到 /chat 会被重定向回首页，直接使用根域名避免这个问题
  chatUrl = 'https://yiyan.baidu.com/';
  // 文心一言主要支持图片分享，URL分享仅限artifact
  supportsShare = true;
  // 输入框选择器：参考 auth helper 的 //div[@data-slate-node="element"]
  // 文心一言使用 Slate.js 富文本编辑器，不是普通 textarea
  // 必须包含 div[data-slate-node="element"] 才能正确找到输入框
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
   *  导航到根域名后，ERNIE 首页会自动渲染聊天界面（如果已登录）。
   *  不需要点击"开始对话"按钮——首页本身就包含输入框。
   *  auth helper 软件也是直接在首页上填写关键词，不点击任何入口按钮。
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成
    await page.waitForTimeout(2000);

    // 如果被重定向到登录页，说明未登录（checkLoginStatus 会处理）
    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      return;
    }

    // auth helper 的做法：直接在首页填写关键词，不点击"开始对话"
    // 首页的 Slate.js 编辑器（div[data-slate-node="element"]）就是输入框
    // 不需要额外的导航或点击操作
  }
}
