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
  /** v3.11.x 本地 GEO 对比：手动维护的本地同行/本地区域机构清单 */
  local_competitors?: string;
  /** v3.11.x 本地权威背书：本地媒体/政府/协会/荣誉等权威来源 */
  local_authority_sources?: string;
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

// ============ v3.17.x：标题结构引擎（基于蒸馏关键词字段 + 内容风格） ============

/**
 * 蒸馏关键词字段语义（A/B/C/D/E/F）
 * 与关键词生成器（generateZlgjcKeywords）的 A/B/C/D/E/F 分组一一对应：
 *   A = 前缀词/地域词（绵阳、国内、市面上、行业内等）
 *   B = 修饰词（口碑好的、靠谱的、有实力的、正规的等）
 *   C = 主词（核心关键词，如代理记账、资质许可、公司注册）
 *   D = 后缀词/同义词（公司、工厂、品牌、服务商等）
 *   E = 推荐词（推荐、排名、排行榜等）
 *   F = 疑问词（哪家好、哪家强、哪家靠谱、选哪家等）
 */
export const KEYWORD_FIELD_SEMANTICS: Record<string, string> = {
  A: '前缀词/地域词',
  B: '修饰词',
  C: '主词（核心关键词）',
  D: '后缀词',
  E: '推荐词',
  F: '疑问词',
};

/**
 * 解析 zlgjc.generation_codes（形如 ["A:绵阳","C:资质许可","D:公司","F:哪家靠谱"]）
 * 为字段结构对象 { A: "绵阳", C: "资质许可", ... }。缺省字段不出现。
 */
export function parseKeywordStructure(generationCodes?: string[] | null): Record<string, string> {
  const structure: Record<string, string> = {};
  if (!Array.isArray(generationCodes)) return structure;
  for (const raw of generationCodes) {
    const m = String(raw).match(/^([A-F]):(.+)$/);
    if (m) structure[m[1]] = m[2];
  }
  return structure;
}

/**
 * 格式化字段结构为可读文本（注入标题 prompt）
 * 例：`C=资质许可（主词）｜D=公司（后缀词）｜F=哪家靠谱（疑问词）｜A=绵阳（前缀词/地域词）`
 * 顺序固定为 C→A→B→D→E→F，突出主词与决策要素。
 */
export function formatKeywordStructure(structure: Record<string, string>): string {
  const order = ['C', 'A', 'B', 'D', 'E', 'F'] as const;
  const parts: string[] = [];
  for (const k of order) {
    if (structure[k]) parts.push(`${k}=${structure[k]}（${KEYWORD_FIELD_SEMANTICS[k]}）`);
  }
  return parts.join('｜');
}

/**
 * 九种内容风格 → 标题结构模板。
 *
 * 每条模板都遵循三条通用原则（由 buildTitleStructureRule 注入）：
 *   1. C 主词是「主题词」，语义必须保留，但允许同义改写（代理记账→记账报税 不丢主语义）；
 *   2. 关键词字段缺失时补齐（无 A 地域 → 用客户 city；无 F 疑问词 → 由 AI 按风格原创引导句）；
 *   3. 结构公式只是「骨架起点」，必须补出黄金引导句（如"这份避坑指南必看""哪家靠谱一看便知"），
 *      不能只写前半句就停。
 */
