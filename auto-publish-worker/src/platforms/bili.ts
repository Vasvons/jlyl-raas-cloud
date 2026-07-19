/**
 * B站平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class BiliAdapter extends BasePlatformAdapter {
  platform = 'bili';
  displayName = 'B站';

  loginCheck = {
    url: 'https://member.bilibili.com/platform/upload/text/new-edit',
    selector: '.header-avatar | .user-info',
    urlPattern: '^https://passport\\.bilibili\\.com/login',
    logoutKeywords: ['请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.uname',
      '.bh-user-name',
      '.header-user-name',
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

export const bili = new BiliAdapter();
