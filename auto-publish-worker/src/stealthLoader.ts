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
    // 注意：不再传 --disable-dev-shm-usage。
    //   docker-compose.yml 已给 auto-publish-worker 挂载 shm_size: 1g（/dev/shm）。
    //   若再加 --disable-dev-shm-usage，Chromium 会忽略 /dev/shm，把共享内存挤进物理 RAM，
    //   与 mem_limit 3g 抢额度，导致微信渲染进程 OOM（Page crashed）。
    //   删除该 flag 后共享内存走专用 1g /dev/shm，给渲染进程留足 RAM 余量。

    // === GPU/渲染（兼容性 + 稳定性） ===
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--hide-scrollbars',
    '--mute-audio',

    // v3.13.15：撤回 v3.13.14 三连（chrome日志实锤其为毒药）：
    //   镜像用 Alpine 系统 chromium（不带 SwiftShader，那是 Playwright 自带 chromium
    //   才有的），SwANGLE EGL_NOT_INITIALIZED 是环境必然：
    //   - --in-process-gpu：把 GPU 初始化搬进浏览器主进程 → GL 必然失败 → 主进程死 →
    //     「browser.newContext: browser has been closed」所有平台浏览器启动即死
    //     （比原来更糟：原来独立 GPU 进程模式下死的只是 GPU 进程，浏览器活着）
    //   - --use-angle=swiftshader / --enable-unsafe-swiftshader：无 SwiftShader 库，
    //     解锁也无济于事（日志实证加了两 flag 后 SwANGLE 仍 EGL_NOT_INITIALIZED）
    //   独立 GPU 进程模式是该环境唯一可行形态：GPU 进程死 → viz 软件合成兜底 →
    //   绝大多数页面正常（tt/bjh/zh 实证），仅 wxgzh loginpage 崩（见下方 WebGL 处置）

    // v3.13.15：wxgzh loginpage 崩溃的针对性处置
    //   崩点稳定在 loginpage@10s，低内存静默死。loginpage 与其他页的本质差异：
    //   登录页跑 canvas/WebGL 指纹检测脚本（QR 码 + 浏览器指纹），在无 GPU 无
    //   SwiftShader 的环境里 WebGL 上下文创建即崩 renderer。禁掉 WebGL/3D API，
    //   检测脚本拿到 null 会跳过（不崩），反指纹损失可忽略（发布场景不依赖 WebGL 伪装）
    '--disable-webgl',
    '--disable-3d-apis',

    // v3.13.16：阻止 viz 起独立 GPU 进程（14:07 轮再次实锤因果：GPU 进程 EGL 初始化
    //   失败退出时刻 = loginpage renderer 崩溃时刻，两者相差 <100ms，多轮复现）。
    //   关键认知：--disable-gpu 管不住 viz——日志报错来自 viz_main_impl（viz 仍起
    //   GPU 进程做 EGL 初始化，Alpine chromium 无 SwiftShader 必败退出）。
    //   --disable-gpu-compositing 强制渲染进程内软件合成，viz 不再需要 GPU 进程，
    //   从根上消除「GPU 进程退出拖崩同时刻初始化的 renderer」这条链。
    //   （若本轮仍崩，下一步方案：换 Playwright 自带 chromium——内置 SwiftShader，
    //     GL 可真正初始化成功，GPU 进程存活；代价是镜像 +170MB）
    '--disable-gpu-compositing',

    // === 启动行为（不显示"首次运行"等弹窗） ===
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--password-store=basic',
    '--use-mock-keychain',

    // v3.13.13：移除 --no-zygote（chrome日志实锤：GPU进程退出后，wxgzh loginpage 的
    //   新渲染进程在无 zygote 的非常规派生路径上崩溃——日志两次警告
    //   "process type 'renderer' should be created through the zygote"，第二个 renderer
    //   即崩溃进程；zygote 是渲染进程的标准派生路径，容器 headless 下同样支持）
    // v3.13.13：新增 --disable-vulkan（容器无 GPU/Vulkan 扩展，ANGLE Vulkan 初始化
    //   必然失败且连锁导致 GPU 进程退出——日志：Internal Vulkan error (-7) →
    //   "Exiting GPU process due to errors during initialization"；禁用 Vulkan 让
    //   GPU 进程干净走软件路径而非崩溃退出）
    '--disable-vulkan',

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
 * 是否启用 Chrome 新 headless 模式
 *
 * 旧 headless 模式有大量自动化特征（HeadlessChrome UA、缺 Chrome.runtime 等）
 * 新 headless 模式（通过 args 传 --headless=new）与有头浏览器几乎一致，过检测能力大幅提升
 *
 * 注意：Playwright 的 headless 参数只接受 boolean，不接受字符串 'new'（这是 Puppeteer 语法）。
 *      要启用新 headless 模式，headless 传 true，同时在 args 中加 --headless=new。
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