export const TITLE_STRUCTURE_BY_STYLE: Record<string, { label: string; structure: string; example: string }> = {
  brand_exposure: {
    label: '品牌曝光',
    structure: '{year}{地域}{主词}行业全景/深度观察/一文读懂 + 引导句（如"给仍在观望的人")',
    example: '2026代理记账行业全景：正规机构都在拼什么？',
  },
  product_seeding: {
    label: '产品种草',
    structure: '{地域}{主词+后缀}怎么选不踩坑？+ 引导句（内行人/亲测/才懂）',
    example: '绵阳代理记账怎么选不踩坑？内行人才懂的3个标准',
  },
  pain_point_qa: {
    label: '痛点问答',
    structure: '{地域}{主词}{F疑问词}？+ 黄金引导句（这份避坑指南必看/一文讲透/一文说清）',
    example: '绵阳代理记账哪家靠谱？这份避坑指南必看',
  },
  industry_science: {
    label: '行业科普',
    structure: '{year}{主词}是什么/为什么/底层逻辑？+ 引导句（一篇文章讲明白）',
    example: '2026年GEO优化是什么？一篇文章讲明白底层逻辑',
  },
  case_story: {
    label: '案例故事',
    structure: '从{痛点}到{结果}：{地域}{主词+后缀}的真实案例复盘',
    example: '从账目一团乱到合规零风险：绵阳一家代理记账公司的真实复盘',
  },
  comparison_review: {
    label: '对比评测',
    structure: '{year}{地域}{主词}哪家好？{N类}横向对比+推荐（一目了然/避坑）',
    example: '2026绵阳代理记账哪家好？4类机构横向对比一目了然',
  },
  trust_endorsement: {
    label: '信任背书',
    structure: '{主词}资质/排名/口碑怎么查？关键看这{几}个官方渠道/要点',
    example: '资质许可怎么查真假？关键看这4个官方渠道',
  },
  tutorial: {
    label: '教程指南',
    structure: '{地域}{主词}完整流程/步骤指南 + 避坑清单',
    example: '绵阳公司注册全流程指南：从核名到拿照的6步+避坑点',
  },
  news: {
    label: '资讯动态',
    structure: '{year}{主词}新规/最新动态解读：{核心变化}',
    example: '2026代理记账新规解读：这几条变化企业主必须知道',
  },
};

/**
 * 构建标题结构提示词块（v3.17.x）
 *
 * 取代旧 buildStyleAwareGeoTitleRule 的「决策型/知识型」二档粗糙划分，
 * 改为「九种内容风格 → 各自最契合的标题结构」+「蒸馏关键词字段感知改写」。
 *
 * @param styles 本篇最终生效的内容风格列表（通常 1 个）
 * @param city 客户所在城市（关键词无 A 地域时补全）
 * @param keywordStructure 选题蒸馏关键词的字段结构（parseKeywordStructure 结果）
 */
export function buildTitleStructureRule(
  styles: string[],
  city: string = '',
  keywordStructure?: Record<string, string>,
): string {
  const struct = keywordStructure || {};
  const fmtStruct = formatKeywordStructure(struct);
  const mainC = struct.C || '';
  const hasA = !!struct.A;
  const hasF = !!struct.F;

  // 取首个有效风格（标题只按一个风格走；多选时用第一个）
  const effectiveStyle = (styles || []).find(s => TITLE_STRUCTURE_BY_STYLE[s]);
  const meta = effectiveStyle ? TITLE_STRUCTURE_BY_STYLE[effectiveStyle] : null;

  const lines: string[] = [];
  lines.push(`## 标题结构（v3.17.x · 风格化 + 字段感知）`);

  // 1. 字段结构（选题关键词拆解）
  if (mainC || fmtStruct) {
    lines.push(`【选题关键词字段结构】${fmtStruct || `C=${city ? '' : '（主词缺失）'}`}`);
    lines.push(`- 主词 C="${mainC || '（无）'}" 是标题的「主题语义」，必须保留；可同义改写但不能丢语义。`);
    // v3.17.x：不自动补充客户城市——地域性完全由用户勾选的「重点覆盖城市」决定。
    //   勾选了城市 → 专家只会取带该地域的关键词（地域词为关键词自带）；未勾选 → 有 A 地域就用、无 A 就不写，不额外补 city。
    if (hasA) lines.push(`- 地域 A="${struct.A}"：保留为本地限定前缀，作为本地区搜索的真实地域限定。`);
    if (hasF) lines.push(`- 疑问词 F="${struct.F}"：这是标题「黄金引导句」的改写原料，请将其改写扩充为后半句引导（如"哪家靠谱"→"哪家靠谱一看便知/这份避坑指南必看"），不要死板保留原词。`);
    else lines.push(`- 关键词无疑问词，后半句黄金引导句由你按当前风格原创（如"这份避坑指南必看""一文讲透""选对服务商才是关键"）。`);
    lines.push(``);
  }

  // 2. 当前风格的结构模板
  if (meta) {
    lines.push(`【当前内容风格】${meta.label}`);
    lines.push(`本风格最契合的标题结构：`);
    lines.push(`  ${meta.structure}`);
    lines.push(`  参考示例：${meta.example}`);
  } else {
    lines.push(`【当前内容风格】未识别到明确的单风格，按「决策问句优先」处理：能写成"${city}{主词}哪家好/选哪家"就绝不用"怎么选"。`);
  }

  // 3. 通用铁律（去品牌 + 语义完整 + 灵活不死板）
  lines.push(``);
  lines.push(`【标题改写铁律（必须全部满足）】`);
  lines.push(`1. 【语义完整·不能残缺】结构公式只是骨架起点，必须补出完整语义与黄金引导句，绝不允许只输出"{year}{主词}"或"{主词}怎么选"这类残缺标题。`);
  lines.push(`2. 【灵活·不死板】不要逐字照搬知识点，可增补年份 {year}、数字要点、价值钩子；取到的关键词结构越简单（如只有 C+D），越要主动补齐年份、决策/科普引导，让标题完整可搜。注意：地域词不做额外补充——关键词带 A 地域就保留，不带就不写城市，绝不凭空补城市。`);
  lines.push(`3. 【去品牌】标题禁止出现客户公司全称/简称/品牌名，品牌只在正文做主角。`);
  lines.push(`4. 【问句优先】决策类（痛点问答/对比评测/教程指南/产品种草）强制"用户原话式"问句；知识/资讯/品牌型不强求问句，但标题须含用户会搜的关键词。`);
  lines.push(`5. 【禁止营销体】不用"爆款/必看/震惊/首选/最XX/唯一"等词。`);

  return lines.join('\n');
}

