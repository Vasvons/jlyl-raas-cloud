import { Router } from 'express';
import {
  getSystemOverview,
  getTaskStatusSummary,
  getRecentRecords,
  getUserDataStats,
} from '../repository';
import { authMiddleware, adminMiddleware } from '../auth';

const router = Router();

// 系统概览
router.get('/overview', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const data = await getSystemOverview();
    res.json({ code: 200, data });
  } catch (e) {
    console.error('[Monitor] 获取系统概览失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 任务状态汇总
router.get('/taskSummary', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const data = await getTaskStatusSummary();
    res.json({ code: 200, data });
  } catch (e) {
    console.error('[Monitor] 获取任务状态汇总失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 最近生成记录
router.get('/recent', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const data = await getRecentRecords(Math.min(limit, 100));
    res.json({ code: 200, data });
  } catch (e) {
    console.error('[Monitor] 获取最近记录失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 各用户数据量统计
router.get('/userStats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const data = await getUserDataStats();
    res.json({ code: 200, data });
  } catch (e) {
    console.error('[Monitor] 获取用户数据统计失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
