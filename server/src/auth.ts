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
export function adminMiddleware(req: any, res: any, next: any) {
  if (req.user?.level !== '1') {
    return res.status(403).json({ code: 403, message: '需要管理员权限' });
  }
  next();
}

// ============ v2.2.12：统一权限中间件（替代各路由手写校验） ============
//
// 设计背景：
//   原系统管理员(level=1)与客户(level=0)在 users 表中是平级记录，无 parent_id 归属关系。
//   "管理员能看所有客户数据"完全靠在每个接口里手写 `if (level !== '1' && id !== userId) return 403` 实现，
//   写漏一个接口就会导致管理员看不到数据（如 v2.2.11 的 /aeo/results 403 bug）。
//
// 本中间件统一封装权限校验逻辑，所有带 userId 参数的接口都应走 requireAdminOrSelf。
// 未来若需"多管理员 + 客户归属"隔离，只需修改本中间件内部的校验逻辑，无需改动各路由。
//
// 权限模型：
//   - requireLogin：登录即可（= authMiddleware 的语义别名，保留可读性）
//   - requireAdmin：仅管理员（= adminMiddleware 的语义别名）
//   - requireAdminOrSelf(getUserId)：管理员放行；普通用户校验 getUserId(req) === req.user.id
//
// Worker 内部认证（X-Worker-Secret）已在 authMiddleware 中注入 level='1'，会自动通过 requireAdmin/requireAdminOrSelf。

/** 登录校验（语义别名，等价于 authMiddleware） */
export function requireLogin(req: any, res: any, next: any) {
  return authMiddleware(req, res, next);
}

/** 管理员校验（语义别名，等价于 adminMiddleware） */
export function requireAdmin(req: any, res: any, next: any) {
  return adminMiddleware(req, res, next);
}

/**
 * 管理员或本人校验：管理员放行，普通用户校验 getUserId(req) === req.user.id
 *
 * @param getUserId 从请求中提取目标 userId 的函数（支持 query.userId / body.userId / params.userId 等）
 *                  返回 string | number | undefined；undefined 表示请求未带 userId，此时只要求登录
 */
export function requireAdminOrSelf(getUserId: (req: any) => string | number | undefined) {
  return (req: any, res: any, next: any) => {
    // 先确保已登录（authMiddleware 已注入 req.user）
    if (!req.user) {
      return res.status(401).json({ code: 401, message: '未登录' });
    }
    // 管理员放行（Worker 内部认证也是 level='1'）
    if (req.user.level === '1') {
      return next();
    }
    // 普通用户：校验 userId 参数与当前登录用户一致
    const targetUserId = getUserId(req);
    if (targetUserId === undefined || targetUserId === null || targetUserId === '') {
      // 未带 userId 参数的请求，只要求登录（如查看自己的资源列表，由业务层用 req.user.id 过滤）
      return next();
    }
    if (String(req.user.id) !== String(targetUserId)) {
      return res.status(403).json({ code: 403, message: '无权访问其他用户的数据' });
    }
    next();
  };
}

/**
 * 资源归属校验：管理员放行，普通用户校验资源属于自己
 *
 * @param loader 加载资源的函数，返回 { userId: string | number | null } 或 null（资源不存在）
 *               缓存在 req.resource 中避免重复查询
 * @param idParam 资源 ID 的参数名，默认 'id'（从 req.params 取）
 */
export function requireAdminOrOwner(
  loader: (req: any) => Promise<{ userId: string | number | null } | null>,
  idParam: string = 'id'
) {
  return async (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ code: 401, message: '未登录' });
    }
    // 管理员放行
    if (req.user.level === '1') {
      return next();
    }
    // 普通用户：加载资源并校验归属
    try {
      const resource = await loader(req);
      if (!resource) {
        return res.status(404).json({ code: 404, message: '资源不存在' });
      }
      if (resource.userId === null || String(req.user.id) !== String(resource.userId)) {
        return res.status(403).json({ code: 403, message: '无权操作该资源' });
      }
      req.resource = resource; // 缓存供后续 handler 复用
      next();
    } catch (e: any) {
      console.error('[requireAdminOrOwner] 资源加载失败:', e.message);
      res.status(500).json({ code: 500, message: '资源校验失败' });
    }
  };
}
