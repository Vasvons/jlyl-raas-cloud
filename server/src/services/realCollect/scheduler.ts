/**
 * 定时调度器：扫描到期的任务，调用Worker执行
 */
import cron from 'node-cron';
import axios from 'axios';
import { getDueRealCollectTasks, updateTaskRunStatus, getDistillateKeywords, getBrandKeywords } from '../../repository';

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:3003';
let schedulerStarted = false;

export async function triggerTaskExecution(task: any): Promise<void> {
  console.log(`[RealCollect] 触发任务执行: ${task.id} (${task.task_name})`);

  await updateTaskRunStatus(task.id, { status: 'running' });

  try {
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
      return;
    }

    const response = await axios.post(`${WORKER_URL}/execute`, {
      taskId: task.id,
      userId: task.user_id,
      keywordType: task.keyword_type,
      keywords,
      platforms: task.platforms
    }, {
      timeout: 3600000
    });

    const { totalRecords, brandMatched } = response.data as { totalRecords: number; brandMatched: number };
    await updateTaskRunStatus(task.id, {
      status: 'success',
      recordCount: totalRecords,
      brandCount: brandMatched,
      endTime: new Date()
    });

    console.log(`[RealCollect] 任务 ${task.id} 执行完成: ${totalRecords}条记录, ${brandMatched}条品牌词匹配`);
  } catch (e: any) {
    console.error(`[RealCollect] 任务 ${task.id} 执行失败:`, e.message);
    await updateTaskRunStatus(task.id, {
      status: 'failed',
      error: e.message,
      endTime: new Date()
    });
  }
}

async function checkAndRunDueTasks(): Promise<void> {
  try {
    const tasks = await getDueRealCollectTasks();
    for (const task of tasks) {
      if (!cron.validate(task.cron_expr)) continue;

      const now = new Date();
      const lastRun = task.last_run_time ? new Date(task.last_run_time) : null;

      // 计算下次应该执行的时间
      const schedule = cron.schedule(task.cron_expr, () => {}, { scheduled: false });
      const nextRun = (schedule as any).nextRunAt();
      schedule.stop();

      if (!nextRun) continue;

      // 如果从未执行过，或上次执行时间早于(下次执行时间-1个周期)，则执行
      // 简化判断：如果上次执行时间为空，或距离上次执行已超过1小时，则检查是否在当前分钟应执行
      if (!lastRun || (now.getTime() - lastRun.getTime()) > 3600000) {
        // 检查当前时间是否匹配cron
        const currentMatch = checkCronMatch(task.cron_expr, now);
        if (currentMatch) {
          await triggerTaskExecution(task);
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

export function startRealCollectScheduler(): void {
  if (schedulerStarted) {
    console.log('[RealCollect] 调度器已启动，跳过');
    return;
  }
  schedulerStarted = true;

  cron.schedule('* * * * *', () => {
    checkAndRunDueTasks().catch(e => {
      console.error('[RealCollect] 调度器异常:', e.message);
    });
  });

  console.log('[RealCollect] 定时调度器已启动(每分钟检查到期任务)');
}
