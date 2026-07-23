import { Router } from 'express';
import { authMiddleware } from '../auth';
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
  getBrandKeywords,
  getBrandQueryKeywords,
  getDistillateKeywords,
} from '../repository';
import { enqueueTaskNow } from '../services/realCollect/scheduler';
import { wsBroadcast } from '../wsServer';

const router = Router();

// v2.5.36：移除文件级 adminMiddleware，代理可访问但按 user_id 隔离
router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

function isAgent(req: any): boolean {
  const userLevel = String(req.user?.level ?? '');
  const userRole = String(req.user?.role ?? '');
  return userLevel !== '1' && userRole === 'agent';
}

/** v2.5.36：解析 userId 参数，代理强制用自己 ID */
function resolveUserId(req: any, bodyField?: string): string | undefined {
  if (isAgent(req)) return String(getUserId(req));
  if (bodyField && req.body?.[bodyField]) return String(req.body[bodyField]);
  if (req.query.userId) return String(req.query.userId);
  return undefined;
}

// 获取蒸馏词库可用的前缀屏蔽词选项（来源：kw_config 的 A 组词）
router.get('/exclude-prefix-options', async (req, res) => {
  try {
    const userId = resolveUserId(req);
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
    const userId = resolveUserId(req);
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
    const userId = resolveUserId(req);
    const tasks = await getRealCollectTasks(userId);
    // v2.1.5：为每个任务附加 keyword_count，前端据此判断"无关键词"状态
    const tasksWithKwCount = await Promise.all(
      tasks.map(async (t: any) => {
        try {
          const keywords = t.keyword_type === 1
            ? await getBrandKeywords(t.user_id)
            : await getDistillateKeywords(t.user_id);
          return { ...t, keyword_count: keywords.length };
        } catch {
          return { ...t, keyword_count: -1 }; // -1 表示查询失败
        }
      })
    );
    res.json({ code: 200, data: tasksWithKwCount });
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
    // v2.5.36：代理创建任务强制用自己 userId
    const userId = isAgent(req) ? String(getUserId(req)) : req.body.userId;
    const { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode } = req.body;
    // cronExpr 可选：循环模式下不传 cronExpr，任务24小时持续执行
    if (!userId || !taskName || keywordType === undefined || !platforms) {
      return res.status(400).json({ code: 400, message: '缺少必要参数' });
    }
    // v2.1.5：创建前检查关键词是否存在，给出警告（但仍允许创建，用户可能稍后导入关键词）
    let warning: string | undefined;
    try {
      const keywords = keywordType === 1
        ? await getBrandQueryKeywords(userId)
        : await getDistillateKeywords(userId);
      if (keywords.length === 0) {
        const kwSource = keywordType === 1 ? '品牌词库（pp 表）' : '蒸馏词库（zlgjc 表）';
        warning = `该用户在${kwSource}中暂无关键词，任务创建后不会立即执行。请先导入关键词。`;
      }
    } catch {
      // 关键词查询失败不阻塞创建
    }
    const id = await createRealCollectTask({ userId, taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode });
    // v2.4.0：推送任务创建事件
    wsBroadcast('real_collect_task_changed', { taskId: id, userId, action: 'created' }, userId);
    res.json({ code: 200, message: '创建成功', data: { id }, warning });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode } = req.body;
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    await updateRealCollectTask(taskId, { taskName, keywordType, platforms, cronExpr, shardSize, excludePrefixes, excludeCombos, queryMode });
    // v2.4.0：推送任务更新事件
    if (task?.user_id) {
      wsBroadcast('real_collect_task_changed', { taskId, userId: task.user_id, action: 'updated' }, task.user_id);
    }
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    await deleteRealCollectTask(taskId);
    // v2.4.0：推送任务删除事件
    if (task?.user_id) {
      wsBroadcast('real_collect_task_changed', { taskId, userId: task.user_id, action: 'deleted' }, task.user_id);
    }
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
    // v2.4.0：推送任务立即执行事件
    wsBroadcast('real_collect_task_changed', { taskId: task.id, userId: task.user_id, action: 'run_now' }, task.user_id);
    res.json({ code: 200, message: '任务已加入队列', data: { queueId } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    await updateRealCollectTask(taskId, { status: 'paused' });
    // v2.4.0：推送任务暂停事件
    if (task?.user_id) {
      wsBroadcast('real_collect_task_changed', { taskId, userId: task.user_id, action: 'paused' }, task.user_id);
    }
    res.json({ code: 200, message: '任务已暂停' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await getRealCollectTaskById(taskId);
    await updateRealCollectTask(taskId, { status: 'active' });
    // v2.4.0：推送任务恢复事件
    if (task?.user_id) {
      wsBroadcast('real_collect_task_changed', { taskId, userId: task.user_id, action: 'resumed' }, task.user_id);
    }
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
