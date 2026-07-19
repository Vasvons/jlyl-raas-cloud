/**
 * 知乎平台适配器（v1.9.35）
 *
 * 走通用流程，登录态失效不支持自动恢复。
 */
import { BasePlatformAdapter } from './base';

export class ZhAdapter extends BasePlatformAdapter {
  platform = 'zh';
  displayName = '知乎';

  loginCheck = {
    url: 'https://zhuanlan.zhihu.com/write',
    selector: "//textarea | //input[@placeholder='请输入标题（最多 100 个字）']",
    urlPattern: '^https://www\\.zhihu\\.com/signin',
    logoutKeywords: ['注册', '加入知乎', '请登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.AppHeader-userName',
      '.AppHeader-userInfo',
      '.ProfileHeader-name',
      '.UserLink-link',
      '.AuthorInfo-name',
      '.ProfileHeader-title',
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

export const zh = new ZhAdapter();
