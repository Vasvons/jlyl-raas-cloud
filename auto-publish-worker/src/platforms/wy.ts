/**
 * 网易号平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class WyAdapter extends BasePlatformAdapter {
  platform = 'wy';
  displayName = '网易号';

  loginCheck = {
    url: 'https://mp.163.com/subscribe_v4/index.html',
    selector: '.user-info | .account-avatar',
    urlPattern: '^https://mp\\.163\\.com/login\\.html\\?url=.*',
    logoutKeywords: ['请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.account-name',
      '.author-name',
      '.userName',
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

export const wy = new WyAdapter();
