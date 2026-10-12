/**
 * 小红书配图策略（v2.14.0）
 *
 * 任务创建时由用户选择，生成器逐篇执行：
 *  - gallery           图库优先（默认）：企业图库取封面/插画（原行为）
 *  - gallery_ai        图库 + AI 补齐：图库取图后，缺封面/内页不足的部分用 Seedream 补上
 *  - ai                AI 生图为主：按配图脚本自动生图（封面 1 张 + 内页 illustration_count 张）
 *  - article_to_image  正文转图：生成端不取图，文章产出后由桌面端「制作卡片 / 一键出图」排成图片
 *  - search            搜图下载待选：按配图脚本搜索下载候选图（is_candidate=true），生成后在笔记编辑器人工挑选
 *
 * 所有 AI / 搜图失败均不阻断生成，只记 warning（缺图时笔记仍产出，可后续手动补图）。
 */
import { getRandomXhsImages, getXhsImageById, createXhsImage } from '../../repository';
import { generateXhsImageToLibrary, uploadXhsImageBuffer } from './xhsImageGenerator';

export type XhsImageStrategy = 'gallery' | 'gallery_ai' | 'ai' | 'article_to_image' | 'search';

export const XHS_IMAGE_STRATEGIES: XhsImageStrategy[] = ['gallery', 'gallery_ai', 'ai', 'article_to_image', 'search'];

export function normalizeImageStrategy(v: any): XhsImageStrategy {
  const s = String(v || '').trim();
  return (XHS_IMAGE_STRATEGIES as string[]).includes(s) ? (s as XhsImageStrategy) : 'gallery';
}

export interface NoteImagePick { id: number; url: string; }
export interface NoteImages { cover: NoteImagePick | null; illustrations: NoteImagePick[]; }

/** 图库取封面（自 xhsNoteGenerator 迁入，行为不变） */
async function pickGalleryCover(task: any): Promise<any | null> {
  const mode = String(task.cover_image_mode || 'none');
  const customerId = Number(task.xhs_customer_id) || 0;
  if (mode === 'fixed' && task.cover_image_id) {
    const img = await getXhsImageById(Number(task.cover_image_id));
    // 归属校验：只认本客户的图，避免跨客户串图
    if (img && Number(img.xhs_customer_id) === customerId) return img;
    return null;
  }
  if ((mode === 'random' || mode === 'auto') && customerId) {
    const covers = await getRandomXhsImages(customerId, 'cover', 1, task.xhs_knowledge_id ? Number(task.xhs_knowledge_id) : null);
    if (covers.length > 0) return covers[0];
  }
  return null;
}

/** 图库取插画（自 xhsNoteGenerator 迁入，行为不变） */
async function pickGalleryIllustrations(task: any, excludeId?: number | null): Promise<any[]> {
  const want = Number(task.illustration_count) || 0;
  const customerId = Number(task.xhs_customer_id) || 0;
  if (want <= 0 || !customerId) return [];
  const rows = await getRandomXhsImages(
    customerId,
    'illustration',
    Math.min(20, want + 3),
    task.xhs_knowledge_id ? Number(task.xhs_knowledge_id) : null,
  );
  return rows.filter((r: any) => !excludeId || Number(r.id) !== Number(excludeId)).slice(0, Math.min(20, want));
}

/** 从配图脚本取第 i 张的画面描述，无脚本时用兜底文案 */
function scriptScene(imageScript: any[], i: number, fallback: string): string {
  const s = Array.isArray(imageScript) ? imageScript : [];
  const hit = s.find((x) => Number(x?.index) === i + 1) || s[i];
  const scene = String(hit?.scene || '').trim();
  return scene || fallback;
}

/** 生图 prompt：统一竖版 3:4、实拍感、无文字水印 */
function buildAiPrompt(scene: string, kind: 'cover' | 'illustration'): string {
  const base = kind === 'cover' ? '小红书封面图，竖版 3:4' : '小红书配图，竖版 3:4';
  return `${scene}。${base}，生活化实拍感，自然光，浅色调，画面干净留白，不要任何文字、不要水印、不要 logo`;
}

async function aiGenerateOne(params: {
  userId: number; task: any; kind: 'cover' | 'illustration'; prompt: string;
}): Promise<NoteImagePick | null> {
  const customerId = Number(params.task.xhs_customer_id) || 0;
  if (!customerId) return null;
  try {
    const r = await generateXhsImageToLibrary({
      userId: params.userId,
      xhsCustomerId: customerId,
      xhsKnowledgeId: params.task.xhs_knowledge_id ? Number(params.task.xhs_knowledge_id) : null,
      imageType: params.kind,
      prompt: params.prompt,
      size: '1024x1536',
    });
    return { id: r.imageId, url: r.url };
  } catch (e: any) {
    console.warn(`[XhsImg] AI 生图失败（${params.kind}）: ${e?.message || e}`);
    return null;
  }
}

