/**
 * 小红书图文写作系统 — Prompt 模板（独立内核）
 *
 * 本文件是「与 GEO 写作系统解耦」的关键边界：
 * 不 import services/content/promptBuilder.ts 的任何规则函数
 * （buildGeoAnswerStructure / buildTitleStructureRule / buildBodyStyleRule /
 *   buildEntityKeywordEnforcement / buildWritingCraftRule 一个都不碰）。
 * 只依赖 aiClient 的类型定义与 repository 的数据读取。
 *
 * 设计依据：docs/superpowers/specs/2026-10-02-xhs-writing-system-design.md §4
 */
import type { ChatMessage } from '../content/aiClient';

/** 「活人感」硬性原则（两条指令共享，注入到所有生成 prompt 的前缀） */
export const HUMAN_VOICE_RULES = `【写作身份】
你在为真人写小红书笔记。这不是 SEO 文章，不是 GEO 答案文，不是官网通稿，不是公众号长文。
读者是刷小红书的真人——他们在地铁上、睡前、排队时随手刷到这篇笔记，三秒内决定是划走还是看完。

【绝对禁止】
- 禁止 <h2> 小标题、表格、FAQ 章节、"常见问题"栏目
- 禁止"首先/其次/最后""第一点/第二点"式序号化分点
- 禁止"综上所述/由此可见/总而言之"这类书面语连接词
- 禁止"效果非常好/非常惊艳/堪称完美"这类空泛形容词堆砌
- 禁止在结尾写"结论与行动建议"式的总结段落，禁止免责声明

【必须做到】
- 短句为主，允许口语和语气词（"真的"、"说实话"、"我踩过坑"、"反正"）
- 正文 3-6 段，每段 2-4 行，段与段之间空一行
- emoji 按语气自然点缀（密度要求：{emoji_rule}），不要每句话都加
- 用具体细节代替形容词：写用量、价格、时长、具体场景、前后对比
- 结尾像真人收尾（一句话感受 / 反问 / 自然引导），不要总结`;

/** emoji 密度 → 中文说明 */
export function emojiRuleText(level?: string): string {
  if (level === 'low') return '每 2-3 段点缀 1 个即可，克制';
  if (level === 'high') return '几乎每段都有 1-3 个，但不要连续堆 3 个以上';
  return '每段 1-2 个，自然出现';
}

/**
 * 填充指令模板里的占位符。
 * 独立实现（不复用 GEO 的 buildPrompt），支持小红书场景需要的占位符。
 */
export function fillTemplate(template: string, ctx: {
  topic?: string;
  keyword?: string;
  hook?: string;
  title?: string;
  enterprise?: string;
  productsServices?: string;
  productFeatures?: string;
  userPainPoints?: string;
  trustEndorsement?: string;
  cases?: string;
  intro?: string;
  wordCount?: number;
}): string {
  const now = new Date();
  let out = template;
  out = out.replace(/\{topic\}/g, ctx.topic || '');
  out = out.replace(/\{keyword\}/g, ctx.keyword || '');
  out = out.replace(/\{hook\}/g, ctx.hook || '');
  out = out.replace(/\{title\}/g, ctx.title || '');
  out = out.replace(/\{enterprise\}/g, ctx.enterprise || '');
  out = out.replace(/\{products_services\}/g, ctx.productsServices || '');
  out = out.replace(/\{product_features\}/g, ctx.productFeatures || '');
  out = out.replace(/\{user_pain_points\}/g, ctx.userPainPoints || '');
  out = out.replace(/\{trust_endorsement\}/g, ctx.trustEndorsement || '');
  out = out.replace(/\{cases\}/g, ctx.cases || '');
  out = out.replace(/\{intro\}/g, ctx.intro || '');
  out = out.replace(/\{word_count\}/g, String(ctx.wordCount || 700));
  out = out.replace(/\{year\}/g, String(now.getFullYear()));
  out = out.replace(/\{current_year\}/g, String(now.getFullYear()));
  out = out.replace(/\{month\}/g, String(now.getMonth() + 1));
  out = out.replace(/\{emoji_rule\}/g, emojiRuleText('medium'));
  return out;
}

