import cron from 'node-cron';
import { query } from './db';
import * as repo from './repository';

// 定时任务：每天凌晨 2:00 执行数据生成
export function startScheduler() {
  console.log('[Scheduler] 启动定时任务调度器... 当前时区:', Intl.DateTimeFormat().resolvedOptions().timeZone);

  // 每天 02:00 执行（北京时间）
  cron.schedule('0 2 * * *', async () => {
    console.log('[Scheduler] 开始执行每日数据生成任务...');
    await runDailyGeneration();
  });

  // 每10分钟检查一次是否有遗漏的任务（容错，提高生成及时性）
  cron.schedule('*/10 * * * *', async () => {
    await runDailyGeneration();
  });
}

async function runDailyGeneration() {
  try {
    // 获取所有运行中的任务
    const tasks = await query(
      `SELECT * FROM task_info WHERE status = 'running'`
    );
    console.log(`[Scheduler] 查询到 ${tasks.rows.length} 个运行中的任务`);

    if (tasks.rows.length === 0) {
      // 没有运行中的任务，检查是否有 paused 状态但仍在日期范围内的任务（容错）
      const pausedTasks = await query(
        `SELECT * FROM task_info WHERE status = 'paused'`
      );
      console.log(`[Scheduler] 另有 ${pausedTasks.rows.length} 个已暂停的任务`);
    }

    for (const task of tasks.rows) {
      try {
        await generateForTask(task);
      } catch (e) {
        console.error(`[Scheduler] 任务 ${task.id} 生成失败:`, e);
      }
    }
  } catch (e) {
    console.error('[Scheduler] 每日生成失败:', e);
  }
}

async function generateForTask(task: any) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(task.end_date);
  endDate.setHours(0, 0, 0, 0);

  // 检查任务是否已结束
  if (today > endDate) {
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已完成`);
    return;
  }

  // 获取任务权重
  const weights = await repo.getTaskWeights(task.id);
  if (weights.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有配置权重，跳过`);
    return;
  }

  // 获取时区权重
  const hourWeights = await repo.getTaskHourWeights(task.id);
  console.log(`[Scheduler] 任务 ${task.id} 时区权重配置: ${hourWeights.length > 0 ? '已配置' : '默认均匀'}`);

  // 获取关键词库（蒸馏关键词 keyword_type=0）
  const zlgjcList = await repo.getZlgjcByUserId(task.user_id, 0);
  if (zlgjcList.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有蒸馏关键词库，跳过`);
    return;
  }

  // 获取品牌关键词库（keyword_type=1）
  const brandZlgjcList = await repo.getZlgjcByUserId(task.user_id, 1);
  console.log(`[Scheduler] 任务 ${task.id} 蒸馏关键词 ${zlgjcList.length} 条，品牌关键词 ${brandZlgjcList.length} 条`);

  // 获取品牌词
  const ppList = await repo.getPPByUserId(task.user_id);
  const ppNames = ppList.map((p: any) => p.pp);

  // 计算每日生成数量
  const startDate = new Date(task.start_date);
  startDate.setHours(0, 0, 0, 0);

  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dailyNum = Math.ceil(task.total_num / totalDays);

  // 检查已生成数量，决定是否需要补齐历史数据
  const generatedNum = await repo.getTaskGeneratedNum(task.id);
  const daysElapsed = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const expectedNum = daysElapsed * dailyNum;

  if (generatedNum < expectedNum && daysElapsed > 0) {
    // 需要补齐历史数据：从开始日期到昨天，逐天检查并补齐缺失的天
    console.log(`[Scheduler] 任务 ${task.id} 需要补齐历史数据，已生成 ${generatedNum}，预期 ${expectedNum}`);

    for (let d = 0; d < daysElapsed; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      // 使用本地时间格式化日期，避免 toISOString() 的 UTC 偏移问题
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      // 检查该天是否已生成
      const existing = await query(
        'SELECT id FROM daily_random WHERE task_id = $1 AND random_date = $2 AND random_num > 0',
        [task.id, dateStr]
      );
      if (existing.rows.length > 0) {
        continue; // 该天已生成，跳过
      }

      console.log(`[Scheduler] 任务 ${task.id} 补齐 ${dateStr} 的数据，数量 ${dailyNum}`);
      await repo.generateBatch({
        userId: task.user_id,
        taskId: task.id,
        count: dailyNum,
        weights,
        zlgjcList,
        brandZlgjcList,
        ppList: ppNames,
        targetDate: date,
        hourWeights,
      });

      await repo.setDailyRandom(task.id, date, dailyNum);
    }
  }

  // 生成今天的数据
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const todayExisting = await query(
    'SELECT id FROM daily_random WHERE task_id = $1 AND random_date = $2 AND random_num > 0',
    [task.id, todayStr]
  );
  if (todayExisting.rows.length === 0) {
    await repo.generateBatch({
      userId: task.user_id,
      taskId: task.id,
      count: dailyNum,
      weights,
      zlgjcList,
      brandZlgjcList,
      ppList: ppNames,
      targetDate: today,
      hourWeights,
    });

    await repo.setDailyRandom(task.id, today, dailyNum);
    console.log(`[Scheduler] 任务 ${task.id} 今日生成 ${dailyNum} 条`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 今天已生成，跳过`);
  }

  // 检查是否完成
  const newGeneratedNum = await repo.getTaskGeneratedNum(task.id);
  if (newGeneratedNum >= task.total_num) {
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已完成，共生成 ${newGeneratedNum} 条`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 总计 ${newGeneratedNum}/${task.total_num}`);
  }
}
