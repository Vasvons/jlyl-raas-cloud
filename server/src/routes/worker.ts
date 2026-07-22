/**
 * Worker 管理路由（v2.5.36 阶段六：混合模式分布式架构）
 *
 * 三类接口：
 * 1. 私有部署：激活 / 心跳 / 解绑 / 状态查询
 * 2. 云端增强包：配额查询 / 容器状态
 * 3. 管理员：节点配置 CRUD / 容器实例查看 / 配额管理 / 手动启停
 *
 * 计费流程：订阅支付成功 → subscription.ts 回调 → 调用本模块 provisionCloudQuota
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { wsBroadcast } from '../wsServer';

const router = Router();

// 所有接口都需要登录鉴权，除了私有 worker 的 activate/heartbeat（用 LICENSE_KEY 鉴权）
router.use((req, res, next) => {
  const path = req.path;
  if (path === '/private-deploy/activate' || path === '/private-deploy/heartbeat') {
    return next();
  }
  return authMiddleware(req, res, next);
});

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
}

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.level === '1' || user?.role === 'super_admin' || user?.role === 'admin';
}

/** 生成随机授权码 */
function generateLicenseKey(): string {
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `JLYL-PD-${rand}`;
}

/** 生成 worker 内部 token（用于 worker 容器调用云端 API 鉴权） */
function generateWorkerToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

// ============================================================
// 第一部分：代理查询自己的 worker 配额 + 状态
// ============================================================

/**
 * 查询我的 worker 配额（含云端增强包 + 私有部署）
 * GET /worker/my-quota
 */
