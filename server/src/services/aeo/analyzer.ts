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
  getRecordsByQueueId,
  insertAeoShardReport,
  checkShardReportExists,
  deleteAeoShardReportByQueueId,
  // v2.0.0 时间维度报告（周/月报）
  getShardReportsByTimeRange,
  getShardReportsByDate,
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
  // v2.2.2：自动写作精细化配置
  getWritingInstructions,
  getAgentProfiles,
  getCustomerKeywordIds,
  getImageLibrary,
  // v2.3.0: 写作建议池持久化与消费
  insertWritingSuggestions,
  getSuggestionPoolSourceType,
  getUnconsumedSuggestionsByLatestPeriod,
  consumeWritingSuggestions,
} from '../../repository';
import { query as dbQuery } from '../../db';
import { decrypt } from '../../utils/crypto';
import { wsBroadcast } from '../../wsServer';

const AEO_RECORD_LIMIT = parseInt(process.env.AEO_RECORD_LIMIT || '200');

/**
 * 为指定客户生成 AEO 日报
 *
 * v2.1.6 重构：数据源从 getBrandMentionRecordsForAeo（单任务、仅品牌命中）
 * 改为 getShardReportsByDate（按客户维度、当日所有分片报告汇总，跨任务合并蒸馏词+品牌词）
 * 这样日报/周报/月报/大屏的数据源统一为 aeo_shard_report，只是时间范围和聚合粒度不同
 *
 * @param taskId 占位 task_id（用于 aeo_report 表的主键约束，实际日报内容跨任务汇总）
 * @param userId 客户 ID（日报按客户维度生成）
 */
