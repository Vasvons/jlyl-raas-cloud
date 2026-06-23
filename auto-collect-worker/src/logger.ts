/**
 * 日志上报器：将 worker 运行日志上报到云端，供桌面端实时查看
 * 使用批量缓冲队列，减少 HTTP 请求频率
 */
import axios from 'axios';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

let currentTaskId: number | undefined = undefined;

// 日志缓冲队列
interface LogEntry {
  workerId: string;
  taskId?: number;
  level: string;
  message: string;
}
const logBuffer: LogEntry[] = [];
const FLUSH_INTERVAL = 2000; // 2秒刷新一次
const MAX_BUFFER_SIZE = 50;  // 满50条立即刷新

let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL);
}

async function flush(): Promise<void> {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, logBuffer.length);
  try {
    // 逐条上报（云端接口是单条），但用 Promise.all 并发
    await Promise.all(batch.map(entry =>
      axios.post(`${SERVER_URL}/real-collect/logs/report`, entry, { timeout: 5000 }).catch(() => {})
    ));
  } catch {
    // 静默忽略
  }
}

export function setTaskId(taskId: number | undefined): void {
  currentTaskId = taskId;
}

export async function log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  // 同时输出到控制台
  const logMsg = `[Worker] ${message}`;
  if (level === 'error') {
    console.error(logMsg);
  } else if (level === 'warn') {
    console.warn(logMsg);
  } else {
    console.log(logMsg);
  }

  // 加入缓冲队列
  logBuffer.push({
    workerId: WORKER_ID,
    taskId: currentTaskId,
    level,
    message,
  });

  // 启动定时刷新（如果未启动）
  startFlushTimer();

  // 缓冲满立即刷新
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    flush().catch(() => {});
  }
}

/** 带 taskId 的日志输出，避免全局状态在并发场景下错乱 */
export async function logWithTask(level: 'info' | 'warn' | 'error', taskId: number | undefined, message: string): Promise<void> {
  const prevTaskId = currentTaskId;
  currentTaskId = taskId;
  try {
    await log(level, message);
  } finally {
    currentTaskId = prevTaskId;
  }
}

export function info(message: string): Promise<void> { return log('info', message); }
export function warn(message: string): Promise<void> { return log('warn', message); }
export function error(message: string): Promise<void> { return log('error', message); }

/** 进程退出前刷新剩余日志 */
export async function flushLogs(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}
