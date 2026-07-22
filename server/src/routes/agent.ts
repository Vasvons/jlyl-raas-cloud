import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { authMiddleware, hashPassword } from '../auth';
import {
  getAdminAccounts,
  createAdminAccount,
  getAgentAccounts,
  createAgentAccount,
  updateUserV2,
  deleteUser,
  assignAgentToAdmin,
  unassignAgentFromAdmin,
  getAgentsByAdminId,
  getAgentGrants,
  grantAgentModule,
  revokeAgentModule,
  recordAgentHeartbeat,
  bindAgentDevice,
  getAgentDevices,
  unbindAgentDevice,
  findUserById,
} from '../repository';

const router = Router();

// v2.5.35：代理客户端授权校验密钥（用于签名授权数据，防中间人篡改）
const LICENSE_SIGN_SECRET = process.env.LICENSE_SIGN_SECRET || 'jlyl-license-sign-secret-v2.5.35';
// 离线宽限期：7 天（单位：毫秒）
const OFFLINE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
// 每个代理最多绑定设备数
const MAX_DEVICES_PER_AGENT = 2;

// 所有接口都需要登录鉴权
router.use(authMiddleware);

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
}

/** 判断是否为超级管理员或管理员 */
function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'super_admin' || user?.role === 'admin' || user?.level === '1';
}

/** 判断是否为超级管理员 */
function isSuperAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'super_admin' || (user?.level === '1' && user?.role !== 'admin');
}

/** 对授权数据签名（HMAC-SHA256），防中间人篡改 */
function signGrants(grants: any[]): string {
  const json = JSON.stringify(grants);
  return crypto.createHmac('sha256', LICENSE_SIGN_SECRET).update(json).digest('hex');
}

// ============ 管理员管理 ============