export async function generateAeoReport(taskId: number, userId: string, options?: { reportDate?: string; force?: boolean }): Promise<number | null> {
  // v2.2.3：修复日报日期逻辑
  // 原 bug：cron 0 2 * * * 凌晨 2 点触发时，today=当天日期，但凌晨 2 点当天分片报告还没生成
  //   → getShardReportsByDate(当天) 返回空 → 生成"无数据日报"，而前一天的日报永远不生成
  // 修复：凌晨 2 点应该总结"前一天"的巡检数据，report_date = 前一天日期
  // 如果当天调用（如手动触发、测试），则使用当天日期，由 checkAeoReportExists 防重复
  // v2.2.5：支持 options.reportDate 指定日期（用于补生成）和 options.force 强制覆盖
  let reportDate: string;
  if (options?.reportDate) {
    reportDate = options.reportDate;
  } else {
    const now = new Date();
    const nowShanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const hour = nowShanghai.getHours();
    // v2.2.3：凌晨 0-6 点视为"次日补前一天日报"，其他时段视为"当天日报"
    const reportDateObj = hour < 6
      ? new Date(nowShanghai.getTime() - 24 * 60 * 60 * 1000) // 前一天
      : nowShanghai; // 当天
    reportDate = reportDateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
  }

  // v2.2.4：检查该日期是否已为该客户生成日报（按 user_id + report_date，不再用 taskId）
  // v2.2.5：options.force=true 时跳过查重（用于补生成已存在但内容有误的日报，需配合删除旧报告）
  if (!options?.force) {
    const exists = await checkAeoReportExists(userId, reportDate);
    if (exists) {
      console.log(`[AEO] 用户 ${userId} ${reportDate} 日报已生成，跳过`);
      return null;
    }
  } else {
    // force 模式下先删除该客户该日期的旧日报（避免主键冲突）
    await dbQuery('DELETE FROM aeo_report WHERE user_id = $1 AND report_date = $2', [userId, reportDate]);
    console.log(`[AEO] 用户 ${userId} ${reportDate} 强制覆盖模式，已删除旧日报`);
  }

  // v2.1.6：改为基于当日分片报告汇总（数据源与周报/月报/大屏一致）
  const shardReports = await getShardReportsByDate(userId, reportDate);

  if (shardReports.length === 0) {
    console.log(`[AEO] 用户 ${userId} ${reportDate} 无分片报告，生成无数据日报`);
    const reportId = await insertAeoReport({
      taskId,
      userId,
      reportDate,
      visibilityScore: 0,
      mentionCount: 0,
      positiveRatio: 0,
      neutralRatio: 0,
      negativeRatio: 0,
      competitorAnalysis: `${reportDate} 无分片报告`,
      suggestions: `${reportDate} 巡检尚未产出分片报告，暂无数据分析结论。请检查巡检任务是否正常运行，或分片报告是否生成成功。`,
      rawAnalysis: JSON.stringify({ reason: 'no_shard_reports', report_date: reportDate, task_id: taskId, user_id: userId }),
      recordIds: [],
    });
    console.log(`[AEO] 用户 ${userId} ${reportDate} 无数据日报生成成功 reportId=${reportId}`);
    return reportId;
  }

  // v2.2.23：日报数据汇总全面重构
  //   原 bug：
  //   1. 数值汇总无 NaN 防护，分片字段为 null 时 avgVisibility/avgPositive 等变成 NaN
  //   2. 未启用竞品反向 GEO 的客户也统计竞品信息，浪费 token
  //   3. LLM 只看到 raw_contents_sample，没看到分片报告已得出的深度结论（suggestions/sentiment_dimensions）
  //   4. 负面发现只统计数量（"1342 条需关注"），没把具体内容喂给 LLM
  //   修复：
  //   1. 数值汇总加 NaN 防护（null/undefined/NaN 一律按 0 处理）
  //   2. 读 cloud_api_config.enable_competitor_geo，未启用时不带竞品字段
  //   3. LLM 输入扩充：分片 suggestions + sentiment_dimensions + 具体负面发现
  //   4. LLM prompt 重构：基于分片结论做"元分析"，不再从 raw 内容重新分析

  // 读取客户配置（判断是否启用竞品反向 GEO）
  const aeoConfig = await getAeoQuotaConfig(Number(userId));
  const enableCompetitorGeo = !!(aeoConfig as any)?.enable_competitor_geo;

  // 数值汇总（v2.2.23：加 NaN 防护）
  const safeNum = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const totalRecords = shardReports.reduce((sum, sr) => sum + safeNum(sr.record_count), 0);
  const totalBrandMatched = shardReports.reduce((sum, sr) => sum + safeNum(sr.brand_matched_count), 0);

  // v2.2.24：废弃"按 record_count 加权平均"，改用 LLM 输出 + 归一化
  //   v2.2.23 bug：分片报告 positive_ratio/neutral_ratio/negative_ratio 字段单位不统一
  //     有的分片存 0-1 小数（如 0.8），有的存 0-100 整数（如 80），混用导致加权后爆炸
  //     （如 0.8 × 5000 = 4000，除以 1 = 4000%，出现 4200% / 5300% / 500% 等荒谬数据）
  //   修复：
  //   1. 不再自己算加权平均，直接用 callLlmForAeoV2 的 LLM 输出
  //      （LLM 已基于分片 sentiment_dimensions 综合判断，比加权平均更准）
  //   2. 归一化：ratio <= 1 视为 0-1 范围，×100 转 0-100；ratio > 1 直接用
  //   3. 三者和约束：positive + neutral + negative 必须 ≤ 100，超出按比例缩放
  const normalizeRatio = (v: number): number => {
    const n = safeNum(v);
    if (n <= 1) return n * 100; // 0-1 范围，转成 0-100
    return n; // 已经是 0-100
  };

  // 汇总平台分布（合计 + 按词类型分组）
  // v2.2.25：区分蒸馏词/品牌词的平台分布
  //   原因：品牌词任务查询词本身含品牌名，命中率天然 90%+；
  //         蒸馏词任务查询词是行业通用词，命中率真实反映 GEO 可见度（通常 10-30%）
  //   合并统计会让蒸馏词的低命中被品牌词的高命中稀释，掩盖真实 GEO 问题
  const platformMap: Record<string, { total: number; brand_matched: number }> = {};
  // 蒸馏词任务的平台分布（keyword_type !== 1）
  const platformMapByDistill: Record<string, { total: number; brand_matched: number }> = {};
  // 品牌词任务的平台分布（keyword_type === 1）
  const platformMapByBrand: Record<string, { total: number; brand_matched: number }> = {};
  for (const sr of shardReports) {
    const pb = Array.isArray(sr.platform_breakdown) ? sr.platform_breakdown : [];
    const isBrand = sr.keyword_type === 1;
    const targetMap = isBrand ? platformMapByBrand : platformMapByDistill;
    for (const p of pb) {
      const name = p.platform || 'unknown';
      // 合计
      if (!platformMap[name]) platformMap[name] = { total: 0, brand_matched: 0 };
      platformMap[name].total += safeNum(p.total);
      platformMap[name].brand_matched += safeNum(p.brand_matched);
      // 按词类型分组
      if (!targetMap[name]) targetMap[name] = { total: 0, brand_matched: 0 };
      targetMap[name].total += safeNum(p.total);
      targetMap[name].brand_matched += safeNum(p.brand_matched);
    }
  }

  // v2.2.23：竞品信息按需汇总（仅在启用竞品反向 GEO 时）
  let competitorMap: Record<string, number> = {};
  let topCompetitors: string[] = [];
  if (enableCompetitorGeo) {
    for (const sr of shardReports) {
      const competitors = Array.isArray(sr.competitor_mentions) ? sr.competitor_mentions : [];
      for (const c of competitors) {
        const name = c.competitor || '';
        if (name) competitorMap[name] = (competitorMap[name] || 0) + safeNum(c.mention_count);
      }
    }
    topCompetitors = Object.entries(competitorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count}次)`);
  }

  // 汇总负面发现（v2.2.23：保留前 20 条具体内容喂给 LLM，不再只统计数量）
  const allNegativeFindings: any[] = [];
  for (const sr of shardReports) {
    const findings = Array.isArray(sr.negative_findings) ? sr.negative_findings : [];
    for (const f of findings) {
      allNegativeFindings.push({
        queue_id: sr.queue_id,
        keyword_type: sr.keyword_type,
        finding: typeof f === 'string' ? f : (f?.description || f?.text || JSON.stringify(f)),
      });
      if (allNegativeFindings.length >= 20) break;
    }
    if (allNegativeFindings.length >= 20) break;
  }

  // v2.2.23：收集分片报告的深度结论（suggestions + sentiment_dimensions）
  //   原 bug：分片报告的 suggestions（LLM 已得出的 3-5 条结论）从未被汇总到日报，
  //     日报 LLM 只看到 raw_contents_sample 重新分析，结论泛泛且与分片结论脱节。
  //   修复：把每个分片的 suggestions 和 sentiment_dimensions 喂给日报 LLM，
  //     让日报 LLM 做"元分析"（汇总分片结论 + 找出跨分片规律）。
  const shardConclusions: any[] = [];
  const shardSentimentDimensions: any[] = [];
  for (const sr of shardReports.slice(0, 10)) { // 最多取 10 个分片，避免 token 超限
    if (sr.content_suggestions || sr.raw_analysis) {
      shardConclusions.push({
        queue_id: sr.queue_id,
        keyword_type: sr.keyword_type === 1 ? '品牌词' : '蒸馏词',
        record_count: safeNum(sr.record_count),
        brand_matched_count: safeNum(sr.brand_matched_count),
        visibility_score: safeNum(sr.visibility_score),
        suggestions: sr.content_suggestions || '',  // 分片 LLM 已得出的结论文本（数据库列名 content_suggestions）
      });
    }
    if (sr.sentiment_dimensions) {
      shardSentimentDimensions.push({
        queue_id: sr.queue_id,
        dimensions: sr.sentiment_dimensions,
      });
    }
  }

  // 收集所有分片的内容样本（保留作为 LLM 兜底输入，但优先用分片结论）
  const allContentSamples: any[] = [];
  for (const sr of shardReports) {
    const samples = Array.isArray(sr.raw_contents_sample) ? sr.raw_contents_sample : [];
    for (const s of samples) {
      allContentSamples.push(s);
      if (allContentSamples.length >= 30) break;
    }
    if (allContentSamples.length >= 30) break;
  }

  // 获取品牌词
  const brandKeywords = await getBrandKeywords(userId);

  // 准备 LLM 分析输入
  const analysisInput = allContentSamples.map(s => ({
    platform: s.platform,
    keyword: s.keyword,
    content: (s.content || '').substring(0, 3000),
    matchedBrands: s.matched_brands,
    brandMatched: s.brand_matched,
  }));

  // v2.2.23：调用增强版 LLM 分析（传入分片结论 + 情感维度 + 负面发现 + 竞品开关）
  const analysis = await callLlmForAeoV2(
    analysisInput,
    brandKeywords,
    userId,
    {
      shardConclusions,
      shardSentimentDimensions,
      negativeFindings: allNegativeFindings,
      enableCompetitorGeo,
      topCompetitors,
      platformStats: platformMap,
      totalRecords,
      totalBrandMatched,
    }
  );

  // v2.2.24：直接用 LLM 输出的评分 + 归一化 + 三者和约束（不再自己算加权平均）
  //   原 bug：自己算加权平均时分片 positive_ratio 字段单位混乱（0-1 / 0-100 混用），
  //     导致出现 4200% / 5300% / 500% 等荒谬数据
  //   修复：LLM 已基于分片 sentiment_dimensions 综合判断，直接用其输出更准确，
  //     再做归一化（0-1 转 0-100）和三者和约束（≤100）确保数据合理
  let finalVisibility = Math.min(100, Math.max(0, safeNum(analysis.visibilityScore)));
  let finalPositive = normalizeRatio(safeNum(analysis.positiveRatio));
  let finalNeutral = normalizeRatio(safeNum(analysis.neutralRatio));
  let finalNegative = normalizeRatio(safeNum(analysis.negativeRatio));
  // 三者和约束：positive + neutral + negative ≤ 100
  const ratioSum = finalPositive + finalNeutral + finalNegative;
  if (ratioSum > 100 && ratioSum > 0) {
    const scale = 100 / ratioSum;
    finalPositive = Math.round(finalPositive * scale);
    finalNeutral = Math.round(finalNeutral * scale);
    finalNegative = Math.round(finalNegative * scale);
  } else {
    finalPositive = Math.round(finalPositive);
    finalNeutral = Math.round(finalNeutral);
    finalNegative = Math.round(finalNegative);
  }

  // 构建日报建议（含多维度汇总数据）
  const inclusionRate = totalRecords > 0
    ? Math.round((totalBrandMatched / totalRecords) * 10000) / 100
    : 0;
  const platformSummary = Object.entries(platformMap)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([name, stat]) => `${name}: ${stat.total}条/命中${stat.brand_matched}条`)
    .join('，');

  // v2.2.24：日报建议重构 - 直接用 LLM 归一化后的数值
  const competitorLine = enableCompetitorGeo
    ? `【竞品提及】${topCompetitors.length > 0 ? topCompetitors.join('、') : '无竞品提及'}。`
    : ''; // 未启用竞品反向 GEO 时不展示这一行
  const dailySuggestions = `【今日数据汇总】分片报告 ${shardReports.length} 份，总查询 ${totalRecords} 条，品牌命中 ${totalBrandMatched} 条，收录率 ${inclusionRate}%，可见度 ${finalVisibility}分。
【情感分布】正面 ${finalPositive}%，中性 ${finalNeutral}%，负面 ${finalNegative}%。
【平台分布】${platformSummary || '无平台数据'}。
${competitorLine}【负面发现】${allNegativeFindings.length} 条（含具体内容，已传递给 LLM 分析）。
【LLM 元分析】${analysis.suggestions}`;

  // 入库
  // v2.2.9：修复 "invalid input syntax for type integer: 'NaN'" 错误
  // 原 bug：recordIds 直接用 sr.queue_id，若 queue_id 为 undefined/null 会传给 BIGINT[] 导致序列化异常
  // 修复：过滤掉非数字的 queue_id，确保数组元素都是有效整数
  const recordIds = shardReports
    .map(sr => sr.queue_id)
    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  const reportId = await insertAeoReport({
    taskId,
    userId,
    reportDate,
    visibilityScore: finalVisibility,
    mentionCount: totalBrandMatched,
    positiveRatio: finalPositive,
    neutralRatio: finalNeutral,
    negativeRatio: finalNegative,
    competitorAnalysis: enableCompetitorGeo
      ? (topCompetitors.length > 0 ? `今日竞品提及：${topCompetitors.join('、')}` : '无竞品提及')
      : '未启用竞品反向 GEO',
    suggestions: dailySuggestions,
    rawAnalysis: JSON.stringify({
      shard_report_count: shardReports.length,
      total_records: totalRecords,
      brand_matched: totalBrandMatched,
      inclusion_rate: inclusionRate,
      platform_breakdown: platformMap,
      // v2.2.25：按词类型分组的平台分布（蒸馏词 vs 品牌词，命中率差异大需分别展示）
      platform_breakdown_by_type: {
        distillate: platformMapByDistill,
        brand: platformMapByBrand,
      },
      competitor_mentions: enableCompetitorGeo ? competitorMap : null,
      competitor_geo_enabled: enableCompetitorGeo,
      negative_findings_count: allNegativeFindings.length,
      negative_findings_sample: allNegativeFindings.slice(0, 5),
      shard_conclusions_count: shardConclusions.length,
      shard_sentiment_dimensions_count: shardSentimentDimensions.length,
      llm_raw: analysis.raw,
      llm_competitor_analysis: analysis.competitorAnalysis,
    }),
    recordIds, // 用 queue_id 作为记录标识（已过滤无效值）
  });

  console.log(`[AEO] 用户 ${userId} 日报生成成功 reportId=${reportId}, 分片报告=${shardReports.length}, 总查询=${totalRecords}, 品牌命中=${totalBrandMatched}, 收录率=${inclusionRate}%`);
  // v2.4.0：推送日报生成完成事件，前端可立即刷新 latestAeo/aeoHistory/writingSuggestions/periodReports.daily/poolSuggestions
  wsBroadcast('aeo_daily_report_generated', {
    reportId,
    userId,
    reportDate: options?.reportDate,
  }, userId);
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

  // v2.1.6：构建多平台维度分析 prompt
  // 输入包含全量记录（含未命中），让 LLM 看到所有 AI 平台的覆盖情况
  // 品牌命中记录带 brandMatched=true，未命中记录带 brandMatched=false
  const platformStats: Record<string, { total: number; hit: number }> = {};
  for (const r of records) {
    const p = r.platform || 'unknown';
    if (!platformStats[p]) platformStats[p] = { total: 0, hit: 0 };
    platformStats[p].total++;
    if (r.brandMatched === true || (r.matchedBrands && r.matchedBrands.length > 0)) platformStats[p].hit++;
  }
  const platformSummary = Object.entries(platformStats)
    .map(([p, s]) => `${p}: 查询${s.total}条/命中${s.hit}条(${s.total > 0 ? Math.round(s.hit / s.total * 100) : 0}%)`)
    .join('；');
  const hitRecords = records.filter(r => r.brandMatched === true || (r.matchedBrands && r.matchedBrands.length > 0));
  const totalRecords = records.length;
  const hitCount = hitRecords.length;

  const prompt = `你是一位 AEO（Answer Engine Optimization）数据分析师，负责评估品牌在所有 AI 平台上的整体可见度和形象。
GEO 优化的目标是提高品牌在所有 AI 平台（不只某一个）上的提及率和正面形象。

注意：你只负责客观数据分析和结论，不负责给出写作或优化建议。写作建议由周报/月报统一生成。

品牌关键词：${brandKeywords.join('、')}

【整体数据概览】
- 总查询记录：${totalRecords} 条
- 品牌命中记录：${hitCount} 条（命中率 ${totalRecords > 0 ? Math.round(hitCount / totalRecords * 100) : 0}%）
- 覆盖平台：${Object.keys(platformStats).length} 个
- 平台分布：${platformSummary}

【记录详情】（brandMatched=true 表示该条 AI 回答提及了品牌，false 表示未提及）
${JSON.stringify(records.slice(0, 30), null, 2)}

请综合所有平台的数据，返回 JSON 格式（不要 markdown 代码块）：
{
  "visibilityScore": 0-100的整数,  // 品牌可见度评分（需综合考虑：命中率、覆盖平台数、各平台命中均衡度）
  "positiveRatio": 0-100的数字,    // 正面情感占比（基于命中记录的内容分析）
  "neutralRatio": 0-100的数字,     // 中性情感占比
  "negativeRatio": 0-100的数字,    // 负面情感占比
  "competitorAnalysis": "竞品分析文本", // 各平台中出现的竞品情况
  "suggestions": "数据分析结论"     // 3-5条客观数据分析结论，需包含：1)整体可见度评估 2)各平台覆盖差异（哪些平台命中高/低）3)情感分布 4)与 GEO 目标的差距
}

评分参考：
- visibilityScore 应反映品牌在所有 AI 平台的整体可见度，不只看单一平台
- 命中率 100% 且覆盖所有平台 = 90-100 分
- 命中率 50% 且覆盖多数平台 = 50-70 分
- 命中率 0% = 0 分
- 只在单一平台命中（其他平台全未命中）应扣分，因为 GEO 目标是全平台覆盖`;

  try {
    const resp = await axios.post(
      apiUrl,
      {
        model,
        messages: [
          { role: 'system', content: '你是 AEO 分析专家，只返回 JSON 格式数据。综合所有 AI 平台数据进行分析，不只看单一平台。' },
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
 * v2.2.23：增强版 AEO LLM 分析（基于分片报告已得出的结论做"元分析"）
 *
 * 与 callLlmForAeo 的区别：
 *   - callLlmForAeo：把原始记录（raw_contents_sample）喂给 LLM，让它从零开始分析
 *     → 问题：日报 LLM 重新分析的结论泛泛，与分片报告已得出的深度结论脱节
 *   - callLlmForAeoV2：把每个分片报告的 suggestions + sentiment_dimensions + 负面发现
 *     喂给 LLM，让它做"元分析"（汇总分片结论 + 找出跨分片规律 + 指出具体问题点）
 *     → 优势：继承分片报告的深度结论，日报 LLM 只需做"高阶综合"，结论更具体
 *
 * 输入扩展上下文：
 *   - shardConclusions：每个分片的 LLM 结论文本（已得出的 3-5 条结论）
 *   - shardSentimentDimensions：每个分片的多维度情感评分（信任度/专业度等）
 *   - negativeFindings：具体负面发现内容（前 20 条）
 *   - enableCompetitorGeo / topCompetitors：竞品开关 + 竞品列表
 *   - platformStats：平台分布统计
 *   - totalRecords / totalBrandMatched：总查询量 / 品牌命中量
 */
async function callLlmForAeoV2(
  records: any[],
  brandKeywords: string[],
  userId: string,
  context: {
    shardConclusions: any[];
    shardSentimentDimensions: any[];
    negativeFindings: any[];
    enableCompetitorGeo: boolean;
    topCompetitors: string[];
    platformStats: Record<string, { total: number; brand_matched: number }>;
    totalRecords: number;
    totalBrandMatched: number;
  }
): Promise<{
  visibilityScore: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
}> {
  const {
    shardConclusions,
    shardSentimentDimensions,
    negativeFindings,
    enableCompetitorGeo,
    topCompetitors,
    platformStats,
    totalRecords,
    totalBrandMatched,
  } = context;

  // 从 ai_model_config 表读取 AEO 专用模型
  const modelConfig = await getAeoModelConfig(userId);
  if (!modelConfig || !modelConfig.api_key_encrypted) {
    console.warn(`[AEO-V2] 用户 ${userId} 未配置 AEO 模型，降级用 fallback 分析`);
    return fallbackAnalysis(records, brandKeywords);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO-V2] API-KEY 解密失败 platform=${modelConfig.platform}:`, e.message);
    return fallbackAnalysis(records, brandKeywords);
  }

  const apiUrl = modelConfig.base_url;
  const model = modelConfig.model_name;
  console.log(`[AEO-V2] 使用模型: platform=${modelConfig.platform} model=${model} 分片结论=${shardConclusions.length} 情感维度=${shardSentimentDimensions.length} 负面发现=${negativeFindings.length}`);

  // 平台分布汇总
  const platformSummary = Object.entries(platformStats)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, s]) => `${name}: ${s.total}条/命中${s.brand_matched}条(${s.total > 0 ? Math.round(s.brand_matched / s.total * 100) : 0}%)`)
    .join('；');

  // v2.2.23：构建"元分析" prompt —— 让 LLM 基于分片已得出的结论做综合分析，而非从 raw 内容重新分析
  // 关键改进：
  //   1. 输入是"分片 LLM 已得出的结论文本"而非"原始 AI 平台回答内容"
  //   2. 要求 LLM 指出"具体问题点"（哪个维度、哪个平台、哪个关键词方向）
  //   3. 竞品分析按需输出（未启用竞品反向 GEO 时不要求 LLM 分析竞品，节省 token）
  //   4. 要求 LLM 输出与分片结论一致的数值（visibilityScore/情感比例），而非重新估算
  const competitorSection = enableCompetitorGeo
    ? `
【竞品提及数据】（已启用竞品反向 GEO）
今日提及竞品：${topCompetitors.length > 0 ? topCompetitors.join('、') : '无'}
请在 "competitorAnalysis" 字段中分析竞品格局，未提及则填"无竞品提及"。`
    : `
【竞品分析要求】
该客户未启用竞品反向 GEO，"competitorAnalysis" 字段固定填"未启用竞品反向 GEO"，不要分析竞品，节省 token。`;

  const prompt = `你是 AEO（Answer Engine Optimization）资深数据分析师，现在要做的是"元分析"（Meta-Analysis）—— 基于分片报告已经得出的结论做高阶综合，而不是从原始内容重新分析。

品牌关键词：${brandKeywords.join('、')}

【今日整体数据】
- 总查询：${totalRecords} 条
- 品牌命中：${totalBrandMatched} 条
- 平台分布：${platformSummary || '无'}
- 分片报告数：${shardConclusions.length} 份（含深度结论），情感维度报告数：${shardSentimentDimensions.length} 份
- 负面发现：${negativeFindings.length} 条具体内容
${competitorSection}

【各分片报告的深度结论】（每个分片已由 LLM 分析得出 3-5 条结论，请基于这些结论做元分析）
${JSON.stringify(shardConclusions, null, 2)}

【各分片的多维度情感评分】（信任度/专业度/推荐意愿/性价比感知/品牌认知度，0-100 分）
${JSON.stringify(shardSentimentDimensions, null, 2)}

【负面发现具体内容】（前 20 条，请重点分析这些具体问题点）
${JSON.stringify(negativeFindings, null, 2)}

【兜底原始记录】（仅作参考，优先使用上面的分片结论）
${JSON.stringify(records.slice(0, 10), null, 2)}

请基于以上分片结论做"元分析"，返回 JSON 格式（不要 markdown 代码块）：
{
  "visibilityScore": 0-100的整数,  // 综合可见度评分（基于分片结论综合判断，不是简单平均）
  "positiveRatio": 0-100的数字,    // 正面情感占比（基于分片情感维度综合）
  "neutralRatio": 0-100的数字,     // 中性情感占比
  "negativeRatio": 0-100的数字,    // 负面情感占比
  "competitorAnalysis": "${enableCompetitorGeo ? '竞品格局分析文本' : '未启用竞品反向 GEO'}",
  "suggestions": "元分析结论文本（4-6条，必须具体到点，不要泛泛而谈）"
}

【suggestions 字段必须包含的内容】（按以下顺序，每条都要具体到点）：
1. **整体情感健康度评估**：基于分片情感维度的加权综合，指出哪个维度（信任度/专业度/推荐意愿/性价比/品牌认知度）得分最高、哪个最低，分数具体到数字
2. **具体问题点诊断**：直接引用分片结论中指出的具体问题（如"专利代办负面突出""DeepSeek 和腾讯元宝负面集中"等具体表述），不要只说"有负面舆情"，要说"在 XX 话题上、XX 平台上、具体是什么负面"
3. **平台差异分析**：哪些平台偏正面、哪些平台偏负面，差异具体表现在哪些话题上
4. **跨分片规律**：多个分片共同指向的问题（如多个分片都提到某话题负面），这是高优先级问题
5. **负面舆情风险等级**：基于负面发现的具体内容，判断风险等级（高/中/低），并指出最需要立即处理的 1-2 条
${enableCompetitorGeo ? '6. **竞品格局**：基于竞品提及数据，分析竞品威胁程度' : ''}

【重要约束】
- 不要泛泛而谈，每条结论必须具体到维度、平台、话题、关键词
- 不要重复分片结论的原话，要做"高阶综合"（找出分片之间的规律和差异）
- visibilityScore / 情感比例 要与分片结论的数值一致（不要凭空估算）
- 如果某个维度数据缺失（如分片没有 sentiment_dimensions），明确说明"数据不足"而不是填 0`;

  try {
    const resp = await axios.post(
      apiUrl,
      {
        model,
        messages: [
          { role: 'system', content: '你是 AEO 资深数据分析师，专注于基于分片结论做元分析，输出具体到点的问题诊断。只返回 JSON 格式数据。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 90000,
      }
    );

    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
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
    console.error(`[AEO-V2] LLM 调用失败 platform=${modelConfig.platform} model=${model}，降级用 fallback 分析:`, e.message);
    return fallbackAnalysis(records, brandKeywords);
  }
}

/**
 * 无 LLM 时的简单分析（纯代码）
 * v2.1.6：改为多平台维度计算，不只看品牌命中
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
  // v2.4.7：修复字段名 bug（原 camelCase 导致 fallback 时所有命中统计全为 0）
  //   数据库 real_collect_record 返回的字段是 snake_case：brand_matched / matched_brands / raw_content
  //   但原代码用 r.brandMatched / r.matchedBrands / r.content 访问，永远拿不到值
  //   → fallback 时 hitRecords=[] → visibilityScore=0、命中率=0%、情感分布全 0%
  //   → 用户看到"LLM 调用失败，使用 fallback"时所有数据归零
  //   修复：统一用 snake_case
  const isHit = (r: any): boolean =>
    r.brand_matched === true || (Array.isArray(r.matched_brands) && r.matched_brands.length > 0);

  // v2.1.6：按平台统计命中情况
  const platformMap: Record<string, { total: number; hit: number }> = {};
  for (const r of records) {
    const p = r.platform || 'unknown';
    if (!platformMap[p]) platformMap[p] = { total: 0, hit: 0 };
    platformMap[p].total++;
    if (isHit(r)) platformMap[p].hit++;
  }
  const platformCount = Object.keys(platformMap).length;
  const hitPlatforms = Object.entries(platformMap).filter(([_, s]) => s.hit > 0).length;
  const totalRecords = records.length;
  const hitRecords = records.filter(isHit);
  const hitCount = hitRecords.length;
  const hitRate = totalRecords > 0 ? hitCount / totalRecords : 0;

  // v2.1.6：可见度 = 命中率(40%) + 平台覆盖均衡度(40%) + 命中数量(20%)
  // 平台覆盖均衡度 = 命中平台数 / 总平台数
  const platformBalance = platformCount > 0 ? hitPlatforms / platformCount : 0;
  const hitCountScore = Math.min(1, hitCount / 10); // 10条命中即满分
  const visibilityScore = Math.round((hitRate * 0.4 + platformBalance * 0.4 + hitCountScore * 0.2) * 100);

  // 简单情感判断：基于命中记录
  // v2.4.7：改进关键词列表，避免匹配到无关内容（如"差异化"误匹配"差"、"没问题"误匹配"问题"）
  //   原关键词：'差', '不好', '问题', '缺点' ... 会匹配到正常文本
  //   改用更精确的组合词或短语，减少误报
  const positiveWords = ['好评', '优秀', '推荐', '不错', '方便', '好用', '满意', '专业', '靠谱', '值得'];
  const negativeWords = ['差评', '不好', '缺点', '不满', '失望', '垃圾', '骗子', '不推荐', '踩雷', '避雷', '投诉', '维权', '质量差', '服务差', '态度差'];

  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const r of hitRecords) {
    // 修复：字段名从 r.content 改为 r.raw_content（数据库实际字段名）
    const text = (r.raw_content || '').toLowerCase();
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

  const total = hitRecords.length || 1;
  const platformBreakdown = Object.entries(platformMap)
    .map(([p, s]) => `${p}: ${s.hit}/${s.total}(${s.total > 0 ? Math.round(s.hit / s.total * 100) : 0}%)`)
    .join('，');
  const competitorAnalysis = `共在 ${hitPlatforms}/${platformCount} 个平台获得 ${hitCount} 次品牌提及。平台分布：${platformBreakdown}`;
  // v2.1.5: 日报只输出客观数据分析结论，不输出写作或优化建议（写作建议由周/月报统一生成）
  const suggestions = `1. 整体可见度评分 ${visibilityScore}，命中率 ${Math.round(hitRate * 100)}%（${hitCount}/${totalRecords}）\n2. 平台覆盖：${hitPlatforms}/${platformCount} 个平台命中品牌，${platformCount - hitPlatforms} 个平台未命中\n3. 正面情感占比 ${Math.round((positive / total) * 100)}%，负面情感占比 ${Math.round((negative / total) * 100)}%\n4. 平台分布：${platformBreakdown}`;

  return {
    visibilityScore,
    positiveRatio: Math.round((positive / total) * 100),
    neutralRatio: Math.round((neutral / total) * 100),
    negativeRatio: Math.round((negative / total) * 100),
    competitorAnalysis,
    suggestions,
    raw: JSON.stringify({ fallback: true, total_records: totalRecords, hit_count: hitCount, hit_rate: hitRate, platform_count: platformCount, hit_platforms: hitPlatforms }),
  };
}

// ============ v2.1.9: 分片报告按关键词来源分离分析管道 ============
// 品牌词任务（keyword_type=1）：查询词本身含品牌，AI 几乎必然提及，命中率天然高（90%+）
//   → 重点做深度情感分析，评分基于情感健康度（正面 - 负面），而非命中率
// 蒸馏词任务（keyword_type=0）：查询词是行业通用词，AI 是否提及品牌才真实反映 GEO 可见度
//   → 重点做提及率/覆盖率分析，评分基于提及率 × 平台覆盖均衡度

/** 品牌词任务分片报告分析结果 */
interface BrandShardAnalysis {
  visibilityScore: number;       // 情感健康度评分（正面占比 - 负面占比，加权平台覆盖）
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
  sentimentDimensions: {
    trust: number;                // 信任度 0-100
    professionalism: number;      // 专业度 0-100
    recommendation_intent: number;// 推荐意愿 0-100
    value_perception: number;     // 性价比感知 0-100
    brand_recall: number;         // 品牌认知度 0-100
    dimension_notes: string;      // 各维度评分依据说明
  };
  brandMentions: any[];
  negativeFindings: any[];
  sentimentSummary: any;
}

/** 蒸馏词任务分片报告分析结果 */
interface DistillateShardAnalysis {
  visibilityScore: number;       // 提及率 × 平台覆盖均衡度
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  raw: string;
  mentionAnalysis: {
    platform_mention_rates: { platform: string; total: number; mentioned: number; rate: number }[];
    uncovered_keywords: string[];      // 未命中品牌的关键词列表
    coverage_gaps: string;             // 覆盖盲区说明
    cross_platform_consistency: number;// 跨平台一致性 0-100
    mention_notes: string;             // 提及率分析说明
  };
  brandMentions: any[];
  negativeFindings: any[];
  sentimentSummary: any;
}

/**
 * 品牌词任务分片分析管道（keyword_type=1）
 *
 * 特点：查询词本身就含品牌（如"川务财税公司注册"），AI 回答几乎必然提及品牌，
 * 命中率天然高（90%+），因此命中率不是有意义的指标。
 * 本管道重点做深度情感分析，理解 AI 回答中对品牌的态度和评价维度。
 *
 * 评分标准（visibilityScore）：
 * - 基于情感健康度 = 正面占比 × 权重 - 负面占比 × 权重 + 平台覆盖修正
 * - 命中率高但负面情感多 → 低分（品牌形象受损）
 * - 命中率高且正面情感占主导 → 高分
 * - 负面情感超过 30% → 直接降至 40 分以下（预警级别）
 */
async function analyzeBrandShard(
  allRecords: any[],
  brandMatchedRecords: any[],
  brandKeywords: string[],
  userId: string,
  platformBreakdown: any[],
  sourcePlatforms: string[]
): Promise<BrandShardAnalysis> {
  const totalRecordCount = allRecords.length;
  const brandMatchedCount = brandMatchedRecords.length;

  // 获取 AEO 专用模型
  const modelConfig = await getAeoModelConfig(userId);
  const hasLlm = modelConfig && modelConfig.api_key_encrypted;

  // 命中记录的内容样本（传给 LLM 做深度情感分析）
  // v2.4.7：优化输入规模避免 LLM 超时
  //   原参数：30 条 × 3000 字符 ≈ 90k 字符（≈ 30k tokens），易导致 LLM 60s 超时
  //   优化后：15 条 × 1500 字符 ≈ 22k 字符（≈ 8k tokens），缩短响应时间
  //   均匀采样：从命中记录中等间距取样，避免只看前几条导致偏倚
  const sampleSize = Math.min(15, brandMatchedRecords.length);
  const step = Math.max(1, Math.floor(brandMatchedRecords.length / sampleSize));
  const sampledRecords: any[] = [];
  for (let i = 0; i < brandMatchedRecords.length && sampledRecords.length < sampleSize; i += step) {
    sampledRecords.push(brandMatchedRecords[i]);
  }
  const analysisInput = sampledRecords.map(r => ({
    platform: r.platform,
    keyword: r.keyword,
    content: (r.raw_content || '').substring(0, 1500),
    matchedBrands: r.matched_brands,
    shareUrl: r.share_url,
  }));

  // 负面发现（关键词匹配兜底，LLM 成功时会被 LLM 输出覆盖）
  // v2.4.7：改进关键词列表，避免误匹配
  //   原关键词 '差','问题' 等会匹配到 "差异化"、"问题解决"、"没问题" 等正常内容
  //   改用更精确的组合词或短语，减少误报
  const negativeWords = ['差评', '不好', '缺点', '不足', '缺陷', '不满', '失望', '垃圾', '骗子', '不推荐', '踩雷', '避雷', '投诉', '维权', '质量差', '服务差', '态度差', '虚假', '夸大'];
  const negativeFindings = brandMatchedRecords
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

  const brandMentions = brandMatchedRecords.map(r => ({
    keyword: r.keyword,
    platform: r.platform,
    matchedBrands: r.matched_brands,
    shareUrl: r.share_url,
    contentPreview: (r.raw_content || '').substring(0, 200),
  }));

  if (!hasLlm || brandMatchedCount === 0) {
    // 无 LLM 或无命中记录：用 fallback 简单分析
    console.warn(`[AEO-Brand] 用户 ${userId} ${!hasLlm ? '未配置 AEO 模型' : '无品牌命中记录'}，品牌词分片使用 fallback 分析`);
    const fallbackSentiment = fallbackAnalysis(allRecords, brandKeywords);
    return {
      ...fallbackSentiment,
      sentimentDimensions: {
        trust: 50,
        professionalism: 50,
        recommendation_intent: 50,
        value_perception: 50,
        brand_recall: brandMatchedCount > 0 ? 70 : 0,
        dimension_notes: '未配置 AEO 模型或无命中记录，使用默认中性评分。请配置 AEO 模型（use_for_aeo=true）以获得深度情感分析。',
      },
      brandMentions,
      negativeFindings,
      sentimentSummary: {
        total: totalRecordCount,
        brand_matched: brandMatchedCount,
        positive: Math.round(brandMatchedCount * fallbackSentiment.positiveRatio / 100),
        neutral: (totalRecordCount - brandMatchedCount) + Math.round(brandMatchedCount * fallbackSentiment.neutralRatio / 100),
        negative: Math.round(brandMatchedCount * fallbackSentiment.negativeRatio / 100),
        positiveRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * fallbackSentiment.positiveRatio / 100) / totalRecordCount * 100 : 0),
        neutralRatio: Math.round(((totalRecordCount - brandMatchedCount) + brandMatchedCount * fallbackSentiment.neutralRatio / 100) / totalRecordCount * 100),
        negativeRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * fallbackSentiment.negativeRatio / 100) / totalRecordCount * 100 : 0),
        platform_coverage: `${sourcePlatforms.length}个平台查询，${platformBreakdown.filter(p => p.brand_matched > 0).length}个平台命中`,
        analysis_mode: 'brand_fallback',
      },
    };
  }

  // 有 LLM：调用大模型做深度情感分析
  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO-Brand] API-KEY 解密失败:`, e.message);
    const fallback = fallbackAnalysis(allRecords, brandKeywords);
    return { ...fallback, sentimentDimensions: { trust: 50, professionalism: 50, recommendation_intent: 50, value_perception: 50, brand_recall: 70, dimension_notes: 'API-KEY 解密失败' }, brandMentions, negativeFindings, sentimentSummary: { total: totalRecordCount, brand_matched: brandMatchedCount, analysis_mode: 'brand_fallback' } };
  }

  const platformSummary = platformBreakdown.map(p => `${p.platform}: 查询${p.total}条/命中${p.brand_matched}条`).join('；');

  // v2.4.7：LLM prompt 重构
  //   1. 增加 negativeFindings 字段，让 LLM 真正理解内容后输出负面发现（带分类标签和说明）
  //      覆盖原 fallback 的简单关键词匹配（原匹配 '差'/'问题' 会误报"差异化"/"问题解决"等正常内容）
  //   2. 明确要求 LLM 必须阅读每条记录内容后再下结论，禁止仅凭关键词匹配下标签
  //   3. 增加 problemType 枚举值，让 LLM 用预定义的分类标签
  const prompt = `你是品牌情感分析专家。这是一个品牌词任务的分片报告 —— 查询词本身就包含品牌名，因此 AI 几乎必然提及品牌，命中率不是有意义的指标。
