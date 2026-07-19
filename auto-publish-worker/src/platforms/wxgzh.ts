/**
 * 微信公众号平台适配器（v1.9.35）
 *
 * 微信公众号的特殊性：
 *  1. 几乎每次打开都需要点击"登录"按钮才能进入后台（即使 cookie 有效）
 *     - 原因：微信会话机制特殊，导航到 mp.weixin.qq.com 后默认显示"请重新登录"页
 *     - 页面有 <a id="jumpUrl" href="/cgi-bin/loginpage?...">登录</a> 链接
 *     - 点击此链接会跳转到登录页，若 cookie 有效会自动用存储的凭据重新登录
 *  2. 登录成功标志：URL 含 token= 参数
 *  3. 诊断需求：拦截 mp.weixin.qq.com 请求，记录 Cookie/sec-ch-ua/UA 头排查登录态问题
 *  4. 封禁/错误提示元素使用 weui-desktop 样式体系
 */
import { Page, BrowserContext } from 'playwright';
import { BasePlatformAdapter } from './base';
import { PlatformHookOpts } from './types';
import { checkLoginState, PlatformLoginCheck } from '../loginDetector';

export class WxgzhAdapter extends BasePlatformAdapter {
  platform = 'wxgzh';
  displayName = '微信公众号';

  loginCheck = {
    url: 'https://mp.weixin.qq.com/cgi-bin/home',
    selector: 'div.weui-desktop_name | .account_info',
    urlPattern: '^https://mp\\.weixin\\.qq\\.com/cgi-bin/loginpage',
    logoutKeywords: ['请重新登录', '请登录', '登录公众号', '尚未登录'],
  };

