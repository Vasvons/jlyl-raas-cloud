/**
 * 板块管理 + 板块订阅 API（v3.0 两层架构重构）
 *
 * 路由列表：
 *   ---- 板块查询（管理端+代理端共用）----
 *   GET    /module/list                     - 板块列表（管理端：全部；代理端：按状态/订阅过滤）
 *   GET    /module/:code                    - 板块详情
 *
 *   ---- 板块管理（管理端）----
 *   POST   /module                          - 创建板块
 *   PUT    /module/:id                      - 更新板块元信息
 *   DELETE /module/:id                      - 删除板块（仅 developing + is_system=false）
 *   PUT    /module/:id/status               - 切换板块状态（developing/preview/published/offline）
 *
 *   ---- 套餐管理（管理端，复用 agent_subscription_plan 表）----
 *   GET    /module/:code/plans              - 板块的套餐列表
 *   POST   /module/:code/plans              - 创建套餐（上架时必填至少 1 个板块套餐）
 *   PUT    /module/plans/:planId            - 更新套餐
 *   DELETE /module/plans/:planId            - 删除套餐（已订阅不可删，改 is_active=false）
 *
 *   ---- 订阅查询（代理端）----
 *   GET    /module/subscriptions/my         - 我的板块订阅列表（查 agent_module_grant）
 *
 *   ---- 订阅授权（管理端）----
 *   POST   /module/grant                    - 管理端授权订阅（直接创建 grant 记录）
 *
 *   ---- 在线订阅（代理端，复用微信支付）----
 *   POST   /module/subscribe                - 代理端在线订阅（生成支付订单）
 *
 *   ---- 访问权限检查 ----
 *   GET    /module/:code/access             - 检查代理对某板块的访问权限（板块窗口加载时调用）
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { grantAgentModule, isUserAgent } from '../repository';
import { createWechatNativePay } from './subscription';

const router = Router();

router.use(authMiddleware);

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
}

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'super_admin' || user?.role === 'admin' || user?.level === '1';
}

// ============ 板块查询 ============

/**
 * 板块列表
 * - 管理端：返回所有板块
 * - 代理端：返回 published + preview + 已订阅的 offline（developing 不返回）
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const admin = isAdmin(req);

    if (admin) {
      const result = await query(
        `SELECT id, code, name, description, icon, status, is_system, sort_order,
                preview_info, preview_assets, publish_config, offline_reason, offline_at,
                created_at, updated_at
         FROM module
         ORDER BY sort_order ASC, id ASC`
      );
      return res.json({ code: 200, data: result.rows });
    }

    // 代理端：published + preview + 已订阅的 offline
    const result = await query(
      `SELECT m.id, m.code, m.name, m.description, m.icon, m.status, m.is_system, m.sort_order,
              m.preview_info, m.preview_assets, m.publish_config, m.offline_reason, m.offline_at,
              g.expire_at AS subscription_expire_at,
              CASE
                WHEN g.id IS NOT NULL AND (g.expire_at IS NULL OR g.expire_at > NOW()) THEN 'subscribed'
                WHEN g.id IS NOT NULL AND g.expire_at <= NOW() THEN 'expired'
                ELSE 'none'
              END AS subscription_status
       FROM module m
       LEFT JOIN agent_module_grant g
         ON g.module_code = m.code
         AND g.agent_user_id = $1
         AND g.status = 'active'
       WHERE m.status IN ('published', 'preview')
          OR (m.status = 'offline' AND g.id IS NOT NULL
              AND (g.expire_at IS NULL OR g.expire_at > NOW()))
       ORDER BY m.sort_order ASC, m.id ASC`,
      [userId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 板块详情
 */
