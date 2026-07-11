import { Page } from 'playwright';

/**
 * 登录态预检（spec 6.5）
 *
 * 对应 auth helper 的 logout_fun：在执行 step_list 前先确认登录态有效，避免跑全流程后才发现未登录
 *
 * 检测维度：
 *  1. URL 跳转检测：navigate 到 login_check_url 后，若被重定向到登录页，说明登录态失效
 *  2. 页面元素检测：检查 login_check_selector 是否存在（登录后才出现的元素）
 *  3. 关键词检测：检查页面内容是否包含 logout_keywords（如"登录""请登录"）
 *
 * 三种检测维度都通过才视为登录态有效
 */

export interface LoginCheckResult {
  valid: boolean;
  reason?: string;
  /** 当前页面 URL（用于日志） */
  currentUrl?: string;
}

export interface PlatformLoginCheck {
  /** 登录态预检页面 URL（通常是平台的写文章页或个人中心） */
  login_check_url?: string;
  /** 登录后才出现的元素选择器（CSS 或 XPath） */
  login_check_selector?: string;
  /** 未登录时页面出现的关键词（如"登录""请登录"） */
  logout_keywords?: string[];
  /** v1.7.0 自定义登录失效 URL 正则（优先级高于平台默认表，对齐 auth helper logout_fun） */
  login_check_url_pattern?: string;
}

/**
 * 通用登录态检测函数
 *
 * @param page Playwright Page 实例
 * @param platform 平台标识（csdn/js/zh/...）
 * @param checkConfig 从 step_list JSON 的 login_check_url/login_check_selector/logout_keywords 字段读取
 */
export async function checkLoginState(
  page: Page,
  platform: string,
  checkConfig?: PlatformLoginCheck
): Promise<LoginCheckResult> {
  const currentUrl = page.url();

  if (!checkConfig) {
    // 没有配置检测项，默认通过（兼容占位平台）
    return { valid: true, currentUrl };
  }

  // 1. URL 跳转检测
  // v1.9.35：优先使用 checkConfig.login_check_url_pattern（来自 adapter.loginCheck.urlPattern）
  //   若未提供则回退到通用 /login/i 检测（旧 loginPatterns 表已迁移到各平台 adapter）
  if (checkConfig.login_check_url) {
    let isLogin = false;
    if (checkConfig.login_check_url_pattern) {
      try {
        const regex = new RegExp(checkConfig.login_check_url_pattern, 'i');
        isLogin = regex.test(currentUrl);
      } catch (e) {
        // 正则解析失败，回退到通用检测
        isLogin = isLoginPage(currentUrl);
      }
    } else {
      // 回退到通用检测（仅匹配 URL 含 login）
      isLogin = isLoginPage(currentUrl);
    }

    if (isLogin) {
      return {
        valid: false,
        reason: `被重定向到登录页（当前 URL: ${currentUrl}）`,
        currentUrl,
      };
    }
  }

  // 2. 页面元素检测
  //    - 用 waitForSelector 等待登录元素出现（带 10 秒超时），给 SPA 足够渲染时间
  //    - 找到后还需二次验证（v1.9.5）：等待页面网络空闲，再检查 body 是否含"请重新登录"等关键词
  //      避免 Loading 页面临时元素命中选择器导致误判
  //    - 超时找不到 → 硬检测：判失效
  let elementFound = false;
  if (checkConfig.login_check_selector) {
    try {
      const selectors = parseSelector(checkConfig.login_check_selector);
      // 用 waitForSelector 竞速等待任意选择器出现（Promise.race + 超时）
      const waitPromises = selectors.map(sel =>
        page.waitForSelector(sel, { timeout: 10000, state: 'attached' })
          .then(() => sel)
          .catch(() => null)
      );
      const winner = await Promise.race(waitPromises);
      if (winner) {
        elementFound = true;
      } else {
        // 所有选择器都超时，等待全部 reject 完成后再判失效
        const results = await Promise.allSettled(waitPromises);
        const anyFulfilled = results.some(r => r.status === 'fulfilled' && r.value !== null);
        if (!anyFulfilled) {
          return {
            valid: false,
            reason: `未检测到登录元素: ${checkConfig.login_check_selector}（等待 10 秒仍未出现，账号可能未登录或 cookie 已过期）`,
            currentUrl,
          };
        }
        elementFound = true;
      }
    } catch (e: any) {
      console.warn(`[LoginDetector] ${platform} 元素检测异常（软检测，不阻断）: ${e.message}`);
    }
  }

  // v1.9.5：元素检测命中后，必须二次验证页面实际内容
  // 避免 Loading 页面/未登录页面临时元素命中选择器导致误判
  if (elementFound) {
    // 等待页面网络空闲（SPA 渲染完成），最多等 8 秒
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    } catch {}
    // 二次检测 body 内容是否含未登录关键词
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const loginFailKeywords = ['请重新登录', '请登录', '登录公众号', '尚未登录'];
      const matched = loginFailKeywords.find(kw => bodyText.includes(kw));
      if (matched) {
        return {
          valid: false,
          reason: `页面含未登录关键词 "${matched}"（元素检测命中但实际未登录，可能 cookie 已失效或为 Loading 页面误判）`,
          currentUrl,
        };
      }
      // v1.9.41：移除"登录"链接检查（text === '登录' 过于宽泛）
      //   已登录页面的页脚/帮助链接可能含"登录"文字导致误判
      //   URL 重定向检测 + 关键词检测已足够覆盖未登录场景
    } catch (e: any) {
      console.warn(`[LoginDetector] ${platform} 二次验证失败:`, e.message);
    }
    return { valid: true, currentUrl };
  }

  // 3. 关键词检测（仅在元素检测未命中时执行）
  if (checkConfig.logout_keywords && checkConfig.logout_keywords.length > 0) {
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const headText = bodyText.slice(0, 500);
      const matchedHead = checkConfig.logout_keywords.find(kw => headText.includes(kw));
      if (matchedHead) {
        return {
          valid: false,
          reason: `页面顶部含未登录关键词 "${matchedHead}"`,
          currentUrl,
        };
      }
    } catch (e: any) {
      console.warn(`[LoginDetector] ${platform} 关键词检测失败:`, e.message);
    }
  }

  return { valid: true, currentUrl };
}

