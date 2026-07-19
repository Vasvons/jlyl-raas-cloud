/**
 * AEO 调度器：
 * - 每天凌晨 2 点为所有活跃任务生成 AEO 日报
 * - 每小时检查是否需要生成周报/月报（按客户创建日计算周期，依次执行非并发）
 */
import cron from 'node-cron';
import { getActiveTasksForAeo, shouldGenerateDailyReport, shouldGenerateWeeklyReport, shouldGenerateMonthlyReport } from '../../repository';
import { generateAeoReport, generatePeriodReport } from './analyzer';
// v2.3.4：scheduler.ts 内需要直接查询 aeo_report 表检测占位日报
import { query as dbQuery } from '../../db';

let aeoSchedulerStarted = false;

export function startAeoScheduler(): void {
  if (aeoSchedulerStarted) {
    console.log('[AEO] 调度器已启动，跳过');
    return;
  }
  aeoSchedulerStarted = true;

  // v2.2.3：启动时补生成昨天的日报（防止部署重启导致 cron 0 2 * * * 错过）
  // 延迟 30 秒执行，等数据库连接池就绪
  // v2.3.4：彻底修复"白天部署启动补生成用今天日期占位导致凌晨 cron 跳过"的 bug
  //   原 bug：generateAeoReport 内部 hour>=6 时 reportDate=今天，
  //     白天部署启动补生成 → 生成"今天"日报（分片不全，残缺）
  //     凌晨 cron 触发 → checkAeoReportExists 返回 true → 跳过
  //     永远是白天那份残缺日报，用户感知"日报没生成"
  //   修复：启动补生成显式传入 reportDate=昨天（上海时区），与凌晨 cron 一致
  //     同时检测已存在的"无数据占位日报"（raw_analysis 含 no_shard_reports）并强制覆盖
  setTimeout(() => {
    generateDailyReports({ isStartupBackfill: true }).catch(e => {
      console.error('[AEO] 启动补生成日报失败:', e.message);
    });
  }, 30 * 1000);

  // 每天凌晨 0 点生成 AEO 日报（覆盖前一天的巡检数据）
  // v2.2.22：原 cron 是 0 2 * * *（凌晨 2 点），但用户期望 0 点准时生成
  //   原 bug1：凌晨 2 点才执行，用户感觉"0 点没生成"
  //   原 bug2：白天 checkAndGeneratePeriodReports 也会触发日报（shouldGenerateDailyReport 返回 true），
  //     白天生成的日报用当天日期，但当天分片报告还没产出 → 生成空日报占位，
  //     凌晨再来生成时被 checkAeoReportExists 跳过 → 永远是空日报
  // 修复：cron 改为 0 0 * * *（凌晨 0 点），且 generateAeoReport 内部用"前一天"日期
  cron.schedule('0 0 * * *', async () => {
    await generateDailyReports();
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

  console.log('[AEO] 调度器已启动(每天凌晨0点生成AEO日报+触发自动写作 + 每小时检查周/月报 + 启动补生成)');
}

/**
 * v2.2.3：生成每日 AEO 日报（抽取为独立函数，供 cron 和启动补生成复用）
 * 按客户(userId)去重，每个客户只生成一份日报（跨任务汇总蒸馏词+品牌词）
 *
 * v2.2.22：同时触发 generatePeriodReport(daily) 创建自动写作任务
 *   原 bug：generateAeoReport 只写 aeo_report 表，不创建写作任务；
 *     自动写作由 generatePeriodReport(daily) 触发，但 v2.2.22 已移除白天触发，
 *     导致自动写作永远不会被触发。
 *   修复：凌晨 0 点 generateAeoReport 完成后，立即调用 generatePeriodReport(daily)
 *     覆盖前一天的巡检数据，并触发自动写作任务创建。
 *
 * v2.3.4：新增 options.isStartupBackfill 参数（启动补生成专用）
 *   原 bug：白天部署启动补生成时 generateAeoReport 内部 hour>=6 → reportDate=今天，
 *     生成"今天"残缺日报占位，凌晨 cron 被 checkAeoReportExists 跳过，日报永远是残缺版
 *   修复：isStartupBackfill=true 时显式传入 reportDate=昨天（上海时区），
 *     与凌晨 cron 一致，避免占位今天日报
 *   同时检测已存在的"无数据占位日报"（raw_analysis 含 reason=no_shard_reports）并强制覆盖
 */
async function generateDailyReports(options?: { isStartupBackfill?: boolean }): Promise<void> {
  const isStartupBackfill = options?.isStartupBackfill === true;
  console.log(`[AEO] 开始生成每日 AEO 日报${isStartupBackfill ? '（启动补生成模式）' : ''}...`);

  // v2.3.4：启动补生成显式计算"昨天"日期（上海时区），避免依赖 generateAeoReport 内部 hour 判断
  let backfillReportDate: string | undefined;
  if (isStartupBackfill) {
    const now = new Date();
    const nowShanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const yesterdayShanghai = new Date(nowShanghai.getTime() - 24 * 60 * 60 * 1000);
    backfillReportDate = yesterdayShanghai.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    console.log(`[AEO] 启动补生成使用昨天日期：${backfillReportDate}（避免占位今天日报）`);
  }

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
          // v2.3.4：启动补生成模式下，检测"无数据占位日报"并强制覆盖
          //   原 bug：白天部署已写入 no_shard_reports 占位日报，凌晨 cron 被 checkAeoReportExists 跳过
          //   修复：启动补生成主动查询该客户昨天的日报，若 raw_analysis 含 no_shard_reports 则强制覆盖
          let needForce = false;
          if (isStartupBackfill && backfillReportDate) {
            const existingReport = await dbQuery(
              'SELECT raw_analysis FROM aeo_report WHERE user_id = $1 AND report_date = $2 LIMIT 1',
              [task.user_id, backfillReportDate]
            ).then((r: any) => r.rows[0]).catch(() => null);

            if (existingReport) {
              const rawAnalysis = String(existingReport.raw_analysis || '');
              if (rawAnalysis.includes('no_shard_reports')) {
                needForce = true;
                console.log(`[AEO] 用户 ${task.user_id} ${backfillReportDate} 检测到无数据占位日报，强制覆盖重新生成`);
              } else {
                // 已存在且有数据，跳过
                console.log(`[AEO] 用户 ${task.user_id} ${backfillReportDate} 日报已存在且有数据，跳过`);
                return;
              }
            }
          }

          // 1. 生成 aeo_report 日报
          //   启动补生成模式：传 reportDate=昨天 + force（仅在检测到占位日报时）
          //   凌晨 cron 模式：不传 reportDate，由 generateAeoReport 内部 hour<6 判断用昨天
          await generateAeoReport(task.id, task.user_id, {
            ...(backfillReportDate ? { reportDate: backfillReportDate } : {}),
            ...(needForce ? { force: true } : {}),
          });

          // v2.2.22：2. 触发 generatePeriodReport(daily) 创建自动写作任务
          //   原 bug：generateAeoReport 不创建写作任务，自动写作由 generatePeriodReport 触发
          //   修复：日报生成完成后立即调用 generatePeriodReport(daily)
          const periodEnd = new Date();
          const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
          const periodReportId = await generatePeriodReport(
            task.user_id,
            'daily',
            periodStart,
            periodEnd
          );
          if (periodReportId) {
            console.log(`[AEO] 用户 ${task.user_id} 日报自动写作任务已创建 periodReportId=${periodReportId}`);
          }
        } catch (e: any) {
          console.error(`[AEO] 用户 ${task.user_id} 日报生成失败:`, e.message);
        }
      }));
    }

    console.log('[AEO] 每日 AEO 日报生成完成');
  } catch (e: any) {
    console.error('[AEO] 调度器异常:', e.message);
  }
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
      // v2.2.22：取消白天的日报生成，避免空占位
      //   原 bug：shouldGenerateDailyReport 在白天每小时检查都会返回 true（如果当天还没生成日报），
      //     但白天分片报告还没产出 → 生成空日报 → 凌晨再来生成时被 checkAeoReportExists 跳过
      //   修复：日报只在凌晨 0 点由 generateDailyReports() 生成（cron 0 0 * * *）
      //     shouldGenerateDailyReport 仅用于判断"当天是否已生成日报"，不再触发 generatePeriodReport
      //     周报/月报仍由这里的 shouldGenerateWeeklyReport/MonthlyReport 触发
      //   注意：如果配额周期是 daily，自动写作任务创建会延迟到凌晨 0 点真正生成日报后触发
      //     （由 generatePeriodReport 内部根据 last_period_report_at 判断）
      if (await shouldGenerateDailyReport(userId, now)) {
        // 已通过 checkAeoReportExists 防重，这里只记录日志，不触发生成
        console.log(`[AEO-Period] 用户 ${userId} 当天日报未生成，等待凌晨 0 点由 cron 生成（不在白天生成避免空占位）`);
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