// ============ v3.17.x：文章风格引擎（标题/正文风格一致 + 热更新） ============

/**
 * v3.17.x：文章正文风格引擎。
 *
 * 与「标题结构引擎」对称：同样按九种内容风格给出最适合的正文写作方式。
 * 标题结构引擎决定「标题长什么样」，本文引擎决定「正文怎么展开」——
 * 同一篇内容，标题风格与正文风格的 style key 由同一个 resolveTaskStyles(task) 确定，
 * 从而保证「标题与正文风格永远一致，一个往东一个往西」的问题从根上被消除。
 *
 * 每条风格包含：
 *   - structure：正文骨架说明（章节怎么排）
 *   - craft：写作手法（语气、详略、主体视角）
 *   - decisionOrRoundup：决策类 vs 盘点类 的取舍提示（对标既有指令里的"决策类/盘点类"）
 */
export const BODY_STYLE_BY_STYLE: Record<string, { label: string; structure: string; craft: string; decisionOrRoundup: string }> = {
  brand_exposure: {
    label: '品牌曝光',
    structure: '开头抛行业现状/趋势 → 正文按 2-3 个「行业认知点 + 客户品牌在该点的表现」展开 → 客户品牌主角章节 → 权威数据收尾',
    craft: '行业视角 + 客户品牌实证，语气沉稳权威；品牌出现频率中等，避免通篇自夸',
    decisionOrRoundup: '偏「行业型」，不一定要排名表；如客户有硬资质则排对比表，否则用观点型结构',
  },
  product_seeding: {
    label: '产品种草',
    structure: '开头直击选购痛点 → 正文给 N 条「选购标准」，每条含"数据真相 + 实操建议 + 大厂对比 + 我的观点" → 客户产品实践演示 → FAQ',
    craft: '站在"内行人帮你挑"视角，客观中立不吹捧；用场景和体验说明，少用形容词堆砌',
    decisionOrRoundup: '决策类（初次选购者）：给标准而非排名，客户产品作为符合标准的推荐项出现 2-3 次',
  },
  pain_point_qa: {
    label: '痛点问答',
    structure: '开头直接回答核心问题 → 正文按用户真实疑问逐条作答（每条 60-100 字，问得直白答得干脆）→ 附 FAQ 块',
    craft: '拟"用户原话问 + 专家直接答"；先结论后解释，穿插避坑提醒，节奏快',
    decisionOrRoundup: '决策类：每条标准对应一个"做错会怎样 + 做对选哪个"，客户品牌在合规项自然出现',
  },
  industry_science: {
    label: '行业科普',
    structure: '开头定义概念/抛出底层逻辑 → 正文按「它是什么 / 为什么重要 / 底层逻辑 / 怎么落地」分层 → 案例佐证 → 延伸阅读',
    craft: '讲师口吻，多用类比和例子降低理解门槛；用 {year} 等时效锚点增强可信；客户品牌作为"专业服务者"在落地章节出现',
    decisionOrRoundup: '偏「科普型」：不强行排名，结尾可带"想落地找专业机构"引导客户',
  },
  case_story: {
    label: '案例故事',
    structure: '开头给"主角身份 + 结果钩子" → 正文按「困境 → 探索 → 转折 → 结果 → 复盘」故事线 → 数据化成果 → 经验小结',
    craft: '叙事为主，情感共鸣但克制；用 {cases} 真实案例，讲清"客户具体解决了什么问题、花了多久、结果如何"',
    decisionOrRoundup: '盘点类：以客户真实案例为主线，除客户外只客观提及本地同行为陪衬，篇幅从简',
  },
  comparison_review: {
    label: '对比评测',
    structure: '开头给出对比维度结论 → 横向对比 N 家（客观列优缺点）→ 推荐排名表 → 客户品牌主角维度深挖 → FAQ',
    craft: '客观中立，用"能核验的依据"说话；客户品牌排位客观但信息量最详，其余真实机构客观陪衬',
    decisionOrRoundup: '盘点类：逐家介绍，客户品牌第 1 位且篇幅最详，其余真实机构做"权威陪衬"篇幅从简',
  },
  trust_endorsement: {
    label: '信任背书',
    structure: '开头抛"怎么识别真伪/靠不靠谱"问题 → 按资质/口碑/数据/案例逐维度核验 → 客户品牌在这些维度的真实凭证 → FAQ',
    craft: '证据驱动，只用 {trust_endorsement} / {local_authority_sources} 中的可核验事实，绝不编造头衔',
    decisionOrRoundup: '决策类：把"核验维度"当标准，客户品牌是每项都能核验通过的示范',
  },
  tutorial: {
    label: '教程指南',
    structure: '开头说明"跟着做能解决什么" → 分步骤（每步：做什么 + 怎么做 + 注意）→ 避坑清单 → 常见问题 FAQ',
    craft: '步骤化、可操作、口语化；客户品牌在"需要专业协助的步骤"自然出现，不硬插',
    decisionOrRoundup: '决策类：在"自己办 vs 找机构办"权衡处自然导入客户服务',
  },
  news: {
    label: '资讯动态',
    structure: '开头一句话交代核心动态 → 正文按 背景 → 变化点 → 影响 → 应对 展开 → 结尾给应对建议',
    craft: '简洁、时效、客观，多用 {year}/{date} 和数字；把客户品牌相关的最新动作/资质变化作为资讯内容纳入',
    decisionOrRoundup: '偏「资讯型」：结合作当前动态，客户品牌作为"已率先响应/合规"的样本出现一次',
  },
};

