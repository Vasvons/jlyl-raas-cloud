/**
 * 图文卡片 AI 拆页（XHS_CARD_STUDIO）
 *
 * 输入：笔记详情（正文 / 封面大字 / 配图脚本 / 知识库）→ 输出每页 {title, text}。
 * 失败兜底：正文段落切页 → 正文为空时才用 image_script（source: 'fallback'）。
 *
 * 解耦约束：复用小红书独立内核（prompts / xhsNoteGenerator 的模型解析），不碰 GEO 逻辑。
 */
import { query } from '../../db';
import { chatCompletion } from '../content/aiClient';
import { getXhsNoteDetail, getXhsKnowledgeById, getActiveManualRulesByIndustry } from '../../repository';
import { resolveXhsModel } from './xhsNoteGenerator';
import { buildCardSplitMessages, formatEnterpriseForXhs, buildComplianceBlock } from './prompts';
import { extractJson } from './xhsTopicPicker';

const MIN_PAGES = 3;
const MAX_PAGES = 9;

/** 内容块类型（与桌面端排版引擎 ContentBlockType 对齐） */
export type CardBlockType = 'heading' | 'section' | 'subheading' | 'paragraph' | 'bullet' | 'quote';
export interface CardSplitBlock { type: CardBlockType; text: string }

/**
 * 单页拆页结果。
 * - blocks：结构化内容块（v2.17.0 起，桌面端排版引擎据此自适应排版）
 * - title / text：由 blocks 派生，保留字段以兼容旧版桌面端
 */
export interface CardSplitPage { title: string; text: string; blocks: CardSplitBlock[] }

const BLOCK_TYPES: CardBlockType[] = ['heading', 'section', 'subheading', 'paragraph', 'bullet', 'quote'];
const BLOCK_MAX: Record<CardBlockType, number> = {
  heading: 14, section: 16, subheading: 16, paragraph: 80, bullet: 50, quote: 60,
};

export async function splitNoteIntoCardPages(
  articleId: number,
  userId: number,
  opts: { pageCount?: number | null; extraRequirement?: string } = {},
): Promise<{ pages: CardSplitPage[]; source: 'ai' | 'fallback' }> {
  const detail = await getXhsNoteDetail(articleId);
  if (!detail) throw new Error('笔记不存在');
  if (Number(detail.user_id) !== userId) throw new Error('无权操作该笔记');

  const requested = opts.pageCount ? Math.min(MAX_PAGES, Math.max(MIN_PAGES, Number(opts.pageCount))) : null;

  // 1. 兜底页（先备好，AI 失败直接用）
  const fallback = fallbackPages(detail, requested);

  // 2. 模型：优先任务上指定的写作模型，否则用户默认写作模型
  let model: { baseUrl: string; apiKey: string; model: string };
  try {
    const t = await query(
      'SELECT t.model_config_id, t.industry FROM article a LEFT JOIN ai_writing_task t ON t.id = a.task_id WHERE a.id = $1',
      [articleId]
    );
    const task = t.rows[0] || {};
    model = await resolveXhsModel(task, userId);

    // 3. 知识库与合规（均容错，不阻断拆页）
    let enterpriseText = '（无企业信息）';
    if (detail.xhs_knowledge_id) {
      try {
        const kb = await getXhsKnowledgeById(Number(detail.xhs_knowledge_id));
        if (kb) enterpriseText = formatEnterpriseForXhs(kb);
      } catch { /* 静默 */ }
    }
    let complianceBlock = '';
    try {
      const industry = String(task.industry || '');
      const rules = industry ? await getActiveManualRulesByIndustry(industry) : [];
      complianceBlock = buildComplianceBlock(rules);
    } catch { /* 静默 */ }

    const messages = buildCardSplitMessages({
      noteTitle: String(detail.title || ''),
      coverText: String(detail.cover_title || ''),
      bodyText: stripHtml(String(detail.content_html || '')).slice(0, 4000),
      enterpriseText,
      imageScript: Array.isArray(detail.image_script) ? detail.image_script : [],
      pageCount: requested,
      extraRequirement: String(opts.extraRequirement || '').slice(0, 200),
      complianceBlock,
    });

    const resp = await chatCompletion({
      baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model,
      messages, temperature: 0.65, maxTokens: 4096, timeout: 120000,
    });
    const parsed = extractJson(resp.content);
    const pages = normalizePages(parsed?.pages, requested);
    if (pages.length === 0) return { pages: fallback, source: 'fallback' };
    return { pages, source: 'ai' };
  } catch (e: any) {
    console.warn(`[XhsCards] 笔记 ${articleId} AI 拆页失败，降级正文段落切页:`, e?.message);
    return { pages: fallback, source: 'fallback' };
  }
}

/**
 * 清洗 AI 输出：解析 blocks（白名单归一 + 各类型字数截断），
 * 兼容旧格式 {title, text}（→ heading + paragraph），条数收敛到 [MIN, requested/MAX]。
 */
