import cron from 'node-cron';
import { query } from './db';
import * as repo from './repository';

// 定时任务：每天凌晨 2:00 执行数据生成
export function startScheduler() {
  console.log('[Scheduler] 启动定时任务调度器...');

  // 每天 02:00 执行
  cron.schedule('0 2 * * *', async () => {
    console.log('[Scheduler] 开始执行每日数据生成任务...');
    await runDailyGeneration();
  });

  // 每小时检查一次是否有遗漏的任务（容错）
  cron.schedule('0 * * * *', async () => {
    await runDailyGeneration();
  });
}

async function runDailyGeneration() {
  try {
    // 获取所有运行中的任务
    const tasks = await query(
      `SELECT * FROM task_info WHERE status = 'running'`
    );

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

  // 检查今天是否已生成
  const todayStr = today.toISOString().split('T')[0];
  const existing = await query(
    'SELECT id FROM daily_random WHERE task_id = $1 AND random_date = $2 AND random_num > 0',
    [task.id, todayStr]
  );
  if (existing.rows.length > 0) {
    console.log(`[Scheduler] 任务 ${task.id} 今天已生成，跳过`);
    return;
  }

  // 获取任务权重
  const weights = await repo.getTaskWeights(task.id);
  if (weights.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有配置权重，跳过`);
    return;
  }

  // 获取关键词库
  const zlgjcList = await repo.getZlgjcByUserId(task.user_id);
  if (zlgjcList.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有关键词库，跳过`);
    return;
  }

  // 获取品牌关键词
  const ppList = await repo.getPPByUserId(task.user_id);
  const ppNames = ppList.map((p: any) => p.pp);

  // 计算每日生成数量
  const startDate = new Date(task.start_date);
  startDate.setHours(0, 0, 0, 0);

  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dailyNum = Math.ceil(task.total_num / totalDays);

  // 检查是否需要补齐历史数据
  const generatedNum = await repo.getTaskGeneratedNum(task.id);
  const expectedNum = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) * dailyNum;

  if (generatedNum < expectedNum) {
    // 补齐历史数据
    const backlogDays = Math.floor((expectedNum - generatedNum) / dailyNum);
    console.log(`[Scheduler] 任务 ${task.id} 需要补齐 ${backlogDays} 天的历史数据`);

    for (let d = 0; d < backlogDays; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      if (date >= today) break;

      await repo.generateBatch({
        userId: task.user_id,
        taskId: task.id,
        count: dailyNum,
        weights,
        zlgjcList,
        ppList: ppNames,
        targetDate: date,
      });

      await repo.setDailyRandom(task.id, date, dailyNum);
    }
  }

  // 生成今天的数据
  await repo.generateBatch({
    userId: task.user_id,
    taskId: task.id,
    count: dailyNum,
    weights,
    zlgjcList,
    ppList: ppNames,
    targetDate: today,
  });

  await repo.setDailyRandom(task.id, today, dailyNum);

  // 检查是否完成
  const newGeneratedNum = await repo.getTaskGeneratedNum(task.id);
  if (newGeneratedNum >= task.total_num) {
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已完成，共生成 ${newGeneratedNum} 条`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 今日生成 ${dailyNum} 条，总计 ${newGeneratedNum}/${task.total_num}`);
  }
}
