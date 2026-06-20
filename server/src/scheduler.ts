import cron from 'node-cron';
import { query } from './db';
import * as repo from './repository';

// 记录调度器运行状态
let schedulerStatus = {
  startedAt: new Date(),
  lastGenerateTime: null as Date | null,
  lastGenerateResult: '' as string,
  lastDisplayTime: null as Date | null,
  lastDisplayResult: '' as string,
  totalGenerateRuns: 0,
  totalDisplayRuns: 0,
  timezone: '',
};

// 定时任务调度器
// 两层动作：
// 1. 生成（=收录）：每3分钟，按时区权重和平台权重生成数据，模拟真实搜索行为
//    create_time=NOW()（收录时间），query_time=NULL（等待查询展示）
// 2. 查询（=展示）：每10分钟，将已生成的数据展示到GEO报告
//    query_time=NOW()（查询展示时间），永远不会是未来时间
export function startScheduler() {
  schedulerStatus.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log('[Scheduler] 启动定时任务调度器... 当前时区:', schedulerStatus.timezone);

  // 每3分钟生成数据（=收录），按时区权重和平台权重
  cron.schedule('*/3 * * * *', async () => {
    await runGeneration();
  });

  // 每10分钟查询展示，将已生成的数据展示到GEO报告
  cron.schedule('*/10 * * * *', async () => {
    await runQueryDisplay();
  });
}

// 获取调度器状态（供诊断接口使用）
export function getSchedulerStatus() {
  return {
    ...schedulerStatus,
    startedAt: schedulerStatus.startedAt.toISOString(),
    lastGenerateTime: schedulerStatus.lastGenerateTime ? schedulerStatus.lastGenerateTime.toISOString() : null,
    lastDisplayTime: schedulerStatus.lastDisplayTime ? schedulerStatus.lastDisplayTime.toISOString() : null,
    currentTime: new Date().toISOString(),
  };
}

// ===== 第一层：数据生成（=收录）=====
// 按时区权重和平台权重生成，模拟用户真实搜索行为
export async function runGeneration() {
  schedulerStatus.totalGenerateRuns++;
  schedulerStatus.lastGenerateTime = new Date();
  try {
    const tasks = await query(`SELECT * FROM task_info WHERE status = 'running'`);
    console.log(`[Scheduler][生成] 查询到 ${tasks.rows.length} 个运行中的任务`);

    if (tasks.rows.length === 0) {
      const pausedTasks = await query(`SELECT * FROM task_info WHERE status = 'paused'`);
      const completedTasks = await query(`SELECT * FROM task_info WHERE status = 'completed'`);
      schedulerStatus.lastGenerateResult = `无运行中任务（paused:${pausedTasks.rows.length}, completed:${completedTasks.rows.length}）`;
    } else {
      schedulerStatus.lastGenerateResult = `处理 ${tasks.rows.length} 个任务`;
    }

    for (const task of tasks.rows) {
      try {
        await generateForTask(task);
      } catch (e: any) {
        console.error(`[Scheduler][生成] 任务 ${task.id} 失败:`, e);
        schedulerStatus.lastGenerateResult += `; 任务${task.id}失败: ${e.message}`;
      }
    }
  } catch (e: any) {
    console.error('[Scheduler][生成] 失败:', e);
    schedulerStatus.lastGenerateResult = `错误: ${e.message}`;
  }
}

