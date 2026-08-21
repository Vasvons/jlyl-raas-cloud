import { Router } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { getCloudApiConfig } from '../repository';
import { generateHtml, injectAnalyticsScript } from '../services/siteHtmlBuilder';

/**
 * 灵犀站点引擎 — 站点 CRUD（SITE_ENGINE_PLAN P0）
 *
 * 数据云端化 + 用户隔离：
 *   - 普通用户（agent/customer）仅见/操作本人 site.user_id 的站点
 *   - 管理员（level=1）可见/操作全部
 *   - 归属不符统一返回 404（不暴露资源存在性）
 *
 * 站点 blocks 结构：Block[] = { id, type, props, order }，
 * type 枚举见桌面端 components/Editor/types.ts（hero/features/pricing/faq/testimonials/cta/footer）
 */
const router = Router();

router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? 0);
}

function isAdmin(req: any): boolean {
  return String(req.user?.level ?? '') === '1';
}

/** 归属校验：管理员可访问任意站点；普通用户仅本人。不符返回 false（已响应 404）。 */
async function checkOwnership(req: any, res: any, siteId: number): Promise<{ ok: boolean; site?: any }> {
  const r = await query('SELECT * FROM site WHERE id = $1', [siteId]);
  const site = r.rows[0];
  if (!site) {
    res.status(404).json({ code: 404, message: '站点不存在' });
    return { ok: false };
  }
  if (!isAdmin(req) && String(site.user_id) !== String(getUserId(req))) {
    res.status(404).json({ code: 404, message: '站点不存在' });
    return { ok: false };
  }
  return { ok: true, site };
}

