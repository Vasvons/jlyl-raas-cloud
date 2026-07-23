import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { migrate } from './migrate';
import { seedStepLists } from './services/content/stepListSeeder';
import { startScheduler, getSchedulerStatus } from './scheduler';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import taskRoutes from './routes/task';
import keywordRoutes from './routes/keyword';
import monitorRoutes from './routes/monitor';
import realCollectTaskRoutes from './routes/realCollectTask';
import realCollectResultRoutes from './routes/realCollectResult';
import realCollectQueueRoutes from './routes/realCollectQueue';
import platformAuthRoutes from './routes/platformAuth';
import workerLogRoutes from './routes/workerLog';
import aeoRoutes from './routes/aeo';
import contentRoutes from './routes/content';
import agentRoutes from './routes/agent';
import updateRoutes from './routes/update';
import subscriptionRoutes, { wechatNotifyHandler } from './routes/subscription';
import workerRoutes, { startWorkerExpiryScheduler } from './routes/worker';
import moduleRoutes from './routes/module';
import portalRoutes from './routes/portal';
import { startRealCollectScheduler } from './services/realCollect/scheduler';
import { startAeoScheduler } from './services/aeo/scheduler';
import { initWsServer } from './wsServer';

dotenv.config();

// ===== 内存日志缓冲（启动时立即接管 console，捕获所有日志）=====
// 通过 GET /debug/memory-logs?filter=AI&lines=200 在线查看，无需上服务器
const memoryLogs: string[] = [];
const MAX_MEMORY_LOGS = 2000;
const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
function pushLog(level: string, args: any[]) {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ')}`;
    memoryLogs.push(line);
    if (memoryLogs.length > MAX_MEMORY_LOGS) memoryLogs.shift();
  } catch { /* 避免日志缓冲自身报错导致进程崩溃 */ }
}
console.log = (...args: any[]) => { pushLog('log', args); origConsoleLog(...args); };
console.warn = (...args: any[]) => { pushLog('warn', args); origConsoleWarn(...args); };
console.error = (...args: any[]) => { pushLog('error', args); origConsoleError(...args); };

const app = express();
const PORT = parseInt(process.env.PORT || '3002');

