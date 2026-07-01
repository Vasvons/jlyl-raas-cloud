import { chatCompletion } from './aiClient';
import { getDefaultModelConfig, getEnterpriseKnowledgeById } from '../../repository';
import { decrypt } from '../../utils/crypto';

/**
 * 三元组结构
 */
export interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * 从企业知识库文本字段中抽取实体三元组
 *
 * 实现要点：
 *  - 聚合 intro_text / cases_text / products_services / product_features / user_pain_points / trust_endorsement / other_info 等自由文本
 *  - 调用 AI 模型，要求严格输出 JSON 数组
 *  - 解析容错：去除 markdown 代码块包裹、提取数组片段、过滤无效项
 *  - 不写入数据库，由前端追加到编辑器，用户确认后再保存
 */
export async function extractTriplesFromKnowledge(knowledgeId: number, userId: number): Promise<Triple[]> {
  // 1. 读取知识库
  const knowledge = await getEnterpriseKnowledgeById(knowledgeId);
  if (!knowledge) {
    throw new Error('知识库不存在');
  }

  // 2. 聚合文本字段
  const textFields = [
    ['企业介绍', knowledge.intro_text],
    ['成功案例', knowledge.cases_text],
    ['产品服务', knowledge.products_services],
    ['产品特点', knowledge.product_features],
    ['用户痛点', knowledge.user_pain_points],
    ['信任背书', knowledge.trust_endorsement],
    ['其他信息', knowledge.other_info],
    ['业务范围', knowledge.business_scope],
  ];
  const textBlob = textFields
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    .map(([label, v]) => `【${label}】\n${(v as string).trim()}`)
    .join('\n\n');

  if (!textBlob) {
    return [];
  }

  // 3. 取该用户的默认 AI 模型配置
  const modelConfig = await getDefaultModelConfig(userId);
  if (!modelConfig) {
    throw new Error('未配置AI模型，请到「后台配置 > 生文模型配置」中添加并启用');
  }

  let apiKey = '';
  if (modelConfig.api_key_encrypted) {
    try {
      apiKey = decrypt(modelConfig.api_key_encrypted);
    } catch {
      throw new Error('API-KEY 解密失败，请重新配置模型');
    }
  }
  if (!apiKey) {
    throw new Error('模型未配置 API-KEY');
  }

  // 4. 构造 prompt
  const systemPrompt = `你是一个实体关系抽取助手。从给定的企业知识库文本中抽取实体三元组 (subject, predicate, object)。

要求：
1. subject / object 必须是文本中出现的具体实体（公司名、产品名、人物、地点、技术、资质等），不要使用代词
2. predicate 必须是简洁的关系描述（如"成立于"、"总部位于"、"主营"、"获得"、"拥有"、"合作"、"隶属于"）
3. 抽取 5-30 条最有信息量的三元组，避免重复或无意义的条目
4. 严格输出 JSON 数组格式，不要包含任何解释文字、markdown 代码块或注释

输出格式示例：
[{"subject":"聚量引力","predicate":"成立于","object":"2018年"},{"subject":"聚量引力","predicate":"总部位于","object":"上海"}]`;

  const userPrompt = `企业名称：${knowledge.company_full_name}${knowledge.company_short_name ? `（简称：${knowledge.company_short_name}）` : ''}

知识库文本：
${textBlob}

请抽取实体三元组，仅输出 JSON 数组：`;

  // 5. 调用 AI（抽取任务用低温度、关闭联网搜索）
  const result = await chatCompletion({
    baseUrl: modelConfig.base_url,
    apiKey,
    model: modelConfig.model_name,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    timeout: 60000,
  });

  // 6. 解析返回的 JSON 数组
  return parseTriples(result.content);
}

/**
 * 从 AI 返回的文本中解析三元组数组
 * 容错策略：
 *  1. 去除 markdown ```json / ``` 代码块包裹
 *  2. 直接 JSON.parse
 *  3. 失败则用正则提取第一个 [ ... ] 片段再 parse
 *  4. 过滤无效项（缺字段或空字符串）
 */
function parseTriples(raw: string): Triple[] {
  if (!raw || typeof raw !== 'string') return [];

  let text = raw.trim();

  // 去除 markdown 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    text = codeBlockMatch[1].trim();
  }

  // 尝试直接解析
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 失败则提取第一个数组片段
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        return [];
      }
    }
  }

  if (!Array.isArray(parsed)) return [];

  // 过滤并归一化
  const result: Triple[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const subject = String(item.subject ?? '').trim();
    const predicate = String(item.predicate ?? '').trim();
    const object = String(item.object ?? '').trim();
    if (subject && predicate && object) {
      result.push({ subject, predicate, object });
    }
  }
  return result;
}
