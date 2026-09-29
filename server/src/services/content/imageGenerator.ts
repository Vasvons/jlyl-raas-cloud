/**
 * 小红书运营大师：AI 文生图服务（XHS_MASTER_PLAN）
 *
 * 流程：读生图配置（用户自备优先 → 平台共享兜底）→ 调火山方舟 Seedream →
 *       下载图片 → 上传阿里云 OSS（与 routes/content.ts 的
 *       POST /publish/records/:id/screenshot 同一套 ali-oss 用法）→
 *       写入 image_library（source='ai', prompt=提示词）
 *
 * 配置与计费：独立 image_model_config 表，不复用 ai_model_config
 *（参照 pet_model_config「独立配置表、避免互相影响」的先例）
 *
 * 降级约定：本模块抛出的业务错误带 code 字段：
 *  4001 未配置生图模型 / 未配置 OSS —— 调用方应提示用户并降级为「企业图库选图」
 *  4002 今日生图额度已用尽 —— 同上降级
 */
import { decrypt } from '../../utils/crypto';
import {
  getCloudApiConfig,
  createImage,
  getImageModelConfigForUser,
  incrementImageModelUsage,
} from '../../repository';

const SEEDREAM_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-4-0-250828';

export interface GenerateImageParams {
  userId: number;
  knowledgeId: number | null;
  imageType: 'cover' | 'illustration';
  prompt: string;
  /** 输出尺寸，默认 1024x1024；小红书竖版封面建议 '1024x1536' */
  size?: string;
}

export interface GenerateImageResult {
  imageId: number;
  url: string;
  source: 'ai';
  quotaUsedToday: number;
}

function bizError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

export async function generateImageToLibrary(params: GenerateImageParams): Promise<GenerateImageResult> {
  // 1. 生图配置
  const cfg = await getImageModelConfigForUser(params.userId);
  if (!cfg) {
    throw bizError('未配置生图模型（请在「账号与素材 → 生图模型配置」中配置 API-KEY），可改用企业图库选图', 4001);
  }

  // 2. 日额度校验（daily_quota 为空表示不限量）
  if (cfg.daily_quota != null && Number(cfg.used_today) >= Number(cfg.daily_quota)) {
    throw bizError(`今日生图额度已用尽（${cfg.used_today}/${cfg.daily_quota}），可改用企业图库选图`, 4002);
  }

  const apiKey = decrypt(cfg.api_key_encrypted);
  const baseUrl = String(cfg.base_url || SEEDREAM_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = cfg.model_name || SEEDREAM_DEFAULT_MODEL;

  // 3. 调 Seedream（火山方舟 OpenAI 风格 images/generations）
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt: params.prompt,
      size: params.size || '1024x1024',
      response_format: 'url',
      sequential_image_generation: 'disabled',
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`生图接口调用失败 HTTP ${resp.status}: ${errText.substring(0, 400)}`);
  }
  const data: any = await resp.json();
  const remoteUrl: string = data?.data?.[0]?.url || '';
  if (!remoteUrl) {
    throw new Error(`生图接口未返回图片 URL: ${JSON.stringify(data).substring(0, 300)}`);
  }

  // 4. 下载生成图
  const imgResp = await fetch(remoteUrl);
  if (!imgResp.ok) throw new Error(`下载生成图失败 HTTP ${imgResp.status}`);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  // 5. 上传 OSS
  const ossCfg = await getCloudApiConfig(params.userId);
  if (!ossCfg?.aliyun_access_key || !ossCfg?.aliyun_access_secret || !ossCfg?.aliyun_oss_bucket) {
    throw bizError('未配置阿里云 OSS（请在「后台配置 → 云接口配置」中填写），可改用企业图库选图', 4001);
  }
  const OSS = (await import('ali-oss')).default; // 动态 import，避免启动时加载未使用依赖
  const client = new OSS({
    accessKeyId: ossCfg.aliyun_access_key,
    accessKeySecret: ossCfg.aliyun_access_secret,
    bucket: ossCfg.aliyun_oss_bucket,
    endpoint: ossCfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com',
    secure: true,
  });
  const today = new Date().toISOString().slice(0, 10);
  const ossKey = `xhs-ai-images/${today}/user-${params.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await client.put(ossKey, buffer);
  const cdnBase = ossCfg.aliyun_oss_cdn ? String(ossCfg.aliyun_oss_cdn).replace(/\/$/, '') : '';
  const url = cdnBase
    ? `${cdnBase}/${ossKey}`
    : `https://${ossCfg.aliyun_oss_bucket}.${String(ossCfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com').replace('https://', '')}/${ossKey}`;

  // 6. 写 image_library（source='ai' 便于图库按来源筛选）
  const imageId = await createImage({
    user_id: params.userId,
    knowledge_id: params.knowledgeId,
    image_type: params.imageType,
    url,
    file_path: ossKey,
    original_name: ossKey.split('/').pop(),
    file_size: buffer.length,
    mime_type: 'image/png',
    description: params.prompt.slice(0, 200),
    tags: [],
    sort_order: 0,
    source: 'ai',
    prompt: params.prompt,
  });

  // 7. 配额 +1
  await incrementImageModelUsage(cfg.id);
  return { imageId, url, source: 'ai', quotaUsedToday: Number(cfg.used_today || 0) + 1 };
}