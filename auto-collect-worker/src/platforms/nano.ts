import { BasePlatformAdapter } from './baseAdapter';

/** 纳米搜索适配器 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  supportsShare = false;
  protected inputSelector = 'textarea, input[type="text"]';
  protected responseSelector = '.answer, .result-content, [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
