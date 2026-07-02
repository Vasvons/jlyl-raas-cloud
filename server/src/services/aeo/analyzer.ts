/**
 * AEO 分析器：调用大模型对品牌提及记录进行分析，生成日报和轮次报告
 * - 日报：每个任务每天生成一次（保留原有功能）
 * - 轮次报告：每轮100%完成后生成，基于完整关键词库的分析结果
 */
import axios from 'axios';
import {
  getBrandMentionRecordsForAeo,
  insertAeoReport,
  checkAeoReportExists,
  getBrandKeywords,
  getRoundRecordsForAeo,
  insertAeoFullReport,
  getDistillateKeywords,
  getArticlesByUserAndTimeRange,
  upsertArticlePerformance,
  insertWritingStrategy,
  getArticlePerformanceStatsByKnowledge,
} from '../../repository';

const LLM_API_URL = process.env.LLM_API_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const AEO_RECORD_LIMIT = parseInt(process.env.AEO_RECORD_LIMIT || '200');

if (!LLM_API_URL || !LLM_API_KEY) {
  console.warn('[AEO] LLM_API_URL 或 LLM_API_KEY 未配置，AEO 分析将使用 fallback 纯代码模式');
}

/**
 * 为指定任务生成 AEO 日报
 */
export async function generateAeoReport(taskId: number, userId: string): Promise<number | null> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // 检查今日是否已生成
  const exists = await checkAeoReportExists(taskId, today);
  if (exists) {
    console.log(`[AEO] 任务 ${taskId} 今日已生成报告，跳过`);
    return null;
  }

  // 获取今日品牌提及记录
  const records = await getBrandMentionRecordsForAeo(taskId, AEO_RECORD_LIMIT);
  if (records.length === 0) {
    console.log(`[AEO] 任务 ${taskId} 今日无品牌提及记录，跳过`);
    return null;
  }

  // 获取品牌词
  const brandKeywords = await getBrandKeywords(userId);

  // 准备分析数据
  const analysisInput = records.map(r => ({
    platform: r.platform,
    keyword: r.keyword,
    content: (r.raw_content || '').substring(0, 500),
    matchedBrands: r.matched_brands,
    shareUrl: r.share_url,
  }));

  // 调用 LLM 分析
  const analysis = await callLlmForAeo(analysisInput, brandKeywords);

  // 入库
  const reportId = await insertAeoReport({
    taskId,
    userId,
    reportDate: today,
    visibilityScore: analysis.visibilityScore,
    mentionCount: records.length,
    positiveRatio: analysis.positiveRatio,
    neutralRatio: analysis.neutralRatio,
    negativeRatio: analysis.negativeRatio,
    competitorAnalysis: analysis.competitorAnalysis,
    suggestions: analysis.suggestions,
    rawAnalysis: analysis.raw,
    recordIds: records.map(r => r.id),
  });

  console.log(`[AEO] 任务 ${taskId} 日报生成成功 reportId=${reportId} mentions=${records.length}`);
  return reportId;
}

/**
 * 调用大模型进行 AEO 分析
 */
async function callLlmForAeo(
  records: any[],
  brandKeywords: string[]
): Promise<{
  visibilityScore: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
}> {
  // 如果未配置 LLM，使用纯代码简单分析
  if (!LLM_API_URL || !LLM_API_KEY) {
    return fallbackAnalysis(records, brandKeywords);
  }

  const prompt = `你是一位 AEO（Answer Engine Optimization）分析专家。请分析以下 AI 平台品牌提及数据，生成一份日报。

品牌关键词：${brandKeywords.join('、')}

提及记录（共${records.length}条）：
${JSON.stringify(records, null, 2)}

请返回 JSON 格式（不要 markdown 代码块）：
{
  "visibilityScore": 0-100的整数,  // 品牌可见度评分
  "positiveRatio": 0-100的数字,    // 正面情感占比
  "neutralRatio": 0-100的数字,     // 中性情感占比
  "negativeRatio": 0-100的数字,    // 负面情感占比
  "competitorAnalysis": "竞品分析文本", // 是否有竞品被提及
  "suggestions": "优化建议文本"     // 3-5条 GEO 优化建议
}`;

  try {
    const resp = await axios.post(
      LLM_API_URL,
      {
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: '你是 AEO 分析专家，只返回 JSON 格式数据。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      {
        headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      }
    );

    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
    // 尝试解析 JSON（去除可能的 markdown 代码块标记）
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      visibilityScore: Math.min(100, Math.max(0, parseInt(parsed.visibilityScore) || 0)),
      positiveRatio: Math.min(100, Math.max(0, parseFloat(parsed.positiveRatio) || 0)),
      neutralRatio: Math.min(100, Math.max(0, parseFloat(parsed.neutralRatio) || 0)),
      negativeRatio: Math.min(100, Math.max(0, parseFloat(parsed.negativeRatio) || 0)),
      competitorAnalysis: String(parsed.competitorAnalysis || ''),
      suggestions: String(parsed.suggestions || ''),
      raw: content,
    };
  } catch (e: any) {
    console.error('[AEO] LLM 调用失败，使用 fallback 分析:', e.message);
    return fallbackAnalysis(records, brandKeywords);
  }
}

