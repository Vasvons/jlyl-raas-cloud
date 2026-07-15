/**
 * AEO 分析器：调用大模型对品牌提及记录进行分析，生成日报和轮次报告
 * - 日报：每个任务每天生成一次（保留原有功能）
 * - 轮次报告：每轮100%完成后生成，基于完整关键词库的分析结果
 * - 分片报告（v2.0.0）：每个分片查询完成后生成，只存储不触发写作，等待周/月报汇总
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
  // v2.0.0 分片级 AEO
  getQueueInfoForShardReport,
  getRecordsByTimeWindow,
  getAllRecordsByTimeWindow,
  insertAeoShardReport,
  checkShardReportExists,
  // v2.0.0 时间维度报告（周/月报）
  getShardReportsByTimeRange,
  getInclusionStatsByTimeRange,
  checkPeriodReportExists,
  insertAeoPeriodReport,
  updatePeriodReportArticleCount,
  getAeoQuotaConfig,
  calcSourcePlatformWeights,
  allocateArticlesByWeight,
  createWritingTask,
  getDefaultModelConfig,
  getAeoModelConfig,
  getEnterpriseKnowledges,
  getAllWritingInstructions,
} from '../../repository';
import { query as dbQuery } from '../../db';
import { decrypt } from '../../utils/crypto';

const AEO_RECORD_LIMIT = parseInt(process.env.AEO_RECORD_LIMIT || '200');

/**
 * 为指定任务生成 AEO 日报
 */
export async function generateAeoReport(taskId: number, userId: string): Promise<number | null> {
  // v2.1.5：使用 Asia/Shanghai 时区的今日日期（原 UTC 导致北京时间 0-8 点日期错位）
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD

  // 检查今日是否已生成
  const exists = await checkAeoReportExists(taskId, today);
  if (exists) {
    console.log(`[AEO] 任务 ${taskId} 今日已生成报告，跳过`);
    return null;
  }

  // 获取今日品牌提及记录
  const records = await getBrandMentionRecordsForAeo(taskId, AEO_RECORD_LIMIT);

  // v2.1.5：今日无品牌命中记录时，生成"今日无数据"报告（而非 return null 静默跳过）
  // 这样飞轮页面"立即触发分析"后能看到报告生成，趋势卡片会更新
  if (records.length === 0) {
    console.log(`[AEO] 任务 ${taskId} 今日无品牌提及记录，生成无数据报告`);
    const reportId = await insertAeoReport({
      taskId,
      userId,
      reportDate: today,
      visibilityScore: 0,
      mentionCount: 0,
      positiveRatio: 0,
      neutralRatio: 0,
      negativeRatio: 0,
      competitorAnalysis: '今日无品牌提及记录',
      suggestions: '今日巡检尚未命中任何品牌关键词，暂无数据分析结论。请检查巡检任务是否正常运行，或品牌关键词是否配置正确。',
      rawAnalysis: JSON.stringify({ reason: 'no_brand_mention_records_today', task_id: taskId }),
      recordIds: [],
    });
    console.log(`[AEO] 任务 ${taskId} 无数据日报生成成功 reportId=${reportId}`);
    return reportId;
  }

  // 获取品牌词
  const brandKeywords = await getBrandKeywords(userId);

  // 准备分析数据
  // v2.0.5：截取前 3000 字（原 500 字太少，品牌描述+情感分析需要完整内容）
  const analysisInput = records.map(r => ({
    platform: r.platform,
    keyword: r.keyword,
    content: (r.raw_content || '').substring(0, 3000),
    matchedBrands: r.matched_brands,
    shareUrl: r.share_url,
  }));

  // 调用 LLM 分析
  const analysis = await callLlmForAeo(analysisInput, brandKeywords, userId);

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
 * v2.0.5：不再读环境变量 LLM_API_URL/LLM_API_KEY/LLM_MODEL
 *         改为读 ai_model_config 表（use_for_aeo=true 的配置）
 *         未配置时降级用 fallbackAnalysis 纯代码分析
 */
async function callLlmForAeo(
  records: any[],
  brandKeywords: string[],
  userId: string
): Promise<{
  visibilityScore: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
}> {
  // 从 ai_model_config 表读取 AEO 专用模型
  const modelConfig = await getAeoModelConfig(userId);
  if (!modelConfig || !modelConfig.api_key_encrypted) {
    console.warn(`[AEO] 用户 ${userId} 未配置 AEO 模型（use_for_aeo=true），使用 fallback 纯代码分析`);
    return fallbackAnalysis(records, brandKeywords);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO] API-KEY 解密失败 platform=${modelConfig.platform}:`, e.message);
    return fallbackAnalysis(records, brandKeywords);
  }

  const apiUrl = modelConfig.base_url;
  const model = modelConfig.model_name;
  console.log(`[AEO] 使用模型: platform=${modelConfig.platform} model=${model}`);

  const prompt = `你是一位 AEO（Answer Engine Optimization）数据分析师。请分析以下 AI 平台品牌提及数据，生成一份客观数据日报。

注意：你只负责客观数据分析和结论，不负责给出写作或优化建议。写作建议由周报/月报统一生成。

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
  "suggestions": "数据分析结论"     // 3-5条客观数据分析结论，如"今日可见度下降5%，主要因为XX平台收录减少"，不要给出任何写作或优化建议
}`;

  try {
    const resp = await axios.post(
      apiUrl,
      {
        model,
        messages: [
          { role: 'system', content: '你是 AEO 分析专家，只返回 JSON 格式数据。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
    console.error(`[AEO] LLM 调用失败 platform=${modelConfig.platform} model=${model}，使用 fallback 分析:`, e.message);
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
  // v2.1.5: 日报只输出客观数据分析结论，不输出写作或优化建议（写作建议由周/月报统一生成）
  const suggestions = `1. 今日品牌可见度评分 ${visibilityScore}，共获得 ${records.length} 次提及\n2. 正面情感占比 ${Math.round((positive / total) * 100)}%，负面情感占比 ${Math.round((negative / total) * 100)}%\n3. 品牌在 ${platformCount} 个平台被提及`;

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
    // v2.0.5：截取前 3000 字（原 500 字太少，品牌描述+情感分析需要完整内容）
    const analysisInput = records.map(r => ({
      platform: r.platform,
      keyword: r.keyword,
      content: (r.raw_content || '').substring(0, 3000),
      matchedBrands: r.matched_brands,
      shareUrl: r.share_url,
    }));

    // 调用 LLM 分析（复用现有函数）
    const analysis = await callLlmForAeo(analysisInput, brandKeywords, userId);

    // 统计本轮总记录数和品牌命中数
    const brandMatchedCount = records.length;

    // v2.0.0 P5：计算收录率汇总（按平台分布）
    const inclusionRateSummary = buildInclusionRateSummary(records, totalKeywords);

    // v2.0.0 P5：生成策略建议（基于本轮数据 + 飞轮反馈）
    const strategySuggestions = buildStrategySuggestions(analysis, records, totalKeywords, roundNo);

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
      inclusionRateSummary,
      strategySuggestions,
    });

    console.log(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮报告生成成功 reportId=${reportId} mentions=${brandMatchedCount} keywords=${totalKeywords}`);

    // ===== 阶段3.2：填充 article_performance 效果数据 =====
    try {
      await fillArticlePerformanceFromAeo(
        userId, roundStartTime, roundEndTime, reportId,
        analysis.visibilityScore, records
      );
    } catch (e: any) {
      console.warn(`[AEO] 任务 ${taskId} 第 ${roundNo} 轮填充文章效果失败:`, e.message);
    }

    // ===== 阶段3.3：飞轮策略生成 =====
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
 * P5：构建收录率汇总（按平台分布 + 整体收录率）
 */
