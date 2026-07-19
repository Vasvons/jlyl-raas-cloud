/**
 * 抖音平台适配器（v1.9.35）
 *
 * 抖音创作者中心登录态检测：
 *  - 预检页：creator.douyin.com/creator-micro/content/upload
 *  - 登录后页面含「内容管理」「作品管理」「发布图文」等导航/Tab 元素
 *  - 原 .user-info/.avatar 选择器在抖音页面不存在，已改为 XPath 文本匹配
 *
 * 抖音登录态失效通常是 cookie 真过期，不支持自动恢复，走 base 默认（返回 false）。
 */
import { BasePlatformAdapter } from './base';

export class DyAdapter extends BasePlatformAdapter {
  platform = 'dy';
  displayName = '抖音';

  loginCheck = {
    url: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3',
    selector:
      "//a[contains(text(),'内容管理')] | //a[contains(text(),'作品管理')] | //span[contains(text(),'发布图文')] | //div[contains(@class,'avatar')]",
    urlPattern: '^https://creator\\.douyin\\.com/.*login.*',
    logoutKeywords: ['请登录', '请先登录', 'sign in'],
  };

  login = {
    accountNameSelectors: [
      '.user-name',
      '.nickname',
      '.creator-name',
      '.account-name',
      '.user-info .name',
      '.userName',
    ],
  };

  ban = {
    // 抖音使用 semi-modal 样式体系
    errorSelectors: [
      '.semi-modal-content',
      '[role="dialog"]',
      '.semi-modal',
      '.semi-toast',
      '.semi-notification',
      '.alert',
      '.error-msg',
      '.ban-tip',
      '[class*="ban"]',
      '[class*="error-tip"]',
    ],
  };
}

export const dy = new DyAdapter();