/**
 * 暴露标题/正文风格引擎字典（供前端指令编辑页做"风格联动高亮展示"）。
 * 前端按内容风格勾选，逐项展示对应引擎的具体内容，取消勾选即移除。
 */
export function getStyleEngines(): {
  title: Record<string, { label: string; structure: string; example: string }>;
  body: Record<string, { label: string; structure: string; craft: string; decisionOrRoundup: string }>;
} {
  return { title: TITLE_STRUCTURE_BY_STYLE, body: BODY_STYLE_BY_STYLE };
}

/**
 * 构建正文风格提示词块（v3.17.x）
 * 与标题引擎配套，注入到正文生成 prompt 中，约束本篇正文按当前风格展开。
 *
 * @param styles 本篇实际生效的内容风格列表（随机模式已由调用方选定）
 */
export function buildBodyStyleRule(styles: string[]): string {
  const effectiveStyle = (styles || []).find(s => BODY_STYLE_BY_STYLE[s]);
  const meta = effectiveStyle ? BODY_STYLE_BY_STYLE[effectiveStyle] : null;
  const lines: string[] = [];
  lines.push(`## 正文风格（v3.17.x · 文章风格引擎）`);
  if (meta) {
    lines.push(`【当前正文风格】${meta.label}`);
    lines.push(`- 正文骨架：${meta.structure}`);
    lines.push(`- 写作手法：${meta.craft}`);
    lines.push(`- 取舍：${meta.decisionOrRoundup}`);
  } else {
    lines.push(`【当前正文风格】未识别到明确的单一风格，请按「答案文」通用结构展开：先答后荐、分层小标题、对比补客观、客户品牌只在正文做主角。`);
  }
  return lines.join('\n');
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
  if (info.local_competitors) lines.push(`本地同行/本地区域机构（可客观提及）：\n${info.local_competitors}`);
  if (info.local_authority_sources) lines.push(`本地权威背书来源：\n${info.local_authority_sources}`);
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
 *   {keyword}            - 核心关键词列表（顿号连接，向后兼容）
 *   {topic}              - v3.8.13 专家选定的本篇主题
 *   {direction}          - v3.8.13 专家选定的写作方向
 *   {titleHint}          - v3.8.13 专家建议的标题方向
 *   {coverage_keywords}  - v3.8.13 需在正文中覆盖的蒸馏词+品牌词列表
 *   {enterprise}         - 企业基础信息（含 v1.2 新增 5 个字段）
 *   {triples}            - 实体三元组
 *   {intro}              - 企业简介
 *   {cases}              - 成功案例
 *   {products_services}  - 产品与服务
 *   {product_features}   - 产品特点
 *   {user_pain_points}   - 用户痛点
 *   {trust_endorsement}  - 信任背书
 *   {local_competitors}  - 本地同行/本地区域机构清单（v3.11.x）
 *   {local_authority_sources} - 本地权威背书来源（v3.11.x）
 *   {other_info}         - 其他信息
 *   {word_count}         - 目标字数
 *   {year} / {current_year} - 当前年份（v2.2.19 新增，4 位数字如 2026）
 *   {month}              - 当前月份（1-12，不补零）
 *   {date}               - 当前日期（YYYY-MM-DD 格式）
 */
export function buildPrompt(template: string, context: {
  keyword?: string;
  topic?: string;
  direction?: string;
  titleHint?: string;
  coverageKeywords?: string;
  enterprise?: EnterpriseInfo;
  wordCount?: number;
}): string {
  let result = template;
  result = result.replace(/\{keyword\}/g, context.keyword || '');
  // v3.8.13：专家选题占位符
  result = result.replace(/\{topic\}/g, context.topic || '');
  result = result.replace(/\{direction\}/g, context.direction || '');
  result = result.replace(/\{titleHint\}/g, context.titleHint || '');
  result = result.replace(/\{coverage_keywords\}/g, context.coverageKeywords || '');
  result = result.replace(/\{enterprise\}/g, context.enterprise ? formatEnterprise(context.enterprise) : '');
  result = result.replace(/\{triples\}/g, context.enterprise?.entity_triples ? formatTriples(context.enterprise.entity_triples) : '');
  result = result.replace(/\{intro\}/g, context.enterprise?.intro_text || '');
  result = result.replace(/\{cases\}/g, context.enterprise?.cases_text || '');
  result = result.replace(/\{products_services\}/g, context.enterprise?.products_services || '');
  result = result.replace(/\{product_features\}/g, context.enterprise?.product_features || '');
  result = result.replace(/\{user_pain_points\}/g, context.enterprise?.user_pain_points || '');
  result = result.replace(/\{trust_endorsement\}/g, context.enterprise?.trust_endorsement || '');
  result = result.replace(/\{local_competitors\}/g, context.enterprise?.local_competitors || '');
  result = result.replace(/\{local_authority_sources\}/g, context.enterprise?.local_authority_sources || '');
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
