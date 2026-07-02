import axios from 'axios';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeout?: number; // 毫秒，默认 120000（2分钟）
  /**
   * 是否启用联网搜索（各平台参数不同，按 base_url / model 推断平台后注入对应字段）
   * - 智谱（bigmodel.cn / zhipuai）：tools: [{ type: 'web_search' }]
   * - 通义（dashscope.aliyuncs.com）：enable_search: true
   * - Kimi（moonshot.cn）：tools: [{ type: 'builtin_function', function: { name: 'web_search' } }]
   * - 豆包（volces.com）：启用插件 search_web（具体参数以火山引擎文档为准）
   * - 其他平台：不注入（不支持或需自定义）
   */
  webSearch?: boolean;
}

export interface ChatCompletionResult {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
 * 调用 OpenAI 兼容协议的 chat completions 接口
 * 支持 DeepSeek/豆包/混元/通义/文心/Kimi/智谱 等国内大模型
 *
 * 注意：
 *  - maxTokens 为 undefined 时不传 max_tokens 字段，让大模型用默认值（不限制输出长度）
 *  - temperature 为 undefined 时默认 0.7
 *  - webSearch 为 true 时按平台动态注入联网搜索参数
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  const body: any = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
  };
  // 仅在显式指定 maxTokens 时才传 max_tokens（不限制输出长度）
  if (params.maxTokens != null) {
    body.max_tokens = params.maxTokens;
  }

  // 联网搜索：按平台动态注入（v1.4.1 修正三家平台参数错误）
  // 与 auto-collect-worker/src/apiAdapter.ts 的 applyWebSearchParams 保持一致
  if (params.webSearch) {
    const platform = detectPlatform(params.baseUrl, params.model);
    switch (platform) {
      case 'zhipu':
        // 智谱 GLM-4 web_search 工具
        body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
        break;
      case 'qianwen':
        // 通义千问 enable_search（OpenAI 兼容模式）
        body.enable_search = true;
        break;
      case 'kimi':
        // Kimi 内置函数名必须是 '$web_search'（带 $ 前缀），否则 HTTP 400
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
        // 文心一言（百度千帆 OpenAI 兼容模式）：用 extra_parameters 而非 enable_search
        body.extra_parameters = { search: true };
        break;
      // DeepSeek 暂不支持联网搜索（截至 2025-08），忽略
      default:
        break;
    }
  }

  const response = await axios.post(params.baseUrl, body, {
    headers: {
      'Authorization': `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: params.timeout ?? 120000,
  });

  // 兼容各平台响应结构：标准 OpenAI content / 文心 result / function_call 兜底
  const data = response.data as any;
  const content = extractContent(data);
  const usage = data?.usage;

  return { content, usage };
}

/**
 * 从 HTTP 响应中提取文本内容，兼容各平台的响应结构
 *
 * 文心一言开启联网搜索时，可能返回 function_call / tool_calls 形式而非 content，
 * 需要兜底从其他字段取值，避免 "空内容" 误判
 */
function extractContent(data: any): string {
  if (!data) return '';
  const choice = data.choices?.[0];
  if (!choice) return '';
  const msg = choice.message || {};

  // 1. 标准 OpenAI 格式
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

/**
 * 从 axios 错误对象中提取各平台兼容的错误信息
 * 兼容 OpenAI / 通义 / 智谱 / 火山方舟 / Kimi / 文心 等不同的错误 JSON 结构
 */
export function extractApiErrorMessage(err: any): string {
  const status = err?.response?.status;
  const data = err?.response?.data;

  // 1. OpenAI 兼容格式：{ error: { message, type, code } }
  // 2. 智谱：{ error: { code, message } }
  // 3. 火山方舟：可能 { error: { message } } 或 { Message: "..." }
  if (data) {
    if (typeof data === 'string') return data.slice(0, 300);
    if (data.error?.message) return data.error.message;
    if (data.error && typeof data.error === 'string') return data.error;
    if (data.Message) return data.Message;
    if (data.message) return data.message;
    // 通义千问：{ code: "InvalidApiKey", message: "...", request_id: "..." }
    if (data.code && data.message) return `[${data.code}] ${data.message}`;
    if (data.code) return `[${data.code}]`;
  }

  // 4. axios 原生错误（网络层/超时）
  if (err?.code === 'ECONNABORTED') return '请求超时（30s），请检查网络或稍后重试';
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
    return `无法连接到 base_url（${err.code}），请检查地址是否正确`;
  }
  if (status === 401 || status === 403) return `认证失败（HTTP ${status}）：API-KEY 无效或无权限`;
  if (status === 404) return `接口地址不存在（HTTP 404）：请检查 base_url 是否正确`;
  if (status === 429) return `请求频率超限（HTTP 429）：请稍后重试`;
  if (status && status >= 500) return `服务端错误（HTTP ${status}）：平台暂不可用，请稍后重试`;

  return err?.message || '未知错误';
}

/**
 * 测试模型连通性 — 发送一条简单消息验证 KEY 是否有效
 */
export async function testModelConnection(params: ChatCompletionParams): Promise<{ success: boolean; message: string }> {
  try {
    const result = await chatCompletion({
      ...params,
      messages: [
        { role: 'user', content: '请回复"连接成功"四个字' },
      ],
      maxTokens: 50,
      timeout: 30000,
    });
    return { success: true, message: result.content.slice(0, 100) };
  } catch (err: any) {
    return { success: false, message: extractApiErrorMessage(err) };
  }
}

// ---------- Embedding 接口 ----------

export interface EmbeddingParams {
  /** embedding 接口完整 URL（如 https://open.bigmodel.cn/api/paas/v4/embeddings） */
  baseUrl: string;
  apiKey: string;
  model: string;
  input: string;
  timeout?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * 调用 OpenAI 兼容协议的 embeddings 接口
 * 支持智谱/通义/OpenAI 等提供 embedding 的平台
 *
 * 注意：DeepSeek 不提供 embedding 接口，需配置其他平台的模型
 */
export async function embeddings(params: EmbeddingParams): Promise<EmbeddingResult> {
  const body = {
    model: params.model,
    input: params.input,
  };

  const response = await axios.post(params.baseUrl, body, {
    headers: {
      'Authorization': `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: params.timeout ?? 30000,
  });

  const data = response.data as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding 接口返回格式异常：缺少 data[0].embedding');
  }

  return { embedding, usage: data?.usage };
}
