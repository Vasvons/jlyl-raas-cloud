import { Router } from 'express';
import { getAeoReports, getLatestAeoReport, getLatestAeoReportByUser, getAeoReportById, getAeoFullReports, getActiveTasksForAeo } from '../repository';
import { generateAeoReport, generateAeoShardReport } from '../services/aeo/analyzer';
import { authMiddleware } from '../auth';
import { query as dbQuery } from '../db';

const router = Router();

// 触发 AEO 分析（手动，需要登录鉴权，防止滥用 LLM 配额）
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const { taskId, userId } = req.body;
    if (!taskId || !userId || !Number.isFinite(Number(taskId))) {
      return res.json({ code: 400, message: '缺少 taskId 或 userId，或 taskId 格式无效' });
    }
    // v2.1.4：管理员可为任意客户触发分析；普通用户只能为自己触发
    const caller = (req as any).user;
    if (caller?.level !== '1' && String(caller?.id) !== String(userId)) {
      return res.status(403).json({ code: 403, message: '无权为其他用户触发分析' });
    }
    const taskIdNum = Number(taskId);
    // v2.1.5：改为同步等待结果，把真实结果反馈给前端（原异步执行静默失败无反馈）
    const reportId = await generateAeoReport(taskIdNum, String(userId));
    if (reportId === null) {
      res.json({ code: 200, message: '今日日报已生成，无需重复生成', data: { reportId: null, skipped: true } });
    } else {
      res.json({ code: 200, message: 'AEO 日报生成成功', data: { reportId, skipped: false } });
    }
  } catch (e: any) {
    console.error(`[AEO] 手动分析失败:`, e.message);
    res.json({ code: 500, message: e.message });
  }
});

