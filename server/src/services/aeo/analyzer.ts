/**
 * AEO 分析器：调用大模型对品牌提及记录进行分析，生成日报
 * 每个任务每天生成一次报告，包含：可见度、情感分布、竞品分析、优化建议
 */
import axios from 'axios';
import {
  getBrandMentionRecordsForAeo,
  insertAeoReport,
  checkAeoReportExists,
  getBrandKeywords,
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
