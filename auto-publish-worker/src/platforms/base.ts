/**
 * 平台适配器默认实现（v1.9.35）
 *
 * 大部分平台的登录预检/恢复/诊断拦截走通用流程，只需配置数据无需覆写钩子。
 * 特殊平台（如 wxgzh）继承本类后覆写相应方法。
 */
import { Page, BrowserContext } from 'playwright';
import { PlatformAdapter, PlatformHookOpts } from './types';

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract platform: string;
  abstract displayName: string;
  abstract loginCheck: PlatformAdapter['loginCheck'];
  abstract login: PlatformAdapter['login'];
  abstract ban: PlatformAdapter['ban'];

  /**
   * 默认：导航到预检页后等待 5 秒，让页面稳定 + 可能的重定向完成
   * wxgzh 覆写为：立即点击"登录"按钮（不等检测失效）
   */
  async onAfterNavigateForLoginCheck(
    _page: Page,
    _context: BrowserContext,
    _opts: PlatformHookOpts
  ): Promise<void> {
    await _page.waitForTimeout(5000);
  }

  /**
   * 默认：不支持自动恢复登录态，返回 false（调用方将报 login_expired 提示用户重新登录）
   * wxgzh 覆写为：点击 #jumpUrl 登录链接尝试恢复会话
   */
  async recoverLogin(
    _page: Page,
    _context: BrowserContext,
    _opts: PlatformHookOpts
  ): Promise<boolean> {
    return false;
  }

  /**
   * 默认：不注册任何请求/响应拦截器
   * wxgzh 覆写为：拦截 mp.weixin.qq.com 请求记录 Cookie/sec-ch-ua/UA 头
   */
  registerDiagInterceptors?(_page: Page, _opts: PlatformHookOpts): void {
    // 默认无操作
  }
}
