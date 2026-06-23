import { Router } from 'express';
import { getAeoReports, getLatestAeoReport, getAeoReportById } from '../repository';
import { generateAeoReport } from '../services/aeo/analyzer';
import { authMiddleware } from '../auth';

const router = Router();

// 触发 AEO 分析（手动，需要登录鉴权，防止滥用 LLM 配额）
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const { taskId, userId } = req.body;
    if (!taskId || !userId || !Number.isFinite(Number(taskId))) {
      return res.json({ code: 400, message: '缺少 taskId 或 userId，或 taskId 格式无效' });
    }
    // 校验 userId 归属：只能为当前登录用户触发分析
    if (String((req as any).user?.id) !== String(userId)) {
      return res.status(403).json({ code: 403, message: '无权为其他用户触发分析' });
    }
    const taskIdNum = Number(taskId);
    // 异步触发分析，不阻塞响应
    generateAeoReport(taskIdNum, String(userId))
      .then(reportId => console.log(`[AEO] 手动分析完成 taskId=${taskIdNum} reportId=${reportId}`))
      .catch(e => console.error(`[AEO] 手动分析失败 taskId=${taskIdNum}:`, e.message));
    res.json({ code: 200, message: '分析已触发，请稍后查询结果' });
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

export default router;
