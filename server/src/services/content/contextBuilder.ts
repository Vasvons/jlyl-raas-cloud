/**
 * 写作上下文构建器（运行时聚合层）
 *
 * 从现有表实时聚合五层上下文，分层组织成 system message + user prompt 后缀：
 *   L0 专家人格层：agent_profile.systemPrompt + skills（角色设定）
 *   L1 客户档案层：enterprise_knowledge 全字段（为谁写）
 *   L2 历史记忆层：article 表最近 N 篇标题+摘要（避免重复选题）
 *   L3 效果记忆层：article_performance 关联 keyword_search_rank（收录好的文章模式）— 阶段3
 *   L4 主题参考层：关键词库列表（写什么）
 *   L5 RAG 检索层：向量检索 top-K 相关历史片段 — 阶段2
 *
 * 设计原则：
 *   - 纯函数模块，不直接访问数据库，数据由调用方通过 repository 查询后传入
 *   - 无条件注入，不依赖占位符（解决用户不写 {enterprise} 导致信息丢失的问题）
 *   - 分层组织，各层独立可选，缺失的层自动跳过
 */

import { formatEnterprise, EnterpriseInfo, buildDirectionContext } from './promptBuilder';

// ---------- 类型定义 ----------

/** L2 历史记忆条目 */
export interface RecentArticleItem {
  title: string;
  summary: string;       // 前 200 字纯文本
  createdAt: string;     // YYYY-MM-DD
  coreKeyword?: string;  // 文章的核心关键词
}

/** L3 效果记忆条目（阶段3） */
export interface PerformanceMemoryItem {
  articleTitle: string;
  performanceLabel: 'good' | 'neutral' | 'poor';
  keywordRankChange?: number;  // 关键词排名变化（正数=提升）
  aeoScore?: number;
  direction?: string;          // 创作方向
  contentType?: string;        // 文案类型
}

/** L3 策略记忆条目（阶段3） */
export interface StrategyMemoryItem {
  strategy: string;     // 策略建议文本
  evidence: string;     // 策略依据
  generatedAt: string;  // 生成时间
}

/** L5 RAG 检索片段（阶段2） */
export interface RagSnippet {
  source: 'article' | 'knowledge' | 'triple';
  title: string;
  content: string;   // 摘要文本
  score: number;     // 相似度分数（0-1）
  articleId?: number;
}

/** buildWritingContext 输入 */
export interface WritingContextInput {
  /** 已联表查询的 task 对象（含 instruction/knowledge/agent_profile 字段） */
  task: any;
  /** 关键词列表 */
  keywords: string[];
  /** L2 历史记忆：最近已生成的文章列表 */
  recentArticles?: RecentArticleItem[];
  /** L3 效果记忆（阶段3，可选） */
  performanceMemory?: PerformanceMemoryItem[];
  /** L3 策略记忆（阶段3，可选） */
  strategyMemory?: StrategyMemoryItem[];
  /** L5 RAG 检索片段（阶段2，可选） */
  ragSnippets?: RagSnippet[];
}

/** buildWritingContext 输出 */
export interface WritingContext {
  /** 完整的 system message（含专家人格+客户档案+历史记忆+策略+效果） */
  systemMessage: string;
  /** 附加到 user prompt 末尾的上下文块 */
  userPromptSuffix: string;
}

// ---------- 辅助函数 ----------

/** 从 HTML 中提取纯文本，截取前 N 字符作为摘要 */
export function stripHtml(html: string, maxLen: number = 200): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 从 task 对象构建 EnterpriseInfo */
function buildEnterpriseInfo(task: any): EnterpriseInfo {
  return {
    company_full_name: task.company_full_name || '',
    company_short_name: task.company_short_name,
    city: task.city,
    industry: task.industry,
    business_scope: task.business_scope,
    intro_text: task.intro_text,
    cases_text: task.cases_text,
    entity_triples: task.entity_triples || [],
    products_services: task.products_services,
    product_features: task.product_features,
    user_pain_points: task.user_pain_points,
    trust_endorsement: task.trust_endorsement,
    other_info: task.other_info,
  };
}