router.get('/my-quota', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    const result = await query(
      `SELECT id, quota_type, max_concurrency, source, expire_at, status,
              private_server_name, private_last_heartbeat,
              private_config, created_at
       FROM agent_worker_quota
       WHERE agent_user_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [userId]
    );

    // 聚合总并发数
    const totalConcurrency = result.rows.reduce(
      (sum: number, r: any) => sum + Number(r.max_concurrency || 0),
      0
    );

    // 查询当前在跑的 worker 实例
    const instances = await query(
      `SELECT instance_id, worker_type, status, started_at, last_heartbeat, server_node
       FROM worker_instance
       WHERE agent_user_id = $1 AND status IN ('starting', 'running')
       ORDER BY started_at DESC`,
      [userId]
    );

    res.json({
      code: 200,
      data: {
        quotas: result.rows,
        total_concurrency: totalConcurrency,
        running_instances: instances.rows,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 本地 worker 心跳（桌面端内置 worker 上报）
 * POST /worker/local-heartbeat
 * body: { worker_id, agent_user_id, fingerprint, hostname }
 */
router.post('/local-heartbeat', async (req: Request, res: Response) => {
  try {
    const { worker_id, agent_user_id, fingerprint, hostname } = req.body || {};
    if (!worker_id || !agent_user_id) {
      return res.status(400).json({ code: 400, message: 'worker_id 和 agent_user_id 必填' });
    }

    // 更新或创建 worker_instance 记录
    await query(
      `INSERT INTO worker_instance
       (instance_id, worker_type, agent_user_id, server_node, status, max_concurrency, started_at, last_heartbeat)
       VALUES ($1, 'local', $2, $3, 'running', 1, COALESCE((SELECT started_at FROM worker_instance WHERE instance_id = $1), NOW()), NOW())
       ON CONFLICT (instance_id) DO UPDATE
       SET last_heartbeat = NOW(), status = 'running', agent_user_id = $2`,
      [worker_id, Number(agent_user_id), hostname || 'local-desktop']
    );

    res.json({ code: 200, data: { ok: true } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============================================================
// 第二部分：私有部署（激活 / 心跳 / 解绑 / 查询授权码）
// ============================================================

/**
 * 查询我的私有部署授权码（支付成功后调用）
 * GET /worker/private-deploy/licenses
 */
router.get('/private-deploy/licenses', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    const result = await query(
      `SELECT id, license_key, server_name, server_fingerprint, max_concurrency,
              status, activated_at, expire_at, last_heartbeat, created_at
       FROM private_deploy_license
       WHERE agent_user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 激活私有部署授权码（worker 容器启动时调用）
 * POST /worker/private-deploy/activate
 * body: { license_key, server_fingerprint, server_name, max_concurrency }
 *
 * 注意：此接口不需要 authMiddleware（worker 用 license_key 鉴权）
 *   但因为 router.use(authMiddleware) 全局生效，这里用 license_key 作为二次鉴权
 */
router.post('/private-deploy/activate', async (req: Request, res: Response) => {
  try {
    const { license_key, server_fingerprint, server_name, max_concurrency } = req.body || {};
    if (!license_key || !server_fingerprint) {
      return res.status(400).json({ code: 400, message: 'license_key 和 server_fingerprint 必填' });
    }

    // 查询授权码
    const licenseResult = await query(
      `SELECT id, agent_user_id, status, server_fingerprint, expire_at
       FROM private_deploy_license
       WHERE license_key = $1`,
      [license_key]
    );
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '授权码不存在' });
    }
    const license = licenseResult.rows[0];

    // 检查授权状态
    if (license.status === 'expired' || license.status === 'revoked') {
      return res.status(403).json({ code: 403, message: `授权已${license.status === 'expired' ? '过期' : '吊销'}` });
    }
    if (license.expire_at && new Date(license.expire_at) < new Date()) {
      await query(`UPDATE private_deploy_license SET status = 'expired' WHERE id = $1`, [license.id]);
      return res.status(403).json({ code: 403, message: '授权已过期' });
    }

    // 检查指纹绑定：一机一码
    if (license.server_fingerprint && license.server_fingerprint !== server_fingerprint) {
      return res.status(403).json({
        code: 403,
        message: '授权码已绑定其他服务器，请联系管理员解绑后重新激活',
      });
    }

    // 激活（首次激活或重新激活同一台机器）
    await query(
      `UPDATE private_deploy_license
       SET server_fingerprint = $1, server_name = $2, max_concurrency = $3,
           status = 'active', activated_at = COALESCE(activated_at, NOW()),
           last_heartbeat = NOW()
       WHERE id = $4`,
      [server_fingerprint, server_name || '未命名服务器', Number(max_concurrency) || 8, license.id]
    );

    // 写入配额表
    await query(
      `INSERT INTO agent_worker_quota
       (agent_user_id, quota_type, max_concurrency, source, status, private_server_id,
        private_server_name, private_last_heartbeat, expire_at)
       VALUES ($1, 'private', $2, 'private', 'active', $3, $4, NOW(), $5)
       ON CONFLICT ON CONSTRAINT agent_worker_quota_pkey DO NOTHING`,
      [
        license.agent_user_id,
        Number(max_concurrency) || 8,
        server_fingerprint,
        server_name || '未命名服务器',
        license.expire_at,
      ]
    );
    // 如果 ON CONFLICT 没触发（没主键冲突），用 UPSERT 按 (agent_user_id, source, private_server_id) 更新
    await query(
      `UPDATE agent_worker_quota
       SET max_concurrency = $1, status = 'active', private_last_heartbeat = NOW(),
           expire_at = $2, updated_at = NOW()
       WHERE agent_user_id = $3 AND source = 'private' AND private_server_id = $4`,
      [Number(max_concurrency) || 8, license.expire_at, license.agent_user_id, server_fingerprint]
    );

    // 生成 worker token
    const workerToken = generateWorkerToken();

    console.log(`[Worker] 私有部署激活成功: agent=${license.agent_user_id}, server=${server_name}, fp=${server_fingerprint.substring(0, 16)}...`);

    res.json({
      code: 200,
      data: {
        worker_token: workerToken,
        agent_user_id: license.agent_user_id,
        max_concurrency: Number(max_concurrency) || 8,
        expire_at: license.expire_at,
        server_url: process.env.PUBLIC_SERVER_URL || 'https://report.jlyl.net.cn',
      },
    });
  } catch (e: any) {
    console.error('[Worker] 私有部署激活失败:', e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 私有 worker 心跳（每 60 秒上报一次）
 * POST /worker/private-deploy/heartbeat
 * body: { license_key, server_fingerprint, cpu_percent, memory_mb, current_tasks }
 */
router.post('/private-deploy/heartbeat', async (req: Request, res: Response) => {
  try {
    const { license_key, server_fingerprint, cpu_percent, memory_mb, current_tasks } = req.body || {};
    if (!license_key || !server_fingerprint) {
      return res.status(400).json({ code: 400, message: 'license_key 和 server_fingerprint 必填' });
    }

    const licenseResult = await query(
      `SELECT id, agent_user_id, status, expire_at FROM private_deploy_license
       WHERE license_key = $1 AND server_fingerprint = $2`,
      [license_key, server_fingerprint]
    );
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '授权码或服务器指纹不匹配' });
    }
    const license = licenseResult.rows[0];

    if (license.status !== 'active') {
      return res.status(403).json({ code: 403, message: `授权状态异常: ${license.status}` });
    }
    if (license.expire_at && new Date(license.expire_at) < new Date()) {
      await query(`UPDATE private_deploy_license SET status = 'expired' WHERE id = $1`, [license.id]);
      return res.status(403).json({ code: 403, message: '授权已过期' });
    }

    // 更新心跳时间
    await query(
      `UPDATE private_deploy_license
       SET last_heartbeat = NOW()
       WHERE id = $1`,
      [license.id]
    );
    await query(
      `UPDATE agent_worker_quota
       SET private_last_heartbeat = NOW(), updated_at = NOW()
       WHERE agent_user_id = $1 AND source = 'private' AND private_server_id = $2`,
      [license.agent_user_id, server_fingerprint]
    );

    res.json({
      code: 200,
      data: { ok: true, server_time: new Date().toISOString() },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 解绑私有部署服务器（代理自己解绑或管理员强制解绑）
 * POST /worker/private-deploy/unbind
 * body: { license_key }
 */
router.post('/private-deploy/unbind', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { license_key } = req.body || {};
    if (!license_key) return res.status(400).json({ code: 400, message: 'license_key 必填' });

    const licenseResult = await query(
      `SELECT id, agent_user_id FROM private_deploy_license WHERE license_key = $1`,
      [license_key]
    );
    if (licenseResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '授权码不存在' });
    }
    const license = licenseResult.rows[0];

    // 权限检查：本人或管理员
    if (!isAdmin(req) && Number(license.agent_user_id) !== userId) {
      return res.status(403).json({ code: 403, message: '无权限' });
    }

    // 解绑：清空指纹，状态改为 pending（可重新激活）
    await query(
      `UPDATE private_deploy_license
       SET server_fingerprint = NULL, status = 'pending', last_heartbeat = NULL
       WHERE id = $1`,
      [license.id]
    );
    // 停用配额
    await query(
      `UPDATE agent_worker_quota
       SET status = 'revoked', updated_at = NOW()
       WHERE agent_user_id = $1 AND source = 'private'`,
      [license.agent_user_id]
    );

    console.log(`[Worker] 私有部署解绑: license=${license_key.substring(0, 16)}..., agent=${license.agent_user_id}`);

    res.json({ code: 200, message: '解绑成功，授权码可重新激活' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============================================================
// 第三部分：管理员 - Worker 节点配置 CRUD
// ============================================================

/**
 * 查询所有 worker 节点
 * GET /worker/admin/nodes
 */
router.get('/admin/nodes', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT * FROM worker_node_config ORDER BY created_at ASC`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 新增 worker 节点
 * POST /worker/admin/nodes
 * body: { node_name, docker_host, docker_tls_cert_path, api_version, max_replicas, config }
 */
router.post('/admin/nodes', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { node_name, docker_host, docker_tls_cert_path, api_version, max_replicas, config } = req.body || {};
    if (!node_name || !docker_host) {
      return res.status(400).json({ code: 400, message: 'node_name 和 docker_host 必填' });
    }
    const result = await query(
      `INSERT INTO worker_node_config
       (node_name, docker_host, docker_tls_cert_path, api_version, max_replicas, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        node_name,
        docker_host,
        docker_tls_cert_path || null,
        api_version || 'v1.41',
        Number(max_replicas) || 4,
        config ? JSON.stringify(config) : null,
      ]
    );
    res.json({ code: 200, data: { id: result.rows[0].id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 编辑 worker 节点
 * PUT /worker/admin/nodes/:id
 */
router.put('/admin/nodes/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { node_name, docker_host, docker_tls_cert_path, api_version, max_replicas, config, status } = req.body || {};
    await query(
      `UPDATE worker_node_config
       SET node_name = COALESCE($1, node_name),
           docker_host = COALESCE($2, docker_host),
           docker_tls_cert_path = COALESCE($3, docker_tls_cert_path),
           api_version = COALESCE($4, api_version),
           max_replicas = COALESCE($5, max_replicas),
           config = COALESCE($6, config),
           status = COALESCE($7, status),
           updated_at = NOW()
       WHERE id = $8`,
      [
        node_name || null,
        docker_host || null,
        docker_tls_cert_path || null,
        api_version || null,
        max_replicas ?? null,
        config ? JSON.stringify(config) : null,
        status || null,
        id,
      ]
    );
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 删除 worker 节点
 * DELETE /worker/admin/nodes/:id
 */
router.delete('/admin/nodes/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    await query(`DELETE FROM worker_node_config WHERE id = $1`, [Number(req.params.id)]);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 测试 worker 节点连通性（测试 docker daemon 远程 API 是否可访问）
 * POST /worker/admin/nodes/:id/test
 */
router.post('/admin/nodes/:id/test', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const nodeResult = await query(`SELECT * FROM worker_node_config WHERE id = $1`, [Number(req.params.id)]);
    if (nodeResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '节点不存在' });
    }
    const node = nodeResult.rows[0];

    // 调用 docker daemon /info 接口测试连通性
    const startTime = Date.now();
    const testResult = await testDockerDaemon(node.docker_host, node.api_version || 'v1.41');
    const elapsed = Date.now() - startTime;

    // 更新节点状态
    await query(
      `UPDATE worker_node_config SET status = $1, last_check_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [testResult.ok ? 'online' : 'offline', node.id]
    );

    if (testResult.ok) {
      res.json({
        code: 200,
        data: {
          ok: true,
          elapsed_ms: elapsed,
          docker_version: testResult.docker_version,
          containers: testResult.containers,
          os: testResult.os,
          arch: testResult.arch,
          mem_total_mb: testResult.mem_total_mb,
        },
      });
    } else {
      res.json({ code: 200, data: { ok: false, error: testResult.error, elapsed_ms: elapsed } });
    }
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 查询所有 worker 容器实例
 * GET /worker/admin/instances
 */
router.get('/admin/instances', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT wi.*, u.username as agent_name
       FROM worker_instance wi
       LEFT JOIN users u ON u.id = wi.agent_user_id
       ORDER BY wi.created_at DESC
       LIMIT 500`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 查询所有代理的配额（管理员视图）
 * GET /worker/admin/quotas
 */
router.get('/admin/quotas', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT q.*, u.username as agent_name
       FROM agent_worker_quota q
       LEFT JOIN users u ON u.id = q.agent_user_id
       ORDER BY q.created_at DESC
       LIMIT 500`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 管理员手动停止某代理的 worker 容器
 * POST /worker/admin/instances/:id/stop
 */
router.post('/admin/instances/:id/stop', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const instanceResult = await query(`SELECT * FROM worker_instance WHERE id = $1`, [id]);
    if (instanceResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '实例不存在' });
    }
    const instance = instanceResult.rows[0];

    // 调用 docker daemon 停止容器
    const nodeResult = await query(`SELECT * FROM worker_node_config WHERE node_name = $1`, [instance.server_node]);
    if (nodeResult.rows.length > 0) {
      const node = nodeResult.rows[0];
      await stopDockerContainer(node.docker_host, node.api_version || 'v1.41', instance.instance_id);
    }

    await query(`UPDATE worker_instance SET status = 'stopped' WHERE id = $1`, [id]);
    res.json({ code: 200, message: '停止成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============================================================
// 第四部分：供 subscription.ts 调用的配额开通函数
// ============================================================

/**
 * 开通云端 worker 增强包配额（订单支付成功后调用）
 * 不走 HTTP，直接被 subscription.ts import 调用
 */
export async function provisionCloudQuota(
  agentUserId: number,
  orderId: number,
  planCode: string,
  expireAt: Date
): Promise<{ quota_id: number; max_concurrency: number }> {
  // 从套餐编码解析并发数（如 cloud_worker_10_monthly → 10）
  const match = planCode.match(/cloud_worker_(\d+)_/);
  const maxConcurrency = match ? parseInt(match[1]) : 2;

  const result = await query(
    `INSERT INTO agent_worker_quota
     (agent_user_id, quota_type, max_concurrency, source, order_id, expire_at, status)
     VALUES ($1, 'cloud', $2, 'cloud', $3, $4, 'active')
     RETURNING id, max_concurrency`,
    [agentUserId, maxConcurrency, orderId, expireAt]
  );

  console.log(`[Worker] 云端增强包开通: agent=${agentUserId}, concurrency=${maxConcurrency}, expire=${expireAt.toISOString()}`);

  // 尝试启动 worker 容器（非阻塞，失败不影响订单）
  try {
    await startCloudWorkerContainers(agentUserId, maxConcurrency);
  } catch (e: any) {
    console.warn(`[Worker] 启动容器失败（不阻断）:`, e.message);
  }

  return {
    quota_id: result.rows[0].id,
    max_concurrency: maxConcurrency,
  };
}

/**
 * 开通私有部署授权码（订单支付成功后调用）
 */
export async function provisionPrivateDeployLicense(
  agentUserId: number,
  orderId: number,
  expireAt: Date
): Promise<{ license_key: string }> {
  const licenseKey = generateLicenseKey();
  await query(
    `INSERT INTO private_deploy_license
     (license_key, agent_user_id, order_id, status, expire_at)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [licenseKey, agentUserId, orderId, expireAt]
  );

  console.log(`[Worker] 私有部署授权码生成: agent=${agentUserId}, key=${licenseKey.substring(0, 16)}...`);

  return { license_key: licenseKey };
}

// ============================================================
// 第五部分：内部工具函数 - Docker Daemon 远程 API
// ============================================================

/**
 * 测试 docker daemon 连通性
 */
async function testDockerDaemon(
  dockerHost: string,
  apiVersion: string
): Promise<{
  ok: boolean;
  docker_version?: string;
  containers?: number;
  os?: string;
  arch?: string;
  mem_total_mb?: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const url = `${dockerHost}/${apiVersion}/info`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        method: 'GET',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const info = JSON.parse(data);
              resolve({
                ok: true,
                docker_version: info.ServerVersion,
                containers: info.Containers,
                os: info.OperatingSystem,
                arch: info.Architecture,
                mem_total_mb: info.MemTotal ? Math.round(info.MemTotal / 1024 / 1024) : 0,
              });
            } catch {
              resolve({ ok: false, error: '响应解析失败' });
            }
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          }
        });
      }
    );

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('连接超时'));
      resolve({ ok: false, error: '连接超时（10s）' });
    });
    req.end();
  });
}

