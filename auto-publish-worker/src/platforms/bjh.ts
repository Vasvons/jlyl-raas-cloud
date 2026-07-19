/**
 * 百家号平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class BjhAdapter extends BasePlatformAdapter {
  platform = 'bjh';
  displayName = '百家号';

  loginCheck = {
    url: 'https://baijiahao.baidu.com/builder/rc/home',
    selector: "//div[contains(@class,'avatar')] | //img[contains(@class,'portrait')]",
    urlPattern: '^https://baijiahao\\.baidu\\.com/builder/theme/bjh/login',
    logoutKeywords: ['请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.header-user-name',
      '.user-name',
      '.username',
      '.account-name',
      '.author-name',
      '.name-text',
      '.user-info .name',
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

export const bjh = new BjhAdapter();
