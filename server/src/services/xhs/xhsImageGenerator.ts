/**
 * 小红书 P4：生图服务（写入小红书独立图库 xhs_image）
 *
 * 与 services/content/imageGenerator.ts **平行实现**，理由：GEO 版写的是 image_library，
 * 改它会引入 GEO 回归风险；两版共用同一张 image_model_config（配置与计费不分家）。
 *
 * 业务错误码：
 *  4001 未配置生图模型 / 未配置 OSS —— 调用方提示并降级为「图库选图」
 *  4002 今日生图额度已用尽 —— 同上
 */
import { decrypt } from '../../utils/crypto';
import {
  getCloudApiConfig,
  getImageModelConfigForUser,
  incrementImageModelUsage,
  createXhsImage,
} from '../../repository';

const SEEDREAM_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-4-0-250828';

export interface GenerateXhsImageParams {
  userId: number;
  xhsCustomerId: number;
  xhsKnowledgeId: number | null;
  imageType: 'cover' | 'illustration';
  prompt: string;
  /** 输出尺寸，默认 1024x1024；小红书竖版建议 '1024x1536' */
  size?: string;
}

export interface GenerateXhsImageResult {
  imageId: number;
  url: string;
  source: 'ai';
  quotaUsedToday: number;
}

function bizError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

export async function generateXhsImageToLibrary(params: GenerateXhsImageParams): Promise<GenerateXhsImageResult> {
  // 1. 生图配置（本人自备 KEY → 平台共享 KEY）
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
  const ossKey = `xhs-ai-images/${today}/customer-${params.xhsCustomerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await client.put(ossKey, buffer);
  const cdnBase = ossCfg.aliyun_oss_cdn ? String(ossCfg.aliyun_oss_cdn).replace(/\/$/, '') : '';
  const url = cdnBase
    ? `${cdnBase}/${ossKey}`
    : `https://${ossCfg.aliyun_oss_bucket}.${String(ossCfg.aliyun_oss_endpoint || 'oss-cn-hangzhou.aliyuncs.com').replace('https://', '')}/${ossKey}`;

  // 6. 写小红书图库（source='ai' 便于按来源筛选）
  const imageId = await createXhsImage({
    xhs_customer_id: params.xhsCustomerId,
    xhs_knowledge_id: params.xhsKnowledgeId,
    owner_user_id: params.userId,
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