/** 格式化实体三元组 */
function formatTriples(triples: Array<{ subject: string; relation: string; object: string }>): string {
  if (!triples || triples.length === 0) return '';
  return triples.map(t => `- ${t.subject} ${t.relation} ${t.object}`).join('\n');
}

/** 格式化关键词列表 */
function formatKeywords(keywords: string[]): string {
  if (!keywords || keywords.length === 0) return '';
  return keywords.join('、');
}

// ---------- 各层构建函数 ----------

/** L0 专家人格层：agent_profile 的 systemPrompt + skills */
function buildLayer0ExpertPersona(task: any): string {
  const systemPrompt: string = task.agent_system_prompt || '';
  const skillsContent: string = task.agent_skills_content || '';
  const parts: string[] = [];
  if (systemPrompt.trim()) {
    parts.push(systemPrompt.trim());
  }
  if (skillsContent.trim()) {
    parts.push(`【已启用技能】\n${skillsContent.trim()}`);
  }
  return parts.join('\n\n');
}

/** L1 客户档案层：enterprise_knowledge 全字段 */
function buildLayer1CustomerProfile(task: any): string {
  // v1.8.1：字段级长度保护，避免某个字段过长导致 prompt 超出模型上下文窗口
  // 经验阈值：单字段 5000 字符（约 1400 tokens），entity_triples 最多 50 条
  const MAX_FIELD_LEN = 5000;
  const MAX_TRIPLES = 50;
  const truncateField = (val: any): string => {
    const s = typeof val === 'string' ? val : (val == null ? '' : String(val));
    if (s.length > MAX_FIELD_LEN) {
      console.warn(`[ContextBuilder][L1] 字段超长已截断: 原长=${s.length}, 截断到 ${MAX_FIELD_LEN}`);
      return s.slice(0, MAX_FIELD_LEN) + '\n[...已截断...]';
    }
    return s;
  };

  const enterpriseInfo = buildEnterpriseInfo({
    ...task,
    intro_text: truncateField(task.intro_text),
    cases_text: truncateField(task.cases_text),
    business_scope: truncateField(task.business_scope),
    products_services: truncateField(task.products_services),
    product_features: truncateField(task.product_features),
    user_pain_points: truncateField(task.user_pain_points),
    trust_endorsement: truncateField(task.trust_endorsement),
    other_info: truncateField(task.other_info),
    entity_triples: Array.isArray(task.entity_triples)
      ? task.entity_triples.slice(0, MAX_TRIPLES)
      : task.entity_triples,
  });
  const entText = formatEnterprise(enterpriseInfo);
  if (!entText) return '';

  const lines: string[] = [entText];

  // 实体三元组
  const triplesText = formatTriples(enterpriseInfo.entity_triples || []);
  if (triplesText) {
    lines.push(`实体三元组：\n${triplesText}`);
  }

  return `【客户档案】\n你正在为以下客户写作，请确保内容与客户的产品、行业、痛点紧密相关：\n${lines.join('\n')}`;
}

/** L2 历史记忆层：最近已生成的文章（避免重复选题） */
function buildLayer2RecentArticles(recentArticles?: RecentArticleItem[]): string {
  if (!recentArticles || recentArticles.length === 0) return '';

  const lines = recentArticles.map((a, i) => {
    const kw = a.coreKeyword ? `[${a.coreKeyword}] ` : '';
    return `${i + 1}. ${kw}${a.title}（${a.createdAt}）`;
  });

  return `【历史记忆】以下是最近已生成的文章，请避免重复选题和相似角度：\n${lines.join('\n')}`;
}

