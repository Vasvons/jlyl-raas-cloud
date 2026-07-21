/**
 * 云端发布执行器（v2.0.0 P6）
 *
 * 从桌面端 publishWorker.ts 迁移，适配云端环境：
 *  - 不依赖 Electron（无 getJlylServerPort / electron.app）
 *  - HTTP 调用直接走 SERVER_URL（不走本地代理）
 *  - 使用 X-Worker-Secret 头认证（不走 JWT）
 *  - 使用 chromium.launch() + newContext({ storageState }) 替代 launchPersistentContext
 *  - 不支持 refreshLoginWithPlaywright（云端无法交互式登录）
 *  - 不支持平台适配器（使用基础登录检查）
 *  - 同平台串行锁（避免 Chrome 崩溃）
 */
import { chromium, BrowserContext } from 'playwright';
import axios from 'axios';
import { getStealthScript, getAntiDetectionArgs, shouldUseHeadless } from './stealthLoader';
import { getStableFingerprint, fingerprintToContextOptions, getFingerprintInjectionScript } from './fingerprintManager';
import { normalizeToPlaywrightStorageState, injectStorageState, captureStorageState } from './storageStateManager';
import { checkLoginState, detectBanSignal, PlatformLoginCheck } from './loginDetector';
import { executeSteps, Step, StepExecutionContext } from './stepExecutor';
import { getPlatformAdapter, isPlatformSupported } from './platforms';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_SECRET = process.env.WORKER_SECRET || '';

// v2.1.0：补齐容错韧性（对齐桌面端 publishWorker v2.0.8）
const RECORD_TIMEOUT_MS = 8 * 60 * 1000;   // record 级 8 分钟超时（防 step 卡死占用并发槽）
const PLATFORM_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 同平台锁 5 分钟超时（防 context.close() 卡住导致同平台饿死）
const PUBLISH_DELAY_MIN_MS = 5000;         // 发布前随机延迟下限 5s（反检测）
const PUBLISH_DELAY_MAX_MS = 15000;        // 发布前随机延迟上限 15s（反检测）
const REPORT_RETRY_MAX = 3;                // 回写重试次数
const REPORT_RETRY_BASE_MS = 1000;         // 回写重试基础间隔（指数退避 1s/2s/4s）

// 同平台串行锁（与桌面端一致，避免同一平台多个 record 共用资源导致 Chrome 崩溃）
const platformLocks: Map<string, Promise<void>> = new Map();

export interface PublishRecord {
  record_id: number;
  task_id: number;
  platform: string;
  platform_auth_id: number;
  account_name?: string;
  account_storage_state: any;
  account_proxy?: any;
  /** v2.5.33：客户 ID，用于推送事件时带上正确的 user_id（原 bug：worker 推送事件 user_id=0 导致前端查不到） */
  user_id?: number;
  article: {
    id: number;
    title: string;
    content_html: string;
    tags: string[];
    cover_image_url?: string;
  };
  scheduled_at?: string;
  step_list: {
    platform: string;
    version?: string;
    login_check_url?: string;
    login_check_url_pattern?: string;
    login_check_selector?: string;
    logout_keywords?: string[];
    steps: Step[];
    is_placeholder?: boolean;
  } | null;
}

export interface PublishResult {
  status: 'success' | 'failed' | 'login_expired' | 'banned';
  error_type?: string;
  article_id_on_platform?: string;
  platform_url?: string;
  error_msg?: string;
  screenshot_path?: string;
}

/**
 * 处理单条发布记录（完整流程）
 *
 * v2.1.0 补齐容错韧性（对齐桌面端 publishWorker v2.0.8）：
 *  - record 级 8 分钟超时（Promise.race，防 step 卡死占用并发槽）
 *  - 同平台锁 5 分钟超时（防 context.close() 卡住导致同平台饿死）
 *  - 发布前 5-15s 随机延迟（反检测）
 *  - WebGL/Canvas 噪声脚本注入（对齐桌面端指纹能力）
 *  - 回写 3 次重试 + 指数退避（防回写丢失）
 *  - 关键事件推送到 flywheel_event_log（让桌面端看到云端 worker 日志）
 */
