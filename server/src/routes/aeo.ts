import { Router } from 'express';
import { getAeoReports, getLatestAeoReport, getAeoReportById, getAeoFullReports } from '../repository';
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
    // 如果传了 userId，校验是否为当前登录用户
    if (userId && String((req as any).user?.id) !== userId) {
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
router.post('/shard/backfill', authMiddleware, async (req, res) => {
  try {
    // 查询所有已完成但无报告的分片（带诊断字段）
    const result = await dbQuery(
      `SELECT q.id AS queue_id, q.task_id, q.user_id, q.start_time, q.end_time, q.status,
              q.result_record_count, q.result_brand_count
       FROM real_collect_queue q
       LEFT JOIN aeo_shard_report s ON s.queue_id = q.id
       WHERE q.status = 'done' AND s.id IS NULL
       ORDER BY q.end_time DESC
       LIMIT 100`
    );
    const rows: any[] = result.rows;
    if (rows.length === 0) {
      return res.json({ code: 200, data: { total: 0, generated: 0, message: '无缺失的分片报告' } });
    }

    // 逐个补生成
    let generated = 0;
    const failed: any[] = [];
    for (const row of rows) {
      const queueId = row.queue_id;
      try {
        const reportId = await generateAeoShardReport(queueId);
        if (reportId) {
          generated++;
        } else {
          // generateAeoShardReport 返回 null，收集诊断信息
          // 查该分片时间窗口内 real_collect_record 的总数和 brand_matched=true 数
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
          // 查该用户品牌词数量
          const brandRes = await dbQuery(
            `SELECT COUNT(*) AS brand_count FROM pp WHERE user_id = $1 AND pp != ''`,
            [row.user_id]
          );
          failed.push({
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
      } catch (e: any) {
        failed.push({ queue_id: queueId, error: e.message });
        console.error(`[AEO-Backfill] 分片 ${queueId} 补生成失败:`, e.message);
      }
    }

    // 生成诊断摘要
    let diagnosis = '';
    if (generated === 0 && failed.length > 0) {
      const sample = failed[0];
      if (sample.brand_keyword_count === 0) {
        diagnosis = `用户 ${sample.user_id} 未配置品牌词（pp 表为空），无法识别品牌命中。请先在"品牌词库"中为该用户添加品牌词。`;
      } else if (sample.brand_matched_count === 0 && sample.records_in_window > 0) {
        diagnosis = `分片 ${sample.queue_id} 时间窗口内有 ${sample.records_in_window} 条查询记录，但无 brand_matched=true 记录（品牌词与 AI 回答内容未匹配）。品牌词配置了 ${sample.brand_keyword_count} 个，可能需要检查品牌词与实际内容是否匹配。`;
      } else if (sample.records_in_window === 0) {
        diagnosis = `分片 ${sample.queue_id} 时间窗口内无任何 real_collect_record 记录（start=${sample.start_time}, end=${sample.end_time}）。可能记录被清理或时间窗口不对。`;
      } else {
        diagnosis = sample.error || '未知原因';
      }
    }

    res.json({
      code: 200,
      data: {
        total: rows.length,
        generated,
        message: `扫描 ${rows.length} 个缺失分片，成功生成 ${generated} 份报告` + (diagnosis ? `。原因：${diagnosis}` : ''),
        diagnosis,
        failed_samples: failed.slice(0, 5),
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
