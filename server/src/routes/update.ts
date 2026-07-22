/**
 * 桌面端更新分发（v2.5.35 阶段三）
 *
 * 路由列表：
 *   POST /api/updates/publish            - 管理员发布更新（接收 exe + latest.yml + blockmap）
 *   GET  /api/updates/releases           - 查询发布历史（管理员）
 *   GET  /api/updates/latest             - 代理客户端检查最新版本（支持灰度）
 *   POST /api/updates/:id/downloaded     - 上报下载完成
 *   POST /api/updates/:id/installed      - 上报安装完成
 *   DELETE /api/updates/:id               - 删除发布（仅 super_admin）
 *   POST /api/updates/:id/rollout        - 调整灰度范围（仅 super_admin）
 *   GET  /api/updates/latest.yml         - electron-updater 直接拉取的 latest.yml（代理客户端专用）
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { getCloudApiConfig } from '../repository';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

router.use(authMiddleware);

function getUserId(req: Request): number {
  const user = (req as any).user;
  return Number(user?.id ?? 0);
}

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'super_admin' || user?.role === 'admin' || user?.level === '1';
}

function isAgent(req: Request): boolean {
  const user = (req as any).user;
  return user?.role === 'agent';
}

/**
 * 上传 exe/blockmap/latest.yml 到 OSS
 * 使用超级管理员的 cloud_api_config（user_id IS NULL 的平台共享配置）
 */
async function uploadToOSS(
  fileBuffer: Buffer,
  fileName: string,
  userId: number
): Promise<string> {
  // 优先用传入 userId 的 OSS 配置，回退到平台共享配置（user_id IS NULL）
  let cfg = await getCloudApiConfig(userId);
  if (!cfg?.aliyun_access_key) {
    const sharedResult = await query(
      `SELECT * FROM cloud_api_config WHERE user_id IS NULL LIMIT 1`
    );
    cfg = sharedResult.rows[0] || cfg;
  }
  if (!cfg?.aliyun_access_key || !cfg?.aliyun_access_secret || !cfg?.aliyun_oss_bucket) {
    throw new Error('未配置阿里云 OSS（需在后台配置中设置 access_key / access_secret / bucket）');
  }

  const OSS = (await import('ali-oss')).default;
  const client = new OSS({
    accessKeyId: cfg.aliyun_access_key,
    accessKeySecret: cfg.aliyun_access_secret,
    bucket: cfg.aliyun_oss_bucket,
    endpoint: cfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com',
    secure: true,
  });

  const today = new Date().toISOString().slice(0, 10);
  const key = `desktop-updates/${today}/${fileName}`;
  await client.put(key, fileBuffer);

  const cdnBase = cfg.aliyun_oss_cdn ? cfg.aliyun_oss_cdn.replace(/\/$/, '') : '';
  return cdnBase
    ? `${cdnBase}/${key}`
    : `https://${cfg.aliyun_oss_bucket}.${(cfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com').replace('https://', '')}/${key}`;
}

// ============ 管理员：发布更新（JSON 模式，桌面端专用）============
// 桌面端先通过 IPC 上传 exe/blockmap/latest.yml 到 OSS，再调用此接口传入 URL

