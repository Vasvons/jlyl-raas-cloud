/**
 * RAG 检索服务
 *
 * 写作时用向量检索该客户的历史文章和知识库片段，找到与当前选题最相关的内容，
 * 注入到写作上下文的 L5 层。
 *
 * 工作流：
 *   1. 用当前选题关键词 + 创作方向构建 query
 *   2. 调用 embeddingService 生成 query 向量
 *   3. 用 pgvector 的余弦距离检索 top-K 相关文章
 *   4. 返回 RagSnippet[] 供 contextBuilder 注入
 *
 * 降级策略：
 *   - 没有 embedding 模型配置 → 返回空数组（不影响写作，只是没有 L5 层）
 *   - 向量检索失败 → 返回空数组
 */

import { generateQueryEmbedding } from './embeddingService';
import { searchArticleEmbeddings } from '../../repository';
import type { RagSnippet } from './contextBuilder';

/**
 * RAG 检索：按当前选题检索相关历史文章片段
 *
 * @param knowledgeId 客户知识库 ID（按客户隔离检索）
 * @param queryText 查询文本（通常是关键词 + 创作方向）
 * @param topK 返回条数，默认 5
 * @returns RagSnippet 数组，可能为空
 */
export async function retrieveRelevantArticles(
  knowledgeId: number,
  queryText: string,
  topK: number = 5
): Promise<RagSnippet[]> {
  try {
    // 1. 生成查询向量
    const queryResult = await generateQueryEmbedding(queryText);
    if (!queryResult) {
      // 没有 embedding 模型配置，降级跳过
      return [];
    }

    // 2. 向量检索
    const results = await searchArticleEmbeddings(knowledgeId, queryResult.embedding, topK);

    // 3. 转换为 RagSnippet
    return results.map(r => ({
      source: 'article' as const,
      title: r.title,
      content: r.contentText.slice(0, 300),  // 每个片段最多 300 字
      score: r.score,
      articleId: r.articleId,
    }));
  } catch (err: any) {
    console.error('[RAG] 检索失败:', err?.message || err);
    return [];
  }
}