你的任务是深度分析 AI 回答中对品牌的情感态度和多维度评价。

品牌关键词：${brandKeywords.join('、')}
本分片查询了 ${totalRecordCount} 条记录，其中 ${brandMatchedCount} 条命中品牌（均匀采样 ${analysisInput.length} 条供你分析）。
平台分布：${platformSummary}

【命中记录详情】（请仔细阅读每条记录的实际内容，理解 AI 对品牌的评价态度。禁止仅凭关键词匹配下结论）
${JSON.stringify(analysisInput, null, 2)}

请返回 JSON 格式（不要 markdown 代码块）：
{
  "visibilityScore": 0-100的整数,        // 情感健康度评分 = 正面情感强度 - 负面情感强度 + 平台覆盖修正
  "positiveRatio": 0-100的数字,          // 正面情感占比（基于命中记录内容深度分析）
  "neutralRatio": 0-100的数字,           // 中性情感占比
  "negativeRatio": 0-100的数字,          // 负面情感占比
  "competitorAnalysis": "竞品分析文本",
  "suggestions": "数据分析结论",          // 3-5条，重点分析：1)品牌情感健康度 2)各维度情感表现 3)负面舆情风险 4)各平台情感差异
  "sentimentDimensions": {
    "trust": 0-100,                       // 信任度：AI 回答中是否体现品牌可靠、可信
    "professionalism": 0-100,             // 专业度：AI 是否认为品牌专业、权威
    "recommendation_intent": 0-100,       // 推荐意愿：AI 是否倾向于推荐该品牌
    "value_perception": 0-100,            // 性价比感知：AI 对品牌性价比的评价
    "brand_recall": 0-100,                // 品牌认知度：AI 对品牌的了解程度（信息丰富度）
    "dimension_notes": "各维度评分依据说明"
  },
  "negativeFindings": [                   // 负面发现：必须基于实际内容理解，不要仅凭关键词匹配
    {
      "keyword": "对应的查询关键词",
      "platform": "对应的AI平台",
      "problemType": "问题分类，从以下枚举中选：质量疑虑|价格争议|服务体验|功能局限|信任风险|对比劣势|信息缺失|无负面",
      "severity": "high|medium|low",
      "contentPreview": "原文中体现负面的片段（200字以内，必须来自实际内容）",
      "description": "为什么这段内容是负面的（基于实际语义理解，不要泛泛而谈）"
    }
  ]
}