function buildInclusionRateSummary(records: any[], totalKeywords: number): any {
  // 按平台分组统计
  const platformStats: Record<string, { total: number; brands: Set<string>; keywords: Set<string> }> = {};
  for (const r of records) {
    const platform = r.platform || 'unknown';
    if (!platformStats[platform]) {
      platformStats[platform] = { total: 0, brands: new Set(), keywords: new Set() };
    }
    platformStats[platform].total++;
    if (Array.isArray(r.matched_brands)) {
      r.matched_brands.forEach((b: string) => platformStats[platform].brands.add(b));
    }
    if (r.keyword) platformStats[platform].keywords.add(r.keyword);
  }

  const platformBreakdown = Object.entries(platformStats).map(([platform, stats]) => ({
    platform,
    record_count: stats.total,
    brand_count: stats.brands.size,
    keyword_count: stats.keywords.size,
  }));

  const totalRecords = records.length;
  const allBrands = new Set<string>();
  const allKeywords = new Set<string>();
  for (const r of records) {
    if (Array.isArray(r.matched_brands)) {
      r.matched_brands.forEach((b: string) => allBrands.add(b));
    }
    if (r.keyword) allKeywords.add(r.keyword);
  }

  return {
    total_records: totalRecords,
    total_brands_mentioned: allBrands.size,
    total_keywords_covered: allKeywords.size,
    total_keywords_in_library: totalKeywords,
    keyword_coverage_rate: totalKeywords > 0 ? Math.round((allKeywords.size / totalKeywords) * 10000) / 100 : 0,
    platform_breakdown: platformBreakdown,
    best_platform: platformBreakdown.sort((a, b) => b.record_count - a.record_count)[0]?.platform || null,
    worst_platform: platformBreakdown.sort((a, b) => a.record_count - b.record_count)[0]?.platform || null,
  };
}

/**
 * P5：构建策略建议（基于分析结果 + 数据统计）
 */
