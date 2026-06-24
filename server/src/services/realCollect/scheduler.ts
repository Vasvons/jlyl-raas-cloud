/**
 * 循环调度器：任务24/7持续循环执行
 * - 服务器启动时：恢复中断的任务，为无pending分片的active任务启动新一轮
 * - 每30秒检查：哪些任务当前轮次已完成(100%)，触发AEO分析并启动新一轮
 * - 多任务严格轮询：由 dequeue 的 SQL 保证（按 task 最近消费时间轮询）
 */
import cron from 'node-cron';
import {
  getDueRealCollectTasks,
  updateTaskRunStatus,
  getDistillateKeywords,
  getBrandKeywords,
  resetDailyAuthCounters,
  getAuthsForRenewal,
  cleanOldWorkerLogs,
  cleanOldRealCollectRecords,
  resetRunningQueueOnRestart,
  getTasksNeedingNewRound,
  isTaskRoundComplete,
  startNewRound,
  getTaskRoundStartTime,
  cleanOversizedPendingShards,
} from '../../repository';
import { generateAeoFullReport } from '../aeo/analyzer';

let schedulerStarted = false;
let loopTimer: ReturnType<typeof setInterval> | null = null;

/** 默认单个队列任务最大关键词数量（用户可在任务配置中自定义 shard_size） */
const DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK = 50;

/**
 * 服务器重启时恢复：
 * 1. 将所有 running 状态的队列任务重置为 pending（Worker可能已死）
 * 2. 为无 pending 分片的 active 任务启动新一轮
 */
async function recoverOnRestart(): Promise<void> {
  try {
    // 1. 恢复中断的队列任务
    const resetCount = await resetRunningQueueOnRestart();
    if (resetCount > 0) {
      console.log(`[RealCollect] 重启恢复：${resetCount} 个中断的队列任务已重置为 pending`);
    }

    // 2. 清理旧的、未分片的 pending 队列项（分片机制生效前入队的巨型队列项）
    const affectedTaskIds = await cleanOversizedPendingShards();
    if (affectedTaskIds.length > 0) {
      console.log(`[RealCollect] 已清理过大的 pending 队列项，涉及任务: ${affectedTaskIds.join(', ')}`);
    }

    // 3. 为无 pending 分片的 active 任务启动新一轮
    const tasks = await getTasksNeedingNewRound();
    for (const task of tasks) {
      await startNewRoundForTask(task);
    }
    console.log(`[RealCollect] 重启恢复完成，${tasks.length} 个任务已启动新一轮`);
  } catch (e: any) {
    console.error('[RealCollect] 重启恢复失败:', e.message);
  }
}

/**
 * 为任务启动新一轮
 */
async function startNewRoundForTask(task: any): Promise<void> {
  try {
    // 获取全量关键词（循环模式：每轮都查全量，不再分片轮询）
    const keywords = task.keyword_type === 1
      ? await getBrandKeywords(task.user_id)
      : await getDistillateKeywords(task.user_id);

    if (keywords.length === 0) {
      console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 无关键词，跳过`);
      return;
    }

    const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
    const result = await startNewRound(task.id, keywords, shardSize, 0);
    // 标记任务为 running 状态并记录开始时间
    // updateTaskRunStatus 中 startTime 会更新 last_run_time 字段，status 会更新 last_run_status 字段
    await updateTaskRunStatus(task.id, { status: 'running', startTime: new Date() });
    console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 启动第 ${result.roundNo} 轮: ${result.shardCount} 个分片, ${keywords.length} 个关键词`);
  } catch (e: any) {
    console.error(`[RealCollect] 任务 ${task.id} 启动新一轮失败:`, e.message);
  }
}

/**
 * 循环检查：检测已完成的轮次，触发AEO分析并启动下一轮
 * 加 isRunning 保护防止重叠执行导致重复入队
 */
