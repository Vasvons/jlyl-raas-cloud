/**
 * 简书平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class JsAdapter extends BasePlatformAdapter {
  platform = 'js';
  displayName = '简书';

  loginCheck = {
    url: 'https://www.jianshu.com/writer#/articles/new',
    selector: "//textarea[contains(@class,'title-input')] | //input[@placeholder='请输入文章标题']",
    urlPattern: '^https://www\\.jianshu\\.com/sign_in',
    logoutKeywords: ['注册', 'sign in', '请登录'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.name',
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

export const js = new JsAdapter();
