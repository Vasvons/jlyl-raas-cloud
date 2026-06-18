import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { migrate } from './migrate';
import { startScheduler } from './scheduler';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import taskRoutes from './routes/task';
import keywordRoutes from './routes/keyword';
import monitorRoutes from './routes/monitor';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3002');

// 中间件
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) || [];
app.use(cors({
  origin: (origin, callback) => {
    // 允许所有来源：未配置白名单时放行所有，配置了白名单时只放行白名单
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // 桌面端需要从任意来源访问，暂时全部放行
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/users', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/task', taskRoutes);
app.use('/monitor', monitorRoutes);
app.use('/', keywordRoutes);

// 错误处理
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[Server] 未捕获错误:', err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
});

// 启动服务
async function start() {
  try {
    // 执行数据库迁移
    await migrate();

    // 启动定时任务
    startScheduler();

    // 启动HTTP服务
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] jlyl-cloud 服务已启动，端口: ${PORT}`);
      console.log(`[Server] 健康检查: http://localhost:${PORT}/health`);
    });
  } catch (e) {
    console.error('[Server] 启动失败:', e);
    process.exit(1);
  }
}

start();
