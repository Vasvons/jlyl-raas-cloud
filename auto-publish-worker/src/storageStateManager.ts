import { BrowserContext, Page } from 'playwright';

/**
 * v1.9.6：将任意格式的 storageState 规范化为 Playwright newContext({ storageState }) 接受的标准格式
 *
 * 用于在创建 context 时通过原生参数注入 cookie（而非创建后 addCookies 补丁式注入）。
 * 原生参数注入能让首个页面加载请求就带上登录态 cookie，避免被微信等强检测平台判定为
 * "未登录的自动化访问"并清除 cookie。
 *
 * 支持的输入格式：
 *  1. 完整 Playwright storage_state：{ cookies: [], origins: [{origin, localStorage}] }
 *  2. 旧格式纯 cookies 数组：[{name, value, domain, path, ...}]
 *  3. 字符串 JSON（自动解析）
 *
 * @returns Playwright 标准格式的 storageState 对象；输入无效时返回 null
 */
export function normalizeToPlaywrightStorageState(storageStateRaw: any): any | null {
  if (!storageStateRaw) return null;

  // 字符串则解析 JSON
  let raw = storageStateRaw;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // 纯 cookies 数组 → 包装为标准格式
  if (Array.isArray(raw)) {
    const cookies = normalizePlaywrightCookies(raw);
    if (cookies.length === 0) return null;
    return { cookies, origins: [] };
  }

  // 对象：检查是否已是标准格式
  if (typeof raw === 'object') {
    const hasCookies = Array.isArray(raw.cookies) && raw.cookies.length > 0;
    const hasOrigins = Array.isArray(raw.origins) && raw.origins.length > 0;
    if (!hasCookies && !hasOrigins) return null;

    return {
      cookies: hasCookies ? normalizePlaywrightCookies(raw.cookies) : [],
      origins: hasOrigins ? raw.origins.map((o: any) => ({
        origin: String(o.origin || ''),
        localStorage: o.localStorage || {},
      })) : [],
    };
  }

  return null;
}

/**
 * storage_state 三级降级注入（spec 6.4）
 *
 * v1.9.6：此函数仅作为兜底方案。推荐使用 normalizeToPlaywrightStorageState + newContext({ storageState })
 * 原生参数注入。此函数保留用于 storageState 无法通过 newContext 注入的边缘场景。
 *
 * platform_auth.storage_state 字段可能存的格式（按时间顺序）：
 *  1. 完整 Playwright storage_state（最新）：{ cookies: [], origins: [{origin, localStorage, sessionStorage}] }
 *  2. 旧格式纯 cookies 数组：[{name, value, domain, path, ...}]
 *  3. 普通 cookies 数组（缺少 sameSite 等字段）
 *
 * 注入策略：
 *  - 第一级：完整 storage_state，addCookies + 遍历 origins 写 localStorage/sessionStorage
 *  - 第二级：旧格式 cookies，normalize 后 addCookies
 *  - 第三级：纯 cookies 数组，直接 addCookies
 *
 * @returns true 表示注入成功；false 表示所有策略都失败
 */
