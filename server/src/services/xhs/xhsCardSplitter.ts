/**
 * 图文卡片 AI 拆页（XHS_CARD_STUDIO）
 *
 * 输入：笔记详情（正文 / 封面大字 / 配图脚本 / 知识库）→ 输出每页 {title, text}。
 * 失败兜底：image_script 转换 → 正文段落切分（source: 'fallback'）。
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

export interface CardSplitPage { title: string; text: string }

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
    console.warn(`[XhsCards] 笔记 ${articleId} AI 拆页失败，降级配图脚本/段落切页:`, e?.message);
    return { pages: fallback, source: 'fallback' };
  }
}

/** 清洗 AI 输出：title ≤12 字、text ≤60 字、条数收敛到 [MIN, requested/MAX] */
function normalizePages(raw: any, requested: number | null): CardSplitPage[] {
  if (!Array.isArray(raw)) return [];
  const pages = raw
    .map((p: any) => ({
      title: String(p?.title || '').trim().slice(0, 12),
      text: String(p?.text || '').trim().slice(0, 60),
    }))
    .filter((p) => p.title || p.text);
  if (pages.length === 0) return [];
  const max = requested || MAX_PAGES;
  return pages.slice(0, max).map((p, i) => ({ ...p, title: p.title || `第 ${i + 1} 页` }));
}

/** 兜底：配图脚本（role→title / scene→text）→ 无脚本时正文段落切页 */
function fallbackPages(detail: any, requested: number | null): CardSplitPage[] {
  const max = requested || 6;
  const script = Array.isArray(detail.image_script) ? detail.image_script : [];
  if (script.length >= 2) {
    return script.slice(0, max).map((s: any, i: number) => ({
      title: String(s?.role || `第 ${i + 1} 页`).trim().slice(0, 12),
      text: String(s?.scene || '').trim().slice(0, 60),
    }));
  }
  const paras = stripHtml(String(detail.content_html || ''))
    .split(/\n+/).map((s: string) => s.trim()).filter(Boolean);
  const head = String(detail.cover_title || detail.title || '本篇要点').trim().slice(0, 12);
  const pages: CardSplitPage[] = [{ title: head, text: '' }];
  paras.slice(0, max - 1).forEach((p: string) => {
    pages.push({ title: p.slice(0, 12), text: p.length > 12 ? p.slice(12, 72) : '' });
  });
  return pages.length >= 2
    ? pages
    : [{ title: head, text: '' }, { title: '要点 1', text: String(paras[0] || '').slice(0, 60) }];
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