/**
 * 定时调度器：扫描到期的任务，放入队列由Worker消费
 */
import cron from 'node-cron';
import {
  getDueRealCollectTasks,
  updateTaskRunStatus,
  getDistillateKeywords,
  getDistillateKeywordsSharded,
  getBrandKeywords,
  enqueueRealCollectTask,
  getQueuePendingCount,
  resetDailyAuthCounters,
  getAuthsForRenewal,
  cleanOldWorkerLogs,
} from '../../repository';

let schedulerStarted = false;

/** 默认单个队列任务最大关键词数量（防止巨型任务长时间阻塞队列） */
const DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK = 50;

/** 将关键词数组分片为多个小批次 */
function shardKeywords(keywords: string[], shardSize: number): string[][] {
  const size = Math.max(1, shardSize);
  const shards: string[][] = [];
  for (let i = 0; i < keywords.length; i += size) {
    shards.push(keywords.slice(i, i + size));
  }
  return shards;
}

/**
 * 将到期任务放入队列
 */
async function checkAndEnqueueDueTasks(): Promise<void> {
  try {
    const tasks = await getDueRealCollectTasks();
    for (const task of tasks) {
      if (!cron.validate(task.cron_expr)) continue;

      const now = new Date();
      const lastRun = task.last_run_time ? new Date(task.last_run_time) : null;

      // 如果从未执行过，或距离上次执行已超过1小时，则检查是否在当前分钟应执行
      if (!lastRun || (now.getTime() - lastRun.getTime()) > 3600000) {
        const currentMatch = checkCronMatch(task.cron_expr, now);
        if (currentMatch) {
          // 获取关键词
          // 品牌词每天全量查询；蒸馏词按7分片轮询（每天查 1/7）
          const keywords = task.keyword_type === 1
            ? await getBrandKeywords(task.user_id)
            : await getDistillateKeywordsSharded(task.user_id, 7);

          if (keywords.length === 0) {
            await updateTaskRunStatus(task.id, {
              status: 'success',
              recordCount: 0,
              brandCount: 0,
              endTime: new Date()
            });
            continue;
          }

          // 分片入队，防止单个任务过大阻塞队列
          const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
          const shards = shardKeywords(keywords, shardSize);
          let firstQueueId = 0;
          for (const shard of shards) {
            const queueId = await enqueueRealCollectTask(task, shard, 0);
            if (firstQueueId === 0) firstQueueId = queueId;
          }
          // 更新任务状态为queued
          await updateTaskRunStatus(task.id, { status: 'queued' });
          console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 已入队(${shards.length}个分片, 每片${shardSize}个关键词, 共${keywords.length}个关键词), 首个queueId=${firstQueueId}`);
        }
      }
    }
  } catch (e: any) {
    console.error('[RealCollect] 调度器检查失败:', e.message);
  }
}

/** 简单检查当前时间是否匹配cron表达式（分钟级） */
function checkCronMatch(cronExpr: string, date: Date): boolean {
  try {
    const parts = cronExpr.split(' ');
    if (parts.length !== 5) return false;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    const m = date.getMinutes();
    const h = date.getHours();
    const dom = date.getDate();
    const mon = date.getMonth() + 1;
    const dow = date.getDay();

    const match = (expr: string, val: number): boolean => {
      if (expr === '*') return true;
      if (expr === val.toString()) return true;
      if (expr.includes(',')) return expr.split(',').some(p => p === val.toString());
      if (expr.includes('/')) {
        const [base, step] = expr.split('/');
        const stepNum = parseInt(step);
        if (base === '*') return val % stepNum === 0;
        return false;
      }
      if (expr.includes('-')) {
        const [start, end] = expr.split('-').map(Number);
        return val >= start && val <= end;
      }
      return false;
    };

    return match(minute, m) && match(hour, h) && match(dayOfMonth, dom) && match(month, mon) && match(dayOfWeek, dow);
  } catch {
    return false;
  }
}

/**
 * 立即将任务放入队列（用于手动触发"立即执行"）
 */
export async function enqueueTaskNow(task: any): Promise<number> {
  // 手动触发时使用全量关键词（不分片轮询）
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

  // 分片入队（高优先级），防止单个任务过大阻塞队列
  const shardSize = task.shard_size || DEFAULT_MAX_KEYWORDS_PER_QUEUE_TASK;
  const shards = shardKeywords(keywords, shardSize);
  let firstQueueId = 0;
  for (const shard of shards) {
    const queueId = await enqueueRealCollectTask(task, shard, 1); // priority=1 手动立即执行，优先消费
    if (firstQueueId === 0) firstQueueId = queueId;
  }
  await updateTaskRunStatus(task.id, { status: 'queued' });
  console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 手动入队(${shards.length}个分片, 每片${shardSize}个关键词, 共${keywords.length}个关键词, 高优先级), 首个queueId=${firstQueueId}`);
  return firstQueueId;
}

export function startRealCollectScheduler(): void {
  if (schedulerStarted) {
    console.log('[RealCollect] 调度器已启动，跳过');
    return;
  }
  schedulerStarted = true;

  // 每分钟检查到期任务，放入队列
  cron.schedule('* * * * *', () => {
    checkAndEnqueueDueTasks().catch(e => {
      console.error('[RealCollect] 调度器异常:', e.message);
    });
  });

  // 每天凌晨0点重置账号池查询计数
  cron.schedule('0 0 * * *', async () => {
    try {
      await resetDailyAuthCounters();
      console.log('[RealCollect] 账号池每日计数已重置');
    } catch (e: any) {
      console.error('[RealCollect] 账号池重置失败:', e.message);
    }
  });

  // 每天凌晨 3 点触发账号续期（worker 会轮询 /platform-auth/renew/pending）
  cron.schedule('0 3 * * *', async () => {
    try {
      console.log('[RealCollect] 触发账号续期检查...');
      // 续期由 worker 主动拉取，这里只做日志
      const auths = await getAuthsForRenewal();
      console.log(`[RealCollect] ${auths.length} 个账号需要续期，等待 worker 处理`);
    } catch (e: any) {
      console.error('[RealCollect] 账号续期检查失败:', e.message);
    }
  });

  // 每天凌晨 4 点清理 7 天前的日志
  cron.schedule('0 4 * * *', async () => {
    try {
      await cleanOldWorkerLogs(7);
      console.log('[RealCollect] 已清理7天前的worker日志');
    } catch (e: any) {
      console.error('[RealCollect] 日志清理失败:', e.message);
    }
  });

  console.log('[RealCollect] 定时调度器已启动(每分钟检查到期任务并放入队列, 每天0点重置账号池计数)');
}
