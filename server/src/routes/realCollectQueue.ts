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
  updateTaskRunStatus,
  updateQueueProgress
} from '../repository';
import { generateAeoShardReport } from '../services/aeo/analyzer';
import { wsBroadcast } from '../wsServer';

const router = Router();

// v2.5.37：获取当前登录用户ID（token payload 字段名为 'id'）
function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

// v2.5.37：判断是否为代理账号（level≠'1' 且 role='agent'）
function isAgent(req: any): boolean {
  const userLevel = String(req.user?.level ?? '');
  const userRole = String(req.user?.role ?? '');
  return userLevel !== '1' && userRole === 'agent';
}

// Worker消费队列任务（不需要鉴权，由Worker内部调用）
router.post('/dequeue', async (req, res) => {
  try {
    const workerId = req.body.workerId || `worker-${req.ip}-${Date.now()}`;
    // v2.5.36：支持按 agent_user_id 路由（混合模式 worker 分布式架构）
    const agentUserId = req.body.agent_user_id ? Number(req.body.agent_user_id) : undefined;
    const task = await dequeueRealCollectTask(workerId, agentUserId);
    if (!task) {
      return res.json({ code: 200, data: null });
    }
    console.log(`[RealCollectQueue] Worker(${workerId}) 消费任务 queueId=${task.queueId} taskId=${task.taskId}`);
    // v2.4.0：推送分片 dequeue 事件，前端可立即刷新 progressMap
    wsBroadcast('shard_dequeued', {
      queueId: task.queueId,
      taskId: task.taskId,
      userId: task.userId,
    }, task.userId);
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

    // v2.0.0: 分片成功完成后，异步触发分片级 AEO 分析
    // 分析结果只入库 aeo_shard_report，不触发写作任务（等待周/月报汇总）
    // v2.0.5 修复：不再依赖 worker 回传的 brandCount（worker 端写死 false，永远为 0）
    // 改为只要分片成功完成就触发，由 generateAeoShardReport 内部查 real_collect_record
    // 表的实际 brand_matched 数据做准确判断（analyzer.ts 第 5/6/7 道门）
    if (!error) {
      generateAeoShardReport(queueId)
        .then(reportId => {
          if (reportId) {
            console.log(`[RealCollectQueue] 分片 ${queueId} AEO报告已生成: reportId=${reportId}`);
            // v2.4.0：推送分片报告生成完成事件，前端可立即刷新 shardReports
            wsBroadcast('aeo_shard_report_generated', {
              reportId,
              queueId,
              taskId,
            }, undefined);
          }
        })
        .catch(e => {
          console.error(`[RealCollectQueue] 分片 ${queueId} AEO分析失败:`, e.message);
        });
    }

    console.log(`[RealCollectQueue] 队列任务完成 queueId=${queueId} records=${recordCount} brands=${brandCount} error=${error || '无'}`);
    // v2.4.0：推送分片完成事件，前端可立即刷新 progressMap
    // 注意：taskId/userId 从 req.body 拿（Worker 上报时携带）
    wsBroadcast('shard_completed', {
      queueId,
      taskId,
      recordCount: recordCount || 0,
      brandCount: brandCount || 0,
      success: !error,
      error: error || null,
    }, undefined);
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

// Worker更新分片处理进度（不需要鉴权，由Worker内部调用）
// 记录已处理到的关键词索引，重启后从断点续查，避免从头重复消费
router.post('/progress', async (req, res) => {
  try {
    const { queueId, lastKeywordIndex } = req.body;
    if (!queueId) {
      return res.status(400).json({ code: 400, message: '缺少queueId' });
    }
    await updateQueueProgress(queueId, lastKeywordIndex);
    res.json({ code: 200, message: 'ok' });
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

// v2.5.36：移除 adminMiddleware，代理可访问（中断操作仅影响自己的队列）
// 获取当前正在运行的任务（供前端显示，需要鉴权）
router.get('/running', authMiddleware, async (req, res) => {
  try {
    // v2.5.37：代理只看自己名下任务的运行状态，管理员看全局
    const userId = isAgent(req) ? getUserId(req) : undefined;
    const task = await getRunningQueueTask(userId);
    res.json({ code: 200, data: task });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 中断指定队列任务（需要鉴权）
router.post('/:id/abort', authMiddleware, async (req, res) => {
  try {
    const queueId = parseInt(req.params.id);
    if (!queueId) {
      return res.status(400).json({ code: 400, message: '缺少queueId' });
    }
    // v2.5.37：代理只能中断自己名下的任务
    const userId = isAgent(req) ? getUserId(req) : undefined;
    const success = await requestQueueAbort(queueId, userId);
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
router.post('/abort-all', authMiddleware, async (req, res) => {
  try {
    // v2.5.37：代理只能中断自己名下的任务
    const userId = isAgent(req) ? getUserId(req) : undefined;
    const count = await abortAllRunningTasks(userId);
    console.log(`[RealCollectQueue] 已请求中断 ${count} 个运行中的任务`);
    res.json({ code: 200, message: `已请求中断 ${count} 个任务`, data: { count } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