// 中间件
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) || [];
app.use(cors({
  origin: (origin, callback) => {
    // 允许的来源：白名单 + 本地开发环境（桌面端 Electron / file:// / localhost）
    const isLocal = !origin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('file://');
    if (isLocal || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
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
  // 简单鉴权：需要 admin token（未配置 ADMIN_TOKEN 时放行，开发环境兼容）
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (token !== adminToken) {
      return res.status(403).json({ code: 403, message: '需要管理员权限' });
    }
  }
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
    // 数据库时间和时区
    const dbTimeResult = await query("SELECT NOW() as now, CURRENT_TIMESTAMP as ct, current_setting('timezone') as tz, clock_timestamp() as clock");
    // 任务状态概览
    const taskStats = await query(
      `SELECT status, COUNT(*) as count, 
              string_agg(id::text, ',') as task_ids,
              MAX(total_num) as max_total
       FROM task_info GROUP BY status ORDER BY status`
    );
    // 运行中任务的详细信息（含对应用户的date_time）
    const runningTasksDetail = await query(
      `SELECT t.id, t.user_id, t.status, t.total_num, t.start_date, t.end_date,
              u.username, u.date_time,
              (SELECT COUNT(*) FROM keyword_search_rank WHERE task_id = t.id) as generated_num,
              (SELECT COUNT(*) FROM keyword_search_rank WHERE task_id = t.id AND query_time IS NULL) as pending_num
       FROM task_info t
       LEFT JOIN users u ON u.id::text = t.user_id::text
       WHERE t.status = 'running'
       ORDER BY t.id`
    );
    // 所有用户列表（含level，用于诊断分享链接问题）
    const usersList = await query(
      `SELECT id, username, level, date_time FROM users ORDER BY id`
    );
    // 最近的分享token
    const recentShareTokens = await query(
      `SELECT id, user_id, username, create_time, expire_time, last_use_time FROM share_tokens ORDER BY create_time DESC LIMIT 10`
    );
    result.checks.dataTimeLogic = {
      status: parseInt(futureCount.rows[0].count) === 0 ? 'ok' : 'future_data',
      totalRecords: parseInt(totalCount.rows[0].count),
      collectedRecords: parseInt(collectedCount.rows[0].count),
      pendingRecords: parseInt(pendingCount.rows[0].count),
      futureRecords: parseInt(futureCount.rows[0].count),
      dbTime: {
        now: dbTimeResult.rows[0].now,
        currentTimestamp: dbTimeResult.rows[0].ct,
        clockTimestamp: dbTimeResult.rows[0].clock,
        timezone: dbTimeResult.rows[0].tz,
      },
      sample: sample.rows.map((r: any) => ({ queryTime: r.query_time, createTime: r.create_time })),
      tasks: taskStats.rows.map((t: any) => ({ status: t.status, count: parseInt(t.count), taskIds: t.task_ids, maxTotal: t.max_total })),
      runningTasksDetail: runningTasksDetail.rows.map((r: any) => ({
        taskId: r.id,
        userId: r.user_id,
        username: r.username,
        status: r.status,
        totalNum: r.total_num,
        generatedNum: parseInt(r.generated_num),
        pendingNum: parseInt(r.pending_num),
        startDate: r.start_date,
        endDate: r.end_date,
        dateTime: r.date_time,
      })),
      users: usersList.rows.map((u: any) => ({ id: u.id, username: u.username, level: u.level, dateTime: u.date_time })),
      recentShareTokens: recentShareTokens.rows.map((t: any) => ({ id: t.id, userId: t.user_id, username: t.username, createTime: t.create_time, expireTime: t.expire_time, lastUseTime: t.last_use_time })),
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

// 手动触发查询展示（无需重启服务即可执行）
app.post('/fix-data', async (req, res) => {
  // 简单鉴权：需要 admin token（未配置 ADMIN_TOKEN 时放行，开发环境兼容）
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (token !== adminToken) {
      return res.status(403).json({ code: 403, message: '需要管理员权限' });
    }
  }
  try {
    const { query } = require('./db');
    // 将所有待展示数据（query_time IS NULL）设置为已展示
    // 使用 clock_timestamp() 确保返回实时时间
    const result = await query(
      `UPDATE keyword_search_rank SET query_time = clock_timestamp(), update_time = clock_timestamp()
       WHERE query_time IS NULL
       RETURNING user_id`
    );
    // 更新受影响用户的date_time为北京时间
    if (result.rows.length > 0) {
      const userIds = [...new Set(result.rows.map((r: any) => String(r.user_id)))];
      await query(
        `UPDATE users SET date_time = to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id::text = ANY($1::text[])`,
        [userIds]
      );
    }
    res.json({
      code: 200,
      message: '查询展示完成',
      data: {
        displayed: result.rows.length,
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
app.use('/real-collect/tasks', realCollectTaskRoutes);
app.use('/real-collect/results', realCollectResultRoutes);
app.use('/real-collect/queue', realCollectQueueRoutes);
app.use('/platform-auth', platformAuthRoutes);
app.use('/real-collect/logs', workerLogRoutes);
app.use('/aeo', aeoRoutes);
app.use('/content', contentRoutes);
// 注意：Nginx 配置 `proxy_pass http://127.0.0.1:3002/;`（末尾带 /）会剥离 /api/ 前缀
// 因此后端路由注册时不能带 /api 前缀，与其他路由保持一致
app.use('/agent', agentRoutes);
app.use('/updates', updateRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/worker', workerRoutes);
app.use('/module', moduleRoutes);
app.use('/portal', portalRoutes);

// 微信支付回调（无需鉴权，单独注册）
app.post('/subscription/wechat/notify', wechatNotifyHandler);

// ===== 临时调试 API：查看 server 内存日志（无需上服务器）=====
// 用法：GET /debug/memory-logs?lines=200&filter=AI
//       GET /debug/memory-logs?lines=500  （查看全部最近 500 行）
app.get('/debug/memory-logs', (req: any, res: any) => {
  const filter = req.query.filter as string;
  const lines = Math.min(Number(req.query.lines) || 200, memoryLogs.length);
  let result = memoryLogs.slice(-lines);
  if (filter) {
    result = result.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
  }
  res.json({ code: 200, data: { total: memoryLogs.length, returned: result.length, lines: result } });
});

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

    // 导入发布 step_list 种子数据（幂等，仅缺失平台才导入）
    await seedStepLists().catch(e => {
      console.error('[Server] step_list 种子导入失败（不阻断启动）:', e.message);
    });

    // 启动定时任务
    startScheduler();

    // 启动真实收录查询循环调度器（24/7持续执行，重启自动恢复）
    startRealCollectScheduler().catch(e => {
      console.error('[Server] 循环调度器启动失败:', e.message);
    });

    // 启动 AEO 日报调度器
    startAeoScheduler();

    // v2.4.0：启动 HTTP 服务 + 挂载 WebSocket 服务端
    // 复用 3002 端口，WS 路径 /ws，与 HTTP 路由互不冲突
    const httpServer = http.createServer(app);
    initWsServer(httpServer);
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] jlyl-cloud 服务已启动，端口: ${PORT}`);
      console.log(`[Server] 健康检查: http://localhost:${PORT}/health`);
      console.log(`[Server] WebSocket: ws://localhost:${PORT}/ws`);
    });

    // v2.5.36：启动 worker 到期回收调度器（在 WS 服务端初始化之后，确保 wsBroadcast 可用）
    // 每 5 分钟扫描：过期配额/授权码回收 + 心跳超时检测 + WS 通知代理客户端
    startWorkerExpiryScheduler();
  } catch (e) {
    console.error('[Server] 启动失败:', e);
    process.exit(1);
  }
}

start();