  login = {
    /** 登录成功：URL 含 token= 且在 mp.weixin.qq.com 域名下 */
    isSuccess(url: string): boolean {
      return url.includes('token=') && url.includes('mp.weixin.qq.com');
    },

    /**
     * 自动点击微信公众号"登录"按钮
     * 优先匹配 <a id="jumpUrl">登录</a>（"请重新登录"页面）
     * 兜底匹配其他含"登录"文字的可点击元素
     */
    async autoClickLoginButton(page: Page): Promise<{ clicked: boolean; text?: string }> {
      try {
        const clickResult = await page.evaluate(() => {
          // 优先：id="jumpUrl" 的链接
          const jumpUrl = document.getElementById('jumpUrl');
          if (jumpUrl) {
            const rect = jumpUrl.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return {
                found: true,
                text: (jumpUrl.textContent || '').trim(),
                x: Math.round(rect.x + rect.width / 2),
                y: Math.round(rect.y + rect.height / 2),
              };
            }
          }
          // 兜底：找所有含"登录"文字的可点击元素
          const allElements = document.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"], [class*="login"]');
          for (const el of Array.from(allElements)) {
            const text = (el.textContent || '').trim();
            if (text === '登录' || text === '点击登录' || text === '确认登录' || (text.includes('登录') && text.length < 10)) {
              const rect = (el as HTMLElement).getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return {
                  found: true,
                  text: text,
                  x: Math.round(rect.x + rect.width / 2),
                  y: Math.round(rect.y + rect.height / 2),
                };
              }
            }
          }
          return { found: false };
        });

        if (!clickResult || !(clickResult as any).found) {
          return { clicked: false };
        }

        const info = clickResult as any;
        // 用 Playwright 鼠标真实点击坐标（触发 React 合成事件）
        await page.mouse.click(info.x, info.y).catch(() => {});
        return { clicked: true, text: info.text };
      } catch {
        return { clicked: false };
      }
    },

    /** 微信公众号账号名选择器（weui 样式体系） */
    accountNameSelectors: [
      '.weui-desktop-account__name',
      '.weui-desktop-account__info-name',
      '.account_box-panel-item__name',
      '.account-name',
      '.nickname',
      '.user-name',
      '.userName',
    ],
  };

  ban = {
    // 微信公众号 weui 样式体系的错误/封禁提示元素
    errorSelectors: [
      '.js_error_msg',
      '.weui-desktop-toast--warn',
      '.weui-desktop-toast--error',
      '.weui-desktop-toast__content',
      '.frm_msg.fail',
      '.js_cover_error',
      '.alert',
      '.error-msg',
      '.ban-tip',
      '[class*="ban"]',
      '[class*="error-tip"]',
      '.weui-desktop-alert',
      '.weui-desktop-msg',
      '.dialog__error',
      '.appmsg_alert',
      '.tips_box',
      '.js_alert',
    ],
  };

  /**
   * 注册请求/响应拦截器（在 page.goto 之前调用）
   * 拦截 mp.weixin.qq.com 请求记录 Cookie/sec-ch-ua/UA 头
   * 拦截 cgi-bin/home 响应记录 Set-Cookie
   */
  registerDiagInterceptors(page: Page, opts: PlatformHookOpts): void {
    const { recordId, pushLog } = opts;
    let firstRequestLogged = false;

    page.on('request', (req) => {
      if (!firstRequestLogged && req.url().includes('mp.weixin.qq.com')) {
        firstRequestLogged = true;
        req.allHeaders().then((allHeaders) => {
          pushLog(`[record ${recordId}] 请求诊断: ${req.method()} ${req.url().slice(0, 80)}`, 'info');
          pushLog(`[record ${recordId}] 请求诊断: Cookie头=${(allHeaders['cookie'] || '(无)').slice(0, 500)}`, 'info');
          pushLog(`[record ${recordId}] 请求诊断: sec-ch-ua=${allHeaders['sec-ch-ua'] || '(无)'}`, 'info');
          pushLog(`[record ${recordId}] 请求诊断: sec-ch-ua-platform=${allHeaders['sec-ch-ua-platform'] || '(无)'}`, 'info');
          pushLog(`[record ${recordId}] 请求诊断: user-agent=${allHeaders['user-agent'] || '(无)'}`, 'info');
        }).catch(() => {});
      }
    });

    page.on('response', (res) => {
      if (res.url().includes('mp.weixin.qq.com/cgi-bin/home')) {
        const setCookie = res.headers()['set-cookie'];
        if (setCookie) {
          pushLog(`[record ${recordId}] 响应诊断: Set-Cookie=${setCookie.slice(0, 300)}`, 'info');
        }
      }
    });
  }

  /**
   * 导航到预检页后的处理
   * 微信公众号特殊：几乎每次都需要点登录按钮才能进入后台
   * 不等检测登录态失效，导航后立即尝试点登录按钮
   * 如果页面已经是登录状态（URL 含 token），则跳过点击
   */
  async onAfterNavigateForLoginCheck(
    page: Page,
    _context: BrowserContext,
    opts: PlatformHookOpts
  ): Promise<void> {
    const { recordId, pushLog } = opts;
    const currentUrl = page.url();
    if (!currentUrl.includes('token=')) {
      pushLog(`[record ${recordId}] 微信公众号：页面未含 token，立即点击"登录"按钮`, 'info');
      await page.waitForTimeout(1000); // 等待页面渲染
      const recovered = await this.recoverLogin(page, _context, opts);
      if (recovered) {
        pushLog(`[record ${recordId}] 登录态恢复成功（立即点击）`, 'info');
      }
    }
  }

  /**
   * 登录态失效后的恢复策略
   * 点击 #jumpUrl 登录链接尝试恢复会话
   * 持久化目录下，点击此链接可能能恢复会话（微信会尝试用存储的凭据重新登录）
   */
  async recoverLogin(
    page: Page,
    _context: BrowserContext,
    opts: PlatformHookOpts
  ): Promise<boolean> {
    const { recordId, pushLog } = opts;
    try {
      // 1. 查找并点击"登录"按钮
      const clickResult = await this.login.autoClickLoginButton!(page);
      if (!clickResult.clicked) {
        pushLog(`[record ${recordId}] 未找到"登录"按钮，无法恢复`, 'warn');
        return false;
      }
      pushLog(`[record ${recordId}] 点击"登录"按钮: "${clickResult.text}"`, 'info');

      // 2. 等待页面跳转（URL 变化）
      const oldUrl = page.url();
      let newUrl = oldUrl;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(500);
        newUrl = page.url();
        if (newUrl !== oldUrl) {
          pushLog(`[record ${recordId}] 页面已跳转: ${newUrl.slice(0, 100)}`, 'info');
          break;
        }
      }

      // 3. 等待页面加载稳定
      await page.waitForTimeout(3000);

      // 4. 检查是否跳转到带 token 的后台页
      if (newUrl.includes('token=') && newUrl.includes('mp.weixin.qq.com')) {
        pushLog(`[record ${recordId}] 检测到 token，登录态可能已恢复`, 'info');
        // 重新检测登录态
        const recheck = await checkLoginState(page, this.platform, this.toLoginCheckConfig());
        if (recheck.valid) {
          return true;
        }
      }

      // 5. 如果跳转到了登录页（需要扫码），发布 Worker 不应阻塞等待扫码，直接返回 false
      if (newUrl.includes('loginpage') || newUrl.includes('login')) {
        pushLog(`[record ${recordId}] 跳转到登录页，需要重新扫码登录`, 'warn');
        return false;
      }

      // 6. 兜底：再检测一次登录态
      const recheck = await checkLoginState(page, this.platform, this.toLoginCheckConfig());
      return recheck.valid;
    } catch (e: any) {
      pushLog(`[record ${recordId}] 恢复登录态异常: ${e.message}`, 'error');
      return false;
    }
  }

  /** 将 adapter 配置转为 loginDetector.ts 的 PlatformLoginCheck 格式 */
  private toLoginCheckConfig(): PlatformLoginCheck {
    return {
      login_check_url: this.loginCheck.url,
      login_check_selector: this.loginCheck.selector,
      logout_keywords: this.loginCheck.logoutKeywords,
      login_check_url_pattern: this.loginCheck.urlPattern,
    };
  }
}

export const wxgzh = new WxgzhAdapter();