router.get('/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const userId = getUserId(req);
    const admin = isAdmin(req);

    const result = await query(
      `SELECT id, code, name, description, icon, status, is_system, sort_order,
              preview_info, preview_assets, publish_config, offline_reason, offline_at,
              created_at, updated_at
       FROM module WHERE code = $1`,
      [code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '板块不存在' });
    }

    const moduleData = result.rows[0];

    // 代理端权限校验：developing 不可见，offline 仅已订阅可见
    if (!admin) {
      if (moduleData.status === 'developing') {
        return res.status(403).json({ code: 403, message: '板块开发中' });
      }
      if (moduleData.status === 'offline') {
        const grant = await query(
          `SELECT id, expire_at FROM agent_module_grant
           WHERE agent_user_id = $1 AND module_code = $2 AND status = 'active'
             AND (expire_at IS NULL OR expire_at > NOW())`,
          [userId, code]
        );
        if (grant.rows.length === 0) {
          return res.status(403).json({ code: 403, message: '板块已下架且无有效订阅' });
        }
      }
    }

    res.json({ code: 200, data: moduleData });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 板块管理（管理端） ============

/**
 * 创建板块
 */
router.post('/', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { code, name, description, icon, sort_order } = req.body;
    if (!code || !name) {
      return res.status(400).json({ code: 400, message: 'code 和 name 必填' });
    }
    // 校验 code 格式：仅小写字母、数字、下划线
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      return res.status(400).json({ code: 400, message: 'code 必须以小写字母开头，仅含小写字母/数字/下划线' });
    }
    const result = await query(
      `INSERT INTO module (code, name, description, icon, status, is_system, sort_order)
       VALUES ($1, $2, $3, $4, 'developing', FALSE, $5)
       RETURNING id, code, name, status`,
      [code, name, description || null, icon || null, sort_order || 0]
    );
    res.json({ code: 200, data: result.rows[0], message: '板块创建成功（开发中）' });
  } catch (e: any) {
    if (e.code === '23505') {
      return res.status(409).json({ code: 409, message: '板块编码已存在' });
    }
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 更新板块元信息
 */
router.put('/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { name, description, icon, sort_order } = req.body;
    const result = await query(
      `UPDATE module SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        icon = COALESCE($3, icon),
        sort_order = COALESCE($4, sort_order),
        updated_at = NOW()
       WHERE id = $5 RETURNING id`,
      [name || null, description !== undefined ? description : null, icon || null,
       sort_order != null ? Number(sort_order) : null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '板块不存在' });
    }
    res.json({ code: 200, message: '板块已更新' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 删除板块（仅 developing + is_system=false）
 */
router.delete('/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    // 查询板块状态
    const modResult = await query(`SELECT status, is_system FROM module WHERE id = $1`, [id]);
    if (modResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '板块不存在' });
    }
    const mod = modResult.rows[0];
    if (mod.is_system) {
      return res.status(400).json({ code: 400, message: '系统预置板块不可删除' });
    }
    if (mod.status !== 'developing') {
      return res.status(400).json({ code: 400, message: '仅开发中状态的板块可删除' });
    }
    await query('DELETE FROM module WHERE id = $1', [id]);
    res.json({ code: 200, message: '板块已删除' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 切换板块状态
 * body: { status: 'developing'|'preview'|'published'|'offline', preview_info?, preview_assets?, offline_reason? }
 */
router.put('/:id/status', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { status, preview_info, preview_assets, offline_reason } = req.body;

    if (!['developing', 'preview', 'published', 'offline'].includes(status)) {
      return res.status(400).json({ code: 400, message: 'status 必须为 developing/preview/published/offline' });
    }

    // 上架前校验：至少有 1 个板块套餐
    if (status === 'published') {
      const planCount = await query(
        `SELECT COUNT(*) as count FROM agent_subscription_plan
         WHERE module_code = (SELECT code FROM module WHERE id = $1)
         AND plan_type = 'module' AND status = 'active'`,
        [id]
      );
      if (parseInt(planCount.rows[0].count) === 0) {
        return res.status(400).json({ code: 400, message: '上架前需配置至少 1 个板块订阅套餐' });
      }
    }

    const result = await query(
      `UPDATE module SET
        status = $1,
        preview_info = COALESCE($2, preview_info),
        preview_assets = COALESCE($3, preview_assets),
        offline_reason = CASE WHEN $1 = 'offline' THEN $4 ELSE NULL END,
        offline_at = CASE WHEN $1 = 'offline' THEN NOW() ELSE NULL END,
        updated_at = NOW()
       WHERE id = $5 RETURNING id, status`,
      [
        status,
        preview_info ? JSON.stringify(preview_info) : null,
        preview_assets ? JSON.stringify(preview_assets) : null,
        offline_reason || null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '板块不存在' });
    }
    res.json({ code: 200, data: result.rows[0], message: `板块状态已切换为 ${status}` });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 套餐管理（管理端，复用 agent_subscription_plan 表） ============

/**
 * 板块的套餐列表
 * query: plan_type=module|service（不传则返回全部）
 */
router.get('/:code/plans', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const { plan_type } = req.query;
    const admin = isAdmin(req);

    // 代理端只看 active 套餐，管理端看全部
    const statusFilter = admin ? '' : "AND status = 'active'";
    const typeFilter = plan_type ? `AND plan_type = $2` : '';

    let sql = `
      SELECT id, plan_code, module_code, name, description, price_fen, period, features,
             plan_type, support_online_pay, status, sort_order, created_at
      FROM agent_subscription_plan
      WHERE module_code = $1 ${typeFilter} ${statusFilter}
      ORDER BY sort_order ASC, id ASC
    `;
    const params: any[] = [code];
    if (plan_type) params.push(plan_type);

    const result = await query(sql, params);
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 创建套餐
 * body: { plan_code, name, description, price_fen, period, features, plan_type, support_online_pay, sort_order }
 */
router.post('/:code/plans', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { code } = req.params;
    const { plan_code, name, description, price_fen, period, features, plan_type, support_online_pay, sort_order } = req.body;

    if (!plan_code || !name || price_fen == null) {
      return res.status(400).json({ code: 400, message: 'plan_code/name/price_fen 必填' });
    }

    const result = await query(
      `INSERT INTO agent_subscription_plan
        (plan_code, module_code, name, description, price_fen, period, features,
         plan_type, support_online_pay, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
       RETURNING id`,
      [
        plan_code, code, name, description || null,
        Number(price_fen), period || 'monthly',
        features ? JSON.stringify(features) : null,
        plan_type || 'module',
        !!support_online_pay,
        sort_order || 0,
      ]
    );
    res.json({ code: 200, data: { id: result.rows[0].id }, message: '套餐创建成功' });
  } catch (e: any) {
    if (e.code === '23505') {
      return res.status(409).json({ code: 409, message: '套餐编码已存在' });
    }
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 更新套餐
 */
router.put('/plans/:planId', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const planId = Number(req.params.planId);
    const { name, description, price_fen, period, features, support_online_pay, status, sort_order } = req.body;

    const result = await query(
      `UPDATE agent_subscription_plan SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        price_fen = COALESCE($3, price_fen),
        period = COALESCE($4, period),
        features = COALESCE($5, features),
        support_online_pay = COALESCE($6, support_online_pay),
        status = COALESCE($7, status),
        sort_order = COALESCE($8, sort_order)
       WHERE id = $9 RETURNING id`,
      [
        name || null,
        description !== undefined ? description : null,
        price_fen != null ? Number(price_fen) : null,
        period || null,
        features ? JSON.stringify(features) : null,
        support_online_pay != null ? !!support_online_pay : null,
        status || null,
        sort_order != null ? Number(sort_order) : null,
        planId,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '套餐不存在' });
    }
    res.json({ code: 200, message: '套餐已更新' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 删除套餐（已有关联订单不可删，改 status=inactive）
 */
router.delete('/plans/:planId', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const planId = Number(req.params.planId);
    const orderCount = await query(
      'SELECT COUNT(*) as count FROM agent_order WHERE plan_id = $1', [planId]
    );
    if (parseInt(orderCount.rows[0].count) > 0) {
      await query(`UPDATE agent_subscription_plan SET status = 'inactive' WHERE id = $1`, [planId]);
      return res.json({ code: 200, message: '套餐已有关联订单，已改为下架' });
    }
    await query('DELETE FROM agent_subscription_plan WHERE id = $1', [planId]);
    res.json({ code: 200, message: '套餐已删除' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 订阅查询（代理端） ============

/**
 * 我的板块订阅列表（查 agent_module_grant）
 */
router.get('/subscriptions/my', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    const result = await query(
      `SELECT g.id, g.module_code, g.status, g.expire_at, g.granted_at,
              g.config,
              CASE
                WHEN g.expire_at IS NULL THEN NULL
                WHEN g.expire_at > NOW() THEN EXTRACT(DAY FROM (g.expire_at - NOW()))::INT
                ELSE 0
              END AS remaining_days,
              m.name AS module_name, m.icon AS module_icon,
              m.status AS module_status
       FROM agent_module_grant g
       LEFT JOIN module m ON m.code = g.module_code
       WHERE g.agent_user_id = $1 AND g.status = 'active'
       ORDER BY g.granted_at DESC`,
      [userId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 订阅授权（管理端） ============

/**
 * 管理端授权订阅（直接创建 grant 记录，不走支付）
 * body: { agent_user_id, module_code, period_days, expire_at }
 */
router.post('/grant', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const userId = getUserId(req);
    const { agent_user_id, module_code, period_days, expire_at } = req.body;

    if (!agent_user_id || !module_code) {
      return res.status(400).json({ code: 400, message: 'agent_user_id 和 module_code 必填' });
    }

    // 计算到期时间
    let expireDate: Date | null = null;
    if (expire_at) {
      expireDate = new Date(expire_at);
    } else if (period_days) {
      expireDate = new Date();
      expireDate.setDate(expireDate.getDate() + Number(period_days));
    }

    const grantResult = await grantAgentModule({
      agent_user_id: Number(agent_user_id),
      module_code,
      granted_by: userId,
      expire_at: expireDate,
      config: { source: 'admin_grant', granted_by: userId },
    });

    res.json({
      code: 200,
      data: { id: grantResult.id, expire_at: expireDate },
      message: '授权成功',
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 在线订阅（代理端，复用微信支付） ============

/**
 * 代理端在线订阅（生成支付订单）
 * body: { plan_id }
 * 复用 subscription.ts 的 createWechatNativePay + agent_order 表
 */
router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    // 代理端才能在线订阅
    const agent = await isUserAgent(userId);
    if (!agent && !isAdmin(req)) {
      return res.status(403).json({ code: 403, message: '仅代理端可订阅' });
    }

    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ code: 400, message: 'plan_id 必填' });

    // 查询套餐
    const planResult = await query(
      `SELECT * FROM agent_subscription_plan WHERE id = $1 AND status = 'active'`,
      [plan_id]
    );
    if (planResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '套餐不存在或已下架' });
    }
    const plan = planResult.rows[0];

    // 校验套餐支持在线支付
    if (!plan.support_online_pay) {
      return res.status(400).json({ code: 400, message: '该套餐不支持在线支付，请联系管理员开通' });
    }

    // 检查是否已有未支付订单（避免重复创建）
    const pendingOrder = await query(
      `SELECT id, order_no, pay_qrcode_url FROM agent_order
       WHERE agent_user_id = $1 AND plan_id = $2 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, plan_id]
    );
    if (pendingOrder.rows.length > 0) {
      return res.json({
        code: 200,
        data: {
          order_id: pendingOrder.rows[0].id,
          order_no: pendingOrder.rows[0].order_no,
          qrcode_url: pendingOrder.rows[0].pay_qrcode_url,
          message: '已有未支付订单，请扫码支付',
        },
      });
    }

    // 生成订单号
    const orderNo = 'JLYL' + Date.now() + Math.floor(Math.random() * 1000000).toString().padStart(6, '0');

    // 计算到期时间
    const expireAt = new Date();
    if (plan.period === 'yearly') {
      expireAt.setFullYear(expireAt.getFullYear() + 1);
    } else {
      expireAt.setMonth(expireAt.getMonth() + 1);
    }

    // 创建订单
    const orderResult = await query(
      `INSERT INTO agent_order
        (order_no, agent_user_id, plan_id, module_code, amount_fen, period, status, expire_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [orderNo, userId, plan_id, plan.module_code, plan.price_fen, plan.period, expireAt]
    );
    const orderId = orderResult.rows[0].id;

    // 调用微信支付 Native 下单
    try {
      const payResult = await createWechatNativePay(
        orderNo,
        Number(plan.price_fen),
        `聚量引力RaaS - ${plan.name}`
      );
      await query(
        `UPDATE agent_order SET wechat_prepay_id = $1, pay_qrcode_url = $2 WHERE id = $3`,
        [payResult.prepay_id, payResult.qrcode_url, orderId]
      );
      res.json({
        code: 200,
        data: {
          order_id: orderId,
          order_no: orderNo,
          qrcode_url: payResult.qrcode_url,
          amount_fen: plan.price_fen,
          plan_name: plan.name,
        },
      });
    } catch (e: any) {
      await query(`UPDATE agent_order SET status = 'failed' WHERE id = $1`, [orderId]);
      return res.status(500).json({ code: 500, message: `微信支付下单失败: ${e.message}` });
    }
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 访问权限检查 ============

/**
 * 检查代理对某板块的访问权限
 * 返回：{ can_access, reason, subscription_status, expire_at }
 */
router.get('/:code/access', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const userId = getUserId(req);
    const admin = isAdmin(req);

    // 管理端始终可访问
    if (admin) {
      return res.json({
        code: 200,
        data: { can_access: true, reason: 'admin', subscription_status: 'admin' },
      });
    }

    // 查询板块状态
    const modResult = await query(`SELECT status FROM module WHERE code = $1`, [code]);
    if (modResult.rows.length === 0) {
      return res.json({
        code: 200,
        data: { can_access: false, reason: 'module_not_found', subscription_status: 'none' },
      });
    }
    const moduleStatus = modResult.rows[0].status;

    // 板块未上架或开发中：不可访问
    if (moduleStatus === 'developing') {
      return res.json({
        code: 200,
        data: { can_access: false, reason: 'developing', subscription_status: 'none' },
      });
    }
    if (moduleStatus === 'preview') {
      return res.json({
        code: 200,
        data: { can_access: false, reason: 'preview', subscription_status: 'none' },
      });
    }

    // 查询订阅状态
    const grantResult = await query(
      `SELECT id, expire_at FROM agent_module_grant
       WHERE agent_user_id = $1 AND module_code = $2 AND status = 'active'`,
      [userId, code]
    );

    if (grantResult.rows.length === 0) {
      // 无订阅
      return res.json({
        code: 200,
        data: {
          can_access: false,
          reason: moduleStatus === 'offline' ? 'offline_no_subscription' : 'no_subscription',
          subscription_status: 'none',
        },
      });
    }

    const grant = grantResult.rows[0];
    const now = new Date();
    const expireAt = grant.expire_at ? new Date(grant.expire_at) : null;

    // 永久订阅或未到期
    if (!expireAt || expireAt > now) {
      return res.json({
        code: 200,
        data: {
          can_access: true,
          reason: 'subscribed',
          subscription_status: 'active',
          expire_at: grant.expire_at,
          remaining_days: expireAt
            ? Math.ceil((expireAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            : null,
        },
      });
    }

    // 已过期
    res.json({
      code: 200,
      data: {
        can_access: false,
        reason: 'expired',
        subscription_status: 'expired',
        expire_at: grant.expire_at,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
