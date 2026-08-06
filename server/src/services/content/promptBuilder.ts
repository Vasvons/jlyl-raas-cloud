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
 * v3.8.12：合并「创作方向」和「文案类型」为统一的「内容风格」
 *
 * 原设计有 7 方向 × 7 类型 = 49 种组合，但存在大量语义重叠：
 *   - comparison_review 方向 ≈ review + comparison 类型
 *   - case_showcase 方向 ≈ case_story 类型
 *   - industry_science 方向 ≈ science 类型
 * 且某些组合存在矛盾（如 资讯文章+产品种草），用户选择负担大。
 *
 * 合并后每个选项同时包含"营销意图"和"体裁风格"，用户只需选一次。
 * 数据存储在 content_types 字段（JSONB 数组），category 字段废弃但保留兼容。
 */

/** 内容风格选项（合并方向×类型） */
export const CONTENT_STYLE_OPTIONS = [
  'brand_exposure',     // 品牌曝光
  'product_seeding',    // 产品种草
  'pain_point_qa',      // 痛点问答
  'industry_science',   // 行业科普
  'case_story',         // 案例故事
  'comparison_review',  // 对比评测
  'trust_endorsement',  // 信任背书
  'tutorial',           // 教程指南
  'news',               // 资讯动态
];

/** 内容风格中文映射（含写作风格描述，注入 prompt） */
const CONTENT_STYLE_META: Record<string, { label: string; style: string }> = {
  brand_exposure:    { label: '品牌曝光', style: '突出品牌形象和核心优势，自然融入品牌关键词，增强品牌记忆点' },
  product_seeding:   { label: '产品种草', style: '软性植入产品亮点和使用场景，激发用户兴趣和购买欲望' },
  pain_point_qa:     { label: '痛点问答', style: '围绕用户常见疑问逐条解答，直击痛点，结构化强' },
  industry_science:  { label: '行业科普', style: '通俗易懂解释行业概念，用类比和例子降低理解门槛' },
  case_story:        { label: '案例故事', style: '以真实案例叙事，突出用户痛点和解决方案效果，情感共鸣' },
  comparison_review: { label: '对比评测', style: '横向对比多方案，客观列出优缺点，给出选择建议' },
  trust_endorsement: { label: '信任背书', style: '突出资质、口碑、数据等信任信号，增强可信度' },
  tutorial:          { label: '教程指南', style: '步骤化操作指南，可操作性强，含注意事项和常见问题' },
  news:              { label: '资讯动态', style: '时效性强，简洁报道行业动态或产品更新' },
};

/**
 * 旧 category 值 → 新 content_style 值的映射（用于数据迁移和兼容）
 */
const CATEGORY_TO_STYLE: Record<string, string> = {
  brand_exposure: 'brand_exposure',
  product_seeding: 'product_seeding',
  pain_point_solution: 'pain_point_qa',
  industry_science: 'industry_science',
  case_showcase: 'case_story',
  comparison_review: 'comparison_review',
  trust_endorsement: 'trust_endorsement',
};

/**
 * 旧 content_types 值 → 新 content_style 值的映射（用于数据迁移和兼容）
 */
const OLD_TYPE_TO_STYLE: Record<string, string> = {
  science: 'industry_science',
  review: 'comparison_review',
  case_story: 'case_story',
  qa: 'pain_point_qa',
  comparison: 'comparison_review',
  news: 'news',
  tutorial: 'tutorial',
};

/**
 * 将旧 category 数组映射为新 content_style 数组（去重）
 */
export function migrateCategoryToStyle(categories: string[]): string[] {
  const styles = categories.map(c => CATEGORY_TO_STYLE[c] || c).filter(s => CONTENT_STYLE_META[s]);
  return [...new Set(styles)];
}

/**
 * 将旧 content_types 数组映射为新 content_style 数组（去重）
 */
export function migrateOldTypesToStyle(types: string[]): string[] {
  const styles = types.map(t => OLD_TYPE_TO_STYLE[t] || t).filter(s => CONTENT_STYLE_META[s]);
  return [...new Set(styles)];
}

/**
 * 构建内容风格上下文（注入 system_prompt 开头）
 * @param styles 内容风格数组（多选；随机模式下已由调用方选好1个）
 * @returns 注入到 system_prompt 开头的上下文文本
 */
export function buildDirectionContext(styles: string[]): string {
  if (!styles || styles.length === 0) return '';

  const labels: string[] = [];
  const styleDescs: string[] = [];

  for (const s of styles) {
    const meta = CONTENT_STYLE_META[s];
    if (meta) {
      labels.push(meta.label);
      styleDescs.push(`${meta.label}：${meta.style}`);
    }
  }

  if (labels.length === 0) return '';

  const lines: string[] = [];
  lines.push(`【内容风格】${labels.join('、')}`);
  lines.push(`【写作要求】`);
  styleDescs.forEach(d => lines.push(`- ${d}`));

  return lines.join('\n') + '\n\n';
}

/**
 * 从内容风格数组中随机选1种（随机模式用）
 */
export function pickRandomContentType(styles: string[]): string {
  if (!styles || styles.length === 0) return '';
  return styles[Math.floor(Math.random() * styles.length)];
}

/**
 * @deprecated v3.8.12 已合并到 pickRandomContentType
 */
export function pickRandomDirection(categories: string[]): string {
  return pickRandomContentType(categories);
}

/**
 * 组装企业基础信息文本（用于占位符替换和无条件上下文注入）
 */
export function formatEnterprise(info: EnterpriseInfo): string {
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
 *   {year} / {current_year} - 当前年份（v2.2.19 新增，4 位数字如 2026）
 *   {month}              - 当前月份（1-12，不补零）
 *   {date}               - 当前日期（YYYY-MM-DD 格式）
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
  // v2.2.19：年份/月份/日期占位符
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1);
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
  result = result.replace(/\{year\}/g, year);
  result = result.replace(/\{current_year\}/g, year);
  result = result.replace(/\{month\}/g, month);
  result = result.replace(/\{date\}/g, dateStr);
  return result;
}