function buildStrategySuggestions(analysis: any, records: any[], totalKeywords: number, roundNo: number): any {
  const suggestions: string[] = [];

  // 基于可见度
  if (analysis.visibilityScore < 40) {
    suggestions.push(`可见度评分 ${analysis.visibilityScore} 偏低，下一轮需增加内容投放量，聚焦核心品牌词。`);
  } else if (analysis.visibilityScore >= 70) {
    suggestions.push(`可见度评分 ${analysis.visibilityScore} 良好，保持当前内容输出频率和方向。`);
  }

  // 基于负面情感
  if (analysis.negativeRatio > 20) {
    suggestions.push(`负面情感占比 ${analysis.negativeRatio}%，需加强正面品牌内容投放，对冲负面舆情。`);
  }

  // 基于平台覆盖
  const platforms = new Set(records.map(r => r.platform));
  if (platforms.size < 3) {
    suggestions.push(`仅覆盖 ${platforms.size} 个平台，建议扩展到更多 AI 平台以提升品牌可见度。`);
  }

  // 基于关键词覆盖
  const coveredKeywords = new Set(records.map(r => r.keyword));
  if (totalKeywords > 0 && coveredKeywords.size < totalKeywords * 0.3) {
    suggestions.push(`关键词覆盖率仅 ${Math.round((coveredKeywords.size / totalKeywords) * 100)}%，下一轮应扩展长尾关键词内容。`);
  }

  // 基于轮次
  if (roundNo > 1) {
    suggestions.push(`已完成 ${roundNo} 轮查询，建议复盘历史数据，调整内容策略中表现不佳的方向。`);
  }

  return {
    round_no: roundNo,
    visibility_score: analysis.visibilityScore,
    suggestions,
    next_round_focus: analysis.negativeRatio > 20 ? '正面舆情对冲' : '品牌词覆盖扩展',
    content_volume_adjustment: analysis.visibilityScore < 40 ? 'increase' : analysis.visibilityScore >= 70 ? 'maintain' : 'slight_increase',
  };
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
      const strategyText = await callLlmForStrategy(stats, roundNo, userId);
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
  roundNo: number,
  userId: string
): Promise<string> {
  // v2.0.5：从 ai_model_config 表读取 AEO 专用模型（use_for_aeo=true）
  const modelConfig = await getAeoModelConfig(userId);
  if (!modelConfig || !modelConfig.api_key_encrypted) {
    return fallbackStrategy(stats);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO] 策略 LLM API-KEY 解密失败 platform=${modelConfig.platform}:`, e.message);
    return fallbackStrategy(stats);
  }

  const apiUrl = modelConfig.base_url;
  const model = modelConfig.model_name;

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
      apiUrl,
      {
        model,
        messages: [
          { role: 'system', content: '你是内容营销策略专家，输出简洁可执行的建议。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

// ============ v2.0.0: 分片级 AEO 分析 ============

/**
 * 生成分片级 AEO 报告（v2.0.0）
 *
 * 每个分片查询完成后触发，分析该分片内品牌命中记录的 AI 情感倾向。
 * 分析结果只入库 aeo_shard_report，不触发写作任务。
 * 等待周/月报汇总后统一驱动写作。
 *
 * @param queueId 分片队列 ID
 * @returns 报告 ID（失败返回 null）
 */
export async function generateAeoShardReport(queueId: number): Promise<number | null> {
  try {
    // 1. 检查是否已生成过报告（避免重复分析）
    const exists = await checkShardReportExists(queueId);
    if (exists) {
      console.log(`[AEO-Shard] 分片 ${queueId} 已有报告，跳过`);
      return null;
    }

    // 2. 获取分片队列信息
    const queueInfo = await getQueueInfoForShardReport(queueId);
    if (!queueInfo) {
      console.log(`[AEO-Shard] 分片 ${queueId} 队列信息不存在`);
      return null;
    }

    // 仅对成功完成的分片进行分析（品牌命中判断交给第 5 道门 getRecordsByTimeWindow）
    // v2.1.5：删除原 result_brand_count===0 检查——worker 端写死 brandMatched=false 导致该字段恒为 0，
    //         所有分片都在此处被错误跳过。真实品牌命中以 real_collect_record 表 brand_matched=true 为准。
    if (queueInfo.status !== 'done') {
      console.log(`[AEO-Shard] 分片 ${queueId} 状态非 done（${queueInfo.status}），跳过`);
      return null;
    }

    // 3. 确定分片时间窗口
    const startTime = queueInfo.start_time ? new Date(queueInfo.start_time) : new Date(Date.now() - 30 * 60 * 1000);
    const endTime = queueInfo.end_time ? new Date(queueInfo.end_time) : new Date();

    // 4. 按时间窗口查询品牌命中记录
    const brandMatchedRecords = await getRecordsByTimeWindow(queueInfo.task_id, startTime, endTime);

    // 5. 获取品牌词
    const userId = queueInfo.user_id || '';
    const brandKeywords = await getBrandKeywords(userId);

    // v2.1.5：无品牌命中时也生成报告（如实展现收录为 0 的情况）
    // 没有命中记录正说明品牌需要做 GEO 优化，报告应如实展现当前 AI 提及率为 0%
    const hasBrandMatch = brandMatchedRecords.length > 0;

    // 查询该时间窗口内所有记录（不限 brand_matched），用于统计总查询量
    const allRecords = hasBrandMatch
      ? brandMatchedRecords
      : await getAllRecordsByTimeWindow(queueInfo.task_id, startTime, endTime);

    // 如果连任何记录都没有，说明分片没有产出查询结果，才真正跳过
    if (allRecords.length === 0) {
      console.log(`[AEO-Shard] 分片 ${queueId} 时间窗口内无任何查询记录，跳过`);
      return null;
    }

    let analysis: any;
    let brandMentions: any[];
    let negativeFindings: any[];
    let sentimentSummary: any;
    let totalRecordCount: number;
    let brandMatchedCount: number;

    if (hasBrandMatch) {
      // ===== 有品牌命中：正常分析流程 =====
      totalRecordCount = queueInfo.result_record_count || allRecords.length;
      brandMatchedCount = brandMatchedRecords.length;

      // 准备分析输入（v2.0.5：截取内容前 3000 字，原 500 字太少）
      const analysisInput = brandMatchedRecords.map(r => ({
        platform: r.platform,
        keyword: r.keyword,
        content: (r.raw_content || '').substring(0, 3000),
        matchedBrands: r.matched_brands,
        shareUrl: r.share_url,
      }));

      // 调用 LLM 分析（复用现有 callLlmForAeo）
      analysis = await callLlmForAeo(analysisInput, brandKeywords, userId);

      // 提取品牌提及详情
      brandMentions = brandMatchedRecords.map(r => ({
        keyword: r.keyword,
        platform: r.platform,
        matchedBrands: r.matched_brands,
        shareUrl: r.share_url,
        contentPreview: (r.raw_content || '').substring(0, 200),
      }));

      // 识别负面发现（内容含负面词的记录）
      const negativeWords = ['差', '不好', '问题', '缺点', '不满', '失望', '垃圾', '骗', '不推荐', '踩雷', '避雷'];
      negativeFindings = brandMatchedRecords
        .filter(r => {
          const text = (r.raw_content || '').toLowerCase();
          return negativeWords.some(w => text.includes(w));
        })
        .map(r => ({
          keyword: r.keyword,
          platform: r.platform,
          contentPreview: (r.raw_content || '').substring(0, 300),
          negativeWords: negativeWords.filter(w => (r.raw_content || '').toLowerCase().includes(w)),
        }));

      // 情感汇总
      sentimentSummary = {
        total: brandMatchedRecords.length,
        positive: Math.round(brandMatchedRecords.length * analysis.positiveRatio / 100),
        neutral: Math.round(brandMatchedRecords.length * analysis.neutralRatio / 100),
        negative: Math.round(brandMatchedRecords.length * analysis.negativeRatio / 100),
        positiveRatio: analysis.positiveRatio,
        neutralRatio: analysis.neutralRatio,
        negativeRatio: analysis.negativeRatio,
      };
    } else {
      // ===== 无品牌命中：生成"收录为 0"的报告 =====
      // 没有命中记录说明品牌 AI 提及率为 0%，这恰恰是最需要 GEO 优化的情况
      totalRecordCount = allRecords.length;
      brandMatchedCount = 0;

      const noKeywordNote = brandKeywords.length === 0
        ? `用户未配置品牌词（pp 表为空），无法识别品牌命中。请先在"品牌词库"中添加品牌词。`
        : `已配置 ${brandKeywords.length} 个品牌词，但 AI 回答中均未提及品牌。`;

      analysis = {
        visibilityScore: 0,
        positiveRatio: 0,
        neutralRatio: 0,
        negativeRatio: 0,
        competitorAnalysis: '无品牌命中，无法分析竞品',
        suggestions: `本分片查询了 ${allRecords.length} 条记录，品牌命中 0 条，AI 提及率为 0%。${noKeywordNote}建议持续通过飞轮运转做 GEO 优化，提高品牌 AI 提及率。`,
        raw: JSON.stringify({
          reason: 'no_brand_match',
          total_records: allRecords.length,
          brand_matched_count: 0,
          brand_keyword_count: brandKeywords.length,
          note: noKeywordNote,
        }),
      };
      brandMentions = [];
      negativeFindings = [];
      sentimentSummary = {
        total: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
        positiveRatio: 0,
        neutralRatio: 0,
        negativeRatio: 0,
      };

      console.log(`[AEO-Shard] 分片 ${queueId} 无品牌命中，生成"收录为 0"报告（总查询 ${allRecords.length} 条）`);
    }

    // 入库
    const reportId = await insertAeoShardReport({
      task_id: queueInfo.task_id,
      queue_id: queueId,
      user_id: userId,
      round_no: queueInfo.round_no,
      shard_keywords: queueInfo.keywords,
      sentiment_summary: sentimentSummary,
      brand_mentions: brandMentions,
      negative_findings: negativeFindings,
      content_suggestions: analysis.suggestions,
      record_count: totalRecordCount,
      brand_matched_count: brandMatchedCount,
      visibility_score: analysis.visibilityScore,
      positive_ratio: analysis.positiveRatio,
      negative_ratio: analysis.negativeRatio,
      neutral_ratio: analysis.neutralRatio,
      raw_analysis: { raw: analysis.raw, competitorAnalysis: analysis.competitorAnalysis },
      shard_start_time: startTime,
      shard_end_time: endTime,
    });

    console.log(`[AEO-Shard] 分片 ${queueId} AEO报告已生成: reportId=${reportId}, 品牌命中=${brandMatchedCount}, 负面发现=${negativeFindings.length}`);
    return reportId;
  } catch (err: any) {
    console.error(`[AEO-Shard] 分片 ${queueId} AEO分析失败:`, err.message);
    return null;
  }
}

// ============ v2.0.0: 时间维度报告（周/月报）+ 写作驱动 ============

/**
 * 生成时间维度报告（周报/月报）并按配额自动创建写作任务（v2.0.0）
 *
 * 按客户创建日计算周期，汇总该周期内：
 * - 分片级 AEO 建议（所有分片的 content_suggestions 汇总）
 * - 收录统计（总记录数、品牌命中数、收录率、各平台分布）
 * - AI 平台信源权重投放建议（calcSourcePlatformWeights）
 * 生成综合写作建议池，按客户配额（weekly/monthly_article_quota）自动创建写作任务。
 *
 * 失败不阻断：各环节独立运行，报告生成失败不影响其他客户，写作任务创建失败不影响报告。
 *
 * @param userId 客户 ID
 * @param periodType 'weekly' | 'monthly'
 * @param periodStart 周期开始日期
 * @param periodEnd 周期结束日期
 * @returns 报告 ID（失败返回 null）
 */
export async function generatePeriodReport(
  userId: string,
  periodType: 'daily' | 'weekly' | 'monthly',
  periodStart: Date,
  periodEnd: Date
): Promise<number | null> {
  try {
    // 1. 防重复
    const exists = await checkPeriodReportExists(userId, periodType, periodStart, periodEnd);
    if (exists) {
      console.log(`[AEO-Period] 用户 ${userId} ${periodType} 报告已存在 (${periodStart.toISOString().slice(0,10)}~${periodEnd.toISOString().slice(0,10)})，跳过`);
      return null;
    }

    console.log(`[AEO-Period] 开始生成用户 ${userId} ${periodType} 报告 (${periodStart.toISOString().slice(0,10)}~${periodEnd.toISOString().slice(0,10)})`);

    // 2. 汇总该周期内的分片报告
    const shardReports = await getShardReportsByTimeRange(userId, periodStart, periodEnd);

    // 3. 收录统计
    const inclusionStats = await getInclusionStatsByTimeRange(userId, periodStart, periodEnd);

    // 4. AI 平台信源权重
    const sourceWeights = await calcSourcePlatformWeights();

    // 5. 客户配额（v2.0.2: 统一配额字段，向后兼容旧字段）
    const quotaConfig = await getAeoQuotaConfig(Number(userId));
    const configCycle = quotaConfig?.quota_cycle || 'weekly';
    // 新字段优先：article_quota + quota_cycle
    // 旧字段兼容：当 article_quota 为 0 但旧字段有值时回退
    const articleQuota = Number(quotaConfig?.article_quota) || 0;
    const legacyQuota = periodType === 'weekly'
      ? (Number(quotaConfig?.weekly_article_quota) || 0)
      : (periodType === 'monthly' ? (Number(quotaConfig?.monthly_article_quota) || 0) : 0);
    // 只有当当前周期类型 === 配置的周期时才触发自动写作
    // v2.1.3：支持 'daily' 周期
    const quota = periodType === configCycle
      ? (articleQuota > 0 ? articleQuota : legacyQuota)
      : 0;

    // 6. 汇总分片建议
    const shardSuggestionsSummary = summarizeShardSuggestions(shardReports);

    // 7. 排名汇总（从分片报告中提取可见度和情感分布）
    const rankSummary = buildRankSummary(shardReports);

    // 8. 平台对比（收录分布 + 信源权重）
    const platformComparison = buildPlatformComparison(inclusionStats, sourceWeights);

    // 9. 生成写作建议池
    const writingSuggestions = await generateWritingSuggestionsPool(
      shardReports, inclusionStats, sourceWeights, periodType, userId
    );

    // v2.0.0 P7：竞品反向 GEO — 若客户开启该功能，注入竞品对比文章建议
    if (quotaConfig?.enable_competitor_geo === true) {
      const competitorBrands = parseCompetitorBrands(quotaConfig.competitor_brands);
      if (competitorBrands.length > 0) {
        const competitorSuggestions = generateCompetitorGeoSuggestions(competitorBrands, sourceWeights, shardReports);
        writingSuggestions.push(...competitorSuggestions);
        console.log(`[AEO-Period] 用户 ${userId} 竞品反向GEO已启用，注入 ${competitorSuggestions.length} 条竞品对比建议，竞品: [${competitorBrands.join(', ')}]`);
      }
    }

    // 10. 建议文章数
    const suggestedArticleCount = quota > 0
      ? quota
      : (shardReports.length > 0 ? Math.min(5, shardReports.length) : 0);

    // 11. 入库
    const reportId = await insertAeoPeriodReport({
      user_id: userId,
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      inclusion_summary: inclusionStats,
      rank_summary: rankSummary,
      platform_comparison: platformComparison,
      shard_suggestions_summary: shardSuggestionsSummary,
      writing_suggestions: writingSuggestions,
      suggested_article_count: suggestedArticleCount,
      actual_article_count: 0,
      status: 'generated',
    });

    console.log(`[AEO-Period] 用户 ${userId} ${periodType} 报告生成成功 reportId=${reportId}, 分片数=${shardReports.length}, 建议文章数=${suggestedArticleCount}`);

    // 12. 按配额自动创建写作任务（P3-5）
    if (quota > 0) {
      try {
        const createdCount = await autoCreateWritingTasksFromPeriod(
          userId, reportId, quota, writingSuggestions, sourceWeights, periodType
        );
        await updatePeriodReportArticleCount(reportId, createdCount);
        console.log(`[AEO-Period] 用户 ${userId} ${periodType} 自动创建 ${createdCount}/${quota} 篇写作任务`);
      } catch (e: any) {
        console.warn(`[AEO-Period] 用户 ${userId} ${periodType} 自动创建写作任务失败:`, e.message);
      }
    }

    return reportId;
  } catch (err: any) {
    console.error(`[AEO-Period] 用户 ${userId} ${periodType} 报告生成失败:`, err.message);
    return null;
  }
}

/**
 * 汇总所有分片报告的内容建议
 */
function summarizeShardSuggestions(shardReports: any[]): string {
  if (shardReports.length === 0) return '本周期内无分片报告数据。';

  const allSuggestions: string[] = [];
  const negativeCount = { total: 0, negative: 0 };

  for (const sr of shardReports) {
    if (sr.content_suggestions) {
      allSuggestions.push(`[分片${sr.queue_id}] ${sr.content_suggestions}`);
    }
    const sentiment = sr.sentiment_summary || {};
    negativeCount.total += sentiment.total || 0;
    negativeCount.negative += sentiment.negative || 0;
  }

  const lines: string[] = [];
  lines.push(`本周期共 ${shardReports.length} 个分片报告，涉及 ${negativeCount.total} 条品牌提及记录。`);
  if (negativeCount.negative > 0) {
    lines.push(`负面情感记录 ${negativeCount.negative} 条，需重点关注并优化内容方向。`);
  }
  if (allSuggestions.length > 0) {
    lines.push('各分片优化建议汇总：');
    lines.push(...allSuggestions.slice(0, 20)); // 限制最多20条避免过长
  }
  return lines.join('\n');
}

/**
 * 构建排名/可见度/情感汇总
 */
function buildRankSummary(shardReports: any[]): any {
  if (shardReports.length === 0) {
    return { shard_count: 0, avg_visibility: 0, sentiment_distribution: { positive: 0, neutral: 0, negative: 0 } };
  }

  const totalVisibility = shardReports.reduce((sum, sr) => sum + (sr.visibility_score || 0), 0);
  const avgVisibility = Math.round(totalVisibility / shardReports.length);

  const sentimentDist = { positive: 0, neutral: 0, negative: 0 };
  for (const sr of shardReports) {
    sentimentDist.positive += sr.positive_ratio || 0;
    sentimentDist.neutral += sr.neutral_ratio || 0;
    sentimentDist.negative += sr.negative_ratio || 0;
  }
  // 取平均
  sentimentDist.positive = Math.round(sentimentDist.positive / shardReports.length);
  sentimentDist.neutral = Math.round(sentimentDist.neutral / shardReports.length);
  sentimentDist.negative = Math.round(sentimentDist.negative / shardReports.length);

  return {
    shard_count: shardReports.length,
    avg_visibility: avgVisibility,
    sentiment_distribution: sentimentDist,
    best_shard: shardReports.reduce((best, sr) => (sr.visibility_score > (best?.visibility_score || 0) ? sr : best), null)?.queue_id,
    worst_shard: shardReports.reduce((worst, sr) => (sr.visibility_score < (worst?.visibility_score || 999) ? sr : worst), null)?.queue_id,
  };
}

/**
 * 构建平台对比（收录分布 + AI平台信源权重）
 */
function buildPlatformComparison(inclusionStats: any, sourceWeights: Record<string, number>): any {
  const platformBreakdown = inclusionStats.platform_breakdown || [];
  return {
    inclusion_by_platform: platformBreakdown.map((p: any) => ({
      platform: p.platform,
      total: parseInt(p.count, 10),
      brand_matched: parseInt(p.brand_count, 10),
      brand_rate: p.count > 0 ? Math.round((parseInt(p.brand_count, 10) / parseInt(p.count, 10)) * 10000) / 100 : 0,
    })),
    ai_source_weights: sourceWeights,
    top_platforms_by_weight: Object.entries(sourceWeights)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([platform, weight]) => ({ platform, weight: Math.round(weight * 100) / 100 })),
  };
}

/**
 * 生成写作建议池（调用 LLM 或规则汇总）
 *
 * 建议池结构：
 * [{
 *   topic: 建议主题,
 *   direction: 创作方向,
 *   keywords: 建议关键词,
 *   platforms: 建议投放平台,
 *   priority: 'high' | 'medium' | 'low',
 *   reason: 建议原因
 * }]
 */
async function generateWritingSuggestionsPool(
  shardReports: any[],
  inclusionStats: any,
  sourceWeights: Record<string, number>,
  periodType: string,
  userId: string
): Promise<any[]> {
  // 收集负面发现和品牌提及关键词
  const negativeFindings: any[] = [];
  const brandMentionKeywords = new Set<string>();
  for (const sr of shardReports) {
    if (Array.isArray(sr.negative_findings)) {
      negativeFindings.push(...sr.negative_findings);
    }
    if (Array.isArray(sr.brand_mentions)) {
      for (const bm of sr.brand_mentions) {
        if (bm.keyword) brandMentionKeywords.add(bm.keyword);
      }
    }
  }

  // 排名前3的信源平台
  const topPlatforms = Object.entries(sourceWeights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([platform]) => platform);

  // v2.0.5：从 ai_model_config 表读取 AEO 专用模型（use_for_aeo=true）
  const modelConfig = await getAeoModelConfig(userId);
  if (!modelConfig || !modelConfig.api_key_encrypted) {
    console.warn(`[AEO-Period] 用户 ${userId} 未配置 AEO 模型（use_for_aeo=true），使用规则兜底生成写作建议`);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, negativeFindings, brandMentionKeywords);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO-Period] API-KEY 解密失败 platform=${modelConfig.platform}:`, e.message);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, negativeFindings, brandMentionKeywords);
  }

  const apiUrl = modelConfig.base_url;
  const model = modelConfig.model_name;
  console.log(`[AEO-Period] 使用模型生成写作建议: platform=${modelConfig.platform} model=${model}`);

  // 调用 LLM 生成建议池
  // v2.1.3：支持 'daily' 周期
  const periodLabel = periodType === 'daily' ? '日' : periodType === 'weekly' ? '周' : '月';
  const prompt = `你是 AEO（Answer Engine Optimization）内容策略专家。请基于以下本${periodLabel}数据，生成 5-10 条具体的写作建议。

分片报告数：${shardReports.length}
收录统计：总记录 ${inclusionStats.total}，品牌命中 ${inclusionStats.brand_matched}，收录率 ${inclusionStats.inclusion_rate}%
负面发现数：${negativeFindings.length}
品牌命中关键词：${Array.from(brandMentionKeywords).slice(0, 30).join('、') || '无'}
推荐投放平台（按AI平台信源权重）：${topPlatforms.join('、') || '无'}

各平台收录分布：
${JSON.stringify(inclusionStats.platform_breakdown || [], null, 2)}

负面发现详情（前5条）：
${JSON.stringify(negativeFindings.slice(0, 5), null, 2)}

请返回 JSON 数组（不要 markdown 代码块），每条建议包含：
{
  "topic": "建议主题（简短）",
  "direction": "创作方向（如：品牌优势强化/负面舆情应对/行业知识科普等）",
  "keywords": ["建议关键词1", "关键词2"],
  "platforms": ["平台1", "平台2"],
  "priority": "high|medium|low",
  "reason": "建议原因（基于数据分析）"
}`;

  try {
    const resp = await axios.post(
      apiUrl,
      {
        model,
        messages: [
          { role: 'system', content: '你是 AEO 内容策略专家，只返回 JSON 数组格式数据。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      }
    );

    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed)) {
      return parsed;
    }
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, negativeFindings, brandMentionKeywords);
  } catch (e: any) {
    console.warn('[AEO-Period] LLM 生成写作建议失败，使用规则兜底:', e.message);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, negativeFindings, brandMentionKeywords);
  }
}