// v2.1.4: 删除指定任务的所有 AEO 日报（调试用，支持飞轮流程反复重试）
router.delete('/by-task/:taskId', authMiddleware, async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    if (!taskId) {
      return res.json({ code: 400, message: '缺少 taskId' });
    }
    // 仅管理员可删除
    const caller = (req as any).user;
    if (caller?.level !== '1') {
      return res.status(403).json({ code: 403, message: '仅管理员可删除 AEO 报告' });
    }
    await dbQuery('DELETE FROM aeo_report WHERE task_id = $1', [taskId]);
    console.log(`[AEO] 已删除任务 ${taskId} 的所有 AEO 日报`);
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 查询 AEO 报告列表（需要登录，校验 userId 归属）
router.get('/results', authMiddleware, async (req, res) => {
  try {
    const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    // v2.2.11：管理员(level=1)可查询任意客户的日报；普通用户只能查自己的
    // 原 bug：管理员选客户后传 userId=客户ID，但 req.user.id=管理员ID，返回 403 导致日报列表为空
    if (userId && String((req as any).user?.id) !== userId && (req as any).user?.level !== '1') {
      return res.status(403).json({ code: 403, message: '无权查询其他用户的报告' });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 30;
    const reports = await getAeoReports({ taskId, userId, limit });
    res.json({ code: 200, data: reports });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 查询最新报告（需要登录）
router.get('/latest', authMiddleware, async (req, res) => {
  try {
    const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
    if (!taskId) {
      return res.json({ code: 400, message: '缺少 taskId' });
    }
    const report = await getLatestAeoReport(taskId);
    res.json({ code: 200, data: report });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// v2.2.4：按 userId 查最新日报（解决 taskId 不匹配问题）
// 日报按客户(userId)生成，飞轮页面/daemon 应使用此接口而非 /latest?taskId=xxx
router.get('/latest-by-user', authMiddleware, async (req, res) => {
  try {
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    if (!userId) {
      return res.json({ code: 400, message: '缺少 userId' });
    }
    const report = await getLatestAeoReportByUser(userId);
    res.json({ code: 200, data: report });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// v2.2.5：补生成指定日期的 AEO 日报（管理员用，解决 cron 错过或部署导致日报未生成的问题）
// 参数：
//   userId: 客户 ID（必填）
//   date:   日报日期 YYYY-MM-DD（可选，默认前一天）
//   force:  是否强制覆盖已有日报（可选，默认 false）
// 实现逻辑：
//   1. 用 getActiveTasksForAeo 取该客户的占位 taskId（日报按 userId 维度，taskId 仅占位）
//   2. 调用 generateAeoReport(taskId, userId, { reportDate, force }) 生成日报
//   3. 同步触发 autoCreateWritingTasksFromPeriod（让日报完成后自动创建写作任务，与 cron 路径一致）
router.post('/backfill-daily', authMiddleware, async (req, res) => {
  try {
    const caller = (req as any).user;
    // 仅管理员可补生成
    if (caller?.level !== '1') {
      return res.status(403).json({ code: 403, message: '仅管理员可补生成日报' });
    }
    const userId = req.body.userId ? String(req.body.userId) : undefined;
    if (!userId) {
      return res.json({ code: 400, message: '缺少 userId' });
    }
    // 默认补生成昨天的日报（用户最常见诉求："昨天的日报没出"）
    let reportDate: string | undefined = req.body.date;
    if (!reportDate) {
      const now = new Date();
      const nowShanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      const yesterday = new Date(nowShanghai.getTime() - 24 * 60 * 60 * 1000);
      reportDate = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    }
    // 校验日期格式 YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      return res.json({ code: 400, message: 'date 格式应为 YYYY-MM-DD' });
    }
    const force = req.body.force === true;

    // 取该客户的占位 taskId
    const tasks = await getActiveTasksForAeo();
    const task = tasks.find(t => String(t.user_id) === userId) || tasks[0];
    if (!task) {
      return res.json({ code: 404, message: `客户 ${userId} 无活跃巡检任务，无法补生成日报` });
    }

    console.log(`[AEO] 管理员触发补生成: userId=${userId}, date=${reportDate}, force=${force}, taskId=${task.id} (type=${typeof task.id})`);
    // v2.2.9：task.id 来自 pg BIGINT，正常应为 number；但若任务列表为空或字段缺失会变成 NaN
    // 此处强校验，避免 NaN 传入 SQL 导致 "invalid input syntax for type integer: NaN"
    const taskIdNum = Number(task.id);
    if (!Number.isFinite(taskIdNum)) {
      console.error(`[AEO] 补生成日报 taskId 非法: task=${JSON.stringify(task)}`);
      return res.json({ code: 400, message: `taskId 非法（${task.id}），请检查客户 ${userId} 是否有活跃的巡检任务` });
    }
    const reportId = await generateAeoReport(taskIdNum, userId, { reportDate, force });
    if (reportId === null) {
      res.json({ code: 200, message: `${reportDate} 日报已存在，无需重复生成`, data: { reportId: null, skipped: true } });
    } else {
      res.json({ code: 200, message: `${reportDate} 日报补生成成功`, data: { reportId, skipped: false } });
    }
  } catch (e: any) {
    console.error('[AEO] 补生成日报失败:', e.message, e.stack);
    res.json({ code: 500, message: e.message });
  }
});

// 查询单个报告详情
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const report = await getAeoReportById(id);
    if (!report) {
      return res.json({ code: 404, message: '报告不存在' });
    }
    res.json({ code: 200, data: report });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 查询 AEO 轮次报告列表（基于完整关键词库的分析，每轮100%完成后生成）
router.get('/full-reports/:taskId', authMiddleware, async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    if (!taskId) {
      return res.json({ code: 400, message: '缺少 taskId' });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const reports = await getAeoFullReports(taskId, limit);
    res.json({ code: 200, data: reports });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// v2.1.5：补生成缺失的分片报告
// 扫描所有 status='done' 但无对应 aeo_shard_report 的分片，逐个调用 generateAeoShardReport
// 用途：修复历史 bug（result_brand_count===0 检查）导致已完成分片未生成报告的问题
// 当 generated=0 时返回诊断信息，帮助定位为什么无法生成
// v2.1.6：补生成任务状态（内存存储，进程重启丢失，不影响功能）
interface BackfillJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  total: number;
  generated: number;
  failed: number;
  current: number;
  currentQueueId: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  message: string;
  diagnosis: string;
  failedSamples: any[];
}
const backfillJobs = new Map<string, BackfillJob>();

// 触发补生成（异步）：立即返回 jobId，后台逐个处理
router.post('/shard/backfill', authMiddleware, async (req, res) => {
  try {
    // v2.1.6：支持按客户过滤（管理员从某客户飞轮页面触发时只补该客户的分片）
    const customerId = req.body.customerId ? String(req.body.customerId) : undefined;

    // 如果已有任务在运行，返回当前任务状态
    const runningJob = Array.from(backfillJobs.values()).find(j => j.status === 'running');
    if (runningJob) {
      return res.json({
        code: 200,
        data: {
          jobId: runningJob.id,
          status: runningJob.status,
          total: runningJob.total,
          generated: runningJob.generated,
          failed: runningJob.failed,
          current: runningJob.current,
          message: '补生成任务正在运行中',
        }
      });
    }

    // 查询所有已完成但无报告的分片（v2.1.6：按 customerId 过滤）
    const params: any[] = [];
    let whereClause = `WHERE q.status = 'done' AND s.id IS NULL`;
    if (customerId) {
      params.push(customerId);
      whereClause += ` AND q.user_id = $${params.length}`;
    }
    const result = await dbQuery(
      `SELECT q.id AS queue_id, q.task_id, q.user_id, q.start_time, q.end_time, q.status,
              q.result_record_count, q.result_brand_count
       FROM real_collect_queue q
       LEFT JOIN aeo_shard_report s ON s.queue_id = q.id
       ${whereClause}
       ORDER BY q.end_time DESC
       LIMIT 100`,
      params
    );
    const rows: any[] = result.rows;
    if (rows.length === 0) {
      return res.json({ code: 200, data: { total: 0, generated: 0, message: '无缺失的分片报告' } });
    }

    // 创建 job
    const jobId = `bf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const job: BackfillJob = {
      id: jobId,
      status: 'running',
      total: rows.length,
      generated: 0,
      failed: 0,
      current: 0,
      currentQueueId: null,
      startedAt: new Date(),
      finishedAt: null,
      message: '',
      diagnosis: '',
      failedSamples: [],
    };
    backfillJobs.set(jobId, job);

    // 立即响应前端
    res.json({
      code: 200,
      data: {
        jobId,
        status: 'running',
        total: rows.length,
        generated: 0,
        failed: 0,
        current: 0,
        message: `开始补生成 ${rows.length} 份分片报告`,
      }
    });

    // 后台异步处理（不阻塞响应）
    (async () => {
      for (const row of rows) {
        const queueId = row.queue_id;
        job.currentQueueId = queueId;
        try {
          const reportId = await generateAeoShardReport(queueId);
          if (reportId) {
            job.generated++;
          } else {
            job.failed++;
            // 收集诊断信息
            const startTime = row.start_time ? new Date(row.start_time) : new Date(Date.now() - 30 * 60 * 1000);
            const endTime = row.end_time ? new Date(row.end_time) : new Date();
            const diagRes = await dbQuery(
              `SELECT
                 COUNT(*) AS total_records,
                 COUNT(*) FILTER (WHERE brand_matched = true) AS brand_matched_count
               FROM real_collect_record
               WHERE task_id = $1 AND query_time >= $2 AND query_time <= $3`,
              [row.task_id, startTime, endTime]
            );
            const diag = diagRes.rows[0] || {};
            const brandRes = await dbQuery(
              `SELECT COUNT(*) AS brand_count FROM pp WHERE user_id = $1 AND pp != ''`,
              [row.user_id]
            );
            if (job.failedSamples.length < 5) {
              job.failedSamples.push({
                queue_id: queueId,
                task_id: row.task_id,
                user_id: row.user_id,
                start_time: row.start_time,
                end_time: row.end_time,
                result_record_count: row.result_record_count,
                records_in_window: Number(diag.total_records || 0),
                brand_matched_count: Number(diag.brand_matched_count || 0),
                brand_keyword_count: Number(brandRes.rows[0]?.brand_count || 0),
              });
            }
          }
        } catch (e: any) {
          job.failed++;
          if (job.failedSamples.length < 5) {
            job.failedSamples.push({ queue_id: queueId, error: e.message });
          }
          console.error(`[AEO-Backfill] 分片 ${queueId} 补生成失败:`, e.message);
        }
        job.current++;
      }

      // 完成
      job.status = 'done';
      job.finishedAt = new Date();
      job.currentQueueId = null;
      job.message = `扫描 ${job.total} 个缺失分片，成功生成 ${job.generated} 份报告，失败 ${job.failed} 份`;

      // 生成诊断摘要
      if (job.generated === 0 && job.failedSamples.length > 0) {
        const sample = job.failedSamples[0];
        if (sample.brand_keyword_count === 0) {
          job.diagnosis = `用户 ${sample.user_id} 未配置品牌词（pp 表为空），无法识别品牌命中。请先在"品牌词库"中为该用户添加品牌词。`;
        } else if (sample.brand_matched_count === 0 && sample.records_in_window > 0) {
          job.diagnosis = `分片 ${sample.queue_id} 时间窗口内有 ${sample.records_in_window} 条查询记录，但无 brand_matched=true 记录（品牌词与 AI 回答内容未匹配）。品牌词配置了 ${sample.brand_keyword_count} 个，可能需要检查品牌词与实际内容是否匹配。`;
        } else if (sample.records_in_window === 0) {
          job.diagnosis = `分片 ${sample.queue_id} 时间窗口内无任何 real_collect_record 记录（start=${sample.start_time}, end=${sample.end_time}）。可能记录被清理或时间窗口不对。`;
        } else {
          job.diagnosis = sample.error || '未知原因';
        }
      }

      console.log(`[AEO-Backfill] 任务 ${jobId} 完成: ${job.message}`);
      // 清理超过 1 小时的旧 job
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      for (const [id, j] of backfillJobs) {
        if (j.finishedAt && j.finishedAt.getTime() < oneHourAgo) {
          backfillJobs.delete(id);
        }
      }
    })().catch(err => {
      console.error(`[AEO-Backfill] 任务 ${jobId} 异常:`, err);
      job.status = 'failed';
      job.message = `任务异常: ${err.message}`;
      job.finishedAt = new Date();
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询补生成任务状态
router.get('/shard/backfill/status', authMiddleware, async (req, res) => {
  const jobId = req.query.jobId as string;
  if (!jobId) {
    // 返回最近的一个 job
    const jobs = Array.from(backfillJobs.values());
    if (jobs.length === 0) {
      return res.json({ code: 200, data: { status: 'none', message: '无补生成任务' } });
    }
    const latest = jobs[jobs.length - 1];
    return res.json({ code: 200, data: latest });
  }
  const job = backfillJobs.get(jobId);
  if (!job) {
    return res.json({ code: 404, data: { message: '任务不存在或已清理' } });
  }
  res.json({ code: 200, data: job });
});

export default router;