/** Bing 图片搜索（无 key，HTML 解析取原图直链；失败返回空数组不抛错） */
async function bingImageSearch(query: string, limit: number): Promise<string[]> {
  try {
    const resp = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&mkt=zh-CN`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const found = new Set<string>();
    // 两种编码形态：HTML 实体转义 / 原始 JSON
    for (const re of [/murl&quot;:&quot;(.*?)&quot;/g, /\bmurl":"(.*?)"/g]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && found.size < limit * 3) {
        const u = String(m[1] || '').replace(/\\\//g, '/');
        if (/^https?:\/\//.test(u) && /\.(jpe?g|png|webp)(\?|$)/i.test(u)) found.add(u);
      }
    }
    return [...found].slice(0, limit);
  } catch (e: any) {
    console.warn(`[XhsImg] 搜图失败（${query}）: ${e?.message || e}`);
    return [];
  }
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string; ext: string } | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: url,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const contentType = String(resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null;
    const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    return { buffer, contentType, ext: extMap[contentType] || 'jpg' };
  } catch {
    return null;
  }
}

/** 搜图下载进候选池（source='searched' + is_candidate=true），不做配图绑定 */
async function downloadSearchCandidates(task: any, userId: number, queries: string[]): Promise<number> {
  const customerId = Number(task.xhs_customer_id) || 0;
  if (!customerId) return 0;
  let saved = 0;
  const seen = new Set<string>();
  for (const q of queries.slice(0, 4)) {
    const urls = await bingImageSearch(q, 3);
    for (const u of urls) {
      if (saved >= 9 || seen.has(u)) continue;
      seen.add(u);
      const img = await downloadImage(u);
      if (!img) continue;
      try {
        const up = await uploadXhsImageBuffer({ userId, buffer: img.buffer, keyPrefix: 'xhs-searched', ext: img.ext, contentType: img.contentType });
        await createXhsImage({
          xhs_customer_id: customerId,
          xhs_knowledge_id: task.xhs_knowledge_id ? Number(task.xhs_knowledge_id) : null,
          owner_user_id: userId,
          image_type: 'illustration',
          url: up.url,
          file_path: up.ossKey,
          original_name: up.ossKey.split('/').pop(),
          file_size: img.buffer.length,
          mime_type: img.contentType,
          description: `搜图候选：${q}`,
          tags: [],
          sort_order: 0,
          source: 'searched',
          prompt: null,
          is_candidate: true,
        });
        saved++;
      } catch (e: any) {
        console.warn(`[XhsImg] 候选图入库失败: ${e?.message || e}`);
      }
    }
  }
  return saved;
}

/** 由配图脚本 / 选题词生成搜索词（最多 4 条） */
function buildSearchQueries(params: { imageScript: any[]; topicAngle: string; keyword: string; title: string }): string[] {
  const qs: string[] = [];
  const s = Array.isArray(params.imageScript) ? params.imageScript : [];
  for (const item of s) {
    const scene = String(item?.scene || '').trim();
    if (scene) qs.push(scene.slice(0, 24));
  }
  if (qs.length === 0) qs.push(params.keyword || params.topicAngle || params.title);
  return [...new Set(qs.filter(Boolean))];
}

/** 主入口：按策略解析本篇笔记的配图 */
export async function resolveNoteImages(params: {
  strategy: XhsImageStrategy;
  task: any;
  userId: number;
  imageScript: Array<{ index?: number; role?: string; scene?: string }>;
  title: string;
  coverText: string;
  topicAngle: string;
  keyword: string;
}): Promise<NoteImages> {
  const { strategy, task, userId } = params;
  const wanted = Math.max(0, Number(task.illustration_count) || 0);

  // 正文转图：生成端不取图（桌面端排图）
  if (strategy === 'article_to_image') {
    return { cover: null, illustrations: [] };
  }

  // 搜图：下载候选池，等人工挑选
  if (strategy === 'search') {
    const saved = await downloadSearchCandidates(task, userId, buildSearchQueries(params));
    console.log(`[XhsImg] 搜图候选已下载 ${saved} 张（待人工挑选）`);
    return { cover: null, illustrations: [] };
  }

  // gallery / gallery_ai / ai
  let cover: NoteImagePick | null = null;
  const illustrations: NoteImagePick[] = [];
  // v2.15.3 封面模式「大字模式」：封面不出图（封面大字由桌面端渲染成纯文字封面图），插画不受影响
  const textCover = String(task.cover_image_mode || '') === 'text';

  if (strategy !== 'ai') {
    const gCover = textCover ? null : await pickGalleryCover(task);
    if (gCover?.url) cover = { id: Number(gCover.id), url: String(gCover.url) };
    const gIllu = await pickGalleryIllustrations(task, gCover?.id ?? null);
    for (const r of gIllu) illustrations.push({ id: Number(r.id), url: String(r.url) });
  }

  if (strategy === 'ai' || strategy === 'gallery_ai') {
    // 封面：ai 策略必生成；gallery_ai 仅在图库缺封面时生成；大字模式一律不生成（留给桌面端渲染文字封面）
    if (!cover && !textCover) {
      const scene = scriptScene(params.imageScript, 0, `${params.title}${params.coverText ? `（封面大字：${params.coverText}）` : ''}`);
      const gen = await aiGenerateOne({ userId, task, kind: 'cover', prompt: buildAiPrompt(scene, 'cover') });
      if (gen) cover = gen;
    }
    // 内页：补到 illustration_count 张（单张失败即停，避免连续踩额度/配置错误）
    while (illustrations.length < wanted) {
      const idx = illustrations.length;
      const scene = scriptScene(params.imageScript, idx + 1, `${params.topicAngle || params.keyword || params.title} 场景细节`);
      const gen = await aiGenerateOne({ userId, task, kind: 'illustration', prompt: buildAiPrompt(scene, 'illustration') });
      if (!gen) break;
      illustrations.push(gen);
    }
  }

  return { cover, illustrations };
}