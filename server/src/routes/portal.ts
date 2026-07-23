/**
 * 门户轮播 API（v3.0 两层架构重构）
 *
 * 路由列表：
 *   GET    /portal/carousel         - 轮播列表（公开，按 target_audience 过滤）
 *   POST   /portal/carousel         - 创建轮播（管理端）
 *   PUT    /portal/carousel/:id     - 更新轮播（管理端）
 *   DELETE /portal/carousel/:id     - 删除轮播（管理端）
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';

const router = Router();

router.use(authMiddleware);

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'super_admin' || user?.role === 'admin' || user?.level === '1';
}

/**
 * 轮播列表
 * - 管理端：返回所有轮播
 * - 代理端：返回 target_audience IN ('all', 'agent') 且在有效期内的活跃轮播
 */
router.get('/carousel', async (req: Request, res: Response) => {
  try {
    const admin = isAdmin(req);
    const audienceFilter = admin
      ? ''
      : `AND target_audience IN ('all', 'agent')
         AND is_active = TRUE
         AND (start_at IS NULL OR start_at <= NOW())
         AND (end_at IS NULL OR end_at >= NOW())`;

    const result = await query(
      `SELECT id, title, image_url, link_type, link_target, target_audience,
              sort_order, is_active, start_at, end_at, created_at, updated_at
       FROM portal_carousel
       WHERE 1=1 ${audienceFilter}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 创建轮播（管理端）
 * body: { title, image_url, link_type, link_target, target_audience, sort_order, is_active, start_at, end_at }
 */
router.post('/carousel', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const { title, image_url, link_type, link_target, target_audience, sort_order, is_active, start_at, end_at } = req.body;

    if (!image_url) {
      return res.status(400).json({ code: 400, message: 'image_url 必填' });
    }
    if (!['none', 'module', 'url'].includes(link_type || 'none')) {
      return res.status(400).json({ code: 400, message: 'link_type 必须为 none/module/url' });
    }
    if (!['all', 'admin', 'agent'].includes(target_audience || 'all')) {
      return res.status(400).json({ code: 400, message: 'target_audience 必须为 all/admin/agent' });
    }

    const result = await query(
      `INSERT INTO portal_carousel
        (title, image_url, link_type, link_target, target_audience,
         sort_order, is_active, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        title || null,
        image_url,
        link_type || 'none',
        link_target || null,
        target_audience || 'all',
        sort_order || 0,
        is_active !== false,
        start_at || null,
        end_at || null,
      ]
    );
    res.json({ code: 200, data: { id: result.rows[0].id }, message: '轮播创建成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 更新轮播（管理端）
 */
router.put('/carousel/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { title, image_url, link_type, link_target, target_audience, sort_order, is_active, start_at, end_at } = req.body;

    const result = await query(
      `UPDATE portal_carousel SET
        title = COALESCE($1, title),
        image_url = COALESCE($2, image_url),
        link_type = COALESCE($3, link_type),
        link_target = COALESCE($4, link_target),
        target_audience = COALESCE($5, target_audience),
        sort_order = COALESCE($6, sort_order),
        is_active = COALESCE($7, is_active),
        start_at = COALESCE($8, start_at),
        end_at = COALESCE($9, end_at),
        updated_at = NOW()
       WHERE id = $10 RETURNING id`,
      [
        title !== undefined ? title : null,
        image_url || null,
        link_type || null,
        link_target !== undefined ? link_target : null,
        target_audience || null,
        sort_order != null ? Number(sort_order) : null,
        is_active != null ? !!is_active : null,
        start_at !== undefined ? (start_at || null) : null,
        end_at !== undefined ? (end_at || null) : null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '轮播不存在' });
    }
    res.json({ code: 200, message: '轮播已更新' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/**
 * 删除轮播（管理端）
 */
router.delete('/carousel/:id', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const result = await query('DELETE FROM portal_carousel WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '轮播不存在' });
    }
    res.json({ code: 200, message: '轮播已删除' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
