import { chromium, Browser } from 'playwright';
import { DeepSeekAdapter } from './platforms/deepseek';
import { KimiAdapter } from './platforms/kimi';
import { DoubaoAdapter } from './platforms/doubao';
import { QianwenAdapter } from './platforms/qianwen';
import { YuanbaoAdapter } from './platforms/yuanbao';
import { WenxinAdapter } from './platforms/wenxin';
import { NanoAdapter } from './platforms/nano';
import { ZhipuAdapter } from './platforms/zhipu';
import { PlatformAdapter, getRandomUA } from './platforms/base';
import { reportResult } from './resultReporter';
import * as logger from './logger';
import axios from 'axios';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

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

/** 从云端账号池借用账号 */
async function acquireAccount(platform: string): Promise<{ authId: number; storageState: string } | null> {
  try {
    const resp = await axios.post(`${SERVER_URL}/platform-auth/acquire`, { platform }, { timeout: 10000 });
    if (resp.data?.code === 200 && resp.data?.data) {
      return {
        authId: resp.data.data.id,
        storageState: resp.data.data.storageState,
      };
    }
    return null;
  } catch (e: any) {
    logger.error(`借用账号失败 ${platform}: ${e.message}`);
    return null;
  }
}

/** 归还账号到云端账号池 */
async function releaseAccount(authId: number, result: 'success' | 'failed' | 'rate_limited'): Promise<void> {
  try {
    await axios.post(`${SERVER_URL}/platform-auth/release`, { authId, result }, { timeout: 10000 });
  } catch (e: any) {
    logger.error(`归还账号失败 authId=${authId}: ${e.message}`);
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
  // 从账号池借用账号
  const account = await acquireAccount(platform);
  if (!account) {
    logger.warn(`无可用账号: ${platform}/${keyword.substring(0, 20)}`);
    return { success: false, brandMatched: false };
  }

  let context: any = null;
  try {
    // 用 storageState 创建 context（自动登录态）
    let storageState: any;
    try {
      storageState = JSON.parse(account.storageState);
    } catch {
      storageState = undefined;
    }

    context = await browser.newContext({
      storageState,
      userAgent: getRandomUA(),
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // 检查登录态
    const isLoggedIn = await adapter.checkLoginStatus(page);
    if (!isLoggedIn) {
      logger.warn(`登录态失效: ${platform}/${keyword.substring(0, 20)}`);
      await releaseAccount(account.authId, 'failed');
      return { success: false, brandMatched: false };
    }

    // 执行查询
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
    return { success: true, brandMatched };
  } catch (e: any) {
    // 判断是否风控
    const errMsg = String(e?.message || '');
    const isRateLimited = errMsg.includes('429') ||
      errMsg.includes('频率') ||
      errMsg.includes('rate') ||
      errMsg.includes('Too Many Requests') ||
      errMsg.includes('rate_limited') ||
      errMsg.includes('风控');
    await releaseAccount(account.authId, isRateLimited ? 'rate_limited' : 'failed');
    logger.error(`查询失败: ${platform}/${keyword.substring(0, 30)} - ${e.message}`);
    return { success: false, brandMatched: false };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

export async function executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
  const { taskId, queueId, userId, keywordType, keywords, platforms, concurrency, workerId } = params;
  const maxConcurrency = concurrency || 8;

  logger.info(`开始执行任务 ${taskId}: ${keywords.length}个关键词 × ${platforms.length}个平台 = ${keywords.length * platforms.length}次查询, 并发=${maxConcurrency}`);

  let totalRecords = 0;
  let brandMatched = 0;
  let aborted = false;

  // 启动一个共享 browser
  let browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  // 每 N 个批次重启 browser，防止内存泄漏导致 Page crashed
  const BROWSER_RESTART_INTERVAL = 50;
  let batchSinceRestart = 0;

  try {
    // 构建所有查询任务（关键词 × 平台的笛卡尔积）
    const allQueries: { keyword: string; platform: string }[] = [];
    for (const keyword of keywords) {
      for (const platform of platforms) {
        if (platformAdapters[platform]) {
          allQueries.push({ keyword, platform });
        } else {
          logger.warn(`平台 ${platform} 无适配器，跳过`);
        }
      }
    }

    // 按并发数分批
    const batches = chunk(allQueries, maxConcurrency);
    logger.info(`共 ${allQueries.length} 次查询，分 ${batches.length} 批执行`);

    for (let i = 0; i < batches.length; i++) {
      // 检查中断请求
      if (i > 0 && i % 5 === 0) {
        const isAborted = await checkAbortRequested(queueId);
        if (isAborted) {
          logger.warn(`任务 ${taskId} 被请求中断，停止执行（已完成 ${i}/${batches.length} 批）`);
          aborted = true;
          break;
        }
      }

      // 定期重启 browser 防止内存泄漏
      if (batchSinceRestart >= BROWSER_RESTART_INTERVAL) {
        logger.info(`定期重启 browser 防止内存泄漏 (已完成 ${i}/${batches.length} 批)`);
        try { await browser.close(); } catch {}
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        batchSinceRestart = 0;
      }

      const batch = batches[i];
      logger.info(`任务 ${taskId} 批次 ${i + 1}/${batches.length} (${batch.length} 个并发查询)`);

      // 并发执行本批
      const promises = batch.map(({ keyword, platform }) => {
        const adapter = platformAdapters[platform];
        return executeSingleQuery(browser, taskId, userId, keywordType, keyword, platform, adapter, workerId);
      });

      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) {
          totalRecords++;
          if (r.value.brandMatched) brandMatched++;
        }
      }

      batchSinceRestart++;

      // 批次间随机延迟（反爬）
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1500));
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