// 查询管理员列表
router.get('/admins', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const list = await getAdminAccounts();
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 创建管理员账号
router.post('/admins', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能创建管理员' });
  try {
    const { username, password, phone, email } = req.body;
    if (!username || !password) return res.status(400).json({ code: 400, message: '用户名和密码必填' });
    const hashed = await hashPassword(password);
    const id = await createAdminAccount({ username, password: hashed, phone, email });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 更新管理员（密码/手机/邮箱/状态）
router.put('/admins/:id', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能修改管理员' });
  try {
    const id = Number(req.params.id);
    const data: any = {};
    if (req.body.password) data.password = await hashPassword(req.body.password);
    if (req.body.phone !== undefined) data.phone = req.body.phone;
    if (req.body.email !== undefined) data.email = req.body.email;
    if (req.body.status !== undefined) data.status = req.body.status;
    await updateUserV2(id, data);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 删除管理员
router.delete('/admins/:id', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能删除管理员' });
  try {
    const id = Number(req.params.id);
    if (id === getUserId(req)) return res.status(400).json({ code: 400, message: '不能删除自己' });
    await deleteUser(id);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询某管理员负责的代理
router.get('/admins/:id/agents', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const list = await getAgentsByAdminId(Number(req.params.id));
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 分配代理给管理员
router.post('/admins/:id/agents', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能分配代理' });
  try {
    const adminId = Number(req.params.id);
    const agentId = Number(req.body.agent_id);
    if (!agentId) return res.status(400).json({ code: 400, message: 'agent_id 必填' });
    await assignAgentToAdmin(adminId, agentId);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 取消代理与管理员的分配
router.delete('/admins/:id/agents/:agentId', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能取消分配' });
  try {
    await unassignAgentFromAdmin(Number(req.params.id), Number(req.params.agentId));
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理管理 ============

// 查询代理列表
router.get('/agents', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const list = await getAgentAccounts();
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 创建代理账号
router.post('/agents', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { username, password, phone, email, parent_admin_id, expire_at } = req.body;
    if (!username || !password) return res.status(400).json({ code: 400, message: '用户名和密码必填' });
    const hashed = await hashPassword(password);
    const result = await createAgentAccount({
      username, password: hashed, phone, email,
      parent_admin_id: parent_admin_id ? Number(parent_admin_id) : undefined,
      expire_at: expire_at ? new Date(expire_at) : null,
    });
    res.json({ code: 200, data: result });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 更新代理（密码/手机/邮箱/状态/到期时间/归属管理员）
router.put('/agents/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const data: any = {};
    if (req.body.password) data.password = await hashPassword(req.body.password);
    if (req.body.phone !== undefined) data.phone = req.body.phone;
    if (req.body.email !== undefined) data.email = req.body.email;
    if (req.body.status !== undefined) data.status = req.body.status;
    if (req.body.parent_admin_id !== undefined) data.parent_admin_id = req.body.parent_admin_id ? Number(req.body.parent_admin_id) : null;
    if (req.body.expire_at !== undefined) data.expire_at = req.body.expire_at ? new Date(req.body.expire_at) : null;
    await updateUserV2(id, data);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 删除代理
router.delete('/agents/:id', async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ code: 403, message: '只有超级管理员能删除代理' });
  try {
    await deleteUser(Number(req.params.id));
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询某代理的板块授权
router.get('/agents/:id/grants', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const list = await getAgentGrants(Number(req.params.id));
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 授权代理使用某板块
router.post('/agents/:id/grants', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const agentUserId = Number(req.params.id);
    const { module_code, expire_at, config } = req.body;
    if (!module_code) return res.status(400).json({ code: 400, message: 'module_code 必填' });
    await grantAgentModule({
      agent_user_id: agentUserId,
      module_code,
      granted_by: getUserId(req),
      expire_at: expire_at ? new Date(expire_at) : null,
      config,
    });
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 撤销代理某板块授权
router.delete('/agents/:id/grants/:moduleCode', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    await revokeAgentModule(Number(req.params.id), req.params.moduleCode);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询某代理已绑定的设备
router.get('/agents/:id/devices', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const list = await getAgentDevices(Number(req.params.id));
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 解绑代理设备
router.delete('/agents/:id/devices/:machineId', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    await unbindAgentDevice(Number(req.params.id), req.params.machineId);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理客户端授权校验（代理自身调用） ============

// 查询自己的授权（代理客户端启动时调用）
router.get('/my-grants', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    const grants = await getAgentGrants(userId);
    const activeGrants = grants.filter((g: any) =>
      g.status === 'active' && (!g.expire_at || new Date(g.expire_at) > new Date())
    );
    const user = await findUserById(userId);

    res.json({
      code: 200,
      data: {
        grants: activeGrants,
        expire_at: (user as any)?.expire_at,
        status: (user as any)?.status,
        role: (user as any)?.role,
        server_time: new Date().toISOString(),
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 授权校验 + 心跳（代理客户端每 5 分钟调用一次）
router.post('/verify-license', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    const { client_version, machine_id, machine_info } = req.body;

    // 1. 校验账号状态
    const user = await findUserById(userId);
    if (!user) return res.json({ code: 403, valid: false, reason: '账号不存在' });
    if ((user as any).role !== 'agent') {
      return res.json({ code: 403, valid: false, reason: '非代理账号，无权使用代理客户端' });
    }
    if ((user as any).status === 'disabled') {
      return res.json({ code: 403, valid: false, reason: '账号已被禁用，请联系管理员' });
    }
    if ((user as any).status === 'expired' || ((user as any).expire_at && new Date((user as any).expire_at) < new Date())) {
      return res.json({ code: 403, valid: false, reason: '账号已过期，请联系管理员续费' });
    }

    // 2. 设备绑定校验（每个 license 默认 2 台）
    if (machine_id) {
      const ok = await bindAgentDevice(userId, machine_id, machine_info, MAX_DEVICES_PER_AGENT);
      if (!ok) {
        return res.json({
          code: 403, valid: false,
          reason: `超出设备数量限制（最多 ${MAX_DEVICES_PER_AGENT} 台），请联系管理员解绑旧设备`,
        });
      }
    }

    // 3. 记录心跳
    await recordAgentHeartbeat({
      agent_user_id: userId,
      client_version,
      ip: req.ip,
      machine_id,
    });

    // 4. 拉取有效授权
    const grants = await getAgentGrants(userId);
    const activeGrants = grants.filter((g: any) =>
      g.status === 'active' && (!g.expire_at || new Date(g.expire_at) > new Date())
    );

    // 5. 签名返回（防中间人篡改）
    const signature = signGrants(activeGrants);

    res.json({
      code: 200,
      valid: true,
      grants: activeGrants,
      expire_at: (user as any).expire_at,
      status: (user as any).status,
      server_time: new Date().toISOString(),
      offline_grace_ms: OFFLINE_GRACE_PERIOD_MS,
      signature,
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理客户端心跳（代理自身调用） ============

router.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    const { client_version, machine_id, machine_info } = req.body;

    // 记录心跳
    await recordAgentHeartbeat({
      agent_user_id: userId,
      client_version,
      ip: req.ip,
      machine_id,
    });

    // 设备绑定（每个 license 默认 2 台）
    if (machine_id) {
      const ok = await bindAgentDevice(userId, machine_id, machine_info, MAX_DEVICES_PER_AGENT);
      if (!ok) {
        return res.json({ code: 403, message: `超出设备数量限制（最多 ${MAX_DEVICES_PER_AGENT} 台），请联系管理员解绑旧设备` });
      }
    }

    // 返回最新授权状态
    const grants = await getAgentGrants(userId);
    const activeGrants = grants.filter((g: any) => g.status === 'active' && (!g.expire_at || new Date(g.expire_at) > new Date()));
    const user = await findUserById(userId);

    res.json({
      code: 200,
      data: {
        grants: activeGrants,
        expire_at: (user as any)?.expire_at,
        status: (user as any)?.status,
        server_time: new Date().toISOString(),
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
