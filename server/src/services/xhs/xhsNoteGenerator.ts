/**
 * 小红书图文写作系统 — 生成内核
 *
 * 流程：任务+指令+知识库 → 选题 → 逐篇成文（结构化 JSON）→ 落 article + xhs_note_meta → 取图 → 进度广播
 *
 * 解耦约束：不 import promptBuilder.ts / articleGenerator.ts；
 * 只依赖 aiClient（调模型）、repository（数据）、wsServer（进度广播）。
 */
import { chatCompletion, extractApiErrorMessage } from '../content/aiClient';
import { wsBroadcast } from '../../wsServer';
import {
  getXhsWritingTaskById,
  getAiModelConfigById,
  getDefaultModelConfig,
  createArticle,
  upsertXhsNoteMeta,
  updateWritingTaskProgress,
  completeWritingTask,
  updateArticleCoverImage,
  getXhsImageById,
  getRandomXhsImages,
  getActiveManualRulesByIndustry,
  getAllActiveManualRules,
} from '../../repository';
import { decrypt } from '../../utils/crypto';
import {
  buildNoteMessages,
  buildComplianceBlock,
  formatEnterpriseForXhs,
} from './prompts';
import { pickXhsTopics, extractJson, type XhsTopic } from './xhsTopicPicker';

/** 小红书平台正文硬上限（与 platform_content_rule.platform='xhs'.content_max_length 一致） */
const XHS_CONTENT_MAX = 1000;

/** 解析写作模型配置（不依赖 GEO 的 resolveModelConfig） */
async function resolveXhsModel(task: any, userId: number): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  let cfg: any = null;
  if (task.model_config_id) {
    cfg = await getAiModelConfigById(Number(task.model_config_id));
  }
  if (!cfg) {
    cfg = await getDefaultModelConfig(userId);
  }
  if (!cfg) {
    throw new Error('未配置可用于写作的 AI 模型，请到「后台配置 → AI模型配置」中配置并开启「用于写作」');
  }
  const baseUrl = String(cfg.base_url || '').trim();
  if (!baseUrl) {
    throw new Error(`模型配置「${cfg.model_name || cfg.platform}」缺少 Base URL，请到「后台配置 → AI模型配置」补全`);
  }
  return { baseUrl, apiKey: decrypt(cfg.api_key_encrypted), model: cfg.model_name };
}

