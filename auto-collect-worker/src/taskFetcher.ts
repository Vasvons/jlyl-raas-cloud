import { BrowserPool } from './browserPool';
import { DeepSeekAdapter } from './platforms/deepseek';
import { KimiAdapter } from './platforms/kimi';
import { PlatformAdapter } from './platforms/base';
import { reportResult } from './resultReporter';

const browserPool = new BrowserPool(4);

const platformAdapters: Record<string, PlatformAdapter> = {
  'DeepSeek': new DeepSeekAdapter(),
  'Kimi': new KimiAdapter(),
};

export interface ExecuteTaskParams {
  taskId: number;
  userId: string;
  keywordType: number;
  keywords: string[];
  platforms: string[];
}

export interface ExecuteTaskResult {
  totalRecords: number;
  brandMatched: number;
}

export async function executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
  const { taskId, userId, keywordType, keywords, platforms } = params;
  const workerId = `worker-${process.pid}-${Date.now()}`;

  console.log(`[TaskExecutor] 开始执行任务 ${taskId}: ${keywords.length}个关键词 × ${platforms.length}个平台 = ${keywords.length * platforms.length}次查询`);

  let totalRecords = 0;
  let brandMatched = 0;

  for (const platform of platforms) {
    const adapter = platformAdapters[platform];
    if (!adapter) {
      console.warn(`[TaskExecutor] 平台 ${platform} 没有对应的适配器，跳过`);
      continue;
    }

    const browser = await browserPool.acquire();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      const isLoggedIn = await adapter.checkLoginStatus(page);
      if (!isLoggedIn) {
        console.warn(`[TaskExecutor] 平台 ${platform} 未登录，跳过`);
        await context.close();
        continue;
      }

      for (const keyword of keywords) {
        try {
          console.log(`[TaskExecutor] 查询: ${platform}/${keyword.substring(0, 30)}`);
          const result = await adapter.query(page, keyword);

          await reportResult({
            taskId,
            userId,
            keyword,
            keywordType,
            platform,
            content: result.content,
            htmlContent: result.htmlContent,
            shareUrl: result.shareUrl,
            supportsShare: result.supportsShare,
            workerId
          });

          totalRecords++;

          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        } catch (e: any) {
          console.error(`[TaskExecutor] 查询失败: ${platform}/${keyword.substring(0, 30)} - ${e.message}`);
        }
      }

      await context.close();
    } catch (e: any) {
      console.error(`[TaskExecutor] 平台 ${platform} 执行失败:`, e.message);
    } finally {
      await browserPool.release(browser);
    }
  }

  console.log(`[TaskExecutor] 任务 ${taskId} 完成: ${totalRecords}条记录`);
  return { totalRecords, brandMatched };
}
