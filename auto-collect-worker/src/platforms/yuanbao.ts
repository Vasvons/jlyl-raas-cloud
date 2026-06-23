import { BasePlatformAdapter } from './baseAdapter';

/** 腾讯元宝适配器 */
export class YuanbaoAdapter extends BasePlatformAdapter {
  platformName = '腾讯元宝';
  loginUrl = 'https://yuanbao.tencent.com/';
  chatUrl = 'https://yuanbao.tencent.com/chat/';
  supportsShare = true;
  // 扩展选择器：覆盖腾讯元宝可能的页面改版
  protected inputSelector = 'textarea, .chat-input textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.agent-chat__msg__content, [class*="chat-content"], .markdown-body, [class*="response"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
