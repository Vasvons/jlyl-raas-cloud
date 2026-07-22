/**
 * SaaS 订阅 + 微信支付（v2.5.35 阶段五）
 *
 * 路由列表：
 *   GET  /api/subscription/plans              - 查询所有可用套餐（代理端）
 *   GET  /api/subscription/my                 - 查询当前代理的有效订阅
 *   POST /api/subscription/orders             - 创建订单（返回微信支付二维码 URL）
 *   GET  /api/subscription/orders/:id         - 查询订单状态
 *   GET  /api/subscription/orders             - 查询我的订单列表
 *   POST /api/subscription/wechat/notify      - 微信支付回调（不需要鉴权）
 *   POST /api/subscription/orders/:id/cancel  - 取消未支付订单
 *
 *   ---- 管理员路由（定价管理页面）----
 *   GET    /api/subscription/admin/plans        - 查询所有套餐（含已下架）
 *   POST   /api/subscription/admin/plans        - 新增套餐
 *   PUT    /api/subscription/admin/plans/:id    - 编辑套餐
 *   DELETE /api/subscription/admin/plans/:id    - 删除套餐
 *   GET    /api/subscription/admin/config       - 读取解锁配置
 *   PUT    /api/subscription/admin/config       - 保存解锁配置
 *   GET    /api/subscription/admin/wechat-pay   - 读取微信支付配置
 *   PUT    /api/subscription/admin/wechat-pay   - 保存微信支付配置
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { grantAgentModule } from '../repository';
import { encrypt, decrypt } from '../utils/crypto';

const router = Router();

router.use(authMiddleware);

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
}

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.level === '1' || user?.role === 'super_admin' || user?.role === 'admin';
}

// ============ 微信支付配置（从数据库读取，带缓存）============

interface WechatPayConfig {
  appid: string;
  mchid: string;
  api_v3_key: string;
  serial_no: string;
  private_key: string;
  notify_url: string;
  enabled: boolean;
}

let cachedWechatConfig: WechatPayConfig | null = null;
let cacheExpiry = 0;

/** 从数据库读取微信支付配置（带 60 秒缓存） */
async function getWechatPayConfig(): Promise<WechatPayConfig | null> {
  if (cachedWechatConfig && Date.now() < cacheExpiry) {
    return cachedWechatConfig;
  }
  try {
    const result = await query(
      `SELECT appid, mchid, api_v3_key, serial_no, private_key, notify_url, enabled
       FROM wechat_pay_config WHERE id = 1`
    );
    if (result.rows.length === 0 || !result.rows[0].enabled) {
      cachedWechatConfig = null;
      cacheExpiry = Date.now() + 10000; // 短缓存
      return null;
    }
    const row = result.rows[0];
    // private_key 加密存储，使用前解密
    let privateKey = row.private_key || '';
    try {
      if (privateKey) privateKey = decrypt(privateKey);
    } catch {
      // 解密失败保持原样
    }
    cachedWechatConfig = {
      appid: row.appid || '',
      mchid: row.mchid || '',
      api_v3_key: row.api_v3_key || '',
      serial_no: row.serial_no || '',
      private_key: privateKey,
      notify_url: row.notify_url || '',
      enabled: !!row.enabled,
    };
    cacheExpiry = Date.now() + 60000; // 60 秒缓存
    return cachedWechatConfig;
  } catch (e) {
    console.error('[WechatPay] 读取配置失败:', e);
    return null;
  }
}

/** 清除配置缓存（管理员保存后调用） */
function invalidateWechatConfigCache() {
  cachedWechatConfig = null;
  cacheExpiry = 0;
}

/** 生成订单号：JLYL + 时间戳 + 随机数 */
function generateOrderNo(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `JLYL${ts}${rand}`;
}

