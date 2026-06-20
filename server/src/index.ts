import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { migrate } from './migrate';
import { startScheduler, getSchedulerStatus } from './scheduler';
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

// 健康检查（含数据库连接诊断）
app.get('/health', async (req, res) => {
  const result: any = { status: 'ok', timestamp: new Date().toISOString() };
  try {
    const { query } = require('./db');
    const dbResult = await query('SELECT 1 as test');
    result.db = 'ok';
    result.dbTest = dbResult.rows[0];
  } catch (e: any) {
    result.db = 'error';
    result.dbError = e.message;
    result.status = 'degraded';
  }
  res.json(result);
});

// 诊断接口（返回详细错误信息，便于排查）
app.get('/diagnose', async (req, res) => {
  const result: any = { timestamp: new Date().toISOString(), checks: {} };
  // 检查数据库连接
  try {
    const { query } = require('./db');
    const start = Date.now();
    await query('SELECT 1 as test');
    result.checks.db = { status: 'ok', latency: Date.now() - start };
  } catch (e: any) {
    result.checks.db = { status: 'error', message: e.message, code: e.code };
  }
  // 检查关键表
  try {
    const { query } = require('./db');
    const tables = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    result.checks.tables = { status: 'ok', count: tables.rows.length, names: tables.rows.map((r: any) => r.table_name) };
  } catch (e: any) {
    result.checks.tables = { status: 'error', message: e.message };
  }
  // 检查pt表
  try {
    const { query } = require('./db');
    const ptCount = await query('SELECT COUNT(*) as count FROM pt');
    result.checks.ptTable = { status: 'ok', count: parseInt(ptCount.rows[0].count) };
  } catch (e: any) {
    result.checks.ptTable = { status: 'error', message: e.message, code: e.code };
  }
  // 检查数据时间逻辑状态
  try {
    const { query } = require('./db');
    const totalCount = await query('SELECT COUNT(*) as count FROM keyword_search_rank');
    const collectedCount = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE query_time IS NOT NULL');
    const pendingCount = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE query_time IS NULL');
    const futureCount = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE query_time > CURRENT_TIMESTAMP');
    const sample = await query('SELECT query_time, create_time FROM keyword_search_rank WHERE query_time IS NOT NULL ORDER BY query_time DESC LIMIT 5');
    // 任务状态概览
    const taskStats = await query(
      `SELECT status, COUNT(*) as count, 
              string_agg(id::text, ',') as task_ids,
              MAX(total_num) as max_total
       FROM task_info GROUP BY status ORDER BY status`
    );
    result.checks.dataTimeLogic = {
      status: parseInt(futureCount.rows[0].count) === 0 ? 'ok' : 'future_data',
      totalRecords: parseInt(totalCount.rows[0].count),
      collectedRecords: parseInt(collectedCount.rows[0].count),
      pendingRecords: parseInt(pendingCount.rows[0].count),
      futureRecords: parseInt(futureCount.rows[0].count),
      sample: sample.rows.map((r: any) => ({ queryTime: r.query_time, createTime: r.create_time })),
      tasks: taskStats.rows.map((t: any) => ({ status: t.status, count: parseInt(t.count), taskIds: t.task_ids, maxTotal: t.max_total })),
    };
  } catch (e: any) {
    result.checks.dataTimeLogic = { status: 'error', message: e.message };
  }
  // 调度器状态
  try {
    result.checks.scheduler = getSchedulerStatus();
  } catch (e: any) {
    result.checks.scheduler = { status: 'error', message: e.message };
  }
  res.json(result);
});

// 手动修正数据时间逻辑（无需重启服务即可执行）
app.post('/fix-data', async (req, res) => {
  try {
    const { query } = require('./db');
    // 1. 历史数据（今天之前）：create_time = query_time（模拟的收录时间）
    const fixHistory = await query(
      `UPDATE keyword_search_rank SET create_time = query_time, update_time = query_time
       WHERE create_time::date < CURRENT_DATE AND query_time IS NOT NULL AND query_time != create_time`
    );
    // 2. 今日数据：query_time = create_time（实际生成时间）
    const fixToday = await query(
      `UPDATE keyword_search_rank SET query_time = create_time
       WHERE create_time::date = CURRENT_DATE AND query_time IS NOT NULL AND query_time != create_time`
    );
    // 3. 今日待收录数据：设为已收录
    const fixPending = await query(
      `UPDATE keyword_search_rank SET query_time = create_time
       WHERE query_time IS NULL AND create_time::date = CURRENT_DATE`
    );
    res.json({
      code: 200,
      message: '数据修正完成',
      data: {
        historyFixed: fixHistory.rowCount || 0,
        todayFixed: fixToday.rowCount || 0,
        pendingFixed: fixPending.rowCount || 0,
      },
    });
  } catch (e: any) {
    res.json({ code: 500, message: '修正失败: ' + e.message });
  }
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
