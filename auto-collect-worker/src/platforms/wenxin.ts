import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://yiyan.baidu.com/';
  chatUrl = 'https://yiyan.baidu.com/';
  supportsShare = true;
  protected inputSelector = 'textarea, #chat-input';
  protected responseSelector = '.answer, .markdown-body, [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
