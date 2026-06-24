/**
 * 结果处理器：接收Worker回写的原始结果，做品牌词+联系方式识别，生成静态页，入库
 */
import {
  insertRealCollectRecord,
  insertStaticPage,
  getBrandKeywords,
  updateRecordStaticPageId
} from '../../repository';
import { recognizeContent } from './recognizer';

export interface WorkerResult {
  taskId: number;
  userId: string;
  keyword: string;
  keywordType: number;
  platform: string;
  content: string;
  htmlContent?: string;
  shareUrl: string | null;
  queryTime: Date;
  workerId: string;
  supportsShare: boolean;
}

function generateStaticHtml(keyword: string, platform: string, content: string, htmlContent?: string): string {
  const body = htmlContent || content.replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${platform} - ${keyword}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #333; }
    .header { border-bottom: 2px solid #1890ff; padding-bottom: 12px; margin-bottom: 20px; }
    .platform { color: #1890ff; font-weight: bold; }
    .keyword { font-size: 18px; margin: 8px 0; }
    .content { background: #f9f9f9; padding: 16px; border-radius: 8px; }
    .footer { margin-top: 20px; color: #999; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="platform">${platform}</div>
    <div class="keyword">查询: ${keyword}</div>
  </div>
  <div class="content">${body}</div>
  <div class="footer">由聚量引力RaaS系统自动生成 · ${new Date().toLocaleString('zh-CN')}</div>
</body>
</html>`;
}

export async function processWorkerResult(result: WorkerResult): Promise<void> {
  // 获取用户品牌词
  const brandKeywords = await getBrandKeywords(result.userId);

  // 使用 recognizer 做品牌词+联系方式联合识别
  // recognizer 只在品牌词附近 ±300 字符窗口内识别联系方式，避免误识别
  const recognizeResult = recognizeContent(result.content, brandKeywords);

  // 先插入 record 获取 id
  const recordId = await insertRealCollectRecord({
    taskId: result.taskId,
    userId: result.userId,
    keyword: result.keyword,
    keywordType: result.keywordType,
    platform: result.platform,
    brandMatched: recognizeResult.brandMatched,
    matchedBrands: recognizeResult.matchedBrands,
    hasContact: recognizeResult.hasContact,
    contacts: recognizeResult.contacts,
    shareUrl: result.shareUrl,
    staticPageId: null,
    rawContent: result.content,
    queryTime: result.queryTime,
    workerId: result.workerId
  });

  // 不支持分享的平台或没有分享链接的，生成静态页
  if (!result.supportsShare || !result.shareUrl) {
    const html = generateStaticHtml(result.keyword, result.platform, result.content, result.htmlContent);
    const staticPageId = await insertStaticPage(recordId, html);
    await updateRecordStaticPageId(recordId, staticPageId);
  }
}
