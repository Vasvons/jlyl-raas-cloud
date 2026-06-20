import cron from 'node-cron';
import { query } from './db';
import * as repo from './repository';

// 记录调度器运行状态
let schedulerStatus = {
  startedAt: new Date(),
  lastRunTime: null as Date | null,
  lastRunResult: '' as string,
  totalRuns: 0,
  timezone: '',
};

// 定时任务：每天凌晨 2:00 执行数据生成
export function startScheduler() {
  schedulerStatus.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log('[Scheduler] 启动定时任务调度器... 当前时区:', schedulerStatus.timezone);

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

// 获取调度器状态（供诊断接口使用）
export function getSchedulerStatus() {
  return {
    ...schedulerStatus,
    startedAt: schedulerStatus.startedAt.toISOString(),
    lastRunTime: schedulerStatus.lastRunTime ? schedulerStatus.lastRunTime.toISOString() : null,
    currentTime: new Date().toISOString(),
  };
}

export async function runDailyGeneration() {
  schedulerStatus.totalRuns++;
  schedulerStatus.lastRunTime = new Date();
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
      const completedTasks = await query(
        `SELECT * FROM task_info WHERE status = 'completed'`
      );
      console.log(`[Scheduler] 另有 ${pausedTasks.rows.length} 个已暂停的任务, ${completedTasks.rows.length} 个已完成的任务`);
      schedulerStatus.lastRunResult = `无运行中任务（paused:${pausedTasks.rows.length}, completed:${completedTasks.rows.length}）`;
    } else {
      schedulerStatus.lastRunResult = `处理 ${tasks.rows.length} 个任务`;
    }

    for (const task of tasks.rows) {
      try {
        await generateForTask(task);
      } catch (e: any) {
        console.error(`[Scheduler] 任务 ${task.id} 生成失败:`, e);
        schedulerStatus.lastRunResult += `; 任务${task.id}失败: ${e.message}`;
      }
    }
  } catch (e: any) {
    console.error('[Scheduler] 每日生成失败:', e);
    schedulerStatus.lastRunResult = `错误: ${e.message}`;
  }
}

