import { chatCompletion, extractApiErrorMessage } from './aiClient';
import { buildPrompt, buildDirectionContext, pickRandomContentType, formatEnterprise, migrateCategoryToStyle, migrateOldTypesToStyle } from './promptBuilder';
import { buildWritingContext, stripHtml, type RecentArticleItem, type PerformanceMemoryItem, type StrategyMemoryItem, type RagSnippet } from './contextBuilder';
import { retrieveRelevantArticles } from './ragRetrieval';
import { generateAndSaveEmbedding } from './embeddingService';
import {
  getWritingTaskById,
  getKeywordsByIds,
  getBrandQueryKeywords,
  getArticleById,
  createArticle,
  updateWritingTaskProgress,
  completeWritingTask,
  incrementModelUsedCount,
  getDefaultModelConfig,
  getAiModelConfigById,
  getRecentArticlesByKnowledge,
  getPerformanceMemory,
  getStrategyMemory,
  getRandomImages,
  getImageById,
  getPlatformRulesByPlatforms,
  getPlatformArticlesByTask,
  createPublishTask,
  getLatestPeriodReportSuggestions,
  getArticleCountByPeriodReport,
  updateWritingTaskAeoContext,
  getCoreKeywordsByUserId,
  getCoreKeywordsFromZlgjcByUserId,
  getActiveManualRulesByPlatform,
  getComplianceRulesByIds,
  updateArticleComplianceStatus,
} from '../../repository';
import { decrypt } from '../../utils/crypto';
import crypto from 'crypto';
// v2.5.19：写作过程每篇完成后广播 WS 事件，让前端进度条实时推进
import { wsBroadcast } from '../../wsServer';

/**
 * 解析指令的 category（创作方向）字段
 * 升级后 category 可能是数组(多选方向)、单字符串(旧数据)或 null
 */
