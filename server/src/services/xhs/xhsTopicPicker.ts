/**
 * 小红书选题器
 *
 * 与 GEO 的「专家选题」本质不同：GEO 用蒸馏词 A–F 字段拼搜索式主题；
 * 这里按真人内容维度（人群 × 场景 × 痛点/卖点）扩题，单次调用产出 N 个不重复角度。
 */
import { chatCompletion } from '../content/aiClient';
import { buildTopicPickerMessages } from './prompts';

export interface XhsTopic {
  angle: string;
  keyword: string;
  hook: string;
}

/** 从模型返回中提取 JSON（容忍 markdown 代码块与前后噪音） */
export function extractJson(raw: string): any | null {
  if (!raw) return null;
  const text = String(raw).trim();
  // 1. 直接解析
  try {
    return JSON.parse(text);
  } catch { /* 继续尝试 */ }
  // 2. 抓 ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch { /* 继续尝试 */ }
  }
  // 3. 抓第一个 { 到最后一个 }，或第一个 [ 到最后一个 ]
  const objMatch = text.match(/[\{\[][\s\S]*[\}\]]/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* 放弃 */ }
  }
  return null;
}

export async function pickXhsTopics(params: {
  keywords: string[];
  count: number;
  enterpriseText: string;
  accountType: string;
  model: { baseUrl: string; apiKey: string; model: string };
}): Promise<XhsTopic[]> {
  const messages = buildTopicPickerMessages({
    keywords: params.keywords,
    count: params.count,
    enterpriseText: params.enterpriseText,
    accountType: params.accountType,
  });

  const result = await chatCompletion({
    baseUrl: params.model.baseUrl,
    apiKey: params.model.apiKey,
    model: params.model.model,
    messages,
    temperature: 0.9,
    maxTokens: 4096,
    timeout: 120000,
  });

  const parsed = extractJson(result.content);
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.topics) ? parsed.topics : []);

  const topics: XhsTopic[] = [];
  for (const item of list) {
    const angle = String(item?.angle || '').trim();
    if (!angle) continue;
    topics.push({
      angle,
      keyword: String(item?.keyword || '').trim(),
      hook: String(item?.hook || '').trim(),
    });
  }

  // 兜底：模型没给出足够角度时，用关键词补齐，保证篇数不缩水
  let i = 0;
  while (topics.length < params.count) {
    const kw = params.keywords[i % Math.max(1, params.keywords.length)] || '';
    topics.push({ angle: kw || `围绕关键词的第 ${topics.length + 1} 个角度`, keyword: kw, hook: '' });
    i++;
    if (i > params.count + 10) break; // 防死循环
  }

  return topics.slice(0, params.count);
}
