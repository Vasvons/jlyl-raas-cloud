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
 * 检测文本是否像思考过程（而非正常标题/内容）
 * 用于过滤推理模型把思考过程当成标题返回的情况
 */
function isThinkingProcess(text: string): boolean {
  if (!text || text.length < 5) return false;
  // 1. 以思考特征词开头（强信号）
  if (/^(好的|首先|让我|我需要|用户|根据|分析|思考|这是一个|我打算|我计划|我考虑|接下来|那么|现在|本次|这次)/i.test(text)) return true;
  // 2. 包含思考特征短语（强信号）
  if (/用户(的需求|希望|需要|这次|提供)|我的思考|我需要|我打算|我计划|我考虑|分析一下|思考一下|核心诉求|围绕如何|GEO优化|差异化优势|我(已经|将|会|打算)/i.test(text)) return true;
  // 3. 标题过长（正常标题 15-30 字，超过 50 字大概率是思考过程）
  if (text.length > 50) return true;
  return false;
}

/**
 * 剥离 AI 响应中的思考过程
 * 兼容：
 *   1. <think>...</think> 标签（DeepSeek-R1 等推理模型）
 *   2. <reasoning>...</reasoning> 标签
 *   3. 裸思考文本（"好的，用户..."、"首先，我..." 等开头，支持多行）
 */
function stripThinking(text: string): string {
  let result = text;
  // 1. 剥离 <think>...</think> 思考过程标签
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 2. 剥离 <reasoning>...</reasoning> 思考过程标签
  result = result.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // 3. 剥离裸思考过程（支持多行，持续到第一个 <title>/<body>/<h> 标签或结尾）
  //    特征：以"好的"、"首先"、"让我"等开头，后面跟随长文本（可能含换行）
  //    使用 [\s\S] 允许多行，用前瞻 (?=...) 在遇到 HTML 结构标签时停止
  result = result.replace(/^[\s\n]*((好的|首先|让我|我需要|用户|根据|分析|思考)[\s\S]{20,5000}?)(?=<title>|<body>|<h[1-6]|<p[^>]*>|$)/i, '');
  return result.trim();
}

/**
 * 从AI响应中提取标题和正文HTML
 *
 * 约定AI返回格式：
 *   <title>标题</title>
 *   <body>正文HTML</body>
 *
 * 兼容处理：
 *   1. 推理模型（DeepSeek-R1 等）的思考过程
 *   2. 无 <title> 标签时，从 H1/H2 提取标题
 */