/**
 * 启动云端 worker 容器（为代理分配专属容器）
 * 策略：轮询选择一个在线的 worker 节点，创建 N 个容器（N = 并发数/2，每容器并发 2）
 */
async function startCloudWorkerContainers(agentUserId: number, maxConcurrency: number): Promise<void> {
  // 查询在线节点
  const nodesResult = await query(
    `SELECT * FROM worker_node_config WHERE status = 'online' ORDER BY current_replicas ASC`
  );
  if (nodesResult.rows.length === 0) {
    console.warn('[Worker] 无在线 worker 节点，跳过容器启动（配额已记录，待节点上线后手动启动）');
    return;
  }

  // 轮询选最闲的节点
  const node = nodesResult.rows[0];
  const containerCount = Math.ceil(maxConcurrency / 2); // 每容器并发 2

  for (let i = 0; i < containerCount; i++) {
    const instanceId = `worker-${agentUserId}-${Date.now()}-${i}`;
    const workerType = i % 2 === 0 ? 'publish' : 'collect';

    // 调用 docker daemon 创建并启动容器
    const createResult = await createDockerContainer(
      node.docker_host,
      node.api_version || 'v1.41',
      {
        Image: 'jlyl-cloud-auto-publish-worker:latest',
        HostConfig: {
          Memory: 2 * 1024 * 1024 * 1024, // 2GB
          RestartPolicy: { Name: 'unless-stopped' },
        },
        Env: [
          `SERVER_URL=${process.env.PUBLIC_SERVER_URL || 'https://report.jlyl.net.cn'}`,
          `AGENT_USER_ID=${agentUserId}`,
          `WORKER_TYPE=${workerType}`,
          `MAX_CONCURRENT=2`,
          `INSTANCE_ID=${instanceId}`,
        ],
      },
      instanceId
    );

    if (createResult.ok) {
      // 记录实例
      await query(
        `INSERT INTO worker_instance
         (instance_id, worker_type, agent_user_id, server_node, status, max_concurrency)
         VALUES ($1, $2, $3, $4, 'running', 2)`,
        [instanceId, workerType, agentUserId, node.node_name, 2]
      );
    } else {
      console.warn(`[Worker] 创建容器失败: ${createResult.error}`);
    }
  }

  // 更新节点当前副本数
  await query(
    `UPDATE worker_node_config SET current_replicas = current_replicas + $1, updated_at = NOW() WHERE id = $2`,
    [containerCount, node.id]
  );
}

