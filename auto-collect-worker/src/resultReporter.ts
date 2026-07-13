import axios from 'axios';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface ReportResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  recordId: number;
}

/**
 * 从 AI 回答内容中提取列举的品牌/公司列表项
 * AI 通常用以下格式列举品牌：
 *   1. 华为 - 描述...
 *   2) 小米：描述...
 *   - 苹果，描述...
 *   * 聚量引力 | 描述...
 *   【品牌名】描述...
 * 本函数提取每行的首部品牌/公司名（分隔符前的部分），最多 20 项
 */
function extractBrandList(content: string): string[] {
  const lines = content.split('\n');
  const brands: string[] = [];
  // 匹配列表项首部：数字序号、-、*、•、【等开头，后跟品牌名，再跟分隔符（- : ：| ，,）
  const listPattern = /^[\s>]*(?:\d+[.)、\s]|[-*•·†‡◦])\s*(.+)$/;
  // 分隔符：品牌名后的描述分隔符
  const separatorPattern = /[-—:：|｜，,。.\(（]|\s{2,}/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(listPattern);
    if (!m) continue;
    const rest = m[1].trim();
    // 按分隔符切分，取第一段作为品牌名
    const sepMatch = rest.split(separatorPattern)[0];
    const name = sepMatch.trim().replace(/^[【\[("']+|[】\)"']+$|\*+/g, '').trim();
    // 过滤过短（<2字符）或过长（>20字符，可能是整句）的
    if (name.length >= 2 && name.length <= 20) {
      // 过滤明显不是品牌名的（如"以下是"、"总的来说"等）
      if (!/^(以下|总的|综上|此外|另外|注意|备注|说明|参考|来源|扩展|阅读|相关|查看|更多)/.test(name)) {
        brands.push(name);
      }
    }
    if (brands.length >= 20) break;
  }
  return brands;
}

/**
 * 构造品牌列表显示：命中的目标品牌用 ★高亮★，未命中的普通显示
 */
function formatBrandList(allBrands: string[], matchedSet: Set<string>): string {
  if (allBrands.length === 0) return '(AI未列举品牌)';
  return allBrands.map(b => matchedSet.has(b) ? `★${b}★` : b).join(' | ');
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
