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
  // 扩展选择器：覆盖文心一言可能的页面改版
  protected inputSelector = 'textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言主要支持图片分享，URL分享仅限artifact
    // 只从当前URL提取（匹配 /chat/{id} 或 /artifactShare/{短码}），不点击分享按钮
    return this.getCurrentPageShareUrl(page);
  }
}