/**
 * 创建 docker 容器（调用 docker daemon 远程 API）
 */
async function createDockerContainer(
  dockerHost: string,
  apiVersion: string,
  config: any,
  instanceId: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(config);
    const url = `${dockerHost}/${apiVersion}/containers/create?name=${instanceId}`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 201) {
            // 启动容器
            startDockerContainer(dockerHost, apiVersion, instanceId).then((startResult) => {
              resolve(startResult);
            });
          } else {
            resolve({ ok: false, error: `创建失败 HTTP ${res.statusCode}: ${data.substring(0, 200)}` });
          }
        });
      }
    );

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('创建超时'));
      resolve({ ok: false, error: '创建超时' });
    });
    req.write(body);
    req.end();
  });
}

/**
 * 启动已创建的 docker 容器
 */
async function startDockerContainer(
  dockerHost: string,
  apiVersion: string,
  containerName: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const url = `${dockerHost}/${apiVersion}/containers/${containerName}/start`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        timeout: 15000,
      },
      (res) => {
        res.on('end', () => {
          if (res.statusCode === 204 || res.statusCode === 304) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `启动失败 HTTP ${res.statusCode}` });
          }
        });
        res.on('data', () => {}); // 消费响应
      }
    );

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('启动超时'));
      resolve({ ok: false, error: '启动超时' });
    });
    req.end();
  });
}

