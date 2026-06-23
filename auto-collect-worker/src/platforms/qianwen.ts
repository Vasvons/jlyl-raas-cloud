import { BasePlatformAdapter } from './baseAdapter';

/** 通义千问适配器 */
export class QianwenAdapter extends BasePlatformAdapter {
  platformName = '通义千问';
  loginUrl = 'https://tongyi.aliyun.com/qianwen';
  chatUrl = 'https://tongyi.aliyun.com/qianwen/';
  supportsShare = true;
  protected inputSelector = 'textarea, [contenteditable="true"]';
  protected responseSelector = '.answer-area, .markdown-body, [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
