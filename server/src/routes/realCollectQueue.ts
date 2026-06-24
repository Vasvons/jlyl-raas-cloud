import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  dequeueRealCollectTask,
  completeQueueTask,
  getQueuePendingCount,
  requestQueueAbort,
  checkQueueAbort,
  abortAllRunningTasks,
  getRunningQueueTask,
  updateTaskRunStatus
} from '../repository';

const router = Router();

// Worker消费队列任务（不需要鉴权，由Worker内部调用）
router.post('/dequeue', async (req, res) => {
  try {
    const workerId = req.body.workerId || `worker-${req.ip}-${Date.now()}`;
    const task = await dequeueRealCollectTask(workerId);
    if (!task) {
      return res.json({ code: 200, data: null });
    }
    console.log(`[RealCollectQueue] Worker(${workerId}) 消费任务 queueId=${task.queueId} taskId=${task.taskId}`);
    res.json({ code: 200, data: task });
  } catch (e: any) {
    console.error('[RealCollectQueue] dequeue失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

// Worker回写队列任务结果（不需要鉴权，由Worker内部调用）
router.post('/complete', async (req, res) => {
  try {
    const { queueId, recordCount, brandCount, error, taskId } = req.body;
    if (!queueId) {
      return res.status(400).json({ code: 400, message: '缺少queueId' });
    }
    await completeQueueTask(queueId, recordCount || 0, brandCount || 0, error);

    // 分片完成时不改变任务的 running 状态（整个轮次完成由 scheduler 检测并更新）
    // 只在分片失败时记录错误信息到任务表
    if (taskId && error) {
      await updateTaskRunStatus(taskId, {
        status: 'running',
        error: error
      });
    }

    console.log(`[RealCollectQueue] 队列任务完成 queueId=${queueId} records=${recordCount} brands=${brandCount} error=${error || '无'}`);
    res.json({ code: 200, message: 'ok' });
  } catch (e: any) {
    console.error('[RealCollectQueue] complete失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

// Worker检查任务是否被请求中断（不需要鉴权，由Worker内部调用）
router.get('/check-abort/:queueId', async (req, res) => {
  try {
    const queueId = parseInt(req.params.queueId);
    if (!queueId) {
      return res.status(400).json({ code: 400, message: '缺少queueId' });
    }
    const aborted = await checkQueueAbort(queueId);
    res.json({ code: 200, data: { aborted } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询队列pending数量（需要鉴权，但此处开放供监控使用）
router.get('/pending-count', async (req, res) => {
  try {
    const count = await getQueuePendingCount();
    res.json({ code: 200, data: { count } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 获取当前正在运行的任务（供前端显示，需要鉴权）
router.get('/running', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const task = await getRunningQueueTask();
    res.json({ code: 200, data: task });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 中断指定队列任务（需要鉴权）
router.post('/:id/abort', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const queueId = parseInt(req.params.id);
    if (!queueId) {
      return res.status(400).json({ code: 400, message: '缺少queueId' });
    }
    const success = await requestQueueAbort(queueId);
    if (success) {
      console.log(`[RealCollectQueue] 任务 queueId=${queueId} 已请求中断`);
      res.json({ code: 200, message: '中断请求已发送' });
    } else {
      res.status(404).json({ code: 404, message: '任务不存在或不在运行中' });
    }
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 紧急中断所有正在运行的任务（需要鉴权）
router.post('/abort-all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const count = await abortAllRunningTasks();
    console.log(`[RealCollectQueue] 已请求中断 ${count} 个运行中的任务`);
    res.json({ code: 200, message: `已请求中断 ${count} 个任务`, data: { count } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
