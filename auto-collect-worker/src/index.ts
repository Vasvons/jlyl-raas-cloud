import dotenv from 'dotenv';
import axios from 'axios';
import { executeTask } from './taskFetcher';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 2000; // 默认2秒轮询一次，保证手动立即执行的任务能快速被消费

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

console.log(`[Worker] 自动收录查询Worker已启动`);
console.log(`[Worker] WORKER_ID=${WORKER_ID}`);
console.log(`[Worker] SERVER_URL=${SERVER_URL}`);
console.log(`[Worker] POLL_INTERVAL=${POLL_INTERVAL}ms`);

let isProcessing = false;

async function pollAndExecute(): Promise<void> {
  if (isProcessing) {
    return; // 上一个任务还在执行，跳过本次轮询
  }

  isProcessing = true;
  try {
    // 从队列消费任务
    const resp = await axios.post(`${SERVER_URL}/real-collect/queue/dequeue`, {
      workerId: WORKER_ID
    }, {
      timeout: 10000
    });

    const task = resp.data?.data;
    if (!task) {
      return; // 队列为空
    }

    console.log(`[Worker] 消费到任务 queueId=${task.queueId} taskId=${task.taskId} userId=${task.userId} keywords=${task.keywords?.length} platforms=${task.platforms?.length}`);

    let recordCount = 0;
    let brandCount = 0;
    let errorMsg: string | undefined;

    try {
      const result = await executeTask({
        taskId: task.taskId,
        userId: task.userId,
        keywordType: task.keywordType,
        keywords: task.keywords,
        platforms: task.platforms
      });
      recordCount = result.totalRecords;
      brandCount = result.brandMatched;
      console.log(`[Worker] 任务执行完成 queueId=${task.queueId} records=${recordCount} brands=${brandCount}`);
    } catch (e: any) {
      errorMsg = e.message;
      console.error(`[Worker] 任务执行失败 queueId=${task.queueId}:`, e.message);
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
      console.log(`[Worker] 队列结果回写成功 queueId=${task.queueId}`);
    } catch (e: any) {
      console.error(`[Worker] 队列结果回写失败 queueId=${task.queueId}:`, e.message);
    }
  } catch (e: any) {
    console.error(`[Worker] 轮询失败:`, e.message);
  } finally {
    isProcessing = false;
  }
}

// 启动轮询
setInterval(() => {
  pollAndExecute().catch(e => {
    console.error('[Worker] 轮询异常:', e.message);
  });
}, POLL_INTERVAL);

// 启动时立即执行一次
pollAndExecute().catch(e => {
  console.error('[Worker] 启动轮询异常:', e.message);
});

// 优雅退出
process.on('SIGTERM', () => {
  console.log('[Worker] 收到SIGTERM信号，准备退出');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Worker] 收到SIGINT信号，准备退出');
  process.exit(0);
});
