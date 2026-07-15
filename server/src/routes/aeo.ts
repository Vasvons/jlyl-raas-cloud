import { Router } from 'express';
import { getAeoReports, getLatestAeoReport, getAeoReportById, getAeoFullReports } from '../repository';
import { generateAeoReport } from '../services/aeo/analyzer';
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

export default router;