/** 企业信息文本（小红书场景：只给真人会用到的事实，不做三元组堆砌） */
export function formatEnterpriseForXhs(k: any): string {
  if (!k) return '（无企业信息）';
  const lines: string[] = [];
  const name = k.company_short_name || k.company_full_name || '';
  if (name) lines.push(`品牌/公司：${name}${k.company_full_name && k.company_full_name !== name ? `（全称：${k.company_full_name}）` : ''}`);
  if (k.city) lines.push(`所在城市：${k.city}`);
  if (k.industry) lines.push(`行业：${k.industry}`);
  if (k.business_scope) lines.push(`业务范围：${k.business_scope}`);
  if (k.products_services) lines.push(`产品/服务：${k.products_services}`);
  if (k.product_features) lines.push(`产品特点：${k.product_features}`);
  if (k.user_pain_points) lines.push(`用户痛点：${k.user_pain_points}`);
  if (k.intro_text) lines.push(`企业介绍：${k.intro_text}`);
  if (k.cases_text) lines.push(`真实案例：${k.cases_text}`);
  if (k.trust_endorsement) lines.push(`资质与背书：${k.trust_endorsement}`);
  if (k.other_info) lines.push(`其他信息：${k.other_info}`);
  return lines.join('\n');
}

/** 合规约束块（保留能力：合规是法律要求，不属于 GEO 逻辑） */
export function buildComplianceBlock(rules: any[]): string {
  const valid = (rules || []).filter((r) => r && r.rule_content && String(r.rule_content).trim());
  if (valid.length === 0) return '';
  const list = valid.map((r, i) => `${i + 1}. ${String(r.rule_content).trim()}`).join('\n');
  return `\n\n【行业合规红线（必须遵守，违反会导致内容违规被平台处罚）】
${list}
以上红线优先级高于「写完」这个目标：如果某个表达触线，换一种说法或直接不写。`;
}

