import { Router } from 'express';
import {
  getAllTasks,
  createTask,
  updateTask,
  deleteTask,
  getTaskWeights,
  setTaskWeights,
  getTaskGeneratedNum,
} from '../repository';
import { authMiddleware, adminMiddleware } from '../auth';

const router = Router();

// 获取任务列表
router.get('/list', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = (req.query.userId as string) || 'all';
    const tasks = await getAllTasks(userId);

    // 获取每个任务的权重和实际生成数量
    const result = [];
    for (const task of tasks) {
      const weights = await getTaskWeights(task.id);
      const generatedNum = await getTaskGeneratedNum(task.id);
      result.push({
        id: task.id,
        userId: task.user_id,
        userName: task.user_name,
        startDate: task.start_date,
        endDate: task.end_date,
        totalNum: task.total_num,
        status: task.status,
        name: task.name,
        createTime: task.create_time,
        generatedNum,
        weights,
      });
    }

    res.json({ code: 200, data: result });
  } catch (e) {
    console.error('[Task] 获取任务列表失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建任务
router.post('/create', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { weights, ...task } = req.body;
    const id = await createTask(task);
    if (weights && Array.isArray(weights)) {
      await setTaskWeights(id, weights);
    }
    res.json({ code: 200, data: { id }, message: '创建成功' });
  } catch (e) {
    console.error('[Task] 创建任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新任务
router.post('/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id, weights, ...task } = req.body;
    if (!id) return res.json({ code: 400, message: '缺少任务ID' });

    await updateTask(parseInt(id), task);
    if (weights && Array.isArray(weights)) {
      await setTaskWeights(parseInt(id), weights);
    }
    res.json({ code: 200, message: '更新成功' });
  } catch (e) {
    console.error('[Task] 更新任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除任务
router.post('/delete', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.json({ code: 400, message: '缺少任务ID' });

    await deleteTask(parseInt(id));
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    console.error('[Task] 删除任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
