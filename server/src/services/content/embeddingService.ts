/**
 * Embedding 服务
 *
 * 负责生成和存储文章的向量表示，用于 RAG 检索。
 *
 * 工作流：
 *   1. 从 ai_model_config 表查找 use_for_embedding=true 的模型
 *   2. 调用模型的 embedding 接口生成向量
 *   3. 存入 article_embedding 表
 *
 * 降级策略：
 *   - 如果没有配置 use_for_embedding=true 的模型，跳过 embedding 生成
 *   - 如果 embedding 接口调用失败，记录日志但不阻塞文章生成
 */

import { embeddings } from './aiClient';
import { getEmbeddingModelConfig, saveArticleEmbedding, searchArticleEmbeddings } from '../../repository';
import { decrypt } from '../../utils/crypto';
import { stripHtml } from './contextBuilder';

/**
 * 获取 embedding 模型的完整配置（含解密后的 apiKey 和正确的 endpoint）
 */
async function resolveEmbeddingConfig(): Promise<{ baseUrl: string; apiKey: string; model: string } | null> {
  const config = await getEmbeddingModelConfig();
  if (!config) return null;

  let apiKey = '';
  if (config.api_key_encrypted) {
    try {
      apiKey = decrypt(config.api_key_encrypted);
    } catch {
      console.error('[Embedding] API-KEY 解密失败');
      return null;
    }
  }
  if (!apiKey) return null;

  // 从 chat completions 的 base_url 推导 embeddings 的 endpoint
  // 各平台的 chat completions URL → embeddings URL 映射
  const chatUrl = (config.base_url || '').replace(/\/chat\/completions\/?$/, '');
  let embeddingUrl: string;
  if (chatUrl.includes('bigmodel.cn')) {
    // 智谱：embedding-3 模型
    embeddingUrl = 'https://open.bigmodel.cn/api/paas/v4/embeddings';
  } else if (chatUrl.includes('dashscope.aliyuncs.com')) {
    // 通义：text-embedding-v3
    embeddingUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  } else if (chatUrl.includes('openai.com')) {
    // OpenAI：text-embedding-3-small
    embeddingUrl = 'https://api.openai.com/v1/embeddings';
  } else {
    // 通用 OpenAI 兼容：替换路径
    embeddingUrl = chatUrl.replace(/\/v1\/?$/, '') + '/v1/embeddings';
  }

  // 模型名：优先用配置的 model_name，否则按平台选默认 embedding 模型
  let model = config.model_name || '';
  if (chatUrl.includes('bigmodel.cn') && !model.includes('embedding')) {
    model = 'embedding-3';
  } else if (chatUrl.includes('dashscope.aliyuncs.com') && !model.includes('embedding')) {
    model = 'text-embedding-v3';
  } else if (chatUrl.includes('openai.com') && !model.includes('embedding')) {
    model = 'text-embedding-3-small';
  }

  return { baseUrl: embeddingUrl, apiKey, model };
}

/**
 * 为文章生成 embedding 并存储
 * 文章生成成功后异步调用，失败不阻塞主流程
 *
 * @param articleId 文章 ID
 * @param knowledgeId 知识库 ID（用于按客户隔离检索）
 * @param title 文章标题
 * @param contentHtml 文章正文 HTML
 */
export async function generateAndSaveEmbedding(
  articleId: number,
  knowledgeId: number | null,
  title: string,
  contentHtml: string
): Promise<boolean> {
  try {
    const config = await resolveEmbeddingConfig();
    if (!config) {
      console.log('[Embedding] 未配置 embedding 模型，跳过向量生成');
      return false;
    }

    // 构建用于 embedding 的文本：标题 + 前500字纯文本摘要
    const summary = stripHtml(contentHtml, 500);
    const contentText = `${title}\n\n${summary}`.slice(0, 2000);

    const result = await embeddings({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      input: contentText,
      timeout: 30000,
    });

    await saveArticleEmbedding(articleId, knowledgeId, contentText, result.embedding, config.model);
    console.log(`[Embedding] 文章 ${articleId} 向量生成成功（维度=${result.embedding.length}）`);
    return true;
  } catch (err: any) {
    console.error(`[Embedding] 文章 ${articleId} 向量生成失败:`, err?.message || err);
    return false;
  }
}

/**
 * 生成查询文本的 embedding（用于 RAG 检索）
 */
export async function generateQueryEmbedding(queryText: string): Promise<{ embedding: number[]; model: string } | null> {
  try {
    const config = await resolveEmbeddingConfig();
    if (!config) return null;

    const result = await embeddings({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      input: queryText.slice(0, 2000),
      timeout: 30000,
    });

    return { embedding: result.embedding, model: config.model };
  } catch (err: any) {
    console.error('[Embedding] 查询向量生成失败:', err?.message || err);
    return null;
  }
}