/**
 * 停止 docker 容器
 */
async function stopDockerContainer(
  dockerHost: string,
  apiVersion: string,
  containerName: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const url = `${dockerHost}/${apiVersion}/containers/${containerName}/stop?t=10`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        timeout: 20000,
      },
      (res) => {
        res.on('end', () => resolve({ ok: true }));
        res.on('data', () => {});
      }
    );

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '停止超时' });
    });
    req.end();
  });
}

// ============================================================
// 第六部分：到期回收定时任务 + WebSocket 通知
// ============================================================

let expirySchedulerStarted = false;
let expiryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动 worker 配额/授权码到期回收调度器
 *
 * 每 5 分钟扫描一次：
 * 1. 云端增强包配额（agent_worker_quota）过期 → status='expired' + 停止运行中的容器
 * 2. 私有部署授权码（private_deploy_license）过期 → status='expired'
 * 3. 心跳超时检测：worker_instance 超过 5 分钟无心跳 → status='offline'
 * 4. WebSocket 广播 'worker_quota_expired' 事件通知代理客户端
 *
 * 应在 index.ts 启动时调用（initWsServer 之后）
 */
export function startWorkerExpiryScheduler(): void {
  if (expirySchedulerStarted) {
    console.log('[WorkerExpiry] 回收调度器已启动，跳过');
    return;
  }
  expirySchedulerStarted = true;

  // 启动后立即执行一次（清理重启期间已过期的记录）
  setTimeout(() => {
    runExpiryReclaim().catch((e) => {
      console.error('[WorkerExpiry] 首次回收异常:', e.message);
    });
  }, 10000);

  // 每 5 分钟扫描一次
  expiryTimer = setInterval(() => {
    runExpiryReclaim().catch((e) => {
      console.error('[WorkerExpiry] 回收异常:', e.message);
    });
  }, 5 * 60 * 1000);

  console.log('[WorkerExpiry] 到期回收调度器已启动（每 5 分钟扫描一次）');
}

