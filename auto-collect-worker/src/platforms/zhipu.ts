import { BasePlatformAdapter } from './baseAdapter';

/** 智谱AI适配器 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  chatUrl = 'https://chatglm.cn/chat/';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.markdown-body, [class*="message"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