/**
 * 无 LLM 时的规则兜底写作建议池
 */
function fallbackWritingSuggestions(
  shardReports: any[],
  inclusionStats: any,
  topPlatforms: string[],
  negativeFindings: any[],
  brandMentionKeywords: Set<string>
): any[] {
  const suggestions: any[] = [];

  // 建议1：负面舆情应对（如果有负面发现）
  if (negativeFindings.length > 0) {
    suggestions.push({
      topic: '负面舆情应对内容',
      direction: '负面舆情应对',
      keywords: Array.from(brandMentionKeywords).slice(0, 3),
      platforms: topPlatforms.slice(0, 2),
      priority: 'high',
      reason: `本周期检测到 ${negativeFindings.length} 条负面提及，需优先发布正面内容对冲`,
    });
  }

  // 建议2：品牌优势强化
  suggestions.push({
    topic: '品牌核心优势强化',
    direction: '品牌优势强化',
    keywords: Array.from(brandMentionKeywords).slice(0, 5),
    platforms: topPlatforms,
    priority: negativeFindings.length > 0 ? 'medium' : 'high',
    reason: '持续强化品牌在AI平台中的正面可见度，提升品牌词命中率',
  });

  // 建议3：低收录平台补强
  const platformBreakdown = inclusionStats.platform_breakdown || [];
  if (platformBreakdown.length > 0) {
    const lowInclusionPlatforms = platformBreakdown
      .filter((p: any) => parseInt(p.count, 10) < 5)
      .map((p: any) => p.platform);
    if (lowInclusionPlatforms.length > 0) {
      suggestions.push({
        topic: '低收录平台内容补强',
        direction: '平台覆盖扩展',
        keywords: Array.from(brandMentionKeywords).slice(0, 3),
        platforms: lowInclusionPlatforms.slice(0, 3),
        priority: 'medium',
        reason: `平台 ${lowInclusionPlatforms.join('、')} 收录量偏低，需增加针对性内容投放`,
      });
    }
  }

  // 建议4：高权重平台加大投放
  if (topPlatforms.length > 0) {
    suggestions.push({
      topic: '高AI信源权重平台加大投放',
      direction: '高权重平台深耕',
      keywords: Array.from(brandMentionKeywords).slice(0, 5),
      platforms: topPlatforms.slice(0, 2),
      priority: 'high',
      reason: `平台 ${topPlatforms.slice(0, 2).join('、')} 在AI平台信源中权重最高，应优先投放以提升AI收录`,
    });
  }

  // 建议5：行业知识科普
  suggestions.push({
    topic: '行业知识科普内容',
    direction: '行业知识科普',
    keywords: Array.from(brandMentionKeywords).slice(0, 3),
    platforms: topPlatforms,
    priority: 'low',
    reason: '通过行业科普内容扩大长尾关键词覆盖，间接提升品牌可见度',
  });

  return suggestions;
}