// ===== 第二层：查询展示 =====
// 每10分钟触发，将已生成的数据（query_time IS NULL）展示到GEO报告
// 查询时间 = 触发时间（NOW()），永远不会是未来时间
export async function runQueryDisplay() {
  schedulerStatus.totalDisplayRuns++;
  schedulerStatus.lastDisplayTime = new Date();
  try {
    // 将所有待展示数据设置为已展示
    const result = await query(
      `UPDATE keyword_search_rank SET query_time = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
       WHERE query_time IS NULL`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[Scheduler][查询] 展示 ${result.rowCount} 条数据到GEO报告`);
      schedulerStatus.lastDisplayResult = `展示 ${result.rowCount} 条`;
    } else {
      schedulerStatus.lastDisplayResult = `无待展示数据`;
    }
  } catch (e: any) {
    console.error('[Scheduler][查询] 展示失败:', e);
    schedulerStatus.lastDisplayResult = `错误: ${e.message}`;
  }
}

// 为单个任务生成数据
export async function generateForTask(task: any): Promise<string> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(task.end_date);
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date(task.start_date);
  startDate.setHours(0, 0, 0, 0);

  console.log(`[Scheduler][生成] 任务 ${task.id}: status=${task.status}, start=${task.start_date}, end=${task.end_date}, total=${task.total_num}, user=${task.user_id}`);

  // 检查任务是否已结束
  if (today > endDate) {
    // 任务到期，标记为completed（待展示数据由查询展示cron处理）
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler][生成] 任务 ${task.id} 已结束，标记为 completed`);
    return `任务已结束，标记为completed`;
  }

  // 获取任务权重
  const weights = await repo.getTaskWeights(task.id);
  if (weights.length === 0) {
    return `任务没有配置平台权重，跳过`;
  }

  // 获取时区权重
  const hourWeights = await repo.getTaskHourWeights(task.id);

  // 获取关键词库
  const zlgjcList = await repo.getZlgjcByUserId(task.user_id, 0);
  if (zlgjcList.length === 0) {
    return `用户${task.user_id}没有蒸馏关键词库，跳过`;
  }
  const brandZlgjcList = await repo.getZlgjcByUserId(task.user_id, 1);
  const ppList = await repo.getPPByUserId(task.user_id);
  const ppNames = ppList.map((p: any) => p.pp);

  // 计算每日生成数量
  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dailyNum = Math.ceil(task.total_num / totalDays);

  // 检查已生成数量
  const generatedNum = await repo.getTaskGeneratedNum(task.id);
  const daysElapsed = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const expectedNum = daysElapsed * dailyNum;

  console.log(`[Scheduler][生成] 任务 ${task.id} 进度: 已生成=${generatedNum}, 预期=${expectedNum}, 每日=${dailyNum}, 总天数=${totalDays}, 已过天数=${daysElapsed}`);

  let generatedToday = 0;

  // 补齐历史数据
  if (generatedNum < expectedNum && daysElapsed > 0) {
    console.log(`[Scheduler][生成] 任务 ${task.id} 需要补齐历史数据，已生成 ${generatedNum}，预期 ${expectedNum}`);

    for (let d = 0; d < daysElapsed; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      const dailyRandomExisting = await query(
        'SELECT id, random_num FROM daily_random WHERE task_id = $1 AND random_date = $2 AND random_num > 0',
        [task.id, dateStr]
      );
      const actualCountResult = await query(
        'SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND create_time::date = $2::date',
        [task.id, dateStr]
      );
      const actualCount = parseInt(actualCountResult.rows[0].count) || 0;

      if (dailyRandomExisting.rows.length > 0 && actualCount >= dailyNum) {
        continue;
      }

      const needGenerate = dailyNum - actualCount;
      console.log(`[Scheduler][生成] 任务 ${task.id} 补齐 ${dateStr}，已有 ${actualCount}，需生成 ${needGenerate}`);
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

  // ===== 今日数据生成（=收录）=====
  // 按时区权重和平台权重生成，模拟真实搜索行为
  // create_time=NOW()（收录时间），query_time=NULL（等待查询展示）

  const now = new Date();
  const currentHour = now.getHours();
  const currentSlot = Math.floor(currentHour / 3); // 0-7，每3小时一个时段

  const validHourWeights = hourWeights.filter((w: any) => w.weight > 0);
  const currentSlotWeight = validHourWeights.find((w: any) => w.hour_slot === currentSlot)?.weight || 0;

  // 当前时段权重为0，不生成数据（模拟无搜索行为）
  if (currentSlotWeight === 0) {
    console.log(`[Scheduler][生成] 任务 ${task.id} 当前时段(${currentSlot})权重为0，不生成`);
    await repo.updateTaskProgress(task.id, generatedNum);
    return `当前时段权重为0，不生成`;
  }

  // 检查总进度
  if (generatedNum >= task.total_num) {
    // 数据已全部生成，保持running等待查询展示
    console.log(`[Scheduler][生成] 任务 ${task.id} 数据已全部生成（${generatedNum}/${task.total_num}），等待查询展示`);
    await repo.updateTaskProgress(task.id, generatedNum);
    return `数据已全部生成，等待查询展示`;
  }

  // 按时区权重计算生成数量
  // 每天应生成 = dailyNum
  // 每个时段应生成 = dailyNum * (时段权重 / 总权重)
  // 每次调度生成 = 时段应生成 / 60（每3小时60次调度，每3分钟一次）
  const totalWeight = validHourWeights.reduce((sum: number, w: any) => sum + w.weight, 0);
  const slotGenerateTotal = totalWeight > 0 ? dailyNum * (currentSlotWeight / totalWeight) : dailyNum / 8;
  const generateCount = Math.max(1, Math.ceil(slotGenerateTotal / 60));

  const remaining = task.total_num - generatedNum;
  const actualGenerate = Math.min(generateCount, remaining);

  console.log(`[Scheduler][生成] 任务 ${task.id} 生成 ${actualGenerate} 条（时段=${currentSlot}(${currentHour}时), 权重=${currentSlotWeight}, 时段应生成=${slotGenerateTotal.toFixed(0)}, 总进度=${generatedNum}/${task.total_num}）`);

  await repo.generateBatch({
    userId: task.user_id,
    taskId: task.id,
    count: actualGenerate,
    weights,
    zlgjcList,
    brandZlgjcList,
    ppList: ppNames,
    targetDate: today,
    hourWeights,
    realtime: true, // create_time=NOW(), query_time=NULL（等待查询展示）
  });
  generatedToday += actualGenerate;

  // 更新进度
  const newGeneratedNum = await repo.getTaskGeneratedNum(task.id);
  await repo.updateTaskProgress(task.id, newGeneratedNum);

  // 检查是否还有待展示数据
  const pendingResult = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time IS NULL', [task.id]);
  const pendingCount = parseInt(pendingResult.rows[0].count) || 0;

  console.log(`[Scheduler][生成] 任务 ${task.id} 总进度 ${newGeneratedNum}/${task.total_num}，待展示 ${pendingCount} 条`);

  return `本次生成${generatedToday}条，总进度${newGeneratedNum}/${task.total_num}，待展示${pendingCount}条`;
}