/** 选题阶段 prompt：产出 N 个互不重复的真人内容角度 */
export function buildTopicPickerMessages(params: {
  keywords: string[];
  count: number;
  enterpriseText: string;
  accountType: string;
}): ChatMessage[] {
  const accountDesc = params.accountType === 'brand'
    ? '品牌官方号（内容落点是官方信息、新品、答疑、教程、资质）'
    : '种草达人号（内容落点是真实使用体验、踩坑复盘、同类对比）';
  const system = `你是小红书内容策划。你要为一个${accountDesc}规划 ${params.count} 个**互不重复**的笔记选题角度。

${HUMAN_VOICE_RULES.replace('{emoji_rule}', '每段 1-2 个')}

【选题铁律】
- 角度必须是**真人在小红书会搜、会点、会收藏的话题**，不是搜索引擎式的商业查询
- 【禁止】生成"XX哪家好""XX排名""XX推荐榜""XX公司怎么样"这类搜索式/商业查询主题
- 每个角度都要落到具体的「人群 + 场景 + 具体问题」，例如"油皮夏天中午就出油，怎么补妆不斑驳"
- ${params.count} 个角度必须互不重复，不要把一个话题换几种说法

【选题维度参考】人群（学生党/宝妈/上班族/敏感肌…）× 场景（夏天/通勤/熬夜/换季/送礼…）× 具体痛点或卖点`;

  const user = `【可用关键词】（从中取材，也可自然延展）
${params.keywords.join('、') || '（无，请自主规划）'}

【企业/产品信息】
${params.enterpriseText}

请规划 ${params.count} 个选题角度。

【输出格式（严格 JSON 数组，不要任何其他文字）】
[{"angle":"选题角度（一句话具体描述）","keyword":"对应的可用关键词","hook":"首图或首句的钩子提示"}]`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 成文阶段 prompt：产出 §3.1 的结构化笔记 JSON */
export function buildNoteMessages(params: {
  accountType: string;
  emojiLevel: string;
  targetWordCount: number;
  requireDrawback: boolean;
  includeImageScript: boolean;
  titlePrompt: string;
  bodyPrompt: string;
  coverTextPrompt: string;
  topicPrompt: string;
  imageScriptPrompt: string;
  topic: string;
  keyword: string;
  hook: string;
  enterpriseText: string;
  complianceBlock: string;
  platformMaxLength: number;
  /** v3.z：用户在两步向导里选定的标题（必须使用） */
  preferredTitle?: string;
  /** v3.z：智能选题产出的推荐话题（成文未给话题时兜底） */
  preferredTopics?: string[];
}): ChatMessage[] {
  const p = params;
  const system = `${HUMAN_VOICE_RULES.replace('{emoji_rule}', emojiRuleText(p.emojiLevel))}

【本次任务】产出一篇完整的小红书图文笔记，包含标题、封面大字、正文、话题标签${p.includeImageScript ? '、配图脚本' : ''}。

【字数】正文 ${Math.min(150, p.platformMaxLength)}-${Math.min(p.targetWordCount, p.platformMaxLength)} 字（硬上限 ${p.platformMaxLength} 字，超出会被平台拒绝，必须控制住）。
${p.requireDrawback ? '\n【强制】正文中必须包含至少 1 处真实的缺点或明确说明「不适合谁」——只夸不损会被识别成广告。' : ''}`;

  const parts: string[] = [];
  parts.push(`【本篇选题】${p.topic}`);
  if (p.preferredTitle) parts.push(`【指定标题（必须使用这个标题，可微调标点）】${p.preferredTitle}`);
  if (p.preferredTopics && p.preferredTopics.length > 0) {
    parts.push(`【推荐话题（优先使用，可增补）】${p.preferredTopics.join(' ')}`);
  }
  if (p.keyword) parts.push(`【取材关键词】${p.keyword}`);
  if (p.hook) parts.push(`【钩子提示】${p.hook}`);
  parts.push(`\n【企业/产品信息】\n${p.enterpriseText}`);
  parts.push(`\n【标题要求】\n${fillTemplate(p.titlePrompt, { topic: p.topic, keyword: p.keyword, hook: p.hook, enterprise: p.enterpriseText, wordCount: p.targetWordCount })}`);
  parts.push(`\n【正文要求】\n${fillTemplate(p.bodyPrompt, { topic: p.topic, keyword: p.keyword, hook: p.hook, enterprise: p.enterpriseText, wordCount: p.targetWordCount })}`);
  if (p.coverTextPrompt) parts.push(`\n【封面大字要求】\n${fillTemplate(p.coverTextPrompt, { topic: p.topic, keyword: p.keyword, hook: p.hook })}`);
  if (p.topicPrompt) parts.push(`\n【话题标签要求】\n${fillTemplate(p.topicPrompt, { topic: p.topic, keyword: p.keyword })}`);
  if (p.includeImageScript && p.imageScriptPrompt) parts.push(`\n【配图脚本要求】\n${fillTemplate(p.imageScriptPrompt, { topic: p.topic })}`);

  parts.push(`\n【输出格式（严格 JSON，不要任何解释文字，不要 markdown 代码块标记）】
{
  "title": "标题（不含引号，不含 emoji 也行）",
  "cover_text": "封面大字（4-10 字，可以和标题不同）",
  "body": "正文纯文本，用空行分段，可以含 emoji，但不要含任何 HTML 标签",
  "topics": ["#话题1#", "#话题2#"]${p.includeImageScript ? ',\n  "image_script": [{"index":1,"role":"封面","scene":"具体画面描述"}]' : ''}
}`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') + p.complianceBlock },
  ];
}
