/**
 * SaaS 订阅 + 微信支付（v2.5.35 阶段五）
 *
 * 路由列表：
 *   GET  /api/subscription/plans              - 查询所有可用套餐
 *   GET  /api/subscription/my                 - 查询当前代理的有效订阅
 *   POST /api/subscription/orders             - 创建订单（返回微信支付二维码 URL）
 *   GET  /api/subscription/orders/:id         - 查询订单状态
 *   GET  /api/subscription/orders             - 查询我的订单列表
 *   POST /api/subscription/wechat/notify      - 微信支付回调（不需要鉴权）
 *   POST /api/subscription/orders/:id/cancel  - 取消未支付订单
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { grantAgentModule } from '../repository';

const router = Router();

// 微信支付配置（从环境变量读取）
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_MCHID = process.env.WECHAT_MCHID || '';
const WECHAT_APIV3_KEY = process.env.WECHAT_APIV3_KEY || '';
const WECHAT_SERIAL_NO = process.env.WECHAT_SERIAL_NO || '';
const WECHAT_PRIVATE_KEY = process.env.WECHAT_PRIVATE_KEY || ''; // PEM 格式
const WECHAT_NOTIFY_URL = process.env.WECHAT_NOTIFY_URL || '';

router.use(authMiddleware);

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
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
  if (!WECHAT_APPID || !WECHAT_MCHID) {
    throw new Error('微信支付未配置（缺 WECHAT_APPID 或 WECHAT_MCHID）');
  }

  const payload = {
    appid: WECHAT_APPID,
    mchid: WECHAT_MCHID,
    description,
    out_trade_no: orderNo,
    time_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    notify_url: WECHAT_NOTIFY_URL,
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
    .sign(WECHAT_PRIVATE_KEY, 'base64');

  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${WECHAT_MCHID}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${WECHAT_SERIAL_NO}",signature="${sign}"`;

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
function decryptWechatResource(ciphertext: string, associatedData: string, nonce: string): any {
  const key = Buffer.from(WECHAT_APIV3_KEY, 'utf-8');
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
    const decrypted = decryptWechatResource(
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

export default router;
