/**
 * 小红书运营大师：生图模型配置路由（XHS_MASTER_PLAN）
 *
 * 两套配置并存：
 *  - 平台共享 KEY：user_id IS NULL，仅管理员可写（管理端统一计费，所有代理共用）
 *  - 用户自备 KEY：user_id = 本人，任何登录用户可写
 * 读取生效配置的优先级由 repository.getImageModelConfigForUser 决定（自备优先）
 *
 * api_key 用 utils/crypto.ts 的 encrypt() 加密入库，接口不回传明文，只回传 has_api_key。
 */
import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import { listImageModelConfigs, upsertImageModelConfig } from '../repository';

const router = Router();
router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

/** GET /image-model-config —— 平台共享 + 本人配置（不回传明文 API-KEY） */
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await listImageModelConfigs(getUserId(req));
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[ImageModelConfig] 读取失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /image-model-config —— upsert 本人自备配置（设计文档写 POST，此处按项目既有 upsert 惯例用 PUT） */
router.put('/', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const { platform, modelName, apiKey, baseUrl, dailyQuota, isActive } = req.body || {};
    if (!platform) return res.status(400).json({ code: 400, message: '缺少 platform' });
    if (!modelName) return res.status(400).json({ code: 400, message: '缺少 modelName' });
    const id = await upsertImageModelConfig({
      user_id: uid,
      platform: String(platform),
      model_name: String(modelName),
      api_key: apiKey,
      base_url: baseUrl,
      daily_quota: dailyQuota === undefined || dailyQuota === null || dailyQuota === '' ? null : Number(dailyQuota),
      is_active: isActive === undefined ? true : !!isActive,
    });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[ImageModelConfig] 保存失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /image-model-config/shared —— upsert 平台共享配置（仅管理员） */
router.put('/shared', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { platform, modelName, apiKey, baseUrl, dailyQuota, isActive } = req.body || {};
    if (!platform) return res.status(400).json({ code: 400, message: '缺少 platform' });
    if (!modelName) return res.status(400).json({ code: 400, message: '缺少 modelName' });
    const id = await upsertImageModelConfig({
      user_id: null,
      platform: String(platform),
      model_name: String(modelName),
      api_key: apiKey,
      base_url: baseUrl,
      daily_quota: dailyQuota === undefined || dailyQuota === null || dailyQuota === '' ? null : Number(dailyQuota),
      is_active: isActive === undefined ? true : !!isActive,
    });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[ImageModelConfig] 平台共享配置保存失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

export default router;