/**
 * 判断当前 URL 是否是登录页
 *
 * v1.9.35：平台专属 URL 正则已迁移到各平台 adapter 的 loginCheck.urlPattern
 * 此函数仅作通用回退（URL 含 login 字样），平台精确匹配由 checkLoginState
 * 通过 checkConfig.login_check_url_pattern 参数传入。
 */
function isLoginPage(url: string): boolean {
  return /login/i.test(url);
}

/**
 * 解析选择器字符串
 *
 * step_list 中 selector 字段支持多种格式：
 *  - "css selector"
 *  - "//xpath"
 *  - "css1 | //xpath1 | css2"（多种选择器任一匹配，用 " | " 分割）
 *
 * 重要：分隔符必须是 " | "（前后有空格的管道符），否则会被当作选择器的一部分。
 * XPath 选择器内的 "/" 不能作为分隔符（"//input" 中的 "//" 是 XPath 起始符）。
 */
function parseSelector(selector: string): string[] {
  // 仅以 " | " (管道符前后必须有空白) 作为分隔符
  const parts = selector.split(/\s+\|\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [selector.trim()];
}

/**
 * 封禁信号检测（spec 6.7）
 *
 * 检测页面是否出现封禁相关提示，命中时标记 banned
 *
 * v1.7.26 修复：之前扫描整个 body.innerText，发表成功后的页面可能含有"账号异常"
 * 等无关文字（如帮助文档、公告链接），导致误判 banned。
 * 现在仅在明确的错误/封禁提示元素中检测，且要求关键词更精确。
 *
 * v1.9.35：errorSelectors 由各平台 adapter 提供（adapter.ban.errorSelectors），
 * 不再硬编码 weui 专属选择器。extraKeywords 补充平台专属封禁关键词。
 *
 * @param page Playwright Page 实例
 * @param platform 平台标识（仅用于日志）
 * @param errorSelectors 错误/封禁提示元素选择器列表（来自 adapter.ban.errorSelectors）
 * @param extraKeywords 额外的平台专属封禁关键词（通用关键词已硬编码）
 */
export async function detectBanSignal(
  page: Page,
  platform: string,
  errorSelectors?: string[],
  extraKeywords?: string[]
): Promise<{ banned: boolean; reason?: string }> {
  // 默认选择器（向后兼容：若未传入则用通用选择器）
  const selectors = errorSelectors && errorSelectors.length > 0 ? errorSelectors : [
    '.alert', '.error-msg', '.ban-tip', '[class*="ban"]', '[class*="error-tip"]',
    '[role="alertdialog"]',
  ];
  try {
    const result = await page.evaluate((sels: string[]) => {
      const errorTexts: string[] = [];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          const t = ((el as HTMLElement).innerText || el.textContent || '').trim();
          if (t) errorTexts.push(t);
        });
      }
      // 同时检测 alert/confirm 弹窗内的文字（封禁提示通常在弹窗里）
      document.querySelectorAll('[role="alertdialog"], .weui-desktop-dialog, .weui-desktop-modal').forEach(d => {
        const r = (d as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const t = ((d as HTMLElement).innerText || '').trim();
          if (t) errorTexts.push(t);
        }
      });
      return { errorTexts, bodySnippet: (document.body.innerText || '').slice(0, 200) };
    }, selectors);

    // 精确的封禁关键词（避免误判，要求更长的短语）
    const banKeywords = [
      '账号已被封禁', '账号已被限制', '账号已封停',
      '账号已被禁用', '账号已被关闭', '封号', '禁言',
      '您的账号已被限制发布', '账号违规',
      '账号异常',  // 保留但在精确元素中检测
    ];
    // 合并平台专属关键词
    if (extraKeywords && extraKeywords.length > 0) {
      banKeywords.push(...extraKeywords);
    }

    for (const errorText of result.errorTexts) {
      for (const kw of banKeywords) {
        if (errorText.includes(kw)) {
          return { banned: true, reason: `检测到封禁关键词: ${kw}（来源: 错误提示元素）` };
        }
      }
    }
    return { banned: false };
  } catch (e: any) {
    console.warn(`[LoginDetector] ${platform} 封禁检测失败:`, e.message);
    return { banned: false };
  }
}
