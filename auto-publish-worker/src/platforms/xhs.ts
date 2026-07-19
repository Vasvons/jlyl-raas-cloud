/**
 * 小红书平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复（cookie 真过期，走 base 默认返回 false）。
 */
import { BasePlatformAdapter } from './base';

export class XhsAdapter extends BasePlatformAdapter {
  platform = 'xhs';
  displayName = '小红书';

  loginCheck = {
    url: 'https://creator.xiaohongshu.com/publish/publish?from=menu',
    selector: "input[placeholder='填写标题会有更多赞哦'] | input[type='file'] | div[contenteditable='true']",
    urlPattern: '^https://creator\\.xiaohongshu\\.com/login\\?source=.*',
    logoutKeywords: ['请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.creator-name',
      '.name-box .name',
      '.user-info .name',
      '.side-user .name',
      '.userName',
      '.nickName',
    ],
  };

  ban = {
    errorSelectors: [
      '.alert',
      '.error-msg',
      '.ban-tip',
      '[class*="ban"]',
      '[class*="error-tip"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
    ],
  };
}

export const xhs = new XhsAdapter();