/**
 * 按配额自动创建写作任务（P3-5）
 *
 * 流程：
 * 1. 获取用户的默认知识库、写作指令、模型配置
 * 2. 按AI平台信源权重分配文章数到各平台（allocateArticlesByWeight）
 * 3. 注入 AEO 建议池作为 aeo_context
 * 4. 创建写作任务，标记 auto_generated=true, trigger_period_report_id=reportId
 *
 * @returns 实际创建的写作任务数
 */
async function autoCreateWritingTasksFromPeriod(
  userId: string,
  periodReportId: number,
  quota: number,
  writingSuggestions: any[],
  sourceWeights: Record<string, number>,
  periodType: string
): Promise<number> {
  const userIdNum = Number(userId);
  if (!userIdNum || quota <= 0) return 0;

  // 1. 获取用户的默认知识库（取第一个活跃的）
  const knowledges = await getEnterpriseKnowledges(userIdNum);
  if (knowledges.length === 0) {
    console.warn(`[AEO-Period] 用户 ${userId} 无企业知识库，跳过自动创建写作任务`);
    return 0;
  }
  const knowledge = knowledges[0];

  // 2. 获取默认写作指令（取第一个活跃的）
  const instructions = await getAllWritingInstructions();
  if (instructions.length === 0) {
    console.warn(`[AEO-Period] 无可用写作指令，跳过自动创建写作任务`);
    return 0;
  }
  const instruction = instructions[0];

  // 3. 获取默认模型配置
  const modelConfig = await getDefaultModelConfig(userIdNum);
  if (!modelConfig) {
    console.warn(`[AEO-Period] 用户 ${userId} 无可用写作模型配置，跳过自动创建写作任务`);
    return 0;
  }

  // 4. 按权重分配文章数
  const allocation = await allocateArticlesByWeight(quota);

  // 5. 构造 AEO 上下文（注入写作建议池）
  const aeoContext = JSON.stringify({
    period_report_id: periodReportId,
    period_type: periodType,
    suggestions: writingSuggestions,
    source_weights: sourceWeights,
    generated_at: new Date().toISOString(),
  });

  // 6. 汇总各平台分配的文章数，创建一个总的写作任务
  // （写作任务支持 target_platforms 字段，一个任务可覆盖多个平台）
  const targetPlatforms = Object.keys(allocation).filter(p => allocation[p] > 0);
  if (targetPlatforms.length === 0) {
    console.warn(`[AEO-Period] 用户 ${userId} 文章分配结果为空，跳过`);
    return 0;
  }

  const taskName = `[AEO自动] ${periodType === 'daily' ? '日报' : periodType === 'weekly' ? '周报' : '月报'}驱动写作任务 ${new Date().toISOString().slice(0, 10)}`;

  // v2.1.3：优先使用用户配置的"重点优化关键词"作为写作主题
  // 如果未配置 focus_keywords，则回退到 null（由写作指令和AEO建议驱动）
  const quotaConfig = await getAeoQuotaConfig(userIdNum);
  const focusKeywords: string[] = Array.isArray(quotaConfig?.focus_keywords)
    ? quotaConfig.focus_keywords.filter((k: any) => typeof k === 'string' && k.trim())
    : [];

  // v2.1.3：将 focus_keywords 字符串转为 zlgjc 表的 keyword_ids
  // 如果 focus_keywords 在 zlgjc 表中找不到匹配项，则 keyword_ids 为空（不影响文章生成，只是 L4 主题参考层为空）
  let focusKeywordIds: number[] = [];
  if (focusKeywords.length > 0) {
    try {
      const { getKeywordIdsByValues } = await import('../../repository');
      focusKeywordIds = await getKeywordIdsByValues(userIdNum, focusKeywords);
      console.log(`[AEO-Period] focus_keywords 匹配到 ${focusKeywordIds.length}/${focusKeywords.length} 个关键词 ID`);
    } catch (e: any) {
      console.warn(`[AEO-Period] 查询 focus_keywords ID 失败:`, e.message);
    }
  }

  // 创建写作任务
  // v2.1.3：auto_publish=true，写作完成后云端自动创建发布任务
  const taskId = await createWritingTask({
    user_id: userIdNum,
    task_name: taskName,
    keyword_ids: focusKeywordIds.length > 0 ? focusKeywordIds : null, // v2.1.3：重点优化关键词 ID
    instruction_id: instruction.id,
    knowledge_id: knowledge.id,
    model_config_id: modelConfig.id,
    generation_mode: 'expert',
    agent_profile_id: null,
    total_count: quota,
    cover_image_mode: 'none',
    cover_image_id: null,
    illustration_count: 0,
    target_platforms: targetPlatforms,
  });

  // 7. 补充 AEO 相关字段（createWritingTask 未包含这些字段）
  // v2.1.3：auto_publish=true 让云端 articleGenerator 完成后自动创建发布任务
  await dbQuery(
    `UPDATE ai_writing_task
     SET aeo_context = $1,
         auto_publish = true,
         auto_generated = true,
         trigger_period_report_id = $2
     WHERE id = $3`,
    [aeoContext, periodReportId, taskId]
  );

  console.log(`[AEO-Period] 写作任务已创建: taskId=${taskId}, name="${taskName}", total=${quota}, platforms=[${targetPlatforms.join(',')}]`);

  // 8. 异步触发写作任务执行（复用现有 executeWritingTask）
  //    使用动态 import 避免循环依赖
  try {
    const { executeWritingTask } = await import('../content/articleGenerator');
    executeWritingTask(taskId, userIdNum).catch((e: any) => {
      console.error(`[AEO-Period] 写作任务 ${taskId} 异步执行失败:`, e.message);
    });
  } catch (e: any) {
    console.warn(`[AEO-Period] 无法触发写作任务执行（articleGenerator 未加载）:`, e.message);
  }

  return quota;
}

