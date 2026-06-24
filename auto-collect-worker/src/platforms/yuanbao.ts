import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 腾讯元宝适配器 */
export class YuanbaoAdapter extends BasePlatformAdapter {
  platformName = '腾讯元宝';
  loginUrl = 'https://yuanbao.tencent.com/';
  chatUrl = 'https://yuanbao.tencent.com/chat/';
  // 腾讯元宝主要支持图片分享（长图分享），无对话URL分享功能
  // /chat/{id} 是私有对话URL，非登录用户访问看不到内容
  // 设为 false，统一由云端生成静态页兜底，保证内容一定能看到
  supportsShare = false;
  // 扩展选择器：覆盖腾讯元宝可能的页面改版
  protected inputSelector = 'textarea, .chat-input textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.agent-chat__msg__content, [class*="chat-content"], .markdown-body, [class*="response"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 腾讯元宝不支持URL分享，返回 null，由云端生成静态页
    return null;
  }
}
