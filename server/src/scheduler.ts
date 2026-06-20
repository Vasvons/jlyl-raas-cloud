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

  // 每3分钟检查一次，实时生成数据（一条一条生成，权重决定生成时机）
  cron.schedule('*/3 * * * *', async () => {
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
    // 任务到期，将所有待收录数据一次性收录
    const pendingResult = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time IS NULL', [task.id]);
    const pendingCount = parseInt(pendingResult.rows[0].count) || 0;
    if (pendingCount > 0) {
      const collected = await repo.collectRecords(task.id, pendingCount);
      console.log(`[Scheduler] 任务 ${task.id} 到期，将 ${collected} 条待收录数据全部收录`);
    }
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已结束（end_date ${task.end_date}），标记为 completed`);
    return `任务已结束（end_date=${task.end_date}），${pendingCount > 0 ? `${pendingCount}条已收录` : '无待收录数据'}`;
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

  // ===== 今日数据：生成与收录分离 =====
  // 1. 数据生成：提前批量生成，create_time=NOW()，query_time=NULL（待收录）
  //    不受每日量限制，只看总进度，数据提前生成等待收录
  // 2. 查询收录：调度器每次运行时，按当前时区权重决定收录多少条待收录数据
  //    query_time = 收录动作触发时间（NOW()），永远不会是未来时间
  // 3. 时区权重决定每次收录的数量，高权重时段收录更多

  const now = new Date();
  const currentHour = now.getHours();
  const currentSlot = Math.floor(currentHour / 3); // 0-7，每3小时一个时段

  // 今日待收录数量（query_time IS NULL）
  const pendingResult = await query(
    'SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time IS NULL',
    [task.id]
  );
  const pendingCount = parseInt(pendingResult.rows[0].count) || 0;

  // 第一步：补充生成数据（保持待收录池充足）
  // 数据提前生成，不受每日量限制，只看总进度和待收录池
  // 每次生成剩余量的1/100，约5小时生成完所有数据，生成速度远快于收录速度
  const remaining = task.total_num - generatedNum;
  const batchSize = Math.max(10, Math.ceil(remaining / 100));
  if (generatedNum < task.total_num && pendingCount < batchSize * 4) {
    const needGenerate = Math.min(batchSize, remaining);
    console.log(`[Scheduler] 任务 ${task.id} 补充生成 ${needGenerate} 条（总进度=${generatedNum}/${task.total_num}, 待收录=${pendingCount}）`);
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
      realtime: true, // create_time=NOW(), query_time=NULL
    });
    generatedToday += needGenerate;
  }

  // 第二步：查询收录动作
  // 时区权重决定本次收录多少条：权重越高，收录越多
  const validHourWeights = hourWeights.filter((w: any) => w.weight > 0);
  const currentSlotWeight = validHourWeights.find((w: any) => w.hour_slot === currentSlot)?.weight || 0;

  // 重新查询待收录数量（可能刚生成了新的）
  const pendingResult2 = await query(
    'SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time IS NULL',
    [task.id]
  );
  const pendingCount2 = parseInt(pendingResult2.rows[0].count) || 0;

  if (currentSlotWeight > 0 && pendingCount2 > 0) {
    // 时区权重决定本次收录多少条：权重越高，收录越多
    // 每个时段应收录总量 = 日总量 * (时段权重 / 总权重)
    // 每次调度收录量 = 时段总量 / 60（每3小时60次调度，每3分钟一次）
    // 一天总收录 = sum(各时段收录) = dailyNum
    const totalWeight = validHourWeights.reduce((sum: number, w: any) => sum + w.weight, 0);
    const slotCollectTotal = totalWeight > 0 ? dailyNum * (currentSlotWeight / totalWeight) : dailyNum / 8;
    const collectCount = Math.max(1, Math.ceil(slotCollectTotal / 60));

    const actualCollect = Math.min(collectCount, pendingCount2);
    console.log(`[Scheduler] 任务 ${task.id} 查询收录 ${actualCollect} 条（时段=${currentSlot}(${currentHour}时), 权重=${currentSlotWeight}, 时段应收录=${slotCollectTotal.toFixed(0)}, 待收录=${pendingCount2}）`);

    const collected = await repo.collectRecords(task.id, actualCollect);
    console.log(`[Scheduler] 任务 ${task.id} 实际收录 ${collected} 条`);
  } else if (currentSlotWeight === 0) {
    console.log(`[Scheduler] 任务 ${task.id} 当前时段权重为0，不收录`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 无待收录数据`);
  }

  // 检查是否完成，并更新 task_progress 表
  const newGeneratedNum = await repo.getTaskGeneratedNum(task.id);
  await repo.updateTaskProgress(task.id, newGeneratedNum);

  // 检查是否还有待收录数据
  const remainingPendingResult = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1 AND query_time IS NULL', [task.id]);
  const remainingPending = parseInt(remainingPendingResult.rows[0].count) || 0;

  if (newGeneratedNum >= task.total_num && remainingPending === 0) {
    // 所有数据已生成且已收录，标记为completed
    await query('UPDATE task_info SET status = $1 WHERE id = $2', ['completed', task.id]);
    console.log(`[Scheduler] 任务 ${task.id} 已完成，共生成 ${newGeneratedNum} 条，全部已收录`);
  } else if (newGeneratedNum >= task.total_num) {
    // 数据已全部生成，但还有待收录数据，保持running继续收录
    console.log(`[Scheduler] 任务 ${task.id} 数据已全部生成（${newGeneratedNum}/${task.total_num}），待收录 ${remainingPending} 条，继续收录中`);
  } else {
    console.log(`[Scheduler] 任务 ${task.id} 总计 ${newGeneratedNum}/${task.total_num}，待收录 ${remainingPending} 条`);
  }

  return `本次生成${generatedToday}条，总进度${newGeneratedNum}/${task.total_num}，待收录${remainingPending}条`;
}
