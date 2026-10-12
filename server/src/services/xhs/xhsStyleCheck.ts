/**
 * 小红书正文质检（v2.13.8，v2.13.9 扩展 AI 味检测，v2.13.10 增品牌存在感，v2.14.2 增封面大字）
 *
 * 背景：prompt 里的写作约束是「君子协定」，模型（尤其低成本模型）仍会写出
 * "先说/再说"清单腔、长句、说教句、AI 书面腔（值得一提/堪称/赋能）与排比升华句，
 * 或走向另一极端——纯生活日记、品牌只出现一次、没有种草核。
 * 这里做生成后程序化校验，返回具体问题清单；
 * 由 xhsNoteGenerator 带问题重写一次（只重试一次，失败保留原版，不阻断生成）。
 */

/** 强清单腔词：命中 1 次即可疑（真人分享不会用"先说/再说/首先/其次"开头分点） */
const STRONG_LIST_WORDS = /先说|再说|首先|其次|综上所述|总而言之/g;
/** 弱清单腔词：出现 2 次以上才算（单次可能是正常口语） */
const WEAK_LIST_WORDS = /另外|还有一点/g;
/** 说教命令句 */
const IMPERATIVE_WORDS = /千万别|必须|记得|一定要|切忌|别忘/g;
/** AI 书面腔词：命中 1 次即可疑（真人分享不会这么说话） */
const AI_WORD_HITS = /值得一提|不难发现|堪称|不失为|与此同时|此外|旨在|致力于|彰显|赋能|打造|解锁|沉浸式|开启.{0,6}之旅|无疑|意味着/g;
/** AI 排比 / 升华句式 */
const AI_PATTERN_HITS = /不只是[^。]{0,14}更是|不仅[^。]{0,14}而且|让我们一起|希望能帮到|希望这篇|愿你/g;
/** 空泛程度副词 */
const VAGUE_ADVERBS = /非常|十分|极其/g;
/** 平台风险 / 夸大词（v2.13.11）：导流、诱导互动、种草夸大词 */
const HYPE_RISK_WORDS = /绝绝子|yyds|YYDS|闭眼入|闭眼冲|必入|评论区扣\d|一键三连|点赞收藏关注|加微信|微信号|加V|VX|淘宝|天猫|京东|二维码/g;
/** 「emoji + 短标签」式小标题（📍🧠💡 这类 AI 腔分节标题） */
const EMOJI_HEADING_LINE = /^(?:📍|🧠|💡|📌|🔖|🛠️|💬|🎯|📚|🔥|🌟|✨)\s*[^：:。！？!?\n]{1,12}[:：]?$/;

