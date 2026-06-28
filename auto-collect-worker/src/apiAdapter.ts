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
 * 按平台注入联网搜索参数（v1.4.1 修正三家平台参数错误）
 *
 * 之前 bug：
 *  - Kimi：函数名 'web_search' 错误，正确是 '$web_search'（带 $ 前缀），导致 HTTP 400
 *  - 文心一言：'enable_search=true' 百度千帆 OpenAI 兼容接口不识别，
 *    正确参数是 'extra_parameters.search=true'，且响应可能放在 tool_calls/function_call
 *  - 智谱：参数格式正确，429 是限流问题，已加重试
 */
function applyWebSearchParams(platform: string, body: any): void {
  switch (platform) {
    case 'zhipu':
      // 智谱 GLM-4 web_search 工具
      body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
      break;
    case 'qianwen':
      // 通义千问 OpenAI 兼容模式
      body.enable_search = true;
      break;
    case 'kimi':
      // Kimi 内置函数名必须是 '$web_search'（带 $ 前缀）
      body.tools = [{
        type: 'builtin_function',
        function: { name: '$web_search' },
      }];
      break;
    case 'doubao':
      // 豆包（火山方舟）启用搜索插件
      body.plugins = [{ name: 'search_web' }];
      break;
    case 'hunyuan':
      // 混元 enable_search
      body.enable_search = true;
      break;
    case 'wenxin':
      // 百度千帆 OpenAI 兼容模式：用 extra_parameters 而非 enable_search
      body.extra_parameters = { search: true };
      break;
    // DeepSeek 暂不支持联网搜索，忽略
    default:
      break;
  }
}

/**
 * 从 HTTP 响应中提取文本内容，兼容各平台的响应结构
 *
 * 文心一言开启联网搜索时，可能返回 function_call / tool_calls 形式而非 content，
 * 需要兜底从其他字段取值，避免 "API 返回空内容" 误判
 */
function extractContent(data: any): string {
  if (!data) return '';
  const choice = data.choices?.[0];
  if (!choice) return '';
  const msg = choice.message || {};

  // 1. 标准 OpenAI 格式：choices[0].message.content
  if (msg.content) return String(msg.content);

  // 2. 文心/千帆格式：result 字段
  if (data.result) return String(data.result);

  // 3. function_call / tool_calls 兜底（联网搜索时可能返回）
  if (msg.function_call?.arguments) return String(msg.function_call.arguments);
  if (msg.tool_calls?.length) {
    const first = msg.tool_calls[0];
    if (first?.function?.arguments) return String(first.function.arguments);
  }

  return '';
}

/** 简易睡眠 */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 调用 OpenAI 兼容协议的 chat/completions 接口
 *
 * 8 平台通用：DeepSeek/豆包/混元/通义/文心/Kimi/智谱 均支持此协议
 *
 * 容错策略：
 *  1. 优先用用户配置的参数调用（含联网搜索）
 *  2. 失败时打印完整错误响应，便于排查
 *  3. 429 限流：指数退避重试 2 次
 *  4. 联网搜索导致 4xx 或空内容：降级为不带联网搜索重试一次（保证巡检结果不丢失）
 */
export async function queryByApi(config: ApiConfig, keyword: string): Promise<ApiQueryResult> {
  const platform = detectPlatform(config.baseUrl, config.modelName);
  const buildBody = (withWebSearch: boolean) => {
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
    if (withWebSearch && config.webSearch) {
      applyWebSearchParams(platform, body);
    }
    return body;
  };

  // 第一次：按用户配置（含联网搜索）调用
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = buildBody(true);
    try {
      const response = await axios.post(config.baseUrl, body, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000, // 2 分钟，大模型生成长内容可能需要时间
      });

      const content = extractContent(response.data);
      if (!content) {
        // 联网搜索时可能返回空 content（如文心一言把结果放在 function_call）
        // 打印响应结构便于排查，并降级重试
        logger.warn(`[API] ${platform} 返回空内容，响应结构: ${JSON.stringify(response.data).slice(0, 500)}`);
        throw new Error('API 返回空内容');
      }

      const htmlContent = `<div style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.6;">${escapeHtml(content)}</div>`;
      return {
        content,
        htmlContent,
        shareUrl: null,
        supportsShare: false,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      const respData = e?.response?.data;
      const respStr = typeof respData === 'string' ? respData.slice(0, 300) : JSON.stringify(respData || {}).slice(0, 300);

      // 429 限流：指数退避重试（最多 2 次重试 = 总共 3 次）
      if (status === 429 && attempt < 2) {
        const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s
        logger.warn(`[API] ${platform} 429 限流，${backoff}ms 后重试 (attempt=${attempt + 1}/3): ${respStr}`);
        await sleep(backoff);
        continue;
      }

      // 4xx 错误（参数问题）：降级为不带联网搜索重试一次
      if (status && status >= 400 && status < 500 && status !== 429 && config.webSearch) {
        logger.warn(`[API] ${platform} 联网搜索调用失败 (HTTP ${status}): ${respStr}，降级为不带联网搜索重试`);
        try {
          const fallbackBody = buildBody(false);
          const fallbackResp = await axios.post(config.baseUrl, fallbackBody, {
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 120000,
          });
          const fallbackContent = extractContent(fallbackResp.data);
          if (fallbackContent) {
            logger.info(`[API] ${platform} 降级（无联网搜索）调用成功，内容长度=${fallbackContent.length}`);
            const htmlContent = `<div style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.6;">${escapeHtml(fallbackContent)}</div>`;
            return {
              content: fallbackContent,
              htmlContent,
              shareUrl: null,
              supportsShare: false,
            };
          }
        } catch (fallbackErr: any) {
          logger.warn(`[API] ${platform} 降级重试仍失败: ${fallbackErr.message}`);
        }
      }

      // 空内容：降级为不带联网搜索重试一次（文心一言场景）
      if (e.message === 'API 返回空内容' && config.webSearch) {
        logger.warn(`[API] ${platform} 开启联网搜索后返回空内容，降级为不带联网搜索重试`);
        try {
          const fallbackBody = buildBody(false);
          const fallbackResp = await axios.post(config.baseUrl, fallbackBody, {
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 120000,
          });
          const fallbackContent = extractContent(fallbackResp.data);
          if (fallbackContent) {
            logger.info(`[API] ${platform} 降级（无联网搜索）调用成功，内容长度=${fallbackContent.length}`);
            const htmlContent = `<div style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.6;">${escapeHtml(fallbackContent)}</div>`;
            return {
              content: fallbackContent,
              htmlContent,
              shareUrl: null,
              supportsShare: false,
            };
          }
        } catch (fallbackErr: any) {
          logger.warn(`[API] ${platform} 降级重试仍失败: ${fallbackErr.message}`);
        }
      }

      // 其他错误：抛出，由上层降级爬虫
      const errMsg = status ? `HTTP ${status}: ${respStr}` : e.message;
      throw new Error(errMsg);
    }
  }

  // 重试耗尽
  throw new Error(lastErr?.message || 'API 调用失败');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
