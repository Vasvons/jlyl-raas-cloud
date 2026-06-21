import express from 'express';
import dotenv from 'dotenv';
import { executeTask } from './taskFetcher';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.WORKER_PORT ? parseInt(process.env.WORKER_PORT) : 3003;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/execute', async (req, res) => {
  try {
    const { taskId, userId, keywordType, keywords, platforms } = req.body;
    console.log(`[Worker] 收到任务: taskId=${taskId}, userId=${userId}, keywords=${keywords.length}, platforms=${platforms.length}`);
    const result = await executeTask({ taskId, userId, keywordType, keywords, platforms });
    res.json({ code: 200, ...result });
  } catch (e: any) {
    console.error('[Worker] 任务执行失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Worker] 自动收录查询Worker服务已启动，端口: ${PORT}`);
});