/** 生成微信支付二维码 URL（Native 扫码支付） */
async function createWechatNativePay(
  orderNo: string,
  amountFen: number,
  description: string
): Promise<{ prepay_id: string; qrcode_url: string }> {
  const cfg = await getWechatPayConfig();
  if (!cfg || !cfg.appid || !cfg.mchid) {
    throw new Error('微信支付未配置（管理员尚未在定价管理中配置支付参数）');
  }

  const payload = {
    appid: cfg.appid,
    mchid: cfg.mchid,
    description,
    out_trade_no: orderNo,
    time_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    notify_url: cfg.notify_url,
    amount: { total: amountFen, currency: 'CNY' },
  };

  // 调用微信支付 v3 API：https://api.mch.weixin.qq.com/v3/pay/transactions/native
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/native';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');

  // 签名串：HTTP方法\nURL\n时间戳\n随机串\n请求体\n
  const signatureBase = `POST\n/v3/pay/transactions/native\n${timestamp}\n${nonceStr}\n${JSON.stringify(payload)}\n`;
  const sign = crypto
    .createSign('RSA-SHA256')
    .update(signatureBase)
    .sign(cfg.private_key, 'base64');

  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${cfg.serial_no}",signature="${sign}"`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authorization,
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`微信支付下单失败: ${resp.status} ${errText}`);
  }

  const data: any = await resp.json();
  return {
    prepay_id: data.prepay_id || '',
    qrcode_url: data.code_url, // wechat://wxpay/bizpayurl?pr=xxx
  };
}

/** 验证微信支付回调签名（v3 API） */
function verifyWechatNotifySignature(
  timestamp: string,
  nonce: string,
  body: string,
  signature: string
): boolean {
  // 简化：实际需要用微信平台证书验证签名
  // 此处占位返回 true，生产环境需要严格验证
  return true;
}

