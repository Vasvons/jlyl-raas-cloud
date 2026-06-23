/**
 * AEO 调度器：每天为所有活跃任务生成一次 AEO 日报
 */
import cron from 'node-cron';
import { getActiveTasksForAeo } from '../../repository';
import { generateAeoReport } from './analyzer';

let aeoSchedulerStarted = false;

export function startAeoScheduler(): void {
  if (aeoSchedulerStarted) {
    console.log('[AEO] 调度器已启动，跳过');
    return;
  }
  aeoSchedulerStarted = true;

  // 每天凌晨 2 点生成 AEO 日报（在巡检任务执行之后）
  cron.schedule('0 2 * * *', async () => {
    console.log('[AEO] 开始生成每日 AEO 日报...');
    try {
      const tasks = await getActiveTasksForAeo();
      console.log(`[AEO] 共 ${tasks.length} 个活跃任务需要生成日报`);

      // 分批并发处理，每批3个
      const batchSize = 3;
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (task) => {
          try {
            await generateAeoReport(task.id, task.user_id);
          } catch (e: any) {
            console.error(`[AEO] 任务 ${task.id} 日报生成失败:`, e.message);
          }
        }));
      }

      console.log('[AEO] 每日 AEO 日报生成完成');
    } catch (e: any) {
      console.error('[AEO] 调度器异常:', e.message);
    }
  });

  console.log('[AEO] 调度器已启动(每天凌晨2点生成AEO日报)');
}
