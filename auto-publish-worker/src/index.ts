/**
 * 云端发布 Worker 主入口（v2.0.0 P6）
 *
 * 职责：
 *  - 定时轮询（30秒）从云端拉取 pending 的 publish_record
 *  - 并发限制 2（与桌面端一致，云端容器内存 1g）
 *  - 同平台串行（由 publishExecutor 内部 platformLocks 保证）
 *  - 通过 X-Worker-Secret 头认证（不走 JWT）
 *
 * 与 auto-collect-worker 的差异：
 *  - 使用 GET /content/publish/records/dequeue 拉取任务（非 POST）
 *  - 并发 2（发布任务更重，比巡检的 8 并发低）
 *  - 无续期器（发布不需要保活账号）
 */
import dotenv from 'dotenv';
import axios from 'axios';
import http from 'http';
import { processRecord, PublishRecord } from './publishExecutor';
import * as logger from './logger';
import { isPrivateDeployMode, activatePrivateDeploy, startHeartbeat, stopHeartbeat, getAgentUserId } from './privateDeploy';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 30000;
const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3004');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2');

const WORKER_ID = `publish-worker-${process.pid}-${Date.now()}`;

if (!WORKER_SECRET) {
  console.error('[PublishWorker] 警告: WORKER_SECRET 环境变量未设置，无法认证到云端服务');
  console.error('[PublishWorker] 请在 docker-compose.yml 中设置 WORKER_SECRET 环境变量');
}

if (!process.env.SERVER_URL) {
  console.error('[PublishWorker] 警告: SERVER_URL 环境变量未设置，使用默认值 http://localhost:3002');
}

logger.info(`云端发布 Worker 已启动`);
logger.info(`WORKER_ID=${WORKER_ID}`);
logger.info(`SERVER_URL=${SERVER_URL}`);
logger.info(`POLL_INTERVAL=${POLL_INTERVAL}ms`);
logger.info(`MAX_CONCURRENT=${MAX_CONCURRENT}`);

// 健康检查 HTTP 服务器
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', workerId: WORKER_ID, activeCount }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});
healthServer.listen(WORKER_PORT, () => {
  logger.info(`健康检查服务监听端口 ${WORKER_PORT}`);
});

let activeCount = 0;
let isShuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
const MAX_BACKOFF_INTERVAL = 60000; // 最大退避到60秒
let lastEmptyLogTime = 0;

/**
 * 轮询主循环
 */
async function pollAndExecute(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  const availableSlots = MAX_CONCURRENT - activeCount;
  if (availableSlots <= 0) {
    return;
  }

  try {
    const resp = await axios.get(
      `${SERVER_URL}/content/publish/records/dequeue`,
      {
        params: {
          limit: availableSlots,
          ...(getAgentUserId() ? { agent_user_id: getAgentUserId() } : {}),
        },
        headers: { 'X-Worker-Secret': WORKER_SECRET },
        timeout: 15000,
      }
    );

    // 成功连接，重置失败计数
    consecutiveFailures = 0;

    const records: any[] = resp.data?.data || [];
    if (records.length === 0) {
      const now = Date.now();
      if (now - lastEmptyLogTime > 60000) {
        lastEmptyLogTime = now;
        const reason = resp.data?.reason || '暂无待发布记录';
        logger.info(`暂无待发布记录：${reason}`);
      }
      return;
    }

    logger.info(`拉取到 ${records.length} 条待发布记录`);
    for (const record of records) {
      activeCount++;
      processRecord(record as PublishRecord).finally(() => {
        activeCount--;
      });
    }
  } catch (e: any) {
    consecutiveFailures++;
    const backoff = Math.min(POLL_INTERVAL * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_INTERVAL);
    logger.error(`轮询失败(第${consecutiveFailures}次): ${e.message}，${Math.round(backoff / 1000)}秒后重试`);
    await new Promise(resolve => setTimeout(resolve, backoff));
  }
}

// v2.5.36：私有部署模式下，先激活再启动轮询；否则直接启动
(async () => {
  if (isPrivateDeployMode()) {
    logger.info(`[PrivateDeploy] 检测到 LICENSE_KEY，启动私有部署模式`);
    const ok = await activatePrivateDeploy();
    if (ok) {
      startHeartbeat();
    } else {
      logger.error(`[PrivateDeploy] 激活失败，5 秒后退出`);
      await new Promise((r) => setTimeout(r, 5000));
      process.exit(1);
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
})();

// 优雅停机
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`收到${signal}信号，准备优雅退出`);

  // 停止私有部署心跳
  stopHeartbeat();

  // 关闭健康检查服务器
  if (healthServer) {
    healthServer.close();
  }

  // 清理轮询定时器
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // 等待当前任务完成（最多60秒，发布任务比巡检任务耗时长）
  const startTime = Date.now();
  while (activeCount > 0 && Date.now() - startTime < 60000) {
    logger.info(`等待 ${activeCount} 个发布任务完成...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  await logger.flushLogs();
  logger.info('退出完成');
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
