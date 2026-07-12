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
  /** 查询来源：api（调用大模型 API）/ crawler（爬虫） */
  source?: 'api' | 'crawler';
}

function generateStaticHtml(keyword: string, platform: string, content: string, htmlContent?: string): string {
  // v2.0.5：优先使用 htmlContent（爬虫模式提取的原始 HTML，保留排版）
  // 其次用 markdown 渲染（API 模式返回纯文本/markdown）
  // 最后兜底用 <pre> 保留纯文本格式
  let body: string;
  if (htmlContent && htmlContent.trim()) {
    body = htmlContent;
  } else {
    body = markdownToHtml(content);
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${platform} - ${escapeHtml(keyword)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; line-height: 1.8; color: #333; background: #fff; }
    .header { border-bottom: 2px solid #1890ff; padding-bottom: 12px; margin-bottom: 24px; }
    .platform { color: #1890ff; font-weight: 600; font-size: 14px; }
    .keyword { font-size: 20px; margin: 8px 0 0; font-weight: 600; color: #222; }
    .content { background: #fafafa; padding: 24px; border-radius: 8px; border: 1px solid #eee; }
    .content h1, .content h2, .content h3, .content h4 { margin-top: 1.4em; margin-bottom: 0.6em; color: #1a1a1a; }
    .content h1 { font-size: 1.5em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
    .content h2 { font-size: 1.3em; }
    .content h3 { font-size: 1.15em; }
    .content h4 { font-size: 1em; }
    .content p { margin: 0.8em 0; }
    .content ul, .content ol { margin: 0.6em 0; padding-left: 2em; }
    .content li { margin: 0.3em 0; }
    .content blockquote { border-left: 4px solid #1890ff; padding: 4px 16px; margin: 1em 0; color: #666; background: #f0f7ff; border-radius: 0 4px 4px 0; }
    .content code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: 'Consolas', 'Monaco', monospace; font-size: 0.9em; }
    .content pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
    .content pre code { background: none; padding: 0; }
    .content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    .content th, .content td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    .content th { background: #f0f0f0; font-weight: 600; }
    .content strong { font-weight: 600; color: #1a1a1a; }
    .content hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
    .content a { color: #1890ff; text-decoration: none; }
    .content a:hover { text-decoration: underline; }
    .footer { margin-top: 24px; color: #999; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="platform">${platform}</div>
    <div class="keyword">查询: ${escapeHtml(keyword)}</div>
  </div>
  <div class="content">${body}</div>
  <div class="footer">内容来源：${platform} · ${new Date().toLocaleString('zh-CN')}</div>
</body>
</html>`;
}

/**
 * 轻量级 Markdown → HTML 转换器（v2.0.5）
 * 不依赖第三方库，支持标题/列表/引用/代码块/粗体/斜体/链接/表格/分隔线
 * 用于静态页生成，还原 AI 回答的排版
 */
function markdownToHtml(markdown: string): string {
  if (!markdown) return '<p style="color:#999;">（无内容）</p>';

  const lines = markdown.split('\n');
  const html: string[] = [];
  let inUl = false;
  let inOl = false;
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let inTable = false;
  let tableBuffer: string[] = [];

  const closeLists = () => {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) {
      // 简单表格渲染：第一行是表头
      if (tableBuffer.length > 0) {
        html.push('<table>');
        const headerCells = tableBuffer[0].split('|').map(c => c.trim()).filter(c => c);
        html.push('<thead><tr>' + headerCells.map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead>');
        if (tableBuffer.length > 2) {
          html.push('<tbody>');
          for (let i = 2; i < tableBuffer.length; i++) {
            const cells = tableBuffer[i].split('|').map(c => c.trim()).filter(c => c);
            html.push('<tr>' + cells.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
          }
          html.push('</tbody>');
        }
        html.push('</table>');
      }
      tableBuffer = [];
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        closeLists();
        closeTable();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // 表格（| 开头）
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeLists();
      inTable = true;
      tableBuffer.push(trimmed);
      continue;
    } else if (inTable) {
      closeTable();
    }

    // 空行
    if (!trimmed) {
      closeLists();
      continue;
    }

    // 标题
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      closeLists();
      const level = hMatch[1].length;
      html.push(`<h${level}>${inlineMd(hMatch[2])}</h${level}>`);
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeLists();
      html.push('<hr>');
      continue;
    }

    // 引用
    if (trimmed.startsWith('>')) {
      closeLists();
      html.push(`<blockquote>${inlineMd(trimmed.substring(1).trim())}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${inlineMd(trimmed.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${inlineMd(trimmed.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    // 普通段落
    closeLists();
    html.push(`<p>${inlineMd(trimmed)}</p>`);
  }

  closeLists();
  closeTable();
  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }

  return html.join('\n');
}

/** 行内 markdown：粗体/斜体/代码/链接 */
function inlineMd(text: string): string {
  let result = escapeHtml(text);
  // 链接 [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // 粗体 **text** 或 __text__
  result = result.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 斜体 *text* 或 _text_
  result = result.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>');
  // 行内代码 `code`
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ProcessResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  recordId: number;
}

export async function processWorkerResult(result: WorkerResult): Promise<ProcessResult | null> {
  // 过滤无效内容：空内容或过短内容（<30字符）说明查询失败或 AI 未回答
  // 这些内容如果保存会被误识别为 brand_matched=true（营销页中可能包含品牌词）
  // 返回 null 让调用方跳过保存
  if (!result.content || result.content.trim().length < 30) {
    console.log(`[resultProcessor] 跳过无效内容: ${result.platform}/${result.keyword.substring(0, 30)} 内容长度=${result.content?.length || 0}`);
    return null;
  }

  // 获取用户品牌词
  const brandKeywords = await getBrandKeywords(result.userId);

  // 使用 recognizer 做品牌词+联系方式联合识别
  // recognizer 只在品牌词附近 ±300 字符窗口内识别联系方式，避免误识别
  const recognizeResult = recognizeContent(result.content, brandKeywords);

  // 只保存有价值的记录：品牌命中 或 有联系方式
  // 既未命中品牌也没有联系方式的记录对用户无用，不保存（避免污染 GEO 报告）
  if (!recognizeResult.brandMatched && !recognizeResult.hasContact) {
    console.log(`[resultProcessor] 跳过无价值记录: ${result.platform}/${result.keyword.substring(0, 30)} 未命中品牌且无联系方式`);
    return null;
  }

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
    workerId: result.workerId,
    source: result.source,
  });

  // 不支持分享的平台或没有分享链接的，生成静态页
  if (!result.supportsShare || !result.shareUrl) {
    const html = generateStaticHtml(result.keyword, result.platform, result.content, result.htmlContent);
    const staticPageId = await insertStaticPage(recordId, html);
    await updateRecordStaticPageId(recordId, staticPageId);
  }

  return {
    brandMatched: recognizeResult.brandMatched,
    matchedBrands: recognizeResult.matchedBrands,
    hasContact: recognizeResult.hasContact,
    recordId
  };
}