/**
 * 停止到期回收调度器（仅用于测试或优雅关闭）
 */
export function stopWorkerExpiryScheduler(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
  expirySchedulerStarted = false;
  console.log('[WorkerExpiry] 到期回收调度器已停止');
}

/**
 * 执行一次到期回收
 */
async function runExpiryReclaim(): Promise<void> {
  const now = new Date();

  // 1. 回收到期的云端增强包配额
  const expiredQuotas = await query(
    `UPDATE agent_worker_quota
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active'
       AND expire_at IS NOT NULL
       AND expire_at < NOW()
     RETURNING id, agent_user_id, quota_type, max_concurrency, source, private_server_name`
  );

  if ((expiredQuotas.rowCount || 0) > 0) {
    console.log(`[WorkerExpiry] 回收 ${expiredQuotas.rowCount} 个到期配额`);

    // 停止这些配额对应的运行中容器
    for (const quota of expiredQuotas.rows) {
      await stopInstancesForQuota(quota.id, quota.agent_user_id);

      // WebSocket 通知代理客户端
      try {
        wsBroadcast('worker_quota_expired', {
          quota_id: quota.id,
          quota_type: quota.quota_type,
          max_concurrency: quota.max_concurrency,
          source: quota.source,
          reason: 'expired',
          message: quota.quota_type === 'cloud'
            ? `云端增强包已到期（并发 ${quota.max_concurrency}）`
            : `私有部署授权已到期（服务器：${quota.private_server_name || '未知'}）`,
          expired_at: now.toISOString(),
        }, String(quota.agent_user_id));
      } catch (e: any) {
        console.warn(`[WorkerExpiry] WS 通知失败 (quota ${quota.id}):`, e.message);
      }
    }
  }

  // 2. 回收到期的私有部署授权码
  const expiredLicenses = await query(
    `UPDATE private_deploy_license
     SET status = 'expired'
     WHERE status IN ('active', 'pending')
       AND expire_at IS NOT NULL
       AND expire_at < NOW()
     RETURNING id, agent_user_id, license_key, server_name`
  );

  if ((expiredLicenses.rowCount || 0) > 0) {
    console.log(`[WorkerExpiry] 回收 ${expiredLicenses.rowCount} 个到期授权码`);

    // 同步把对应的私有配额也置为 expired
    const licenseKeys = expiredLicenses.rows.map((r: any) => r.license_key);
    if (licenseKeys.length > 0) {
      await query(
        `UPDATE agent_worker_quota
         SET status = 'expired', updated_at = NOW()
         WHERE source = ANY($1::text[]) AND status = 'active'`,
        [licenseKeys]
      );
    }

    // WebSocket 通知
    for (const lic of expiredLicenses.rows) {
      try {
        wsBroadcast('worker_license_expired', {
          license_id: lic.id,
          license_key: lic.license_key,
          server_name: lic.server_name,
          reason: 'expired',
          message: `私有部署授权码已到期：${lic.license_key}`,
          expired_at: now.toISOString(),
        }, String(lic.agent_user_id));
      } catch (e: any) {
        console.warn(`[WorkerExpiry] WS 通知失败 (license ${lic.id}):`, e.message);
      }
    }
  }

  // 3. 心跳超时检测：worker_instance 超过 5 分钟无心跳 → 标记 offline
  const staleInstances = await query(
    `UPDATE worker_instance
     SET status = 'offline', last_heartbeat = last_heartbeat
     WHERE status IN ('starting', 'running')
       AND last_heartbeat IS NOT NULL
       AND last_heartbeat < NOW() - INTERVAL '5 minutes'
     RETURNING instance_id, agent_user_id, worker_type, server_node`
  );

  if ((staleInstances.rowCount || 0) > 0) {
    console.log(`[WorkerExpiry] 标记 ${staleInstances.rowCount} 个心跳超时的 worker 实例为 offline`);
    for (const inst of staleInstances.rows) {
      try {
        wsBroadcast('worker_instance_offline', {
          instance_id: inst.instance_id,
          worker_type: inst.worker_type,
          server_node: inst.server_node,
          reason: 'heartbeat_timeout',
          message: `Worker 实例心跳超时已标记为离线：${inst.server_node}`,
        }, String(inst.agent_user_id));
      } catch (e: any) {
        console.warn(`[WorkerExpiry] WS 通知失败 (instance ${inst.instance_id}):`, e.message);
      }
    }
  }

  // 4. 心跳超时检测：private_deploy_license 超过 5 分钟无心跳 → 标记 offline（不影响授权状态，仅通知）
  const staleLicenses = await query(
    `UPDATE private_deploy_license
     SET last_heartbeat = last_heartbeat
     WHERE status = 'active'
       AND last_heartbeat IS NOT NULL
       AND last_heartbeat < NOW() - INTERVAL '5 minutes'
     RETURNING id, agent_user_id, license_key, server_name, last_heartbeat`
  );

  if ((staleLicenses.rowCount || 0) > 0) {
    console.log(`[WorkerExpiry] 检测到 ${staleLicenses.rowCount} 个私有部署心跳超时`);
    for (const lic of staleLicenses.rows) {
      try {
        wsBroadcast('worker_heartbeat_lost', {
          license_id: lic.id,
          license_key: lic.license_key,
          server_name: lic.server_name,
          last_heartbeat: lic.last_heartbeat,
          message: `私有部署服务器心跳丢失：${lic.server_name || lic.license_key}`,
        }, String(lic.agent_user_id));
      } catch (e: any) {
        console.warn(`[WorkerExpiry] WS 通知失败 (license heartbeat ${lic.id}):`, e.message);
      }
    }
  }
}