function parseDirections(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

/**
 * 解析指令的 content_types 字段
 * 数据库 JSONB 类型可能返回数组或字符串
 */
function parseContentTypes(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * v3.8.12：构建内容风格上下文（注入 prompt 开头）
 * 合并后只读 content_types 字段（已含原 category 映射后的数据）
 * - random_mode=true：每次随机选1种风格
 * - random_mode=false：用所有配置的风格
 */
function buildDirectionContextForTask(task: any): string {
  // 兼容旧数据：优先用 content_types，若为空则从 category 迁移
  let styles = parseContentTypes(task.content_types);
  if (styles.length === 0 && task.instruction_category) {
    styles = migrateCategoryToStyle(parseDirections(task.instruction_category));
  }
  // 双重兼容：如果 content_types 里存的是旧值（science/review/qa 等），自动映射
  if (styles.length > 0 && !styles.every(s => ['brand_exposure','product_seeding','pain_point_qa','industry_science','case_story','comparison_review','trust_endorsement','tutorial','news'].includes(s))) {
    styles = migrateOldTypesToStyle(styles);
  }

  const isRandom = !!task.random_mode;

  if (isRandom) {
    const picked = pickRandomContentType(styles);
    return buildDirectionContext(picked ? [picked] : []);
  }
  return buildDirectionContext(styles);
}

/**
 * v3.11.x：解析任务最终生效的内容风格列表（含旧值迁移 + random_mode 随机选1）
 * 与 buildDirectionContextForTask 共用，供标题 GEO 决策意图做风格感知判断
 */
function resolveTaskStyles(task: any): string[] {
  let styles = parseContentTypes(task.content_types);
  if (styles.length === 0 && task.instruction_category) {
    styles = migrateCategoryToStyle(parseDirections(task.instruction_category));
  }
  if (styles.length > 0 && !styles.every(s => ['brand_exposure','product_seeding','pain_point_qa','industry_science','case_story','comparison_review','trust_endorsement','tutorial','news'].includes(s))) {
    styles = migrateOldTypesToStyle(styles);
  }
  if (task.random_mode && styles.length > 0) {
    const picked = pickRandomContentType(styles);
    styles = picked ? [picked] : [];
  }
  return styles;
}

/**
 * 构建标题 GEO 决策意图的风格感知规则（v3.11.x）
 * 决策友好风格（痛点问答/对比评测/教程指南/产品种草）强约束；
 * 其余风格（行业科普/资讯动态/案例故事/信任背书/品牌曝光）弱化、允许带决策落点
 */
function buildStyleAwareGeoTitleRule(styles: string[]): string {
  const decisionIntentStyles = ['pain_point_qa', 'comparison_review', 'tutorial', 'product_seeding'];
  const strong = styles.some(s => decisionIntentStyles.includes(s));
  if (strong) {
    return `10. 【GEO 决策意图（v3.11.x · 强约束）】当前内容风格偏"决策友好型"，标题**必须**落在用户"选购/决策"的真实搜索意图上，落点在"怎么选 / 哪家好 / 对比 / 参考 / 避坑 / 指南"这类查询（如"绵阳代理记账公司怎么选？对比 5 家后给你参考"）。这样更贴近用户和 AI 在回答"本地某业务哪家好/排名"时的检索来源，利于 GEO 收录。禁止写成无决策意图的纯企业介绍或泛泛科普标题。`;
  }
  return `10. 【GEO 决策意图（v3.11.x · 弱约束）】当前内容风格偏"知识/资讯/品牌"型，标题可侧重原有风格与专业表达，但**建议**在结尾带一个决策落点（如"2026年代理记账行业新政策解读，看完就知道怎么选"），避免写成纯泛泛而谈、无任何检索价值的标题。不必强套"怎么选/哪家好"，自然带出即可。`;
}

/**
 * 检测文本是否像思考过程（而非正常标题/内容）
 * 用于过滤推理模型把思考过程当成标题返回的情况
 * v2.2.16：新增"提示词模板污染"识别——AI 把 title_prompt 模板内容当标题输出
 */
function isThinkingProcess(text: string): boolean {
  if (!text || text.length < 5) return false;
  // 1. 以思考特征词开头（强信号）
  if (/^(好的|首先|让我|我需要|用户|根据|分析|思考|这是一个|我打算|我计划|我考虑|接下来|那么|现在|本次|这次)/i.test(text)) return true;
  // 2. 包含思考特征短语（强信号）
  if (/用户(的需求|希望|需要|这次|提供)|我的思考|我需要|我打算|我计划|我考虑|分析一下|思考一下|核心诉求|围绕如何|GEO优化|差异化优势|我(已经|将|会|打算)/i.test(text)) return true;
  // 3. 标题过长（正常标题 15-30 字，超过 50 字大概率是思考过程）
  if (text.length > 50) return true;
  // 4. v2.2.16：提示词模板污染检测
  //    场景：AI 把 title_prompt 模板内容（如"【爆款自媒体文章标题生成提示词】 ### 标题选项"）当标题输出
  //    特征词：提示词、标题选项、爆款、prompt、生成提示词、选项 1、选项 2、### 标题
  if (/(提示词|标题选项|生成提示词|爆款|prompt|###\s*标题|选项\s*[1-9]|标题生成)/i.test(text)) return true;
  return false;
}

/**
 * 剥离 AI 响应中的思考过程
 * 兼容：
 *   1. <think>...</think> 标签（DeepSeek-R1 等推理模型）
 *   2. <reasoning>...</reasoning> 标签
 *   3. 裸思考文本（"好的，用户..."、"首先，我..." 等开头，支持多行）
 */
function stripThinking(text: string): string {
  let result = text;
  // 1. 剥离 <think>...</think> 思考过程标签
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 2. 剥离 <reasoning>...</reasoning> 思考过程标签
  result = result.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // 3. 剥离裸思考过程（支持多行，持续到第一个 <title>/<body>/<h> 标签或结尾）
  //    特征：以"好的"、"首先"、"让我"等开头，后面跟随长文本（可能含换行）
  //    使用 [\s\S] 允许多行，用前瞻 (?=...) 在遇到 HTML 结构标签时停止
  result = result.replace(/^[\s\n]*((好的|首先|让我|我需要|用户|根据|分析|思考)[\s\S]{20,5000}?)(?=<title>|<body>|<h[1-6]|<p[^>]*>|$)/i, '');
  return result.trim();
}

/**
 * v2.2.19：清洗标题前缀和后缀
 * 场景：AI 不遵守"只输出标题文字"指令，把 # / 【标题】/ 标题：/ ## 等前缀一起输出
 * 修复：去除所有非标题文字的前缀、后缀、装饰符号
 */
function cleanTitlePrefix(title: string): string {
  if (!title) return '';
  let t = title.trim();
  // 循环去除开头的前缀（可能有多个，如 "## 【标题】xxx"）
  let prev = '';
  while (prev !== t && t) {
    prev = t;
    // 1. 去除开头的 markdown 标题符号 #（一个或多个，后跟空格）
    t = t.replace(/^#{1,6}\s*/, '');
    // 2. 去除开头的 【标题】、【标题：】、【标题1】 等前缀块
    t = t.replace(/^【\s*标题\s*[\d：:]*\s*】\s*/, '');
    // 3. 去除开头的 "标题："、"标题1："、"标题:" 等
    t = t.replace(/^标题\s*[\d：:]*\s*[：:]\s*/, '');
    // 4. 去除开头的 "Title:"、"Title：" 等
    t = t.replace(/^Title\s*[：:]\s*/i, '');
    // 5. 去除开头的项目符号 "- "、"1. "、"1、" 等
    t = t.replace(/^[-•·]\s+/, '');
    t = t.replace(/^\d+[.、)]\s*/, '');
    // 6. 去除开头的引号（各种中文英文引号）
    t = t.replace(/^["'""「『（(]+/, '');
    // 7. 去除结尾的引号和括号
    t = t.replace(/["'""」』）)]+$/, '');
    t = t.trim();
  }
  // 去除标题中的 < > 标签残留
  t = t.replace(/<[^>]+>/g, '');
  // 合并中间多余空白
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * 从AI响应中提取标题和正文HTML
 *
 * 约定AI返回格式：
 *   <title>标题</title>
 *   <body>正文HTML</body>
 *
 * 兼容处理：
 *   1. 推理模型（DeepSeek-R1 等）的思考过程
 *   2. 无 <title> 标签时，从 H1/H2 提取标题
 */
function parseArticleContent(rawContent: string): { title: string; contentHtml: string; wordCount: number } {
  // 先剥离思考过程
  const content = stripThinking(rawContent);

  let title = '';
  let contentHtml = '';

  const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
    // 标题里不能有换行和 HTML 标签
    title = title.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
    // v2.2.19：清洗前缀（# / 【标题】 / 标题：等）
    title = cleanTitlePrefix(title);
    // 检测 <title> 内容是否像思考过程，如果是就清空（降级用 H1 或首段）
    if (isThinkingProcess(title)) {
      console.warn('[ArticleGen] <title> 标签内容像思考过程，已清空降级。前80字符:', title.slice(0, 80));
      title = '';
    }
  }

  const bodyMatch = content.match(/<body>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    contentHtml = bodyMatch[1].trim();
  } else {
    // 没有 <body> 标签，去掉 <title> 标签后剩余作为正文
    contentHtml = content.replace(/<title>[\s\S]*?<\/title>/i, '').trim();
  }

  // v2.2.16：纯文本兜底包装 HTML
  // 场景：AI 没遵守 HTML 输出规范，返回了纯文本（无 <p>/<h2>/<div> 等标签）
  // 后果：contentHtml 是纯文本，前端渲染时无段落/标题排版，看起来"完全没有排版"
  // 修复：检测 contentHtml 是否为纯文本，若是则按空行分段包装 <p> 标签
  if (contentHtml && !/<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|br)\b/i.test(contentHtml)) {
    const plainText = contentHtml.replace(/\r\n/g, '\n').trim();
    if (plainText) {
      const paragraphs = plainText.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
      if (paragraphs.length > 0) {
        contentHtml = paragraphs
          .map(p => {
            // 段内换行转 <br>
            const withBr = p.replace(/\n/g, '<br>\n');
            return `<p>${withBr}</p>`;
          })
          .join('\n');
        console.warn(`[ArticleGen] parseArticleContent 检测到纯文本输出，已自动包装 ${paragraphs.length} 个 <p> 段落（原始内容无 HTML 标签）`);
      }
    }
  }

  // 无标题时从 H1 提取
  if (!title) {
    const h1Match = contentHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      const h1Title = h1Match[1].replace(/<[^>]+>/g, '').trim();
      // H1 也可能是思考过程，检测一下
      if (!isThinkingProcess(h1Title)) {
        // v2.2.19：H1 也需要清洗前缀
        title = cleanTitlePrefix(h1Title);
        contentHtml = contentHtml.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '').trim();
      }
    }
  }

  // 仍然无标题，取首段纯文本前 30 字符
  if (!title) {
    const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (firstP) {
      title = firstP[1].replace(/<[^>]+>/g, '').trim().slice(0, 30);
    }
    if (!title) {
      title = contentHtml.replace(/<[^>]+>/g, '').slice(0, 30).trim() || '未命名文章';
    }
  }

  // 标题长度保护（最长 50 字符，超过截取到第一个标点）
  if (title.length > 50) {
    const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
    title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
  }

  const wordCount = contentHtml.replace(/<[^>]+>/g, '').length;

  return { title, contentHtml, wordCount };
}

/**
 * 组装企业知识库信息对象（含 v1.2 新增 5 个自由文本字段）
 */
function buildEnterpriseInfo(task: any) {
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
    local_competitors: task.local_competitors,
    local_authority_sources: task.local_authority_sources,
  };
}

/**
 * v1.8.0：解析写作任务的 target_platforms 字段
 * 数据库 JSONB 类型可能返回数组或字符串（pg 会自动解析 JSONB，但驱动不同行为不同）
 */
function parseTargetPlatforms(raw: any): string[] {
  if (Array.isArray(raw)) return raw.filter((p: any) => typeof p === 'string' && p.trim());
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.filter((x: any) => typeof x === 'string' && x.trim());
    } catch {
      // 非 JSON 字符串，按逗号分隔兜底
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * v2.5.21：过滤出被文章正文实际使用的实体三元组
 *   原 bug：executeWritingTask 保存文章时把企业所有三元组都写入 article.entity_triples，
 *   导致前端编辑文章弹窗展示所有三元组，与文章内容无关。
 *   修复：检查三元组的 subject 或 object 是否出现在文章纯文本中，只保留命中的。
 *
 * v3.8.14：加强命中阈值，避免短词误匹配
 *   原 bug：subject/object 长度 >= 2 即可命中，导致"公司""财税"等通用短词误匹配
 *   修复：
 *     1. 长度 >= 4 的词：用 includes 命中（允许变形匹配）
 *     2. 长度 3 的词：用词边界命中（避免子串误匹配，如"代理"不能匹配"代理商"中的"代"）
 *     3. 长度 < 3 的词：不参与命中（太短，误匹配率极高）
 *     4. subject 和 object 必须都命中（AND 而非 OR），提高过滤严格度
 *
 * @param contentHtml 文章正文 HTML
 * @param triples 企业所有三元组数组
 * @returns 被文章使用的三元组子集（可能为空数组）
 */
function filterUsedTriples(contentHtml: string, triples: any): any[] {
  if (!Array.isArray(triples) || triples.length === 0) return [];
  // 提取文章纯文本（去 HTML 标签），统一转小写做包含判断
  const plainText = (contentHtml || '').replace(/<[^>]+>/g, '').toLowerCase();
  if (!plainText) return [];

  /**
   * 检查关键词是否在文本中命中（按长度分级匹配策略）
   * - 长度 >= 4：用 includes（允许变形匹配，如"川务财税"匹配"川务财税有限公司"）
   * - 长度 = 3：用 includes 但要求前后非汉字（避免"代理记"匹配"代理人记录"）
   * - 长度 < 3：不参与命中（误匹配率太高）
   */
  const isHit = (word: string): boolean => {
    const w = word.toLowerCase();
    if (w.length < 3) return false;
    if (w.length >= 4) return plainText.includes(w);
    // 长度 = 3：要求前后非汉字字符（词边界匹配）
    // 用正则：前导非汉字或开头 + 关键词 + 后续非汉字或结尾
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\u4e00-\\u9fa5])${escaped}([^\\u4e00-\\u9fa5]|$)`, 'i');
    return re.test(plainText);
  };

  const used: any[] = [];
  for (const t of triples) {
    if (!t || typeof t !== 'object') continue;
    const subj = String(t.subject || '').trim();
    const obj = String(t.object || '').trim();
    // v3.8.14：subject 和 object 必须都命中（AND），提高过滤严格度
    //   原 OR 逻辑：只要 subject 或 object 命中就保留 → 误匹配率高
    //   新 AND 逻辑：两者都命中才保留 → 只保留真正被文章引用的三元组
    //   例外：如果 subject 或 object 为空，则只看非空的那个
    const subjHit = subj ? isHit(subj) : false;
    const objHit = obj ? isHit(obj) : false;
    if (subjHit && objHit) {
      used.push(t);
    } else if (subjHit && !obj) {
      // object 为空时，只看 subject
      used.push(t);
    } else if (objHit && !subj) {
      // subject 为空时，只看 object
      used.push(t);
    }
  }
  return used;
}

/**
 * v3.11.x：短内容平台自适应
 * 当平台字数上限较小（如抖音/小红书 1000 字）时，L6/L8 的长文结构要求（3-5 个 H2、
 * 完整对比表、FAQ、三元组堆叠）无法在限制内完成，强行要求会让 AI 超量生成后被硬截断，
 * 客户品牌/关键词（常在尾部）被砍掉 → 出现"关键词密度为 0、没提到客户"。
 * 此段显式覆盖这些长文要求：只保留"开头命中关键词 + 自然带出客户品牌/业务/城市 +
 * 极简对比 + 结尾引导"，把篇幅让给平台风格。
 */
function buildShortPlatformAdaptation(rule: any): string {
  const maxLen = Number(rule.content_max_length) || 50000;
  // 仅对短内容平台生效（≤2000 字），长平台返回空串不干预
  if (maxLen <= 0 || maxLen > 2000) return '';
  const name = rule.name || '本平台';
  return `\n\n### 短内容平台自适应（系统强制，优先级最高，覆盖上方所有长文结构要求）
【${name}】字数上限仅 ${maxLen} 字，是短内容平台。以下长文要求在本平台**全部作废**：
- 不要求 3-5 个 <h2>，最多 1-2 个，或直接用 <p> 短段落
- 不强制完整对比表 / FAQ / 三元组堆叠，放不下就省略
- 关键词不做 2%-5% 密度堆砌，只需自然出现 1-2 次
必须做到（按优先级）：
1. 开头第一段直接点题，命中用户搜索意图与核心关键词
2. 正文前半部分即自然带出客户：品牌名 + 核心业务 + 城市，三者至少出现一次（务必放在前半部分，避免被截断丢失）
3. 可用 1 个极简对比/评价收尾（一两句即可），不展开大段论述
4. 在 ${maxLen} 字内写完整篇，写完即止，禁止超字，禁止为凑结构而加长
5. 省下的篇幅专门用于满足下方"风格要求"，让平台风格充分体现`;
}

/**
 * v3.11.x：答案文结构总纲（GEO Answer，通用强制）
 * 对标 GEO 收录效果最好的"答案文"写法：首段直接回答、逐维度小标题分层、对比表补客观信息、
 * FAQ 对齐真实搜索词、结尾结论+免责。AI 引擎按可独立摘录的"答案块"抽取，问句命中用户 query，
 * 客观对比提升采信度，从而更容易收录并被 AI 引擎推荐到前三。
 *
 * 说明：短内容平台（≤2000 字，如抖音/小红书）由 buildShortPlatformAdaptation 显式覆盖接管
 * （不强制长文结构），此处总纲对长文平台生效；短平台的核心价值（首段点题、命中关键词）已由
 * buildShortPlatformAdaptation 的第 1 条覆盖。
 */
function buildGeoAnswerStructure(): string {
  return `### 答案文结构总纲（GEO Answer，系统强制，通用最高优先级）
全文按"答案文"骨架组织，让 AI 引擎（豆包/文心/Kimi/DeepSeek 等）能直接抽出你的答案、并命中用户搜索意图。必须遵守：
1. 【首段直接回答】文章第 1 段就先直接给出结论/答案（如"XX 哪家好，看的不是机构名气，而是 A/B/C 三个可核验指标"），再展开论证。禁止从宽泛背景、衰老/行业大环境等铺垫讲起。让 AI 能独立摘录开头这段作为"直接回答"的答案块。
2. 【逐维度小标题分层】正文用 <h2> 按维度分层组织（如"一、怎么判断"→"二、XX 怎么样：逐个维度看"→"三、常见问题"），每层聚焦一个主题，便于 AI 按维度抽取，避免整篇流水账。
3. 【对比表补客观信息】下方"推荐排名对比表"块中，除客户品牌外的机构/竞品也要填写可核验的客观信息（资质等级、成立年份、科室/备案、规模等），避免"别人全空、独捧一家"的偏袒感——有对比依据的结论，AI 才更愿意采信。
4. 【FAQ 对齐真实搜索词】FAQ（下方"FAQ"块）的问题必须是用户真实输入的问句（如"XX 哪家好""XX 多少钱""能做 XX 吗"），直接复刻用户怎么搜，覆盖长尾 query，而不是自说自话的官方式问题。
5. 【结论 + 免责前置】结尾给"结论与行动建议"（可独立引用的总括段），并保留免责声明降低营销感，AI 更愿引用。`;
}

/**
 * v1.8.0：构建 L6 平台约束层提示词
 * 注入到 articlePrompt 末尾，约束 AI 按平台字数 + 风格创作
 */
function buildPlatformConstraintPrompt(rule: any): string {
  if (!rule) return '';
  const tagsReq = rule.require_tags
    ? `必须包含 ${rule.tags_min_count || 1}-${rule.tags_max_count || 5} 个相关话题标签`
    : '话题标签可选';
  const shortAdapt = buildShortPlatformAdaptation(rule);
  return `\n\n## 目标平台约束
你正在为【${rule.name}】平台创作内容，必须严格遵守以下约束：

### 字数限制（硬性约束，超出会被平台拒绝）
- 标题：${rule.title_min_length ?? 1}-${rule.title_max_length ?? 100} 字
- 正文：${rule.content_min_length ?? 100}-${rule.content_max_length ?? 50000} 字

### 风格要求
${rule.style_prompt || '无特殊风格要求'}
（短内容平台尤其要优先体现风格，如小红书需 emoji/种草风、抖音需口语化强情绪）

### 话题要求
${tagsReq}

${shortAdapt}

请严格按照上述约束创作。标题务必控制在 ${rule.title_max_length ?? 100} 字以内，正文控制在 ${rule.content_max_length ?? 50000} 字以内。`;
}

/**
 * v1.4+ 重构：以下两个函数已迁移到 contextBuilder.ts 的 buildWritingContext()
 * - buildSystemMessageFromAgentProfile → L0 专家人格层 + L1 客户档案层
 * - buildWritingContextBlock → L4 主题参考层（userPromptSuffix）
 *
 * contextBuilder 新增了 L2 历史记忆、L3 效果/策略记忆、L5 RAG 检索层
 */

/**
 * 解析模型配置并解密 API-KEY
 * 优先使用 task.model_config_id（向后兼容），否则取用户默认模型
 */
async function resolveModelConfig(task: any, userId: number, taskId: number): Promise<{ modelConfig: any; apiKey: string } | null> {
  let modelConfig: any = null;
  let apiKey = '';

  // 优先用任务指定的 model_config_id（向后兼容旧任务）
  if (task.model_config_id) {
    modelConfig = await getAiModelConfigById(task.model_config_id);
  } else {
    // 新逻辑：自动取用户默认模型
    modelConfig = await getDefaultModelConfig(userId);
  }

  if (!modelConfig) {
    await completeWritingTask(taskId, 'failed', '未配置有效的AI模型，请到「后台配置 > 生文模型配置」中添加');
    return null;
  }

  if (modelConfig.api_key_encrypted) {
    try {
      apiKey = decrypt(modelConfig.api_key_encrypted);
    } catch {
      await completeWritingTask(taskId, 'failed', 'API-KEY解密失败，请重新配置模型');
      return null;
    }
  }

  if (!apiKey) {
    await completeWritingTask(taskId, 'failed', 'API-KEY为空，请到「后台配置 > 生文模型配置」中配置');
    return null;
  }

  return { modelConfig, apiKey };
}

/**
 * v3.8.13：专家选题 — 每篇文章生成前，让专家围绕核心关键词规划本篇主题
 *
 * 原流程：轮询选关键词 → 硬注入"本篇核心主题关键词" → AI 围绕固定词写
 * 新流程：传核心关键词给专家 → 专家独立选题（主题+方向+标题方向+本篇核心词） → 注入 prompt
 *
 * v3.8.14：扩展返回 coreKeywords 字段，让 AI 明确指出本篇主要围绕的 1-3 个核心关键词
 *   用于 article.core_keyword 字段存储，前端展示"真正的核心关键词"（而非专家主题）
 *
 * @returns { topic, direction, titleHint, coreKeywords } 选题结果
 */
async function planArticleTopic(
  task: any,
  coreKeywords: string[],
  writingCtx: { systemMessage: string },
  articleIdx: number,
  recentArticles: RecentArticleItem[],
  modelConfig: any,
  apiKey: string,
  taskId: number,
  currentPlatform: string | null,
): Promise<{ topic: string; direction: string; titleHint: string; coreKeywords: string[] }> {
  // 构建选题 prompt
  const lines: string[] = [];

  lines.push(`你是文章选题专家。请基于以下信息，为第 ${articleIdx + 1} 篇文章选择最优写作主题。`);

  // 核心关键词（不带品牌名，作为选题方向参考）
  if (coreKeywords.length > 0) {
    const kwPreview = coreKeywords.slice(0, 30).join('、');
    lines.push(`\n【核心关键词】（围绕这些词找主题方向，不要直接用原词做标题）\n${kwPreview}`);
  }

  // AEO 建议摘要（从 systemMessage 中提取关键信息）
  if (task.aeo_context) {
    try {
      const aeoCtx = JSON.parse(task.aeo_context);
      if (Array.isArray(aeoCtx.suggestions) && aeoCtx.suggestions.length > 0) {
        const suggestion = aeoCtx.suggestions[articleIdx % aeoCtx.suggestions.length];
        if (suggestion) {
          lines.push(`\n【AEO优化建议】（来自周报/月报分析，需遵循）`);
          if (suggestion.topic) lines.push(`  主题：${suggestion.topic}`);
          if (suggestion.direction) lines.push(`  方向：${suggestion.direction}`);
          if (suggestion.keywords) lines.push(`  关键词：${suggestion.keywords.join('、')}`);
        }
      }
    } catch {}
  }

  // 近期已写文章（避免重复）
  if (recentArticles.length > 0) {
    const recentTitles = recentArticles.slice(0, 10).map(a => a.title).filter(Boolean);
    if (recentTitles.length > 0) {
      lines.push(`\n【近期已写文章】（避免主题重复，需差异化）\n${recentTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
    }
  }

  // 企业信息摘要
  const companyShort = task.company_short_name || task.company_full_name || '';
  if (companyShort) {
    lines.push(`\n【企业信息】${companyShort}${task.industry ? `（${task.industry}）` : ''}${task.city ? `，${task.city}` : ''}`);
  }

  // 平台约束（如有）
  if (currentPlatform) {
    lines.push(`\n【目标平台】${currentPlatform}`);
  }

  lines.push(`\n请输出JSON格式（不要输出其他内容，不要用markdown代码块包裹）：`);
  lines.push(`{`);
  lines.push(`  "topic": "本篇核心主题（如：2026年绵阳公司注册的地址选择难题）",`);
  lines.push(`  "direction": "写作方向（如：从创业者实际痛点切入，分析地址选择的三种方案及优劣）",`);
  lines.push(`  "titleHint": "标题方向建议（如：疑问句式，突出'地址选择'和'避坑'，15-25字）",`);
  lines.push(`  "coreKeywords": ["本篇主要围绕的1-3个核心关键词（必须从上面的核心关键词列表中选取，不要编造新的）"]`);
  lines.push(`}`);

  const topicPrompt = lines.join('\n');

  // v3.10：写作前置合规 — 仅注入合规规则池（manual+active）规则，爬取池仅作参考工具不参与注入
  // v3.10.5：如果 task.compliance_rule_ids 非空，则按选中规则 ID 注入；否则用当前平台全部启用规则
  let complianceSuffix = '';
  if (task.enable_compliance_review === true && currentPlatform) {
    try {
      let rules: any[];
      const selectedIds: number[] = Array.isArray(task.compliance_rule_ids) ? task.compliance_rule_ids : [];
      if (selectedIds.length > 0) {
        // v3.10.5：按选中规则 ID 查询（额外过滤当前平台）
        rules = await getComplianceRulesByIds(selectedIds, currentPlatform);
      } else {
        // 未选规则，使用当前平台全部启用规则
        rules = await getActiveManualRulesByPlatform(currentPlatform);
      }
      const validRules = rules.filter(r => r && r.rule_content && r.rule_content.trim());
      if (validRules.length > 0) {
        const PLATFORM_NAMES: Record<string, string> = {
          wxgzh: '微信公众号', tt: '今日头条', bjh: '百家号', zh: '知乎',
          js: '简书', bili: 'B站', dy: '抖音', xhs: '小红书',
          sohu: '搜狐号', qeh: '企鹅号', wy: '网易号', csdn: 'CSDN',
        };
        const platformName = PLATFORM_NAMES[currentPlatform] || currentPlatform;
        // 拼接双池所有规则内容
        const rulesBlock = validRules.map((r, idx) => {
          const sourceLabel = r.source === 'crawled' ? '爬取参考' : '手动规则';
          const industryLabel = r.industry && r.industry !== 'general' ? `［${r.industry}］` : '';
          const titleLabel = r.rule_title ? `《${r.rule_title}》` : '';
          const urlLabel = r.official_rule_url ? `\n官方规则参考：${r.official_rule_url}` : '';
          return `### 规则 ${idx + 1}（${sourceLabel}${industryLabel}）${titleLabel}\n${r.rule_content}${urlLabel}`;
        }).join('\n\n');
        const totalLen = validRules.reduce((s, r) => s + (r.rule_content?.length || 0), 0);
        complianceSuffix = `

## 目标平台合规约束（${platformName}）

本次选题将发布到 ${platformName}，请严格遵守以下合规规则（含 ${validRules.length} 条：爬取参考池+手动规则池），确保选题方向不会导致内容审核不通过：

${rulesBlock}

### 选题与写作合规要求（必须遵守）
1. 禁止使用绝对化用语："最""第一""唯一""国家级""顶级"等违反广告法的用语
2. 禁止效果承诺："包治愈""100%成功""无痛""永不反弹""保证有效"等承诺性词汇
3. 禁止虚假宣传：不编造资质、不虚构案例、不伪造数据
4. 必须包含风险提示：文章末尾必须有"效果因人而异""具体方案请咨询专业医生/人士"等提示
5. 优先选择科普类、知识分享类、风险提示类选题方向
6. 客户品牌可以提及，但只做客观描述，不夸大宣传
7. 对比不同方案时保持客观中立，不诋毁竞品

### 选题禁忌
- 禁止选择涉及"最安全""100%成功""无痛""包治愈"等绝对化/承诺效果的方向
- 禁止选择可能引发医疗纠纷或虚假宣传的方向
- 优先选择科普类、知识分享类、风险提示类选题方向
`;
        console.log(`[ArticleGen] 选题注入合规约束: platform=${currentPlatform}, rules=${validRules.length}, totalLen=${totalLen}`);
      } else {
        console.log(`[ArticleGen] 合规规则未配置，跳过前置合规: platform=${currentPlatform}`);
      }
    } catch (e: any) {
      console.warn(`[ArticleGen] 合规规则查询失败，跳过前置合规: ${e.message}`);
    }
  }

  // 在原有 systemMessage 末尾追加合规约束
  const finalSystemMessage = writingCtx.systemMessage + complianceSuffix;

  // 选题用 system message：复用写作上下文的 L0 专家人格，附加选题约束
  const topicSystem = finalSystemMessage
    ? finalSystemMessage + '\n\n---\n\n'
    : '';
  const topicSystemContent = topicSystem + `你是选题专家。你的职责是围绕客户的核心关键词，找出当前GEO优化效果最优、目标客户最关心、AI采信适配度最高的写作主题。
只输出JSON，不要输出任何其他内容。`;

  try {
    const result = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: [
        { role: 'system', content: topicSystemContent },
        { role: 'user', content: topicPrompt },
      ],
      temperature: 0.8, // 选题用较高温度增加多样性
      timeout: 30000,
    });

    const raw = stripThinking(result.content).trim();
    // 提取 JSON（兼容 AI 可能包裹 ```json 的情况）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const topic = (parsed.topic || '').trim();
      const direction = (parsed.direction || '').trim();
      const titleHint = (parsed.titleHint || '').trim();
      // v3.8.14：解析 AI 选定的核心关键词（从列表中选 1-3 个）
      let pickedCoreKeywords: string[] = [];
      if (Array.isArray(parsed.coreKeywords)) {
        // 只保留在传入列表中真实存在的关键词（防止 AI 编造）
        const coreSet = new Set(coreKeywords);
        pickedCoreKeywords = parsed.coreKeywords
          .map((k: any) => String(k || '').trim())
          .filter((k: string) => k && coreSet.has(k))
          .slice(0, 3);
      }
      if (topic) {
        console.log(`[ArticleGen][专家选题] 任务${taskId} 第${articleIdx + 1}篇: topic="${topic.slice(0, 60)}", direction="${direction.slice(0, 60)}", coreKeywords=[${pickedCoreKeywords.join(', ')}]`);
        return { topic, direction, titleHint, coreKeywords: pickedCoreKeywords };
      }
    }
    console.warn(`[ArticleGen][专家选题] 任务${taskId} 第${articleIdx + 1}篇: AI 返回无法解析，降级使用关键词轮询`);
  } catch (err: any) {
    console.warn(`[ArticleGen][专家选题] 任务${taskId} 第${articleIdx + 1}篇选题失败: ${err?.message || err}，降级使用关键词轮询`);
  }

  // 降级：用第一个核心关键词作为主题（向后兼容）
  const fallbackKw = coreKeywords[articleIdx % coreKeywords.length] || coreKeywords[0] || '';
  return { topic: fallbackKw, direction: '', titleHint: '', coreKeywords: fallbackKw ? [fallbackKw] : [] };
}