/** L3 效果记忆层：收录好的文章模式（阶段3） */
function buildLayer3Performance(performanceMemory?: PerformanceMemoryItem[]): string {
  if (!performanceMemory || performanceMemory.length === 0) return '';

  const goodItems = performanceMemory.filter(p => p.performanceLabel === 'good');
  const poorItems = performanceMemory.filter(p => p.performanceLabel === 'poor');

  const lines: string[] = [];
  if (goodItems.length > 0) {
    lines.push('收录效果好的文章特征（可借鉴）：');
    for (const item of goodItems.slice(0, 5)) {
      const dir = item.direction ? `[${item.direction}] ` : '';
      const rank = item.keywordRankChange !== undefined ? `（排名+${item.keywordRankChange}）` : '';
      lines.push(`  ✓ ${dir}${item.articleTitle}${rank}`);
    }
  }
  if (poorItems.length > 0) {
    lines.push('收录效果差的文章特征（需避免）：');
    for (const item of poorItems.slice(0, 3)) {
      const dir = item.direction ? `[${item.direction}] ` : '';
      lines.push(`  ✗ ${dir}${item.articleTitle}`);
    }
  }

  return lines.length > 0 ? `【效果记忆】基于 AEO 分析的收录效果反馈：\n${lines.join('\n')}` : '';
}

/** L3 策略记忆层：飞轮总结的创作策略（阶段3） */
function buildLayer3Strategy(strategyMemory?: StrategyMemoryItem[]): string {
  if (!strategyMemory || strategyMemory.length === 0) return '';

  const lines = strategyMemory.slice(0, 3).map((s, i) => {
    return `${i + 1}. ${s.strategy}\n   依据：${s.evidence}（${s.generatedAt}）`;
  });

  return `【飞轮策略】基于近期收录数据自动总结的创作策略建议：\n${lines.join('\n')}`;
}

/** L4 主题参考层：关键词库列表 */
function buildLayer4TopicReference(keywords: string[]): string {
  const kwText = formatKeywords(keywords);
  if (!kwText) return '';

  return `【主题参考】客户关键词库（请从中选择主题创作，不要逐一展开，也不要一个关键词写一篇）：\n${kwText}`;
}

/** L5 RAG 检索层：向量检索相关历史片段（阶段2） */
function buildLayer5RagSnippets(ragSnippets?: RagSnippet[]): string {
  if (!ragSnippets || ragSnippets.length === 0) return '';

  const lines = ragSnippets.map((s, i) => {
    const sourceLabel = s.source === 'article' ? '历史文章' : s.source === 'knowledge' ? '知识库' : '三元组';
    return `${i + 1}. [${sourceLabel}] ${s.title}\n   ${s.content}`;
  });

  return `【相关参考】基于向量检索的相关历史内容片段：\n${lines.join('\n')}`;
}

/** L6 输出规范层：强制输出格式、排版、关键词密度（字数由写作指令控制） */
function buildLayer6OutputSpec(task: any, keywords: string[]): string {
  // 从关键词库中选出主关键词（前 5 个）用于关键词密度要求
  const mainKeywords = keywords.slice(0, 5);

  const lines: string[] = [];
  lines.push(`【输出规范（必须严格遵守）】`);
  lines.push(``);
  lines.push(`一、输出格式`);
  lines.push(`必须按以下格式输出，不要输出任何其他内容（不要输出思考过程、分析过程、解释说明）：`);
  lines.push(`<title>文章标题（15-30字，不要包含"文章"二字，不要包含书名号）</title>`);
  lines.push(`<body>`);
  lines.push(`正文HTML内容`);
  lines.push(`</body>`);
  lines.push(``);
  lines.push(`二、字数要求`);
  lines.push(`字数以写作指令中的要求为准（如果指令中指定了字数范围，严格遵守该范围）。`);
  lines.push(`字数统计基于纯文本（不含 HTML 标签），写完后自行核对字数。`);
  lines.push(``);
  lines.push(`三、排版规范（必须使用语义化 HTML 标签）`);
  lines.push(`1. 用 <h2> 划分文章主要章节（3-5 个 H2）`);
  lines.push(`2. 用 <h3> 划分子章节（可选，用于更细的内容分层）`);
  lines.push(`3. 用 <p> 标签包裹正文段落，每段 80-150 字，不要一整段超过 200 字`);
  lines.push(`4. 用 <ul><li> 或 <ol><li> 展示要点、特征、步骤（至少出现 1-2 次）`);
  lines.push(`5. 对比类内容用 <table><thead><tr><th>...</th></tr></thead><tbody><tr><td>...</td></tr></tbody></table> 展示`);
  lines.push(`6. 重要观点、关键数据用 <strong> 或 <em> 加粗强调（适度使用，不要滥用）`);
  lines.push(`7. 不要使用 <h1>（H1 由系统自动从 <title> 生成）`);
  lines.push(`8. 不要输出 markdown 语法（## ** 等），必须用 HTML 标签`);
  lines.push('9. 不要输出 ``` 代码块标记');
  lines.push(``);
  lines.push(`四、关键词密度要求（GEO 优化核心）`);
  if (mainKeywords.length > 0) {
    lines.push(`以下关键词必须在文章中自然出现（关键词密度 2%-5%，即每 100 字出现 2-5 次）：`);
    mainKeywords.forEach((kw, i) => lines.push(`  ${i + 1}. "${kw}"`));
    lines.push(`要求：`);
    lines.push(`- 关键词必须出现在标题、H2 标题、正文段落中（至少 3 个位置）`);
    lines.push(`- 关键词使用要自然流畅，不要生硬堆砌，不要影响阅读体验`);
    lines.push(`- 优先使用关键词的完整匹配，不要随意拆分`);
  }
  lines.push(``);
  lines.push(`五、内容质量要求`);
  lines.push(`1. 开头直接切入主题，不要"随着...的发展"等套话`);
  lines.push(`2. 内容必须基于客户档案的真实信息，不要编造企业信息、案例、数据`);
  lines.push(`3. 结尾给出明确的行动建议或总结，不要泛泛而谈`);
  lines.push(`4. 不要输出"以上就是"、"希望对您有帮助"等废话结尾`);

  return lines.join('\n');
}

