import dotenv from 'dotenv';
import axios from 'axios';
import { executeTask } from './taskFetcher';
import * as logger from './logger';
import { getCurrentConcurrency } from './dynamicConcurrency';
import { startRenewer, stopRenewer } from './renewer';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 2000;

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

// P3-5: SERVER_URL 缺 fail-fast 提示
if (!process.env.SERVER_URL) {
  console.error('[Worker] 警告: SERVER_URL 环境变量未设置，使用默认值 http://localhost:3002');
  console.error('[Worker] 生产环境请务必设置 SERVER_URL 指向云端服务地址');
}

logger.info(`自动收录查询Worker已启动`);
logger.info(`WORKER_ID=${WORKER_ID}`);
logger.info(`SERVER_URL=${SERVER_URL}`);
logger.info(`POLL_INTERVAL=${POLL_INTERVAL}ms`);

// 启动账号续期器
startRenewer();

let isProcessing = false;
let isShuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// 连续失败计数（用于退避）
let consecutiveFailures = 0;
const MAX_BACKOFF_INTERVAL = 30000; // 最大退避到30秒

async function pollAndExecute(): Promise<void> {
  if (isProcessing || isShuttingDown) {
    return;
  }

  isProcessing = true;
  try {
    const resp = await axios.post(`${SERVER_URL}/real-collect/queue/dequeue`, {
      workerId: WORKER_ID
    }, {
      timeout: 10000
    });

    // 成功连接，重置失败计数
    consecutiveFailures = 0;

    const task = resp.data?.data;
    if (!task) {
      return;
    }

    logger.setTaskId(task.taskId);
    logger.info(`消费到任务 queueId=${task.queueId} taskId=${task.taskId} userId=${task.userId} keywords=${task.keywords?.length} platforms=${task.platforms?.length}`);

    let recordCount = 0;
    let brandCount = 0;
    let errorMsg: string | undefined;

    try {
      // 获取动态并发数
      const concurrency = await getCurrentConcurrency();
      const result = await executeTask({
        taskId: task.taskId,
        userId: task.userId,
        keywordType: task.keywordType,
        keywords: task.keywords,
        platforms: task.platforms,
        concurrency,
        workerId: WORKER_ID,
      });
      recordCount = result.totalRecords;
      brandCount = result.brandMatched;
      logger.info(`任务执行完成 queueId=${task.queueId} records=${recordCount} brands=${brandCount}`);
    } catch (e: any) {
      errorMsg = e.message;
      logger.error(`任务执行失败 queueId=${task.queueId}: ${e.message}`);
    }

    // 回写队列结果
    try {
      await axios.post(`${SERVER_URL}/real-collect/queue/complete`, {
        queueId: task.queueId,
        taskId: task.taskId,
        recordCount,
        brandCount,
        error: errorMsg
      }, {
        timeout: 10000
      });
      logger.info(`队列结果回写成功 queueId=${task.queueId}`);
    } catch (e: any) {
      logger.error(`队列结果回写失败 queueId=${task.queueId}: ${e.message}`);
    }

    logger.setTaskId(undefined);
  } catch (e: any) {
    consecutiveFailures++;
    // 指数退避：失败次数越多，等待越久（最多30秒）
    const backoff = Math.min(POLL_INTERVAL * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_INTERVAL);
    logger.error(`轮询失败(第${consecutiveFailures}次): ${e.message}，${Math.round(backoff / 1000)}秒后重试`);
    // 延迟下一次轮询
    await new Promise(resolve => setTimeout(resolve, backoff));
  } finally {
    isProcessing = false;
  }
}

// 启动轮询
pollTimer = setInterval(() => {
  pollAndExecute().catch(e => {
    logger.error(`轮询异常: ${e.message}`);
  });
}, POLL_INTERVAL);

// 启动时立即执行一次
pollAndExecute().catch(e => {
  logger.error(`启动轮询异常: ${e.message}`);
});

// 优雅停机
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`收到${signal}信号，准备优雅退出`);

  // 停止续期器
  stopRenewer();

  // 清理轮询定时器
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // 等待当前任务完成（最多30秒）
  const startTime = Date.now();
  while (isProcessing && Date.now() - startTime < 30000) {
    logger.info('等待当前任务完成...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 刷新日志
  await logger.flushLogs();

  logger.info('退出完成');
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
