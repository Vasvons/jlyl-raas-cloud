import { chatCompletion, extractApiErrorMessage } from './aiClient';
import { buildPrompt, buildDirectionContext, pickRandomContentType, pickRandomDirection, formatEnterprise } from './promptBuilder';
import { buildWritingContext, stripHtml, type RecentArticleItem, type PerformanceMemoryItem, type StrategyMemoryItem, type RagSnippet } from './contextBuilder';
import { retrieveRelevantArticles } from './ragRetrieval';
import { generateAndSaveEmbedding } from './embeddingService';
import {
  getWritingTaskById,
  getKeywordsByIds,
  getArticleById,
  createArticle,
  updateWritingTaskProgress,
  completeWritingTask,
  incrementModelUsedCount,
  getDefaultModelConfig,
  getAiModelConfigById,
  getRecentArticlesByKnowledge,
  getPerformanceMemory,
  getStrategyMemory,
} from '../../repository';
import { decrypt } from '../../utils/crypto';

/**
 * 解析指令的 category（创作方向）字段
 * 升级后 category 可能是数组(多选方向)、单字符串(旧数据)或 null
 */
function parseDirections(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

/**
 * 解析指令的 content_types 字段
 * 数据库 JSONB 类型可能返回数组或字符串
 */
function parseContentTypes(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * 构建创作方向×文案类型上下文（注入 prompt 开头）
 * - random_mode=true：每次随机选1种方向×1种类型
 * - random_mode=false：用所有配置的方向 + 第1种类型
 */
function buildDirectionContextForTask(task: any): string {
  const directions = parseDirections(task.instruction_category);
  const contentTypes = parseContentTypes(task.content_types);
  const isRandom = !!task.random_mode;

  let selectedDirection: string[] = [];
  let selectedType = '';

  if (isRandom) {
    const dir = pickRandomDirection(directions);
    selectedDirection = dir ? [dir] : [];
    selectedType = pickRandomContentType(contentTypes);
  } else {
    selectedDirection = directions;
    selectedType = contentTypes[0] || '';
  }

  return buildDirectionContext(selectedDirection, selectedType);
}

/**
 * 从AI响应中提取标题和正文HTML
 * 约定AI返回格式：
 *   <title>标题</title>
 *   <body>正文HTML</body>
 * 如果没有标签则整段作为正文，标题用前30字符
 */
function parseArticleContent(rawContent: string): { title: string; contentHtml: string; wordCount: number } {
  let title = '';
  let contentHtml = '';

  const titleMatch = rawContent.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  const bodyMatch = rawContent.match(/<body>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    contentHtml = bodyMatch[1].trim();
  } else {
    contentHtml = rawContent.trim();
    if (!title) {
      title = contentHtml.replace(/<[^>]+>/g, '').slice(0, 30).trim() || '未命名文章';
    }
  }

  const wordCount = contentHtml.replace(/<[^>]+>/g, '').length;

  return { title, contentHtml, wordCount };
}

/**
 * 组装企业知识库信息对象（含 v1.2 新增 5 个自由文本字段）
 */
function buildEnterpriseInfo(task: any) {
  return {
    company_full_name: task.company_full_name || '',
    company_short_name: task.company_short_name,
    city: task.city,
    industry: task.industry,
    business_scope: task.business_scope,
    intro_text: task.intro_text,
    cases_text: task.cases_text,
    entity_triples: task.entity_triples || [],
    products_services: task.products_services,
    product_features: task.product_features,
    user_pain_points: task.user_pain_points,
    trust_endorsement: task.trust_endorsement,
    other_info: task.other_info,
  };
}

/**
 * v1.4+ 重构：以下两个函数已迁移到 contextBuilder.ts 的 buildWritingContext()
 * - buildSystemMessageFromAgentProfile → L0 专家人格层 + L1 客户档案层
 * - buildWritingContextBlock → L4 主题参考层（userPromptSuffix）
 *
 * contextBuilder 新增了 L2 历史记忆、L3 效果/策略记忆、L5 RAG 检索层
 */

/**
 * 解析模型配置并解密 API-KEY
 * 优先使用 task.model_config_id（向后兼容），否则取用户默认模型
 */
async function resolveModelConfig(task: any, userId: number, taskId: number): Promise<{ modelConfig: any; apiKey: string } | null> {
  let modelConfig: any = null;
  let apiKey = '';

  // 优先用任务指定的 model_config_id（向后兼容旧任务）
  if (task.model_config_id) {
    modelConfig = await getAiModelConfigById(task.model_config_id);
  } else {
    // 新逻辑：自动取用户默认模型
    modelConfig = await getDefaultModelConfig(userId);
  }

  if (!modelConfig) {
    await completeWritingTask(taskId, 'failed', '未配置有效的AI模型，请到「后台配置 > 生文模型配置」中添加');
    return null;
  }

  if (modelConfig.api_key_encrypted) {
    try {
      apiKey = decrypt(modelConfig.api_key_encrypted);
    } catch {
      await completeWritingTask(taskId, 'failed', 'API-KEY解密失败，请重新配置模型');
      return null;
    }
  }

  if (!apiKey) {
    await completeWritingTask(taskId, 'failed', 'API-KEY为空，请到「后台配置 > 生文模型配置」中配置');
    return null;
  }

  return { modelConfig, apiKey };
}

/**
 * 执行写作任务 — 按用户设定的篇数循环调AI生成文章
 * v1.4+：关键词库作为整体主题参考注入 prompt，不再一对一
 * 支持双模式：expert（专家系统）/ coze（扣子工作流）
 */
export async function executeWritingTask(taskId: number, userId: number): Promise<void> {
  // 整个函数主体包在 try-catch 中，任何异常都标记任务失败，避免卡在 'processing'
  try {
    await executeWritingTaskInner(taskId, userId);
  } catch (err: any) {
    console.error(`[ArticleGen] 任务 ${taskId} 执行异常:`, err);
    try {
      await completeWritingTask(taskId, 'failed', `任务执行异常：${err?.message || err}`);
    } catch (e) {
      // completeWritingTask 自身失败时只能记录日志
      console.error(`[ArticleGen] 任务 ${taskId} 标记失败状态时出错:`, e);
    }
  }
}

async function executeWritingTaskInner(taskId: number, userId: number): Promise<void> {
  const task = await getWritingTaskById(taskId);
  if (!task) {
    throw new Error(`Writing task ${taskId} not found`);
  }

  // 获取关键词详情（v1.4+：关键词库作为主题参考，可为空）
  const keywordIds: number[] = task.keyword_ids || [];
  const keywords = await getKeywordsByIds(keywordIds);
  // 关键词列表字符串（顿号连接），注入到 prompt 中作为主题参考
  const keywordsListStr = keywords.map((k: any) => k.value).join('、');

  // 文章篇数：由用户在创建任务时手动设定（task.total_count）
  const totalCount: number = Math.max(1, Number(task.total_count) || 1);

  // 生成模式：expert（默认）/ coze
  const generationMode = task.generation_mode || 'expert';

  // 专家系统模式：需要模型配置
  let modelConfig: any = null;
  let apiKey = '';
  if (generationMode === 'expert') {
    const resolved = await resolveModelConfig(task, userId, taskId);
    if (!resolved) return;
    modelConfig = resolved.modelConfig;
    apiKey = resolved.apiKey;
    // 校验 base_url 非空（避免 axios "invalid URL" 错误）
    if (!modelConfig.base_url) {
      await completeWritingTask(taskId, 'failed', '模型配置的 base_url 为空，请到「后台配置 > 生文模型配置」中填写');
      return;
    }
  }

  // 企业知识库信息
  const enterpriseInfo = buildEnterpriseInfo(task);

  // v1.4+：构建分层写作上下文（运行时聚合层）
  // L2 历史记忆：查询该客户最近 20 篇已生成文章，避免重复选题
  let recentArticles: RecentArticleItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawArticles = await getRecentArticlesByKnowledge(task.knowledge_id, 20);
      recentArticles = rawArticles.map(a => ({
        title: a.title,
        summary: stripHtml((a as any).contentHtml || '', 200),
        createdAt: a.createdAt,
        coreKeyword: a.coreKeyword || undefined,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L2 历史记忆失败:', err);
    }
  }

  // L3 效果记忆：收录好的文章模式
  let performanceMemory: PerformanceMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawPerf = await getPerformanceMemory(task.knowledge_id, 10);
      performanceMemory = rawPerf.map((p: any) => ({
        articleTitle: p.article_title,
        performanceLabel: p.performance_label,
        keywordRankChange: p.keyword_rank_change,
        aeoScore: p.aeo_score ? parseFloat(p.aeo_score) : undefined,
        direction: p.direction,
        contentType: p.content_type,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L3 效果记忆失败:', err);
    }
  }

  // L3 策略记忆：飞轮总结的创作策略
  let strategyMemory: StrategyMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawStrategy = await getStrategyMemory(task.knowledge_id, 3);
      strategyMemory = rawStrategy.map((s: any) => ({
        strategy: s.strategy,
        evidence: s.evidence || '',
        generatedAt: s.generated_at,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L3 策略记忆失败:', err);
    }
  }

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  // v1.4+：按用户设定的 total_count 循环生成，不再按关键词一对一
  // 关键词列表作为整体主题参考注入到每篇文章的 prompt 中
  // AI 根据 指令 + 知识库 + 专家 + 关键词列表 + 历史记忆 + RAG 自行决定每篇文章的主题
  for (let i = 0; i < totalCount; i++) {
    try {
      let title = '';
      let contentHtml = '';
      let wordCount = 0;
      let modelUsed = '';

      // 为本次生成选择一个主题关键词（轮询取，用于文章归属标记，不影响 prompt 内容）
      const kw = keywords.length > 0 ? keywords[i % keywords.length] : null;

      if (generationMode === 'coze') {
        // 扣子工作流模式
        const result = await generateByCoze(task, keywordsListStr || '', enterpriseInfo, userId);
        title = result.title;
        contentHtml = result.contentHtml;
        wordCount = result.wordCount;
        modelUsed = 'coze';
      } else {
        // 专家系统模式
        const directionCtx = buildDirectionContextForTask(task);

        // L5 RAG 检索：用当前选题关键词 + 创作方向检索相关历史文章
        let ragSnippets: RagSnippet[] = [];
        if (task.knowledge_id) {
          const queryText = `${kw?.value || keywordsListStr} ${directionCtx}`;
          ragSnippets = await retrieveRelevantArticles(task.knowledge_id, queryText, 5);
        }

        // 构建分层写作上下文（L0专家 + L1客户档案 + L2历史 + L3效果/策略 + L5 RAG）
        const writingCtx = buildWritingContext({
          task,
          keywords: keywords.map((k: any) => k.value),
          recentArticles,
          performanceMemory,
          strategyMemory,
          ragSnippets,
        });

        // 1. 先做占位符替换（向后兼容用户在模板里写的 {enterprise} {keyword} 等）
        let articlePrompt = buildPrompt(directionCtx + (task.article_prompt || ''), {
          keyword: keywordsListStr || '',
          enterprise: enterpriseInfo,
          wordCount: task.target_word_count,
        });
        // 2. 附加 L4 主题参考层（userPromptSuffix）
        articlePrompt += writingCtx.userPromptSuffix;

        // 3. 组装 messages（systemMessage 含 L0+L1+L2+L3+L5）
        const messages: { role: 'system' | 'user'; content: string }[] = writingCtx.systemMessage
          ? [
              { role: 'system', content: writingCtx.systemMessage },
              { role: 'user', content: articlePrompt },
            ]
          : [{ role: 'user', content: articlePrompt }];

        // 调AI生成文章正文
        // 注意：不传 maxTokens，让平台用默认值（豆包等平台对 max_tokens 有硬截断行为，
        // 传 4096 会导致 finish_reason=length 被截断成几个字符）
        const articleResult = await chatCompletion({
          baseUrl: modelConfig.base_url,
          apiKey,
          model: modelConfig.model_name,
          messages,
          temperature: Number(modelConfig.temperature) || 0.7,
          timeout: 120000,
          webSearch: !!modelConfig.web_search,
        });

        // 如果指令配置了 title_prompt，单独调用AI生成标题（失败时降级使用正文解析的标题）
        if (task.title_prompt && task.title_prompt.trim()) {
          try {
            let titlePrompt = buildPrompt(directionCtx + task.title_prompt, {
              keyword: keywordsListStr || '',
              enterprise: enterpriseInfo,
              wordCount: task.target_word_count,
            });
            titlePrompt += writingCtx.userPromptSuffix;
            const titleMessages: { role: 'system' | 'user'; content: string }[] = writingCtx.systemMessage
              ? [
                  { role: 'system', content: writingCtx.systemMessage },
                  { role: 'user', content: titlePrompt },
                ]
              : [{ role: 'user', content: titlePrompt }];
            const titleResult = await chatCompletion({
              baseUrl: modelConfig.base_url,
              apiKey,
              model: modelConfig.model_name,
              messages: titleMessages,
              temperature: Number(modelConfig.temperature) || 0.7,
              maxTokens: 200,
              timeout: 30000,
            });
            title = titleResult.content.replace(/<[^>]+>/g, '').trim();
          } catch (titleErr) {
            console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇标题生成失败，降级使用正文标题:`, extractApiErrorMessage(titleErr));
          }
        }

        const parsed = parseArticleContent(articleResult.content);
        contentHtml = parsed.contentHtml;
        wordCount = parsed.wordCount;
        if (!title) {
          title = parsed.title;
        }
        // 空内容校验：AI 返回空内容时跳过保存，避免出现"空文章"
        if (!contentHtml || contentHtml.replace(/<[^>]+>/g, '').trim().length < 50) {
          throw new Error(`AI 返回内容为空或过短（${contentHtml.length} 字符），可能是内容审查触发或平台限流`);
        }
        modelUsed = modelConfig.model_name;
      }

      // 保存文章
      const articleId = await createArticle({
        user_id: userId,
        task_id: taskId,
        keyword_id: kw?.id ?? null,
        core_keyword: kw?.value || '',
        keyword_type: kw?.keyword_type || 0,
        title,
        content_html: contentHtml,
        entity_triples: enterpriseInfo.entity_triples,
        word_count: wordCount,
        status: 'generated',
        model_used: modelUsed,
      });

      // 异步生成 embedding（不阻塞主流程，失败不影响文章生成）
      generateAndSaveEmbedding(articleId, task.knowledge_id || null, title, contentHtml).catch(err => {
        console.warn(`[ArticleGen] 文章 ${articleId} embedding 生成失败:`, err?.message);
      });

      successCount++;
      await updateWritingTaskProgress(taskId, 1, 0);
      // 模型使用次数统计失败不阻塞文章生成
      if (modelConfig?.id) {
        await incrementModelUsedCount(modelConfig.id).catch(e => {
          console.warn(`[ArticleGen] 模型使用次数统计失败:`, e?.message);
        });
      }
    } catch (err: any) {
      failCount++;
      // 用 extractApiErrorMessage 提取各平台兼容的错误信息，避免只看到 axios 通用消息
      const errMsg = extractApiErrorMessage(err) || err?.message || String(err);
      errors.push(`第 ${i + 1} 篇生成失败：${errMsg}`);
      console.error(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇生成失败:`, errMsg);
      await updateWritingTaskProgress(taskId, 0, 1);
    }
  }

  const status = failCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');
  await completeWritingTask(taskId, status as any, errors.length > 0 ? errors.join('\n') : undefined);
}

/**
 * 扣子工作流生成文章（框架，待实现）
 * TODO: 实现 coze API 调用 https://api.coze.cn/v1/workflow/run
 */
async function generateByCoze(
  task: any,
  keyword: string,
  enterprise: any,
  userId: number,
): Promise<{ title: string; contentHtml: string; wordCount: number }> {
  // 动态导入避免未使用时加载
  const { getCloudApiConfig } = await import('../../repository');
  const config = await getCloudApiConfig(userId);
  if (!config || !config.coze_key || !config.coze_baowen_workflow_id) {
    throw new Error('扣子工作流未配置，请到「后台配置 > 云接口配置」中填写 coze_key 和 coze_baowen_workflow_id');
  }

  // TODO: 实现扣子工作流 API 调用
  // const response = await axios.post('https://api.coze.cn/v1/workflow/run', {
  //   workflow_id: config.coze_baowen_workflow_id,
  //   parameters: { keyword, enterprise: JSON.stringify(enterprise), ... },
  // }, { headers: { 'Authorization': `Bearer ${config.coze_key}` } });

  throw new Error('扣子工作流模式暂未实现，请使用专家系统模式');
}

/**
 * 重新生成单篇文章
 */
export async function regenerateArticle(articleId: number, userId: number): Promise<void> {
  const article = await getArticleById(articleId);
  if (!article || !article.task_id) {
    throw new Error('Article not found or has no associated task');
  }

  const task = await getWritingTaskById(article.task_id);
  if (!task) {
    throw new Error('Associated writing task not found');
  }

  const generationMode = task.generation_mode || 'expert';

  if (generationMode === 'coze') {
    const enterpriseInfo = buildEnterpriseInfo(task);
    const result = await generateByCoze(task, article.core_keyword, enterpriseInfo, userId);
    const { updateArticle } = await import('../../repository');
    await updateArticle(articleId, {
      title: result.title,
      content_html: result.contentHtml,
      word_count: result.wordCount,
      model_used: 'coze',
      status: 'generated',
    });
    return;
  }

  // 专家系统模式
  const resolved = await resolveModelConfig(task, userId, 0);
  if (!resolved) throw new Error('未配置有效的AI模型或API-KEY');
  const { modelConfig, apiKey } = resolved;

  const enterpriseInfo = buildEnterpriseInfo(task);
  const directionCtx = buildDirectionContextForTask(task);

  // v1.4+：使用 contextBuilder 构建分层上下文
  let recentArticles: RecentArticleItem[] = [];
  let performanceMemory: PerformanceMemoryItem[] = [];
  let strategyMemory: StrategyMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawArticles = await getRecentArticlesByKnowledge(task.knowledge_id, 20);
      recentArticles = rawArticles.map(a => ({
        title: a.title,
        summary: stripHtml((a as any).contentHtml || '', 200),
        createdAt: a.createdAt,
        coreKeyword: a.coreKeyword || undefined,
      }));
    } catch { /* 降级 */ }
    try { performanceMemory = (await getPerformanceMemory(task.knowledge_id, 10)).map((p: any) => ({ articleTitle: p.article_title, performanceLabel: p.performance_label, direction: p.direction, contentType: p.content_type })); } catch { /* 降级 */ }
    try { strategyMemory = (await getStrategyMemory(task.knowledge_id, 3)).map((s: any) => ({ strategy: s.strategy, evidence: s.evidence || '', generatedAt: s.generated_at })); } catch { /* 降级 */ }
  }

  // L5 RAG 检索
  let ragSnippets: RagSnippet[] = [];
  if (task.knowledge_id) {
    ragSnippets = await retrieveRelevantArticles(task.knowledge_id, `${article.core_keyword} ${directionCtx}`, 5);
  }

  const writingCtx = buildWritingContext({
    task,
    keywords: article.core_keyword ? [article.core_keyword] : [],
    recentArticles,
    performanceMemory,
    strategyMemory,
    ragSnippets,
  });

  let articlePrompt = buildPrompt(directionCtx + (task.article_prompt || ''), {
    keyword: article.core_keyword,
    enterprise: enterpriseInfo,
    wordCount: task.target_word_count,
  });
  articlePrompt += writingCtx.userPromptSuffix;

  const systemContent = writingCtx.systemMessage;
  const messages: { role: 'system' | 'user'; content: string }[] = systemContent
    ? [
        { role: 'system', content: systemContent },
        { role: 'user', content: articlePrompt },
      ]
    : [{ role: 'user', content: articlePrompt }];

  const articleResult = await chatCompletion({
    baseUrl: modelConfig.base_url,
    apiKey,
    model: modelConfig.model_name,
    messages,
    temperature: Number(modelConfig.temperature) || 0.7,
    maxTokens: modelConfig.max_tokens || 4096,
    timeout: 120000,
    webSearch: !!modelConfig.web_search,
  });

  let title = '';
  if (task.title_prompt && task.title_prompt.trim()) {
    const titlePrompt = buildPrompt(directionCtx + task.title_prompt, {
      keyword: article.core_keyword,
      enterprise: enterpriseInfo,
      wordCount: task.target_word_count,
    });
    const titleMessages: { role: 'system' | 'user'; content: string }[] = systemContent
      ? [
          { role: 'system', content: systemContent },
          { role: 'user', content: titlePrompt },
        ]
      : [{ role: 'user', content: titlePrompt }];
    const titleResult = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: titleMessages,
      temperature: Number(modelConfig.temperature) || 0.7,
      maxTokens: 200,
      timeout: 30000,
    });
    title = titleResult.content.replace(/<[^>]+>/g, '').trim();
  }

  const { title: parsedTitle, contentHtml, wordCount } = parseArticleContent(articleResult.content);
  if (!title) title = parsedTitle;

  const { updateArticle } = await import('../../repository');
  await updateArticle(articleId, {
    title,
    content_html: contentHtml,
    word_count: wordCount,
    model_used: modelConfig.model_name,
    status: 'generated',
  });
}