router.post('/publish-json', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const {
      version, changelog, release_type, rollout_strategy, gray_agent_ids,
      oss_exe_url, oss_blockmap_url, latest_yml,
    } = req.body;

    if (!version) return res.status(400).json({ code: 400, message: 'version 必填' });
    if (!oss_exe_url) return res.status(400).json({ code: 400, message: '缺少 oss_exe_url' });
    if (!latest_yml) return res.status(400).json({ code: 400, message: '缺少 latest_yml 内容' });

    const userId = getUserId(req);

    // 检查版本号是否已存在
    const existing = await query('SELECT id FROM desktop_update_release WHERE version = $1', [version]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ code: 409, message: `版本 ${version} 已存在` });
    }

    // 解析 gray_agent_ids
    let grayIds: number[] = [];
    if (rollout_strategy === 'gray' && Array.isArray(gray_agent_ids)) {
      grayIds = gray_agent_ids.map(Number).filter(Boolean);
    }

    const result = await query(
      `INSERT INTO desktop_update_release
        (version, changelog, release_type, rollout_strategy, gray_agent_ids,
         oss_exe_url, oss_blockmap_url, latest_yml, published_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
       RETURNING id, published_at`,
      [
        version,
        changelog || '',
        release_type || 'optional',
        rollout_strategy || 'full',
        grayIds,
        oss_exe_url,
        oss_blockmap_url || null,
        latest_yml,
        userId,
      ]
    );

    res.json({
      code: 200,
      data: {
        id: result.rows[0].id,
        published_at: result.rows[0].published_at,
      },
      message: `版本 ${version} 发布成功`,
    });
  } catch (e: any) {
    console.error('[Update] publish-json 失败:', e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：发布更新（multipart 模式，Web 端专用）============

router.post('/publish', upload.fields([
  { name: 'exe', maxCount: 1 },
  { name: 'blockmap', maxCount: 1 },
  { name: 'latestYml', maxCount: 1 },
]), async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const { version, changelog, release_type, rollout_strategy, gray_agent_ids } = req.body;

    if (!version) return res.status(400).json({ code: 400, message: 'version 必填' });
    if (!files?.exe?.[0]) return res.status(400).json({ code: 400, message: '缺少 exe 文件' });
    if (!files?.latestYml?.[0]) return res.status(400).json({ code: 400, message: '缺少 latest.yml 文件' });

    const userId = getUserId(req);

    // 检查版本号是否已存在
    const existing = await query('SELECT id FROM desktop_update_release WHERE version = $1', [version]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ code: 409, message: `版本 ${version} 已存在` });
    }

    // 上传文件到 OSS
    const exeFileName = `聚量引力RaaS-Setup-${version}.exe`;
    const exeUrl = await uploadToOSS(files.exe[0].buffer, exeFileName, userId);

    let blockmapUrl: string | null = null;
    if (files?.blockmap?.[0]) {
      const blockmapFileName = `聚量引力RaaS-Setup-${version}.exe.blockmap`;
      blockmapUrl = await uploadToOSS(files.blockmap[0].buffer, blockmapFileName, userId);
    }

    const latestYmlContent = files.latestYml[0].buffer.toString('utf-8');
    // 同时上传 latest.yml 到 OSS，方便 electron-updater 直接拉取
    const latestYmlUrl = await uploadToOSS(
      Buffer.from(latestYmlContent, 'utf-8'),
      `latest-${version}.yml`,
      userId
    );

    // 解析 gray_agent_ids
    let grayIds: number[] = [];
    if (rollout_strategy === 'gray' && gray_agent_ids) {
      grayIds = typeof gray_agent_ids === 'string'
        ? gray_agent_ids.split(',').map((s: string) => Number(s.trim())).filter(Boolean)
        : Array.isArray(gray_agent_ids) ? gray_agent_ids.map(Number) : [];
    }

    const result = await query(
      `INSERT INTO desktop_update_release
        (version, changelog, release_type, rollout_strategy, gray_agent_ids,
         oss_exe_url, oss_blockmap_url, latest_yml, published_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
       RETURNING id, published_at`,
      [
        version,
        changelog || '',
        release_type || 'optional',
        rollout_strategy || 'full',
        grayIds,
        exeUrl,
        blockmapUrl,
        latestYmlContent,
        userId,
      ]
    );

    res.json({
      code: 200,
      data: {
        id: result.rows[0].id,
        published_at: result.rows[0].published_at,
        oss_exe_url: exeUrl,
        oss_blockmap_url: blockmapUrl,
        oss_latest_yml_url: latestYmlUrl,
      },
      message: `版本 ${version} 发布成功`,
    });
  } catch (e: any) {
    console.error('[Update] publish 失败:', e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：查询发布历史 ============

router.get('/releases', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const result = await query(
      `SELECT id, version, changelog, release_type, rollout_strategy, gray_agent_ids,
              oss_exe_url, oss_blockmap_url, published_by, published_at, status,
              downloaded_count, installed_count
       FROM desktop_update_release
       ORDER BY published_at DESC
       LIMIT 100`
    );
    res.json({ code: 200, data: result.rows });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：删除发布 ============

router.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user?.role !== 'super_admin' && !(user?.level === '1' && user?.role !== 'admin')) {
    return res.status(403).json({ code: 403, message: '只有超级管理员能删除发布' });
  }
  try {
    await query('DELETE FROM desktop_update_release WHERE id = $1', [Number(req.params.id)]);
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 管理员：调整灰度范围 ============

router.post('/:id/rollout', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ code: 403, message: '无权限' });
  try {
    const id = Number(req.params.id);
    const { rollout_strategy, gray_agent_ids } = req.body;
    let grayIds: number[] = [];
    if (rollout_strategy === 'gray' && Array.isArray(gray_agent_ids)) {
      grayIds = gray_agent_ids.map(Number).filter(Boolean);
    }
    await query(
      `UPDATE desktop_update_release
       SET rollout_strategy = $1, gray_agent_ids = $2
       WHERE id = $3`,
      [rollout_strategy || 'full', grayIds, id]
    );
    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理客户端：检查最新版本 ============

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });

    // 查询所有 published 状态的发布，按时间倒序
    const result = await query(
      `SELECT id, version, changelog, release_type, rollout_strategy, gray_agent_ids,
              oss_exe_url, oss_blockmap_url, latest_yml, published_at
       FROM desktop_update_release
       WHERE status = 'published'
       ORDER BY published_at DESC
       LIMIT 50`
    );

    if (result.rows.length === 0) {
      return res.json({ code: 200, data: { has_update: false } });
    }

    // 根据灰度策略筛选该代理可见的最新版本
    const isAgentUser = isAgent(req);
    let visibleRelease: any = null;
    for (const row of result.rows) {
      if (row.rollout_strategy === 'full') {
        visibleRelease = row;
        break;
      }
      if (row.rollout_strategy === 'gray' && isAgentUser) {
        const grayIds: number[] = row.gray_agent_ids || [];
        if (grayIds.includes(userId)) {
          visibleRelease = row;
          break;
        }
      }
      // 管理员可见所有版本
      if (!isAgentUser) {
        visibleRelease = row;
        break;
      }
    }

    if (!visibleRelease) {
      return res.json({ code: 200, data: { has_update: false } });
    }

    res.json({
      code: 200,
      data: {
        has_update: true,
        release: {
          id: visibleRelease.id,
          version: visibleRelease.version,
          changelog: visibleRelease.changelog,
          release_type: visibleRelease.release_type,
          url: visibleRelease.oss_exe_url,
          blockmap_url: visibleRelease.oss_blockmap_url,
          latest_yml: visibleRelease.latest_yml,
          published_at: visibleRelease.published_at,
        },
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理客户端：上报下载完成 ============

router.post('/:id/downloaded', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    const releaseId = Number(req.params.id);
    const { machine_id, client_version_before } = req.body;

    // upsert 下载记录
    await query(
      `INSERT INTO desktop_update_download
        (release_id, agent_user_id, machine_id, status, downloaded_at, client_version_before)
       VALUES ($1, $2, $3, 'downloaded', NOW(), $4)
       ON CONFLICT (release_id, agent_user_id, machine_id)
       DO UPDATE SET status = 'downloaded', downloaded_at = NOW()`,
      [releaseId, userId, machine_id || null, client_version_before || null]
    );

    // 更新发布表的下载计数
    await query(
      `UPDATE desktop_update_release SET downloaded_count = downloaded_count + 1 WHERE id = $1`,
      [releaseId]
    );

    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 代理客户端：上报安装完成 ============

router.post('/:id/installed', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (userId === 0) return res.status(401).json({ code: 401, message: '未登录' });
    const releaseId = Number(req.params.id);
    const { machine_id, client_version_after } = req.body;

    await query(
      `UPDATE desktop_update_download
       SET status = 'installed', installed_at = NOW(), client_version_after = $1
       WHERE release_id = $2 AND agent_user_id = $3 AND machine_id = $4`,
      [client_version_after || null, releaseId, userId, machine_id || null]
    );

    await query(
      `UPDATE desktop_update_release SET installed_count = installed_count + 1 WHERE id = $1`,
      [releaseId]
    );

    res.json({ code: 200 });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
