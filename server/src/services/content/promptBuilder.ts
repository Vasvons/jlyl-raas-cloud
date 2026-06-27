export interface EnterpriseInfo {
  company_full_name: string;
  company_short_name?: string;
  city?: string;
  address?: string;
  industry?: string;
  founded_year?: number;
  business_scope?: string;
  intro_text?: string;
  cases_text?: string;
  entity_triples?: Array<{ subject: string; relation: string; object: string }>;
  /** v1.2 新增 5 个自由文本字段 */
  products_services?: string;
  product_features?: string;
  user_pain_points?: string;
  trust_endorsement?: string;
  other_info?: string;
}

/**
 * 创作方向候选（多选，对应 writing_instruction.category 字段）
 * 注：category 原为单选分层(认知层等)，现已升级为多选创作方向
 */
export const DIRECTION_OPTIONS = [
  'brand_exposure',     // 品牌曝光
  'product_seeding',    // 产品种草
  'pain_point_solution',// 痛点解决
  'industry_science',   // 行业科普
  'case_showcase',      // 案例展示
  'comparison_review',  // 对比评测
  'trust_endorsement',  // 信任背书
];

/** 创作方向中文映射 */
const DIRECTION_LABELS: Record<string, string> = {
  brand_exposure: '品牌曝光',
  product_seeding: '产品种草',
  pain_point_solution: '痛点解决',
  industry_science: '行业科普',
  case_showcase: '案例展示',
  comparison_review: '对比评测',
  trust_endorsement: '信任背书',
};

/**
 * 文案类型候选（多选，对应 writing_instruction.content_types 字段）
 */
export const CONTENT_TYPE_OPTIONS = [
  'science',     // 科普文章
  'review',      // 测评文章
  'case_story',  // 案例故事
  'qa',          // 问答文章
  'comparison',  // 对比文章
  'news',        // 资讯文章
  'tutorial',    // 教程文章
];

/** 文案类型中文映射（含写作风格描述，注入 prompt） */
const CONTENT_TYPE_META: Record<string, { label: string; style: string }> = {
  science:    { label: '科普文章', style: '通俗易懂地解释概念，用类比和例子降低理解门槛，结构清晰' },
  review:     { label: '测评文章', style: '客观评价产品/服务，列出优缺点，给出购买建议，数据支撑' },
  case_story: { label: '案例故事', style: '以真实案例叙事，突出用户痛点和解决方案效果，情感共鸣' },
  qa:         { label: '问答文章', style: '围绕用户常见疑问组织内容，逐条解答，结构化强' },
  comparison: { label: '对比文章', style: '横向对比多款产品/方案，表格化展示差异，给出选择建议' },
  news:       { label: '资讯文章', style: '时效性强，简洁报道行业动态或产品更新，倒金字塔结构' },
  tutorial:   { label: '教程文章', style: '步骤化操作指南，可操作性强，含注意事项和常见问题' },
};

/**
 * 构建方向×类型上下文（注入 system_prompt 开头）
 * @param directions 创作方向数组（可为空）
 * @param contentType 文案类型 key（单次生成只选1种）
 * @returns 注入到 system_prompt 开头的上下文文本（空字符串表示不注入）
 */