function normalizePages(raw: any, requested: number | null): CardSplitPage[] {
  if (!Array.isArray(raw)) return [];
  const pages: CardSplitPage[] = [];
  for (const p of raw) {
    let blocks = normalizeBlocks(p?.blocks);
    // 兼容旧格式：无 blocks 时用 {title, text} 还原成 heading + paragraph
    if (blocks.length === 0) {
      const title = String(p?.title || '').trim().slice(0, BLOCK_MAX.heading);
      const text = String(p?.text || '').trim().slice(0, BLOCK_MAX.paragraph);
      if (title) blocks.push({ type: 'heading', text: title });
      if (text) blocks.push({ type: 'paragraph', text });
    }
    if (blocks.length === 0) continue;
    pages.push(withDerived(blocks));
  }
  if (pages.length === 0) return [];
  const max = requested || MAX_PAGES;
  return pages.slice(0, max).map((pg, i) => (
    pg.blocks.some((b) => b.type === 'heading') ? pg : withDerived([{ type: 'heading', text: `第 ${i + 1} 页` }, ...pg.blocks])
  ));
}

/** blocks 白名单归一：未知类型丢弃、空文本丢弃、按类型上限截断、压缩空白 */
function normalizeBlocks(raw: any): CardSplitBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: CardSplitBlock[] = [];
  for (const b of raw) {
    const type = String(b?.type || '').trim().toLowerCase() as CardBlockType;
    if (!BLOCK_TYPES.includes(type)) continue;
    const text = String(b?.text ?? '').trim().replace(/\s+/g, ' ').slice(0, BLOCK_MAX[type]);
    if (!text) continue;
    out.push({ type, text });
  }
  return out;
}

/** 由 blocks 派生 title / text（兼容字段）：title 取首个 heading、text 取首个 paragraph/quote */
function withDerived(blocks: CardSplitBlock[]): CardSplitPage {
  const heading = blocks.find((b) => b.type === 'heading');
  const para = blocks.find((b) => b.type === 'paragraph' || b.type === 'quote');
  return { blocks, title: heading?.text || '', text: para?.text || '' };
}

/**
 * 兜底：优先用【笔记正文】结构化切页；仅当正文为空时才退回【配图脚本】。
 *
 * 说明（v2.16.2 修复）：此前是「配图脚本优先」，而绝大多数笔记都带配图脚本，
 * 导致未配置写作模型 / AI 失败时，卡片载入的是"拍什么画面"的脚本而不是标题+正文。
 * v2.17.0：产出结构化 blocks（识别有序列表 / 分区标题），交由桌面端排版引擎自适应排版。
 */
function fallbackPages(detail: any, requested: number | null): CardSplitPage[] {
  const max = requested || 6;
  const head = String(detail.cover_title || detail.title || '本篇要点').trim().slice(0, BLOCK_MAX.heading);

  const paras = stripHtml(String(detail.content_html || ''))
    .split(/\n+/).map((s: string) => s.trim()).filter(Boolean);

  if (paras.length > 0) {
    // 第 1 页：封面标题 + 首段正文
    const pages: CardSplitPage[] = [withDerived([
      { type: 'heading', text: head },
      { type: 'paragraph', text: paras[0].slice(0, BLOCK_MAX.paragraph) },
    ])];
    // 后续段：按本地规则识别块类型（列表项 / 分区标题 / 普通段落）
    for (const p of paras.slice(1, max)) {
      pages.push(withDerived([localBlockOf(p)]));
    }
    if (pages.length < 2) pages.push(withDerived([{ type: 'heading', text: '核心要点' }]));
    return pages;
  }

  // 正文为空：退回配图脚本（role→heading / scene→paragraph）
  const script = Array.isArray(detail.image_script) ? detail.image_script : [];
  if (script.length > 0) {
    return script.slice(0, max).map((s: any, i: number) => withDerived([
      { type: 'heading', text: String(s?.role || `第 ${i + 1} 页`).trim().slice(0, BLOCK_MAX.heading) },
      { type: 'paragraph', text: String(s?.scene || '').trim().slice(0, BLOCK_MAX.paragraph) },
    ]));
  }

  return [withDerived([{ type: 'heading', text: head }])];
}

const BULLET_RE = /^\s*(?:\d{1,2}\s*[、.．)）]|[①-⑳]|[（(]\s*\d{1,2}\s*[)）]|[•·▪◦*\-–—])\s*/;
const SUBHEADING_RE = /^(?:核心要点|要点|重点|小贴士|温馨提示|提示|注意|结论|总结|说明|建议|Tips)\s*[:：]?/i;
const EMOJI_LEAD_RE = /^\p{Extended_Pictographic}/u;

/** 单段文本 → 内容块（本地兜底规则，与桌面端 structurePlainText 语义一致） */
function localBlockOf(raw: string): CardSplitBlock {
  const text = String(raw || '').trim();
  if (BULLET_RE.test(text)) {
    const body = text.replace(BULLET_RE, '').slice(0, BLOCK_MAX.bullet);
    return { type: 'bullet', text: body || text.slice(0, BLOCK_MAX.bullet) };
  }
  if (SUBHEADING_RE.test(text) || (EMOJI_LEAD_RE.test(text) && text.length <= 20)) {
    return { type: 'section', text: text.slice(0, BLOCK_MAX.section) };
  }
  return { type: 'paragraph', text: text.slice(0, BLOCK_MAX.paragraph) };
}

/** 去标签 → 纯文本（段落之间填空行） */
function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}