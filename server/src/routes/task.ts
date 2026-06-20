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
import { runDailyGeneration, generateForTask, getSchedulerStatus } from '../scheduler';
import { query } from '../db';

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

    console.log(`[Task] 更新任务 ${taskIdNum}: count=${count}, startAt=${startAt}, endAt=${endAt}, name=${name}`);

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

    // 验证更新结果
    const verifyResult = await query('SELECT total_num, start_date, end_date FROM task_info WHERE id = $1', [taskIdNum]);
    if (verifyResult.rows.length > 0) {
      console.log(`[Task] 更新后验证: total_num=${verifyResult.rows[0].total_num}, start=${verifyResult.rows[0].start_date}, end=${verifyResult.rows[0].end_date}`);
    }

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

    res.json({ code: 200, data: { alreadyGenerated, remaining, totalNum: count }, message: '更新成功' });
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

// 复制任务
router.post('/copy', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.json({ code: 400, message: '缺少 taskId' });

    const tasks = await getAllTasks('all');
    // 注意：PostgreSQL BIGINT 返回的是字符串，需要用 String() 统一类型比较
    const original = tasks.find((t: any) => String(t.id) === String(taskId));
    if (!original) return res.json({ code: 404, message: '原任务不存在' });

    const newId = Date.now();
    await createTask({
      id: newId,
      userId: original.user_id,
      startDate: original.start_date,
      endDate: original.end_date,
      totalNum: original.total_num,
      status: 'paused',
      name: (original.name || '') + ' (副本)',
    });

    // 复制平台权重
    const weights = await getTaskWeights(parseInt(taskId));
    if (weights.length > 0) {
      await setTaskWeights(newId, weights);
    }
    // 复制时区权重
    const hourWeights = await getTaskHourWeights(parseInt(taskId));
    if (hourWeights.length > 0) {
      await setTaskHourWeights(newId, hourWeights);
    }

    res.json({ code: 200, data: { id: newId }, message: '复制成功' });
  } catch (e: any) {
    console.error('[Task] 复制任务失败:', e);
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

// 诊断接口：获取调度器状态和所有任务概览
router.get('/diagnose', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const schedulerStatus = getSchedulerStatus();

    // 获取所有任务的状态
    const tasksResult = await query(`
      SELECT t.id, t.name, t.user_id, t.start_date, t.end_date, t.total_num, t.status, t.create_time,
             COALESCE(p.generated_num, 0) as generated_num,
             u.username as user_name
      FROM task_info t
      LEFT JOIN task_progress p ON p.task_id = t.id
      LEFT JOIN users u ON t.user_id = u.id::text
      ORDER BY t.id DESC
    `);

    const tasks = [];
    for (const task of tasksResult.rows) {
      const weights = await getTaskWeights(task.id);
      const hourWeights = await getTaskHourWeights(task.id);

      // 检查关键词库
      const zlgjcCount = await query('SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1 AND keyword_type = 0', [task.user_id]);
      const brandZlgjcCount = await query('SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1 AND keyword_type = 1', [task.user_id]);

      // 检查 daily_random 记录
      const dailyRandomRecords = await query(
        'SELECT random_date, random_num FROM daily_random WHERE task_id = $1 AND random_num > 0 ORDER BY random_date DESC LIMIT 5',
        [task.id]
      );

      // 检查最近的 keyword_search_rank 记录
      const latestRecord = await query(
        'SELECT create_time, query_time FROM keyword_search_rank WHERE task_id = $1 ORDER BY create_time DESC LIMIT 1',
        [task.id]
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(task.end_date);
      endDate.setHours(0, 0, 0, 0);
      const startDate = new Date(task.start_date);
      startDate.setHours(0, 0, 0, 0);

      tasks.push({
        id: task.id,
        name: task.name,
        userId: task.user_id,
        userName: task.user_name,
        startDate: task.start_date,
        endDate: task.end_date,
        totalNum: task.total_num,
        status: task.status,
        generatedNum: parseInt(task.generated_num) || 0,
        createTime: task.create_time,
        platformWeights: weights,
        hourWeights,
        zlgjcCount: parseInt(zlgjcCount.rows[0].count) || 0,
        brandZlgjcCount: parseInt(brandZlgjcCount.rows[0].count) || 0,
        dailyRandomRecords: dailyRandomRecords.rows,
        latestRecord: latestRecord.rows[0] || null,
        isExpired: today > endDate,
        daysElapsed: Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)),
        totalDays: Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1,
      });
    }

    res.json({
      code: 200,
      data: {
        scheduler: schedulerStatus,
        tasks,
      },
    });
  } catch (e: any) {
    console.error('[Task] 诊断失败:', e);
    res.json({ code: 500, message: '诊断失败: ' + e.message });
  }
});

// 手动触发单个任务生成
router.post('/trigger/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    if (!taskId) return res.json({ code: 400, message: '缺少任务ID' });

    const taskResult = await query('SELECT * FROM task_info WHERE id = $1', [taskId]);
    if (taskResult.rows.length === 0) {
      return res.json({ code: 404, message: '任务不存在' });
    }

    const task = taskResult.rows[0];
    console.log(`[Task] 手动触发任务 ${taskId}`);

    const result = await generateForTask(task);

    res.json({ code: 200, data: { result }, message: '触发完成' });
  } catch (e: any) {
    console.error('[Task] 手动触发失败:', e);
    res.json({ code: 500, message: '触发失败: ' + e.message });
  }
});

// 手动触发所有任务生成
router.post('/trigger-all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    console.log('[Task] 手动触发所有任务生成');
    await runDailyGeneration();
    res.json({ code: 200, message: '触发完成' });
  } catch (e: any) {
    console.error('[Task] 手动触发所有任务失败:', e);
    res.json({ code: 500, message: '触发失败: ' + e.message });
  }
});

export default router;