// ============ v2.0.0 P7: 竞品反向 GEO ============

/**
 * 解析竞品品牌列表
 * 支持字符串数组、逗号分隔字符串、JSON 字符串
 */
function parseCompetitorBrands(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((b: any) => typeof b === 'string' && b.trim()).map((b: string) => b.trim());
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((b: any) => typeof b === 'string' && b.trim()).map((b: string) => b.trim());
      }
    } catch {
      // 非 JSON，按逗号分隔
      return raw.split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * P7：生成竞品反向 GEO 写作建议
 *
 * 策略：为每个竞品生成客观对比类文章建议，帮助用户品牌在 AI 平台搜索竞品时也获得曝光。
 * 文章方向：客观对比、行业评测、选型指南等，避免恶意贬低。
 *
 * @param competitorBrands 竞品品牌列表
 * @param sourceWeights AI平台信源权重
 * @param shardReports 本周期分片报告（用于分析竞品在本轮的提及情况）
 * @returns 写作建议数组
 */
function generateCompetitorGeoSuggestions(
  competitorBrands: string[],
  sourceWeights: Record<string, number>,
  shardReports: any[]
): any[] {
  const suggestions: any[] = [];

  // 排名前3的信源平台
  const topPlatforms = Object.entries(sourceWeights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([platform]) => platform);

  // 分析竞品在本轮分片报告中的提及情况
  const competitorMentions: Record<string, number> = {};
  for (const brand of competitorBrands) {
    competitorMentions[brand] = 0;
    for (const sr of shardReports) {
      const mentions = Array.isArray(sr.brand_mentions) ? sr.brand_mentions : [];
      for (const m of mentions) {
        const content = (m.contentPreview || '').toLowerCase();
        const keywords = (m.keyword || '').toLowerCase();
        if (content.includes(brand.toLowerCase()) || keywords.includes(brand.toLowerCase())) {
          competitorMentions[brand]++;
        }
      }
    }
  }

  // 建议1：客观对比类文章（用户品牌 vs 竞品）
  const topCompetitors = competitorBrands.slice(0, 3);
  if (topCompetitors.length > 0) {
    suggestions.push({
      topic: `品牌与竞品客观对比（${topCompetitors.join('、')}）`,
      direction: '竞品对比分析',
      keywords: topCompetitors,
      platforms: topPlatforms,
      priority: 'high',
      reason: `竞品反向GEO：当用户搜索竞品 "${topCompetitors.join('、')}" 时，通过客观对比文章让用户品牌也获得曝光。文章应客观公正，突出差异化优势。`,
    });
  }

  // 建议2：行业选型指南
  suggestions.push({
    topic: '行业选型指南（含竞品对比）',
    direction: '选型指南',
    keywords: [...competitorBrands, '选型', '对比', '评测'],
    platforms: topPlatforms,
    priority: 'medium',
    reason: '竞品反向GEO：通过行业选型指南类内容，在用户调研阶段就植入品牌认知，覆盖竞品搜索流量。',
  });

  // 建议3：针对提及量高的竞品，加强对比内容
  const hotCompetitors = Object.entries(competitorMentions)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([brand]) => brand);

  for (const brand of hotCompetitors) {
    suggestions.push({
      topic: `${brand} 深度对比评测`,
      direction: '竞品深度评测',
      keywords: [brand, '评测', '优缺点', '对比'],
      platforms: topPlatforms.slice(0, 2),
      priority: 'high',
      reason: `竞品 "${brand}" 在本轮查询中被提及 ${competitorMentions[brand]} 次，需加强对比内容投放，抢占该竞品的搜索流量。`,
    });
  }

  // 建议4：差异化优势内容
  if (competitorBrands.length > 0) {
    suggestions.push({
      topic: '品牌差异化优势分析',
      direction: '差异化定位',
      keywords: competitorBrands.slice(0, 2),
      platforms: topPlatforms,
      priority: 'medium',
      reason: '竞品反向GEO：通过差异化优势内容，在不贬低竞品的前提下，突出用户品牌的独特价值主张。',
    });
  }

  return suggestions;
}