/**
 * 无 LLM 时的简单分析（纯代码）
 */
function fallbackAnalysis(
  records: any[],
  brandKeywords: string[]
): {
  visibilityScore: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
} {
  const platformCount = new Set(records.map(r => r.platform)).size;
  const visibilityScore = Math.min(100, records.length * 5 + platformCount * 10);

  // 简单情感判断：包含正面词计为正面，包含负面词计为负面
  const positiveWords = ['好', '优秀', '推荐', '不错', '方便', '好用', '满意', '专业'];
  const negativeWords = ['差', '不好', '问题', '缺点', '不满', '失望', '垃圾', '骗'];

  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const r of records) {
    const text = (r.content || '').toLowerCase();
    let posScore = 0;
    let negScore = 0;
    for (const w of positiveWords) {
      if (text.includes(w.toLowerCase())) posScore++;
    }
    for (const w of negativeWords) {
      if (text.includes(w.toLowerCase())) negScore++;
    }
    if (posScore > negScore) positive++;
    else if (negScore > posScore) negative++;
    else neutral++;
  }

  const total = records.length || 1;
  const competitorAnalysis = `共在 ${platformCount} 个平台获得 ${records.length} 次品牌提及。`;
  const suggestions = `1. 继续保持当前 GEO 内容输出频率\n2. 关注提及量较少的平台，增加针对性内容\n3. 定期监控品牌情感变化趋势`;

  return {
    visibilityScore,
    positiveRatio: Math.round((positive / total) * 100),
    neutralRatio: Math.round((neutral / total) * 100),
    negativeRatio: Math.round((negative / total) * 100),
    competitorAnalysis,
    suggestions,
    raw: JSON.stringify({ fallback: true, records: records.length }),
  };
}

/**
 * 生成 AEO 轮次报告（基于完整关键词库的分析）
 * 每轮100%完成后触发，分析本轮所有品牌命中记录
 */
