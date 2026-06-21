import axios from 'axios';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export async function reportResult(result: {
  taskId: number;
  userId: string;
  keyword: string;
  keywordType: number;
  platform: string;
  content: string;
  htmlContent?: string;
  shareUrl: string | null;
  supportsShare: boolean;
  workerId: string;
}): Promise<void> {
  try {
    await axios.post(`${SERVER_URL}/real-collect/results/worker/report`, {
      ...result,
      queryTime: new Date().toISOString()
    }, {
      timeout: 30000
    });
    console.log(`[Reporter] 结果回写成功: ${result.platform}/${result.keyword.substring(0, 20)}`);
  } catch (e: any) {
    console.error(`[Reporter] 结果回写失败: ${e.message}`);
    throw e;
  }
}
