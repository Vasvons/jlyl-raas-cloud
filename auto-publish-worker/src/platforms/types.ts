/**
 * 平台适配器接口定义（v1.9.35）
 *
 * 每个自媒体平台一个独立模块，实现本接口。通用发布流程通过 adapter 钩子调用
 * 平台特定逻辑，消除 publishWorker.ts / PlaywrightLogin.ts 中的 if(platform===) 分支。
 *
 * 接管 4 项职责：
 *  1. 登录态预检与恢复（loginCheck + recoverLogin + onAfterNavigateForLoginCheck）
 *  2. 登录入口行为（login.isSuccess / autoClickLoginButton / accountNameSelectors）
 *  3. 请求/响应拦截诊断（registerDiagInterceptors）
 *  4. 封禁信号检测（ban.errorSelectors / extraKeywords）
 */
import { Page, BrowserContext } from 'playwright';

/** 钩子调用时的公共参数 */
export interface PlatformHookOpts {
  recordId: number;
  pushLog: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

/** 登录态预检配置 */
export interface LoginCheckConfig {
  /** 预检页面 URL（通常是平台的写文章页或个人中心） */
  url: string;
  /** 登录后才出现的元素选择器（CSS 或 XPath，支持 "a | b" 多选） */
  selector?: string;
  /** 未登录时被重定向到的登录页 URL 正则 */
  urlPattern?: string;
  /** 未登录时页面出现的关键词（如"请登录"） */
  logoutKeywords?: string[];
}

/** 登录入口行为配置 */
export interface LoginBehavior {
  /**
   * 判断 URL 是否表示登录成功
   * @param url 当前页面 URL
   * @returns true 表示登录成功
   */
  isSuccess?(url: string): boolean;
  /**
   * 自动点击登录按钮（如 wxgzh 点击 #jumpUrl）
   * @returns { clicked: boolean, text?: string } 是否点击成功及按钮文字
   */
  autoClickLoginButton?(page: Page): Promise<{ clicked: boolean; text?: string }>;
  /** 抓取账号名的 CSS 选择器列表（按优先级排序） */
  accountNameSelectors: string[];
}

/** 封禁信号检测配置 */
export interface BanCheckConfig {
  /** 封禁/错误提示元素选择器列表（仅在这些元素中检测关键词，不扫整个 body） */
  errorSelectors: string[];
  /** 额外的封禁关键词（通用关键词已在 detectBanSignal 中硬编码，此处补充平台专属） */
  extraKeywords?: string[];
}

export interface PlatformAdapter {
  /** 平台标识（与 platform_auth.platform 字段一致） */
  platform: string;
  /** 平台显示名（用于日志） */
  displayName: string;

  // ===== 1. 登录态预检与恢复 =====
  loginCheck: LoginCheckConfig;
  /**
   * 导航到 loginCheck.url 后、执行登录态检测前的额外处理
   * 默认实现：等待 5 秒让页面稳定
   * wxgzh 覆写：立即点击"登录"按钮（不等检测失效）
   */
  onAfterNavigateForLoginCheck?(page: Page, context: BrowserContext, opts: PlatformHookOpts): Promise<void>;
  /**
   * 登录态失效后的恢复策略
   * @returns true 表示恢复成功可继续；false 表示无法恢复，需报 login_expired
   * 默认实现：返回 false（不支持自动恢复）
   * wxgzh 覆写：点击 #jumpUrl 登录链接尝试恢复会话
   */
  recoverLogin?(page: Page, context: BrowserContext, opts: PlatformHookOpts): Promise<boolean>;

  // ===== 2. 登录入口行为（PlaywrightLogin.ts 用） =====
  login: LoginBehavior;

  // ===== 3. 请求/响应拦截诊断 =====
  /**
   * 注册请求/响应拦截器（在 page.goto 之前调用）
   * 默认实现：不注册任何拦截器
   * wxgzh 覆写：拦截 mp.weixin.qq.com 请求记录 Cookie/sec-ch-ua/UA 头
   */
  registerDiagInterceptors?(page: Page, opts: PlatformHookOpts): void;

  // ===== 4. 封禁信号检测 =====
  ban: BanCheckConfig;
}
