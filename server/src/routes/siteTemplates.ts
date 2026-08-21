import { Router } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';

/**
 * 灵犀站点引擎 — 模板 CRUD + 收藏（SITE_ENGINE_PLAN P0）
 *
 * 模板两类：官方模板（user_id IS NULL，平台共享）+ 用户模板（user_id = 本人）。
 * 收藏走 site_template_favorite（跨设备持久化）。
 */
const router = Router();

router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? 0);
}

// 模板列表：官方 + 本人，附收藏标记与使用次数
router.get('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    const r = await query(
      `SELECT t.id, t.user_id, t.name, t.category, t.description, t.blocks, t.sort_order,
              t.created_at, t.updated_at,
              COALESCE((SELECT COUNT(*) FROM site s WHERE s.template_id = t.id), 0)::int AS usage_count,
              CASE WHEN f.template_id IS NOT NULL THEN true ELSE false END AS is_favorite
       FROM site_template t
       LEFT JOIN site_template_favorite f ON f.template_id = t.id AND f.user_id = $1
       WHERE t.status = 'active' AND (t.user_id IS NULL OR t.user_id = $1)
       ORDER BY (t.user_id IS NULL) DESC, t.sort_order ASC, t.id DESC`,
      [uid]
    );
    res.json({ code: 200, data: r.rows });
  } catch (e: any) {
    console.error('[SiteTemplate] 列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 另存为模板（绑定本人）
router.post('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { name, category, description, blocks } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ code: 400, message: '缺少模板名称' });
    }
    if (blocks !== undefined && !Array.isArray(blocks)) {
      return res.status(400).json({ code: 400, message: 'blocks 必须为数组' });
    }
    const r = await query(
      `INSERT INTO site_template (user_id, name, category, description, blocks)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, category, description, blocks, created_at`,
      [uid, name.trim(), category || '通用', description || '', JSON.stringify(blocks || [])]
    );
    res.json({ code: 200, data: r.rows[0], message: '模板保存成功' });
  } catch (e: any) {
    console.error('[SiteTemplate] 保存失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 删除模板（仅本人模板；官方模板不可删）
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效模板ID' });
    const uid = getUserId(req);
    const r = await query('SELECT * FROM site_template WHERE id = $1', [id]);
    const tpl = r.rows[0];
    if (!tpl) return res.status(404).json({ code: 404, message: '模板不存在' });
    if (tpl.user_id == null) {
      return res.status(403).json({ code: 403, message: '官方模板不可删除' });
    }
    if (String(tpl.user_id) !== String(uid)) {
      return res.status(404).json({ code: 404, message: '模板不存在' });
    }
    await query('DELETE FROM site_template WHERE id = $1', [id]);
    await query('DELETE FROM site_template_favorite WHERE template_id = $1', [id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[SiteTemplate] 删除失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 收藏 / 取消收藏（toggle）
router.post('/:id/favorite', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ code: 400, message: '无效模板ID' });
    const uid = getUserId(req);

    // 可见性：官方或本人
    const r = await query(
      `SELECT * FROM site_template WHERE id = $1 AND (user_id IS NULL OR user_id = $2)`,
      [id, uid]
    );
    if (!r.rows[0]) return res.status(404).json({ code: 404, message: '模板不存在' });

    const fav = await query(
      'SELECT 1 FROM site_template_favorite WHERE user_id = $1 AND template_id = $2',
      [uid, id]
    );
    if (fav.rows.length > 0) {
      await query('DELETE FROM site_template_favorite WHERE user_id = $1 AND template_id = $2', [uid, id]);
      res.json({ code: 200, data: { isFavorite: false }, message: '已取消收藏' });
    } else {
      await query('INSERT INTO site_template_favorite (user_id, template_id) VALUES ($1, $2)', [uid, id]);
      res.json({ code: 200, data: { isFavorite: true }, message: '已收藏' });
    }
  } catch (e: any) {
    console.error('[SiteTemplate] 收藏失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

export default router;