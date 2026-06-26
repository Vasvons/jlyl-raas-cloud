import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  createRealCollectTask,
  updateRealCollectTask,
  deleteRealCollectTask,
  getRealCollectTasks,
  getRealCollectTaskById,
  getTaskShardProgress,
  resetTaskCurrentRound,
  getExcludePrefixOptions,
} from '../repository';
import { enqueueTaskNow } from '../services/realCollect/scheduler';

const router = Router();

router.use(authMiddleware, adminMiddleware);

// 获取蒸馏词库可用的前缀屏蔽词选项（来源：kw_config 的 A 组词）
router.get('/exclude-prefix-options', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) {
      return res.json({ code: 400, message: '缺少 userId' });
    }
    const options = await getExcludePrefixOptions(userId);
    res.json({ code: 200, data: options });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

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
    const { userId, taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes } = req.body;
    // cronExpr 可选：循环模式下不传 cronExpr，任务24小时持续执行
    if (!userId || !taskName || keywordType === undefined || !platforms) {
      return res.status(400).json({ code: 400, message: '缺少必要参数' });
    }
    const id = await createRealCollectTask({ userId, taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes });
    res.json({ code: 200, message: '创建成功', data: { id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes } = req.body;
    await updateRealCollectTask(parseInt(req.params.id), { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes });
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

// 重置任务当前轮次
// 删除当前轮次的所有分片，重置 round_no，调度器会自动用去重后的关键词启动新一轮
// 用于修复分片数异常（如关键词重复入库导致分片数翻倍）的问题
router.post('/:id/reset-round', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' });
    }
    const result = await resetTaskCurrentRound(taskId);
    res.json({
      code: 200,
      message: `已重置第 ${result.roundNo} 轮，删除 ${result.deletedShards} 个分片，调度器将自动启动新一轮`,
      data: result,
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
