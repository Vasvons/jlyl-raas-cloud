/**
 * 循环调度器：任务24/7持续循环执行
 * - 服务器启动时：恢复中断的任务，为无pending分片的active任务启动新一轮
 * - 每30秒检查：哪些任务当前轮次已完成(100%)，触发AEO分析并启动新一轮
 * - 多任务严格轮询：由 dequeue 的 SQL 保证（按 task 最近消费时间轮询）
 */
import cron from 'node-cron';
import { query } from '../../db';
import {
  getDueRealCollectTasks,
  updateTaskRunStatus,
  getDistillateKeywords,
  getBrandQueryKeywords,
  resetDailyAuthCounters,
  getAuthsForRenewal,
  cleanOldWorkerLogs,
  cleanOldRealCollectRecords,
  resetRunningQueueOnRestart,
  requeueStaleRunningShards,
  getTasksNeedingNewRound,
  isTaskRoundComplete,
  startNewRound,
  getTaskRoundStartTime,
  cleanOversizedPendingShards,
  getRunningQueueTask,
  requestQueueAbort,
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

    // 1.5 删除旧轮次的 pending 分片（round_no != 任务当前 round_no）
    // 旧方案是"同步 round_no"，但这会把多个旧轮次的 pending 分片合并到当前轮次，
    // 导致 getTaskShardProgress 统计出多个分片（明明只有1个分片却显示3个）
    // 正确做法：删除旧轮次的 pending 分片，让 getTasksNeedingNewRound 为无 pending 的任务启动新一轮
    const deleteOldPendingResult = await query(
      `DELETE FROM real_collect_queue q
       USING real_collect_task t
       WHERE q.task_id = t.id
         AND q.status = 'pending'
         AND COALESCE(q.round_no, 0) != COALESCE(t.round_no, 0)`
    );
    if ((deleteOldPendingResult.rowCount || 0) > 0) {
      console.log(`[RealCollect] 重启恢复：删除 ${deleteOldPendingResult.rowCount} 个旧轮次的 pending 分片（避免 round_no 同并导致重复统计）`);
    }

    // 2. 清理旧的、未分片的 pending 队列项（分片机制生效前入队的巨型队列项）
    const affectedTaskIds = await cleanOversizedPendingShards();
    if (affectedTaskIds.length > 0) {
      console.log(`[RealCollect] 已清理过大的 pending 队列项，涉及任务: ${affectedTaskIds.join(', ')}`);
    }

    // 3. 恢复服务器重启时被误标记为 expired 的账号
    // 服务器/Worker 重启时，续期器可能正在执行续期，被中断后导致续期失败累加 renewal_fail_count
    // 连续3次失败会标记 expired，但实际账号可能仍然有效
    // 同时恢复被误标记为 offline 的账号（之前的单次判定逻辑可能误判，重启给一次重新尝试的机会）
    // 重启时重置 renewal_fail_count / offline_fail_count，并将 health_status IN (normal, offline) 的 expired 账号恢复为 active
    const recoverAccountResult = await query(
      `UPDATE platform_auth
       SET status = 'active',
           health_status = 'normal',
           renewal_fail_count = 0,
           offline_fail_count = 0,
           risk_detected_at = NULL,
           updated_at = NOW()
       WHERE status = 'expired' AND health_status IN ('normal', 'offline')
       RETURNING id, platform, health_status`
    );
    if (recoverAccountResult.rows.length > 0) {
      const offlineCount = recoverAccountResult.rows.filter((r: any) => r.health_status === 'offline').length;
      const normalCount = recoverAccountResult.rows.length - offlineCount;
      console.log(`[RealCollect] 重启恢复：${recoverAccountResult.rows.length} 个被误标记为 expired 的账号已恢复为 active${offlineCount > 0 ? ` (其中 ${offlineCount} 个原为 offline 状态，${normalCount} 个为 normal 状态)` : ''}`);
    }

    // 4. 为无 pending 分片的 active 任务启动新一轮
    const tasks = await getTasksNeedingNewRound();
    for (const task of tasks) {
      await startNewRoundForTask(task);
    }
    console.log(`[RealCollect] 重启恢复完成，${tasks.length} 个任务已启动新一轮`);

    // 5. 修复 last_run_time：对于有 pending 分片但 last_run_time 为 NULL 的 active 任务，
    // 更新 last_run_time 为 round_start_time（解决一直在执行的任务没有"上次执行"信息的问题）
    await query(
      `UPDATE real_collect_task
       SET last_run_time = COALESCE(round_start_time, NOW()),
           last_run_status = COALESCE(last_run_status, 'running')
       WHERE status = 'active'
         AND last_run_time IS NULL
         AND EXISTS (
           SELECT 1 FROM real_collect_queue q
           WHERE q.task_id = real_collect_task.id AND q.status = 'pending'
         )`
    );
  } catch (e: any) {
    console.error('[RealCollect] 重启恢复失败:', e.message);
  }
}

