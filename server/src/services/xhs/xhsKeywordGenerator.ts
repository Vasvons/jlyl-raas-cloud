/**
 * 小红书关键词库 — AI 候选词生成器（v2.15.1）
 *
 * 输入：库名称（+备注）+ 客户知识库摘要 + 排除列表（库内已有词 / 上一批候选，用于「换一批」）
 * 输出：一批符合小红书搜索习惯的候选关键词（品类词 / 场景词 / 人群词 / 需求词混合）
 *
 * 解耦约束：只依赖 aiClient（调模型）与 xhsTopicPicker.extractJson，不 import GEO 逻辑。
 */
import { chatCompletion } from '../content/aiClient';
import type { ChatMessage } from '../content/aiClient';
import { extractJson } from './xhsTopicPicker';

/** 单批候选词数量上限（模型可能返回更少） */
const CANDIDATE_COUNT = 20;
/** 词长度硬边界（汉字个数） */
const MIN_LEN = 2;
const MAX_LEN = 8;

const SYSTEM_PROMPT = `你是小红书关键词运营专家。你要为一个「关键词库」生成一批候选关键词——这些词随后会被用作小红书笔记的「取材关键词」，会出现在笔记的标题、封面大字和话题标签里。

【候选词硬性要求】
- 长度 2-8 个汉字，必须是小红书用户真实会搜索的词，不是句子、不是卖点口号
- 每个词必须能自然地写进封面大字（封面共 1-3 行、每行不超过 10 字），禁止问句、标点符号、英文混排
- 四类词混合输出：① 品类词（如「阳台柜」）② 场景词（如「小户型阳台收纳」）③ 人群词（如「租房改造」）④ 需求词（如「阳台柜尺寸」「阳台柜防潮」）
- 必须落在企业知识库的行业 / 产品 / 服务范围内，禁止虚构知识库里没有的业务
- 禁止出现品牌名（封面大字规则不允许品牌名，会造成冲突）
- 禁止绝对化 / 诱导词（最好、第一、闭眼入、天花板、绝绝子 等）
- 与「关键词库名称」的主题相关；词与词之间要有差异化，不要把一个意思换几种说法
- 不要输出与「已存在 / 已生成过」列表重复的词

【输出格式】只输出 JSON，不要任何解释：
{"keywords":["词1","词2","词3"]}`;

/** 清洗单个候选词：去引号/空白，过滤标点与超长词；不合格返回空串 */
function cleanKeyword(raw: any): string {
  let s = String(raw || '').trim();
  // 去掉模型偶发包裹的引号 / 书名号 / 井号
  s = s.replace(/^["'“”‘’《》【】#\s]+|["'“”‘’《》【】#\s]+$/g, '');
  if (!s) return '';
  // 含标点、空格、英文、数字混排的一律拒绝（保证能自然上封面）
  if (/[\s,，.。!！?？、;；:：()（）\[\]{}<>\/\\|~—…\-"'“”‘’#$%^&*+=@`]/.test(s)) return '';
  const len = Array.from(s).length;
  if (len < MIN_LEN || len > MAX_LEN) return '';
  return s;
}

/** 组装用户消息：库名 + 备注 + 知识库摘要 + 排除列表 */
function buildUserPrompt(params: {
  libraryName: string;
  remark?: string;
  knowledgeText: string;
  exclude: string[];
}): string {
  const parts: string[] = [];
  parts.push(`【关键词库名称】${params.libraryName}`);
  if (params.remark) parts.push(`【库备注】${params.remark}`);
  parts.push(`\n【企业知识库（关键词必须在此业务范围内）】\n${params.knowledgeText}`);
  if (params.exclude.length > 0) {
    parts.push(`\n【已存在 / 已生成过（不要重复）】\n${params.exclude.join('、')}`);
  }
  parts.push(`\n请生成最多 ${CANDIDATE_COUNT} 个候选关键词，按 JSON 格式输出。`);
  return parts.join('\n');
}

/**
 * 生成候选关键词（调用方已解析好模型配置与知识库文本）
 */
export async function generateXhsKeywordCandidates(params: {
  libraryName: string;
  remark?: string;
  knowledgeText: string;
  /** 排除词：库内已有词 + 上一批候选（换一批时传入） */
  exclude?: string[];
  model: { baseUrl: string; apiKey: string; model: string };
}): Promise<string[]> {
  const excludeSet = new Set(
    (params.exclude || []).map((s) => String(s || '').trim()).filter(Boolean),
  );
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserPrompt({
        libraryName: params.libraryName,
        remark: params.remark,
        knowledgeText: params.knowledgeText,
        exclude: Array.from(excludeSet),
      }),
    },
  ];

  const result = await chatCompletion({
    baseUrl: params.model.baseUrl,
    apiKey: params.model.apiKey,
    model: params.model.model,
    messages,
    // 高温度：同一库反复「换一批」时产出差异更大的词
    temperature: 0.95,
    maxTokens: 2048,
    timeout: 120000,
  });

  const parsed = extractJson(result.content);
  const list: any[] = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.keywords) ? parsed.keywords : []);

  const out: string[] = [];
  for (const item of list) {
    const kw = cleanKeyword(item);
    if (!kw) continue;
    if (excludeSet.has(kw)) continue;
    if (out.includes(kw)) continue;
    out.push(kw);
    if (out.length >= CANDIDATE_COUNT) break;
  }
  return out;
}