export function checkXhsNoteStyle(body: string, opts?: { brandNames?: string[] }): string[] {
  const issues: string[] = [];
  const text = String(body || '').replace(/\s+/g, ' ');

  // 1. 清单腔过渡词（攻略帖残留重灾区）
  const strongHits = text.match(STRONG_LIST_WORDS) || [];
  const weakHits = text.match(WEAK_LIST_WORDS) || [];
  if (strongHits.length > 0) {
    issues.push(`出现清单腔过渡词「${[...new Set(strongHits)].join('、')}」，正文应像经历分享，不像分点攻略`);
  } else if (weakHits.length >= 2) {
    issues.push(`「另外/此外/还有一点」出现 ${weakHits.length} 次，像在分点罗列`);
  }

  // 2. 长句：以句号分句后超过 45 字的句子 ≥ 2 条
  const sentences = text.split(/[。！？!?~]+/).map((s) => s.trim()).filter(Boolean);
  const longSentences = sentences.filter((s) => s.replace(/\s/g, '').length > 45);
  if (longSentences.length >= 2) {
    issues.push(`有 ${longSentences.length} 句超过 45 字（要拆成短句）`);
  }

  // 3. 说教腔：命令句过多
  const imperativeHits = text.match(IMPERATIVE_WORDS) || [];
  if (imperativeHits.length > 3) {
    issues.push(`"千万别/必须/记得"这类命令句出现 ${imperativeHits.length} 处（最多 2 处，其余改成"我当初怎么做"）`);
  }

  // 4. AI 书面腔词（v2.13.9）
  const aiHits = text.match(AI_WORD_HITS) || [];
  if (aiHits.length > 0) {
    issues.push(`出现 AI 书面腔词「${[...new Set(aiHits)].join('、')}」，要换成大白话或直接删掉`);
  }

  // 5. 排比 / 升华句式（v2.13.9）
  const patternHits = text.match(AI_PATTERN_HITS) || [];
  if (patternHits.length > 0) {
    issues.push(`出现排比或升华句式（${[...new Set(patternHits)].map((s) => s.slice(0, 8)).join('、')}），真人不这么写`);
  }

  // 6. 空泛副词（v2.13.9）
  const vagueHits = text.match(VAGUE_ADVERBS) || [];
  if (vagueHits.length > 3) {
    issues.push(`"非常/十分/极其"这类空泛副词出现 ${vagueHits.length} 次（最多 2 个，感受直接写出来）`);
  }

  // 7. 品牌存在感（v2.13.10）：品牌名出现 < 2 次 → 读者记不住推荐的是谁（读不出一篇种草）
  const brandNames = (opts?.brandNames || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (brandNames.length > 0) {
    const maxCount = Math.max(...brandNames.map((n) => text.split(n).length - 1));
    if (maxCount < 2) {
      issues.push(`品牌名只出现 ${maxCount} 次（至少 2 次）：补一次"好在哪"的具体表达，读者要能记住推荐的是谁`);
    }
  }

  // 8. 平台风险 / 夸大词（v2.13.11）
  const hypeHits = text.match(HYPE_RISK_WORDS) || [];
  if (hypeHits.length > 0) {
    issues.push(`出现平台风险/夸大词「${[...new Set(hypeHits)].join('、')}」：换成客观体验描述或删掉（导流/诱导互动/夸大词会被限流）`);
  }

  // 9. 「emoji + 短标签」式小标题（v2.13.11，📍场景引入 / 🧠概念 这类 AI 腔）
  const headingLines = String(body || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 16 && EMOJI_HEADING_LINE.test(l));
  if (headingLines.length > 0) {
    issues.push(`出现"emoji + 短标签"式小标题（${headingLines[0]}）：删掉标签，把内容并进自然段落`);
  }

  return issues;
}

// ==================== v2.14.2 第 10 类：封面大字质检 ====================

/** 封面大字负面信号：复述踩坑经历（命中 ≥2 且无正面落点即判"写成吐槽帖标题"） */
const COVER_NEGATIVE_WORDS = [
  '长毛', '发霉', '霉味', '翻车', '踩坑', '后悔', '血泪', '拆了', '拆掉', '烂了',
  '生锈', '锈了', '鼓包', '返潮', '受潮', '白花钱', '别学', '劝退', '教训', '变形', '裂了',
];
/** 封面大字正面落点信号：种草结果 / 推荐判断（有其一即视为已落到种草） */
const COVER_POSITIVE_WORDS = [
  '真香', '推荐', '值得', '值了', '够用', '严丝合缝', '没再', '不用', '省心', '多出',
  '这样装', '搞定', '好用', '方便', '好看', '干净', '通透', '放心', '省事', '没问题', '香',
];

/**
 * v2.14.2 封面大字质检（第 10 类）——决定"划不划走"的最外层大字
 *
 * 命中即由生成器带问题重写一次：
 *  ① 没点到产品品类词 → 读者不知道这篇讲什么（如关键词「阳台柜」，封面却只有"柜子"）
 *  ② 整体在复述踩坑、没有种草落点 → 封面写成了吐槽帖标题（如"长毛/拆了"却没有正面结果）
 */
export function checkXhsCoverText(coverText: string, opts?: { productWord?: string }): string[] {
  const issues: string[] = [];
  const raw = String(coverText || '').trim();
  if (!raw) return issues;
  // 去掉空白便于跨行匹配（多行封面大字分行书写，产品词可能落在任意一行）
  const text = raw.replace(/\s+/g, '');

  // 10.1 必须点到产品品类词
  const productWord = String(opts?.productWord || '').trim();
  if (productWord.length >= 2 && !text.includes(productWord)) {
    issues.push(`封面大字没有点到产品品类词「${productWord}」，划到的人看不出这篇讲的是什么`);
  }

  // 10.2 种草落点：不能只复述踩坑（否定表达不算负面，如"两年没长毛"）
  const negRe = new RegExp(`(?<![没不无未])(?:${COVER_NEGATIVE_WORDS.join('|')})`, 'g');
  const negHits = text.match(negRe) || [];
  const posHits = COVER_POSITIVE_WORDS.filter((w) => text.includes(w));
  if (negHits.length >= 2 && posHits.length === 0) {
    issues.push(
      `封面大字整体在复述踩坑（命中「${[...new Set(negHits)].join('、')}」）、没有落到种草结果：` +
      '要让人想知道"换成了什么、现在多好"，不能写成吐槽帖标题',
    );
  }

  return issues;
}