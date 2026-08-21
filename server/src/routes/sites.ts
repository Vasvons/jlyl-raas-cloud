import { Router } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';

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

export default router;