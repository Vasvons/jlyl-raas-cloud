import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  createRealCollectTask,
  updateRealCollectTask,
  deleteRealCollectTask,
  getRealCollectTasks,
  getRealCollectTaskById,
  getTaskShardProgress,
} from '../repository';
import { enqueueTaskNow } from '../services/realCollect/scheduler';

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    const tasks = await getRealCollectTasks(userId);
    res.json({ code: 200, data: tasks });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const task = await getRealCollectTaskById(parseInt(req.params.id));
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' });
    }
    res.json({ code: 200, data: task });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { userId, taskName, keywordType, platforms, cronExpr, shardSize } = req.body;
    // cronExpr 可选：循环模式下不传 cronExpr，任务24小时持续执行
    if (!userId || !taskName || keywordType === undefined || !platforms) {
      return res.status(400).json({ code: 400, message: '缺少必要参数' });
    }
    const id = await createRealCollectTask({ userId, taskName, keywordType, platforms, cronExpr, shardSize });
    res.json({ code: 200, message: '创建成功', data: { id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { taskName, keywordType, platforms, cronExpr, shardSize } = req.body;
    await updateRealCollectTask(parseInt(req.params.id), { taskName, keywordType, platforms, cronExpr, shardSize });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteRealCollectTask(parseInt(req.params.id));
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const task = await getRealCollectTaskById(parseInt(req.params.id));
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' });
    }
    const queueId = await enqueueTaskNow(task);
    res.json({ code: 200, message: '任务已加入队列', data: { queueId } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    await updateRealCollectTask(parseInt(req.params.id), { status: 'paused' });
    res.json({ code: 200, message: '任务已暂停' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    await updateRealCollectTask(parseInt(req.params.id), { status: 'active' });
    res.json({ code: 200, message: '任务已恢复' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 获取任务分片执行进度
router.get('/:id/progress', async (req, res) => {
  try {
    const progress = await getTaskShardProgress(parseInt(req.params.id));
    res.json({ code: 200, data: progress });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
