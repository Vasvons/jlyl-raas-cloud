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

  // 联网搜索：按平台动态注入
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
        // Kimi 内置 web_search 函数
        body.tools = [{
          type: 'builtin_function',
          function: { name: 'web_search' },
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
        // 文心一言（千帆 OpenAI 兼容）启用联网搜索
        body.enable_search = true;
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

  const content = (response.data as any)?.choices?.[0]?.message?.content || '';
  const usage = (response.data as any)?.usage;

  return { content, usage };
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
    const msg = err.response?.data?.error?.message || err.message || '未知错误';
    return { success: false, message: msg };
  }
}
