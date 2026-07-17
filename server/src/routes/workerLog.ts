import { Router } from 'express';
import { insertWorkerLog, insertWorkerLogs, getWorkerLogs, getQueuePressure } from '../repository';
import { authMiddleware, requireAdmin } from '../auth';

const router = Router();

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

// 内部调用鉴权中间件（worker 与 server 共享密钥）
function internalAuth(req: any, res: any, next: any): void {
  // 如果未配置密钥，则放行（开发环境兼容）
  if (!INTERNAL_SECRET) return next();
  const secret = req.headers['x-internal-secret'] || req.query.secret;
  if (secret !== INTERNAL_SECRET) {
    res.status(401).json({ code: 401, message: '未授权' });
    return;
  }
  next();
}

// Worker 上报日志（内部调用，需要密钥）
router.post('/report', internalAuth, async (req, res) => {
  try {
    const { workerId, taskId, level, message } = req.body;
    if (!workerId || !message) {
      return res.json({ code: 400, message: '缺少 workerId 或 message' });
    }
    await insertWorkerLog({
      workerId,
      taskId: taskId ? Number(taskId) : undefined,
      level: level || 'info',
      message: String(message).substring(0, 2000),
    });
    res.json({ code: 200, message: 'ok' });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// Worker 批量上报日志（内部调用，需要密钥）
// 单次最多200条，用一条 SQL 批量插入，大幅减少高频上报时的请求量和数据库压力
router.post('/report-batch', internalAuth, async (req, res) => {
  try {
    const logs = req.body.logs;
    if (!Array.isArray(logs) || logs.length === 0) {
      return res.json({ code: 400, message: '缺少 logs 数组' });
    }
    const limited = logs.slice(0, 200).filter((e: any) => e && e.workerId && e.message);
    if (limited.length > 0) {
      await insertWorkerLogs(limited.map((e: any) => ({
        workerId: String(e.workerId),
        taskId: e.taskId ? Number(e.taskId) : undefined,
        level: e.level || 'info',
        message: e.message,
      })));
    }
    res.json({ code: 200, message: 'ok', count: limited.length });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 查询日志（v2.2.12：修复原完全公开漏洞，改为需要管理员登录）
// 原 bug：任何人可查任意 taskId 的 Worker 日志，可能泄露巡检任务内部信息
router.get('/list', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const sinceId = req.query.sinceId ? Number(req.query.sinceId) : undefined;
    const logs = await getWorkerLogs({ taskId, limit, sinceId });
    res.json({ code: 200, data: logs });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 队列压力（worker 用于动态扩缩容，内部调用）
router.get('/queue-pressure', internalAuth, async (req, res) => {
  try {
    const pressure = await getQueuePressure();
    // 根据pending+running数量推荐并发数
    // 重要：worker 容器内存仅 1g，并发数超过 8 会导致 Page crashed
    // 最大并发数限制为 8，避免浏览器内存压力
    const totalActive = pressure.pendingCount + pressure.processingCount;
    let recommendedConcurrency = 6;
    if (pressure.pendingCount > 20) recommendedConcurrency = 8;
    else if (pressure.pendingCount > 10) recommendedConcurrency = 8;
    else if (pressure.pendingCount > 5) recommendedConcurrency = 6;
    else if (pressure.pendingCount > 0) recommendedConcurrency = 4;
    else if (totalActive > 0) recommendedConcurrency = 6; // 有running任务但无pending，保持6
    else recommendedConcurrency = 4; // 队列空闲，保持4
    res.json({ code: 200, data: { ...pressure, recommendedConcurrency } });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

export default router;
