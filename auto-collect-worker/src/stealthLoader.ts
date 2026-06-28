/**
 * 云端巡检 Worker 隐身加载器（借鉴桌面端 stealthLoader.ts）
 *
 * 与桌面端差异：
 *  - 不依赖 electron process.resourcesPath
 *  - 路径解析简化为：__dirname / process.cwd() / 同目录
 *  - 反检测 args 与桌面端完全一致（30+ 参数）
 */

import fs from 'fs';
import path from 'path';

let stealthScriptCache: string | null = null;

/**
 * 加载 stealth.min.js（来自 berstend/puppeteer-extra，MIT 许可证）
 *
 * 路径解析：
 *  - 开发模式：auto-collect-worker/stealth.min.js
 *  - Docker 模式：容器内 /app/stealth.min.js（COPY 时一起打包）
 */
export function getStealthScript(): string {
  if (stealthScriptCache) return stealthScriptCache;

  const candidates: string[] = [
    // 1. 当前目录
    path.join(__dirname, 'stealth.min.js'),
    // 2. 上一级目录（src/ 旁边）
    path.join(__dirname, '..', 'stealth.min.js'),
    // 3. process.cwd()
    path.join(process.cwd(), 'stealth.min.js'),
    // 4. /app/（Docker 容器内常见路径）
    '/app/stealth.min.js',
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        stealthScriptCache = fs.readFileSync(filePath, 'utf-8');
        return stealthScriptCache;
      }
    } catch {
      // 继续尝试下一个候选路径
    }
  }

  throw new Error(`stealth.min.js 未找到，已尝试: ${candidates.join(', ')}`);
}

/**
 * 检查 stealth.min.js 是否存在（不抛错，用于降级处理）
 */
export function hasStealthScript(): boolean {
  try {
    getStealthScript();
    return true;
  } catch {
    return false;
  }
}

/**
 * 30+ 反检测启动参数（综合 spec 6.2 示例 + playwright-stealth / undetected-chromedriver 标准列表）
 *
 * 这些 flag 通过 Playwright launch args 传入，影响 Chromium 启动行为：
 *  - 隐藏自动化特征（webdriver、navigator.webdriver、blink features）
 *  - 模拟真实浏览器（不显示"被自动化软件控制"提示）
 *  - 禁用各种后台节流/优化（保证页面加载稳定）
 *  - 强制中文环境（lang=zh-CN）
 *  - Headless 隐身支持（headless: 'new' 模式下过检测）
 */
export function getAntiDetectionArgs(): string[] {
  return [
    // === 隐藏自动化特征（核心，DeepSeek 被封就是因为缺这些） ===
    '--disable-blink-features=AutomationControlled',
    '--enable-automation=false',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-ipc-flooding-protection',

    // === 沙箱/安全（容器友好 + 避免权限问题） ===
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // === GPU/渲染（兼容性 + 稳定性） ===
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--hide-scrollbars',
    '--mute-audio',

    // === 启动行为（不显示"首次运行"等弹窗） ===
    '--no-first-run',
    '--no-zygote',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--password-store=basic',
    '--use-mock-keychain',

    // === 后台节流（避免 SPA 应用因后台节流导致状态丢失） ===
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',

    // === 隐私/遥测（不发送数据） ===
    '--metrics-recording-only',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=AudioServiceOutOfProcess',

    // === 语言环境（强制中文，匹配国内 IP） ===
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh',

    // === Headless 隐身（借鉴 BrowserAct 隐身浏览器） ===
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--disable-extensions',
    '--disable-plugins-discovery',
    '--window-size=1920,1080',
  ];
}

/**
 * 是否启用 Chrome 新 headless 模式（headless: 'new'）
 *
 * 旧 headless: true 模式有大量自动化特征（HeadlessChrome UA、缺 Chrome.runtime 等）
 * 新 headless: 'new' 模式与有头浏览器几乎一致，过检测能力大幅提升
 *
 * 默认 true（巡检 Worker 在 Docker 内运行，必须有头less）
 * 可通过 STEALTH_HEADLESS=false 环境变量切换到有头模式（用于调试）
 */
export function shouldUseHeadless(): boolean {
  const v = process.env.STEALTH_HEADLESS;
  if (v === undefined) return true; // 默认开启
  return v === 'true' || v === '1' || v === '';
}

/**
 * 应用层注入脚本（与 stealth.min.js 配合使用）
 *
 * 在 stealth.min.js 执行后再注入，覆盖一些 stealth.min.js 未处理或被新版 Chromium 暴露的字段
 */
export function getAppLayerInjectionScript(): string {
  return `
(function() {
  // 1. navigator.webdriver = false（核心，部分版本仍可被检测）
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  } catch (e) {}

  // 2. navigator.languages = ['zh-CN', 'zh']
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
  } catch (e) {}

  // 3. navigator.plugins 模拟真实 Chrome（Headless Chrome 默认 plugins 为空）
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' },
      ],
    });
  } catch (e) {}

  // 4. window.chrome 模拟（Headless Chrome 缺失 window.chrome.runtime）
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: {},
        OnRestartRequiredReason: {},
        PlatformOs: {},
        PlatformArch: {},
      };
    }
  } catch (e) {}

  // 5. permissions API 模拟
  try {
    const originalQuery = navigator.permissions && navigator.permissions.query;
    if (originalQuery) {
      navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  } catch (e) {}
})();
`;
}