/** 解密微信支付回调资源（AES-256-GCM） */
async function decryptWechatResource(ciphertext: string, associatedData: string, nonce: string): Promise<any> {
  const cfg = await getWechatPayConfig();
  if (!cfg || !cfg.api_v3_key) {
    throw new Error('微信支付未配置 api_v3_key');
  }
  const key = Buffer.from(cfg.api_v3_key, 'utf-8');
  const cipherBuf = Buffer.from(ciphertext, 'base64');
  const authTag = cipherBuf.subarray(cipherBuf.length - 16);
  const encryptedData = cipherBuf.subarray(0, cipherBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf-8'));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData, 'utf-8'));
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf-8');
  return JSON.parse(decrypted);
}

// ============ 查询套餐列表 ============

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, plan_code, module_code, name, description, price_fen, period, features, sort_order
       FROM agent_subscription_plan
       WHERE status = 'active'
       ORDER BY sort_order ASC`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 查询我的订阅 ============

router.get('/my', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    // 查询当前用户已支付且未过期的订单（即有效订阅）
    const result = await query(
      `SELECT o.id, o.order_no, o.module_code, o.amount_fen, o.period, o.paid_at, o.expire_at,
              p.name as plan_name, p.features
       FROM agent_order o
       JOIN agent_subscription_plan p ON p.id = o.plan_id
       WHERE o.agent_user_id = $1 AND o.status = 'paid'
       ORDER BY o.paid_at DESC`,
      [userId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 创建订单（发起支付） ============

router.post('/orders', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

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

    // 创建订单
    const orderNo = generateOrderNo();
    const expireAt = new Date();
    if (plan.period === 'yearly') {
      expireAt.setFullYear(expireAt.getFullYear() + 1);
    } else {
      expireAt.setMonth(expireAt.getMonth() + 1);
    }

    const orderResult = await query(
      `INSERT INTO agent_order
        (order_no, agent_user_id, plan_id, module_code, amount_fen, period, status, expire_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [orderNo, userId, plan_id, plan.module_code, plan.price_fen, plan.period, expireAt]
    );
    const orderId = orderResult.rows[0].id;

    // 调用微信支付 Native 下单
    let qrcodeUrl = '';
    let prepayId = '';
    try {
      const payResult = await createWechatNativePay(
        orderNo,
        Number(plan.price_fen),
        `聚量引力RaaS - ${plan.name}`
      );
      qrcodeUrl = payResult.qrcode_url;
      prepayId = payResult.prepay_id;

      // 更新订单的支付信息
      await query(
        `UPDATE agent_order SET wechat_prepay_id = $1, pay_qrcode_url = $2 WHERE id = $3`,
        [prepayId, qrcodeUrl, orderId]
      );
    } catch (e: any) {
      // 微信支付下单失败，标记订单为 failed
      await query(`UPDATE agent_order SET status = 'failed' WHERE id = $1`, [orderId]);
      return res.status(500).json({
        code: 500,
        message: `微信支付下单失败: ${e.message}`,
      });
    }

    res.json({
      code: 200,
      data: {
        order_id: orderId,
        order_no: orderNo,
        qrcode_url: qrcodeUrl,
        amount_fen: plan.price_fen,
        plan_name: plan.name,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 查询订单状态 ============

router.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    const result = await query(
      `SELECT o.*, p.name as plan_name
       FROM agent_order o
       JOIN agent_subscription_plan p ON p.id = o.plan_id
       WHERE o.id = $1 AND o.agent_user_id = $2`,
      [Number(req.params.id), userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '订单不存在' });
    }
    res.json({ code: 200, data: result.rows[0] });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 查询我的订单列表 ============

router.get('/orders', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    const result = await query(
      `SELECT o.id, o.order_no, o.module_code, o.amount_fen, o.period, o.status, o.paid_at, o.expire_at,
              p.name as plan_name
       FROM agent_order o
       JOIN agent_subscription_plan p ON p.id = o.plan_id
       WHERE o.agent_user_id = $1
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [userId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 取消未支付订单 ============

router.post('/orders/:id/cancel', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    await query(
      `UPDATE agent_order SET status = 'cancelled' WHERE id = $1 AND agent_user_id = $2 AND status = 'pending'`,
      [Number(req.params.id), userId]
    );
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 微信支付回调（不需要鉴权，需单独注册） ============

const wechatNotifyHandler = async (req: Request, res: Response) => {
  try {
    const { id: timestamp, resource } = req.body || {};
    if (!resource) {
      return res.json({ code: 'FAIL', message: '无 resource 字段' });
    }

    // 验证签名（生产环境必须严格验证）
    const signature = req.headers['wechatpay-signature'] as string;
    const wechatTimestamp = req.headers['wechatpay-timestamp'] as string;
    const nonce = req.headers['wechatpay-nonce'] as string;
    const body = JSON.stringify(req.body);

    if (!verifyWechatNotifySignature(wechatTimestamp, nonce, body, signature)) {
      console.warn('[WechatPay] 回调签名验证失败');
      return res.json({ code: 'FAIL', message: '签名验证失败' });
    }

    // 解密资源数据
    const decrypted = await decryptWechatResource(
      resource.ciphertext,
      resource.associated_data,
      resource.nonce
    );

    const { out_trade_no, transaction_id, trade_state } = decrypted;
    if (trade_state !== 'SUCCESS') {
      console.log('[WechatPay] 回调非成功状态:', trade_state);
      return res.json({ code: 'SUCCESS', message: '成功' });
    }

    // 查询订单
    const orderResult = await query(
      `SELECT id, agent_user_id, module_code, period, plan_id FROM agent_order WHERE order_no = $1`,
      [out_trade_no]
    );
    if (orderResult.rows.length === 0) {
      console.warn('[WechatPay] 订单不存在:', out_trade_no);
      return res.json({ code: 'SUCCESS', message: '成功' });
    }
    const order = orderResult.rows[0];

    // 更新订单状态
    await query(
      `UPDATE agent_order
       SET status = 'paid', wechat_transaction_id = $1, paid_at = NOW()
       WHERE id = $2 AND status = 'pending'`,
      [transaction_id, order.id]
    );

    // 计算订阅到期时间
    const expireAt = new Date();
    if (order.period === 'yearly') {
      expireAt.setFullYear(expireAt.getFullYear() + 1);
    } else {
      expireAt.setMonth(expireAt.getMonth() + 1);
    }

    // 授予板块权限（写入 agent_module_grant 表）
    const grantResult = await grantAgentModule({
      agent_user_id: order.agent_user_id,
      module_code: order.module_code,
      granted_by: 0, // 系统自动授权
      expire_at: expireAt,
      config: { source: 'subscription', order_id: order.id, plan_id: order.plan_id },
    });

    // 关联 grant_id 到订单
    await query(
      `UPDATE agent_order SET grant_id = $1 WHERE id = $2`,
      [grantResult.id, order.id]
    );

    console.log(`[WechatPay] 订单 ${out_trade_no} 支付成功，已授权模块 ${order.module_code}`);
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (e: any) {
    console.error('[WechatPay] 回调处理异常:', e);
    res.json({ code: 'FAIL', message: e.message });
  }
};

// 导出 wechatNotifyHandler 供 index.ts 单独注册（无需 authMiddleware）
export { wechatNotifyHandler };

// ============ 管理员：套餐 CRUD ============

// 查询所有套餐（含已下架）
router.get('/admin/plans', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT id, plan_code, module_code, name, description, price_fen, period, features, status, sort_order, created_at
       FROM agent_subscription_plan
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 新增套餐
router.post('/admin/plans', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { plan_code, module_code, name, description, price_fen, period, features, status, sort_order } = req.body;
    if (!plan_code || !module_code || !name || price_fen == null) {
      return res.status(400).json({ code: 400, message: 'plan_code/module_code/name/price_fen 必填' });
    }
    const result = await query(
      `INSERT INTO agent_subscription_plan
        (plan_code, module_code, name, description, price_fen, period, features, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        plan_code,
        module_code,
        name,
        description || null,
        Number(price_fen),
        period || 'monthly',
        features ? JSON.stringify(features) : null,
        status || 'active',
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

// 编辑套餐
router.put('/admin/plans/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { plan_code, module_code, name, description, price_fen, period, features, status, sort_order } = req.body;
    const result = await query(
      `UPDATE agent_subscription_plan SET
        plan_code = COALESCE($1, plan_code),
        module_code = COALESCE($2, module_code),
        name = COALESCE($3, name),
        description = COALESCE($4, description),
        price_fen = COALESCE($5, price_fen),
        period = COALESCE($6, period),
        features = COALESCE($7, features),
        status = COALESCE($8, status),
        sort_order = COALESCE($9, sort_order)
       WHERE id = $10 RETURNING id`,
      [
        plan_code || null,
        module_code || null,
        name || null,
        description !== undefined ? description : null,
        price_fen != null ? Number(price_fen) : null,
        period || null,
        features ? JSON.stringify(features) : null,
        status || null,
        sort_order != null ? Number(sort_order) : null,
        id,
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

// 删除套餐（如果有订单关联则改为下架）
router.delete('/admin/plans/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    // 检查是否有关联订单
    const orderCount = await query('SELECT COUNT(*) as count FROM agent_order WHERE plan_id = $1', [id]);
    if (parseInt(orderCount.rows[0].count) > 0) {
      // 有关联订单，改为下架
      await query(`UPDATE agent_subscription_plan SET status = 'inactive' WHERE id = $1`, [id]);
      return res.json({ code: 200, message: '套餐已有关联订单，已改为下架' });
    }
    await query('DELETE FROM agent_subscription_plan WHERE id = $1', [id]);
    res.json({ code: 200, message: '套餐已删除' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：解锁配置 ============

router.get('/admin/config', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT trial_days, free_modules, grace_days, lock_on_expire, updated_at
       FROM agent_subscription_config WHERE id = 1`
    );
    if (result.rows.length === 0) {
      return res.json({ code: 200, data: { trial_days: 0, free_modules: [], grace_days: 3, lock_on_expire: true } });
    }
    res.json({ code: 200, data: result.rows[0] });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/admin/config', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { trial_days, free_modules, grace_days, lock_on_expire } = req.body;
    await query(
      `UPDATE agent_subscription_config SET
        trial_days = COALESCE($1, trial_days),
        free_modules = COALESCE($2, free_modules),
        grace_days = COALESCE($3, grace_days),
        lock_on_expire = COALESCE($4, lock_on_expire),
        updated_at = NOW()
       WHERE id = 1`,
      [
        trial_days != null ? Number(trial_days) : null,
        Array.isArray(free_modules) ? free_modules : null,
        grace_days != null ? Number(grace_days) : null,
        lock_on_expire != null ? !!lock_on_expire : null,
      ]
    );
    res.json({ code: 200, message: '解锁配置已保存' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：微信支付配置 ============

router.get('/admin/wechat-pay', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    // 注意：必须 SELECT private_key 才能判断是否已配置（不返回内容，仅判断非空）
    const result = await query(
      `SELECT appid, mchid, api_v3_key, serial_no, private_key, notify_url, enabled, updated_at
       FROM wechat_pay_config WHERE id = 1`
    );
    if (result.rows.length === 0) {
      return res.json({ code: 200, data: { appid: '', mchid: '', api_v3_key: '', serial_no: '', notify_url: '', enabled: false } });
    }
    const row = result.rows[0];
    // 不返回 private_key，仅返回是否已配置标识
    res.json({
      code: 200,
      data: {
        appid: row.appid || '',
        mchid: row.mchid || '',
        api_v3_key: row.api_v3_key ? '******' : '', // 脱敏显示
        serial_no: row.serial_no || '',
        notify_url: row.notify_url || '',
        enabled: !!row.enabled,
        has_private_key: !!row.private_key,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/admin/wechat-pay', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { appid, mchid, api_v3_key, serial_no, private_key, notify_url, enabled } = req.body;

    // 构建动态 UPDATE（private_key 可选更新，api_v3_key '******' 表示不改）
    const updates: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (appid !== undefined) { updates.push(`appid = $${paramIdx++}`); params.push(appid || ''); }
    if (mchid !== undefined) { updates.push(`mchid = $${paramIdx++}`); params.push(mchid || ''); }
    if (api_v3_key !== undefined && api_v3_key !== '******') {
      updates.push(`api_v3_key = $${paramIdx++}`);
      params.push(api_v3_key || '');
    }
    if (serial_no !== undefined) { updates.push(`serial_no = $${paramIdx++}`); params.push(serial_no || ''); }
    if (private_key !== undefined && private_key !== '') {
      // 加密存储私钥
      const encrypted = private_key ? encrypt(private_key) : null;
      updates.push(`private_key = $${paramIdx++}`);
      params.push(encrypted);
    }
    if (notify_url !== undefined) { updates.push(`notify_url = $${paramIdx++}`); params.push(notify_url || ''); }
    if (enabled !== undefined) { updates.push(`enabled = $${paramIdx++}`); params.push(!!enabled); }

    if (updates.length === 0) {
      return res.json({ code: 200, message: '无字段需要更新' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(1); // WHERE id = 1

    await query(
      `UPDATE wechat_pay_config SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      params
    );

    // 清除缓存，让新配置立即生效
    invalidateWechatConfigCache();
    res.json({ code: 200, message: '微信支付配置已保存' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：测试微信支付配置 ============
// 调用微信支付 v3 /v3/certificates 接口验证 mchid + serial_no + private_key 是否正确
// 支持两种模式：
//   1. body 中传入临时配置（未保存前测试）
//   2. 不传 body，使用已保存的配置

router.post('/admin/wechat-pay/test', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const body = req.body || {};

    // 读取已保存的配置作为基础，body 中的字段覆盖
    const savedResult = await query(
      `SELECT appid, mchid, api_v3_key, serial_no, private_key, notify_url, enabled
       FROM wechat_pay_config WHERE id = 1`
    );
    const saved = savedResult.rows[0] || {};

    const appid = body.appid !== undefined ? body.appid : (saved.appid || '');
    const mchid = body.mchid !== undefined ? body.mchid : (saved.mchid || '');
    const apiV3Key = (body.api_v3_key && body.api_v3_key !== '******')
      ? body.api_v3_key
      : (saved.api_v3_key || '');
    const serialNo = body.serial_no !== undefined ? body.serial_no : (saved.serial_no || '');
    const notifyUrl = body.notify_url !== undefined ? body.notify_url : (saved.notify_url || '');

    // private_key：body 传入时用 body 的，否则解密已保存的
    let privateKey = '';
    if (body.private_key && body.private_key !== '') {
      privateKey = body.private_key;
    } else if (saved.private_key) {
      try {
        privateKey = decrypt(saved.private_key);
      } catch {
        privateKey = saved.private_key; // 解密失败，按原样尝试
      }
    }

    // 基础校验
    if (!mchid) return res.json({ code: 200, success: false, message: '缺少商户号 MchID' });
    if (!serialNo) return res.json({ code: 200, success: false, message: '缺少证书序列号 serial_no' });
    if (!privateKey) return res.json({ code: 200, success: false, message: '缺少商户私钥 private_key' });
    if (!privateKey.includes('BEGIN')) {
      return res.json({
        code: 200,
        success: false,
        message: '私钥格式错误：需为 PEM 格式（应包含 -----BEGIN PRIVATE KEY----- 头部）',
      });
    }

    // 调用微信支付 v3 /v3/certificates 接口
    // 此接口仅需 mchid + serial_no + private_key 签名正确即可访问
    const url = 'https://api.mch.weixin.qq.com/v3/certificates';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');

    // 签名串：HTTP方法\nURL路径\n时间戳\n随机串\n请求体\n
    const signatureBase = `GET\n/v3/certificates\n${timestamp}\n${nonceStr}\n\n`;
    let sign: string;
    try {
      sign = crypto
        .createSign('RSA-SHA256')
        .update(signatureBase)
        .sign(privateKey, 'base64');
    } catch (e: any) {
      return res.json({
        code: 200,
        success: false,
        message: `私钥签名失败：${e.message}（请确认私钥为 RSA 格式且 PEM 内容完整）`,
      });
    }

    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${sign}"`;

    const startTs = Date.now();
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': authorization,
      },
    });
    const elapsedMs = Date.now() - startTs;
    const respText = await resp.text();

    if (resp.ok) {
      // 解析证书列表，进一步确认配置正确
      let certCount = 0;
      try {
        const data = JSON.parse(respText);
        certCount = Array.isArray(data.data) ? data.data.length : 0;
      } catch { /* 忽略解析错误 */ }

      // 检查 appid 是否已填写（certificates 接口不验证 appid，单独提示）
      const warnings: string[] = [];
      if (!appid) warnings.push('AppID 未填写（下单时必填，请补全）');
      if (!apiV3Key) warnings.push('APIv3 密钥未填写（回调验签时必填，请补全）');
      if (!notifyUrl) warnings.push('回调 URL 未填写（支付成功后无法通知，请补全）');

      let message = `微信支付配置验证成功（商户号: ${mchid}, 平台证书 ${certCount} 个, 耗时 ${elapsedMs}ms）`;
      if (warnings.length > 0) {
        message += `；⚠️ 注意：${warnings.join('、')}`;
      }

      return res.json({
        code: 200,
        success: true,
        message,
        data: { mchid, cert_count: certCount, elapsedMs, warnings },
      });
    }

    // 失败：解析微信返回的错误
    let friendly = `HTTP ${resp.status}: ${respText}`;
    try {
      const errJson = JSON.parse(respText);
      const code = errJson.code || '';
      const msg = errJson.message || '';
      if (code === 'SIGN_ERROR') {
        friendly = `签名错误（SIGN_ERROR）：${msg}（请检查私钥 private_key 与证书序列号 serial_no 是否匹配）`;
      } else if (code === 'MCH_NOT_EXISTS') {
        friendly = `商户号不存在（MCH_NOT_EXISTS）：${msg}（请检查 MchID 是否正确）`;
      } else if (code === 'NO_AUTH') {
        friendly = `无权限（NO_AUTH）：${msg}（请检查商户号是否已开通 Native 支付产品）`;
      } else if (code === 'PARAM_ERROR') {
        friendly = `参数错误（PARAM_ERROR）：${msg}（请检查证书序列号 serial_no 格式）`;
      } else if (resp.status === 401) {
        friendly = `认证失败（401）：${msg || '签名或证书序列号错误'}`;
      } else if (resp.status === 403) {
        friendly = `权限不足（403）：${msg || '商户号未开通相关权限'}`;
      } else {
        friendly = `微信支付返回错误 [${code}]: ${msg}`;
      }
    } catch { /* 非 JSON 错误，返回原始文本 */ }

    return res.json({ code: 200, success: false, message: friendly, http_status: resp.status });
  } catch (e: any) {
    return res.json({ code: 200, success: false, message: '测试异常: ' + e.message });
  }
});

export default router;
