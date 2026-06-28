import { chromium, Browser } from 'playwright';
import { DeepSeekAdapter } from './platforms/deepseek';
import { KimiAdapter } from './platforms/kimi';
import { DoubaoAdapter } from './platforms/doubao';
import { QianwenAdapter } from './platforms/qianwen';
import { YuanbaoAdapter } from './platforms/yuanbao';
import { WenxinAdapter } from './platforms/wenxin';
import { NanoAdapter } from './platforms/nano';
import { ZhipuAdapter } from './platforms/zhipu';
import { PlatformAdapter } from './platforms/base';
import { reportResult } from './resultReporter';
import * as logger from './logger';
import axios from 'axios';
// 隐身浏览器组件（v1.3+）
import { getAntiDetectionArgs, shouldUseHeadless, getStealthScript, hasStealthScript, getAppLayerInjectionScript } from './stealthLoader';
import { getRandomFingerprint, getStableFingerprint, fingerprintToContextOptions, getFingerprintInjectionScript } from './fingerprintManager';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

/** 并发硬上限（与 docker-compose mem_limit 配套，2g 内存下安全值） */
const MAX_CONCURRENCY_HARD_LIMIT = 4;

/** 故障熔断：连续失败计数 */
const platformFailureStats: Record<string, { consecutiveFailures: number; lastFailureTime: number }> = {};
const CIRCUIT_BREAKER_THRESHOLD = 5; // 连续失败 5 次触发熔断
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 熔断后冷却 5 分钟

const platformAdapters: Record<string, PlatformAdapter> = {
  'DeepSeek': new DeepSeekAdapter(),
  'Kimi': new KimiAdapter(),
  '豆包': new DoubaoAdapter(),
  '通义千问': new QianwenAdapter(),
  '腾讯元宝': new YuanbaoAdapter(),
  '文心一言': new WenxinAdapter(),
  '纳米': new NanoAdapter(),
  '智谱AI': new ZhipuAdapter(),
};

export interface ExecuteTaskParams {
  taskId: number;
  queueId: number;
  userId: string;
  keywordType: number;
  keywords: string[];
  platforms: string[];
  concurrency?: number;
  workerId: string;
  lastKeywordIndex?: number; // 断点续查：从此索引之后开始处理（-1 表示从头开始）
}

export interface ExecuteTaskResult {
  totalRecords: number;
  brandMatched: number;
  aborted: boolean;
}

/** 检查任务是否被请求中断 */
async function checkAbortRequested(queueId: number): Promise<boolean> {
  try {
    const resp = await axios.get(`${SERVER_URL}/real-collect/queue/check-abort/${queueId}`, { timeout: 5000 });
    return resp.data?.code === 200 && resp.data?.data?.aborted === true;
  } catch {
    return false;
  }
}

/** 更新分片处理进度（记录已处理到的关键词索引，重启后从断点续查） */
async function updateProgress(queueId: number, lastKeywordIndex: number): Promise<void> {
  try {
    await axios.post(`${SERVER_URL}/real-collect/queue/progress`, { queueId, lastKeywordIndex }, { timeout: 5000 });
  } catch {
    // 进度更新失败不影响主流程
  }
}

/** 从云端账号池借用账号 */
async function acquireAccount(platform: string): Promise<{
  authId: number;
  storageState: string;
  proxy?: { endpoint: string; username?: string; password?: string } | null;
} | null> {
  try {
    const resp = await axios.post(`${SERVER_URL}/platform-auth/acquire`, { platform }, { timeout: 10000 });
    if (resp.data?.code === 200 && resp.data?.data) {
      return {
        authId: resp.data.data.id,
        storageState: resp.data.data.storageState,
        // 代理信息（v1.3+：账号绑定的代理，由云端从 proxy_pool 解密返回）
        proxy: resp.data.data.proxy || null,
      };
    }
    return null;
  } catch (e: any) {
    logger.error(`借用账号失败 ${platform}: ${e.message}`);
    return null;
  }
}