function parseArticleContent(rawContent: string): { title: string; contentHtml: string; wordCount: number } {
  // 先剥离思考过程
  const content = stripThinking(rawContent);

  let title = '';
  let contentHtml = '';

  const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
    // 标题里不能有换行和 HTML 标签
    title = title.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
    // 检测 <title> 内容是否像思考过程，如果是就清空（降级用 H1 或首段）
    if (isThinkingProcess(title)) {
      console.warn('[ArticleGen] <title> 标签内容像思考过程，已清空降级。前80字符:', title.slice(0, 80));
      title = '';
    }
  }

  const bodyMatch = content.match(/<body>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    contentHtml = bodyMatch[1].trim();
  } else {
    // 没有 <body> 标签，去掉 <title> 标签后剩余作为正文
    contentHtml = content.replace(/<title>[\s\S]*?<\/title>/i, '').trim();
  }

  // 无标题时从 H1 提取
  if (!title) {
    const h1Match = contentHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      const h1Title = h1Match[1].replace(/<[^>]+>/g, '').trim();
      // H1 也可能是思考过程，检测一下
      if (!isThinkingProcess(h1Title)) {
        title = h1Title;
        contentHtml = contentHtml.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '').trim();
      }
    }
  }

  // 仍然无标题，取首段纯文本前 30 字符
  if (!title) {
    const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (firstP) {
      title = firstP[1].replace(/<[^>]+>/g, '').trim().slice(0, 30);
    }
    if (!title) {
      title = contentHtml.replace(/<[^>]+>/g, '').slice(0, 30).trim() || '未命名文章';
    }
  }

  // 标题长度保护（最长 50 字符，超过截取到第一个标点）
  if (title.length > 50) {
    const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
    title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
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

        // === 诊断日志：输出各层上下文生效情况（仅第一篇打印，避免刷屏）===
        if (i === 0) {
          console.log('[ArticleGen] 上下文诊断 === 任务', taskId, '===');
          console.log('[ArticleGen][L0专家] systemPrompt 长度:', (task.agent_system_prompt || '').length, '预览:', (task.agent_system_prompt || '').slice(0, 100));
          console.log('[ArticleGen][L0专家] skills 长度:', (task.agent_skills_content || '').length, '预览:', (task.agent_skills_content || '').slice(0, 100));
          console.log('[ArticleGen][L1客户] company_full_name:', task.company_full_name, '/ industry:', task.industry, '/ intro_text 长度:', (task.intro_text || '').length);
          console.log('[ArticleGen][L1客户] products_services 长度:', (task.products_services || '').length, '/ user_pain_points 长度:', (task.user_pain_points || '').length);
          console.log('[ArticleGen][L1客户] entity_triples 数量:', Array.isArray(task.entity_triples) ? task.entity_triples.length : 0);
          console.log('[ArticleGen][L2历史] recentArticles 数量:', recentArticles.length);
          console.log('[ArticleGen][L3效果] performanceMemory 数量:', performanceMemory.length);
          console.log('[ArticleGen][L3策略] strategyMemory 数量:', strategyMemory.length);
          console.log('[ArticleGen][L4主题] keywords 数量:', keywords.length, '前5:', keywords.slice(0, 5).map((k: any) => k.value));
          console.log('[ArticleGen][L5RAG] ragSnippets 数量:', ragSnippets.length);
          console.log('[ArticleGen][写作指令] article_prompt 长度:', (task.article_prompt || '').length, '预览:', (task.article_prompt || '').slice(0, 200));
          console.log('[ArticleGen][标题指令] title_prompt 长度:', (task.title_prompt || '').length, '预览:', (task.title_prompt || '').slice(0, 200));
          console.log('[ArticleGen][创作方向] directionCtx 长度:', directionCtx.length, '内容:', directionCtx.slice(0, 200));
          console.log('[ArticleGen][最终 systemMessage] 总长度:', writingCtx.systemMessage.length, '前300字符:', writingCtx.systemMessage.slice(0, 300));
          console.log('[ArticleGen][最终 userPrompt] 总长度:', articlePrompt.length, '前300字符:', articlePrompt.slice(0, 300));
        }

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
            // 标题生成用极简 system message，避免 L0-L5 上下文让 AI 陷入思考
            const titleMessages: { role: 'system' | 'user'; content: string }[] = [
              { role: 'system', content: '你是标题生成器。只输出标题文字本身，不要输出任何思考过程、分析、解释、引号、前缀。直接输出标题。' },
              { role: 'user', content: titlePrompt },
            ];
            const titleResult = await chatCompletion({
              baseUrl: modelConfig.base_url,
              apiKey,
              model: modelConfig.model_name,
              messages: titleMessages,
              temperature: Number(modelConfig.temperature) || 0.7,
              // 不传 maxTokens，避免推理模型思考过程占满 token 后被截断
              timeout: 30000,
            });
            // 剥离思考过程 + HTML 标签 + 引号
            title = stripThinking(titleResult.content)
              .replace(/<[^>]+>/g, '')
              .replace(/^["'"「『]+|["'"」』]+$/g, '')
              .replace(/\n+/g, ' ')
              .trim();
            // 标题长度保护
            if (title.length > 50) {
              const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
              title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
            }
            // 如果剥离思考后标题为空或仍然像思考过程，降级使用正文标题
            if (!title || title.length < 5 || isThinkingProcess(title)) {
              console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇标题生成结果异常，降级使用正文标题。原始返回前100字符:`, titleResult.content.slice(0, 100));
              title = '';
            }
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
        // 最终兜底：如果 parsed.title 也是思考过程，用关键词 + 首段纯文本生成标题
        if (!title || isThinkingProcess(title)) {
          const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const firstText = firstP ? firstP[1].replace(/<[^>]+>/g, '').trim() : '';
          if (firstText && !isThinkingProcess(firstText)) {
            title = (kw?.value ? kw.value + '：' : '') + firstText.slice(0, 25);
          } else {
            title = kw?.value || '未命名文章';
          }
          console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇正文标题也是思考过程，用关键词+首段生成标题:`, title);
        }
        // 空内容校验：AI 返回空内容时跳过保存，避免出现"空文章"
        if (!contentHtml || contentHtml.replace(/<[^>]+>/g, '').trim().length < 50) {
          throw new Error(`AI 返回内容为空或过短（${contentHtml.length} 字符），可能是内容审查触发或平台限流`);
        }
        modelUsed = modelConfig.model_name;
      }

      // 保存文章
      // 字段长度保护（避免数据库 varchar 长度限制报错）
      // article 表：title VARCHAR(255), core_keyword VARCHAR(128), target_platform VARCHAR(32), model_used VARCHAR(64)
      const safeTitle = (title || '未命名文章').slice(0, 250);
      const safeCoreKeyword = (kw?.value || '').slice(0, 120);
      const safeModelUsed = (modelUsed || '').slice(0, 60);
      const articleId = await createArticle({
        user_id: userId,
        task_id: taskId,
        keyword_id: kw?.id ?? null,
        core_keyword: safeCoreKeyword,
        keyword_type: kw?.keyword_type || 0,
        title: safeTitle,
        content_html: contentHtml,
        entity_triples: enterpriseInfo.entity_triples,
        word_count: wordCount,
        status: 'generated',
        model_used: safeModelUsed,
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
    // 不传 maxTokens，避免豆包等平台对 max_tokens 硬截断导致内容被截断成几个字符
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
    // 标题生成用极简 system message，避免 L0-L5 上下文让 AI 陷入思考
    const titleMessages: { role: 'system' | 'user'; content: string }[] = [
      { role: 'system', content: '你是标题生成器。只输出标题文字本身，不要输出任何思考过程、分析、解释、引号、前缀。直接输出标题。' },
      { role: 'user', content: titlePrompt },
    ];
    const titleResult = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: titleMessages,
      temperature: Number(modelConfig.temperature) || 0.7,
      // 不传 maxTokens，避免推理模型思考过程占满 token 后被截断
      timeout: 30000,
    });
    // 剥离思考过程 + HTML 标签 + 引号
    title = stripThinking(titleResult.content)
      .replace(/<[^>]+>/g, '')
      .replace(/^["'"「『]+|["'"」』]+$/g, '')
      .replace(/\n+/g, ' ')
      .trim();
    // 标题长度保护
    if (title.length > 50) {
      const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
      title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
    }
    // 如果剥离思考后标题为空或仍然像思考过程，降级使用正文标题
    if (!title || title.length < 5 || isThinkingProcess(title)) {
      console.warn(`[ArticleGen] 文章 ${articleId} 重新生成标题异常，降级使用正文标题。原始返回前100字符:`, titleResult.content.slice(0, 100));
      title = '';
    }
  }

  const { title: parsedTitle, contentHtml, wordCount } = parseArticleContent(articleResult.content);
  if (!title) title = parsedTitle;
  // 最终兜底：如果 parsedTitle 也是思考过程，用关键词 + 首段纯文本生成标题
  if (!title || isThinkingProcess(title)) {
    const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const firstText = firstP ? firstP[1].replace(/<[^>]+>/g, '').trim() : '';
    if (firstText && !isThinkingProcess(firstText)) {
      title = (article.core_keyword ? article.core_keyword + '：' : '') + firstText.slice(0, 25);
    } else {
      title = article.core_keyword || '未命名文章';
    }
    console.warn(`[ArticleGen] 文章 ${articleId} 正文标题也是思考过程，用关键词+首段生成标题:`, title);
  }

  const { updateArticle } = await import('../../repository');
  await updateArticle(articleId, {
    title,
    content_html: contentHtml,
    word_count: wordCount,
    model_used: modelConfig.model_name,
    status: 'generated',
  });
}
