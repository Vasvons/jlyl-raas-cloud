/**
 * 搜狐号平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class SohuAdapter extends BasePlatformAdapter {
  platform = 'sohu';
  displayName = '搜狐号';

  loginCheck = {
    url: 'https://mp.sohu.com/mpfe/v4/contentManagement/first/page',
    selector: '.user-info | .user-avatar',
    urlPattern: '^https://mp\\.sohu\\.com/mpfe/v4/login',
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

export const sohu = new SohuAdapter();