/** 归还账号到云端账号池
 * detail 传入具体的风控关键词或错误信息，云端据此判断是否标记 banned/offline
 */
async function releaseAccount(
  authId: number,
  result: 'success' | 'failed' | 'rate_limited',
  detail?: string
): Promise<void> {
  try {
    await axios.post(`${SERVER_URL}/platform-auth/release`, { authId, result, detail }, { timeout: 10000 });
  } catch (e: any) {
    logger.error(`归还账号失败 authId=${authId}: ${e.message}`);
  }
}

/** 检查平台是否处于熔断状态 */
function isPlatformInCircuitBreaker(platform: string): boolean {
  const stats = platformFailureStats[platform];
  if (!stats) return false;
  if (stats.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
  const elapsed = Date.now() - stats.lastFailureTime;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    // 冷却期过，重置计数，允许重试
    stats.consecutiveFailures = 0;
    return false;
  }
  return true;
}

/** 记录平台成功/失败，用于熔断判断 */
function recordPlatformResult(platform: string, success: boolean): void {
  if (!platformFailureStats[platform]) {
    platformFailureStats[platform] = { consecutiveFailures: 0, lastFailureTime: 0 };
  }
  const stats = platformFailureStats[platform];
  if (success) {
    stats.consecutiveFailures = 0;
  } else {
    stats.consecutiveFailures++;
    stats.lastFailureTime = Date.now();
    if (stats.consecutiveFailures === CIRCUIT_BREAKER_THRESHOLD) {
      logger.warn(`[熔断器] 平台 ${platform} 连续失败 ${CIRCUIT_BREAKER_THRESHOLD} 次，触发熔断，冷却 ${CIRCUIT_BREAKER_COOLDOWN_MS / 60000} 分钟`);
    }
  }
}

/** 将数组按 size 分块 */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * 启动 Chromium（v1.3+ 隐身版）
 *
 * 关键改进（DeepSeek 被封的根因修复）：
 * 1. 使用 30+ 反检测 args（含 --disable-blink-features=AutomationControlled）
 * 2. stealth.min.js + appLayerInjectionScript 覆盖 navigator.webdriver=false
 * 3. 指纹伪造脚本覆盖 WebGL/Canvas/Platform
 *
 * 关于 headless 模式：
 *  - Playwright 文档显示 headless: 'new' 在某些版本/Docker 环境下报错"expected boolean"
 *  - Docker 镜像用 apk add chromium 装的系统 Chromium 可能不支持新 headless
 *  - 改回 headless: true（旧模式），但通过 stealth.min.js + 反检测 args 补偿
 *  - stealth.min.js 已覆盖 HeadlessChrome UA、navigator.webdriver=true 等旧 headless 特征
 */
function getChromiumLaunchArgs() {
  const useHeadless = shouldUseHeadless();
  return {
    // 旧 headless 模式（兼容所有 Playwright 版本和 Docker 系统 Chromium）
    // 隐身由 stealth.min.js + 反检测 args + 指纹伪造脚本保证
    headless: useHeadless ? true : false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: getAntiDetectionArgs(),
  };
}

/**
 * 为 BrowserContext 注入所有隐身措施（v1.3+）
 *
 * 调用时机：browser.newContext() 之后、page.goto() 之前
 * 注入内容：
 *  1. stealth.min.js（来自 berstend/puppeteer-extra，覆盖 webdriver/plugins/chrome.runtime 等）
 *  2. appLayerInjectionScript（navigator.webdriver=false 等）
 *  3. fingerprintInjectionScript（WebGL/Canvas/Platform 伪造）
 *
 * @param context Playwright BrowserContext
 * @param fingerprint 本次会话使用的指纹（决定 WebGL/Canvas 伪造值）
 */
