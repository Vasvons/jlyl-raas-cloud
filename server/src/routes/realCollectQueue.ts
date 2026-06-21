import { Router } from 'express';
import {
  dequeueRealCollectTask,
  completeQueueTask,
  getQueuePendingCount,
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

    // 同步更新任务运行状态
    if (taskId) {
      await updateTaskRunStatus(taskId, {
        status: error ? 'failed' : 'success',
        recordCount: recordCount || 0,
        brandCount: brandCount || 0,
        endTime: new Date()
      });
    }

    console.log(`[RealCollectQueue] 队列任务完成 queueId=${queueId} records=${recordCount} brands=${brandCount} error=${error || '无'}`);
    res.json({ code: 200, message: 'ok' });
  } catch (e: any) {
    console.error('[RealCollectQueue] complete失败:', e.message);
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

export default router;
