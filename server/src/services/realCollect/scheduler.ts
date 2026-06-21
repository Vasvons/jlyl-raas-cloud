/**
 * 定时调度器：扫描到期的任务，放入队列由Worker消费
 */
import cron from 'node-cron';
import {
  getDueRealCollectTasks,
  updateTaskRunStatus,
  getDistillateKeywords,
  getBrandKeywords,
  enqueueRealCollectTask,
  getQueuePendingCount,
} from '../../repository';

let schedulerStarted = false;

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
            continue;
          }

          // 放入队列
          const queueId = await enqueueRealCollectTask(task, keywords);
          // 更新任务状态为queued
          await updateTaskRunStatus(task.id, { status: 'queued' });
          console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 已入队(queueId=${queueId}), ${keywords.length}个关键词`);
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

  const queueId = await enqueueRealCollectTask(task, keywords, 1); // priority=1 手动立即执行，优先消费
  await updateTaskRunStatus(task.id, { status: 'queued' });
  console.log(`[RealCollect] 任务 ${task.id} (${task.task_name}) 手动入队(queueId=${queueId}, 高优先级), ${keywords.length}个关键词`);
  return queueId;
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

  console.log('[RealCollect] 定时调度器已启动(每分钟检查到期任务并放入队列)');
}
