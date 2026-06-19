import { Router } from 'express';
import {
  getAllTasks,
  createTask,
  updateTask,
  deleteTask,
  getTaskWeights,
  setTaskWeights,
  getTaskHourWeights,
  setTaskHourWeights,
  getTaskGeneratedNum,
  updateTaskStatus,
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
      const hourWeights = await getTaskHourWeights(task.id);
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
        platformWeights: weights,
        hourWeights,
      });
    }

    res.json({ code: 200, data: result });
  } catch (e) {
    console.error('[Task] 获取任务列表失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建任务（兼容桌面端 POST /task/rw）
router.post('/rw', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, count, startAt, endAt, name, platformWeights, hourWeights } = req.body;
    const id = Date.now(); // 使用时间戳作为任务ID
    await createTask({
      id,
      userId,
      startDate: startAt,
      endDate: endAt,
      totalNum: count,
      status: 'running',
      name: name || '',
    });
    if (platformWeights && Array.isArray(platformWeights)) {
      await setTaskWeights(id, platformWeights);
    }
    if (hourWeights && Array.isArray(hourWeights)) {
      await setTaskHourWeights(id, hourWeights);
    }
    res.json({ code: 200, data: { id }, message: '创建成功' });
  } catch (e) {
    console.error('[Task] 创建任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建任务（云端原始接口，保留兼容）
router.post('/create', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { weights, ...task } = req.body;
    const id = task.id || Date.now();
    await createTask({ ...task, id });
    if (weights && Array.isArray(weights)) {
      await setTaskWeights(id, weights);
    }
    res.json({ code: 200, data: { id }, message: '创建成功' });
  } catch (e) {
    console.error('[Task] 创建任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新任务（兼容桌面端参数格式）
router.post('/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { taskId, userId, count, startAt, endAt, name, platformWeights, hourWeights, id, weights } = req.body;
    const taskIdNum = parseInt(taskId || id);
    if (!taskIdNum) return res.json({ code: 400, message: '缺少任务ID' });

    // 兼容桌面端和云端两种参数格式
    const taskData: any = {
      userId: userId,
      startDate: startAt,
      endDate: endAt,
      totalNum: count,
      name: name || '',
    };
    // 如果有云端格式的参数，也兼容
    if (id) taskData.id = id;
    if (weights) taskData.weights = weights;

    await updateTask(taskIdNum, taskData);
    const w = platformWeights || weights;
    if (w && Array.isArray(w)) {
      await setTaskWeights(taskIdNum, w);
    }
    if (hourWeights && Array.isArray(hourWeights)) {
      await setTaskHourWeights(taskIdNum, hourWeights);
    }

    // 返回已生成数量和剩余数量
    const alreadyGenerated = await getTaskGeneratedNum(taskIdNum);
    const remaining = Math.max(0, (count || 0) - alreadyGenerated);

    res.json({ code: 200, data: { alreadyGenerated, remaining }, message: '更新成功' });
  } catch (e) {
    console.error('[Task] 更新任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新任务状态（暂停/恢复/完成）
router.post('/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { taskId, status } = req.body;
    if (!taskId || !status) return res.json({ code: 400, message: '缺少 taskId 或 status' });

    await updateTaskStatus(parseInt(taskId), status);
    res.json({ code: 200, message: '状态更新成功' });
  } catch (e) {
    console.error('[Task] 更新任务状态失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除任务（兼容桌面端 DELETE /task/delete/:id）
router.delete('/delete/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.json({ code: 400, message: '缺少任务ID' });

    await deleteTask(id);
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    console.error('[Task] 删除任务失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除任务（POST 方式，保留兼容）
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

// 保存平台权重（独立接口）
router.post('/weights', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { taskId, weights } = req.body;
    if (!taskId) return res.json({ code: 400, message: '缺少 taskId' });
    if (weights && Array.isArray(weights)) {
      await setTaskWeights(parseInt(taskId), weights);
    }
    res.json({ code: 200, message: '保存成功' });
  } catch (e) {
    console.error('[Task] 保存平台权重失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存时区权重
router.post('/hourWeights', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { taskId, weights } = req.body;
    if (!taskId) return res.json({ code: 400, message: '缺少 taskId' });
    if (weights && Array.isArray(weights)) {
      await setTaskHourWeights(parseInt(taskId), weights);
    }
    res.json({ code: 200, message: '保存成功' });
  } catch (e) {
    console.error('[Task] 保存时区权重失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
