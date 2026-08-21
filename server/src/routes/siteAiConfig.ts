import { Router } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';
import { encrypt, decrypt } from '../utils/crypto';

/**
 * 灵犀站点引擎 v3 — 板块独立 AI 模型配置（SITE_ENGINE_PLAN）
 *
 * 建站模型配置从「智能体公司」独立出来：按 user_id 单行存储，
 * api_key 用 crypto.ts encrypt() 加密入库、decrypt() 解密返回明文（与 ai_model_config 策略一致）。
 * 桌面端「AI 模型配置」页读写此接口，建站对话与 Pi 底座生成统一读取。
 */
const router = Router();

router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? 0);
}

// 读取当前用户配置（api_key 解密明文返回；未配置返回 data: null）
router.get('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    const r = await query('SELECT * FROM site_ai_config WHERE user_id = $1', [uid]);
    if (!r.rows[0]) {
      return res.json({ code: 200, data: null });
    }
    const row = r.rows[0];
    let apiKey = '';
    try {
      apiKey = row.api_key_encrypted ? decrypt(row.api_key_encrypted) : '';
    } catch (e: any) {
      console.warn('[SiteAiConfig] API-KEY 解密失败:', e.message);
    }
    res.json({
      code: 200,
      data: {
        provider: row.provider,
        modelName: row.model_name,
        apiKey,
        baseUrl: row.base_url,
        temperature: row.temperature,
        systemPrompt: row.system_prompt,
        updatedAt: row.updated_at,
      },
    });
  } catch (e: any) {
    console.error('[SiteAiConfig] 读取失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 保存当前用户配置（upsert；apiKey 为空字符串时保留原 key）
router.put('/', async (req, res) => {
  try {
    const uid = getUserId(req);
    const { provider, modelName, apiKey, baseUrl, temperature, systemPrompt } = req.body || {};
    const encrypted = apiKey ? encrypt(String(apiKey)) : '';
    await query(
      `INSERT INTO site_ai_config
         (user_id, provider, model_name, api_key_encrypted, base_url, temperature, system_prompt, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model_name = EXCLUDED.model_name,
         api_key_encrypted = CASE
           WHEN EXCLUDED.api_key_encrypted = '' THEN site_ai_config.api_key_encrypted
           ELSE EXCLUDED.api_key_encrypted
         END,
         base_url = EXCLUDED.base_url,
         temperature = EXCLUDED.temperature,
         system_prompt = EXCLUDED.system_prompt,
         updated_at = CURRENT_TIMESTAMP`,
      [uid, provider || 'deepseek', modelName || '', encrypted, baseUrl || '', temperature ?? 0.7, systemPrompt || '']
    );
    res.json({ code: 200, message: '保存成功' });
  } catch (e: any) {
    console.error('[SiteAiConfig] 保存失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

export default router;
