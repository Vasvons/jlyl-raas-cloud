import axios from 'axios';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface ReportResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  recordId: number;
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
    const contentPreview = result.content.substring(0, 80).replace(/\n/g, ' ');
    if (data && data.brandMatched) {
      const brands = data.matchedBrands || [];
      const contact = data.hasContact ? ' [含联系方式]' : '';
      logger.info(`[品牌命中] ${result.platform}/${result.keyword.substring(0, 30)} 命中品牌: ${brands.join(', ')}${contact} recordId=${data.recordId}${shareInfo}`);
      logger.info(`[品牌命中详情] 关键词="${result.keyword}" 内容长度=${result.content.length} 内容预览="${contentPreview}"`);
    } else if (data) {
      logger.info(`[未命中品牌] ${result.platform}/${result.keyword.substring(0, 30)} 内容长度=${result.content.length} recordId=${data.recordId}${shareInfo}`);
      logger.info(`[未命中详情] 关键词="${result.keyword}" 内容预览="${contentPreview}"`);
    } else {
      logger.info(`[Reporter] 结果回写成功(无识别结果): ${result.platform}/${result.keyword.substring(0, 20)} 内容长度=${result.content.length}${shareInfo}`);
    }

    return data || null;
  } catch (e: any) {
    logger.error(`[Reporter] 结果回写失败: ${e.message}`);
    throw e;
  }
}
