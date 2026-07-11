/**
 * 云端巡检 Worker 指纹管理器（复用桌面端 fingerprintManager.ts 实现）
 *
 * 核心能力：
 * 1. 60 个真实指纹配置池（UA × 屏幕分辨率 × 时区 × 语言 × WebGL × Canvas 噪声种子）
 * 2. 隐私模式：每次 newContext 用全新指纹（巡检 Worker 默认模式）
 * 3. 固定身份模式：同一账号始终用同一指纹（基于 accountId 哈希选指纹）
 *
 * 与 stealth.min.js 的关系：
 *  - stealth.min.js 覆盖 navigator.webdriver / plugins / chrome.runtime 等"是否存在"问题
 *  - 本模块覆盖 UA / viewport / locale / timezone / WebGL / Canvas 噪声等"具体值"问题
 */

/**
 * 单个指纹配置
 */
export interface Fingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  timezoneId: string;
  locale: string;
  languages: string[];
  webglVendor: string;
  webglRenderer: string;
  canvasNoiseSeed: number;
  platform: string;
  hardwareConcurrency: number;
}

// ==================== UA 池（10 个真实 Chrome UA） ====================

const UA_POOL: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.130 Safari/537.36',
];

const VIEWPORT_POOL: Array<{ viewport: Fingerprint['viewport']; deviceScaleFactor: number }> = [
  { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  { viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 },
  { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 },
];

const WEBGL_POOL: Array<{ vendor: string; renderer: string }> = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 4600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 5600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

const PLATFORM_POOL: string[] = ['Win32', 'Win32', 'Win32', 'MacIntel', 'MacIntel'];
const HARDWARE_CONCURRENCY_POOL: number[] = [4, 8, 8, 12, 16];

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_LOCALE = 'zh-CN';
const DEFAULT_LANGUAGES = ['zh-CN', 'zh'];

const FINGERPRINT_POOL: Fingerprint[] = (() => {
  const pool: Fingerprint[] = [];
  for (let i = 0; i < 60; i++) {
    const ua = UA_POOL[i % UA_POOL.length];
    const isMac = ua.includes('Macintosh');
    const vp = VIEWPORT_POOL[Math.floor(Math.random() * VIEWPORT_POOL.length)];
    const webgl = WEBGL_POOL[Math.floor(Math.random() * WEBGL_POOL.length)];
    const platform = isMac ? 'MacIntel' : PLATFORM_POOL[Math.floor(Math.random() * PLATFORM_POOL.length)];
    const hc = HARDWARE_CONCURRENCY_POOL[Math.floor(Math.random() * HARDWARE_CONCURRENCY_POOL.length)];

    pool.push({
      userAgent: ua,
      viewport: vp.viewport,
      deviceScaleFactor: vp.deviceScaleFactor,
      timezoneId: DEFAULT_TIMEZONE,
      locale: DEFAULT_LOCALE,
      languages: DEFAULT_LANGUAGES,
      webglVendor: webgl.vendor,
      webglRenderer: webgl.renderer,
      canvasNoiseSeed: Math.floor(Math.random() * 1000000),
      platform,
      hardwareConcurrency: hc,
    });
  }
  return pool;
})();

/**
 * 随机获取一个指纹（隐私模式：每次 newContext 用全新指纹）
 */
export function getRandomFingerprint(): Fingerprint {
  const idx = Math.floor(Math.random() * FINGERPRINT_POOL.length);
  return FINGERPRINT_POOL[idx];
}

/**
 * 基于账号 ID 稳定获取指纹（固定身份模式：同一账号始终用同一指纹）
 */
export function getStableFingerprint(accountId: string | number): Fingerprint {
  const key = String(accountId);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % FINGERPRINT_POOL.length;
  return FINGERPRINT_POOL[idx];
}

/**
 * 生成指纹注入脚本（在 stealth.min.js 之后执行）
 *
 * 覆盖：
 *  - navigator.platform
 *  - navigator.hardwareConcurrency
 *  - WebGL 厂商和渲染器
 *  - Canvas toDataURL/getImageData 加入微小噪声
 */
export function getFingerprintInjectionScript(fp: Fingerprint): string {
  return `
(function() {
  // 1. navigator.platform
  try {
    Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(fp.platform)} });
  } catch (e) {}

  // 2. navigator.hardwareConcurrency
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency} });
  } catch (e) {}

  // 3. WebGL 厂商和渲染器伪造
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    const VENDOR = ${JSON.stringify(fp.webglVendor)};
    const RENDERER = ${JSON.stringify(fp.webglRenderer)};
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return VENDOR;
      if (param === 37446) return RENDERER;
      return origGetParameter.call(this, param);
    };
    if (WebGL2RenderingContext.prototype.getParameter !== origGetParameter2) {
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return VENDOR;
        if (param === 37446) return RENDERER;
        return origGetParameter2.call(this, param);
      };
    }
  } catch (e) {}

  // 4. Canvas 噪声（基于 seed 的微小扰动，不影响视觉但破坏指纹哈希）
  try {
    const SEED = ${fp.canvasNoiseSeed};
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    function seededRandom(seed) {
      let s = seed;
      return function() {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    }

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const imageData = origGetImageData.call(ctx, 0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
          const rng = seededRandom(SEED);
          for (let i = 0; i < imageData.data.length; i += 4) {
            if (rng() > 0.7) {
              imageData.data[i] = imageData.data[i] ^ 1;
            }
          }
          ctx.putImageData(imageData, 0, 0);
        }
      } catch (e) {}
      return origToDataURL.apply(this, args);
    };
  } catch (e) {}
})();
`;
}

/**
 * 将指纹的 newContext 选项提取出来（供 browser.newContext 直接使用）
 */
export function fingerprintToContextOptions(fp: Fingerprint) {
  return {
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    extraHTTPHeaders: {
      'Accept-Language': fp.languages.join(','),
    },
  };
}
