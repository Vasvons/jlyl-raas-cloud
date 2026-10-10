/**
 * 小红书图文写作系统 — 生成内核
 *
 * 流程：任务+指令+知识库 → 选题 → 逐篇成文（结构化 JSON）→ 落 article + xhs_note_meta → 取图 → 进度广播
 *
 * 解耦约束：不 import promptBuilder.ts / articleGenerator.ts；
 * 只依赖 aiClient（调模型）、repository（数据）、wsServer（进度广播）。
 */
import { chatCompletion, extractApiErrorMessage } from '../content/aiClient';
import type { ChatMessage } from '../content/aiClient';
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
import { checkXhsNoteStyle } from './xhsStyleCheck';
import { resolveNoteImages, normalizeImageStrategy } from './xhsImageStrategy';

/** 小红书平台正文硬上限（与 platform_content_rule.platform='xhs'.content_max_length 一致） */
const XHS_CONTENT_MAX = 1000;

/** 解析写作模型配置（不依赖 GEO 的 resolveModelConfig） */
export async function resolveXhsModel(task: any, userId: number): Promise<{ baseUrl: string; apiKey: string; model: string }> {
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

/** 纯文本正文 → <p> 段落 HTML（不信任模型输出的 HTML；笔记编辑器改正文复用此转换） */
export function bodyTextToHtml(body: string): string {
  return String(body || '')
    .split(/\n\s*\n/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => `<p>${seg.replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

/** 剥离标签后的纯文本字数（笔记编辑器改正文后重算字数复用） */
export function countText(text: string): number {
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
  // v2.14.0 配图策略（生成时选定，逐篇执行）
  const imageStrategy = normalizeImageStrategy(task.image_strategy);
  const instruction = task.xhs_instruction_id ? task : null;
  if (!instruction) {
    await completeWritingTask(taskId, 'failed', '小红书写作任务缺少写作指令（xhs_instruction_id 为空）');
    return;
  }

  const model = await resolveXhsModel(task, userId);
  const enterpriseText = formatEnterpriseForXhs(task);
  // v2.13.10 种草核质检用：品牌名（短名优先，全称兜底；知识库未填品牌时跳过该检测）
  const brandNames = [
    String(task.company_short_name || '').trim(),
    String(task.company_full_name || '').trim(),
  ].filter(Boolean);

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
      // v2.13.11：正文形态随选题透传（两步向导的旧数据没有该字段，为空时模型按题材自选）
      form: String(t?.form || '').trim(),
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
        // v2.13.11：正文形态（叙述型 / 半干货型）随选题透传
        bodyForm: topic.form || '',
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

      // v2.13.8 正文质检（清单腔/长句/说教句/AI 腔/品牌存在感）：命中时带具体问题重写一次（只重试一次，失败保留原版）
      let finalBody = body;
      const styleIssues = checkXhsNoteStyle(finalBody, { brandNames });
      if (styleIssues.length > 0) {
        console.warn(`${logTag} 正文质检未通过（${styleIssues.length} 项），带问题重写一次: ${styleIssues.join('；')}`);
        try {
          const retryMessages: ChatMessage[] = [
            ...messages,
            { role: 'assistant', content: resp.content },
            {
              role: 'user',
              content: `【上一版正文未通过质检，请重写并输出完整 JSON】
需要修复的问题：
${styleIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}
重写要求：① 正文要像"我的经历分享"，不能像给读者的注意事项清单——把知识点和建议包进"我遇到了什么、当时怎么做的"里；② 保住种草核：至少 2 个产品价值的具体证据（用后的状态 / 材质做工体感 / 服务细节）、品牌出现 ≥2 次且至少一次说清"好在哪"、结尾给一句明确的推荐判断；③ 句子拆短；标题/话题等其他字段保持原样；只输出 JSON，不要解释。`,
            },
          ];
          const retryResp = await chatCompletion({
            baseUrl: model.baseUrl,
            apiKey: model.apiKey,
            model: model.model,
            messages: retryMessages,
            temperature: 0.7,
            maxTokens: 8192,
            timeout: 180000,
          });
          const retryBody = String(extractJson(retryResp.content)?.body || '').trim();
          if (retryBody && checkXhsNoteStyle(retryBody, { brandNames }).length < styleIssues.length) {
            finalBody = retryBody;
            console.log(`${logTag} 质检重写通过（${styleIssues.length} → ${checkXhsNoteStyle(retryBody, { brandNames }).length} 项）`);
          } else {
            console.warn(`${logTag} 质检重写未通过，保留原版`);
          }
        } catch (e: any) {
          console.warn(`${logTag} 质检重写失败（保留原版）:`, e?.message);
        }
      }

      const { text: safeBody, truncated } = truncateBody(finalBody, XHS_CONTENT_MAX);
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

      // 4.3 取图（v2.14.0 按任务配图策略执行：图库 / 图库+AI / AI / 正文转图 / 搜图候选）
      const picked = await resolveNoteImages({
        strategy: imageStrategy,
        task,
        userId,
        imageScript,
        title,
        coverText,
        topicAngle: topic.angle || '',
        keyword: topic.keyword || '',
      });
      const coverImg = picked.cover;
      const illuImgs = picked.illustrations;
      if (coverImg?.url) {
        await updateArticleCoverImage(articleId, coverImg.url);
      }

      // 4.4 笔记元数据
      await upsertXhsNoteMeta(articleId, userId, {
        note_style: task.note_style || null,
        cover_title: coverText || title,
        cover_image_id: coverImg?.id ?? null,
        image_ids: illuImgs.map((r) => Number(r.id)),
        topics: topicsOut,
        // v2.13.5 双内容形态：随任务落库（'note' 笔记 / 'card' 图文），列表按形态分栏
        content_form: task.content_form === 'card' ? 'card' : 'note',
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