/**
 * 停止某个配额对应的所有运行中容器实例
 */
async function stopInstancesForQuota(quotaId: number, agentUserId: number): Promise<void> {
  try {
    const instances = await query(
      `SELECT instance_id, server_node FROM worker_instance
       WHERE agent_user_id = $1 AND status IN ('starting', 'running')`,
      [agentUserId]
    );

    if (instances.rows.length === 0) return;

    // 查询可用的 docker 节点配置
    const nodes = await query(
      `SELECT node_name, docker_host, api_version FROM worker_node_config WHERE status = 'online'`
    );

    for (const inst of instances.rows) {
      const node = nodes.rows.find((n: any) => n.node_name === inst.server_node);
      if (node) {
        try {
          await stopDockerContainer(node.docker_host, node.api_version || 'v1.41', inst.instance_id);
          console.log(`[WorkerExpiry] 已停止容器 ${inst.instance_id} (节点 ${inst.server_node})`);
        } catch (e: any) {
          console.warn(`[WorkerExpiry] 停止容器 ${inst.instance_id} 失败:`, e.message);
        }
      }
    }

    // 更新实例状态为 stopped
    await query(
      `UPDATE worker_instance
       SET status = 'stopped', last_heartbeat = NOW()
       WHERE agent_user_id = $1 AND status IN ('starting', 'running')`,
      [agentUserId]
    );
  } catch (e: any) {
    console.warn(`[WorkerExpiry] 停止配额 ${quotaId} 的容器失败:`, e.message);
  }
}

// ============================================================
// 第六部分：Docker Compose 部署模式 - 生成部署文件
// ============================================================

/**
 * 生成 Docker Compose 部署文件（管理员用，无需开放 docker daemon 远程 API）
 * GET /worker/admin/generate-compose?server_name=xxx&collect_concurrency=4&publish_concurrent=2
 *
 * 返回：
 *   - docker_compose_yml: docker-compose.yml 文件内容
 *   - env_content: .env 文件内容（含管理员预生成的 LICENSE_KEY）
 *   - commands: 部署命令列表
 *   - license_key: 生成的授权码（也写入 private_deploy_license 表）
 */