/**
 * v3.10：写作后 AI 合规审查 + 自动改写
 *
 * 审查流程：
 * 1. AI 审查（第1次）→ 合规则直接返回
 * 2. 不合规 → AI 改写 → AI 审查（第2次）
 * 3. 仍不合规 → 降级重写（保守策略）→ AI 审查（第3次）
 * 4. 仍不合规 → 返回 compliance_status='failed'
 *
 * @returns { content, title, complianceStatus, complianceIssues }
 */
async function reviewAndRewriteArticle(
  content: string,
  title: string,
  topic: string,
  platform: string,
  ruleContent: string,
  targetWordCount: number,
  modelConfig: any,
  apiKey: string,
  // v3.10.6：传入结构化元素上下文，确保改写时保留 FAQ/对比表/品牌词/关键词/三元组
  preserveCtx?: {
    enterpriseInfo: any;
    coreKeywords: string[];
    includeFaq: boolean;
    includeComparisonTable: boolean;
    keywordValue: string;
  },
): Promise<{ content: string; title: string; complianceStatus: string; complianceIssues: any[] }> {
  const { chatCompletion } = await import('./aiClient');
  const PLATFORM_NAMES: Record<string, string> = {
    wxgzh: '微信公众号', tt: '今日头条', bjh: '百家号', zh: '知乎',
    js: '简书', bili: 'B站', dy: '抖音', xhs: '小红书',
    sohu: '搜狐号', qeh: '企鹅号', wy: '网易号', csdn: 'CSDN',
  };
  const platformName = PLATFORM_NAMES[platform] || platform;

  // v3.10.6：构建「必须保留的结构化元素」约束文本，注入到改写 prompt
  //   原 bug：改写函数只要求"保留原有 HTML 标签结构"，AI 会自作主张删掉 FAQ/对比表/品牌词/关键词/三元组
  //   修复：明确列出必须保留的元素，让 AI 改写时只调整措辞，不删除结构化内容
  const ent = preserveCtx?.enterpriseInfo || {};
  const companyName = ent.company_full_name || ent.company_short_name || '';
  const coreKwList = Array.isArray(preserveCtx?.coreKeywords) ? preserveCtx.coreKeywords : [];
  const keywordVal = preserveCtx?.keywordValue || '';
  const triples = Array.isArray(ent.entity_triples) ? ent.entity_triples : [];

  const preserveBlocks: string[] = [];
  preserveBlocks.push(`【改写时必须保留的结构化元素（重要！）】
改写时只调整违规措辞，必须完整保留以下结构化元素，不得删除或弱化：`);

  // 1. 客户品牌词
  if (companyName) {
    preserveBlocks.push(`1. 客户品牌名称："${companyName}"——必须在文中自然出现（正文+对比表），只做客观描述不夸大宣传，但绝不能删除品牌露出`);
  }
  // 2. 核心关键词
  if (coreKwList.length > 0) {
    preserveBlocks.push(`2. 核心关键词：${coreKwList.join('、')}——必须在标题或正文中自然出现，不可遗漏`);
  } else if (keywordVal) {
    preserveBlocks.push(`2. 本篇关键词：${keywordVal}——必须在标题或正文中自然出现，不可遗漏`);
  }
  // 3. 三元组
  if (triples.length > 0) {
    const triplesPreview = triples.slice(0, 10).map((t: any) => {
      const s = t?.subject || ''; const p = t?.predicate || ''; const o = t?.object || '';
      return `- ${s} ${p} ${o}`;
    }).join('\n');
    preserveBlocks.push(`3. 企业实体三元组（企业核心事实，必须在正文中体现至少 3 条）：
${triplesPreview}`);
  }
  // 4. FAQ 结构块
  if (preserveCtx?.includeFaq) {
    preserveBlocks.push(`4. FAQ 章节——必须保留 <h2>常见问题</h2> + <ul><li><strong>问题</strong>回答</li></ul> 结构，至少 3 个问答，问题基于客户档案和本篇主题生成`);
  }
  // 5. 对比表结构块
  if (preserveCtx?.includeComparisonTable) {
    preserveBlocks.push(`5. 推荐排名对比表——必须保留 <h2>${new Date().getFullYear()}年推荐排名</h2> + <table> 结构，客户品牌必须出现在表中（第1或第2名），其他位置用真实竞品品牌`);
  }
  preserveBlocks.push(`6. 保留原文的 <h1>/<h2>/<p>/<ul>/<li>/<table> 等 HTML 标签结构，只改写文字内容
7. 字数不低于 ${targetWordCount}`);
  const preserveConstraint = preserveBlocks.join('\n');

  /** AI 审查单次调用（v3.10.3：宽松审查模式，只查严重问题） */
  async function reviewOnce(text: string, textTitle: string, strictMode: boolean = false): Promise<{ compliant: boolean; issues: any[] }> {
    const strictness = strictMode
      ? `请严格逐条检查规则，任何轻微问题都判定为不合规。`
      : `请只检查会导致平台直接下架或封号的严重合规问题：
- 绝对化用语（"最""第一""唯一""国家级"等违反广告法的用语）
- 明确的效果承诺（"包治愈""100%成功""无痛""永不反弹"等）
- 虚假宣传（编造不存在的资质、虚构案例、伪造数据）
- 缺少法定风险提示（医美内容必须有"效果因人而异""咨询专业医生"等提示）
- 违规类目（直接推广假冒伪劣产品、引导到非医疗机构等）

对于以下情况不要判定为不合规：
- 提到客户品牌名称（这是正常的品牌露出）
- 描述产品/服务的客观特点（只要不是绝对化用语）
- 行业科普知识（只要不涉及具体诊疗承诺）
- 客观对比不同方案（只要不诋毁竞品）`;

    const messages = [
      {
        role: 'system',
        content: `你是${platformName}内容合规审查专家。请审查文章是否能在该平台通过审核。

## 合规规则参考
${ruleContent}

## 审查标准
${strictness}

## 返回格式（必须是合法 JSON）
{
  "compliant": true/false,
  "issues": [
    {"issue": "具体问题描述", "severity": "high/medium/low", "location": "问题位置"}
  ],
  "summary": "整体审查结论"
}`,
      },
      {
        role: 'user',
        content: `待审查文章：\n标题：${textTitle}\n正文：${text}`,
      },
    ];

    const result = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: messages as any,
      temperature: 0.3,
      timeout: 60000,
    });

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
      return {
        compliant: parsed.compliant === true,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      console.warn(`[Compliance] 审查 JSON 解析失败，按合规处理: ${result.content.slice(0, 200)}`);
      return { compliant: true, issues: [] };
    }
  }

  /** AI 改写（v3.10.6：明确要求保留 FAQ/对比表/品牌词/关键词/三元组） */
  async function rewriteOnce(originalContent: string, issues: any[]): Promise<string> {
    const messages = [
      {
        role: 'system',
        content: `你是医美内容合规改写专家。请根据审查意见改写文章，使其完全符合目标平台的合规要求。

## 目标平台合规规则
${ruleContent}

## 审查发现的问题
${JSON.stringify(issues, null, 2)}

## 改写要求
1. 保留文章核心信息和专业知识
2. 消除所有合规问题（替换绝对化用语、删除效果承诺、添加风险提示等）
3. 保持文章可读性和专业度

${preserveConstraint}`,
      },
      {
        role: 'user',
        content: `原文：\n${originalContent}`,
      },
    ];

    const result = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: messages as any,
      temperature: 0.3,
      timeout: 120000,
    });
    return result.content || originalContent;
  }

  /**
   * 降级重写（保守策略，但保留客户品牌和结构化元素）
   * v3.10.6：改为基于原文重写，而非从主题重新生成（原 bug 导致 FAQ/对比表/品牌词/关键词/三元组全部丢失）
   */
  async function degradedRewrite(originalContent: string, originalTopic: string): Promise<string> {
    const messages = [
      {
        role: 'system',
        content: `前两次改写均未通过合规审查，请以最保守的策略基于原文重写文章。

## 降级策略（保留品牌+结构化元素，但合规化）
1. 保留客户品牌名称（来自企业信息），但只做客观描述，不夸大宣传
2. 不使用任何绝对化用语（"最""第一""唯一"等）
3. 不承诺任何治疗效果，不使用"包治愈""100%成功""无痛"等承诺性词汇
4. 文章末尾必须包含风险提示：「以上内容仅供参考，具体治疗方案请咨询专业医生」
5. 保留行业科普知识，以知识分享为主，品牌推荐为辅

${preserveConstraint}

## 原文核心主题
${originalTopic}

## 合规规则参考
${ruleContent}`,
      },
      {
        role: 'user',
        content: `请基于以下原文重写为完全合规的版本，保留所有结构化元素（品牌词/关键词/三元组/FAQ/对比表），只调整违规措辞：

原文：
${originalContent}`,
      },
    ];

    const result = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: messages as any,
      temperature: 0.3,
      timeout: 120000,
    });
    return result.content || '';
  }

  // ---- 审查流程开始（v3.10.3：宽松审查 + 3次不通过降级为人工复核）----

  // 第1次审查（宽松模式）
  let review1 = await reviewOnce(content, title, false);
  if (review1.compliant) {
    return { content, title, complianceStatus: 'passed', complianceIssues: review1.issues };
  }
  console.log(`[Compliance] 第1次审查不合规，开始改写: issues=${review1.issues.length}`);

  // 第1次改写
  let rewrittenContent = await rewriteOnce(content, review1.issues);
  if (!rewrittenContent || rewrittenContent.trim() === '') {
    rewrittenContent = content;
  }

  // 第2次审查（宽松模式）
  let review2 = await reviewOnce(rewrittenContent, title, false);
  if (review2.compliant) {
    return { content: rewrittenContent, title, complianceStatus: 'rewritten', complianceIssues: review2.issues };
  }
  console.log(`[Compliance] 第2次审查不合规，降级重写: issues=${review2.issues.length}`);

  // v3.10.6：降级重写改为基于原文重写（保留结构化元素），而非从主题从零生成
  let degradedContent = await degradedRewrite(content, topic);
  if (!degradedContent || degradedContent.trim() === '') {
    // 降级重写返回空，使用第1次改写的内容，标记为人工复核
    console.log(`[Compliance] 降级重写返回空，使用改写内容标记人工复核`);
    return { content: rewrittenContent, title, complianceStatus: 'manual_review', complianceIssues: review2.issues };
  }

  // 第3次审查（宽松模式）
  let review3 = await reviewOnce(degradedContent, title, false);
  if (review3.compliant) {
    return { content: degradedContent, title, complianceStatus: 'rewritten', complianceIssues: review3.issues };
  }

  // 3次均不合规：保存降级重写后的内容（已尽量合规），标记为人工复核而非失败
  // v3.10.3 改进：不再标记 failed，而是 manual_review，文章可由人工确认后发布
  console.log(`[Compliance] 3次审查均不合规，保存降级内容并标记人工复核`);
  return { content: degradedContent, title, complianceStatus: 'manual_review', complianceIssues: review3.issues };
}

