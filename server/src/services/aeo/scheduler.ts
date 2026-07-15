/**
 * AEO 调度器：
 * - 每天凌晨 2 点为所有活跃任务生成 AEO 日报
 * - 每小时检查是否需要生成周报/月报（按客户创建日计算周期，依次执行非并发）
 */
import cron from 'node-cron';
import { getActiveTasksForAeo, shouldGenerateDailyReport, shouldGenerateWeeklyReport, shouldGenerateMonthlyReport } from '../../repository';
import { generateAeoReport, generatePeriodReport } from './analyzer';

let aeoSchedulerStarted = false;

export function startAeoScheduler(): void {
  if (aeoSchedulerStarted) {
    console.log('[AEO] 调度器已启动，跳过');
    return;
  }
  aeoSchedulerStarted = true;

  // 每天凌晨 2 点生成 AEO 日报（在巡检任务执行之后）
  // v2.1.6：改为按客户(userId)去重，每个客户只生成一份日报（跨任务汇总蒸馏词+品牌词）
  cron.schedule('0 2 * * *', async () => {
    console.log('[AEO] 开始生成每日 AEO 日报...');
    try {
      const tasks = await getActiveTasksForAeo();
      // 按 userId 去重，每个客户取第一个任务作为占位 taskId
      const userTaskMap = new Map<string, any>();
      for (const task of tasks) {
        if (task.user_id && !userTaskMap.has(task.user_id)) {
          userTaskMap.set(task.user_id, task);
        }
      }
      const userTasks = Array.from(userTaskMap.values());
      console.log(`[AEO] 共 ${tasks.length} 个活跃任务，去重后 ${userTasks.length} 个客户需要生成日报`);

      // 分批并发处理，每批3个
      const batchSize = 3;
      for (let i = 0; i < userTasks.length; i += batchSize) {
        const batch = userTasks.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (task) => {
          try {
            await generateAeoReport(task.id, task.user_id);
          } catch (e: any) {
            console.error(`[AEO] 用户 ${task.user_id} 日报生成失败:`, e.message);
          }
        }));
      }

      console.log('[AEO] 每日 AEO 日报生成完成');
    } catch (e: any) {
      console.error('[AEO] 调度器异常:', e.message);
    }
  });

  // v2.0.0: 每小时检查是否需要生成周报/月报（按客户创建日计算周期）
  // 依次执行（非并发），避免资源压力
  cron.schedule('0 * * * *', async () => {
    try {
      await checkAndGeneratePeriodReports();
    } catch (e: any) {
      console.error('[AEO-Period] 周期报告调度异常:', e.message);
    }
  });

  console.log('[AEO] 调度器已启动(每天凌晨2点生成AEO日报 + 每小时检查周/月报)');
}

/**
 * 检查所有用户是否需要生成周报/月报，依次执行（非并发）
 */
async function checkAndGeneratePeriodReports(): Promise<void> {
  // 获取所有活跃任务，提取 distinct user_id
  const tasks = await getActiveTasksForAeo();
  const userIds = [...new Set(tasks.map(t => t.user_id).filter(Boolean))];

  if (userIds.length === 0) return;

  const now = new Date();
  let dailyCount = 0;
  let weeklyCount = 0;
  let monthlyCount = 0;

  // 依次处理每个用户（非并发，避免 LLM 调用和写作任务创建同时进行导致资源压力）
  for (const userId of userIds) {
    try {
      // v2.1.3：检查日报（配额周期为 daily 时触发自动写作）
      if (await shouldGenerateDailyReport(userId, now)) {
        const periodEnd = now;
        const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        console.log(`[AEO-Period] 用户 ${userId} 需要生成日报 (${periodStart.toISOString().slice(0,10)}~${periodEnd.toISOString().slice(0,10)})`);
        const reportId = await generatePeriodReport(userId, 'daily', periodStart, periodEnd);
        if (reportId) dailyCount++;
      }

      // 检查周报
      if (await shouldGenerateWeeklyReport(userId, now)) {
        const periodEnd = now;
        const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        console.log(`[AEO-Period] 用户 ${userId} 需要生成周报 (${periodStart.toISOString().slice(0,10)}~${periodEnd.toISOString().slice(0,10)})`);
        const reportId = await generatePeriodReport(userId, 'weekly', periodStart, periodEnd);
        if (reportId) weeklyCount++;
      }

      // 检查月报
      if (await shouldGenerateMonthlyReport(userId, now)) {
        const periodEnd = now;
        const periodStart = new Date(now);
        periodStart.setMonth(periodStart.getMonth() - 1);
        console.log(`[AEO-Period] 用户 ${userId} 需要生成月报 (${periodStart.toISOString().slice(0,10)}~${periodEnd.toISOString().slice(0,10)})`);
        const reportId = await generatePeriodReport(userId, 'monthly', periodStart, periodEnd);
        if (reportId) monthlyCount++;
      }
    } catch (e: any) {
      console.error(`[AEO-Period] 用户 ${userId} 周期报告生成失败:`, e.message);
    }
  }

  if (dailyCount > 0 || weeklyCount > 0 || monthlyCount > 0) {
    console.log(`[AEO-Period] 周期报告检查完成: 生成 ${dailyCount} 份日报, ${weeklyCount} 份周报, ${monthlyCount} 份月报`);
  }
}