async function injectStealthScripts(context: any, fingerprint: ReturnType<typeof getRandomFingerprint>): Promise<void> {
  // 1. stealth.min.js（每个新 page 都会自动注入）
  if (hasStealthScript()) {
    try {
      const stealthScript = getStealthScript();
      await context.addInitScript(stealthScript);
      logger.info('[隐身] stealth.min.js 已注入');
    } catch (e: any) {
      logger.warn(`[隐身] stealth.min.js 注入失败: ${e.message}`);
    }
  } else {
    logger.warn('[隐身] stealth.min.js 未找到，仅用 appLayerInjectionScript 兜底');
  }

  // 2. 应用层注入脚本（navigator.webdriver=false 等）
  try {
    await context.addInitScript(getAppLayerInjectionScript());
  } catch (e: any) {
    logger.warn(`[隐身] appLayerInjectionScript 注入失败: ${e.message}`);
  }

  // 3. 指纹伪造脚本（WebGL/Canvas/Platform）
  try {
    await context.addInitScript(getFingerprintInjectionScript(fingerprint));
  } catch (e: any) {
    logger.warn(`[隐身] 指纹伪造脚本注入失败: ${e.message}`);
  }
}

/** 执行单次查询（一个关键词在一个平台上） */
async function executeSingleQuery(
  browser: Browser,
  taskId: number,
  userId: string,
  keywordType: number,
  keyword: string,
  platform: string,
  adapter: PlatformAdapter,
  workerId: string
): Promise<{ success: boolean; brandMatched: boolean }> {
  // 熔断检查：连续失败的平台跳过
  if (isPlatformInCircuitBreaker(platform)) {
    logger.warn(`[熔断] 平台 ${platform} 处于熔断状态，跳过: ${keyword.substring(0, 20)}`);
    return { success: false, brandMatched: false };
  }

  // 从账号池借用账号
  const account = await acquireAccount(platform);
  if (!account) {
    logger.warn(`无可用账号: ${platform}/${keyword.substring(0, 20)}`);
    recordPlatformResult(platform, false);
    return { success: false, brandMatched: false };
  }

  let context: any = null;
  let page: any = null;
  try {
    // 用 storageState 创建 context（自动登录态）
    let storageState: any;
    try {
      storageState = JSON.parse(account.storageState);
    } catch {
      storageState = undefined;
    }

    // 隐私模式：每次 newContext 用全新随机指纹（不复用账号指纹，降低被关联风险）
    const fingerprint = getRandomFingerprint();
    const contextOptions: any = {
      storageState,
      ...fingerprintToContextOptions(fingerprint),
    };

    // 代理注入（v1.3+：账号绑定的代理）
    if (account.proxy?.endpoint) {
      contextOptions.proxy = {
        server: account.proxy.endpoint,
        username: account.proxy.username || undefined,
        password: account.proxy.password || undefined,
      };
      logger.info(`[隐身] 账号 ${account.authId} 使用代理: ${account.proxy.endpoint}`);
    }

    context = await browser.newContext(contextOptions);

    // 注入所有隐身脚本（stealth.min.js + appLayerInjectionScript + 指纹伪造）
    await injectStealthScripts(context, fingerprint);

    page = await context.newPage();

    // 执行查询（query 方法内部已包含登录态检测，无需重复调用 checkLoginStatus）
    logger.info(`查询: ${platform}/${keyword.substring(0, 30)}`);
    const result = await adapter.query(page, keyword);

    // 品牌词包含检查由云端 resultProcessor 完成，worker 端只统计记录数
    const brandMatched = false;

    // 回写结果（上报失败不影响账号归还状态）
    try {
      await reportResult({
        taskId,
        userId,
        keyword,
        keywordType,
        platform,
        content: result.content,
        htmlContent: result.htmlContent,
        shareUrl: result.shareUrl,
        supportsShare: result.supportsShare,
        workerId,
      });
    } catch (reportErr: any) {
      logger.error(`结果上报失败 ${platform}/${keyword.substring(0, 30)}: ${reportErr.message}`);
      // 上报失败仍视为查询成功，账号归还 success
    }

    await releaseAccount(account.authId, 'success');
    recordPlatformResult(platform, true);
    return { success: true, brandMatched };
  } catch (e: any) {
    // 判断是否风控（多维度检测）
    const errMsg = String(e?.message || '');

    // 登录态失效单独处理：必须走 failed 路径，让云端标记 offline
    // 不能放入 isRateLimited，否则会走 rate_limited 路径而不标记 offline
    const isLoginExpired = errMsg.includes('登录态失效') ||
      errMsg.includes('登录失效') ||
      errMsg.includes('请重新登录') ||
      errMsg.includes('登录已失效');

    const isRateLimited = !isLoginExpired && (
      errMsg.includes('429') ||
      errMsg.includes('频率') ||
      errMsg.includes('rate') ||
      errMsg.includes('Too Many Requests') ||
      errMsg.includes('rate_limited') ||
      errMsg.includes('风控') ||
      errMsg.includes('验证码') ||
      errMsg.includes('captcha') ||
      errMsg.includes('安全验证') ||
      errMsg.includes('unauthorized') ||
      errMsg.includes('forbidden') ||
      errMsg.includes('访问过于频繁') ||
      errMsg.includes('请稍后再试')
    );

    // 如果有 page 对象，检测页面内容是否包含风控提示
    let pageRiskDetected = false;
    let detectedKeyword = '';
    try {
      if (page && !page.isClosed()) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '').catch(() => '');
        const riskKeywords = [
          '验证码', '安全验证', '请完成验证', '人机验证',
          '访问过于频繁', '请稍后再试', '操作太频繁',
          '账号已被限制', '账号异常', '登录已失效',
          '请重新登录', 'unusual traffic', '机器人',
        ];
        for (const kw of riskKeywords) {
          if (bodyText.includes(kw)) {
            pageRiskDetected = true;
            detectedKeyword = kw;
            logger.warn(`检测到风控提示 "${kw}": ${platform}/${keyword.substring(0, 30)}`);
            break;
          }
        }
      }
    } catch {}

    // 登录态失效 → failed + detail='登录态失效'，云端会标记 offline
    // 风控/封禁 → rate_limited + detail=风控关键词，云端会判断是否 banned
    // 其他失败 → failed + detail=错误消息，不改状态
    const finalResult = isLoginExpired ? 'failed' : (isRateLimited || pageRiskDetected ? 'rate_limited' : 'failed');
    const detail = isLoginExpired ? '登录态失效' : (detectedKeyword || (isRateLimited ? errMsg.substring(0, 200) : errMsg.substring(0, 200)));
    await releaseAccount(account.authId, finalResult, detail);
    recordPlatformResult(platform, false);
    logger.error(`查询失败: ${platform}/${keyword.substring(0, 30)} - ${e.message}${pageRiskDetected ? ' [检测到页面风控提示]' : ''}${isLoginExpired ? ' [登录态失效]' : ''}`);
    return { success: false, brandMatched: false };
  } finally {
    // 显式关闭 page 再关闭 context，避免 page 泄漏
    if (page) {
      try { await page.close(); } catch {}
    }
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

export async function executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
  const { taskId, queueId, userId, keywordType, keywords, platforms, concurrency, workerId, lastKeywordIndex } = params;
  // 并发数钳制：不超过硬上限
  const maxConcurrency = Math.min(concurrency || MAX_CONCURRENCY_HARD_LIMIT, MAX_CONCURRENCY_HARD_LIMIT);

  // 断点续查：从上次中断的位置继续处理
  // lastKeywordIndex = -1 表示从头开始，= 5 表示前5个关键词已处理，从第6个开始
  const startIndex = (lastKeywordIndex ?? -1) + 1;
  const remainingKeywords = keywords.length - startIndex;

  if (startIndex > 0) {
    logger.info(`任务 ${taskId} 断点续查: 从第 ${startIndex + 1}/${keywords.length} 个关键词开始（跳过已处理的 ${startIndex} 个）`);
  }

  if (remainingKeywords <= 0) {
    logger.info(`任务 ${taskId} 所有关键词已处理完毕，无需重复执行`);
    return { totalRecords: 0, brandMatched: 0, aborted: false };
  }

  logger.info(`开始执行任务 ${taskId}: 剩余${remainingKeywords}/${keywords.length}个关键词 × ${platforms.length}个平台 = ${remainingKeywords * platforms.length}次查询, 并发=${maxConcurrency}`);

  let totalRecords = 0;
  let brandMatched = 0;
  let aborted = false;

  // 启动一个共享 browser
  let browser = await chromium.launch(getChromiumLaunchArgs());

  // 每 N 个批次重启 browser，防止内存泄漏导致 Page crashed
  const BROWSER_RESTART_INTERVAL = 15;
  let batchSinceRestart = 0;

  try {
    // 按关键词分组执行：每个关键词的所有平台并发查询
    // 从断点位置开始遍历，跳过已处理的关键词
    for (let kwOffset = 0; kwOffset < remainingKeywords; kwOffset++) {
      const kwIdx = startIndex + kwOffset;
      const keyword = keywords[kwIdx];
      logger.info(`任务 ${taskId} 关键词 ${kwIdx + 1}/${keywords.length}: ${keyword.substring(0, 30)}`);

      // 检查中断请求
      if (kwOffset > 0) {
        const isAborted = await checkAbortRequested(queueId);
        if (isAborted) {
          logger.warn(`任务 ${taskId} 被请求中断，停止执行（已完成 ${kwIdx}/${keywords.length} 个关键词）`);
          aborted = true;
          break;
        }
      }

      // 定期重启 browser 防止内存泄漏
      if (batchSinceRestart >= BROWSER_RESTART_INTERVAL) {
        logger.info(`定期重启 browser 防止内存泄漏 (已处理到 ${kwIdx + 1}/${keywords.length} 个关键词)`);
        try { await browser.close(); } catch {}
        browser = await chromium.launch(getChromiumLaunchArgs());
        batchSinceRestart = 0;
      }

      // 构建本关键词的所有平台查询任务
      const platformQueries: { platform: string; adapter: PlatformAdapter }[] = [];
      for (const platform of platforms) {
        if (platformAdapters[platform]) {
          platformQueries.push({ platform, adapter: platformAdapters[platform] });
        } else {
          logger.warn(`平台 ${platform} 无适配器，跳过`);
        }
      }

      // 按并发数分批执行本关键词的平台查询
      const batches = chunk(platformQueries, maxConcurrency);
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.info(`  关键词 "${keyword.substring(0, 20)}" 平台批次 ${i + 1}/${batches.length}: ${batch.map(b => b.platform).join(', ')}`);

        const promises = batch.map(({ platform, adapter }) => {
          return executeSingleQuery(browser, taskId, userId, keywordType, keyword, platform, adapter, workerId);
        });

        const results = await Promise.allSettled(promises);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.success) {
            totalRecords++;
            if (r.value.brandMatched) brandMatched++;
          } else if (r.status === 'rejected') {
            logger.error(`关键词 "${keyword.substring(0, 20)}" 批次 ${i + 1} 中有 promise rejected: ${r.reason?.message || r.reason}`);
          }
        }

        batchSinceRestart++;

        // 批次间随机延迟（反爬）
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1500));
        }
      }

      // 每个关键词处理完毕后，更新进度（断点续查依据）
      await updateProgress(queueId, kwIdx);

      // 关键词间延迟（反爬）
      if (kwOffset < remainingKeywords - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  if (aborted) {
    logger.info(`任务 ${taskId} 已中断: 已完成 ${totalRecords}条记录`);
  } else {
    logger.info(`任务 ${taskId} 完成: ${totalRecords}条记录, 品牌命中${brandMatched}条`);
  }
  return { totalRecords, brandMatched, aborted };
}