/** 纯文本正文 → <p> 段落 HTML（不信任模型输出的 HTML） */
function bodyTextToHtml(body: string): string {
  return String(body || '')
    .split(/\n\s*\n/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => `<p>${seg.replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

/** 剥离标签后的纯文本字数 */
function countText(text: string): number {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\s/g, '').length;
}

/** 超上限按句截断 */
function truncateBody(body: string, max: number): { text: string; truncated: boolean } {
  const plain = String(body || '');
  if (countText(plain) <= max) return { text: plain, truncated: false };
  const sentences = plain.split(/(?<=[。！？!?~])/);
  let acc = '';
  for (const s of sentences) {
    if (countText(acc + s) > max) break;
    acc += s;
  }
  return { text: acc || plain.slice(0, max), truncated: true };
}

/** 取封面图（返回 xhs_image 行或 null） */
async function pickCoverImage(task: any, userId: number): Promise<any | null> {
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

/** 取配图（返回 xhs_image 行数组，保持顺序） */
async function pickIllustrations(task: any, userId: number, excludeId?: number | null): Promise<any[]> {
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

/**
 * 执行小红书写作任务（由 articleGenerator.executeWritingTask 分派调用）
 */
export async function executeXhsWritingTask(taskId: number, userId: number): Promise<void> {
  const task = await getXhsWritingTaskById(taskId);
  if (!task) throw new Error(`小红书写作任务 ${taskId} 不存在`);

  // 1. 体系校验（防止误分派）
  if (String(task.writing_system || 'geo') !== 'xhs') {
    throw new Error(`任务 ${taskId} 的 writing_system=${task.writing_system}，不应由小红书内核执行`);
  }

  const totalCount = Math.max(1, Number(task.total_count) || 1);
  const instruction = task.xhs_instruction_id ? task : null;
  if (!instruction) {
    await completeWritingTask(taskId, 'failed', '小红书写作任务缺少写作指令（xhs_instruction_id 为空）');
    return;
  }

  const model = await resolveXhsModel(task, userId);
  const enterpriseText = formatEnterpriseForXhs(task);

  // 关键词：任务创建时按文本查 ID 落库，这里取回文本
  const { getKeywordsByIds } = await import('../../repository');
  const kwRows = await getKeywordsByIds(Array.isArray(task.keyword_ids) ? task.keyword_ids : []);
  const keywords: string[] = kwRows.map((k: any) => String(k.value || k.keyword || '')).filter(Boolean);

  // 2. 合规块（合规是法律要求，不属于 GEO 逻辑，必须保留）
  let complianceBlock = '';
  try {
    const industry = String(task.industry || '');
    const rules = industry
      ? await getActiveManualRulesByIndustry(industry)
      : await getAllActiveManualRules();
    complianceBlock = buildComplianceBlock(rules);
  } catch (e: any) {
    console.warn(`[XhsGen] 任务 ${taskId} 合规规则读取失败（不阻断）:`, e?.message);
  }

  // 3. 选题：优先使用用户在两步向导里确认过的选题；否则调用选题器
  let topics: XhsTopic[] = [];
  const confirmed: any[] = Array.isArray(task.xhs_topics) ? task.xhs_topics : [];
  if (confirmed.length > 0) {
    topics = confirmed.map((t: any) => ({
      angle: String(t?.angle || '').trim(),
      keyword: String(t?.keyword || '').trim(),
      hook: String(t?.hook || '').trim(),
      title: String(t?.title || '').trim(),
      topics: Array.isArray(t?.topics) ? t.topics.map((x: any) => String(x)) : [],
    })).filter((t) => t.angle || t.title);
    console.log(`[XhsGen] 任务 ${taskId} 使用用户确认的 ${topics.length} 个选题（跳过选题器）`);
  }
  if (topics.length === 0) {
    try {
      topics = await pickXhsTopics({
        keywords,
        count: totalCount,
        enterpriseText,
        accountType: String(task.account_type || 'creator'),
        model,
      });
    } catch (e: any) {
      console.warn(`[XhsGen] 任务 ${taskId} 选题失败，降级为关键词直用:`, e?.message);
      topics = Array.from({ length: totalCount }, (_, i) => ({
        angle: keywords[i % Math.max(1, keywords.length)] || `第 ${i + 1} 篇`,
        keyword: keywords[i % Math.max(1, keywords.length)] || '',
        hook: '',
      }));
    }
  }

  // 4. 逐篇成文
  let successCount = 0;
  let failedCount = 0;
  const includeImageScript = task.include_image_script !== false;

  for (let i = 0; i < totalCount; i++) {
    const topic = topics[i] || { angle: keywords[i] || `第 ${i + 1} 篇`, keyword: keywords[i] || '', hook: '' };
    const logTag = `[XhsGen][Task ${taskId}][${i + 1}/${totalCount}]`;
    let createdArticleId: number | null = null;
    try {
      const messages = buildNoteMessages({
        accountType: String(task.account_type || 'creator'),
        emojiLevel: String(task.emoji_level || 'medium'),
        targetWordCount: Number(task.xhs_target_word_count) || 700,
        requireDrawback: task.require_drawback === true,
        includeImageScript,
        titlePrompt: String(task.xhs_title_prompt || ''),
        bodyPrompt: String(task.xhs_body_prompt || ''),
        coverTextPrompt: String(task.xhs_cover_text_prompt || ''),
        topicPrompt: String(task.xhs_topic_prompt || ''),
        imageScriptPrompt: String(task.xhs_image_script_prompt || ''),
        topic: topic.angle,
        keyword: topic.keyword,
        hook: topic.hook,
        enterpriseText,
        complianceBlock,
        preferredTitle: topic.title || '',
        preferredTopics: topic.topics || [],
        platformMaxLength: XHS_CONTENT_MAX,
      });

      const resp = await chatCompletion({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        messages,
        temperature: 0.85,
        maxTokens: 8192,
        timeout: 180000,
      });

      const parsed = extractJson(resp.content);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`模型未返回可解析的 JSON：${String(resp.content || '').slice(0, 200)}`);
      }

      // 4.1 字段兜底
      let title = String(parsed.title || '').trim().replace(/^["'「]|["'」]$/g, '');
      const coverText = String(parsed.cover_text || '').trim().replace(/^["'「]|["'」]$/g, '');
      const body = String(parsed.body || '').trim();
      const rawTopics: any[] = Array.isArray(parsed.topics) && parsed.topics.length > 0
        ? parsed.topics
        : (topic.topics || []);
      const topicsOut: string[] = rawTopics
        .map((t: any) => {
          const s = String(t || '').trim();
          if (!s) return '';
          return s.startsWith('#') && s.endsWith('#') ? s : `#${s.replace(/^#+|#+$/g, '')}#`;
        }).filter(Boolean).slice(0, 10);
      const imageScript: any[] = Array.isArray(parsed.image_script) ? parsed.image_script.slice(0, 8) : [];

      if (!title) title = coverText || topic.keyword || topic.angle;
      if (title.length > 20) title = title.slice(0, 20);
      if (!body) throw new Error('模型返回的正文为空');

      const { text: safeBody, truncated } = truncateBody(body, XHS_CONTENT_MAX);
      if (truncated) console.warn(`${logTag} 正文超 ${XHS_CONTENT_MAX} 字已按句截断`);

      // 4.2 落库
      const contentHtml = bodyTextToHtml(safeBody);
      const wordCount = countText(contentHtml);
      const articleId = await createArticle({
        user_id: userId,
        task_id: taskId,
        keyword_id: null,
        core_keyword: (topic.keyword || topic.angle || title).slice(0, 128),
        keyword_type: 0,
        title,
        content_html: contentHtml,
        entity_triples: null,
        target_platform: 'xhs',
        word_count: wordCount,
        status: 'generated',
        model_used: model.model,
        cover_image_url: null,
        tags: topicsOut,
      });
      createdArticleId = articleId;

      // 4.3 取图（小红书配图不内嵌正文，只写图库引用）
      const coverImg = await pickCoverImage(task, userId);
      const illuImgs = await pickIllustrations(task, userId, coverImg?.id ?? null);
      if (coverImg?.url) {
        await updateArticleCoverImage(articleId, coverImg.url);
      }

      // 4.4 笔记元数据
      await upsertXhsNoteMeta(articleId, userId, {
        note_style: task.note_style || null,
        cover_title: coverText || title,
        cover_image_id: coverImg?.id ?? null,
        image_ids: illuImgs.map((r: any) => Number(r.id)),
        topics: topicsOut,
        xhs_customer_id: Number(task.xhs_customer_id) || null,
        // v2.12.0 P4：从写作指令的快照账号类型（蓝V官号/种草达人）落到笔记上，
        // 发布取号时据此只在同类型的账号池里取号（NULL = 不限类型，兼容历史笔记）
        xhs_account_type: ['brand', 'creator'].includes(String(task.account_type))
          ? (String(task.account_type) as 'brand' | 'creator')
          : null,
      });

      // 4.5 配图脚本（单独更新，upsert 白名单不含该字段）
      const { query } = await import('../../db');
      await query('UPDATE xhs_note_meta SET image_script = $2::jsonb, update_time = NOW() WHERE article_id = $1', [
        articleId,
        JSON.stringify(imageScript),
      ]);

      successCount++;
      await updateWritingTaskProgress(taskId, 1, 0);
      console.log(`${logTag} 完成：articleId=${articleId}, 标题=${title}, 字数=${wordCount}`);
    } catch (e: any) {
      failedCount++;
      await updateWritingTaskProgress(taskId, 0, 1);
      console.error(`${logTag} 失败:`, e?.message || e);
    }

    // 每篇完成后广播进度。
    //   wsBroadcast 是「事件名 + 数据 + targetUserId」三参数签名（与 articleGenerator.ts:1856 一致），
    //   不是 { type, data } 单对象；事件名为 writing_task_progress。
    try {
      wsBroadcast('writing_task_progress', {
        taskId,
        userId,
        completedCount: successCount,
        failedCount,
        totalCount,
        articleId: createdArticleId,
        action: 'article_completed',
      }, userId);
    } catch { /* WS 广播失败不影响主流程 */ }
  }

  const finalStatus: 'completed' | 'partial' | 'failed' =
    failedCount === 0 ? 'completed' : (successCount > 0 ? 'partial' : 'failed');
  await completeWritingTask(
    taskId,
    finalStatus,
    failedCount > 0 ? `${failedCount}/${totalCount} 篇生成失败，详见服务端日志` : undefined
  );
  console.log(`[XhsGen] 任务 ${taskId} 结束：成功 ${successCount}，失败 ${failedCount}，状态 ${finalStatus}`);
}

/** 供上层捕获真实模型错误（与 GEO 侧 extractApiErrorMessage 行为一致） */
export { extractApiErrorMessage };