export async function injectStorageState(
  context: BrowserContext,
  page: Page,
  storageStateRaw: any
): Promise<boolean> {
  if (!storageStateRaw) {
    return false;
  }

  // 第一级：完整 storage_state（Playwright 标准格式）
  try {
    if (storageStateRaw && typeof storageStateRaw === 'object' && !Array.isArray(storageStateRaw)) {
      const hasOrigins = Array.isArray(storageStateRaw.origins) && storageStateRaw.origins.length > 0;
      const hasCookies = Array.isArray(storageStateRaw.cookies) && storageStateRaw.cookies.length > 0;

      if (hasOrigins || hasCookies) {
        // 注入 cookies
        if (hasCookies) {
          await context.addCookies(normalizePlaywrightCookies(storageStateRaw.cookies));
        }
        // 注入 localStorage / sessionStorage（需先导航到对应 origin）
        if (hasOrigins) {
          for (const origin of storageStateRaw.origins) {
            try {
              const originUrl = origin.origin;
              // 若当前页面不在该 origin，先导航（避免 localStorage 写入失败）
              const currentUrl = page.url();
              if (!currentUrl.startsWith(originUrl)) {
                await page.goto(originUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              }
              // 写入 localStorage
              if (origin.localStorage && typeof origin.localStorage === 'object') {
                await page.evaluate((items) => {
                  for (const [key, value] of Object.entries(items)) {
                    try { window.localStorage.setItem(key, String(value)); } catch (e) {}
                  }
                }, origin.localStorage);
              }
              // 写入 sessionStorage
              if (origin.sessionStorage && typeof origin.sessionStorage === 'object') {
                await page.evaluate((items) => {
                  for (const [key, value] of Object.entries(items)) {
                    try { window.sessionStorage.setItem(key, String(value)); } catch (e) {}
                  }
                }, origin.sessionStorage);
              }
            } catch (e) {
              console.warn(`[StorageState] origin ${origin.origin} 注入失败:`, e);
            }
          }
        }
        return true;
      }
    }
  } catch (e) {
    console.warn('[StorageState] 第一级注入失败:', e);
  }

  // 第二级：normalize 后注入
  try {
    const normalized = normalizePlaywrightCookies(storageStateRaw);
    if (normalized.length > 0) {
      await context.addCookies(normalized);
      return true;
    }
  } catch (e) {
    console.warn('[StorageState] 第二级注入失败:', e);
  }

  // 第三级：直接 addCookies（Playwright 会自动校验/容错）
  try {
    if (Array.isArray(storageStateRaw) && storageStateRaw.length > 0) {
      await context.addCookies(storageStateRaw);
      return true;
    }
  } catch (e) {
    console.warn('[StorageState] 第三级注入失败:', e);
  }

  return false;
}

/**
 * spec 6.4: normalize_playwright_cookies
 *
 * 将旧格式或部分字段缺失的 cookies 数组规范化为 Playwright 接受的格式
 * 必填字段：name, value, domain
 * 可选字段：path, expires, httpOnly, secure, sameSite
 *
 * v1.9.7 修复：Electron BrowserView 的 session.cookies.get() 返回的 cookie 用
 * `expirationDate` 字段（Unix 时间戳，秒），而 Playwright 用 `expires` 字段。
 * 原代码只检查 c.expires，导致 Electron 抓取的 cookie 的 expires 被设为 -1
 * （session cookie），newContext({ storageState }) 注入后页面导航不发送这些
 * cookie，微信显示"请重新登录"。
 *
 * v1.9.12 修复：Cookie 头为空问题
 * Playwright 的 storageState 原生参数注入对 sameSite=Lax/Strict 的 cookie 有特殊行为：
 * 当从新 context（about:blank）导航到目标站点时，这被视为跨站点请求，
 * Lax/Strict cookie 不会被附加到第一个请求，导致 Cookie 头为空，微信显示"请重新登录"。
 * 修复：将所有 cookie 的 sameSite 设为 None（配合 secure=true，在 HTTPS 下正常发送）。
 * 这样所有 cookie 都会在第一个请求中被发送，无论导航来源。
 */
function normalizePlaywrightCookies(raw: any): any[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: any[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    if (!c.name || !c.value || !c.domain) continue;
    // v1.9.7：兼容 Electron (expirationDate) 和 Playwright (expires) 两种字段名
    let expires: number;
    if (typeof c.expires === 'number') {
      expires = c.expires;
    } else if (typeof c.expirationDate === 'number') {
      expires = c.expirationDate > 0 ? c.expirationDate : -1;
    } else {
      expires = -1;
    }
    // v1.9.12：强制 sameSite=None，确保 cookie 在跨站点导航时也被发送
    // 原来 Electron 的 'unspecified' 被映射为 'Lax'，导致 Playwright 不发送 cookie
    // sameSite=None 要求 secure=true，所以这里也强制 secure=true
    const secure = true;  // 强制 secure，配合 sameSite=None
    result.push({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain),
      path: c.path || '/',
      expires,
      httpOnly: Boolean(c.httpOnly),
      secure,
      sameSite: 'None',
    });
  }
  return result;
}

function normalizeSameSite(sameSite: any): 'Strict' | 'Lax' | 'None' {
  if (!sameSite) return 'Lax';
  const s = String(sameSite).toLowerCase();
  if (s === 'strict') return 'Strict';
  // v1.9.7：Electron 用 'no_restriction' 表示 SameSite=None
  if (s === 'none' || s === 'no_restriction') return 'None';
  // Electron 'unspecified' 或 'lax' → Lax
  return 'Lax';
}

/**
 * 从 Playwright BrowserContext 抓取最新的 storage_state
 *
 * 用于：
 *  - 用户在 BrowserView 登录后，抓取登录态存到 platform_auth 表
 *  - 发布完成后刷新账号 storage_state（若网站更新了 token）
 */
export async function captureStorageState(context: BrowserContext): Promise<any> {
  try {
    return await context.storageState();
  } catch (e) {
    console.error('[StorageState] 抓取失败:', e);
    return null;
  }
}
