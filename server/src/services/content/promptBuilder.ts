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
 *   {keyword}     - 核心关键词
 *   {enterprise}  - 企业基础信息
 *   {triples}     - 实体三元组
 *   {intro}       - 企业自由文本介绍
 *   {cases}       - 成功案例
 *   {word_count}  - 目标字数
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
  result = result.replace(/\{word_count\}/g, String(context.wordCount || 1500));
  return result;
}