export async function generateForTask(task: any): Promise<string> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(task.end_date);
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date(task.start_date);
  startDate.setHours(0, 0, 0, 0);

  console.log(`[Scheduler] 任务 ${task.id} 诊断: status=${task.status}, start=${task.start_date}, end=${task.end_date}, total=${task.total_num}, user=${task.user_id}, today=${today.toISOString().split('T')[0]}`);

  // 检查任务是否已结束
  if (today > endDate) {
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已结束（end_date ${task.end_date} 早于今天），标记为 completed`);
    return `任务已结束（end_date=${task.end_date}），已标记为completed`;
  }

  // 获取任务权重
  const weights = await repo.getTaskWeights(task.id);
  if (weights.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有配置权重，跳过`);
    return `任务没有配置平台权重，跳过生成`;
  }

  // 获取时区权重
  const hourWeights = await repo.getTaskHourWeights(task.id);
  console.log(`[Scheduler] 任务 ${task.id} 时区权重配置: ${hourWeights.length > 0 ? '已配置' : '默认均匀'}`);

  // 获取关键词库（蒸馏关键词 keyword_type=0）
  const zlgjcList = await repo.getZlgjcByUserId(task.user_id, 0);
  if (zlgjcList.length === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 没有蒸馏关键词库（user_id=${task.user_id}, keyword_type=0），跳过`);
    return `用户${task.user_id}没有蒸馏关键词库，跳过生成`;
  }

  // 获取品牌关键词库（keyword_type=1）
  const brandZlgjcList = await repo.getZlgjcByUserId(task.user_id, 1);
  console.log(`[Scheduler] 任务 ${task.id} 蒸馏关键词 ${zlgjcList.length} 条，品牌关键词 ${brandZlgjcList.length} 条`);

  // 获取品牌词
  const ppList = await repo.getPPByUserId(task.user_id);
  const ppNames = ppList.map((p: any) => p.pp);

  // 计算每日生成数量
  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dailyNum = Math.ceil(task.total_num / totalDays);

  // 检查已生成数量，决定是否需要补齐历史数据
  const generatedNum = await repo.getTaskGeneratedNum(task.id);
  const daysElapsed = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const expectedNum = daysElapsed * dailyNum;

  console.log(`[Scheduler] 任务 ${task.id} 进度: 已生成=${generatedNum}, 预期=${expectedNum}, 每日=${dailyNum}, 总天数=${totalDays}, 已过天数=${daysElapsed}`);

  // 修正今日已有数据：将今日记录的 query_time 同步为 create_time
  // 因为今日数据应该是实时生成的，query_time = create_time = 实际生成时间
  const fixResult = await query(
    `UPDATE keyword_search_rank SET query_time = create_time
     WHERE task_id = $1 AND create_time::date = CURRENT_DATE AND query_time != create_time`,
    [task.id]
  );
  if (fixResult.rowCount && fixResult.rowCount > 0) {
    console.log(`[Scheduler] 任务 ${task.id} 修正今日 ${fixResult.rowCount} 条记录的 query_time 为 create_time`);
  }

  let generatedToday = 0;

  if (generatedNum < expectedNum && daysElapsed > 0) {
    // 需要补齐历史数据：从开始日期到昨天，逐天检查并补齐缺失的天
    // query_time = 目标日期 + 时区权重随机时间，模拟那一天24小时内的查询动作
    console.log(`[Scheduler] 任务 ${task.id} 需要补齐历史数据，已生成 ${generatedNum}，预期 ${expectedNum}`);

    for (let d = 0; d < daysElapsed; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      // 使用本地时间格式化日期，避免 toISOString() 的 UTC 偏移问题
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      // 同时检查 daily_random 和 keyword_search_rank 实际记录数
      // 避免 daily_random 有记录但 keyword_search_rank 实际没数据导致永远跳过的问题
      const dailyRandomExisting = await query(
        'SELECT id, random_num FROM daily_random WHERE task_id = $1 AND random_date = $2 AND random_num > 0',
        [task.id, dateStr]
      );
      const actualCountResult = await query(
        'SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time::date = $2::date',
        [task.id, dateStr]
      );
      const actualCount = parseInt(actualCountResult.rows[0].count) || 0;

      if (dailyRandomExisting.rows.length > 0 && actualCount >= dailyNum) {
        continue; // 该天已生成且实际记录数足够，跳过
      }

      const needGenerate = dailyNum - actualCount;
      console.log(`[Scheduler] 任务 ${task.id} 补齐 ${dateStr} 的数据，已有 ${actualCount}，需生成 ${needGenerate}`);
      await repo.generateBatch({
        userId: task.user_id,
        taskId: task.id,
        count: needGenerate,
        weights,
        zlgjcList,
        brandZlgjcList,
        ppList: ppNames,
        targetDate: date,
        hourWeights,
      });

      await repo.setDailyRandom(task.id, date, dailyNum);
      generatedToday += needGenerate;
    }
  }

  // 生成今天的数据（实时生成：query_time = create_time = NOW()）
  // 权重决定数据生成的密集度：高权重时段更密集地生成，而不是一次性生成全天的量
  // 每次调度只生成一小批，让数据在一天中持续产生
  const now = new Date();
  const currentHour = now.getHours();
  const currentSlot = Math.floor(currentHour / 3); // 0-7，每3小时一个时段

  // 计算当前时段的权重和所有时段权重总和
  const validHourWeights = hourWeights.filter((w: any) => w.weight > 0);
  const totalWeight = validHourWeights.reduce((sum: number, w: any) => sum + w.weight, 0);
  const currentSlotWeight = validHourWeights.find((w: any) => w.hour_slot === currentSlot)?.weight || 0;

  // 今日已生成数量（用 create_time 统计，因为实时生成时 query_time = create_time）
  const todayActualCountResult = await query(
    'SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND create_time::date = CURRENT_DATE',
    [task.id]
  );
  const todayActualCount = parseInt(todayActualCountResult.rows[0].count) || 0;

  // 今日预期生成数量 = dailyNum * (已过时段权重 / 总权重)
  // 已过时段包括当前时段（因为当前时段正在生成中）
  let elapsedWeight = 0;
  for (const w of validHourWeights) {
    if (w.hour_slot <= currentSlot) {
      elapsedWeight += w.weight;
    }
  }
  const expectedTodayByNow = totalWeight > 0 ? Math.ceil(dailyNum * elapsedWeight / totalWeight) : dailyNum;

  console.log(`[Scheduler] 任务 ${task.id} 今日进度: 已生成=${todayActualCount}, 当前时段预期=${expectedTodayByNow}, 当前时段权重=${currentSlotWeight}/${totalWeight}, 当前时段=${currentSlot}(${currentHour}时)`);

  // 只有当前时段权重 > 0 时才生成
  if (currentSlotWeight > 0 && todayActualCount < expectedTodayByNow) {
    // 本次需要生成的数量 = 预期数量 - 已生成数量
    const needGenerate = Math.max(1, expectedTodayByNow - todayActualCount);
    console.log(`[Scheduler] 任务 ${task.id} 实时生成 ${needGenerate} 条（当前时段权重=${currentSlotWeight}）`);
    await repo.generateBatch({
      userId: task.user_id,
      taskId: task.id,
      count: needGenerate,
      weights,
      zlgjcList,
      brandZlgjcList,
      ppList: ppNames,
      targetDate: today,
      hourWeights,
      realtime: true, // 当下实时生成，query_time=create_time=NOW()
    });
    generatedToday += needGenerate;
    console.log(`[Scheduler] 任务 ${task.id} 本次实时生成 ${needGenerate} 条`);
  } else if (currentSlotWeight === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 当前时段权重为0，跳过生成`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 今日已生成 ${todayActualCount} 条，达到当前时段预期 ${expectedTodayByNow}，等待下一个时段`);
  }

  // 检查是否完成，并更新 task_progress 表
  const newGeneratedNum = await repo.getTaskGeneratedNum(task.id);
  await repo.updateTaskProgress(task.id, newGeneratedNum);
  if (newGeneratedNum >= task.total_num) {
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已完成，共生成 ${newGeneratedNum} 条`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 总计 ${newGeneratedNum}/${task.total_num}`);
  }

  return `本次生成${generatedToday}条，总进度${newGeneratedNum}/${task.total_num}`;
}
