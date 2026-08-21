import { Router } from 'express';
import { query } from '../db';

/**
 * 灵犀站点引擎 — 数据统计（SITE_ENGINE_PLAN P1，公开接口）
 *
 *   GET  /sites-analytics/analytics.js  - 统计脚本（内存生成，随发布注入，浏览器直接加载）
 *   POST /sites-analytics/collect       - 埋点上报（navigator.sendBeacon，无鉴权）
 *
 * 公开接口无需 authMiddleware，但通过 IP 令牌桶限频 + site 状态校验 + 请求体大小限制防刷，
 * 避免被恶意刷量；UV 通过「IP hash + 日期」内存集合粗去重（重启丢弃可接受）。
 */

const router = Router();

// ============ 内存限频（60 次/分钟/IP） ============
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 60;
const rateMap = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  let r = rateMap.get(ip);
  if (!r || now >= r.resetAt) {
    r = { count: 0, resetAt: now + RL_WINDOW_MS };
    rateMap.set(ip, r);
  }
  if (r.count >= RL_MAX) return true;
  r.count += 1;
  // 防止 Map 无限增长
  if (rateMap.size > 100000) rateMap.clear();
  return false;
}

// ============ UV 粗去重（IP hash + 日期） ============
const UV_DATE_MS = 24 * 60 * 60 * 1000;
const uvSeen = new Map<string, number>(); // key -> lastTs

function uvFirstSeen(siteId: number, ip: string): boolean {
  const now = Date.now();
  const dayKey = new Date().toISOString().slice(0, 10);
  const key = `${siteId}_${dayKey}_${ip}`;
  const last = uvSeen.get(key);
  uvSeen.set(key, now);
  // 清理过期
  if (uvSeen.size > 200000) {
    for (const [k, ts] of uvSeen) {
      if (now - ts > UV_DATE_MS) uvSeen.delete(k);
    }
  }
  return last == null;
}

function getClientIp(req: any): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// ============ analytics.js ============
const ANALYTICS_JS = `(function(){try{var s=document.currentScript;var id=s&&s.getAttribute('data-site');if(!id)return;var base=(s.src||'').replace(/\\/analytics\\.js(\\?.*)?$/,'');var k='_lx_uv_'+id;var uv=0;try{if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,'1');uv=1;}}catch(e){}var ua=navigator.userAgent||'';var dev=/Mobile|Android|iPhone|iPad|iPod/.test(ua)?'mobile':/Tablet/.test(ua)?'tablet':'desktop';var body=new URLSearchParams();body.append('siteId',id);body.append('path',(location.pathname||'').slice(0,200));body.append('ref',(document.referrer||'').slice(0,300));body.append('dev',dev);body.append('uv',String(uv));if(navigator.sendBeacon){navigator.sendBeacon(base+'/collect',body);}else{var x=new XMLHttpRequest();x.open('POST',base+'/collect',true);x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');x.send(body.toString());}}catch(e){}})();`;

// 统计脚本（公开，长缓存）
router.get('/analytics.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(ANALYTICS_JS);
});

// 埋点上报（公开，sendBeacon 场景）
router.post('/collect', async (req: any, res) => {
  const ip = getClientIp(req);

  // 1. 限频：超限直接 204，不报错（避免刷探测）
  if (rateLimited(ip)) {
    return res.status(204).end();
  }

  try {
    // 2. 请求体大小限制（express.json 已设 10mb 上限，这里针对 body 字符串再校验）
    const rawLen = typeof req.body === 'string' ? req.body.length : JSON.stringify(req.body || {}).length;
    if (rawLen > 1024) {
      return res.status(204).end();
    }

    const siteId = Number(req.body?.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) {
      return res.status(204).end();
    }

    const path = String(req.body?.path || '').slice(0, 200);
    const ref = String(req.body?.ref || '').slice(0, 300);
    const dev = ['mobile', 'tablet', 'desktop'].includes(req.body?.dev) ? req.body?.dev : 'desktop';
    const uv = Number(req.body?.uv) === 1 ? 1 : 0;

    // 3. 校验站点存在且已发布
    const siteR = await query('SELECT id, user_id FROM site WHERE id = $1 AND status = $2', [siteId, 'published']);
    const site = siteR.rows[0];
    if (!site) {
      return res.status(204).end();
    }

    // 4. UV 粗去重
    const isFirstUv = uv === 1 && uvFirstSeen(siteId, ip);

    // 5. UPSERT 日聚合
    const refDomain = ref ? safeDomain(ref) : '';
    const addPv = 1;
    const addUv = isFirstUv ? 1 : 0;

    await query(
      `INSERT INTO site_stats_daily (site_id, user_id, stat_date, pv, uv, referrers, devices)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (site_id, stat_date)
       DO UPDATE SET
         pv = site_stats_daily.pv + EXCLUDED.pv,
         uv = site_stats_daily.uv + EXCLUDED.uv,
         referrers = site_stats_daily.referrers || EXCLUDED.referrers,
         updated_at = NOW()`,
      [
        siteId,
        site.user_id,
        addPv,
        addUv,
        refDomain ? JSON.stringify({ [refDomain]: 1 }) : '{}',
        JSON.stringify({ [dev]: 1 }),
      ]
    );

    // 6. 响应 204（beacon 场景）
    res.status(204).end();
  } catch (e: any) {
    // 埋点失败静默，不阻塞页面
    console.warn('[SiteAnalytics] collect 失败:', e.message);
    res.status(204).end();
  }
});

/** 提取域名（仅主机名，去协议/路径/端口，防注入） */
function safeDomain(ref: string): string {
  try {
    const u = new URL(ref);
    return u.hostname;
  } catch {
    return '';
  }
}

export default router;