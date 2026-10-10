/**
 * 小红书正文质检（v2.13.8，v2.13.9 扩展 AI 味检测）
 *
 * 背景：prompt 里的写作约束是「君子协定」，模型（尤其低成本模型）仍会写出
 * "先说/再说"清单腔、长句、说教句、AI 书面腔（值得一提/堪称/赋能）与排比升华句。
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

export function checkXhsNoteStyle(body: string): string[] {
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

  return issues;
}