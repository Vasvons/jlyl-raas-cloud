/**
 * 今日头条平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class TtAdapter extends BasePlatformAdapter {
  platform = 'tt';
  displayName = '今日头条';

  loginCheck = {
    url: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    selector: "textarea[placeholder*='标题'] | div[contenteditable='true']",
    urlPattern: '^https://mp\\.toutiao\\.com/auth/page/login\\?redirect_url=.*',
    logoutKeywords: ['请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.account-name',
      '.author-name',
      '.name-text',
      '.user-info .name',
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

export const tt = new TtAdapter();
