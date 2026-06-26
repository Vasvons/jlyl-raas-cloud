import { chatCompletion } from './aiClient';
import { buildPrompt } from './promptBuilder';
import {
  getWritingTaskById,
  getKeywordsByIds,
  getArticleById,
  createArticle,
  updateWritingTaskProgress,
  completeWritingTask,
  incrementModelUsedCount,
} from '../../repository';
import { decrypt } from '../../utils/crypto';

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
      // 无标题标签时，取前30个字符作为标题
      title = contentHtml.replace(/<[^>]+>/g, '').slice(0, 30).trim() || '未命名文章';
    }
  }

  // 计算字数（去除HTML标签）
  const wordCount = contentHtml.replace(/<[^>]+>/g, '').length;

  return { title, contentHtml, wordCount };
}

/**
 * 执行写作任务 — 遍历关键词调AI生成文章
 * 此函数在路由层调用，会长时间运行（可能几分钟到几十分钟）
 */
export async function executeWritingTask(taskId: number, userId: number): Promise<void> {
  const task = await getWritingTaskById(taskId);
  if (!task) {
    throw new Error(`Writing task ${taskId} not found`);
  }

  // 获取关键词详情
  const keywordIds: number[] = task.keyword_ids || [];
  const keywords = await getKeywordsByIds(keywordIds);
  if (keywords.length === 0) {
    await completeWritingTask(taskId, 'failed', '未找到选中的关键词');
    return;
  }

  // 获取模型配置（含解密API-KEY）
  let apiKey = '';
  let modelConfig: any = null;
  if (task.model_config_id) {
    const { getAiModelConfigById } = await import('../../repository');
    modelConfig = await getAiModelConfigById(task.model_config_id);
    if (modelConfig?.api_key_encrypted) {
      try {
        apiKey = decrypt(modelConfig.api_key_encrypted);
      } catch {
        await completeWritingTask(taskId, 'failed', 'API-KEY解密失败');
        return;
      }
    }
  }

  if (!modelConfig || !apiKey) {
    await completeWritingTask(taskId, 'failed', '未配置有效的AI模型或API-KEY');
    return;
  }

  // 企业知识库信息
  const enterpriseInfo = {
    company_full_name: task.company_full_name || '',
    company_short_name: task.company_short_name,
    city: task.city,
    industry: task.industry,
    business_scope: task.business_scope,
    intro_text: task.intro_text,
    cases_text: task.cases_text,
    entity_triples: task.entity_triples || [],
  };

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const kw of keywords) {
    try {
      // 组装 prompt
      const systemPrompt = buildPrompt(task.system_prompt, {
        keyword: kw.value,
        enterprise: enterpriseInfo,
        wordCount: task.target_word_count,
      });
      const userPrompt = buildPrompt(task.user_prompt_template, {
        keyword: kw.value,
        enterprise: enterpriseInfo,
        wordCount: task.target_word_count,
      });

      // 调AI
      const result = await chatCompletion({
        baseUrl: modelConfig.base_url,
        apiKey,
        model: modelConfig.model_name,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: Number(modelConfig.temperature) || 0.7,
        maxTokens: modelConfig.max_tokens || 4096,
        timeout: 120000,
      });

      // 解析响应
      const { title, contentHtml, wordCount } = parseArticleContent(result.content);

      // 保存文章
      await createArticle({
        user_id: userId,
        task_id: taskId,
        keyword_id: kw.id,
        core_keyword: kw.value,
        keyword_type: kw.keyword_type || 0,
        title,
        content_html: contentHtml,
        entity_triples: enterpriseInfo.entity_triples,
        word_count: wordCount,
        status: 'generated',
        model_used: modelConfig.model_name,
      });

      successCount++;
      await updateWritingTaskProgress(taskId, 1, 0);
      await incrementModelUsedCount(modelConfig.id);
    } catch (err: any) {
      failCount++;
      errors.push(`关键词"${kw.value}"生成失败：${err.message}`);
      await updateWritingTaskProgress(taskId, 0, 1);
    }
  }

  // 完成任务
  const status = failCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');
  await completeWritingTask(taskId, status as any, errors.length > 0 ? errors.join('\n') : undefined);
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

  // 获取模型配置
  const { getAiModelConfigById } = await import('../../repository');
  let apiKey = '';
  let modelConfig: any = null;
  if (task.model_config_id) {
    modelConfig = await getAiModelConfigById(task.model_config_id);
    if (modelConfig?.api_key_encrypted) {
      apiKey = decrypt(modelConfig.api_key_encrypted);
    }
  }
  if (!modelConfig || !apiKey) {
    throw new Error('未配置有效的AI模型或API-KEY');
  }

  const enterpriseInfo = {
    company_full_name: task.company_full_name || '',
    company_short_name: task.company_short_name,
    city: task.city,
    industry: task.industry,
    business_scope: task.business_scope,
    intro_text: task.intro_text,
    cases_text: task.cases_text,
    entity_triples: task.entity_triples || [],
  };

  const systemPrompt = buildPrompt(task.system_prompt, {
    keyword: article.core_keyword,
    enterprise: enterpriseInfo,
    wordCount: task.target_word_count,
  });
  const userPrompt = buildPrompt(task.user_prompt_template, {
    keyword: article.core_keyword,
    enterprise: enterpriseInfo,
    wordCount: task.target_word_count,
  });

  const result = await chatCompletion({
    baseUrl: modelConfig.base_url,
    apiKey,
    model: modelConfig.model_name,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: Number(modelConfig.temperature) || 0.7,
    maxTokens: modelConfig.max_tokens || 4096,
    timeout: 120000,
  });

  const { title, contentHtml, wordCount } = parseArticleContent(result.content);

  const { updateArticle } = await import('../../repository');
  await updateArticle(articleId, {
    title,
    content_html: contentHtml,
    word_count: wordCount,
    model_used: modelConfig.model_name,
    status: 'generated',
  });
}