export async function generateAeoFullReport(
  taskId: number,
  userId: string,
  roundNo: number,
  roundStartTime: Date,
  roundEndTime: Date
): Promise<number | null> {
  try {
    // 获取本轮所有品牌命中记录
    const records = await getRoundRecordsForAeo(taskId, roundStartTime);
    if (records.length === 0) {
      console.log(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮无品牌命中记录，跳过轮次报告`);
      return null;
    }

    // 获取品牌词和蒸馏词（用于分析上下文）
    const brandKeywords = await getBrandKeywords(userId);
    let totalKeywords = 0;
    try {
      const distillateKeywords = await getDistillateKeywords(userId);
      totalKeywords = distillateKeywords.length;
    } catch {}

    // 准备分析数据
    const analysisInput = records.map(r => ({
      platform: r.platform,
      keyword: r.keyword,
      content: (r.raw_content || '').substring(0, 500),
      matchedBrands: r.matched_brands,
      shareUrl: r.share_url,
    }));

    // 调用 LLM 分析（复用现有函数）
    const analysis = await callLlmForAeo(analysisInput, brandKeywords);

    // 统计本轮总记录数和品牌命中数
    const brandMatchedCount = records.length;

    // 入库
    const reportId = await insertAeoFullReport({
      taskId,
      userId,
      roundNo,
      totalKeywords,
      totalRecords: brandMatchedCount,
      brandMatchedCount,
      visibilityScore: analysis.visibilityScore,
      mentionCount: brandMatchedCount,
      positiveRatio: analysis.positiveRatio,
      neutralRatio: analysis.neutralRatio,
      negativeRatio: analysis.negativeRatio,
      competitorAnalysis: analysis.competitorAnalysis,
      suggestions: analysis.suggestions,
      rawAnalysis: analysis.raw,
      recordIds: records.map(r => r.id),
      roundStartTime,
      roundEndTime,
    });

    console.log(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮报告生成成功 reportId=${reportId} mentions=${brandMatchedCount} keywords=${totalKeywords}`);

    // ===== 阶段3.2：填充 article_performance 效果数据 =====
    // 将本轮 AEO 分析结果回写到本轮时间窗口内生成的文章效果表
    // L3 效果记忆层的数据来源，供下一轮写作上下文使用
    try {
      await fillArticlePerformanceFromAeo(
        userId, roundStartTime, roundEndTime, reportId,
        analysis.visibilityScore, records
      );
    } catch (e: any) {
      console.warn(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮填充文章效果失败:`, e.message);
    }

    // ===== 阶段3.3：飞轮策略生成 =====
    // 基于本轮文章效果统计，用 LLM 生成创作策略，注入下一轮写作上下文
    try {
      await generateWritingStrategyFromRound(userId, roundNo, roundStartTime, roundEndTime);
    } catch (e: any) {
      console.warn(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮策略生成失败:`, e.message);
    }

    return reportId;
  } catch (e: any) {
    console.error(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮报告生成失败:`, e.message);
    return null;
  }
}

/**
 * 阶段3.2：将 AEO 分析结果回填到 article_performance 表
 * - 查询本轮时间窗口内该用户生成的所有文章
 * - 检查每篇文章的 core_keyword 是否在本轮品牌命中记录中出现
 * - 根据可见度评分和品牌命中情况标记 good/poor/neutral
 */
async function fillArticlePerformanceFromAeo(
  userId: string,
  roundStartTime: Date,
  roundEndTime: Date,
  aeoReportId: number,
  visibilityScore: number,
  roundRecords: any[]
): Promise<void> {
  const articles = await getArticlesByUserAndTimeRange(userId, roundStartTime, roundEndTime);
  if (articles.length === 0) {
    console.log(`[AEO] 用户 ${userId} 本轮无已生成文章，跳过效果回填`);
    return;
  }

  // 本轮品牌命中的关键词集合
  const brandMatchedKeywords = new Set(
    roundRecords
      .filter(r => r.matched_brands && r.matched_brands.length > 0)
      .map(r => r.keyword)
  );

  let filled = 0;
  for (const article of articles) {
    const brandMentioned = article.coreKeyword
      ? brandMatchedKeywords.has(article.coreKeyword)
      : false;

    // 效果标记：品牌被提及=good，可见度>=60=neutral，否则=poor
    let label = 'neutral';
    if (brandMentioned) {
      label = 'good';
    } else if (visibilityScore < 60) {
      label = 'poor';
    }

    await upsertArticlePerformance(article.id, article.knowledgeId, {
      aeoReportId,
      aeoScore: visibilityScore,
      brandMentioned,
      performanceLabel: label,
      direction: article.direction || undefined,
      contentType: article.contentType || undefined,
    });
    filled++;
  }
  console.log(`[AEO] 文章效果回填完成: ${filled}/${articles.length} 篇，品牌命中关键词 ${brandMatchedKeywords.size} 个`);
}

/**
 * 阶段3.3：飞轮策略生成
 * 基于本轮文章效果统计，用 LLM 总结创作策略，写入 writing_strategy 表
 * 策略将在下一轮写作时作为 L3 策略记忆注入到 system message
 */
async function generateWritingStrategyFromRound(
  userId: string,
  roundNo: number,
  roundStartTime: Date,
  roundEndTime: Date
): Promise<void> {
  // 收集用户所有 knowledge_id 的效果统计
  const articles = await getArticlesByUserAndTimeRange(userId, roundStartTime, roundEndTime);
  if (articles.length === 0) return;

  // 按 knowledge_id 分组
  const knowledgeGroups = new Map<number, typeof articles>();
  for (const a of articles) {
    if (a.knowledgeId == null) continue;
    if (!knowledgeGroups.has(a.knowledgeId)) {
      knowledgeGroups.set(a.knowledgeId, [] as typeof articles);
    }
    knowledgeGroups.get(a.knowledgeId)!.push(a);
  }

  for (const [knowledgeId, _articles] of knowledgeGroups) {
    try {
      const stats = await getArticlePerformanceStatsByKnowledge(knowledgeId, roundStartTime, roundEndTime);
      if (stats.total === 0) continue;

      // 用 LLM 生成策略（无 LLM 配置时用规则兜底）
      const strategyText = await callLlmForStrategy(stats, roundNo);
      if (!strategyText) continue;

      await insertWritingStrategy(
        knowledgeId,
        strategyText,
        JSON.stringify({
          total: stats.total,
          goodCount: stats.goodCount,
          poorCount: stats.poorCount,
          goodExamples: stats.goodExamples.map(g => g.title),
        }),
        roundNo,
        stats.goodCount,
        stats.poorCount
      );
      console.log(`[AEO] 飞轮策略已生成: knowledgeId=${knowledgeId} round=${roundNo} good=${stats.goodCount} poor=${stats.poorCount}`);
    } catch (e: any) {
      console.warn(`[AEO] knowledgeId=${knowledgeId} 策略生成失败:`, e.message);
    }
  }
}

/**
 * 调用 LLM 生成创作策略（飞轮反馈）
 * 输入本轮文章效果统计，输出 2-3 条可执行的创作建议
 */
async function callLlmForStrategy(
  stats: { total: number; goodCount: number; poorCount: number; neutralCount: number; goodExamples: any[] },
  roundNo: number
): Promise<string> {
  // 无 LLM 配置时用规则生成
  if (!LLM_API_URL || !LLM_API_KEY) {
    return fallbackStrategy(stats);
  }

  const prompt = `你是内容营销策略专家。请基于以下本轮（第 ${roundNo} 轮）文章效果数据，生成 2-3 条可执行的自媒体创作策略建议。

本轮数据：
- 文章总数: ${stats.total}
- 效果好(品牌被提及): ${stats.goodCount}
- 效果差(可见度低): ${stats.poorCount}
- 效果中性: ${stats.neutralCount}
- 效果好的文章标题示例: ${stats.goodExamples.map(g => g.title).join(' | ') || '无'}

请直接输出策略文本（不要 JSON、不要 markdown 代码块），每条策略一行，聚焦于「下一轮写作应该调整什么」。例如：多用某类标题、聚焦某方向、避免某类选题等。`;

  try {
    const resp = await axios.post(
      LLM_API_URL,
      {
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: '你是内容营销策略专家，输出简洁可执行的建议。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
      },
      {
        headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
    return content.trim() || fallbackStrategy(stats);
  } catch (e: any) {
    console.warn('[AEO] 策略 LLM 调用失败，使用规则兜底:', e.message);
    return fallbackStrategy(stats);
  }
}

/**
 * 无 LLM 时的规则兜底策略
 */
function fallbackStrategy(stats: { total: number; goodCount: number; poorCount: number; goodExamples: any[] }): string {
  const lines: string[] = [];
  if (stats.goodCount > 0) {
    lines.push(`本轮有 ${stats.goodCount} 篇文章获得品牌提及，继续保持当前创作方向，参考表现好的标题模式。`);
  } else {
    lines.push(`本轮无文章获得品牌提及，下一轮尝试调整标题风格，强化品牌词在标题中的出现。`);
  }
  if (stats.poorCount > stats.total * 0.5) {
    lines.push(`超过半数文章效果偏弱（可见度低于60），下一轮聚焦核心关键词，减少泛主题内容。`);
  }
  if (stats.goodExamples.length > 0) {
    lines.push(`表现好的方向：${stats.goodExamples.map(g => g.direction || '未分类').join('、')}，下一轮优先选用。`);
  }
  return lines.join('\n') || '保持当前创作节奏，持续监控品牌可见度变化。';
}