export async function processRecord(record: PublishRecord): Promise<void> {
  const recordId = record.record_id;
  const platform = record.platform;
  const articleTitle = record.article?.title || '(无标题)';
  logger.setRecordId(recordId);
  logger.info(`开始处理 [${platform}] "${articleTitle}"`);

  // v2.1.0：推送事件到云端 flywheel_event_log（让桌面端"自动写作"Tab 的云端日志能看到）
  void reportFlywheelEvent('publish_started', `开始发布 [${platform}] "${articleTitle}"（record #${recordId}）`, { record_id: recordId, platform, task_id: record.task_id }, record.user_id).catch(() => {});

  // v2.1.0：同平台锁 5 分钟超时（防 context.close() 卡住导致同平台饿死）
  const prevLock = platformLocks.get(platform) || Promise.resolve();
  let releaseLock!: () => void;
  const thisLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  const lockWithTimeout = Promise.race([
    prevLock,
    new Promise<void>((resolve) => setTimeout(() => {
      logger.warn(`同平台锁等待超时（${PLATFORM_LOCK_TIMEOUT_MS / 1000}s），强制继续执行`);
      resolve();
    }, PLATFORM_LOCK_TIMEOUT_MS)),
  ]);
  platformLocks.set(platform, lockWithTimeout.then(() => thisLock));
  await lockWithTimeout;

  // v2.1.0：用 record 级超时包裹整个执行流程（防 step 卡死）
  const executePromise = processRecordInner(record, recordId, platform, articleTitle);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`record 执行超时（${RECORD_TIMEOUT_MS / 1000}s），强制终止`)), RECORD_TIMEOUT_MS);
  });

  try {
    await Promise.race([executePromise, timeoutPromise]);
  } catch (err: any) {
    // processRecordInner 内部已有 catch 处理，这里只处理超时
    const isTimeout = err.message?.includes('执行超时');
    if (isTimeout) {
      logger.error(`record #${recordId} 超时: ${err.message}`);
      void reportFlywheelEvent('publish_failed', `[${platform}] record #${recordId} 执行超时（8分钟）`, { record_id: recordId, platform, reason: 'timeout' }, record.user_id).catch(() => {});
      await reportPublishResult(recordId, {
        status: 'failed',
        error_type: 'timeout',
        error_msg: err.message,
      }).catch(() => {});
    }
    // 非 timeout 的错误已由 processRecordInner 内部处理，这里不重复
  } finally {
    releaseLock();
  }
}

/**
 * processRecord 的内部实现（不含锁和超时，由外层 processRecord 包裹）
 */
