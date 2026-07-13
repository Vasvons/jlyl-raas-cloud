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
  getExcludeComboOptions,
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

// 获取蒸馏词库可用的组合规则屏蔽选项（来源：kw_config 的 combos 字段）
router.get('/exclude-combo-options', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) {
      return res.json({ code: 400, message: '缺少 userId' });
    }
    const options = await getExcludeComboOptions(userId);
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
    const { userId, taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode } = req.body;
    // cronExpr 可选：循环模式下不传 cronExpr，任务24小时持续执行
    if (!userId || !taskName || keywordType === undefined || !platforms) {
      return res.status(400).json({ code: 400, message: '缺少必要参数' });
    }
    const id = await createRealCollectTask({ userId, taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode });
    res.json({ code: 200, message: '创建成功', data: { id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode } = req.body;
    await updateRealCollectTask(parseInt(req.params.id), { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode });
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
// 1. 对 running 分片请求 abort（Worker 几秒内退出）
// 2. 删除当前轮次所有分片
// 3. 立即调用 enqueueTaskNow 入队新分片（高优先级）
// 用于：编辑屏蔽词后立即生效、修复分片数异常
router.post('/:id/reset-round', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' });
    }
    const result = await resetTaskCurrentRound(taskId);
    // 立即入队新分片（不能再依赖调度器，调度器 checkCompletedRounds 不会为此场景启动新一轮）
    let firstQueueId = 0;
    try {
      firstQueueId = await enqueueTaskNow(task);
    } catch (e: any) {
      // enqueueTaskNow 失败不阻塞返回，但要在消息里提示
      console.error(`[RealCollect] 任务 ${taskId} reset-round 后入队失败:`, e.message);
      return res.json({
        code: 200,
        message: `已重置第 ${result.roundNo} 轮，删除 ${result.deletedShards} 个分片，中断 ${result.runningShardsAborted} 个运行分片；但新分片入队失败：${e.message}`,
        data: { ...result, firstQueueId: 0 },
      });
    }
    res.json({
      code: 200,
      message: `已重置第 ${result.roundNo} 轮，删除 ${result.deletedShards} 个分片，中断 ${result.runningShardsAborted} 个运行分片，并立即启动新一轮（${firstQueueId ? '首分片已入队' : '无可用关键词'}）`,
      data: { ...result, firstQueueId },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
