import axios from 'axios';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface ReportResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  recordId: number;
}

// 公司/品牌后缀白名单：包含这些词的列表项才是品牌/公司名
// v2.0.10: 改为严格过滤，只有包含公司后缀的才保留，不含后缀的全部过滤
const COMPANY_SUFFIXES = [
  '公司', '事务所', '集团', '有限', '代理', '财税', '法务',
  '知识产权', '科技', '咨询', '国际', '控股', '研究院', '机构',
  '律师事务所', '商标事务所', '证券', '银行', '保险', '基金',
  '工作室', '工坊', '工厂', '厂家',
];

// 知名短品牌名白名单（不含公司后缀但确实是品牌）
const KNOWN_SHORT_BRANDS = new Set([
  '德勤', '普华永道', '安永', '毕马威', '瑞华', '立信', '天职', '大华', '天健',
  '慧算账', '快法务', '企查查', '天眼查', '权大师', '八戒', '大账房', '金米',
  '华为', '小米', '苹果', '三星', 'OPPO', 'vivo', '联想', '中兴',
]);

/**
 * 从 AI 回答内容中提取列举的品牌/公司列表项
 * v2.0.10: 严格过滤策略
 *   - 包含公司后缀（公司/事务所/集团等）→ 保留（高置信度）
 *   - 在知名短品牌白名单中 → 保留
 *   - 其他全部过滤（解决"特点/优势/服务质量"等描述性词汇混入问题）
 * 返回 { brands: 品牌列表, hasRealBrand: 是否包含真正的品牌/公司 }
 */
function extractBrandList(content: string): { brands: string[]; hasRealBrand: boolean } {
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

    if (name.length < 2 || name.length > 30) continue;

    // 严格过滤：必须包含公司后缀 或 在知名品牌白名单中
    const hasSuffix = COMPANY_SUFFIXES.some(s => name.includes(s));
    const isKnownBrand = KNOWN_SHORT_BRANDS.has(name);
    if (!hasSuffix && !isKnownBrand) continue;

    brands.push(name);
    if (brands.length >= 20) break;
  }
  return { brands, hasRealBrand: brands.length > 0 };
}

/**
 * 构造品牌列表显示：命中的目标品牌用 【HIT】标记【/HIT】 包裹，前端渲染为高亮颜色
 */
function formatBrandList(allBrands: string[], matchedSet: Set<string>): string {
  if (allBrands.length === 0) return '';
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
    const { brands: aiBrandList, hasRealBrand } = extractBrandList(result.content);
    const matchedSet = new Set<string>((data?.matchedBrands || []).map((b: string) => b));
    const brandListDisplay = formatBrandList(aiBrandList, matchedSet);

    if (data && data.brandMatched) {
      const matchedBrands = data.matchedBrands || [];
      const contact = data.hasContact ? ' [含联系方式]' : '';
      logger.info(`[品牌命中] ${result.platform}/${result.keyword.substring(0, 30)} 命中: ${matchedBrands.join(', ')}${contact} recordId=${data.recordId}${shareInfo}`);
      if (hasRealBrand) {
        logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
      } else {
        logger.warn(`[品牌列表] ⚠️ 关键词="${result.keyword}" AI未列举任何品牌/公司名（生成结果可能异常）`);
      }
    } else if (data) {
      logger.info(`[未命中品牌] ${result.platform}/${result.keyword.substring(0, 30)} recordId=${data.recordId}${shareInfo}`);
      if (hasRealBrand) {
        logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
      } else {
        logger.warn(`[品牌列表] ⚠️ 关键词="${result.keyword}" AI未列举任何品牌/公司名（生成结果可能异常）`);
      }
    } else {
      logger.info(`[Reporter] 结果回写成功(无识别结果): ${result.platform}/${result.keyword.substring(0, 20)} 内容长度=${result.content.length}${shareInfo}`);
      if (hasRealBrand) {
        logger.info(`[品牌列表] 关键词="${result.keyword}" AI列举品牌=[${brandListDisplay}]`);
      } else {
        logger.warn(`[品牌列表] ⚠️ 关键词="${result.keyword}" AI未列举任何品牌/公司名（生成结果可能异常）`);
      }
    }

    return data || null;
  } catch (e: any) {
    logger.error(`[Reporter] 结果回写失败: ${e.message}`);
    throw e;
  }
}