// 站点列表（摘要，不含 blocks/published_html 大字段）
router.get('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    let rows: any[];
    if (isAdmin(req)) {
      const r = await query(
        `SELECT id, user_id, name, industry, description, status, publish_url,
                custom_domain, seo_score, published_at, created_at, updated_at
         FROM site ORDER BY updated_at DESC`
      );
      rows = r.rows;
    } else {
      const r = await query(
        `SELECT id, user_id, name, industry, description, status, publish_url,
                custom_domain, seo_score, published_at, created_at, updated_at
         FROM site WHERE user_id = $1 ORDER BY updated_at DESC`,
        [uid]
      );
      rows = r.rows;
    }
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Site] 列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 站点详情（含 blocks）
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok, site } = await checkOwnership(req, res, id);
    if (!ok) return;
    res.json({ code: 200, data: site });
  } catch (e: any) {
    console.error('[Site] 详情失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 创建站点（绑定当前用户；带 templateId 时复制模板 blocks）
router.post('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { name, industry, description, targetAudience, templateId } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ code: 400, message: '缺少站点名称' });
    }

    let blocks: any[] = [];
    let resolvedTemplateId: number | null = null;
    if (templateId != null && Number.isFinite(Number(templateId))) {
      const tid = Number(templateId);
      // 模板可见性：官方（user_id IS NULL）或本人
      const tr = await query(
        `SELECT * FROM site_template WHERE id = $1 AND (user_id IS NULL OR user_id = $2)`,
        [tid, uid]
      );
      const tpl = tr.rows[0];
      if (!tpl) {
        return res.status(404).json({ code: 404, message: '模板不存在或不可用' });
      }
      if (Array.isArray(tpl.blocks)) blocks = tpl.blocks;
      resolvedTemplateId = tid;
    }

    const r = await query(
      `INSERT INTO site (user_id, name, description, industry, target_audience, template_id, blocks)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, status, blocks, created_at, updated_at`,
      [
        uid,
        name.trim(),
        description || '',
        industry || '',
        targetAudience || '',
        resolvedTemplateId,
        JSON.stringify(blocks),
      ]
    );
    res.json({ code: 200, data: r.rows[0], message: '创建成功' });
  } catch (e: any) {
    console.error('[Site] 创建失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 更新站点（名称/blocks/custom_domain/seo_score 等）
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok } = await checkOwnership(req, res, id);
    if (!ok) return;

    const { name, description, industry, targetAudience, blocks, customDomain, seoScore } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { sets.push(`name = $${params.length + 1}`); params.push(String(name).trim()); }
    if (description !== undefined) { sets.push(`description = $${params.length + 1}`); params.push(description); }
    if (industry !== undefined) { sets.push(`industry = $${params.length + 1}`); params.push(industry); }
    if (targetAudience !== undefined) { sets.push(`target_audience = $${params.length + 1}`); params.push(targetAudience); }
    if (blocks !== undefined) {
      if (!Array.isArray(blocks)) return res.status(400).json({ code: 400, message: 'blocks 必须为数组' });
      sets.push(`blocks = $${params.length + 1}`); params.push(JSON.stringify(blocks));
    }
    if (customDomain !== undefined) { sets.push(`custom_domain = $${params.length + 1}`); params.push(String(customDomain).trim()); }
    if (seoScore !== undefined) { sets.push(`seo_score = $${params.length + 1}`); params.push(Number(seoScore)); }
    if (sets.length === 0) return res.json({ code: 200, message: '无变更' });

    sets.push(`updated_at = NOW()`);
    params.push(id);
    const r = await query(
      `UPDATE site SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, name, status, blocks, custom_domain, seo_score, updated_at`,
      params
    );
    res.json({ code: 200, data: r.rows[0], message: '更新成功' });
  } catch (e: any) {
    console.error('[Site] 更新失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 删除站点
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok } = await checkOwnership(req, res, id);
    if (!ok) return;
    await query('DELETE FROM site WHERE id = $1', [id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Site] 删除失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ============ P1：发布 / 预览 / 统计 ============

/** 云端公开基地址（统计脚本注入用），与 worker.ts 同源默认值 */
function cloudBase(): string {
  return (process.env.PUBLIC_SERVER_URL || 'https://report.jlyl.net.cn').replace(/\/$/, '');
}

/** 解析 OSS 配置（本人 → 平台共享行降级） */
async function resolveOss(userId: number): Promise<any> {
  let cfg = await getCloudApiConfig(userId);
  if (!cfg?.aliyun_access_key) {
    const shared = await query(`SELECT * FROM cloud_api_config WHERE user_id IS NULL LIMIT 1`);
    cfg = shared.rows[0] || cfg;
  }
  return cfg || null;
}

/** 拼装发布 URL（自定义域名 > CDN > 直链） */
function buildPublishUrl(cfg: any, customDomain: string, userId: number, siteId: number): string {
  const key = `sites/${userId}/${siteId}/index.html`;
  if (customDomain) return `https://${customDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`;
  if (cfg?.aliyun_oss_cdn) return `${cfg.aliyun_oss_cdn.replace(/\/$/, '')}/${key}`;
  const bucket = cfg?.aliyun_oss_bucket;
  const endpoint = (cfg?.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com').replace(/^https?:\/\//, '');
  return `https://${bucket}.${endpoint}/${key}`;
}

// 发布到 OSS（生成 HTML → 注入统计 → PUT OSS → 回写 URL）
router.post('/:id/publish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok, site } = await checkOwnership(req, res, id);
    if (!ok) return;

    const blocks: any[] = Array.isArray(site.blocks) ? site.blocks : [];
    // 1. 生成 HTML（唯一生成源）
    let html = generateHtml(blocks, site.name || '我的网站');
    // 2. 注入统计脚本
    html = injectAnalyticsScript(html, cloudBase(), id);

    // 3. OSS 配置解析（用户级 → 平台共享）
    const cfg = await resolveOss(getUserId(req));
    if (!cfg?.aliyun_access_key || !cfg?.aliyun_access_secret || !cfg?.aliyun_oss_bucket) {
      return res.json({ code: 4001, message: '未配置阿里云 OSS，请到 后台配置→云接口配置 填写 access_key / access_secret / bucket' });
    }

    // 4. PUT OSS
    const OSS = (await import('ali-oss')).default;
    const client = new OSS({
      accessKeyId: cfg.aliyun_access_key,
      accessKeySecret: cfg.aliyun_access_secret,
      bucket: cfg.aliyun_oss_bucket,
      endpoint: cfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com',
      secure: true,
    });
    const key = `sites/${getUserId(req)}/${id}/index.html`;
    await client.put(key, Buffer.from(html, 'utf-8'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });

    // 5. URL 规则
    const url = buildPublishUrl(cfg, site.custom_domain || '', getUserId(req), id);

    // 6. 回写站点状态
    await query(
      `UPDATE site SET status='published', published_html=$1, publish_url=$2, published_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [html, url, id]
    );

    res.json({ code: 200, data: { url, publishedAt: new Date().toISOString() }, message: '发布成功' });
  } catch (e: any) {
    console.error('[Site] 发布失败:', e.message);
    res.status(500).json({ code: 500, message: '发布失败: ' + e.message });
  }
});

// 服务端渲染预览（免 OSS，直接返回 HTML）
router.get('/:id/preview', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok, site } = await checkOwnership(req, res, id);
    if (!ok) return;

    const blocks: any[] = Array.isArray(site.blocks) ? site.blocks : [];
    const html = generateHtml(blocks, site.name || '我的网站');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (e: any) {
    console.error('[Site] 预览失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 数据统计聚合（真实统计源：site_stats_daily + keyword_search_rank + site.seo_score）
router.get('/:id/stats', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效站点ID' });
    const { ok, site } = await checkOwnership(req, res, id);
    if (!ok) return;

    const start = req.query.start ? String(req.query.start) : '';
    const end = req.query.end ? String(req.query.end) : '';
    const endDate = end || new Date().toISOString().slice(0, 10);
    const startDate =
      start || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1. 站点日聚合（PV/UV/来源/设备）
    const statsR = await query(
      `SELECT stat_date, pv, uv, referrers, devices
       FROM site_stats_daily
       WHERE site_id = $1 AND stat_date BETWEEN $2 AND $3
       ORDER BY stat_date ASC`,
      [id, startDate, endDate]
    );

    let totalPv = 0;
    let totalUv = 0;
    const referrerMap: Record<string, number> = {};
    const deviceMap: Record<string, number> = {};
    const byDate = new Map<string, { pv: number; uv: number }>();

    for (const row of statsR.rows) {
      totalPv += Number(row.pv || 0);
      totalUv += Number(row.uv || 0);
      byDate.set(toDateStr(row.stat_date), { pv: Number(row.pv || 0), uv: Number(row.uv || 0) });
      for (const [k, v] of Object.entries(row.referrers || {})) {
        referrerMap[k] = (referrerMap[k] || 0) + Number(v);
      }
      for (const [k, v] of Object.entries(row.devices || {})) {
        deviceMap[k] = (deviceMap[k] || 0) + Number(v);
      }
    }

    // 2. 趋势：按日期填 0（缺日补 0）
    const trends: any[] = [];
    const dayCount = Math.max(
      1,
      Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1
    );
    for (let i = 0; i < Math.min(dayCount, 90); i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const v = byDate.get(ds) || { pv: 0, uv: 0 };
      trends.push({ date: ds, visits: v.pv, uv: v.uv, aiCitations: 0, seoScore: site.seo_score ?? 0 });
    }

    // 3. AI 引擎引用分布 + 关键词（复用 keyword_search_rank 真实巡检数据，按用户关联）
    const uidTxt = String(site.user_id);
    const engineR = await query(
      `SELECT platform, COUNT(*)::int AS citations
       FROM keyword_search_rank
       WHERE user_id = $1 AND platform <> ''
       GROUP BY platform
       ORDER BY citations DESC
       LIMIT 10`,
      [uidTxt]
    );
    const engines = engineR.rows.filter((r: any) => r.platform);
    const engineTotal = engines.reduce((s: number, r: any) => s + r.citations, 0) || 1;
    const aiEngineBreakdown = engines.map((r: any) => ({
      engine: r.platform,
      citations: r.citations,
      percentage: Math.round((r.citations / engineTotal) * 100),
    }));

    const kwR = await query(
      `SELECT expanded_keyword, platform, url
       FROM keyword_search_rank
       WHERE user_id = $1 AND expanded_keyword <> ''
       ORDER BY create_time DESC
       LIMIT 10`,
      [uidTxt]
    );
    const keywordRankings = kwR.rows.map((r: any) => ({
      keyword: r.expanded_keyword,
      platform: r.platform,
      position: 0,
      change: 0,
      url: r.url || '/',
    }));

    res.json({
      code: 200,
      data: {
        overview: {
          totalVisits: totalPv,
          uniqueVisitors: totalUv,
          avgSessionDuration: '—',
          bounceRate: 0,
          aiCitations: engineTotal,
          seoScore: site.seo_score ?? 0,
          geoScore: 0,
        },
        trends,
        topPages: [{ url: '/', title: '首页', visits: totalPv, avgTime: '—' }],
        aiEngineBreakdown,
        keywordRankings,
        referrers: Object.entries(referrerMap).map(([domain, count]) => ({ domain, count })),
        devices: Object.entries(deviceMap).map(([type, count]) => ({ type, count })),
        dataNote:
          'PV/UV 来自已发布站点的埋点统计；AI 引擎引用与关键词来自 GEO 巡检真实数据；会话时长/跳出率暂未追踪',
      },
    });
  } catch (e: any) {
    console.error('[Site] 统计失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** 将 DB TIMESTAMP / DATE 转成 YYYY-MM-DD */
function toDateStr(v: any): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

export default router;