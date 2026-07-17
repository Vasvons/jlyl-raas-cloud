import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'jlyl-raas-cloud-secret-key-2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
// v2.0.0 P6：云端发布 Worker 内部认证密钥（Docker 内部网络通信，不走 JWT）
const WORKER_SECRET = process.env.WORKER_SECRET || '';

export function generateToken(payload: any): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
}

export function verifyToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Express 中间件：验证JWT
// v2.0.0 P6：支持云端 Worker 通过 X-Worker-Secret 头认证（内部服务间通信）
export function authMiddleware(req: any, res: any, next: any) {
  // Worker 内部认证：X-Worker-Secret 匹配时跳过 JWT
  if (WORKER_SECRET && req.headers['x-worker-secret'] === WORKER_SECRET) {
    req.user = { id: 0, level: '1', isWorker: true, username: 'cloud-worker' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }

  req.user = decoded;
  next();
}

// 管理员中间件
// v2.2.15：仅用于"用户管理"这类系统级管理操作（如 auth 路由的 /list /create /update /delete）。
// 业务数据接口（AEO 报告、写作任务、客户列表等）只需 authMiddleware，因为登录的永远是管理员，
// level='0' 的"客户"是管理员管理的数据对象，不是登录用户，不存在"普通用户越权"的威胁模型。
export function adminMiddleware(req: any, res: any, next: any) {
  if (req.user?.level !== '1') {
    return res.status(403).json({ code: 403, message: '需要管理员权限' });
  }
  next();
}