async function processRecordInner(record: PublishRecord, recordId: number, platform: string, articleTitle: string): Promise<void> {
  let context: BrowserContext | null = null;

  try {
    // ---- 前置校验 ----
    if (!record.step_list) {
      throw new Error(`平台 ${platform} 无 step_list 配置`);
    }
    if (record.step_list.is_placeholder) {
      logger.warn(`平台 ${platform} 的 step_list 为模板（is_placeholder=true），将尝试执行但可能失败`);
    }
    if (!record.step_list.steps || record.step_list.steps.length === 0) {
      throw new Error(`平台 ${platform} 的 step_list 无有效步骤`);
    }
    if (!record.account_storage_state) {
      throw new Error(`账号 ${record.account_name || record.platform_auth_id} 无 storage_state，请先登录`);
    }

    // ---- v2.1.0：发布前 5-15s 随机延迟（反检测，对齐桌面端） ----
    const delayMs = PUBLISH_DELAY_MIN_MS + Math.floor(Math.random() * (PUBLISH_DELAY_MAX_MS - PUBLISH_DELAY_MIN_MS));
    logger.info(`发布前随机延迟 ${Math.round(delayMs / 1000)}s（反检测）`);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // ---- 1. 启动 Playwright ----
    const useHeadless = shouldUseHeadless();
    const launchArgs = getAntiDetectionArgs();
    if (useHeadless) {
      launchArgs.push('--headless=new');
    }

    const fingerprint = getStableFingerprint(record.platform || record.platform_auth_id || recordId);
    logger.info(`启动浏览器（launch + newContext + stealth + ${launchArgs.length} 个反检测参数 + headless: ${useHeadless ? 'new' : 'false'}）`);

    // 代理配置
    const proxyConfig = record.account_proxy ? {
      server: record.account_proxy.endpoint,
      username: record.account_proxy.username || undefined,
      password: record.account_proxy.password || undefined,
    } : undefined;

    if (proxyConfig) {
      logger.info(`使用代理: ${record.account_proxy.name} (${record.account_proxy.endpoint})`);
    }

    // storageState 预处理
    const storageStateRaw = parseStorageState(record.account_storage_state);
    const normalizedStorageState = normalizeToPlaywrightStorageState(storageStateRaw);
    const lsCount = normalizedStorageState?.origins?.reduce((sum: number, o: any) => sum + (o.localStorage?.length || 0), 0) || 0;
    logger.info(`注入 storage_state（cookies=${normalizedStorageState?.cookies?.length || 0}条, origins=${normalizedStorageState?.origins?.length || 0}个, localStorage=${lsCount}条）`);

    // 构建 context 选项
    const contextOptions: any = {
      ...fingerprintToContextOptions(fingerprint),
      permissions: ['clipboard-read', 'clipboard-write'],
    };

    // 使用原生 storageState 注入（首个请求即带登录态 cookie）
    if (normalizedStorageState) {
      contextOptions.storageState = normalizedStorageState;
    }

    // 注入代理
    if (proxyConfig) {
      contextOptions.proxy = proxyConfig;
    }

    const browser = await chromium.launch({
      headless: useHeadless,
      args: launchArgs,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });

    context = await browser.newContext(contextOptions);

    // 注入 stealth.min.js
    await context.addInitScript(getStealthScript());

    // v2.1.0：注入 WebGL/Canvas 噪声指纹脚本（对齐桌面端，之前缺失）
    await context.addInitScript(getFingerprintInjectionScript(fingerprint));
    logger.info(`已注入 WebGL/Canvas 噪声指纹脚本（vendor=${fingerprint.webglVendor.slice(0, 20)}...）`);

    const page = await context.newPage();

    // 兜底：若原生 storageState 注入失败，用补丁式注入
    if (!normalizedStorageState) {
      const injected = await injectStorageState(context, page, storageStateRaw);
      if (!injected) {
        logger.warn(`storage_state 注入失败，所有策略均失败`);
      }
    }

    // ---- 2. 登录预检（v2.5.0：走平台适配器，支持 wxgzh #jumpUrl 等特殊处理） ----
    const adapter = isPlatformSupported(platform) ? getPlatformAdapter(platform) : null;
    const loginCheckConfig: PlatformLoginCheck = adapter
      ? {
          login_check_url: adapter.loginCheck.url,
          login_check_selector: adapter.loginCheck.selector,
          logout_keywords: adapter.loginCheck.logoutKeywords,
          login_check_url_pattern: adapter.loginCheck.urlPattern,
        }
      : {
          login_check_url: record.step_list.login_check_url,
          login_check_selector: record.step_list.login_check_selector,
          logout_keywords: record.step_list.logout_keywords,
          login_check_url_pattern: record.step_list.login_check_url_pattern,
        };

    if (loginCheckConfig.login_check_url) {
      logger.info(`登录预检: 导航到 ${loginCheckConfig.login_check_url}`);
      await page.goto(loginCheckConfig.login_check_url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
        logger.warn(`预检导航失败: ${e.message}`);
      });

      // v2.5.0：调用适配器的 onAfterNavigateForLoginCheck（wxgzh 会自动点 #jumpUrl）
      if (adapter) {
        const pushLog = (msg: string, level?: 'info' | 'warn' | 'error') => {
          if (level === 'error') logger.error(msg);
          else if (level === 'warn') logger.warn(msg);
          else logger.info(msg);
        };
        await adapter.onAfterNavigateForLoginCheck?.(page, context, { recordId, pushLog });
      } else {
        await page.waitForTimeout(5000);
      }

      // 诊断信息（保留原有逻辑）
      try {
        const diagUrl = page.url();
        const diagCookies = await context.cookies();
        const diagTitle = await page.title().catch(() => '(无标题)');
        const diagBody = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300)).catch(() => '(无法读取)');
        const stealthCheck = await page.evaluate(() => JSON.stringify({
          webdriver: navigator.webdriver,
          hasChrome: !!(window as any).chrome,
          plugins: navigator.plugins.length,
        })).catch(() => '(无法读取)');
        logger.info(`预检诊断: stealth=${stealthCheck}`);
        logger.info(`预检诊断: URL=${diagUrl}, cookies=${diagCookies.length}条, title="${diagTitle}"`);
        logger.info(`预检诊断: body="${diagBody.replace(/\n/g, ' ').slice(0, 200)}"`);
      } catch (e: any) {
        logger.warn(`预检诊断失败: ${e.message}`);
      }

      const loginCheck = await checkLoginState(page, platform, loginCheckConfig);
      if (!loginCheck.valid) {
        // v2.5.0：先尝试适配器的 recoverLogin（如 wxgzh 点 #jumpUrl），失败再报 login_expired
        let recovered = false;
        if (adapter?.recoverLogin) {
          const pushLog = (msg: string, level?: 'info' | 'warn' | 'error') => {
            if (level === 'error') logger.error(msg);
            else if (level === 'warn') logger.warn(msg);
            else logger.info(msg);
          };
          logger.info(`登录态失效，尝试适配器 recoverLogin...`);
          recovered = await adapter.recoverLogin(page, context, { recordId, pushLog }).catch(() => false);
        }
        if (!recovered) {
          logger.error(`登录态失效: ${loginCheck.reason}（云端不支持交互式登录恢复，请重新登录账号）`);
          void reportFlywheelEvent('login_expired', `[${platform}] 账号登录态失效：${loginCheck.reason}（请在桌面端重新登录）`, { record_id: recordId, platform, account_name: record.account_name }).catch(() => {});
          await reportPublishResult(recordId, {
            status: 'login_expired',
            error_msg: `登录态失效: ${loginCheck.reason}（云端发布 Worker 不支持自动登录恢复，请在桌面端重新登录该账号）`,
          });
          return;
        }
        logger.info(`适配器 recoverLogin 成功，继续发布`);
      } else {
        logger.info(`登录态有效`);
      }

      // 封禁信号检测（保留原有逻辑）
      const banCheck = await detectBanSignal(page, platform);
      if (banCheck.banned) {
        logger.error(`检测到封禁信号: ${banCheck.reason}`);
        void reportFlywheelEvent('banned', `[${platform}] 检测到封禁信号：${banCheck.reason}（账号 ${record.account_name}）`, { record_id: recordId, platform, account_name: record.account_name }).catch(() => {});
        await reportPublishResult(recordId, {
          status: 'banned',
          error_msg: banCheck.reason,
        });
        return;
      }
    }

    // ---- 3. 执行 step_list ----
    const ctx: StepExecutionContext = {
      page,
      platform,
      article: {
        title: record.article.title || '',
        content_html: record.article.content_html || '',
        tags: Array.isArray(record.article.tags) ? record.article.tags : [],
        cover_image_url: record.article.cover_image_url,
      },
      scheduledAt: record.scheduled_at ? new Date(record.scheduled_at) : undefined,
      onLog: (msg, level) => logger.info(msg),
    };

    logger.info(`开始执行 step_list（${record.step_list.steps.length} 步）`);
    await executeSteps(record.step_list.steps as Step[], ctx);

    // ---- 4. 截图存证（v2.5.0：上传 OSS） ----
    const screenshotBuffer = await takeScreenshot(page, recordId);
    let screenshotPath: string | undefined;
    if (screenshotBuffer) {
      try {
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        formData.append('screenshot', screenshotBuffer, { filename: `record-${recordId}.png`, contentType: 'image/png' });
        const resp = await axios.post(
          `${SERVER_URL}/content/publish/records/${recordId}/screenshot`,
          formData,
          {
            headers: { 'X-Worker-Secret': WORKER_SECRET, ...formData.getHeaders() },
            timeout: 30000,
          }
        );
        screenshotPath = resp.data?.data?.url;
      } catch (e: any) {
        logger.warn(`截图上传 server 失败: ${e.message}`);
      }
    }

    // ---- 5. 获取发布后文章 URL ----
    const platformUrl = extractPlatformUrl(ctx.lastEvalResult);

    // ---- 6. 再次检测封禁信号（发布后） ----
    const postBanCheck = await detectBanSignal(page, platform).catch(() => ({ banned: false, reason: undefined } as { banned: boolean; reason?: string }));
    if (postBanCheck.banned) {
      logger.error(`发布后检测到封禁: ${postBanCheck.reason}`);
      void reportFlywheelEvent('banned', `[${platform}] 发布后检测到封禁：${postBanCheck.reason}（账号 ${record.account_name}）`, { record_id: recordId, platform, account_name: record.account_name }).catch(() => {});
      await reportPublishResult(recordId, {
        status: 'banned',
        error_msg: postBanCheck.reason,
        screenshot_path: screenshotPath,
      });
      return;
    }

    // ---- 7. 回写成功 ----
    await reportPublishResult(recordId, {
      status: 'success',
      platform_url: platformUrl,
      screenshot_path: screenshotPath,
    });
    logger.info(`发布成功${platformUrl ? ' → ' + platformUrl : ''}`);
    void reportFlywheelEvent('publish_success', `[${platform}] 发布成功 "${articleTitle}"${platformUrl ? ' → ' + platformUrl : ''}`, { record_id: recordId, platform, platform_url: platformUrl, task_id: record.task_id }).catch(() => {});

    // ---- 8. 抓取最新 storage_state 回传（保持账号新鲜） ----
    try {
      const latestState = await captureStorageState(context);
      if (latestState) {
        await reportAccountStorageStateUpdate(record.platform_auth_id, latestState);
      }
    } catch {
      // 不阻断流程
    }

  } catch (err: any) {
    let errorMsg = err.message || String(err);
    logger.error(`发布失败: ${errorMsg}`);

    if (record.step_list?.is_placeholder) {
      errorMsg = `[模板需调整] ${errorMsg}。该平台 step_list 为模板，请基于失败截图调整选择器后重试。`;
    }

    const result = classifyError(errorMsg);
    void reportFlywheelEvent('publish_failed', `[${platform}] 发布失败 "${articleTitle}": ${errorMsg}（类型: ${result.error_type}）`, { record_id: recordId, platform, error_type: result.error_type, error_msg: errorMsg }, record.user_id).catch(() => {});
    await reportPublishResult(recordId, {
      status: result.status,
      error_type: result.error_type,
      error_msg: errorMsg,
    }).catch(() => {});
  } finally {
    if (context) {
      try {
        const browser = context.browser();
        for (const p of context.pages()) {
          await p.close().catch(() => {});
        }
        await context.close().catch(() => {});
        if (browser) {
          await browser.close().catch(() => {});
        }
      } catch {}
    }
    logger.setRecordId(undefined);
  }
}