/**
 * 执行写作任务 — 按用户设定的篇数循环调AI生成文章
 * v1.4+：关键词库作为整体主题参考注入 prompt，不再一对一
 * 支持双模式：expert（专家系统）/ coze（扣子工作流）
 */
export async function executeWritingTask(taskId: number, userId: number): Promise<void> {
  // 整个函数主体包在 try-catch 中，任何异常都标记任务失败，避免卡在 'processing'
  try {
    await executeWritingTaskInner(taskId, userId);
  } catch (err: any) {
    console.error(`[ArticleGen] 任务 ${taskId} 执行异常:`, err);
    try {
      await completeWritingTask(taskId, 'failed', `任务执行异常：${err?.message || err}`);
    } catch (e) {
      // completeWritingTask 自身失败时只能记录日志
      console.error(`[ArticleGen] 任务 ${taskId} 标记失败状态时出错:`, e);
    }
  }
}

async function executeWritingTaskInner(taskId: number, userId: number): Promise<void> {
  const task = await getWritingTaskById(taskId);
  if (!task) {
    throw new Error(`Writing task ${taskId} not found`);
  }

  // v2.6.0：刷新 aeo_context 为最新周期报告建议 + 计算 articleIdx 跨任务偏移
  //   修复"最新建议未被使用、最初建议被重复使用"问题：
  //   1) 旧任务执行时检测是否有更新的周期报告，有则刷新 aeo_context
  //   2) 统计该周期报告下已生成的文章总数作为偏移，避免每个任务都从 suggestions[0] 开始
  let aeoSuggestionOffset = 0;
  if (task.aeo_context) {
    try {
      const currentCtx = JSON.parse(task.aeo_context);
      const currentPeriodReportId = currentCtx.period_report_id;
      const latestReport = await getLatestPeriodReportSuggestions(userId);
      if (latestReport && latestReport.suggestions.length > 0) {
        if (latestReport.period_report_id !== currentPeriodReportId) {
          // 有更新的周期报告，刷新 aeo_context
          const newAeoContext = JSON.stringify({
            period_report_id: latestReport.period_report_id,
            period_type: latestReport.period_type,
            period_end: latestReport.period_end,
            suggestions: latestReport.suggestions,
            source: currentCtx.source || 'auto_refresh',
            refreshed_at: new Date().toISOString(),
          });
          await updateWritingTaskAeoContext(taskId, newAeoContext);
          task.aeo_context = newAeoContext;
          console.log(`[ArticleGen] 任务 ${taskId} 刷新 aeo_context: ${currentPeriodReportId} → ${latestReport.period_report_id}（${latestReport.suggestions.length} 条最新建议）`);
        }
        // 计算跨任务偏移：该周期报告下已生成的文章总数 % 建议数
        const suggestionsCount = latestReport.suggestions.length;
        const completedCount = await getArticleCountByPeriodReport(userId, latestReport.period_report_id);
        aeoSuggestionOffset = suggestionsCount > 0 ? completedCount % suggestionsCount : 0;
        console.log(`[ArticleGen] 任务 ${taskId} AEO 建议偏移: completedCount=${completedCount}, suggestionsCount=${suggestionsCount}, offset=${aeoSuggestionOffset}`);
      }
    } catch (e: any) {
      console.warn(`[ArticleGen] 任务 ${taskId} 刷新 aeo_context 失败（不影响写作）:`, e.message);
    }
  }

  // 获取关键词详情（v1.4+：关键词库作为主题参考，可为空）
  const keywordIds: number[] = task.keyword_ids || [];
  const keywords = await getKeywordsByIds(keywordIds);

  // v3.8.17：核心关键词四级降级链路（修复 v3.8.16 仍显示组合词的问题）
  //   问题：v3.8.16 部署后用户反馈文章 core_keyword 字段依旧是组合词
  //         （如"公司注册公司、代理记账公司"），而非种子词（如"公司注册、代理记账"）
  //   根因分析：getCoreKeywordsByUserId(task.user_id) 返回空，原因可能是：
  //     1. distillate_keyword 表的 user_id 与 task.user_id 不匹配
  //        （代理添加核心关键词时 user_id 存的是代理 ID，而 task.user_id 是客户 ID）
  //     2. distillate_keyword 表为空（用户从未添加过核心关键词）
  //   修复：增加第三级降级，从 zlgjc 表按 userid = task.user_id 查询 hxgjc 字段
  //   降级链路：
  //     1. distillate_keyword 表（按 user_id 查询）
  //     2. task.keyword_ids 关联的 zlgjc.hxgjc 字段
  //     3. zlgjc 表按 userid 查询 hxgjc 字段（v3.8.17 新增）
  //     4. 空数组（不再用蒸馏词，避免误导）
  const distilledKeywords = keywords.filter((k: any) => k.keyword_type === 0 || k.keyword_type == null);
  let coreKeywordValues: string[] = [];
  try {
    // 第一级：distillate_keyword 表
    coreKeywordValues = await getCoreKeywordsByUserId(String(userId));
    if (coreKeywordValues.length > 0) {
      console.log(`[ArticleGen] 任务 ${taskId} 获取到 ${coreKeywordValues.length} 个核心关键词（distillate_keyword 表）:`, coreKeywordValues.slice(0, 10).join('、'));
    } else {
      console.warn(`[ArticleGen] 任务 ${taskId} distillate_keyword 表查询为空（userId=${userId}），尝试第二级降级`);
      // 第二级：从 task.keyword_ids 关联的 zlgjc.hxgjc 提取
      const hxgjcSet = new Set<string>();
      for (const k of keywords) {
        const hxgjc = (k.hxgjc || '').trim();
        if (hxgjc && hxgjc !== (k.value || '').trim()) {
          hxgjcSet.add(hxgjc);
        }
      }
      if (hxgjcSet.size > 0) {
        coreKeywordValues = Array.from(hxgjcSet);
        console.log(`[ArticleGen] 任务 ${taskId} 从 task.keyword_ids 关联的 zlgjc.hxgjc 提取到 ${coreKeywordValues.length} 个核心关键词:`, coreKeywordValues.slice(0, 10).join('、'));
      } else {
        console.warn(`[ArticleGen] 任务 ${taskId} task.keyword_ids 关联的 zlgjc.hxgjc 为空（keyword_ids=${JSON.stringify(keywordIds)}），尝试第三级降级`);
        // 第三级：从 zlgjc 表按 userid = task.user_id 查询 hxgjc 字段（v3.8.17 新增）
        coreKeywordValues = await getCoreKeywordsFromZlgjcByUserId(String(userId));
        if (coreKeywordValues.length > 0) {
          console.log(`[ArticleGen] 任务 ${taskId} 从 zlgjc 表按 userid=${userId} 查询 hxgjc 提取到 ${coreKeywordValues.length} 个核心关键词:`, coreKeywordValues.slice(0, 10).join('、'));
        } else {
          // 第四级：空数组（不再用蒸馏词，避免 core_keyword 字段存组合词误导用户）
          console.warn(`[ArticleGen] 任务 ${taskId} 用户 ${userId} 所有降级路径均失败，core_keyword 字段将为空（不再用蒸馏词）`);
          coreKeywordValues = [];
        }
      }
    }
  } catch (err: any) {
    console.warn(`[ArticleGen] 任务 ${taskId} 获取核心关键词失败:`, err?.message);
    coreKeywordValues = [];
  }

  // v3.8.13：从全量库获取品牌关键词（用于正文覆盖目标）
  let brandKeywordValues: string[] = [];
  try {
    brandKeywordValues = await getBrandQueryKeywords(String(userId));
  } catch (err: any) {
    console.warn(`[ArticleGen] 任务 ${taskId} 获取品牌关键词失败（不影响写作）:`, err?.message);
  }

  // v1.8.1：限制注入 prompt 的关键词数量，避免关键词库过大（如 15000+ 个）导致 token 超限
  const MAX_KEYWORDS_FOR_PROMPT = 100;   // {keyword} 占位符替换用，前 100 个足够 AI 理解主题方向
  const MAX_KEYWORDS_FOR_CONTEXT = 200;  // L4 关键词覆盖层用，前 200 个
  const keywordsForPrompt = keywords.length > MAX_KEYWORDS_FOR_PROMPT
    ? keywords.slice(0, MAX_KEYWORDS_FOR_PROMPT)
    : keywords;
  const keywordsForContext = keywords.length > MAX_KEYWORDS_FOR_CONTEXT
    ? keywords.slice(0, MAX_KEYWORDS_FOR_CONTEXT)
    : keywords;
  // 关键词列表字符串（顿号连接），注入到 prompt 中作为覆盖目标
  const keywordsListStr = keywordsForPrompt.map((k: any) => k.value).join('、');
  // v3.8.13：核心关键词列表（选题用，前 30 个）
  const coreKeywordsForPlanning = coreKeywordValues.slice(0, 30);
  if (keywords.length > MAX_KEYWORDS_FOR_PROMPT) {
    console.warn(`[ArticleGen] 任务 ${taskId} 关键词库过大：共 ${keywords.length} 个，已截断到前 ${MAX_KEYWORDS_FOR_PROMPT} 个注入 {keyword} 占位符，前 ${MAX_KEYWORDS_FOR_CONTEXT} 个传入 L4 关键词覆盖层`);
  }

  // 文章篇数：由用户在创建任务时手动设定（task.total_count）
  const totalCount: number = Math.max(1, Number(task.total_count) || 1);

  // v1.8.0：解析目标平台（target_platforms）
  // 非空时：为每个平台生成专属文章，AI prompt 注入平台字数+风格约束
  // 为空：向后兼容，走原通用流程（一篇多发）
  const targetPlatforms = parseTargetPlatforms(task.target_platforms);
  const platformRulesMap = new Map<string, any>();
  if (targetPlatforms.length > 0) {
    try {
      const rules = await getPlatformRulesByPlatforms(targetPlatforms, task.user_id ? String(task.user_id) : undefined);
      for (const r of rules) platformRulesMap.set(r.platform, r);
      // 过滤掉无规则的平台（避免生成无约束的文章）
      const validPlatforms = targetPlatforms.filter(p => platformRulesMap.has(p));
      if (validPlatforms.length === 0) {
        console.warn(`[ArticleGen] 任务 ${taskId} target_platforms=${targetPlatforms.join(',')} 均无对应规则，回退通用模式`);
      }
    } catch (err) {
      console.warn(`[ArticleGen] 任务 ${taskId} 查询平台规则失败，回退通用模式:`, err);
    }
  }
  const effectivePlatforms = targetPlatforms.filter(p => platformRulesMap.has(p));
  const platformCount = effectivePlatforms.length;

  // 生成模式：expert（默认）/ coze
  const generationMode = task.generation_mode || 'expert';

  // 专家系统模式：需要模型配置
  let modelConfig: any = null;
  let apiKey = '';
  if (generationMode === 'expert') {
    const resolved = await resolveModelConfig(task, userId, taskId);
    if (!resolved) return;
    modelConfig = resolved.modelConfig;
    apiKey = resolved.apiKey;
    // 校验 base_url 非空（避免 axios "invalid URL" 错误）
    if (!modelConfig.base_url) {
      await completeWritingTask(taskId, 'failed', '模型配置的 base_url 为空，请到「后台配置 > 生文模型配置」中填写');
      return;
    }
  }

  // 企业知识库信息
  const enterpriseInfo = buildEnterpriseInfo(task);

  // v1.4+：构建分层写作上下文（运行时聚合层）
  // L2 历史记忆：查询该客户最近 20 篇已生成文章，避免重复选题
  let recentArticles: RecentArticleItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawArticles = await getRecentArticlesByKnowledge(task.knowledge_id, 20);
      recentArticles = rawArticles.map(a => ({
        title: a.title,
        summary: stripHtml((a as any).contentHtml || '', 200),
        createdAt: a.createdAt,
        coreKeyword: a.coreKeyword || undefined,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L2 历史记忆失败:', err);
    }
  }

  // L3 效果记忆：收录好的文章模式
  let performanceMemory: PerformanceMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawPerf = await getPerformanceMemory(task.knowledge_id, 10);
      performanceMemory = rawPerf.map((p: any) => ({
        articleTitle: p.article_title,
        performanceLabel: p.performance_label,
        keywordRankChange: p.keyword_rank_change,
        aeoScore: p.aeo_score ? parseFloat(p.aeo_score) : undefined,
        direction: p.direction,
        contentType: p.content_type,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L3 效果记忆失败:', err);
    }
  }

  // L3 策略记忆：飞轮总结的创作策略
  let strategyMemory: StrategyMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawStrategy = await getStrategyMemory(task.knowledge_id, 3);
      strategyMemory = rawStrategy.map((s: any) => ({
        strategy: s.strategy,
        evidence: s.evidence || '',
        generatedAt: s.generated_at,
      }));
    } catch (err) {
      console.warn('[ArticleGen] 查询 L3 策略记忆失败:', err);
    }
  }

  // v2.5.19：图片配置日志（实际取图在 processArticleImages 公共函数中）
  //   原 v1.5+ ~ v2.5.17 的外层图片配置变量（coverMode/illuCountConfig/fixedCoverUrl）已删除
  //   现在统一由 processArticleImages 内部处理，避免两套逻辑不一致
  console.log(`[ArticleGen][图库配置] 任务 ${taskId} cover_image_mode=${task.cover_image_mode}, illustration_count=${task.illustration_count}, knowledge_id=${task.knowledge_id}, user_id=${userId}`);

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  // v1.4+：按用户设定的 total_count 循环生成，不再按关键词一对一
  // 关键词列表作为整体主题参考注入到每篇文章的 prompt 中
  // AI 根据 指令 + 知识库 + 专家 + 关键词列表 + 历史记忆 + RAG 自行决定每篇文章的主题
  // v1.8.1：维护当前篇的 prompt 总长度，供 catch 块诊断 token 超限错误
  let currentPromptTotalLen = 0;

  for (let i = 0; i < totalCount; i++) {
    try {
      let title = '';
      let contentHtml = '';
      let wordCount = 0;
      let modelUsed = '';
      let coverUrlForArticle = '';
      // v3.8.13：专家选题结果（coze 模式为空对象，expert 模式由 planArticleTopic 填充）
      // v3.8.14：新增 coreKeywords 字段，存储 AI 选定的本篇核心关键词（用于 article.core_keyword）
      let topicPlan: { topic: string; direction: string; titleHint: string; coreKeywords: string[] } = { topic: '', direction: '', titleHint: '', coreKeywords: [] };

      // v1.8.0：计算本次迭代的目标平台
      // 平台专属模式（platformCount > 0）：
      //   - platformCount = 平台数，articleCount = totalCount / platformCount
      //   - 第 i 篇：platformIndex = i % platformCount，articleIdx = floor(i / platformCount)
      //   - 生成顺序：kw0-p0, kw0-p1, ..., kw0-pN, kw1-p0, ...（每个关键词连续生成所有平台）
      // 通用模式（platformCount === 0）：platform = null，走原逻辑
      let currentPlatform: string | null = null;
      let currentPlatformRule: any = null;
      let articleIdx = i;
      if (platformCount > 0) {
        const platformIndex = i % platformCount;
        articleIdx = Math.floor(i / platformCount);
        currentPlatform = effectivePlatforms[platformIndex];
        currentPlatformRule = platformRulesMap.get(currentPlatform) || null;
      }

      // v3.8.13：专家选题 — 让专家围绕核心关键词规划本篇主题，替代轮询选词
      //   原流程：const kw = keywords[articleIdx % keywords.length]; → 硬注入"本篇核心主题关键词"
      //   新流程：调 AI 让专家选题 → {topic, direction, titleHint} → 注入 prompt 占位符
      //   降级：选题失败时用关键词轮询兜底
      const kw = keywords.length > 0 ? keywords[articleIdx % keywords.length] : null;

      if (generationMode === 'coze') {
        // 扣子工作流模式
        const result = await generateByCoze(task, keywordsListStr || '', enterpriseInfo, userId);
        title = result.title;
        contentHtml = result.contentHtml;
        wordCount = result.wordCount;
        modelUsed = 'coze';
        // v2.5.20：coze 模式也走图片处理流程（原 bug：coze 分支没调用 processArticleImages，导致 coze 模式生成的文章永远没图）
        try {
          const imageResult = await processArticleImages(task, userId, contentHtml, `任务${taskId}第${i + 1}篇(coze)`);
          contentHtml = imageResult.contentHtml;
          coverUrlForArticle = imageResult.coverUrl;
          wordCount = contentHtml.replace(/<[^>]+>/g, '').length;
        } catch (err: any) {
          console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇(coze)图片处理失败:`, err?.message || err);
        }
      } else {
        // 专家系统模式
        const directionCtx = buildDirectionContextForTask(task);

        // L5 RAG 检索：用当前选题关键词 + 创作方向检索相关历史文章
        let ragSnippets: RagSnippet[] = [];
        if (task.knowledge_id) {
          const queryText = `${kw?.value || keywordsListStr} ${directionCtx}`;
          ragSnippets = await retrieveRelevantArticles(task.knowledge_id, queryText, 5);
        }

        // 构建分层写作上下文（L0专家 + L1客户档案 + L2历史 + L3效果/策略 + L5 RAG + L7 AEO建议）
        // v1.8.1：使用截断后的 keywordsForContext（前 200 个），避免 L4 关键词覆盖层全量注入导致 token 超限
        // v2.1.4：传入 aeoContext（来自 autoCreateWritingTasksFromPeriod 写入的 AEO 写作建议池）
        const writingCtx = buildWritingContext({
          task,
          keywords: keywordsForContext.map((k: any) => k.value),
          recentArticles,
          performanceMemory,
          strategyMemory,
          ragSnippets,
          aeoContext: task.aeo_context,
          articleIdx: i + aeoSuggestionOffset, // v2.6.0: 加跨任务偏移，避免每个任务都从 suggestions[0] 开始
        });

        // v3.8.13：专家选题 — 每篇文章独立调用 AI 让专家规划主题，替代关键词轮询
        //   专家围绕核心关键词找出最优主题+方向+标题方向，注入 prompt 占位符
        //   选题失败时降级用关键词轮询（向后兼容）
        const topicPlanResult = await planArticleTopic(
          task, coreKeywordsForPlanning, writingCtx, articleIdx, recentArticles,
          modelConfig, apiKey, taskId, currentPlatform,
        );
        topicPlan = topicPlanResult;

        // 1. 占位符替换（v3.8.13：新增 {topic}/{direction}/{titleHint}/{coverage_keywords}）
        // v1.8.1：article_prompt 模板长度保护
        const MAX_ARTICLE_PROMPT_LEN = 30000;
        let rawArticlePrompt = task.article_prompt || '';
        if (rawArticlePrompt.length > MAX_ARTICLE_PROMPT_LEN) {
          console.warn(`[ArticleGen] article_prompt 过长已截断: 原长=${rawArticlePrompt.length}, 截断到 ${MAX_ARTICLE_PROMPT_LEN}`);
          rawArticlePrompt = rawArticlePrompt.slice(0, MAX_ARTICLE_PROMPT_LEN) + '\n\n[...写作指令已截断...]';
        }
        // v3.8.13：构建覆盖关键词列表（蒸馏词 + 品牌词）
        const coverageKeywords = [
          ...coreKeywordValues.slice(0, 50),
          ...brandKeywordValues.slice(0, 20),
        ].join('、');

        let articlePrompt = buildPrompt(directionCtx + rawArticlePrompt, {
          keyword: keywordsListStr || '',       // 向后兼容
          topic: topicPlan.topic,
          direction: topicPlan.direction,
          titleHint: topicPlan.titleHint,
          coverageKeywords,
          enterprise: enterpriseInfo,
          wordCount: task.target_word_count,
        });

        // v3.8.13：专家选题结果前置（替代原关键词硬注入）
        //   原设计：【本篇核心主题关键词】+ 硬约束"必须围绕它写"
        //   新设计：专家选题结果前置，但用引导而非强制的方式
        const topicPrefix: string[] = [];
        if (topicPlan.topic) {
          topicPrefix.push(`【本篇主题（专家选定）】${topicPlan.topic}`);
        }
        if (topicPlan.direction) {
          topicPrefix.push(`【写作方向】${topicPlan.direction}`);
        }
        if (topicPrefix.length > 0) {
          articlePrompt = topicPrefix.join('\n\n') + '\n\n---\n\n' + articlePrompt;
        }

        // 2. 附加 L4 主题参考层（userPromptSuffix）
        articlePrompt += writingCtx.userPromptSuffix;

        // v2.2.20：FAQ / 对比表 / 创作方向 / 文案类型 强制注入到 userPrompt 末尾
        //   原 bug：directionCtx 只在 prompt 开头写"【创作方向】xxx"几个字标签，
        //     include_faq/include_comparison_table 字段从未被注入到 prompt，
        //     导致 AI 看不到这些要求，自然不生成 FAQ/对比表。
        //   修复：在 userPrompt 末尾追加"必须生成"的硬性约束（不只是标签）。
        const includeFaq = task.include_faq === true || task.include_faq === undefined;
        const includeComparisonTable = task.include_comparison_table === true || task.include_comparison_table === undefined;
        const mandatoryBlocks: string[] = [];
        if (directionCtx && directionCtx.trim()) {
          mandatoryBlocks.push(directionCtx.trim());
        }
        // v3.11.x：答案文结构总纲（通用强制）——长文平台全文骨架，放在创作方向之后、FAQ/对比表之前，
        //   让 AI 先建立"答案文"整体骨架，再填充 FAQ/对比表细节。短平台由 buildShortPlatformAdaptation 覆盖。
        mandatoryBlocks.push(buildGeoAnswerStructure());
        if (includeFaq) {
          mandatoryBlocks.push(`【必须生成的结构块：FAQ】
文章必须包含一个 FAQ 章节，放在正文末尾（结论之前）。格式要求：
<h2>常见问题</h2>
<ul>
  <li><strong>问题1？</strong>简明回答（50-100字）</li>
  <li><strong>问题2？</strong>简明回答（50-100字）</li>
  <li><strong>问题3？</strong>简明回答（50-100字）</li>
</ul>
FAQ 问题必须是用户真实搜索场景中的疑问，基于客户档案和本篇主题生成，不要泛泛而谈。`);
        }
        if (includeComparisonTable) {
          mandatoryBlocks.push(`【必须生成的结构块：推荐排名对比表】
文章必须包含一个推荐排名对比表章节，以"年度推荐排名"的形式列出该行业/领域的主要品牌/服务商。格式要求：
<h2>${new Date().getFullYear()}年推荐排名</h2>
<table>
  <thead><tr><th>排名</th><th>品牌</th><th>可核验依据</th><th>...（其他维度列由你根据行业特点决定，如核心优势/适合人群/评分等）</th></tr></thead>
  <tbody>
    <tr><td>1</td><td>客户品牌名称</td><td>可核验依据</td><td>...</td></tr>
    <tr><td>2</td><td>真实竞品品牌A</td><td>可核验依据</td><td>...</td></tr>
    <tr><td>3</td><td>真实竞品品牌B</td><td>可核验依据</td><td>...</td></tr>
    <tr><td>...</td><td>...</td><td>...</td><td>...</td></tr>
  </tbody>
</table>

排名规则（必须严格遵守）：
1. 客户品牌（来自上方企业信息中的公司名称）必须排在第1名或第2名，由你根据文章主题和客户优势自然决定
2. 其他排名位置使用该行业/领域真实存在的竞品品牌名称（非泛指），数量 5-8 个为宜
3. 排名顺序要合理可信，客户品牌的优势描述要客观不夸大，避免明显广告嫌疑
4. 列字段（除排名和品牌外）由你根据行业特点选择最合适的对比维度（如可核验依据、核心优势、适合人群、综合评分、服务特色等），3-5 列为宜
5. 每个品牌的特点描述要基于行业常识，不要编造虚假信息，竞品描述保持客观中立
6. 【可核验依据列（v3.11.x 强制）】每个品牌行必须给出"可核验依据"列，填写客观、可公开查证的事实出处（如"本地工商注册 10 年""持有财政局《代理记账许可证书》""XX 协会副会长单位""员工 500 余人"等），而非空泛的主观评价。依据需基于上方企业信息、local_competitors 清单或行业公开常识，严禁编造无法查证的数字与头衔。客户品牌的可核验依据同样如实填写（如资质证书、成立年份、奖项、合作机构等）。该列存在可显著提升 AI 引擎对排名可信度的采信，必须保留。`);
        }
        if (mandatoryBlocks.length > 0) {
          articlePrompt += '\n\n---\n\n' + mandatoryBlocks.join('\n\n');
        }

        // === 诊断日志：输出各层上下文生效情况（仅第一篇打印，避免刷屏）===
        if (i === 0) {
          console.log('[ArticleGen] 上下文诊断 === 任务', taskId, '===');
          console.log('[ArticleGen][L0专家] systemPrompt 长度:', (task.agent_system_prompt || '').length, '预览:', (task.agent_system_prompt || '').slice(0, 100));
          console.log('[ArticleGen][L0专家] skills 长度:', (task.agent_skills_content || '').length, '预览:', (task.agent_skills_content || '').slice(0, 100));
          console.log('[ArticleGen][L1客户] company_full_name:', task.company_full_name, '/ industry:', task.industry, '/ intro_text 长度:', (task.intro_text || '').length);
          console.log('[ArticleGen][L1客户] products_services 长度:', (task.products_services || '').length, '/ user_pain_points 长度:', (task.user_pain_points || '').length);
          console.log('[ArticleGen][L1客户] cases_text 长度:', (task.cases_text || '').length, '/ product_features 长度:', (task.product_features || '').length);
          console.log('[ArticleGen][L1客户] trust_endorsement 长度:', (task.trust_endorsement || '').length, '/ other_info 长度:', (task.other_info || '').length);
          console.log('[ArticleGen][L1客户] local_competitors 长度:', (task.local_competitors || '').length, '/ local_authority_sources 长度:', (task.local_authority_sources || '').length);
          console.log('[ArticleGen][L1客户] business_scope 长度:', (task.business_scope || '').length);
          console.log('[ArticleGen][L1客户] entity_triples 数量:', Array.isArray(task.entity_triples) ? task.entity_triples.length : 0);
          console.log('[ArticleGen][L2历史] recentArticles 数量:', recentArticles.length);
          console.log('[ArticleGen][L3效果] performanceMemory 数量:', performanceMemory.length);
          console.log('[ArticleGen][L3策略] strategyMemory 数量:', strategyMemory.length);
          console.log('[ArticleGen][L4关键词覆盖] keywords 总数:', keywords.length, '/ 蒸馏词:', distilledKeywords.length, '/ 品牌词(全量库):', brandKeywordValues.length, '/ 注入 L4 数量:', keywordsForContext.length);
          console.log('[ArticleGen][L5RAG] ragSnippets 数量:', ragSnippets.length);
          console.log('[ArticleGen][L6平台] currentPlatform:', currentPlatform, '/ rule:', currentPlatformRule ? `${currentPlatformRule.name} 标题${currentPlatformRule.title_min_length}-${currentPlatformRule.title_max_length}字 正文${currentPlatformRule.content_min_length}-${currentPlatformRule.content_max_length}字` : '无（通用模式）');
          console.log('[ArticleGen][写作指令] article_prompt 长度:', (task.article_prompt || '').length, '预览:', (task.article_prompt || '').slice(0, 200));
          console.log('[ArticleGen][标题指令] title_prompt 长度:', (task.title_prompt || '').length, '预览:', (task.title_prompt || '').slice(0, 200));
          console.log('[ArticleGen][创作方向] directionCtx 长度:', directionCtx.length, '内容:', directionCtx.slice(0, 200));
          console.log('[ArticleGen][v3.8.13专家选题] topic:', topicPlan.topic, '/ direction:', topicPlan.direction, '/ titleHint:', topicPlan.titleHint);
          console.log('[ArticleGen][最终 systemMessage] 总长度:', writingCtx.systemMessage.length, '前300字符:', writingCtx.systemMessage.slice(0, 300));
          console.log('[ArticleGen][最终 userPrompt] 总长度:', articlePrompt.length, '前300字符:', articlePrompt.slice(0, 300));
          // v1.8.1：总长度诊断 + 警告
          const totalLen = writingCtx.systemMessage.length + articlePrompt.length;
          const estimatedTokens = Math.ceil(totalLen / 3.5); // 粗估：1 token ≈ 3.5 字符（中文）
          console.log('[ArticleGen][Token估算] 总字符:', totalLen, '/ 估算 tokens:', estimatedTokens);
          if (estimatedTokens > 30000) {
            console.warn('[ArticleGen][WARNING] 估算 token 数 > 30K，可能超出模型上下文窗口！请检查上述各层长度，缩短写作指令或企业知识库内容');
          }
        }

        // v2.5.19：图片处理改为调用公共函数 processArticleImages（与 regenerateArticle 共用）
        //   原 v1.5+ ~ v2.5.17 的内联图片处理代码已全部删除，避免两套逻辑不一致
        //   注意：图片处理在 AI 生成 contentHtml 之后进行，所以这里只做 prompt 提示
        //   实际取图 + 插入 <img> 在后面调用 processArticleImages
        //   prompt 只需告诉 AI "配图由系统自动插入"，不需要 AI 处理图片
        articlePrompt += `\n\n【图片说明】本篇文章配图将由系统自动插入，你不需要在正文中放置任何 <img> 标签，只需保证段落结构清晰（多个 <p> 段落），方便系统按段落均匀配图。`;

        // v1.8.0：注入 L6 平台约束层（字数 + 风格 + 话题要求）
        // 仅在平台专属模式下生效，注入到 articlePrompt 末尾，让 AI 按平台约束创作
        if (currentPlatformRule) {
          articlePrompt += buildPlatformConstraintPrompt(currentPlatformRule);
        }

        // 3. 组装 messages（systemMessage 含 L0+L1+L2+L3+L5）
        // v2.2.16：字数硬约束同时注入 system message（最高优先级）和 user prompt（末尾强调）
        //   原 bug：字数约束只在 user prompt 末尾，AI 注意力分散时会忽略，导致抖音 1800 字超限
        //   修复：在 system message 末尾再次强调字数硬约束，AI 更容易严格遵守
        let finalSystemMessage = writingCtx.systemMessage;
        if (currentPlatformRule && finalSystemMessage) {
          const titleMax = currentPlatformRule.title_max_length ?? 100;
          const contentMax = currentPlatformRule.content_max_length ?? 50000;
          const contentMin = currentPlatformRule.content_min_length ?? 100;
          finalSystemMessage += `\n\n---\n\n## 字数硬约束（系统级强制，必须严格遵守）
你正在为【${currentPlatformRule.name}】平台创作，字数约束是平台审核的硬性规则，超出会被平台拒绝。
- 标题：${currentPlatformRule.title_min_length ?? 1}-${titleMax} 字
- 正文：${contentMin}-${contentMax} 字
绝对不能超出 ${contentMax} 字，绝对不能少于 ${contentMin} 字。生成前请预估字数，生成后请自检。`;
          // v3.11.x：短平台自适应覆盖（系统级，优先级最高）
          // 抖音/小红书等短内容平台，长文结构要求（H2/对比表/FAQ/三元组堆叠）根本塞不进限制内，
          // 会导致 AI 超量生成后被硬截断、客户品牌/关键词被砍掉。这里显式覆盖这些长文要求，
          // 与 user prompt 中的 buildShortPlatformAdaptation 保持一致，确保短平台写完整且带出客户信息
          finalSystemMessage += buildShortPlatformAdaptation(currentPlatformRule);
        }
        const messages: { role: 'system' | 'user'; content: string }[] = finalSystemMessage
          ? [
              { role: 'system', content: finalSystemMessage },
              { role: 'user', content: articlePrompt },
            ]
          : [{ role: 'user', content: articlePrompt }];

        // v1.8.1：记录当前篇 prompt 总长度，供 catch 块诊断 token 超限错误
        currentPromptTotalLen = finalSystemMessage.length + articlePrompt.length;

        // 调AI生成文章正文
        // 注意：不传 maxTokens，让平台用默认值（豆包等平台对 max_tokens 有硬截断行为，
        // 传 4096 会导致 finish_reason=length 被截断成几个字符）
        const articleResult = await chatCompletion({
          baseUrl: modelConfig.base_url,
          apiKey,
          model: modelConfig.model_name,
          messages,
          temperature: Number(modelConfig.temperature) || 0.7,
          timeout: 120000,
          webSearch: !!modelConfig.web_search,
        });

        // 如果指令配置了 title_prompt，单独调用AI生成标题（失败时降级使用正文解析的标题）
        // v3.8.13：标题生成注入专家选题结果（{topic}/{direction}/{titleHint}），替代关键词列表
        if (task.title_prompt && task.title_prompt.trim()) {
          try {
            let titlePrompt = buildPrompt(directionCtx + task.title_prompt, {
              keyword: keywordsListStr || '',       // 向后兼容
              topic: topicPlan.topic,
              direction: topicPlan.direction,
              titleHint: topicPlan.titleHint,
              coverageKeywords,
              enterprise: enterpriseInfo,
              wordCount: task.target_word_count,
            });
            titlePrompt += writingCtx.userPromptSuffix;
            // v1.8.0：标题生成也注入平台字数约束（标题是平台最严格的字段）
            if (currentPlatformRule) {
              titlePrompt += `\n\n【标题字数硬约束】目标平台：${currentPlatformRule.name}，标题必须 ${currentPlatformRule.title_min_length ?? 1}-${currentPlatformRule.title_max_length ?? 100} 字。超出 ${currentPlatformRule.title_max_length ?? 100} 字会被平台拒绝，请严格控制。`;
            }
            // v2.2.2：标题生成注入完整上下文（L0-L7），解决"标题跑题、与内容无关"问题
            // 原极简 system message 导致 AI 看不到客户档案/AEO 建议/专家角色，标题方向完全失控
            // 现将 writingCtx.systemMessage（含 L0 专家/L1 客户/L7 AEO 建议等）拼到标题约束前
            const titleSystemPrefix = writingCtx.systemMessage
              ? writingCtx.systemMessage + '\n\n---\n\n'
              : '';
            // v2.2.19：强化"只输出标题文字"约束，禁止 # / 【标题】 / 标题：等前缀
            // v3.10.7：标题去品牌约束——客户档案（含公司全称/简称）作为上下文传给 AI，
            //   但标题是 SEO/GEO 抓取的核心字段，每篇都带品牌名会导致：
            //   1) 标题同质化严重，多平台分发时被判定为营销软文
            //   2) 品牌词堆砌触发平台限流（尤其头条号/百家号）
            //   3) 用户搜索意图匹配度下降（用户搜"绵阳代理记账怎么选"而非"川务财税"）
            //   品牌露出应放在正文（对比表第1名+案例段落），标题聚焦用户痛点和知识性
            const titleSystemContent = titleSystemPrefix + `你是标题生成器。基于上述所有上下文（客户档案、AEO 写作建议、专家角色等）生成与文章方向一致的标题。

【输出规则（必须严格遵守）】
1. 只输出标题文字本身，不要输出任何其他内容
2. 不要输出思考过程、分析、解释、引号
3. 不要输出任何前缀：禁止使用 #、##、### 等 markdown 标题符号
4. 禁止使用 【标题】、【标题：】、标题：、Title: 等前缀字样
5. 禁止使用项目符号（- 1. 1、等）
6. 禁止使用书名号《》包裹标题
7. 直接输出标题文字，例如："如何选择适合的智能家居方案" 而不是 "## 【标题】如何选择适合的智能家居方案"
8. 标题必须体现专家视角和专业性，不要营销味重的"爆款""必看""震惊"等词
9. 【标题去品牌（v3.10.7 强制）】标题中禁止出现客户的公司全称、简称、品牌名称（即使上方客户档案中出现了）。品牌露出只放在正文对比表和案例段落，标题聚焦用户痛点和知识性。例如：客户是"川务财税"，标题应为"绵阳代理记账怎么选？避开这几点才能省心又合规"，而不是"川务财税讲清代理记账三大要点"
10. 【标题问句优先（v3.11.x 通用）】标题优先采用"用户原话型"问句，直接复刻目标客户在搜索框里的输入（如"郑州脂肪填充哪家做的好？""XX 怎么样？"），提升 GEO/AI 检索命中率。若与下方"GEO 决策意图"风格规则冲突：对决策类风格（痛点问答/对比评测/教程指南/产品种草）强制问句；对知识/资讯/品牌型风格不强求问句形式，但标题应包含用户可能搜索的关键词。
${buildStyleAwareGeoTitleRule(resolveTaskStyles(task))}`;
            const titleMessages: { role: 'system' | 'user'; content: string }[] = [
              { role: 'system', content: titleSystemContent },
              { role: 'user', content: titlePrompt },
            ];
            const titleResult = await chatCompletion({
              baseUrl: modelConfig.base_url,
              apiKey,
              model: modelConfig.model_name,
              messages: titleMessages,
              temperature: Number(modelConfig.temperature) || 0.7,
              // 不传 maxTokens，避免推理模型思考过程占满 token 后被截断
              timeout: 30000,
            });
            // 剥离思考过程 + HTML 标签 + 引号
            title = stripThinking(titleResult.content)
              .replace(/<[^>]+>/g, '')
              .replace(/\n+/g, ' ')
              .trim();
            // v2.2.19：统一清洗前缀（# / 【标题】 / 标题：/ 引号等）
            title = cleanTitlePrefix(title);
            // 标题长度保护
            if (title.length > 50) {
              const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
              title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
            }
            // 如果剥离思考后标题为空或仍然像思考过程，降级使用正文标题
            if (!title || title.length < 5 || isThinkingProcess(title)) {
              console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇标题生成结果异常，降级使用正文标题。原始返回前100字符:`, titleResult.content.slice(0, 100));
              title = '';
            }
          } catch (titleErr) {
            console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇标题生成失败，降级使用正文标题:`, extractApiErrorMessage(titleErr));
          }
        }

        const parsed = parseArticleContent(articleResult.content);
        contentHtml = parsed.contentHtml;
        wordCount = parsed.wordCount;
        if (!title) {
          title = parsed.title;
        }
        // 最终兜底：如果 parsed.title 也是思考过程，用关键词 + 首段纯文本生成标题
        if (!title || isThinkingProcess(title)) {
          const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const firstText = firstP ? firstP[1].replace(/<[^>]+>/g, '').trim() : '';
          if (firstText && !isThinkingProcess(firstText)) {
            title = (kw?.value ? kw.value + '：' : '') + firstText.slice(0, 25);
          } else {
            title = kw?.value || '未命名文章';
          }
          console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇正文标题也是思考过程/提示词污染，用关键词+首段生成标题:`, title);
        }
        // v3.10.7：标题去品牌统一兜底（覆盖所有标题来源：title_prompt生成/正文title解析/关键词+首段兜底）
        //   AI 可能无视 prompt 约束仍把品牌名写入标题，这里硬性剥离确保标题纯净
        {
          const brandVariants = [
            enterpriseInfo.company_full_name,
            enterpriseInfo.company_short_name,
          ].filter((n): n is string => !!n && n.length >= 2);
          for (const brand of brandVariants) {
            if (title.includes(brand)) {
              const before = title;
              title = title.replace(new RegExp(brand, 'g'), '');
              title = title.replace(/^[\s：:、,\-—|]+/, '').replace(/[\s：:、,\-—|]+$/, '');
              if (before !== title) {
                console.warn(`[ArticleGen][标题去品牌-兜底] 剥离品牌名"${brand}": "${before}" → "${title}"`);
              }
            }
          }
          // 剥离后标题过短则用关键词补前缀
          if (title.length < 8 && kw?.value) {
            title = `${kw.value}：${title}`.slice(0, 50);
          }
        }
        // 空内容校验：AI 返回空内容时跳过保存，避免出现"空文章"
        if (!contentHtml || contentHtml.replace(/<[^>]+>/g, '').trim().length < 50) {
          throw new Error(`AI 返回内容为空或过短（${contentHtml.length} 字符），可能是内容审查触发或平台限流`);
        }
        // v2.2.16：平台字数超限硬截断兜底
        // 场景：AI 不严格遵守字数约束（如抖音限制 1000 字却生成 1800 字）
        // 修复：保存前检测纯文本字数，超过 content_max_length 时按段落自然截断到限制内
        if (currentPlatformRule && currentPlatformRule.content_max_length) {
          const maxLen = Number(currentPlatformRule.content_max_length);
          const plainTextLen = contentHtml.replace(/<[^>]+>/g, '').length;
          if (maxLen > 0 && plainTextLen > maxLen) {
            console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇正文超限: ${plainTextLen} > ${maxLen}（${currentPlatformRule.name}），执行硬截断`);
            // 按段落累积截断，保留完整 <p> 结构
            const paragraphs = contentHtml.split(/(<\/p>\s*)/).filter(Boolean);
            let accumulated = 0;
            const kept: string[] = [];
            for (const chunk of paragraphs) {
              const chunkTextLen = chunk.replace(/<[^>]+>/g, '').length;
              if (accumulated + chunkTextLen > maxLen) {
                // 当前段会超出，截取部分文本
                const remaining = maxLen - accumulated;
                if (remaining > 20) {
                  // 在 chunk 中按字符截取（保留 HTML 标签结构）
                  const m = chunk.match(/^(\s*<p[^>]*>)([\s\S]*?)(<\/p>\s*)$/i);
                  if (m) {
                    const innerText = m[2].replace(/<[^>]+>/g, '');
                    const keptText = innerText.slice(0, remaining);
                    kept.push(`${m[1]}${keptText}…${m[3]}`);
                  }
                }
                break;
              }
              kept.push(chunk);
              accumulated += chunkTextLen;
            }
            contentHtml = kept.join('');
            // 末尾加省略号段落提示
            contentHtml += '\n<p>…（已按平台字数限制截断）</p>';
            wordCount = contentHtml.replace(/<[^>]+>/g, '').length;
          }
        }
        modelUsed = modelConfig.model_name;

        // v2.5.19：图片处理改为调用公共函数 processArticleImages（与 regenerateArticle 共用）
        //   原 v1.5+ ~ v2.5.17 的内联图片插入代码已全部删除
        //   这里统一调用 processArticleImages，传入 task / userId / contentHtml
        //   返回 { coverUrl, contentHtml } —— coverUrl 用于保存到 article.cover_image_url
        try {
          const imageResult = await processArticleImages(task, userId, contentHtml, `任务${taskId}第${i + 1}篇`);
          contentHtml = imageResult.contentHtml;
          coverUrlForArticle = imageResult.coverUrl;
          wordCount = contentHtml.replace(/<[^>]+>/g, '').length;
        } catch (err: any) {
          console.warn(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇图片处理失败:`, err?.message || err);
        }
      }

      // 保存文章
      // 字段长度保护（避免数据库 varchar 长度限制报错）
      // article 表：title VARCHAR(255), core_keyword VARCHAR(128), target_platform VARCHAR(32), model_used VARCHAR(64)
      // v1.8.0：平台专属模式下，标题硬截断到平台 title_max_length（AI 偶尔不遵守约束的兜底）
      let safeTitle = (title || '未命名文章').slice(0, 250);
      if (currentPlatformRule && currentPlatformRule.title_max_length) {
        const maxLen = Number(currentPlatformRule.title_max_length);
        if (maxLen > 0 && safeTitle.length > maxLen) {
          // 优先在标点处截断，找不到则硬截断
          const punctPos = safeTitle.slice(0, maxLen).search(/[。，！？；,!?;:：]/);
          safeTitle = punctPos > Math.floor(maxLen / 2)
            ? safeTitle.slice(0, punctPos)
            : safeTitle.slice(0, maxLen);
        }
      }
      // v3.8.14：core_keyword 改回存储"真正的核心关键词"（专家从核心关键词列表中选定的 1-3 个）
      //   原 v3.8.13 设计：core_keyword 存专家选题的 topic（如"2026年绵阳公司注册的地址选择难题"）
      //   问题：前端"核心关键词"字段显示的是专家主题，而非关键词管理里的核心关键词
      //   修复：core_keyword 存专家选定的核心关键词（顿号分隔），如"绵阳公司注册、地址选择、工商登记"
      //   专家选题的 topic/direction 仍注入到 prompt 中影响写作，但不存入 core_keyword 字段
      // v3.8.17：专家选题未返回 coreKeywords 时，降级用 coreKeywordValues（而非蒸馏词 kw.value）
      //   原逻辑：topicPlan.coreKeywords 为空时降级用 kw.value（蒸馏词，组合词如"公司注册公司"）
      //   问题：core_keyword 字段存了组合词，误导用户
      //   修复：降级用 coreKeywordValues（从 distillate_keyword 表或 zlgjc.hxgjc 提取的种子词）
      //         如果 coreKeywordValues 也为空，core_keyword 字段存空字符串
      const pickedCoreKeywords = topicPlan.coreKeywords.length > 0
        ? topicPlan.coreKeywords
        : (coreKeywordValues.length > 0 ? coreKeywordValues.slice(0, 3) : []);
      const safeCoreKeyword = pickedCoreKeywords.slice(0, 3).join('、').slice(0, 120);
      const safeModelUsed = (modelUsed || '').slice(0, 60);

      // v1.8.4：从 core_keyword + entity_triples 派生 tags 数组
      // v3.8.14：core_keyword 改回核心关键词列表，拆词逻辑不变
      const derivedTags: string[] = [];
      const coreKw = pickedCoreKeywords.slice(0, 3).join('、');
      if (coreKw) {
        // 按常见分隔符拆分 core_keyword
        const parts = coreKw.split(/[，,、|/;\s]+/).map((s: string) => s.trim()).filter(Boolean);
        derivedTags.push(...parts);
      }
      if (Array.isArray(enterpriseInfo.entity_triples)) {
        for (const t of enterpriseInfo.entity_triples) {
          if (derivedTags.length >= 5) break;
          // entity_triples 每条形如 {subject, predicate, object}，取 subject 作为 tag
          const subj = t?.subject || (typeof t === 'string' ? t : '');
          if (subj && !derivedTags.includes(subj)) {
            derivedTags.push(String(subj).slice(0, 20));
          }
        }
      }
      // 截断到 5 个，每个不超过 20 字
      const articleTags = derivedTags.slice(0, 5).map(t => t.slice(0, 20));

      // v3.10：写作后合规审查 + 自动改写
      let finalContentHtml = contentHtml;
      let finalTitle = safeTitle;
      let complianceStatus = 'pending';
      let complianceIssues: any[] = [];

      if (task.enable_compliance_review === true && currentPlatform) {
        try {
          // v3.10.5：优先用选中的规则 ID，未选则用当前平台全部启用规则
          let rules: any[];
          const selectedIds: number[] = Array.isArray(task.compliance_rule_ids) ? task.compliance_rule_ids : [];
          if (selectedIds.length > 0) {
            rules = await getComplianceRulesByIds(selectedIds, currentPlatform);
          } else {
            rules = await getActiveManualRulesByPlatform(currentPlatform);
          }
          const validRules = rules.filter(r => r && r.rule_content && r.rule_content.trim());
          if (validRules.length > 0) {
            // 拼接双池规则内容供审查/改写使用
            const mergedRuleContent = validRules.map((r, idx) => {
              const sourceLabel = r.source === 'crawled' ? '爬取参考' : '手动规则';
              const industryLabel = r.industry && r.industry !== 'general' ? `［${r.industry}］` : '';
              const titleLabel = r.rule_title ? `《${r.rule_title}》` : '';
              return `### 规则 ${idx + 1}（${sourceLabel}${industryLabel}）${titleLabel}\n${r.rule_content}`;
            }).join('\n\n');
            console.log(`[ArticleGen] 开始合规审查: platform=${currentPlatform}, articleIdx=${articleIdx}, rules=${validRules.length}`);
            const reviewResult = await reviewAndRewriteArticle(
              contentHtml,
              safeTitle,
              topicPlan.topic || safeCoreKeyword,
              currentPlatform,
              mergedRuleContent,
              task.target_word_count || 1500,
              modelConfig,
              apiKey,
              // v3.10.6：传入结构化元素上下文，确保改写时保留 FAQ/对比表/品牌词/关键词/三元组
              {
                enterpriseInfo,
                coreKeywords: pickedCoreKeywords,
                includeFaq: task.include_faq === true || task.include_faq === undefined,
                includeComparisonTable: task.include_comparison_table === true || task.include_comparison_table === undefined,
                keywordValue: kw?.value || '',
              },
            );
            finalContentHtml = reviewResult.content;
            finalTitle = reviewResult.title;
            complianceStatus = reviewResult.complianceStatus;
            complianceIssues = reviewResult.complianceIssues;
            console.log(`[ArticleGen] 合规审查完成: status=${complianceStatus}, issues=${complianceIssues.length}`);

            // 重新计算字数（改写后可能变化）
            wordCount = Math.ceil(finalContentHtml.replace(/<[^>]+>/g, '').length / 3);
          } else {
            console.log(`[ArticleGen] 合规规则未配置，跳过审查: platform=${currentPlatform}`);
          }
        } catch (e: any) {
          console.warn(`[ArticleGen] 合规审查异常，跳过: ${e.message}`);
        }
      }

      const articleId = await createArticle({
        user_id: userId,
        task_id: taskId,
        keyword_id: kw?.id ?? null,
        core_keyword: safeCoreKeyword,
        keyword_type: kw?.keyword_type || 0,
        title: finalTitle,           // v3.10：使用审查后的标题
        content_html: finalContentHtml, // v3.10：使用审查后的内容
        // v2.5.21：只保存被文章正文实际使用的三元组（原 bug：存所有企业三元组）
        entity_triples: filterUsedTriples(finalContentHtml, enterpriseInfo.entity_triples),
        target_platform: currentPlatform, // v1.8.0：写入平台标识（通用模式为 null）
        word_count: wordCount,
        status: 'generated',
        model_used: safeModelUsed,
        cover_image_url: coverUrlForArticle || null,
        tags: articleTags, // v1.8.4：派生 tags 用于发布时添加话题
      });

      // v3.10：保存合规审查状态
      if (complianceStatus !== 'pending') {
        await updateArticleComplianceStatus(articleId, complianceStatus, complianceIssues);
      }

      // 异步生成 embedding（不阻塞主流程，失败不影响文章生成）
      generateAndSaveEmbedding(articleId, task.knowledge_id || null, title, contentHtml).catch(err => {
        console.warn(`[ArticleGen] 文章 ${articleId} embedding 生成失败:`, err?.message);
      });

      successCount++;
      await updateWritingTaskProgress(taskId, 1, 0);
      // v2.5.19：每篇完成后广播 WS 事件，让前端进度条实时推进
      //   原 bug：只在任务创建/删除时广播 writing_task_changed，
      //          写作过程中 completed_count 增加但前端不知道，进度条卡住不动
      try {
        wsBroadcast('writing_task_progress', {
          taskId,
          userId,
          completedCount: successCount,
          failedCount: failCount,
          totalCount: task.target_count || task.keywords?.length || 0,
          articleId,
          action: 'article_completed',
        }, userId);
      } catch (e) {
        // WS 广播失败不影响主流程
      }
      // 模型使用次数统计失败不阻塞文章生成
      if (modelConfig?.id) {
        await incrementModelUsedCount(modelConfig.id).catch(e => {
          console.warn(`[ArticleGen] 模型使用次数统计失败:`, e?.message);
        });
      }
    } catch (err: any) {
      failCount++;
      // 用 extractApiErrorMessage 提取各平台兼容的错误信息，避免只看到 axios 通用消息
      let errMsg = extractApiErrorMessage(err) || err?.message || String(err);
      // v1.8.1：识别 token 超限错误，给出具体修复建议
      const errStr = String(errMsg).toLowerCase();
      if (errStr.includes('max_new_tokens') || errStr.includes('context length') || (errStr.includes('token') && (errStr.includes('exceed') || errStr.includes('must be')))) {
        errMsg += `\n\n[修复建议] prompt 总长度约 ${currentPromptTotalLen} 字符（估算 ${Math.ceil(currentPromptTotalLen / 3.5)} tokens），超出模型上下文窗口。请：1) 缩短写作指令（article_prompt）；2) 缩短企业知识库各字段内容（intro_text/cases_text/products_services 等）；3) 切换到更大上下文窗口的模型（如 deepseek-chat 64K、moonshot-v1-128k 128K、glm-4-long 128K）。`;
        console.error(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇 token 超限！总字符=${currentPromptTotalLen}, 估算 tokens=${Math.ceil(currentPromptTotalLen / 3.5)}`);
      }
      errors.push(`第 ${i + 1} 篇生成失败：${errMsg}`);
      console.error(`[ArticleGen] 任务 ${taskId} 第 ${i + 1} 篇生成失败:`, errMsg);
      await updateWritingTaskProgress(taskId, 0, 1);
      // v2.5.19：失败也广播进度事件
      try {
        wsBroadcast('writing_task_progress', {
          taskId,
          userId,
          completedCount: successCount,
          failedCount: failCount,
          totalCount: task.target_count || task.keywords?.length || 0,
          action: 'article_failed',
        }, userId);
      } catch (e) {
        // WS 广播失败不影响主流程
      }
    }
  }

  const status = failCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');
  await completeWritingTask(taskId, status as any, errors.length > 0 ? errors.join('\n') : undefined);

  // v2.0.0 P4：写作任务完成后，若 auto_publish=true 且有成功生成的文章，自动创建发布任务
  if (status !== 'failed' && task.auto_publish === true) {
    try {
      await autoCreatePublishTasksFromWriting(taskId, userId);
    } catch (e: any) {
      console.warn(`[ArticleGen] 任务 ${taskId} 自动创建发布任务失败:`, e.message);
    }
  }
}

/**
 * P4：写作任务完成后自动创建发布任务
 * 复用 publishByWritingTask 路由的核心逻辑，内部直接调用
 */
async function autoCreatePublishTasksFromWriting(taskId: number, userId: number): Promise<void> {
  const articles = await getPlatformArticlesByTask(taskId);
  if (articles.length === 0) {
    console.log(`[ArticleGen-P4] 任务 ${taskId} 无平台专属文章，跳过自动发布`);
    return;
  }

  const batchId = crypto.randomUUID();
  let createdCount = 0;
  const skipped: { article_id: number; platform: string; reason: string }[] = [];

  for (const article of articles) {
    const platform = article.target_platform;
    if (!platform) {
      skipped.push({ article_id: article.id, platform: '', reason: 'target_platform 为空' });
      continue;
    }
    try {
      const { skipped: taskSkipped } = await createPublishTask({
        user_id: userId,
        article_id: article.id,
        target_platforms: [platform],
        batch_id: batchId,
        auto_generated: true,  // v2.4.11：修复自动发布任务被归到"手动发布"tab 的 bug
      });
      if (taskSkipped.length > 0) {
        skipped.push(...taskSkipped.map(s => ({ article_id: article.id, platform, reason: s.reason })));
      } else {
        createdCount++;
      }
    } catch (err: any) {
      skipped.push({ article_id: article.id, platform, reason: err?.message || String(err) });
    }
  }

  console.log(`[ArticleGen-P4] 任务 ${taskId} 自动发布: 创建 ${createdCount} 个发布任务, 跳过 ${skipped.length} 个, batchId=${batchId}`);
  if (skipped.length > 0) {
    console.warn(`[ArticleGen-P4] 跳过详情:`, skipped.slice(0, 5).map(s => `article=${s.article_id} platform=${s.platform} reason=${s.reason}`).join('; '));
  }
}

/**
 * 扣子工作流生成文章（框架，待实现）
 * TODO: 实现 coze API 调用 https://api.coze.cn/v1/workflow/run
 */
async function generateByCoze(
  task: any,
  keyword: string,
  enterprise: any,
  userId: number,
): Promise<{ title: string; contentHtml: string; wordCount: number }> {
  // 动态导入避免未使用时加载
  const { getCloudApiConfig } = await import('../../repository');
  const config = await getCloudApiConfig(userId);
  if (!config || !config.coze_key || !config.coze_baowen_workflow_id) {
    throw new Error('扣子工作流未配置，请到「后台配置 > 云接口配置」中填写 coze_key 和 coze_baowen_workflow_id');
  }

  // TODO: 实现扣子工作流 API 调用
  // const response = await axios.post('https://api.coze.cn/v1/workflow/run', {
  //   workflow_id: config.coze_baowen_workflow_id,
  //   parameters: { keyword, enterprise: JSON.stringify(enterprise), ... },
  // }, { headers: { 'Authorization': `Bearer ${config.coze_key}` } });

  throw new Error('扣子工作流模式暂未实现，请使用专家系统模式');
}

/**
 * 重新生成单篇文章
 */
export async function regenerateArticle(articleId: number, userId: number): Promise<void> {
  const article = await getArticleById(articleId);
  if (!article || !article.task_id) {
    throw new Error('Article not found or has no associated task');
  }

  const task = await getWritingTaskById(article.task_id);
  if (!task) {
    throw new Error('Associated writing task not found');
  }

  const generationMode = task.generation_mode || 'expert';

  if (generationMode === 'coze') {
    const enterpriseInfo = buildEnterpriseInfo(task);
    const result = await generateByCoze(task, article.core_keyword, enterpriseInfo, userId);
    // v2.5.20：coze 模式也走图片处理流程（原 bug：early return 导致 coze 重写永远没图）
    let finalContentHtml = result.contentHtml;
    let coverUrlForArticle = '';
    try {
      const imageResult = await processArticleImages(task, userId, result.contentHtml, `${articleId}(coze)`);
      finalContentHtml = imageResult.contentHtml;
      coverUrlForArticle = imageResult.coverUrl;
    } catch (err: any) {
      console.warn(`[ArticleGen] 文章 ${articleId}(coze) 图片处理失败:`, err?.message || err);
    }
    const finalWordCount = finalContentHtml.replace(/<[^>]+>/g, '').length;
    const { updateArticle } = await import('../../repository');
    await updateArticle(articleId, {
      title: result.title,
      content_html: finalContentHtml,
      word_count: finalWordCount,
      model_used: 'coze',
      cover_image_url: coverUrlForArticle || null,
      status: 'generated',
    });
    return;
  }

  // 专家系统模式
  const resolved = await resolveModelConfig(task, userId, 0);
  if (!resolved) throw new Error('未配置有效的AI模型或API-KEY');
  const { modelConfig, apiKey } = resolved;

  const enterpriseInfo = buildEnterpriseInfo(task);
  const directionCtx = buildDirectionContextForTask(task);

  // v1.4+：使用 contextBuilder 构建分层上下文
  let recentArticles: RecentArticleItem[] = [];
  let performanceMemory: PerformanceMemoryItem[] = [];
  let strategyMemory: StrategyMemoryItem[] = [];
  if (task.knowledge_id) {
    try {
      const rawArticles = await getRecentArticlesByKnowledge(task.knowledge_id, 20);
      recentArticles = rawArticles.map(a => ({
        title: a.title,
        summary: stripHtml((a as any).contentHtml || '', 200),
        createdAt: a.createdAt,
        coreKeyword: a.coreKeyword || undefined,
      }));
    } catch { /* 降级 */ }
    try { performanceMemory = (await getPerformanceMemory(task.knowledge_id, 10)).map((p: any) => ({ articleTitle: p.article_title, performanceLabel: p.performance_label, direction: p.direction, contentType: p.content_type })); } catch { /* 降级 */ }
    try { strategyMemory = (await getStrategyMemory(task.knowledge_id, 3)).map((s: any) => ({ strategy: s.strategy, evidence: s.evidence || '', generatedAt: s.generated_at })); } catch { /* 降级 */ }
  }

  // L5 RAG 检索
  let ragSnippets: RagSnippet[] = [];
  if (task.knowledge_id) {
    ragSnippets = await retrieveRelevantArticles(task.knowledge_id, `${article.core_keyword} ${directionCtx}`, 5);
  }

  const writingCtx = buildWritingContext({
    task,
    keywords: article.core_keyword ? [article.core_keyword] : [],
    recentArticles,
    performanceMemory,
    strategyMemory,
    ragSnippets,
    aeoContext: task.aeo_context, // v2.1.4
  });

  // v3.8.13：重新生成时用已保存的 core_keyword（即专家选定的主题）作为 {topic}
  const regenTopic = article.core_keyword || '';
  let articlePrompt = buildPrompt(directionCtx + (task.article_prompt || ''), {
    keyword: regenTopic,
    topic: regenTopic,
    direction: '',
    titleHint: '',
    coverageKeywords: regenTopic,
    enterprise: enterpriseInfo,
    wordCount: task.target_word_count,
  });
  articlePrompt += writingCtx.userPromptSuffix;

  // v1.8.0：重新生成时也注入 L6 平台约束（基于文章已有的 target_platform）
  let regenPlatformRule: any = null;
  if (article.target_platform) {
    try {
      const { getPlatformRule } = await import('../../repository');
      regenPlatformRule = await getPlatformRule(article.target_platform);
      if (regenPlatformRule) {
        articlePrompt += buildPlatformConstraintPrompt(regenPlatformRule);
      }
    } catch (err) {
      console.warn(`[ArticleGen] 文章 ${articleId} 重新生成时查询平台规则失败:`, err);
    }
  }

  const systemContent = writingCtx.systemMessage;
  const messages: { role: 'system' | 'user'; content: string }[] = systemContent
    ? [
        { role: 'system', content: systemContent },
        { role: 'user', content: articlePrompt },
      ]
    : [{ role: 'user', content: articlePrompt }];

  const articleResult = await chatCompletion({
    baseUrl: modelConfig.base_url,
    apiKey,
    model: modelConfig.model_name,
    messages,
    temperature: Number(modelConfig.temperature) || 0.7,
    // 不传 maxTokens，避免豆包等平台对 max_tokens 硬截断导致内容被截断成几个字符
    timeout: 120000,
    webSearch: !!modelConfig.web_search,
  });

  let title = '';
  if (task.title_prompt && task.title_prompt.trim()) {
    let titlePrompt = buildPrompt(directionCtx + task.title_prompt, {
      keyword: regenTopic,
      topic: regenTopic,
      direction: '',
      titleHint: '',
      coverageKeywords: regenTopic,
      enterprise: enterpriseInfo,
      wordCount: task.target_word_count,
    });
    // v1.8.0：重新生成时标题也注入平台字数约束
    if (regenPlatformRule) {
      titlePrompt += `\n\n【标题字数硬约束】目标平台：${regenPlatformRule.name}，标题必须 ${regenPlatformRule.title_min_length ?? 1}-${regenPlatformRule.title_max_length ?? 100} 字。超出 ${regenPlatformRule.title_max_length ?? 100} 字会被平台拒绝，请严格控制。`;
    }
    // 标题生成用极简 system message，避免 L0-L5 上下文让 AI 陷入思考
    const titleMessages: { role: 'system' | 'user'; content: string }[] = [
      { role: 'system', content: '你是标题生成器。只输出标题文字本身，不要输出任何思考过程、分析、解释、引号、前缀。直接输出标题。' },
      { role: 'user', content: titlePrompt },
    ];
    const titleResult = await chatCompletion({
      baseUrl: modelConfig.base_url,
      apiKey,
      model: modelConfig.model_name,
      messages: titleMessages,
      temperature: Number(modelConfig.temperature) || 0.7,
      // 不传 maxTokens，避免推理模型思考过程占满 token 后被截断
      timeout: 30000,
    });
    // 剥离思考过程 + HTML 标签 + 引号
    title = stripThinking(titleResult.content)
      .replace(/<[^>]+>/g, '')
      .replace(/^["'"「『]+|["'"」』]+$/g, '')
      .replace(/\n+/g, ' ')
      .trim();
    // 标题长度保护
    if (title.length > 50) {
      const punctPos = title.slice(0, 50).search(/[。，！？；,!?;]/);
      title = punctPos > 10 ? title.slice(0, punctPos) : title.slice(0, 50);
    }
    // 如果剥离思考后标题为空或仍然像思考过程，降级使用正文标题
    if (!title || title.length < 5 || isThinkingProcess(title)) {
      console.warn(`[ArticleGen] 文章 ${articleId} 重新生成标题异常，降级使用正文标题。原始返回前100字符:`, titleResult.content.slice(0, 100));
      title = '';
    }
  }

  const { title: parsedTitle, contentHtml, wordCount } = parseArticleContent(articleResult.content);
  if (!title) title = parsedTitle;
  // 最终兜底：如果 parsedTitle 也是思考过程，用关键词 + 首段纯文本生成标题
  if (!title || isThinkingProcess(title)) {
    const firstP = contentHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const firstText = firstP ? firstP[1].replace(/<[^>]+>/g, '').trim() : '';
    if (firstText && !isThinkingProcess(firstText)) {
      title = (article.core_keyword ? article.core_keyword + '：' : '') + firstText.slice(0, 25);
    } else {
      title = article.core_keyword || '未命名文章';
    }
    console.warn(`[ArticleGen] 文章 ${articleId} 正文标题也是思考过程，用关键词+首段生成标题:`, title);
  }

  // v2.5.19：重新生成时也走图片处理流程（原 bug：regenerateArticle 完全没有图片处理逻辑，
  //   导致用户点"重写"后文章永远没图）
  //   调用公共函数 processArticleImages，与 executeWritingTask 共用同一套逻辑
  let finalContentHtml = contentHtml;
  let coverUrlForArticle = '';
  try {
    const imageResult = await processArticleImages(task, userId, contentHtml, articleId);
    finalContentHtml = imageResult.contentHtml;
    coverUrlForArticle = imageResult.coverUrl;
    // 重新计算字数（插图 <img> 不计入字数，但 contentHtml 已变）
  } catch (err: any) {
    console.warn(`[ArticleGen] 文章 ${articleId} 图片处理失败:`, err?.message || err);
  }
  const finalWordCount = finalContentHtml.replace(/<[^>]+>/g, '').length;

  const { updateArticle } = await import('../../repository');
  await updateArticle(articleId, {
    title,
    content_html: finalContentHtml,
    word_count: finalWordCount,
    model_used: modelConfig.model_name,
    cover_image_url: coverUrlForArticle || null,  // v2.5.19：保存封面图 URL
    // v2.5.21：重写时也更新三元组为被文章实际使用的子集
    entity_triples: filterUsedTriples(finalContentHtml, task.entity_triples || []),
    status: 'generated',
  });
}

// v2.5.19：图片处理公共函数（取封面 + 取插画 + 按段落均匀插入 <img>）
//   executeWritingTask 和 regenerateArticle 共用此函数，避免代码重复
//   返回 { coverUrl, contentHtml } —— 调用方需用这两个值更新文章
export async function processArticleImages(
  task: any,
  userId: number,
  contentHtml: string,
  articleIdForLog?: string | number
): Promise<{ coverUrl: string; contentHtml: string }> {
  const logTag = articleIdForLog != null ? `[Article ${articleIdForLog}]` : `[ArticleGen]`;

  // 1. 解析封面模式
  const rawCoverMode = task.cover_image_mode || 'none';
  let coverMode: 'none' | 'random' | 'fixed' | 'auto';
  if (rawCoverMode === 'auto' || rawCoverMode === 'none' || rawCoverMode === 'random' || rawCoverMode === 'fixed') {
    coverMode = rawCoverMode;
  } else {
    coverMode = 'none';
  }

  // 2. 解析插画数量（v2.5.17：尊重用户配置——设几就取几，不设置/0/-1 都不插图）
  const rawIlluCountConfig = Number(task.illustration_count);
  let illuCountConfig: number;
  if (Number.isFinite(rawIlluCountConfig) && rawIlluCountConfig > 0) {
    illuCountConfig = Math.min(20, rawIlluCountConfig);
  } else {
    illuCountConfig = 0;
  }

  console.log(`${logTag}[图库配置] cover_image_mode=${task.cover_image_mode}(生效=${coverMode}), illustration_count=${task.illustration_count}(生效=${illuCountConfig}), knowledge_id=${task.knowledge_id}, user_id=${userId}`);

  let coverUrl = '';
  let coverFingerprint: { name: string; size: number } | null = null;

  // 3. 取封面图
  if (coverMode === 'fixed' && task.cover_image_id) {
    try {
      const coverImg = await getImageById(task.cover_image_id);
      if (coverImg) {
        coverUrl = coverImg.url;
        if (coverImg.original_name && coverImg.file_size != null) {
          coverFingerprint = { name: coverImg.original_name, size: coverImg.file_size };
        }
      }
    } catch (err) {
      console.warn(`${logTag} 获取指定封面图失败:`, err);
    }
  } else if ((coverMode === 'random' || coverMode === 'auto') && task.knowledge_id) {
    try {
      const randomCovers = await getRandomImages(userId, task.knowledge_id, 'cover', 1);
      if (randomCovers.length > 0) {
        coverUrl = randomCovers[0].url;
        const c = randomCovers[0];
        if (c.original_name && c.file_size != null) {
          coverFingerprint = { name: c.original_name, size: c.file_size };
        }
      } else {
        console.warn(`${logTag}[图库诊断] ${coverMode} 模式：封面图库查询返回空（userId=${userId}, knowledgeId=${task.knowledge_id}, imageType=cover）`);
      }
    } catch (err) {
      console.warn(`${logTag} 取随机封面失败:`, err);
    }
  } else if ((coverMode === 'random' || coverMode === 'auto') && !task.knowledge_id) {
    console.warn(`${logTag}[图库诊断] ${coverMode} 模式：task.knowledge_id 为空，无法取封面图`);
  }

  // 4. 取插画
  let illustrationUrls: string[] = [];
  if (illuCountConfig > 0 && task.knowledge_id) {
    try {
      const fetchCount = illuCountConfig + 5;
      let randomIllus = await getRandomImages(userId, task.knowledge_id, 'illustration', fetchCount);
      if (randomIllus.length > 0 && coverFingerprint) {
        randomIllus = randomIllus.filter((img: any) => {
          return !(
            img.original_name &&
            img.original_name === coverFingerprint!.name &&
            img.file_size != null &&
            img.file_size === coverFingerprint!.size
          );
        });
      }
      if (randomIllus.length > 0) {
        const finalCount = Math.min(illuCountConfig, randomIllus.length);
        illustrationUrls = randomIllus.slice(0, finalCount).map((img: any) => img.url);
      } else {
        console.warn(`${logTag}[图库诊断] 插画图库查询返回空（userId=${userId}, knowledgeId=${task.knowledge_id}, imageType=illustration）`);
      }
    } catch (err) {
      console.warn(`${logTag} 取插画失败:`, err);
    }
  }

  console.log(`${logTag}[图库注入] coverUrl=${coverUrl ? coverUrl.substring(0, 60) + '...' : '(无)'}, illustrationUrls=${illustrationUrls.length}张`);

  // v2.5.25：移除"cover 图库为空时用第一张插画作封面"的兜底逻辑
  //   用户反馈：图库分了插画图库和封面图库，各取各的，不应因 cover 图库为空就吃掉一张插画。
  //   修复：封面只从 cover 图库取，取不到就没封面；插画数量严格按 illustration_count 配置，不被封面占用。

  // 5. 按段落均匀插入插画（v2.5.17：代码统一插入，不依赖 AI）
  let finalContentHtml = contentHtml;
  let effectiveIllusUrls = illustrationUrls;
  if (effectiveIllusUrls.length === 0 && task.knowledge_id && illuCountConfig > 0) {
    // 取图失败时重查兜底（仅当用户确实配了插图数量时才重查）
    try {
      const retryCount = Math.min(3, illuCountConfig);
      const retryImgs = await getRandomImages(userId, task.knowledge_id, 'illustration', retryCount);
      if (retryImgs.length > 0) {
        effectiveIllusUrls = retryImgs.map((img: any) => img.url);
        console.warn(`${logTag}[图库Fallback] 原取图为空，重查成功 ${retryImgs.length} 张`);
      } else {
        console.warn(`${logTag}[图库Fallback] 重查仍为空（userId=${userId}, knowledgeId=${task.knowledge_id}, imageType=illustration）`);
      }
    } catch (err: any) {
      console.warn(`${logTag}[图库Fallback] 重查图库失败:`, err?.message || err);
    }
  }
  if (effectiveIllusUrls.length > 0) {
    const existingImgMatches = finalContentHtml.match(/<img[^>]*\ssrc\s*=\s*["'][^"']+["']/gi) || [];
    const existingImgCount = existingImgMatches.length;
    if (existingImgCount < effectiveIllusUrls.length) {
      const missingUrls = effectiveIllusUrls.slice(existingImgCount);
      console.log(`${logTag}[代码插图] 现有 ${existingImgCount}/${effectiveIllusUrls.length} 张，代码补插 ${missingUrls.length} 张`);

      const paragraphEnds: number[] = [];
      let searchFrom = 0;
      while (true) {
        const idx = finalContentHtml.indexOf('</p>', searchFrom);
        if (idx === -1) break;
        paragraphEnds.push(idx + 4);
        searchFrom = idx + 4;
      }
      if (paragraphEnds.length === 0) {
        const imgTags = missingUrls.map((url, idx) => `<p><img src="${url}" alt="插图${existingImgCount + idx + 1}"></p>`).join('\n');
        finalContentHtml += '\n' + imgTags;
      } else {
        const insertPositions: number[] = [];
        for (let k = 0; k < missingUrls.length; k++) {
          const posIdx = Math.floor((k + 1) * paragraphEnds.length / (missingUrls.length + 1));
          insertPositions.push(paragraphEnds[Math.min(posIdx, paragraphEnds.length - 1)]);
        }
        insertPositions.sort((a, b) => b - a);
        let modifiedHtml = finalContentHtml;
        for (let k = 0; k < missingUrls.length; k++) {
          const pos = insertPositions[k];
          const url = missingUrls[k];
          const imgTag = `\n<p><img src="${url}" alt="插图${existingImgCount + k + 1}"></p>\n`;
          modifiedHtml = modifiedHtml.slice(0, pos) + imgTag + modifiedHtml.slice(pos);
        }
        finalContentHtml = modifiedHtml;
      }
      console.log(`${logTag}[代码插图] 插入完成，总图数=${existingImgCount + missingUrls.length}`);
    } else {
      console.log(`${logTag}[代码插图] 已有 ${existingImgCount} 张图，无需补插`);
    }
  }

  return { coverUrl, contentHtml: finalContentHtml };
}
