import { Router } from 'express';
import { insertWorkerLog, getWorkerLogs, getQueuePressure } from '../repository';

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

// 查询日志（前端调用，不需要内部密钥）
router.get('/list', async (req, res) => {
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
    // 修复：原来pendingCount=0时降到2，但有running任务时应保持较高并发
    const totalActive = pressure.pendingCount + pressure.processingCount;
    let recommendedConcurrency = 8;
    if (pressure.pendingCount > 20) recommendedConcurrency = 16;
    else if (pressure.pendingCount > 10) recommendedConcurrency = 12;
    else if (pressure.pendingCount > 5) recommendedConcurrency = 8;
    else if (pressure.pendingCount > 0) recommendedConcurrency = 6;
    else if (totalActive > 0) recommendedConcurrency = 8; // 有running任务但无pending，保持8
    else recommendedConcurrency = 4; // 队列空闲，保持4（不再降到2）
    res.json({ code: 200, data: { ...pressure, recommendedConcurrency } });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

export default router;
