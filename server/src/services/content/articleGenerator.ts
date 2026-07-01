import { chatCompletion } from './aiClient';
import { buildPrompt, buildDirectionContext, pickRandomContentType, pickRandomDirection } from './promptBuilder';
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
 * 从 agent_profile 构建系统消息（system message）
 * 把专家角色的 systemPrompt + 启用的技能内容拼成 system message
 * 用于注入到 chatCompletion 调用，让大模型"成为"这个专家
 *
 * @param task 已联表查询 agent_profile 的任务对象（含 agent_system_prompt, agent_skills_content）
 * @returns system message 字符串，若角色未配置则返回空字符串
 */
function buildSystemMessageFromAgentProfile(task: any): string {
  const systemPrompt: string = task.agent_system_prompt || '';
  const skillsContent: string = task.agent_skills_content || '';

  const parts: string[] = [];
  if (systemPrompt.trim()) {
    parts.push(systemPrompt.trim());
  }
  if (skillsContent.trim()) {
    parts.push(skillsContent.trim());
  }
  return parts.join('\n\n');
}

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
  }

  // 企业知识库信息
  const enterpriseInfo = buildEnterpriseInfo(task);

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  // v1.4+：按用户设定的 total_count 循环生成，不再按关键词一对一
  // 关键词列表作为整体主题参考注入到每篇文章的 prompt 中
  // AI 根据 指令 + 知识库 + 专家 + 关键词列表 自行决定每篇文章的主题
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
        // 组装 prompt（方向×类型上下文注入 article_prompt 开头）
        // v1.4+：keyword 参数传整个关键词列表作为主题参考
        const directionCtx = buildDirectionContextForTask(task);
        const articlePrompt = buildPrompt(directionCtx + (task.article_prompt || ''), {
          keyword: keywordsListStr || '',
          enterprise: enterpriseInfo,
          wordCount: task.target_word_count,
        });

        // 构建系统消息：若任务绑定了专家智能体(agent_profile)，注入其 systemPrompt + 技能内容
        const systemContent = buildSystemMessageFromAgentProfile(task);
        const messages: { role: 'system' | 'user'; content: string }[] = systemContent
          ? [
              { role: 'system', content: systemContent },
              { role: 'user', content: articlePrompt },
            ]
          : [{ role: 'user', content: articlePrompt }];

        // 调AI生成文章正文（不限制 max_tokens，让大模型用默认值输出完整内容）
        const articleResult = await chatCompletion({
          baseUrl: modelConfig.base_url,
          apiKey,
          model: modelConfig.model_name,
          messages,
          temperature: Number(modelConfig.temperature) || 0.7,
          timeout: 120000,
          webSearch: !!modelConfig.web_search,
        });

        // 如果指令配置了 title_prompt，单独调用AI生成标题
        if (task.title_prompt && task.title_prompt.trim()) {
          const titlePrompt = buildPrompt(directionCtx + task.title_prompt, {
            keyword: keywordsListStr || '',
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

        const parsed = parseArticleContent(articleResult.content);
        contentHtml = parsed.contentHtml;
        wordCount = parsed.wordCount;
        // 如果没有单独的 title_prompt，则从文章内容中解析标题
        if (!title) {
          title = parsed.title;
        }
        modelUsed = modelConfig.model_name;
      }

      // 保存文章
      await createArticle({
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

      successCount++;
      await updateWritingTaskProgress(taskId, 1, 0);
      if (modelConfig?.id) {
        await incrementModelUsedCount(modelConfig.id);
      }
    } catch (err: any) {
      failCount++;
      errors.push(`第 ${i + 1} 篇生成失败：${err.message}`);
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

  const articlePrompt = buildPrompt(directionCtx + (task.article_prompt || ''), {
    keyword: article.core_keyword,
    enterprise: enterpriseInfo,
    wordCount: task.target_word_count,
  });

  // 构建系统消息：若任务绑定了专家智能体，注入其 systemPrompt + 技能内容
  const systemContent = buildSystemMessageFromAgentProfile(task);
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