// ============ 辅助函数 ============

function parseStorageState(raw: any): any {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function extractPlatformUrl(evalResult: any): string | undefined {
  if (!evalResult) return undefined;
  if (typeof evalResult === 'string') {
    if (evalResult.startsWith('http')) return evalResult;
    return undefined;
  }
  if (typeof evalResult === 'object' && evalResult.url) {
    return String(evalResult.url);
  }
  return undefined;
}

function classifyError(errorMsg: string): { status: PublishResult['status']; error_type: string } {
  const lower = errorMsg.toLowerCase();

  if (
    errorMsg.includes('登录') || errorMsg.includes('未登录') ||
    lower.includes('login') || lower.includes('sign in') ||
    errorMsg.includes('登录态失效')
  ) {
    return { status: 'login_expired', error_type: 'account_login_expired' };
  }

  if (
    errorMsg.includes('封禁') || errorMsg.includes('封号') ||
    lower.includes('banned') || lower.includes('blocked') ||
    errorMsg.includes('账号异常') || errorMsg.includes('账号已被限制')
  ) {
    return { status: 'banned', error_type: 'account_banned' };
  }

  if (
    errorMsg.includes('上限') || errorMsg.includes('限额') ||
    errorMsg.includes('限流') || errorMsg.includes('配额') ||
    errorMsg.includes('太频繁') || errorMsg.includes('过于频繁') ||
    lower.includes('limit') || lower.includes('quota') ||
    lower.includes('too many requests') || lower.includes('rate limited')
  ) {
    return { status: 'failed', error_type: 'account_limited' };
  }

  if (
    errorMsg.includes('标题') || errorMsg.includes('正文') ||
    errorMsg.includes('图片') || errorMsg.includes('封面') ||
    errorMsg.includes('违规') || errorMsg.includes('敏感') ||
    errorMsg.includes('审核') || errorMsg.includes('不通过') ||
    lower.includes('content') || lower.includes('violate') ||
    lower.includes('invalid') || lower.includes('forbidden')
  ) {
    return { status: 'failed', error_type: 'content_error' };
  }

  if (
    errorMsg.includes('平台') || errorMsg.includes('服务器') ||
    errorMsg.includes('服务繁忙') || errorMsg.includes('系统繁忙') ||
    lower.includes('server') || lower.includes('platform') ||
    lower.includes('503') || lower.includes('502') ||
    lower.includes('bad gateway') || lower.includes('service unavailable')
  ) {
    return { status: 'failed', error_type: 'platform_error' };
  }

  return { status: 'failed', error_type: 'unknown' };
}

/**
 * 截图并返回 buffer（v2.5.0：不再写本地文件，直接返回 buffer 供 OSS 上传）
 */
async function takeScreenshot(page: any, recordId: number): Promise<Buffer | undefined> {
  try {
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return buffer as Buffer;
  } catch (e: any) {
    logger.warn(`截图失败: ${e.message}`);
    return undefined;
  }
}

/**
 * 回写发布结果到云端（v2.1.0：3 次重试 + 指数退避，防回写丢失）
 */
async function reportPublishResult(recordId: number, result: PublishResult): Promise<void> {
  for (let attempt = 1; attempt <= REPORT_RETRY_MAX; attempt++) {
    try {
      await axios.post(
        `${SERVER_URL}/content/publish/records/${recordId}/result`,
        result,
        {
          headers: { 'X-Worker-Secret': WORKER_SECRET },
          timeout: 10000,
        }
      );
      logger.info(`已回写: ${result.status}${attempt > 1 ? `（第${attempt}次成功）` : ''}`);
      return;
    } catch (e: any) {
      if (attempt < REPORT_RETRY_MAX) {
        const backoff = REPORT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(`回写失败(第${attempt}次): ${e.message}，${backoff}ms 后重试`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      } else {
        logger.error(`回写失败(已重试${REPORT_RETRY_MAX}次): ${e.message}，放弃回写`);
        throw e;
      }
    }
  }
}

/**
 * v2.1.0：推送事件到云端 flywheel_event_log 表
 * 让桌面端"自动发布"Tab 的"云端发布日志"能看到云端 worker 的执行过程
 *
 * 事件类型：publish_started / publish_success / publish_failed / login_expired / banned
 * 复用 v2.0.9 新建的 flywheel_event_log 表和 POST /content/flywheel/event-logs 路由
 *
 * v2.5.33 修复：新增 userId 参数，显式传 user_id 给后端
 *   原 bug：worker 鉴权后 req.user.id=0（硬编码），不传 user_id 时后端写入 user_id=0，
 *          前端按客户 ID 过滤查不到日志，窗口空空如也
 */
async function reportFlywheelEvent(
  eventType: string,
  message: string,
  data?: any,
  userId?: number
): Promise<void> {
  await axios.post(
    `${SERVER_URL}/content/flywheel/event-logs`,
    {
      event_type: eventType,
      message,
      data,
      // v2.5.33：显式传 user_id，让事件归属于正确的客户
      user_id: userId && userId > 0 ? userId : undefined,
    },
    {
      headers: { 'X-Worker-Secret': WORKER_SECRET },
      timeout: 5000,
    }
  );
}

/**
 * 回传账号最新 storage_state
 */
async function reportAccountStorageStateUpdate(accountId: number, storageState: any): Promise<void> {
  try {
    await axios.put(
      `${SERVER_URL}/content/publish-accounts/${accountId}`,
      { storage_state: storageState },
      {
        headers: { 'X-Worker-Secret': WORKER_SECRET },
        timeout: 10000,
      }
    );
    logger.info(`账号 ${accountId} storage_state 已更新`);
  } catch (e: any) {
    logger.warn(`账号 ${accountId} storage_state 更新失败: ${e.message}`);
  }
}