重要规则：
1. negativeFindings 必须基于实际阅读内容后的理解，不要仅凭"差"、"问题"等单个关键词就标记为负面
2. 如果内容是中性客观陈述（如"该品牌成立于2015年"），不要标记为负面
3. 如果内容是正面评价（如"性价比较高"），不要标记为负面
4. 只有内容中确实存在对品牌的批评、质疑、负面评价时才加入 negativeFindings
5. 如果所有命中记录都是中性或正面，返回空数组 []
6. problemType 必须从枚举值中选，"无负面"仅用于无可分类的情况

评分标准（visibilityScore = 情感健康度）：
- 正面情感占主导（positiveRatio > 60%）且负面 < 10% = 80-100 分
- 正面略多于负面 = 60-80 分
- 中性为主 = 40-60 分
- 负面情感超过 30% = 直接降至 40 分以下（品牌形象预警）
- 命中率高但负面多 → 低分（重点：负面舆情需立即处理）
- 负面 0% 且正面 > 70% = 90-100 分`;

  try {
    // v2.4.7：延长超时时间到 90s（原 60s 在大模型分析 15 条命中记录时易超时）
    const resp = await axios.post(
      modelConfig.base_url,
      {
        model: modelConfig.model_name,
        messages: [
          { role: 'system', content: '你是品牌情感分析专家，只返回 JSON 格式数据。重点分析 AI 回答中对品牌的多维度情感态度。必须基于实际内容理解后下结论，不要仅凭关键词匹配。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
    );

    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const positiveRatio = Math.min(100, Math.max(0, parseFloat(parsed.positiveRatio) || 0));
    const neutralRatio = Math.min(100, Math.max(0, parseFloat(parsed.neutralRatio) || 0));
    const negativeRatio = Math.min(100, Math.max(0, parseFloat(parsed.negativeRatio) || 0));

    // 品牌词评分 = 情感健康度（正面 - 负面，加权平台覆盖）
    const hitPlatformCount = platformBreakdown.filter(p => p.brand_matched > 0).length;
    const platformCoverageFactor = sourcePlatforms.length > 0 ? hitPlatformCount / sourcePlatforms.length : 0;
    const sentimentHealth = positiveRatio - negativeRatio * 1.5; // 负面权重更高
    let visibilityScore = Math.round(Math.max(0, Math.min(100, sentimentHealth * 0.7 + platformCoverageFactor * 30)));
    // 负面超过 30% 直接降分
    if (negativeRatio > 30) visibilityScore = Math.min(visibilityScore, 40);

    const sentimentDimensions = parsed.sentimentDimensions || {
      trust: 50, professionalism: 50, recommendation_intent: 50, value_perception: 50, brand_recall: 50, dimension_notes: 'LLM 未返回维度评分',
    };

    // v2.4.7：LLM 输出的负面发现覆盖 fallback 的简单关键词匹配
    //   原逻辑：无论 LLM 是否成功，negativeFindings 都是简单关键词匹配结果
    //   新逻辑：LLM 成功时用 LLM 输出的 negativeFindings（带分类标签和理解说明）
    //         LLM 未返回或格式错误时，回退到关键词匹配结果
    let finalNegativeFindings = negativeFindings;
    if (Array.isArray(parsed.negativeFindings)) {
      finalNegativeFindings = parsed.negativeFindings
        .filter((f: any) => f && typeof f === 'object')
        .map((f: any) => ({
          keyword: String(f.keyword || ''),
          platform: String(f.platform || ''),
          problemType: String(f.problemType || '未分类'),
          severity: String(f.severity || 'low'),
          contentPreview: String(f.contentPreview || '').substring(0, 300),
          description: String(f.description || ''),
          // 兼容前端展示：negativeWords 字段保留关键词标签（用 problemType 替代）
          negativeWords: f.problemType && f.problemType !== '无负面' ? [String(f.problemType)] : [],
        }));
      console.log(`[AEO-Brand] 分片负面发现：LLM 输出 ${finalNegativeFindings.length} 条（覆盖 fallback 的 ${negativeFindings.length} 条关键词匹配）`);
    }

    return {
      visibilityScore,
      positiveRatio,
      neutralRatio,
      negativeRatio,
      competitorAnalysis: String(parsed.competitorAnalysis || ''),
      suggestions: String(parsed.suggestions || ''),
      raw: content,
      sentimentDimensions: {
        trust: Math.min(100, Math.max(0, parseInt(sentimentDimensions.trust) || 50)),
        professionalism: Math.min(100, Math.max(0, parseInt(sentimentDimensions.professionalism) || 50)),
        recommendation_intent: Math.min(100, Math.max(0, parseInt(sentimentDimensions.recommendation_intent) || 50)),
        value_perception: Math.min(100, Math.max(0, parseInt(sentimentDimensions.value_perception) || 50)),
        brand_recall: Math.min(100, Math.max(0, parseInt(sentimentDimensions.brand_recall) || 50)),
        dimension_notes: String(sentimentDimensions.dimension_notes || ''),
      },
      brandMentions,
      negativeFindings: finalNegativeFindings,
      sentimentSummary: {
        total: totalRecordCount,
        brand_matched: brandMatchedCount,
        positive: Math.round(brandMatchedCount * positiveRatio / 100),
        neutral: (totalRecordCount - brandMatchedCount) + Math.round(brandMatchedCount * neutralRatio / 100),
        negative: Math.round(brandMatchedCount * negativeRatio / 100),
        positiveRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * positiveRatio / 100) / totalRecordCount * 100 : 0),
        neutralRatio: Math.round(((totalRecordCount - brandMatchedCount) + brandMatchedCount * neutralRatio / 100) / totalRecordCount * 100),
        negativeRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * negativeRatio / 100) / totalRecordCount * 100 : 0),
        platform_coverage: `${sourcePlatforms.length}个平台查询，${hitPlatformCount}个平台命中`,
        analysis_mode: 'brand_deep_sentiment',
      },
    };
  } catch (e: any) {
    console.error(`[AEO-Brand] LLM 调用失败:`, e.message, e?.response?.status, e?.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : '');
    const fallback = fallbackAnalysis(allRecords, brandKeywords);
    return { ...fallback, sentimentDimensions: { trust: 50, professionalism: 50, recommendation_intent: 50, value_perception: 50, brand_recall: 70, dimension_notes: 'LLM 调用失败，使用 fallback' }, brandMentions, negativeFindings, sentimentSummary: { total: totalRecordCount, brand_matched: brandMatchedCount, analysis_mode: 'brand_fallback' } };
  }
}

/**
 * 蒸馏词任务分片分析管道（keyword_type=0）
 *
 * 特点：查询词是行业通用词（如"公司注册流程"），AI 是否提及品牌才真实反映 GEO 可见度。
 * 命中率是这个管道的核心指标，直接反映品牌在 AI 回答中的出现概率。
 *
 * 评分标准（visibilityScore）：
 * - 基于提及率 × 平台覆盖均衡度
 * - 提及率 100% 且覆盖所有平台 = 90-100 分
 * - 提及率 50% 且覆盖多数平台 = 50-70 分
 * - 提及率 0% = 0 分
 * - 只在单一平台命中（其他全未命中）应扣分（GEO 目标是全平台覆盖）
 */
async function analyzeDistillateShard(
  allRecords: any[],
  brandMatchedRecords: any[],
  brandKeywords: string[],
  userId: string,
  platformBreakdown: any[],
  keywordCoverage: any[],
  sourcePlatforms: string[]
): Promise<DistillateShardAnalysis> {
  const totalRecordCount = allRecords.length;
  const brandMatchedCount = brandMatchedRecords.length;
  const hitRate = totalRecordCount > 0 ? Math.round((brandMatchedCount / totalRecordCount) * 10000) / 100 : 0;

  // 未命中品牌的关键词列表（覆盖盲区）
  const uncoveredKeywords = keywordCoverage
    .filter(k => k.brand_matched === 0)
    .map(k => k.keyword)
    .slice(0, 50);

  // 各平台提及率
  const platformMentionRates = platformBreakdown.map(p => ({
    platform: p.platform,
    total: p.total,
    mentioned: p.brand_matched,
    rate: p.brand_rate,
  }));

  // 跨平台一致性：各平台提及率的标准差越小，一致性越高
  const rates = platformMentionRates.map(p => p.rate);
  const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const variance = rates.length > 0 ? rates.reduce((sum, r) => sum + Math.pow(r - avgRate, 2), 0) / rates.length : 0;
  const stdDev = Math.sqrt(variance);
  const crossPlatformConsistency = Math.max(0, Math.min(100, Math.round(100 - stdDev)));

  const brandMentions = brandMatchedRecords.map(r => ({
    keyword: r.keyword,
    platform: r.platform,
    matchedBrands: r.matched_brands,
    shareUrl: r.share_url,
    contentPreview: (r.raw_content || '').substring(0, 200),
  }));

  // v2.4.7：改进负面发现关键词列表，避免误匹配（同品牌词管道修复）
  const negativeWords = ['差评', '不好', '缺点', '不足', '缺陷', '不满', '失望', '垃圾', '骗子', '不推荐', '踩雷', '避雷', '投诉', '维权', '质量差', '服务差', '态度差', '虚假', '夸大'];
  const negativeFindings = brandMatchedRecords
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

  // 蒸馏词评分 = 提及率 × 0.6 + 平台覆盖均衡度 × 0.4
  const hitPlatformCount = platformBreakdown.filter(p => p.brand_matched > 0).length;
  const platformBalance = sourcePlatforms.length > 0 ? hitPlatformCount / sourcePlatforms.length : 0;
  const visibilityScore = Math.round(hitRate * 0.6 + platformBalance * 100 * 0.4);

  // 获取 AEO 模型（可选，蒸馏词管道即使无 LLM 也能生成有意义的提及率分析）
  const modelConfig = await getAeoModelConfig(userId);
  const hasLlm = modelConfig && modelConfig.api_key_encrypted;

  if (!hasLlm || brandMatchedCount === 0) {
    // 无 LLM 或无命中：用纯代码分析（蒸馏词管道的核心指标是提及率，不依赖 LLM）
    const coverageGaps = uncoveredKeywords.length > 0
      ? `共 ${uncoveredKeywords.length} 个关键词未命中品牌，占关键词总数的 ${keywordCoverage.length > 0 ? Math.round(uncoveredKeywords.length / keywordCoverage.length * 100) : 0}%。这些关键词是 GEO 优化的重点方向。`
      : '所有关键词均命中品牌，覆盖完整。';

    return {
      visibilityScore,
      positiveRatio: 0,
      neutralRatio: brandMatchedCount > 0 ? 100 : 0,
      negativeRatio: 0,
      competitorAnalysis: brandMatchedCount > 0 ? `在 ${hitPlatformCount}/${sourcePlatforms.length} 个平台获得 ${brandMatchedCount} 次品牌提及` : '无品牌命中',
      suggestions: `1. 提及率 ${hitRate}%（${brandMatchedCount}/${totalRecordCount}），${hitRate > 50 ? 'GEO 可见度良好' : hitRate > 20 ? 'GEO 可见度有待提升' : 'GEO 可见度较低，需加强优化'}\n2. 平台覆盖：${hitPlatformCount}/${sourcePlatforms.length} 个平台命中\n3. ${coverageGaps}\n4. 跨平台一致性 ${crossPlatformConsistency}%（${crossPlatformConsistency > 70 ? '各平台提及率较均衡' : '各平台提及率差异较大，需针对性优化'}`,
      raw: JSON.stringify({ fallback: true, hit_rate: hitRate, platform_balance: platformBalance, uncovered: uncoveredKeywords.length }),
      mentionAnalysis: {
        platform_mention_rates: platformMentionRates,
        uncovered_keywords: uncoveredKeywords,
        coverage_gaps: coverageGaps,
        cross_platform_consistency: crossPlatformConsistency,
        mention_notes: '未配置 AEO 模型或无命中记录，使用纯代码提及率分析。配置 AEO 模型可获得更深入的内容分析。',
      },
      brandMentions,
      negativeFindings,
      sentimentSummary: {
        total: totalRecordCount,
        brand_matched: brandMatchedCount,
        positive: 0,
        neutral: totalRecordCount,
        negative: 0,
        positiveRatio: 0,
        neutralRatio: 100,
        negativeRatio: 0,
        platform_coverage: `${sourcePlatforms.length}个平台查询，${hitPlatformCount}个平台命中`,
        hit_rate: hitRate,
        analysis_mode: 'distillate_code_analysis',
      },
    };
  }

  // 有 LLM：调用大模型做提及率+内容综合分析
  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO-Distillate] API-KEY 解密失败:`, e.message);
    return {
      visibilityScore,
      positiveRatio: 0, neutralRatio: 100, negativeRatio: 0,
      competitorAnalysis: '', suggestions: '', raw: 'API-KEY 解密失败',
      mentionAnalysis: { platform_mention_rates: platformMentionRates, uncovered_keywords: uncoveredKeywords, coverage_gaps: '', cross_platform_consistency: crossPlatformConsistency, mention_notes: 'API-KEY 解密失败' },
      brandMentions, negativeFindings,
      sentimentSummary: { total: totalRecordCount, brand_matched: brandMatchedCount, hit_rate: hitRate, analysis_mode: 'distillate_code_analysis' },
    };
  }

  // v2.4.7：优化 LLM 输入规模（原 20 条 × 2000 字符 ≈ 40k 字符，易超时）
  //   改为均匀采样 15 条 × 1500 字符 ≈ 22k 字符
  const sampleSize = Math.min(15, brandMatchedRecords.length);
  const step = Math.max(1, Math.floor(brandMatchedRecords.length / sampleSize));
  const sampledRecords: any[] = [];
  for (let i = 0; i < brandMatchedRecords.length && sampledRecords.length < sampleSize; i += step) {
    sampledRecords.push(brandMatchedRecords[i]);
  }
  const analysisInput = sampledRecords.map(r => ({
    platform: r.platform,
    keyword: r.keyword,
    content: (r.raw_content || '').substring(0, 1500),
    matchedBrands: r.matched_brands,
  }));

  const prompt = `你是 AEO（Answer Engine Optimization）分析师。这是一个蒸馏词任务的分片报告 —— 查询词是行业通用词（非品牌词），AI 是否提及品牌才真实反映品牌的 GEO 可见度。
命中率（提及率）是这个报告的核心指标。请重点分析提及率、平台覆盖和盲区。

品牌关键词：${brandKeywords.join('、')}
本分片查询了 ${totalRecordCount} 条记录，其中 ${brandMatchedCount} 条命中品牌，提及率 ${hitRate}%（均匀采样 ${analysisInput.length} 条供你分析）。
平台分布：${platformMentionRates.map(p => `${p.platform}: ${p.mentioned}/${p.total}(${p.rate}%)`).join('；')}
未命中关键词数：${uncoveredKeywords.length}

【命中记录详情】（请仔细阅读每条记录的实际内容，理解 AI 是否提及品牌及提及态度。禁止仅凭关键词匹配下结论）
${JSON.stringify(analysisInput, null, 2)}

请返回 JSON 格式（不要 markdown 代码块）：
{
  "visibilityScore": 0-100的整数,        // 提及率 × 平台覆盖均衡度（评分标准见下）
  "positiveRatio": 0-100的数字,          // 命中记录中的正面情感占比
  "neutralRatio": 0-100的数字,
  "negativeRatio": 0-100的数字,
  "competitorAnalysis": "竞品分析文本",
  "suggestions": "数据分析结论",          // 3-5条，重点分析：1)提及率水平 2)各平台覆盖差异 3)未命中关键词盲区 4)与 GEO 目标的差距
  "mentionAnalysis": {
    "coverage_gaps": "覆盖盲区说明",       // 详细说明哪些关键词/平台是 GEO 优化盲区
    "cross_platform_consistency": 0-100,  // 跨平台一致性评分
    "mention_notes": "提及率分析说明"       // 对提及率的深度解读
  },
  "negativeFindings": [                   // 负面发现：必须基于实际内容理解，不要仅凭关键词匹配
    {
      "keyword": "对应的查询关键词",
      "platform": "对应的AI平台",
      "problemType": "问题分类，从以下枚举中选：质量疑虑|价格争议|服务体验|功能局限|信任风险|对比劣势|信息缺失|无负面",
      "severity": "high|medium|low",
      "contentPreview": "原文中体现负面的片段（200字以内，必须来自实际内容）",
      "description": "为什么这段内容是负面的（基于实际语义理解，不要泛泛而谈）"
    }
  ]
}

重要规则：
1. negativeFindings 必须基于实际阅读内容后的理解，不要仅凭"差"、"问题"等单个关键词就标记为负面
2. 如果内容是中性客观陈述，不要标记为负面
3. 如果内容是正面评价，不要标记为负面
4. 只有内容中确实存在对品牌的批评、质疑、负面评价时才加入 negativeFindings
5. 如果所有命中记录都是中性或正面，返回空数组 []

评分标准（visibilityScore = 提及率 × 平台覆盖）：
- 提及率 100% 且覆盖所有平台 = 90-100 分
- 提及率 50% 且覆盖多数平台 = 50-70 分
- 提及率 0% = 0 分
- 只在单一平台命中（其他全未命中）应扣分，因为 GEO 目标是全平台覆盖`;

  try {
    // v2.4.7：延长超时时间到 90s
    const resp = await axios.post(
      modelConfig.base_url,
      {
        model: modelConfig.model_name,
        messages: [
          { role: 'system', content: '你是 AEO 分析专家，只返回 JSON 格式数据。重点分析提及率和平台覆盖。必须基于实际内容理解后下结论，不要仅凭关键词匹配。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
    );

    const content = (resp.data as any)?.choices?.[0]?.message?.content || '';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const positiveRatio = Math.min(100, Math.max(0, parseFloat(parsed.positiveRatio) || 0));
    const neutralRatio = Math.min(100, Math.max(0, parseFloat(parsed.neutralRatio) || 0));
    const negativeRatio = Math.min(100, Math.max(0, parseFloat(parsed.negativeRatio) || 0));

    // 蒸馏词评分 = 提及率 × 0.6 + 平台覆盖均衡度 × 0.4（以代码计算为准，LLM 评分仅参考）
    const finalVisibilityScore = visibilityScore;

    const mentionAnalysisParsed = parsed.mentionAnalysis || {};

    // v2.4.7：LLM 输出的负面发现覆盖 fallback 的简单关键词匹配（同品牌词管道修复）
    let finalNegativeFindings = negativeFindings;
    if (Array.isArray(parsed.negativeFindings)) {
      finalNegativeFindings = parsed.negativeFindings
        .filter((f: any) => f && typeof f === 'object')
        .map((f: any) => ({
          keyword: String(f.keyword || ''),
          platform: String(f.platform || ''),
          problemType: String(f.problemType || '未分类'),
          severity: String(f.severity || 'low'),
          contentPreview: String(f.contentPreview || '').substring(0, 300),
          description: String(f.description || ''),
          negativeWords: f.problemType && f.problemType !== '无负面' ? [String(f.problemType)] : [],
        }));
      console.log(`[AEO-Distillate] 分片负面发现：LLM 输出 ${finalNegativeFindings.length} 条（覆盖 fallback 的 ${negativeFindings.length} 条关键词匹配）`);
    }

    return {
      visibilityScore: finalVisibilityScore,
      positiveRatio,
      neutralRatio,
      negativeRatio,
      competitorAnalysis: String(parsed.competitorAnalysis || ''),
      suggestions: String(parsed.suggestions || ''),
      raw: content,
      mentionAnalysis: {
        platform_mention_rates: platformMentionRates,
        uncovered_keywords: uncoveredKeywords,
        coverage_gaps: String(mentionAnalysisParsed.coverage_gaps || (uncoveredKeywords.length > 0 ? `共 ${uncoveredKeywords.length} 个关键词未命中品牌` : '所有关键词均命中品牌')),
        cross_platform_consistency: Math.min(100, Math.max(0, parseInt(mentionAnalysisParsed.cross_platform_consistency) || crossPlatformConsistency)),
        mention_notes: String(mentionAnalysisParsed.mention_notes || ''),
      },
      brandMentions,
      negativeFindings: finalNegativeFindings,
      sentimentSummary: {
        total: totalRecordCount,
        brand_matched: brandMatchedCount,
        positive: Math.round(brandMatchedCount * positiveRatio / 100),
        neutral: (totalRecordCount - brandMatchedCount) + Math.round(brandMatchedCount * neutralRatio / 100),
        negative: Math.round(brandMatchedCount * negativeRatio / 100),
        positiveRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * positiveRatio / 100) / totalRecordCount * 100 : 0),
        neutralRatio: Math.round(((totalRecordCount - brandMatchedCount) + brandMatchedCount * neutralRatio / 100) / totalRecordCount * 100),
        negativeRatio: Math.round(brandMatchedCount > 0 ? (brandMatchedCount * negativeRatio / 100) / totalRecordCount * 100 : 0),
        platform_coverage: `${sourcePlatforms.length}个平台查询，${hitPlatformCount}个平台命中`,
        hit_rate: hitRate,
        analysis_mode: 'distillate_llm_analysis',
      },
    };
  } catch (e: any) {
    console.error(`[AEO-Distillate] LLM 调用失败:`, e.message, e?.response?.status, e?.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : '');
    // LLM 失败时回退到纯代码分析（蒸馏词管道的核心指标是提及率，代码计算即可）
    return {
      visibilityScore,
      positiveRatio: 0, neutralRatio: 100, negativeRatio: 0,
      competitorAnalysis: '', suggestions: `提及率 ${hitRate}%（${brandMatchedCount}/${totalRecordCount}），平台覆盖 ${hitPlatformCount}/${sourcePlatforms.length}`,
      raw: JSON.stringify({ fallback: true, llm_error: e.message }),
      mentionAnalysis: {
        platform_mention_rates: platformMentionRates,
        uncovered_keywords: uncoveredKeywords,
        coverage_gaps: uncoveredKeywords.length > 0 ? `共 ${uncoveredKeywords.length} 个关键词未命中品牌` : '所有关键词均命中品牌',
        cross_platform_consistency: crossPlatformConsistency,
        mention_notes: 'LLM 调用失败，使用纯代码提及率分析',
      },
      brandMentions, negativeFindings,
      sentimentSummary: { total: totalRecordCount, brand_matched: brandMatchedCount, hit_rate: hitRate, analysis_mode: 'distillate_code_analysis' },
    };
  }
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
 * @param options.force 是否强制重新生成（删除旧报告后重新分析）
 * @returns 报告 ID（失败返回 null）
 */
export async function generateAeoShardReport(
  queueId: number,
  options?: { force?: boolean }
): Promise<number | null> {
  try {
    // 1. 检查是否已生成过报告（避免重复分析）
    // v2.4.7：options.force=true 时先删除旧报告再重新分析
    //   场景：分片报告因 LLM 调用失败或字段名 bug 导致数据错误，需重新生成
    if (options?.force) {
      const deleted = await deleteAeoShardReportByQueueId(queueId);
      if (deleted > 0) {
        console.log(`[AEO-Shard] 分片 ${queueId} 强制重新生成：已删除旧报告（${deleted} 条）`);
      }
    } else {
      const exists = await checkShardReportExists(queueId);
      if (exists) {
        console.log(`[AEO-Shard] 分片 ${queueId} 已有报告，跳过`);
        return null;
      }
    }

    // 2. 获取分片队列信息（v2.1.6：含 keyword_type 和 task_name）
    const queueInfo = await getQueueInfoForShardReport(queueId);
    if (!queueInfo) {
      console.log(`[AEO-Shard] 分片 ${queueId} 队列信息不存在`);
      return null;
    }

    // 仅对成功完成的分片进行分析
    if (queueInfo.status !== 'done') {
      console.log(`[AEO-Shard] 分片 ${queueId} 状态非 done（${queueInfo.status}），跳过`);
      return null;
    }

    // 3. 确定分片时间窗口
    // v2.1.6：修复 start_time=null 导致时间窗口计算错误的问题
    // 优先级：start_time > create_time > now-2h
    // end_time 优先级：end_time > create_time+2h > now
    const queueCreateTime = queueInfo.create_time ? new Date(queueInfo.create_time) : null;
    const startTime = queueInfo.start_time
      ? new Date(queueInfo.start_time)
      : queueCreateTime
        ? new Date(queueCreateTime.getTime() - 10 * 60 * 1000) // create_time 前10分钟兜底
        : new Date(Date.now() - 2 * 60 * 60 * 1000);
    const endTime = queueInfo.end_time
      ? new Date(queueInfo.end_time)
      : queueCreateTime
        ? new Date(queueCreateTime.getTime() + 2 * 60 * 60 * 1000) // create_time 后2小时兜底
        : new Date();

    const userId = queueInfo.user_id || '';
    const keywordType = queueInfo.keyword_type ?? 0; // 0=蒸馏词, 1=品牌词

    // v2.1.6：优先用 queue_id 精确查询分片记录（新记录），fallback 到时间窗口（旧记录）
    // 这样解决同任务多分片同时执行时时间窗口重叠导致记录串分片的问题
    let allRecords = await getRecordsByQueueId(queueId);
    if (allRecords.length === 0) {
      // 旧记录无 queue_id，fallback 到时间窗口查询
      console.log(`[AEO-Shard] 分片 ${queueId} 无 queue_id 关联记录，fallback 到时间窗口查询 (task=${queueInfo.task_id}, start=${startTime.toISOString()}, end=${endTime.toISOString()})`);
      allRecords = await getAllRecordsByTimeWindow(queueInfo.task_id, startTime, endTime);
    }

    // v2.1.6：如果时间窗口也查不到，查询该任务最近 N 条记录作为兜底
    // 解决记录被清理或 query_time 时区问题导致查不到的情况
    if (allRecords.length === 0) {
      console.warn(`[AEO-Shard] 分片 ${queueId} 时间窗口内无记录，查询任务 ${queueInfo.task_id} 最近记录作为兜底`);
      // 查该任务是否有任何记录
      const { query: dbQuery } = await import('../../db');
      const statsResult = await dbQuery(
        `SELECT COUNT(*) as total, MIN(query_time) as min_time, MAX(query_time) as max_time,
                MIN(create_time) as min_create, MAX(create_time) as max_create
         FROM real_collect_record WHERE task_id = $1`,
        [queueInfo.task_id]
      );
      const stats = statsResult.rows[0] || {};
      console.warn(`[AEO-Shard] 任务 ${queueInfo.task_id} 记录统计: total=${stats.total}, query_time范围=${stats.min_time}~${stats.max_time}, create_time范围=${stats.min_create}~${stats.max_create}`);

      // v2.1.6：如果任务有记录，取该分片 end_time 前后最近的 N 条记录作为兜底
      // 这样即使时间窗口对不上，也能基于该任务最近的数据生成报告
      if (Number(stats.total) > 0) {
        const { rows: recentRecords } = await dbQuery(
          `SELECT id, task_id, user_id, keyword, platform, brand_matched, matched_brands,
                  share_url, raw_content, query_time, create_time
           FROM real_collect_record
           WHERE task_id = $1
           ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(query_time, create_time) - $2)))
           LIMIT 50`,
          [queueInfo.task_id, endTime]
        );
        if (recentRecords.length > 0) {
          console.warn(`[AEO-Shard] 分片 ${queueId} 使用任务 ${queueInfo.task_id} 最近 ${recentRecords.length} 条记录作为兜底`);
          allRecords = recentRecords;
        }
      }
    }

    // 如果连任何记录都没有，说明分片没有产出查询结果，才真正跳过
    if (allRecords.length === 0) {
      console.log(`[AEO-Shard] 分片 ${queueId} 时间窗口内无任何查询记录，跳过`);
      return null;
    }

    // 4. 获取品牌词，从全量记录中识别品牌命中
    const brandKeywords = await getBrandKeywords(userId);
    const brandKeywordSet = new Set(brandKeywords.map(k => k.toLowerCase()));
    const brandMatchedRecords = allRecords.filter(r => r.brand_matched === true);

    const hasBrandMatch = brandMatchedRecords.length > 0;
    const totalRecordCount = allRecords.length;
    const brandMatchedCount = brandMatchedRecords.length;
    const hitRate = totalRecordCount > 0
      ? Math.round((brandMatchedCount / totalRecordCount) * 10000) / 100
      : 0;

    // 5. v2.1.6：构建多维度数据
    // (a) platform_breakdown：各AI平台的查询数/品牌命中数
    const platformMap: Record<string, { total: number; brand_matched: number }> = {};
    for (const r of allRecords) {
      const p = r.platform || 'unknown';
      if (!platformMap[p]) platformMap[p] = { total: 0, brand_matched: 0 };
      platformMap[p].total++;
      if (r.brand_matched === true) platformMap[p].brand_matched++;
    }
    const platformBreakdown = Object.entries(platformMap).map(([platform, stat]) => ({
      platform,
      total: stat.total,
      brand_matched: stat.brand_matched,
      brand_rate: stat.total > 0 ? Math.round((stat.brand_matched / stat.total) * 10000) / 100 : 0,
    })).sort((a, b) => b.total - a.total);

    // (b) keyword_coverage：关键词覆盖详情（关键词列表+命中情况）
    const keywordMap: Record<string, { total: number; brand_matched: number; platforms: Set<string> }> = {};
    for (const r of allRecords) {
      const kw = r.keyword || '';
      if (!kw) continue;
      if (!keywordMap[kw]) keywordMap[kw] = { total: 0, brand_matched: 0, platforms: new Set() };
      keywordMap[kw].total++;
      if (r.brand_matched === true) keywordMap[kw].brand_matched++;
      if (r.platform) keywordMap[kw].platforms.add(r.platform);
    }
    const keywordCoverage = Object.entries(keywordMap).map(([keyword, stat]) => ({
      keyword,
      total: stat.total,
      brand_matched: stat.brand_matched,
      hit_rate: stat.total > 0 ? Math.round((stat.brand_matched / stat.total) * 10000) / 100 : 0,
      platforms: Array.from(stat.platforms),
    })).sort((a, b) => b.total - a.total);

    // (c) source_platforms：本分片查询的AI平台列表（去重）
    const sourcePlatforms = Array.from(new Set(allRecords.map(r => r.platform).filter(Boolean)));

    // (d) share_urls：分享链接列表（用于详情查看）
    const shareUrls = allRecords
      .filter(r => r.share_url)
      .map(r => ({
        keyword: r.keyword,
        platform: r.platform,
        share_url: r.share_url,
        brand_matched: r.brand_matched === true,
      }))
      .slice(0, 50); // 限制最多50条避免过大

    // (e) raw_contents_sample：AI回答内容样本（前10条，供日报/周报LLM分析用）
    const rawContentsSample = allRecords
      .slice(0, 10)
      .map(r => ({
        keyword: r.keyword,
        platform: r.platform,
        content: (r.raw_content || '').substring(0, 1000),
        brand_matched: r.brand_matched === true,
        matched_brands: r.matched_brands,
      }));

    // (f) competitor_mentions：竞品在AI回答中的出现情况
    // 从品牌命中记录中提取非自身品牌的实体（matched_brands 中非自身品牌的字符串）
    const competitorMentions: any[] = [];
    if (hasBrandMatch && brandKeywords.length > 0) {
      const competitorMap: Record<string, { count: number; platforms: Set<string>; keywords: Set<string> }> = {};
      for (const r of brandMatchedRecords) {
        const matchedBrands: string[] = Array.isArray(r.matched_brands) ? r.matched_brands : [];
        for (const brand of matchedBrands) {
          const lowerBrand = (brand || '').toLowerCase();
          // 非自身品牌 = 竞品
          if (lowerBrand && !brandKeywordSet.has(lowerBrand)) {
            if (!competitorMap[brand]) competitorMap[brand] = { count: 0, platforms: new Set(), keywords: new Set() };
            competitorMap[brand].count++;
            if (r.platform) competitorMap[brand].platforms.add(r.platform);
            if (r.keyword) competitorMap[brand].keywords.add(r.keyword);
          }
        }
      }
      for (const [competitor, stat] of Object.entries(competitorMap)) {
        competitorMentions.push({
          competitor,
          mention_count: stat.count,
          platforms: Array.from(stat.platforms),
          keywords: Array.from(stat.keywords),
        });
      }
      competitorMentions.sort((a, b) => b.mention_count - a.mention_count);
    }

    // v2.1.9：按 keyword_type 分流到不同分析管道
    // - 品牌词任务（keyword_type=1）：深度情感分析，评分基于情感健康度
    // - 蒸馏词任务（keyword_type=0）：提及率分析，评分基于提及率 × 平台覆盖
    let analysisResult: any;
    let sentimentDimensions: any = null;
    let mentionAnalysis: any = null;

    if (keywordType === 1) {
      // ===== 品牌词任务管道：深度情感分析 =====
      const brandAnalysis = await analyzeBrandShard(
        allRecords, brandMatchedRecords, brandKeywords, userId, platformBreakdown, sourcePlatforms
      );
      analysisResult = brandAnalysis;
      sentimentDimensions = brandAnalysis.sentimentDimensions;
      console.log(`[AEO-Shard] 分片 ${queueId} 使用品牌词管道（深度情感分析），情感健康度=${brandAnalysis.visibilityScore}`);
    } else {
      // ===== 蒸馏词任务管道：提及率分析 =====
      const distillateAnalysis = await analyzeDistillateShard(
        allRecords, brandMatchedRecords, brandKeywords, userId, platformBreakdown, keywordCoverage, sourcePlatforms
      );
      analysisResult = distillateAnalysis;
      mentionAnalysis = distillateAnalysis.mentionAnalysis;
      console.log(`[AEO-Shard] 分片 ${queueId} 使用蒸馏词管道（提及率分析），提及率=${hitRate}%，可见度=${distillateAnalysis.visibilityScore}`);
    }

    // 入库（v2.1.6：含多维度扩展字段；v2.1.9：含 sentiment_dimensions/mention_analysis）
    const reportId = await insertAeoShardReport({
      task_id: queueInfo.task_id,
      queue_id: queueId,
      user_id: userId,
      round_no: queueInfo.round_no,
      shard_keywords: queueInfo.keywords,
      sentiment_summary: analysisResult.sentimentSummary,
      brand_mentions: analysisResult.brandMentions,
      negative_findings: analysisResult.negativeFindings,
      content_suggestions: analysisResult.suggestions,
      record_count: totalRecordCount,
      brand_matched_count: brandMatchedCount,
      visibility_score: analysisResult.visibilityScore,
      positive_ratio: analysisResult.positiveRatio,
      negative_ratio: analysisResult.negativeRatio,
      neutral_ratio: analysisResult.neutralRatio,
      raw_analysis: { raw: analysisResult.raw, competitorAnalysis: analysisResult.competitorAnalysis },
      shard_start_time: startTime,
      shard_end_time: endTime,
      // v2.1.6：多维度扩展字段
      platform_breakdown: platformBreakdown,
      keyword_coverage: keywordCoverage,
      competitor_mentions: competitorMentions,
      source_platforms: sourcePlatforms,
      keyword_type: keywordType,
      hit_rate: hitRate,
      share_urls: shareUrls,
      raw_contents_sample: rawContentsSample,
      // v2.1.9：分离管道专属字段
      sentiment_dimensions: sentimentDimensions,
      mention_analysis: mentionAnalysis,
    });

    console.log(`[AEO-Shard] 分片 ${queueId} AEO报告已生成: reportId=${reportId}, 任务类型=${keywordType === 1 ? '品牌词(情感分析)' : '蒸馏词(提及率分析)'}, 总查询=${totalRecordCount}, 品牌命中=${brandMatchedCount}, 命中率=${hitRate}%, 可见度=${analysisResult.visibilityScore}, 平台数=${sourcePlatforms.length}, 竞品=${competitorMentions.length}`);
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

    // 5. 客户配额（v2.3.0: 统一按天配额，与建议来源周期解耦）
    const quotaConfig = await getAeoQuotaConfig(Number(userId));
    // v2.3.0：自动写作配额只按天设置，日报生成时创建 daily_article_quota 篇任务
    // 周报/月报仅沉淀写作建议，不再触发自动写作（避免与日报重复创建）
    const dailyQuota = Number(quotaConfig?.daily_article_quota) || 0;
    const legacyArticleQuota = Number(quotaConfig?.article_quota) || 0;
    const legacyCycleQuota = periodType === 'weekly'
      ? (Number(quotaConfig?.weekly_article_quota) || 0)
      : (periodType === 'monthly' ? (Number(quotaConfig?.monthly_article_quota) || 0) : 0);
    // 兼容旧配置：daily_article_quota 为 0 时，若旧字段有值则按原周期逻辑回退
    const quota = periodType === 'daily'
      ? (dailyQuota > 0 ? dailyQuota : (legacyArticleQuota > 0 ? legacyArticleQuota : legacyCycleQuota))
      : ((dailyQuota === 0 && legacyArticleQuota > 0 && quotaConfig?.quota_cycle === periodType)
          ? legacyArticleQuota
          : 0);

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

    // 11.5 写入独立建议池（v2.3.0）
    try {
      if (Array.isArray(writingSuggestions) && writingSuggestions.length > 0) {
        // v2.5.7：修复 UTC 时区 bug——原 periodStart.toISOString().slice(0,10) 用 UTC，
        //   上海凌晨 0 点生成的日报 periodStart 是前天 16:00 UTC → slice 得到前天日期
        //   （例：7/19 凌晨日报实际写入 report_date=7/17，导致前端"建议池停滞"）
        //   改用上海时区 toLocaleDateString('sv-SE') 得到正确的 YYYY-MM-DD
        const reportDateStr = periodStart.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        await insertWritingSuggestions(
          Number(userId),
          reportId,
          periodType,
          reportDateStr,
          writingSuggestions.map((s: any) => ({
            topic: String(s.topic || ''),
            reason: s.reason ? String(s.reason) : undefined,
            direction: s.direction ? String(s.direction) : undefined,
            platforms: Array.isArray(s.platforms) ? s.platforms.filter((p: any) => typeof p === 'string') : [],
            keywords: Array.isArray(s.keywords) ? s.keywords.filter((k: any) => typeof k === 'string') : [],
            priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
          }))
        );
        console.log(`[AEO-Period] 用户 ${userId} ${periodType} 报告已写入 ${writingSuggestions.length} 条独立建议`);
      }
    } catch (e: any) {
      console.warn(`[AEO-Period] 写入独立建议池失败（不阻断报告生成）:`, e.message);
    }

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

// v2.4.0：generatePeriodReportWrapper - 包装函数，在成功生成周期报告后推送事件
//   原 generatePeriodReport 返回 reportId 后调用方无法感知，这里包装一层用于事件广播
//   注意：实际调用 generatePeriodReport 的地方都需要改为调用此包装函数
export async function generatePeriodReportAndBroadcast(
  userId: string,
  periodType: 'daily' | 'weekly' | 'monthly',
  periodStart: Date,
  periodEnd: Date
): Promise<number | null> {
  const reportId = await generatePeriodReport(userId, periodType, periodStart, periodEnd);
  if (reportId) {
    // v2.4.0：推送周期报告生成完成事件
    wsBroadcast('aeo_period_report_generated', {
      reportId,
      userId,
      periodType,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    }, userId);
  }
  return reportId;
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
  // v2.1.9：按 keyword_type 分组，分别生成针对性建议再合并
  // - 品牌词报告（keyword_type=1）：侧重情感修复/优势强化，基于 sentiment_dimensions
  // - 蒸馏词报告（keyword_type=0）：侧重提及率提升/盲区覆盖，基于 mention_analysis
  const brandShardReports = shardReports.filter(sr => sr.keyword_type === 1);
  const distillateShardReports = shardReports.filter(sr => sr.keyword_type !== 1);
  console.log(`[AEO-Period] 写作建议分组: 品牌词报告 ${brandShardReports.length} 条, 蒸馏词报告 ${distillateShardReports.length} 条`);

  // 排名前3的信源平台
  const topPlatforms = Object.entries(sourceWeights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([platform]) => platform);

  // v2.0.5：从 ai_model_config 表读取 AEO 专用模型（use_for_aeo=true）
  const modelConfig = await getAeoModelConfig(userId);
  if (!modelConfig || !modelConfig.api_key_encrypted) {
    console.warn(`[AEO-Period] 用户 ${userId} 未配置 AEO 模型（use_for_aeo=true），使用规则兜底生成写作建议`);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, [], new Set());
  }

  let apiKey: string;
  try {
    apiKey = decrypt(modelConfig.api_key_encrypted);
  } catch (e: any) {
    console.error(`[AEO-Period] API-KEY 解密失败 platform=${modelConfig.platform}:`, e.message);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, [], new Set());
  }

  const apiUrl = modelConfig.base_url;
  const model = modelConfig.model_name;
  const periodLabel = periodType === 'daily' ? '日' : periodType === 'weekly' ? '周' : '月';
  console.log(`[AEO-Period] 使用模型生成写作建议: platform=${modelConfig.platform} model=${model}（分组模式）`);

  // 并行为两组报告生成建议
  const [brandSuggestions, distillateSuggestions] = await Promise.all([
    generateSuggestionsForGroup(modelConfig, apiKey, apiUrl, model, brandShardReports, periodLabel, topPlatforms, 'brand'),
    generateSuggestionsForGroup(modelConfig, apiKey, apiUrl, model, distillateShardReports, periodLabel, topPlatforms, 'distillate'),
  ]);

  // 合并建议池，每条标注来源类型
  const allSuggestions = [
    ...brandSuggestions.map(s => ({ ...s, source_type: 'brand' })),
    ...distillateSuggestions.map(s => ({ ...s, source_type: 'distillate' })),
  ];

  // v2.3.4：LLM 路径返回空时自动回退到 fallback
  //   原 bug：配置了 AEO 模型但分片为空时，generateSuggestionsForGroup 因 length===0 直接返回 []，
  //     writingSuggestions 数组为空 → 不写入 aeo_writing_suggestion 表 → 前端写作建议池永远为空
  //   修复：LLM 路径返回空时（无论是因为分片为空还是 LLM 调用失败），
  //     自动回退到 fallbackWritingSuggestions，至少产出"品牌核心优势强化"等通用建议，
  //     确保写作建议池始终有可消费内容
  if (allSuggestions.length === 0) {
    console.warn(`[AEO-Period] LLM 路径返回 0 条建议（可能因分片为空或 LLM 异常），自动回退到 fallback 生成通用建议`);
    return fallbackWritingSuggestions(shardReports, inclusionStats, topPlatforms, [], new Set());
  }

  console.log(`[AEO-Period] 写作建议生成完成: 品牌词建议 ${brandSuggestions.length} 条, 蒸馏词建议 ${distillateSuggestions.length} 条, 合计 ${allSuggestions.length} 条`);
  return allSuggestions;
}

/**
 * 为单个分组（品牌词/蒸馏词）生成写作建议
 * @param groupType 'brand' | 'distillate'
 */
async function generateSuggestionsForGroup(
  modelConfig: any,
  apiKey: string,
  apiUrl: string,
  model: string,
  groupShardReports: any[],
  periodLabel: string,
  topPlatforms: string[],
  groupType: 'brand' | 'distillate'
): Promise<any[]> {
  if (groupShardReports.length === 0) return [];

  try {
    let prompt: string;

    if (groupType === 'brand') {
      // 品牌词报告：基于 sentiment_dimensions 生成情感修复/优势强化建议
      const sentimentDimensionsList = groupShardReports
        .filter(sr => sr.sentiment_dimensions)
        .slice(0, 10)
        .map(sr => ({
          queue_id: sr.queue_id,
          dimensions: sr.sentiment_dimensions,
          negative_findings: (sr.negative_findings || []).slice(0, 3),
        }));

      const allNegativeFindings = groupShardReports.flatMap(sr => sr.negative_findings || []).slice(0, 5);

      prompt = `你是 AEO 内容策略专家。这是品牌词任务的本${periodLabel}报告数据 —— 查询词本身含品牌，命中率天然高，重点在于情感健康度。
请基于以下多维度情感分析数据，生成 3-5 条针对品牌情感优化和负面舆情应对的写作建议。

品牌词报告数：${groupShardReports.length}
推荐投放平台：${topPlatforms.join('、') || '无'}

各分片情感维度评分（信任度/专业度/推荐意愿/性价比感知/品牌认知度）：
${JSON.stringify(sentimentDimensionsList, null, 2)}

负面发现详情（前5条）：
${JSON.stringify(allNegativeFindings, null, 2)}

请返回 JSON 数组（不要 markdown 代码块），每条建议包含：
{
  "topic": "建议主题",
  "direction": "创作方向（如：品牌信任强化/负面舆情应对/专业度提升/性价比优势展示等）",
  "keywords": ["建议关键词1", "关键词2"],
  "platforms": ["平台1", "平台2"],
  "priority": "high|medium|low",
  "reason": "建议原因（基于情感维度数据分析）"
}

重点关注：
- 信任度/专业度偏低的维度需强化
- 负面情感超过 30% 的话题需优先应对
- 推荐意愿偏低的平台需针对性优化`;
    } else {
      // 蒸馏词报告：基于 mention_analysis 生成提及率提升/盲区覆盖建议
      const mentionAnalysisList = groupShardReports
        .filter(sr => sr.mention_analysis)
        .slice(0, 10)
        .map(sr => ({
          queue_id: sr.queue_id,
          hit_rate: sr.hit_rate,
          mention_analysis: sr.mention_analysis,
        }));

      const allUncoveredKeywords = Array.from(new Set(
        groupShardReports.flatMap(sr => sr.mention_analysis?.uncovered_keywords || [])
      )).slice(0, 30);

      prompt = `你是 AEO 内容策略专家。这是蒸馏词任务的本${periodLabel}报告数据 —— 查询词是行业通用词，提及率真实反映品牌 GEO 可见度。
请基于以下提及率分析数据，生成 3-5 条针对提及率提升和覆盖盲区弥补的写作建议。

蒸馏词报告数：${groupShardReports.length}
推荐投放平台：${topPlatforms.join('、') || '无'}

各分片提及率分析：
${JSON.stringify(mentionAnalysisList, null, 2)}

未命中品牌的关键词（覆盖盲区，前30个）：
${allUncoveredKeywords.join('、') || '无'}

请返回 JSON 数组（不要 markdown 代码块），每条建议包含：
{
  "topic": "建议主题",
  "direction": "创作方向（如：行业知识科普/关键词覆盖提升/平台均衡优化等）",
  "keywords": ["建议关键词1", "关键词2"],
  "platforms": ["平台1", "平台2"],
  "priority": "high|medium|low",
  "reason": "建议原因（基于提及率和覆盖盲区数据）"
}

重点关注：
- 提及率低于 20% 的话题需优先优化
- 未命中关键词（覆盖盲区）需通过内容建设弥补
- 跨平台一致性低的需针对性加强薄弱平台`;
    }

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
    console.warn(`[AEO-Period] ${groupType} 分组 LLM 返回非数组，使用空建议`);
    return [];
  } catch (e: any) {
    console.warn(`[AEO-Period] ${groupType} 分组 LLM 生成建议失败:`, e.message);
    return [];
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
  // v2.2.2：getEnterpriseKnowledges 已按 user_id 过滤，无需改动
  // v2.2.17：支持通过 AeoQuotaConfig 指定具体 knowledge_id
  const knowledges = await getEnterpriseKnowledges(userIdNum);
  if (knowledges.length === 0) {
    console.warn(`[AEO-Period] 用户 ${userId} 无企业知识库，跳过自动创建写作任务`);
    return 0;
  }
  const quotaConfig = await getAeoQuotaConfig(userIdNum);

  // 2.5 读取建议来源配置，从独立建议池消费未消费建议（v2.3.0）
  // 注意：日报生成任务时，根据 cloud_api_config.suggestion_source_period_type 决定消费哪类周期报告的建议
  //       例如配置为 weekly 时，每天从最新周报中消费未使用建议，直到下次周报刷新
  let consumedSuggestionIds: number[] = [];
  let effectiveSuggestions = writingSuggestions;
  try {
    const sourceType = await getSuggestionPoolSourceType(userIdNum);
    // 优先消费配置来源类型的未消费建议；若未找到则回退到当前日报自己的 writingSuggestions
    const unconsumed = await getUnconsumedSuggestionsByLatestPeriod(userIdNum, sourceType);
    if (unconsumed.length > 0) {
      effectiveSuggestions = unconsumed.map(s => ({
        topic: s.topic,
        reason: s.reason,
        direction: s.direction,
        platforms: s.platforms,
        keywords: s.keywords,
        priority: s.priority,
        source_type: 'distillate',
        id: s.id,
      }));
    }
  } catch (e: any) {
    console.warn(`[AEO-Period] 读取独立建议池失败，使用报告内建议兜底:`, e.message);
  }

  // v2.2.17：若配置了 auto_knowledge_id 则用配置值，否则取第一个（向后兼容）
  const configuredKnowledgeId = quotaConfig?.auto_knowledge_id
    ? Number(quotaConfig.auto_knowledge_id)
    : null;
  const knowledge = configuredKnowledgeId
    ? (knowledges.find((k: any) => k.id === configuredKnowledgeId) || knowledges[0])
    : knowledges[0];
  if (configuredKnowledgeId && knowledge.id !== configuredKnowledgeId) {
    console.warn(`[AEO-Period] 配置的 auto_knowledge_id=${configuredKnowledgeId} 不属于客户 ${userId}，回退到第一个知识库 id=${knowledge.id}`);
  }

  // 2. v2.2.2：按客户筛选写作指令（替代原 getAllWritingInstructions 全局取第一个）
  // v2.2.17：支持通过 AeoQuotaConfig 指定具体 instruction_id
  let instructions = await getWritingInstructions(userIdNum);
  if (instructions.length === 0) {
    console.warn(`[AEO-Period] 用户 ${userId} 无客户专属写作指令，回退到全局指令`);
    instructions = await getAllWritingInstructions();
  }
  if (instructions.length === 0) {
    console.warn(`[AEO-Period] 无可用写作指令，跳过自动创建写作任务`);
    return 0;
  }
  const configuredInstructionId = quotaConfig?.auto_instruction_id
    ? Number(quotaConfig.auto_instruction_id)
    : null;
  const instruction = configuredInstructionId
    ? (instructions.find((i: any) => i.id === configuredInstructionId) || instructions[0])
    : instructions[0];
  if (configuredInstructionId && instruction.id !== configuredInstructionId) {
    console.warn(`[AEO-Period] 配置的 auto_instruction_id=${configuredInstructionId} 不属于客户 ${userId}，回退到第一个指令 id=${instruction.id}`);
  }

  // 3. v2.2.2：自动写作也使用专家角色（替代原 agent_profile_id=null）
  // v2.2.17：支持通过 AeoQuotaConfig 指定具体 agent_profile_id
  let agentProfileId: number | null = null;
  try {
    const agentProfiles = await getAgentProfiles(userIdNum);
    const configuredAgentId = quotaConfig?.auto_agent_profile_id
      ? Number(quotaConfig.auto_agent_profile_id)
      : null;
    if (configuredAgentId) {
      const matched = agentProfiles.find((p: any) => p.id === configuredAgentId);
      if (matched) {
        agentProfileId = matched.id;
        console.log(`[AEO-Period] 自动写作使用配置指定的专家角色: userId=${userId}, profileId=${agentProfileId}, name=${matched.name}`);
      } else {
        console.warn(`[AEO-Period] 配置的 auto_agent_profile_id=${configuredAgentId} 不属于客户 ${userId}，回退到第一个 active 角色`);
      }
    }
    if (!agentProfileId) {
      const activeProfile = agentProfiles.find((p: any) => p.is_active !== false);
      if (activeProfile) {
        agentProfileId = activeProfile.id;
        console.log(`[AEO-Period] 自动写作使用第一个 active 专家角色: userId=${userId}, profileId=${agentProfileId}, name=${activeProfile.name}`);
      } else {
        console.warn(`[AEO-Period] 用户 ${userId} 无 active 专家角色，自动写作将不注入 L0 专家人格层`);
      }
    }
  } catch (e: any) {
    console.warn(`[AEO-Period] 查询专家角色失败（不影响任务创建）:`, e.message);
  }

  // 4. 获取默认模型配置
  const modelConfig = await getDefaultModelConfig(userIdNum);
  if (!modelConfig) {
    console.warn(`[AEO-Period] 用户 ${userId} 无可用写作模型配置，跳过自动创建写作任务`);
    return 0;
  }

  // v2.2.17：从写作建议池收集候选平台，让写作建议池真正影响平台投放
  // writingSuggestions 的 platforms 字段是信源平台名（如 'dy'/'xhs'/'zh'/'bjh'）
  // 这些平台作为 candidatePlatforms 传给 allocateArticlesByWeight，仅在候选平台内按权重分配
  // 若 writingSuggestions 为空或未收集到平台，则不传 candidatePlatforms（保持原行为：使用所有有权重的平台）
  // v2.2.18：auto_target_platforms（用户显式配置的目标平台白名单）优先级最高
  //   - 配置了 auto_target_platforms：仅在该白名单内分配（不再读写作建议池的 platforms）
  //   - 未配置 auto_target_platforms（null/[]）：回退到写作建议池 platforms 收集逻辑
  //   - 两者都为空：使用所有有权重的平台
  const configuredTargetPlatforms: string[] | null = Array.isArray(quotaConfig?.auto_target_platforms)
    ? quotaConfig.auto_target_platforms.filter((p: any) => typeof p === 'string' && p.trim())
    : null;

  let candidatePlatforms: string[] = [];
  let platformSource = 'all_weighted'; // 日志用：标记平台来源
  if (configuredTargetPlatforms && configuredTargetPlatforms.length > 0) {
    // 用户显式配置了目标平台白名单，优先使用
    candidatePlatforms = configuredTargetPlatforms;
    platformSource = 'configured';
  } else {
    // 未配置，回退到写作建议池的 platforms 字段
    for (const sug of (effectiveSuggestions || [])) {
      if (Array.isArray(sug.platforms)) {
        for (const p of sug.platforms) {
          if (typeof p === 'string' && p.trim() && !candidatePlatforms.includes(p)) {
            candidatePlatforms.push(p);
          }
        }
      }
    }
    if (candidatePlatforms.length > 0) {
      platformSource = 'suggestions';
    }
  }
  // 按权重分配文章数（candidatePlatforms 为空时不传，使用所有有权重的平台）
  const allocation = await allocateArticlesByWeight(
    quota,
    candidatePlatforms.length > 0 ? candidatePlatforms : undefined
  );
  console.log(`[AEO-Period] 平台分配来源=${platformSource}, 候选=[${candidatePlatforms.join(',')}], 实际分配=${JSON.stringify(allocation)}`);

  // 5. 构造 AEO 上下文（注入写作建议池）
  const aeoContext = JSON.stringify({
    period_report_id: periodReportId,
    period_type: periodType,
    suggestions: effectiveSuggestions,
    source_weights: sourceWeights,
    generated_at: new Date().toISOString(),
  });

  // 6. 汇总各平台分配的文章数，创建一个总的写作任务
  // （写作任务支持 target_platforms 字段，一个任务可覆盖多个平台）
  // v2.2.18 修复：保留所有候选平台（不过滤 allocation=0 的）。
  //   原 bug：allocateArticlesByWeight(quota=10, 12 平台) 按权重分配后，5 个权重低的平台分到 0 篇被过滤，
  //   导致"配 12 平台只写 7 平台"。修复后保留全部候选平台，让 articleGenerator 按 i % platformCount 轮询，
  //   前 quota 篇覆盖前 quota 个平台（若 quota < 平台数，部分平台不写；若 quota >= 平台数，每平台至少 1 篇）。
  const targetPlatforms = candidatePlatforms.length > 0
    ? candidatePlatforms
    : Object.keys(allocation).filter(p => allocation[p] > 0);
  if (targetPlatforms.length === 0) {
    console.warn(`[AEO-Period] 用户 ${userId} 文章分配结果为空，跳过`);
    return 0;
  }

  const taskName = `[AEO自动] ${periodType === 'daily' ? '日报' : periodType === 'weekly' ? '周报' : '月报'}驱动写作任务 ${new Date().toISOString().slice(0, 10)}`;

  // v2.1.3：优先使用用户配置的"重点优化关键词"作为写作主题
  // v2.2.2：如果未配置 focus_keywords，则回退到客户全量关键词（蒸馏+品牌），避免 L4 主题参考层为空
  // v2.2.17：quotaConfig 已在前面读取，这里复用，不再重复查询
  const focusKeywords: string[] = Array.isArray(quotaConfig?.focus_keywords)
    ? quotaConfig.focus_keywords.filter((k: any) => typeof k === 'string' && k.trim())
    : [];

  // v2.1.3：将 focus_keywords 字符串转为 zlgjc 表的 keyword_ids
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

  // v2.2.2：focus_keywords 为空时回退到客户全量关键词（蒸馏+品牌）
  // 原逻辑 focus_keywords 未配置时 keyword_ids=null，导致 L4 主题参考层为空，AI 缺少主题方向
  // 现改为查询客户全量关键词库，确保 L4 层有内容，与手动写作行为一致
  if (focusKeywordIds.length === 0) {
    try {
      const customerKeywords = await getCustomerKeywordIds(userIdNum);
      if (customerKeywords.ids.length > 0) {
        focusKeywordIds = customerKeywords.ids;
        console.log(`[AEO-Period] focus_keywords 未配置，回退到客户全量关键词: ${customerKeywords.ids.length} 个（蒸馏 ${customerKeywords.distilledCount} + 品牌 ${customerKeywords.brandCount}）`);
      } else {
        console.warn(`[AEO-Period] 用户 ${userId} 客户全量关键词也为空，L4 主题参考层将为空`);
      }
    } catch (e: any) {
      console.warn(`[AEO-Period] 查询客户全量关键词失败:`, e.message);
    }
  }

  // v2.2.13：取消 cover_image_mode/illustration_count 硬编码，改为查询客户图库
  // v2.2.16：cover_mode='random'，illustration≤5
  // v2.2.17：支持通过 AeoQuotaConfig 显式配置 auto_cover_image_mode 和 auto_illustration_count
  //   - auto_cover_image_mode='auto'（默认）→ 按图库自动决定（有封面图=random，无封面图=none）
  //   - auto_cover_image_mode='none' → 永不取封面图
  //   - auto_cover_image_mode='random' → 每篇独立随机取 1 张（即使图库为空也尝试，由 articleGenerator 兜底）
  //   - auto_illustration_count=-1（默认）→ 按图库自动决定（min(5, 图库数)）
  //   - auto_illustration_count>=0 → 直接使用配置值
  // v2.2.18 修复：原逻辑当 configuredCoverMode='random' 时仍查 coverImages.length 判断，
  //   但 needQueryLibrary=false 导致 coverImages 是空数组，结果 coverMode 被错误降级为 'none'。
  //   修复：'random' 直接生效，不依赖图库预查询；图库实际查询交给 articleGenerator.getRandomImages。
  const configuredCoverMode = typeof quotaConfig?.auto_cover_image_mode === 'string'
    ? quotaConfig.auto_cover_image_mode
    : 'auto';
  const configuredIllustrationCount = typeof quotaConfig?.auto_illustration_count === 'number'
    ? quotaConfig.auto_illustration_count
    : -1;
  let illustrationCount = 0;
  let coverMode = 'none';
  try {
    // 仅在需要按图库自动决定时才查询图库
    const needQueryLibrary = configuredCoverMode === 'auto' || configuredIllustrationCount === -1;
    let illuImages: any[] = [];
    let coverImages: any[] = [];
    if (needQueryLibrary) {
      [illuImages, coverImages] = await Promise.all([
        getImageLibrary(userIdNum, knowledge.id, 'illustration'),
        getImageLibrary(userIdNum, knowledge.id, 'cover'),
      ]);
    }
    // 决定 coverMode（v2.2.18：random 直接生效，不再依赖图库预查询结果）
    if (configuredCoverMode === 'auto') {
      coverMode = coverImages.length > 0 ? 'random' : 'none';
    } else if (configuredCoverMode === 'none') {
      coverMode = 'none';
    } else {
      // random / fixed（旧数据兼容）/ 未知值：直接 random（由 articleGenerator 实际取图时兜底）
      coverMode = 'random';
    }
    // 决定 illustrationCount
    if (configuredIllustrationCount === -1) {
      illustrationCount = illuImages.length > 0 ? Math.min(5, illuImages.length) : 0;
    } else {
      illustrationCount = Math.max(0, configuredIllustrationCount);
    }
    console.log(`[AEO-Period] 客户 ${userId} 图库配置: coverMode=${configuredCoverMode}(生效=${coverMode}), illuConfig=${configuredIllustrationCount}(生效=${illustrationCount}), 库存: cover=${coverImages.length}张, illu=${illuImages.length}张`);
  } catch (e: any) {
    console.warn(`[AEO-Period] 查询客户 ${userId} 图库失败（按配置降级：coverMode=${configuredCoverMode}, illu=${configuredIllustrationCount}）:`, e.message);
    // 降级：按配置值生效（如果配置是 auto/-1，则用 none/0；其他直接用配置值）
    if (configuredCoverMode === 'auto' || configuredCoverMode === 'none') {
      coverMode = 'none';
    } else {
      coverMode = 'random';
    }
    illustrationCount = configuredIllustrationCount === -1 ? 0 : Math.max(0, configuredIllustrationCount);
  }

  // v2.2.18 修复：totalCount = quota（quota 是用户配的"每周期总篇数"，不是"每平台篇数"）。
  //   原 bug（v2.2.16 引入）：totalCount = quota × platforms.length，把 quota 当成"每平台篇数"，
  //   导致 quota=10 + 12 平台 → totalCount=120 篇（用户期望 10 篇）。
  //   修复后：totalCount = quota = 10 篇，articleGenerator 按 i % platformCount 轮询平台，
  //   10 篇分到前 10 个平台（若 quota >= 平台数则每平台至少 1 篇）。
  const totalCount = quota;

  // 创建写作任务
  // v2.1.3：auto_publish=true，写作完成后云端自动创建发布任务
  // v2.2.2：agent_profile_id 改为使用查询到的专家角色（替代原 null）
  // v2.2.13：illustration_count 改为按客户图库实际情况配置（替代硬编码 0）
  // v2.2.16：cover_image_mode 从 'none' 改为 'random'；total_count 乘以平台数
  // v2.2.18：generation_mode 改为读取配置（替代硬编码）；cover_image_id 不再支持 fixed 配置，固定 null
  const configuredGenerationMode = typeof quotaConfig?.auto_generation_mode === 'string'
    && ['expert', 'coze'].includes(quotaConfig.auto_generation_mode)
    ? quotaConfig.auto_generation_mode
    : 'expert';

  const taskId = await createWritingTask({
    user_id: userIdNum,
    task_name: taskName,
    keyword_ids: focusKeywordIds.length > 0 ? focusKeywordIds : null,
    instruction_id: instruction.id,
    knowledge_id: knowledge.id,
    model_config_id: modelConfig.id,
    generation_mode: configuredGenerationMode,  // v2.2.18：读取配置（原硬编码 'expert'）
    agent_profile_id: agentProfileId,  // v2.2.2：使用专家角色
    total_count: totalCount,  // v2.2.16：quota × 平台数（原仅 quota）
    cover_image_mode: coverMode,  // v2.2.16：有封面图库时 'random'（原硬编码 'none'）
    cover_image_id: null,  // 自动写作不配置具体封面图（对齐手动流程图库步骤：仅 none/random 两种模式）
    illustration_count: illustrationCount,  // v2.2.13：按客户图库配置（原硬编码 0）
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

  // 标记独立建议池中的建议为已消费（v2.3.0）
  if (effectiveSuggestions !== writingSuggestions && effectiveSuggestions.length > 0) {
    try {
      const suggestionIds = effectiveSuggestions.map((s: any) => s.id).filter((id: any) => typeof id === 'number');
      if (suggestionIds.length > 0) {
        const consumedCount = await consumeWritingSuggestions(suggestionIds, taskId);
        console.log(`[AEO-Period] 已消费 ${consumedCount}/${suggestionIds.length} 条独立建议`);
      }
    } catch (e: any) {
      console.warn(`[AEO-Period] 标记建议消费失败:`, e.message);
    }
  }

  console.log(`[AEO-Period] 写作任务已创建: taskId=${taskId}, name="${taskName}", total=${totalCount}(quota=${quota}×${targetPlatforms.length}平台), platforms=[${targetPlatforms.join(',')}], cover=${coverMode}, illu=${illustrationCount}`);

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

  return totalCount;
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