router.get('/admin/generate-compose', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const serverName = (req.query.server_name as string) || `cloud-worker-${Date.now()}`;
    const collectConcurrency = Math.min(8, Math.max(1, Number(req.query.collect_concurrency) || 4));
    const publishConcurrent = Math.min(4, Math.max(1, Number(req.query.publish_concurrent) || 2));
    const adminUserId = getUserId(req);

    // 推断云端 API 地址：优先用请求头 host（公网域名），其次用环境变量
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
    const host = req.headers.host || process.env.PUBLIC_API_URL || 'https://report.jlyl.net.cn';
    const cloudApiUrl = `${proto}://${host}`;

    // 为管理员预生成一个授权码（agent_user_id=admin，便于在订阅管理中统一查看）
    const licenseKey = generateLicenseKey();
    await query(
      `INSERT INTO private_deploy_license
       (license_key, agent_user_id, order_id, status, expire_at, server_name)
       VALUES ($1, $2, NULL, 'pending', NULL, $3)`,
      [licenseKey, adminUserId, serverName]
    );

    // docker-compose.yml 内容（与 docker-compose.private-worker.yml 同构，但环境变量已预填）
    const dockerComposeYml = `# 聚量引力 RaaS 平台 — 云端 Worker 节点（管理员部署）
# 在 worker 服务器上执行：
#   1. 把 docker-compose.yml 和 .env 放到同一目录
#   2. docker compose up -d
#   3. docker compose logs -f  查看日志
#   4. docker compose down  停止

services:
  cloud-collect-worker:
    build:
      context: ./auto-collect-worker
      dockerfile: Dockerfile
    container_name: jlyl-cloud-collect-worker
    restart: always
    environment:
      SERVER_URL: \${CLOUD_API_URL}
      WORKER_PORT: "3003"
      POLL_INTERVAL: "2000"
      MAX_CONCURRENCY: \${COLLECT_MAX_CONCURRENCY}
      LICENSE_KEY: \${LICENSE_KEY}
      SERVER_NAME: \${SERVER_NAME}
      SHM_SIZE: "512m"
    ports:
      - "127.0.0.1:3003:3003"
    mem_limit: 2g
    memswap_limit: 2g
    shm_size: 512m
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost:3003/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  cloud-publish-worker:
    build:
      context: ./auto-publish-worker
      dockerfile: Dockerfile
    container_name: jlyl-cloud-publish-worker
    restart: always
    environment:
      SERVER_URL: \${CLOUD_API_URL}
      WORKER_PORT: "3004"
      POLL_INTERVAL: "30000"
      MAX_CONCURRENT: \${PUBLISH_MAX_CONCURRENT}
      WORKER_SECRET: \${WORKER_SECRET}
      STEALTH_HEADLESS: "true"
      LICENSE_KEY: \${LICENSE_KEY}
      SERVER_NAME: \${SERVER_NAME}
    ports:
      - "127.0.0.1:3004:3004"
    mem_limit: 1g
    memswap_limit: 1g
    shm_size: 512m
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost:3004/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
`;

    // .env 内容（含预生成的 LICENSE_KEY + 推断的 CLOUD_API_URL）
    const envContent = `# 聚量引力云端 Worker 节点配置（管理员预生成）
# 修改后保存为 .env 与 docker-compose.yml 同目录

# 云端 API 地址（已自动填写为云端公网地址，如有反向代理请改为对外域名）
CLOUD_API_URL=${cloudApiUrl}

# 授权码（已预生成，容器启动后会自动激活并绑定本服务器指纹）
LICENSE_KEY=${licenseKey}

# 服务器名称（在管理后台显示用，可改）
SERVER_NAME=${serverName}

# 巡检 Worker 最大并发（建议 2-8，超过 8 易 Page crashed）
COLLECT_MAX_CONCURRENCY=${collectConcurrency}

# 发布 Worker 最大并发（建议 1-2）
PUBLISH_MAX_CONCURRENT=${publishConcurrent}

# 发布 Worker 调用云端 API 时的密钥（与云端 .env 中的 WORKER_SECRET 保持一致）
WORKER_SECRET=${process.env.WORKER_SECRET || 'jlyl-cloud-worker-secret-2024'}
`;

    const commands = [
      `# 1. 把 docker-compose.yml 和 .env 上传到 worker 服务器（如 /opt/jlyl-worker/）`,
      `# 2. 在服务器上启动`,
      `cd /opt/jlyl-worker && docker compose up -d`,
      `# 3. 查看日志`,
      `docker compose logs -f`,
      `# 4. 健康检查`,
      `curl http://localhost:3003/health && curl http://localhost:3004/health`,
      `# 5. 停止`,
      `docker compose down`,
    ];

    res.json({
      code: 200,
      data: {
        license_key: licenseKey,
        docker_compose_yml: dockerComposeYml,
        env_content: envContent,
        commands,
        cloud_api_url: cloudApiUrl,
        server_name: serverName,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