let checkCompletedRunning = false;
async function checkCompletedRounds(): Promise<void> {
  if (checkCompletedRunning) {
    console.log('[RealCollect] 上一次 checkCompletedRounds 仍在执行，跳过本次');
    return;
  }
  checkCompletedRunning = true;
  try {
    // 获取所有 active 任务
    const tasks = await getDueRealCollectTasks();

    for (const task of tasks) {
      try {
        // 检查当前轮次是否完成
        const isComplete = await isTaskRoundComplete(task.id);
        if (!isComplete) continue;

        // 轮次完成，触发AEO分析
        try {
          const roundStartTime = await getTaskRoundStartTime(task.id);
          if (roundStartTime) {
            console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 第 ${task.round_no} 轮完成，触发AEO分析`);
            // 标记任务为 success 状态并记录结束时间
            await updateTaskRunStatus(task.id, { status: 'success', endTime: new Date() });
            // 异步触发AEO分析，不阻塞下一轮入队
            generateAeoFullReport(task.id, task.user_id, task.round_no, roundStartTime, new Date())
              .then(reportId => {
                if (reportId) {
                  console.log(`[RealCollect] 任务 ${task.id} AEO轮次报告已生成: reportId=${reportId}`);
                }
              })
              .catch(e => {
                console.error(`[RealCollect] 任务 ${task.id} AEO分析失败:`, e.message);
              });
          }
        } catch (e: any) {
          console.error(`[RealCollect] 任务 ${task.id} AEO触发失败:`, e.message);
        }

        // 启动新一轮
        await startNewRoundForTask(task);
      } catch (e: any) {
        console.error(`[RealCollect] 任务 ${task.id} 轮次检查失败:`, e.message);
      }
    }
  } catch (e: any) {
    console.error('[RealCollect] 循环检查失败:', e.message);
  } finally {
    checkCompletedRunning = false;
  }
}

/**
 * 立即将任务放入队列（用于手动触发"立即执行"）
 * 手动触发会中断当前轮次的剩余分片，重新开始新一轮
 */
export async function enqueueTaskNow(task: any): Promise<number> {
  // 获取全量关键词
  const keywords = task.keyword_type === 1
    ? await getBrandKeywords(task.user_id)
    : await getDistillateKeywords(task.user_id);

  if (keywords.length === 0) {
    await updateTaskRunStatus(task.id, {
      status: 'success',
      recordCount: 0,
      brandCount: 0,
      endTime: new Date()
    });
    return 0;
  }

  // 启动新一轮（高优先级）
  const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
  const result = await startNewRound(task.id, keywords, shardSize, 1);
  await updateTaskRunStatus(task.id, { status: 'running', startTime: new Date() });
  console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 手动触发第 ${result.roundNo} 轮: ${result.shardCount} 个分片, 高优先级`);
  return result.firstQueueId;
}

export async function startRealCollectScheduler(): Promise<void> {
  if (schedulerStarted) {
    console.log('[RealCollect] 调度器已启动，跳过');
    return;
  }
  schedulerStarted = true;

  // 1. 重启恢复
  await recoverOnRestart();

  // 2. 启动循环检查（每30秒检查一次是否有轮次完成）
  loopTimer = setInterval(() => {
    checkCompletedRounds().catch(e => {
      console.error('[RealCollect] 循环检查异常:', e.message);
    });
  }, 30000);

  // 3. 每天凌晨0点重置账号池查询计数
  cron.schedule('0 0 * * *', async () => {
    try {
      await resetDailyAuthCounters();
      console.log('[RealCollect] 账号池每日计数已重置');
    } catch (e: any) {
      console.error('[RealCollect] 账号池重置失败:', e.message);
    }
  });

  // 4. 每天凌晨 3 点触发账号续期检查
  cron.schedule('0 3 * * *', async () => {
    try {
      console.log('[RealCollect] 触发账号续期检查...');
      const auths = await getAuthsForRenewal();
      console.log(`[RealCollect] ${auths.length} 个账号需要续期，等待 worker 处理`);
    } catch (e: any) {
      console.error('[RealCollect] 账号续期检查失败:', e.message);
    }
  });

  // 5. 每天凌晨 4 点清理 7 天前的日志和 30 天前的真实查询记录
  cron.schedule('0 4 * * *', async () => {
    try {
      await cleanOldWorkerLogs(7);
      console.log('[RealCollect] 已清理7天前的worker日志');
      const deletedCount = await cleanOldRealCollectRecords(30);
      if (deletedCount > 0) {
        console.log(`[RealCollect] 已清理30天前的真实查询记录 ${deletedCount} 条`);
      }
    } catch (e: any) {
      console.error('[RealCollect] 日志/记录清理失败:', e.message);
    }
  });

  console.log('[RealCollect] 循环调度器已启动(24/7持续执行, 30秒检查轮次完成, 重启自动恢复)');
}
