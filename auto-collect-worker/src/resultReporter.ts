import axios from 'axios';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface ReportResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  recordId: number;
}

// 描述性词汇黑名单（AI 回答中常见的非品牌列表项标签）
const DESCRIPTIVE_BLACKLIST = new Set([
  // 属性标签
  '特点', '优势', '不足', '缺点', '特色', '简介', '概述', '总结', '建议', '备注', '说明',
  '适合', '适合人群', '适合对象', '适用场景', '目标用户',
  '地址', '电话', '官网', '网址', '邮箱', '联系方式',
  '基本情况', '背景', '成立时间', '总部', '服务范围', '服务内容', '业务范围',
  '透明报价', '价格区间', '合理价格', '收费标准', '费用明细', '报价',
  '平台简介', '官方查询渠道', '避坑提示', '风险', '注意事项',
  '常见品牌', '代表平台', '区域性建议', '总结建议', '建议行动路径',
  '第一步', '第二步', '第三步', '第四步', '行动路径',
  // 行业描述
  '小规模纳税人', '一般纳税人', '二三线城市', '大型全国性企业服务平台',
  '本地口碑较好的财务公司', '线上工商代办平台',
  // 关系描述
  '与服务提供商详细沟通', '签订正规合同', '签订正式合同',
]);

// 动词前缀过滤：以这些动词开头的列表项不是品牌名
const VERB_PREFIXES = [
  '看', '查', '问', '找', '警惕', '签订', '考察', '咨询', '避免', '拒绝', '索要',
  '总结', '建议', '定位', '实地', '明确', '避开', '要求', '询问', '拥有', '支持',
  '筛选', '必须', '核心', '包括', '这些', '如果', '客户', '集律师', '在广东',
  '在国内外', '可在线', '每月', '每年', '日常', '是否',
];

// 公司/品牌后缀白名单：包含这些词的列表项高概率是公司/品牌名
const COMPANY_SUFFIXES = [
  '公司', '事务所', '集团', '有限', '代理', '品牌', '财税', '法务', '服务',
  '知识产权', '科技', '咨询', '国际', '控股', '研究院', '中心', '机构',
  '律师事务所', '代理有限公司', '商标事务所',
];

/**
 * 从 AI 回答内容中提取列举的品牌/公司列表项
 * v2.0.9: 改进过滤算法，只保留像品牌/公司名的项，过滤描述性标签和动词短语
 */
function extractBrandList(content: string): string[] {
  const lines = content.split('\n');
  const brands: string[] = [];
  const listPattern = /^[\s>]*(?:\d+[.)、\s]|[-*•·†‡◦])\s*(.+)$/;
  const separatorPattern = /[-—:：|｜，,。.\(（]|\s{2,}/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(listPattern);
    if (!m) continue;
    const rest = m[1].trim();
    const sepMatch = rest.split(separatorPattern)[0];
    const name = sepMatch.trim().replace(/^[【\[("']+|[】\)"']+$|\*+/g, '').trim();

    // 长度过滤：<2 或 >20 直接跳过
    if (name.length < 2 || name.length > 20) continue;

    // 黑名单精确匹配
    if (DESCRIPTIVE_BLACKLIST.has(name)) continue;

    // 动词前缀过滤
    if (VERB_PREFIXES.some(v => name.startsWith(v))) continue;

    // 以"以下是/总的来说"等开头的过滤
    if (/^(以下|总的|综上|此外|另外|注意|参考|来源|扩展|阅读|相关|查看|更多)/.test(name)) continue;

    // 公司后缀白名单：包含后缀的直接保留（高置信度）
    const hasSuffix = COMPANY_SUFFIXES.some(s => name.includes(s));

    if (hasSuffix) {
      brands.push(name);
    } else if (name.length >= 2 && name.length <= 8) {
      // 不含后缀但 2-8 字，可能是品牌名（如"德勤""慧算账""权大师"），保留
      brands.push(name);
    }
    // >8 字且不含公司后缀 → 很可能是描述性短语，过滤

    if (brands.length >= 20) break;
  }
  return brands;
}

/**
 * 构造品牌列表显示：命中的目标品牌用 【HIT】标记【/HIT】 包裹，前端渲染为高亮颜色
 */
function formatBrandList(allBrands: string[], matchedSet: Set<string>): string {
  if (allBrands.length === 0) return '(AI未列举品牌)';
  return allBrands.map(b => matchedSet.has(b) ? `【HIT】${b}【/HIT】` : b).join(' | ');
}

export async function reportResult(result: {
  taskId: number;
  userId: string;
  keyword: string;
  keywordType: number;
  platform: string;
  content: string;
  htmlContent?: string;
  shareUrl: string | null;
  supportsShare: boolean;
  workerId: string;
  /** 查询来源：api（大模型 API）/ crawler（爬虫） */
  source?: 'api' | 'crawler';
}): Promise<ReportResult | null> {
  try {
    const resp = await axios.post(`${SERVER_URL}/real-collect/results/worker/report`, {
      ...result,
      queryTime: new Date().toISOString()
    }, {
      timeout: 30000
    });

    // 解析云端返回的品牌识别结果
    const data = resp.data?.data;
    const shareInfo = result.shareUrl ? ` 分享链接=${result.shareUrl}` : ' (无分享链接)';

    // 从 AI 回答中提取列举的品牌/公司列表，高亮命中的目标品牌
    const aiBrandList = extractBrandList(result.content);
    const matchedSet = new Set<string>((data?.matchedBrands || []).map((b: string) => b));
    const brandListDisplay = formatBrandList(aiBrandList, matchedSet);

    if (data && data.brandMatched) {
      const matchedBrands = data.matchedBrands || [];
      const contact = data.hasContact ? ' [含联系方式]' : '';
      logger.info(`[品牌命中] ${result.platform}/${result.keyword.substring(0, 30)} 命中: ${matchedBrands.join(', ')}${contact} recordId=${data.recordId}${shareInfo}`);
      logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
    } else if (data) {
      logger.info(`[未命中品牌] ${result.platform}/${result.keyword.substring(0, 30)} recordId=${data.recordId}${shareInfo}`);
      logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
    } else {
      logger.info(`[Reporter] 结果回写成功(无识别结果): ${result.platform}/${result.keyword.substring(0, 20)} 内容长度=${result.content.length}${shareInfo}`);
      logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
    }

    return data || null;
  } catch (e: any) {
    logger.error(`[Reporter] 结果回写失败: ${e.message}`);
    throw e;
  }
}