// ---------- 核心函数 ----------

/**
 * 构建完整写作上下文（运行时聚合层）
 *
 * @param input 写作上下文输入
 * @returns { systemMessage, userPromptSuffix }
 *
 * systemMessage 包含 L0(专家) + L1(客户档案) + L2(历史) + L3(效果/策略) + L5(RAG) + L6(输出规范)
 * userPromptSuffix 包含 L4(主题参考) — 因为主题参考与具体任务指令更相关
 *
 * 调用方使用方式：
 *   const ctx = await buildWritingContext({ task, keywords, recentArticles });
 *   const messages = ctx.systemMessage
 *     ? [{ role: 'system', content: ctx.systemMessage }, { role: 'user', content: articlePrompt + ctx.userPromptSuffix }]
 *     : [{ role: 'user', content: articlePrompt + ctx.userPromptSuffix }];
 */
export function buildWritingContext(input: WritingContextInput): WritingContext {
  const { task, keywords, recentArticles, performanceMemory, strategyMemory, ragSnippets } = input;

  // 构建 system message：L0 + L1 + L2 + L3 + L5 + L6
  const systemParts: string[] = [];

  const l0 = buildLayer0ExpertPersona(task);
  if (l0) systemParts.push(l0);

  const l1 = buildLayer1CustomerProfile(task);
  if (l1) systemParts.push(l1);

  const l2 = buildLayer2RecentArticles(recentArticles);
  if (l2) systemParts.push(l2);

  const l3Perf = buildLayer3Performance(performanceMemory);
  if (l3Perf) systemParts.push(l3Perf);

  const l3Strategy = buildLayer3Strategy(strategyMemory);
  if (l3Strategy) systemParts.push(l3Strategy);

  const l5 = buildLayer5RagSnippets(ragSnippets);
  if (l5) systemParts.push(l5);

  // L6 输出规范层（始终注入，确保格式/字数/排版/关键词密度）
  const l6 = buildLayer6OutputSpec(task, keywords);
  if (l6) systemParts.push(l6);

  // 构建 user prompt 后缀：L4 主题参考
  const suffixParts: string[] = [];
  const l4 = buildLayer4TopicReference(keywords);
  if (l4) suffixParts.push(l4);

  return {
    systemMessage: systemParts.join('\n\n---\n'),
    userPromptSuffix: suffixParts.length > 0 ? '\n\n---\n' + suffixParts.join('\n\n') : '',
  };
}