/**
 * 为任务启动新一轮
 * @returns 是否成功入队分片（false 表示无关键词或失败）
 */
async function startNewRoundForTask(task: any): Promise<boolean> {
  try {
    // 获取全量关键词（循环模式：每轮都查全量，不再分片轮询）
    // v2.1.8 修复：keyword_type=1 时从 zlgjc 表读品牌查询关键词（116个），不是从 pp 表读品牌名（1个）
    const keywords = task.keyword_type === 1
      ? await getBrandQueryKeywords(task.user_id)
      : await getDistillateKeywords(task.user_id);

    if (keywords.length === 0) {
      // v2.1.5：关键词为空时记录错误信息到 last_error 字段，前端可据此显示"无关键词"状态
      const kwSource = task.keyword_type === 1 ? 'zlgjc 表（品牌查询关键词库 keyword_type=1）' : 'zlgjc 表（蒸馏词库）';
      const errMsg = `无关键词：${kwSource}中 user_id=${task.user_id} 无数据，请先导入关键词`;
      console.warn(`[RealCollect] 任务 ${task.id} (${task.task_name}) ${errMsg}`);
      // 无关键词时标记为 success（避免 checkCompletedRounds 每次循环都尝试入队），但记录错误原因
      await updateTaskRunStatus(task.id, { status: 'success', endTime: new Date(), error: errMsg });
      return false;
    }

    const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
    const result = await startNewRound(task.id, keywords, shardSize, 0);
    // 标记任务为 running 状态并记录开始时间
    // updateTaskRunStatus 中 startTime 会更新 last_run_time 字段，status 会更新 last_run_status 字段
    await updateTaskRunStatus(task.id, { status: 'running', startTime: new Date() });
    console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 启动第 ${result.roundNo} 轮: ${result.shardCount} 个分片, ${keywords.length} 个关键词`);
    return true;
  } catch (e: any) {
    console.error(`[RealCollect] 任务 ${task.id} 启动新一轮失败:`, e.message);
    return false;
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
    // 0. 回收超时的 running 分片（Worker 崩溃/OOM/容器重启后会永久卡在 running）
    // 阈值 30 分钟：正常分片 50 个关键词，单个查询 10-30 秒，最多 25 分钟完成
    // 超过 30 分钟还在 running 的分片，Worker 一定已经死了
    try {
      const { requeuedCount, resetTaskIds } = await requeueStaleRunningShards(30);
      if (requeuedCount > 0) {
        console.log(`[RealCollect] 回收 ${requeuedCount} 个超时 running 分片，涉及任务: [${resetTaskIds.join(', ')}]`);
      }
    } catch (e: any) {
      console.error('[RealCollect] 回收超时 running 分片失败:', e.message);
    }

    // 获取所有 active 任务
    const tasks = await getDueRealCollectTasks();

    for (const task of tasks) {
      try {
        // 分片数不匹配检测：如果当前轮次的分片数 × shard_size 远大于实际关键词数，
        // 说明分片入队时关键词有重复（已通过 DISTINCT 修复，但旧分片仍需手动纠正）
        // 注意：不自动重置！自动重置会删除 running 分片，导致 Worker 执行无效分片
        // 期间所有任务显示"队列中"（因为新分片都是 pending，Worker 还在执行被删除的旧分片）
        // 改为只记录警告日志，用户通过 POST /:id/reset-round 手动重置
        try {
          const shardCountResult = await query(
            `SELECT COUNT(*) as cnt FROM real_collect_queue WHERE task_id = $1 AND round_no = $2`,
            [task.id, task.round_no]
          );
          const shardCount = parseInt(shardCountResult.rows[0]?.cnt || '0');
          if (shardCount > 0) {
            const uniqueKeywords = task.keyword_type === 1
              ? await getBrandQueryKeywords(task.user_id)
              : await getDistillateKeywords(task.user_id);
            const expectedShardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
            const expectedShardCount = Math.ceil(uniqueKeywords.length / expectedShardSize);
            if (shardCount > expectedShardCount * 1.2) {
              console.warn(`[RealCollect] 任务 ${task.id} (${task.task_name}) 分片数不匹配: 实际=${shardCount}, 预期=${expectedShardCount}（关键词${uniqueKeywords.length}个），请手动调用 POST /real-collect/task/${task.id}/reset-round 重置`);
            }
          }
        } catch (e: any) {
          console.error(`[RealCollect] 任务 ${task.id} 分片数检测失败:`, e.message);
        }

        // 检查当前轮次是否完成
        const isComplete = await isTaskRoundComplete(task.id);
        if (!isComplete) {
          // 额外检查：当前轮次是否完全没有分片（可能入队失败、被手动删除、或重启恢复时遗漏）
          // isTaskRoundComplete 在 total=0 时返回 false，但任务会永远卡住
          // 此时需要直接启动新一轮
          const noShardResult = await query(
            `SELECT COUNT(*) as cnt FROM real_collect_queue WHERE task_id = $1 AND round_no = $2`,
            [task.id, task.round_no]
          );
          const shardCount = parseInt(noShardResult.rows[0]?.cnt || '0');
          if (shardCount === 0) {
            console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 当前轮次 ${task.round_no} 无分片，启动新一轮`);
            await startNewRoundForTask(task);
          }
          continue;
        }

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
 * v2.1.8 行为调整：
 *  1. 中断 Worker 当前正在执行的其他任务分片（设置 abort_requested）
 *  2. 把当前任务的新一轮第一个分片以 priority=1 入队（插队立即执行）
 *  3. 其余分片 priority=0，回到正常队列公平轮询
 *  4. 被中断的分片会由 completeQueueTask 重新设为 pending（保留 last_keyword_index 断点续查）
 */
export async function enqueueTaskNow(task: any): Promise<number> {
  // 1. 中断 Worker 当前正在执行的分片（如果是其他任务的，且尚未请求中断）
  const runningTask = await getRunningQueueTask();
  if (runningTask && runningTask.task_id !== task.id && !runningTask.abort_requested) {
    await requestQueueAbort(runningTask.id);
    console.log(`[RealCollect] 立即执行：已请求中断当前运行的分片 queueId=${runningTask.id} taskId=${runningTask.task_id}，Worker 将在当前关键词查询完成后停止`);
  }

  // 2. 获取全量关键词
  // v2.1.8 修复：keyword_type=1 时从 zlgjc 表读品牌关键词（116 个），不是从 pp 表读品牌名（1 个）
  const keywords = task.keyword_type === 1
    ? await getBrandQueryKeywords(task.user_id)
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

  // 3. 启动新一轮（第一个分片 priority=1 插队，其余 priority=0 公平轮询）
  const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
  const result = await startNewRound(task.id, keywords, shardSize, 1);
  await updateTaskRunStatus(task.id, { status: 'running', startTime: new Date() });
  console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 手动触发第 ${result.roundNo} 轮: ${result.shardCount} 个分片, 首分片高优先级`);
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