export function buildDirectionContext(directions: string[], contentType: string): string {
  const lines: string[] = [];

  // 创作方向（可多个，组合表达意图）
  if (directions && directions.length > 0) {
    const labels = directions.map(d => DIRECTION_LABELS[d]).filter(Boolean);
    if (labels.length > 0) {
      lines.push(`【创作方向】${labels.join('、')}`);
    }
  }

  // 文案类型（单次只选1种，含风格描述）
  if (contentType && CONTENT_TYPE_META[contentType]) {
    const meta = CONTENT_TYPE_META[contentType];
    lines.push(`【文案类型】${meta.label}`);
    lines.push(`【写作风格】${meta.style}`);
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 从指令的 content_types 中随机选1种文案类型
 * @param contentTypes 指令配置的文案类型数组
 * @returns 随机选中的 contentType key，空数组返回空字符串
 */
export function pickRandomContentType(contentTypes: string[]): string {
  if (!contentTypes || contentTypes.length === 0) return '';
  return contentTypes[Math.floor(Math.random() * contentTypes.length)];
}

/**
 * 从指令的 category 中随机选1种创作方向
 * @param categories 指令配置的创作方向数组
 * @returns 随机选中的方向 key，空数组返回空字符串
 */
export function pickRandomDirection(categories: string[]): string {
  if (!categories || categories.length === 0) return '';
  return categories[Math.floor(Math.random() * categories.length)];
}

/**
 * 组装企业基础信息文本（用于占位符替换）
 */
function formatEnterprise(info: EnterpriseInfo): string {
  const lines: string[] = [];
  if (info.company_full_name) lines.push(`企业全称：${info.company_full_name}`);
  if (info.company_short_name) lines.push(`简称：${info.company_short_name}`);
  if (info.city) lines.push(`所在城市：${info.city}`);
  if (info.address) lines.push(`地址：${info.address}`);
  if (info.industry) lines.push(`所属行业：${info.industry}`);
  if (info.founded_year) lines.push(`成立年份：${info.founded_year}`);
  if (info.business_scope) lines.push(`业务范围：\n${info.business_scope}`);
  if (info.products_services) lines.push(`产品与服务：\n${info.products_services}`);
  if (info.product_features) lines.push(`产品特点：\n${info.product_features}`);
  if (info.user_pain_points) lines.push(`用户痛点：\n${info.user_pain_points}`);
  if (info.trust_endorsement) lines.push(`信任背书：\n${info.trust_endorsement}`);
  if (info.other_info) lines.push(`其他信息：\n${info.other_info}`);
  return lines.join('\n');
}

/**
 * 组装实体三元组文本（GEO核心，用于占位符替换）
 */
function formatTriples(triples: Array<{ subject: string; relation: string; object: string }>): string {
  if (!triples || triples.length === 0) return '';
  return triples.map(t => `- ${t.subject} ${t.relation} ${t.object}`).join('\n');
}

/**
 * 替换 prompt 模板中的占位符
 * 支持的占位符：
 *   {keyword}            - 核心关键词
 *   {enterprise}         - 企业基础信息（含 v1.2 新增 5 个字段）
 *   {triples}            - 实体三元组
 *   {intro}              - 企业简介
 *   {cases}              - 成功案例
 *   {products_services}  - 产品与服务
 *   {product_features}   - 产品特点
 *   {user_pain_points}   - 用户痛点
 *   {trust_endorsement}  - 信任背书
 *   {other_info}         - 其他信息
 *   {word_count}         - 目标字数
 */
export function buildPrompt(template: string, context: {
  keyword: string;
  enterprise?: EnterpriseInfo;
  wordCount?: number;
}): string {
  let result = template;
  result = result.replace(/\{keyword\}/g, context.keyword);
  result = result.replace(/\{enterprise\}/g, context.enterprise ? formatEnterprise(context.enterprise) : '');
  result = result.replace(/\{triples\}/g, context.enterprise?.entity_triples ? formatTriples(context.enterprise.entity_triples) : '');
  result = result.replace(/\{intro\}/g, context.enterprise?.intro_text || '');
  result = result.replace(/\{cases\}/g, context.enterprise?.cases_text || '');
  result = result.replace(/\{products_services\}/g, context.enterprise?.products_services || '');
  result = result.replace(/\{product_features\}/g, context.enterprise?.product_features || '');
  result = result.replace(/\{user_pain_points\}/g, context.enterprise?.user_pain_points || '');
  result = result.replace(/\{trust_endorsement\}/g, context.enterprise?.trust_endorsement || '');
  result = result.replace(/\{other_info\}/g, context.enterprise?.other_info || '');
  result = result.replace(/\{word_count\}/g, String(context.wordCount || 1500));
  return result;
}
