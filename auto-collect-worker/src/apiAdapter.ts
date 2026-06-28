/**
 * API 适配器（v1.4：用大模型 API 替代爬虫做智能巡检）
 *
 * 核心思路：
 *  - 各家大模型都有 OpenAI 兼容协议的 chat/completions 接口
 *  - 巡检的"查询"本质就是让 AI 回答用户的关键词问题
 *  - API 返回完整内容（无截断），不依赖 DOM 选择器，不会被封号
 *
 * 调用流程：
 *  1. getApiConfig(platform) 从云端拉取该平台的 API 配置（含解密后的 api_key、webSearch 开关）
 *  2. queryByApi(config, keyword) 调用 OpenAI 兼容接口
 *  3. 返回 { content, htmlContent } —— shareUrl 传 null，由云端自动生成静态页
 */
import axios from 'axios';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  /** 是否启用联网搜索（用户在 AI 模型配置 Tab 中开启） */
  webSearch?: boolean;
}

export interface ApiQueryResult {
  content: string;
  htmlContent: string;
  /** API 模式没有原生分享链接，由云端生成静态页 */
  shareUrl: null;
  supportsShare: boolean;
}

/**
 * 根据 baseUrl / model 推断平台标识，用于按平台注入联网搜索参数
 */
function detectPlatform(baseUrl: string, model: string): string {
  const url = (baseUrl || '').toLowerCase();
  const m = (model || '').toLowerCase();
  if (url.includes('bigmodel.cn') || url.includes('zhipuai')) return 'zhipu';
  if (url.includes('dashscope.aliyuncs.com') || url.includes('qianwen')) return 'qianwen';
  if (url.includes('moonshot.cn') || url.includes('moonshot') || m.startsWith('moonshot') || m.startsWith('kimi')) return 'kimi';
  if (url.includes('volces.com') || url.includes('doubao') || m.startsWith('doubao')) return 'doubao';
  if (url.includes('hunyuan') || m.startsWith('hunyuan')) return 'hunyuan';
  if (url.includes('wenxin') || url.includes('baidubce') || m.startsWith('ernie')) return 'wenxin';
  if (url.includes('deepseek') || m.startsWith('deepseek')) return 'deepseek';
  return '';
}

/**
 * 从云端获取巡检平台对应的 API 配置
 * 返回 null 表示该平台未配置 API，Worker 应降级走爬虫
 */
export async function getApiConfig(platform: string): Promise<ApiConfig | null> {
  try {
    const resp = await axios.get(
      `${SERVER_URL}/platform-auth/api-config/${encodeURIComponent(platform)}`,
      { timeout: 5000 }
    );
    if (resp.data?.code === 200 && resp.data?.data) {
      return {
        baseUrl: resp.data.data.baseUrl,
        apiKey: resp.data.data.apiKey,
        modelName: resp.data.data.modelName,
        webSearch: !!resp.data.data.webSearch,
      };
    }
    return null;
  } catch (e: any) {
    // 网络/服务器错误不降级爬虫（可能只是暂时网络抖动），但记录日志
    logger.warn(`[API] 获取 ${platform} API 配置失败: ${e.message}`);
    return null;
  }
}

/**
 * 调用 OpenAI 兼容协议的 chat/completions 接口
 *
 * 8 平台通用：DeepSeek/豆包/混元/通义/文心/Kimi/智谱 均支持此协议
 *
 * @param config API 配置（baseUrl/apiKey/modelName/webSearch）
 * @param keyword 查询关键词（即用户的问题）
 * @returns 完整内容（无截断）
 */
export async function queryByApi(config: ApiConfig, keyword: string): Promise<ApiQueryResult> {
  const body: any = {
    model: config.modelName,
    messages: [
      {
        role: 'user',
        // 直接把关键词作为问题发给大模型
        // 巡检的目的是看大模型如何回答用户关于品牌/产品的问题
        content: keyword,
      },
    ],
    temperature: 0.7,
    // 不传 max_tokens，让大模型用默认值输出完整内容（不限制长度）
    stream: false,
  };

  // 联网搜索：按平台动态注入
  if (config.webSearch) {
    const platform = detectPlatform(config.baseUrl, config.modelName);
    switch (platform) {
      case 'zhipu':
        body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
        break;
      case 'qianwen':
        body.enable_search = true;
        break;
      case 'kimi':
        body.tools = [{
          type: 'builtin_function',
          function: { name: 'web_search' },
        }];
        break;
      case 'doubao':
        body.plugins = [{ name: 'search_web' }];
        break;
      case 'hunyuan':
      case 'wenxin':
        body.enable_search = true;
        break;
      // DeepSeek 暂不支持联网搜索，忽略
      default:
        break;
    }
  }

  const response = await axios.post(config.baseUrl, body, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120000, // 2 分钟，大模型生成长内容可能需要时间
  });

  const content = (response.data as any)?.choices?.[0]?.message?.content || '';
  if (!content) {
    throw new Error('API 返回空内容');
  }

  // 将纯文本/markdown 内容包装为 HTML（保留换行格式）
  const htmlContent = `<div style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.6;">${escapeHtml(content)}</div>`;

  return {
    content,
    htmlContent,
    shareUrl: null, // API 模式无原生分享，云端会自动生成静态页
    supportsShare: false,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
