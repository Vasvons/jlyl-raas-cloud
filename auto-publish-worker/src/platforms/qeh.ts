/**
 * 企鹅号平台适配器（v1.9.40）
 *
 * v1.9.40：loginCheck.selector 改为实地验证过的编辑器元素（标题/正文输入框），
 *          避免 .user-info/.user-avatar 选择器失配导致误判登录态失效。
 * 走通用流程，登录态失效不支持自动恢复（由 publishWorker v1.9.40 自动触发重新登录）。
 */
import { BasePlatformAdapter } from './base';

export class QehAdapter extends BasePlatformAdapter {
  platform = 'qeh';
  displayName = '企鹅号';

  loginCheck = {
    url: 'https://om.qq.com/main/creation/article',
    selector: 'span.omui-inputautogrowing__inner[contenteditable="true"] | .ProseMirror.ExEditor-basic',
    urlPattern: '^https://om\\.qq\\.com/userAuth/index',
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

export const qeh = new QehAdapter();
