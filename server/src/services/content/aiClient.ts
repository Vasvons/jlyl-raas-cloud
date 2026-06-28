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
 * 调用 OpenAI 兼容协议的 chat completions 接口
 * 支持 DeepSeek/豆包/混元/通义/文心/Kimi/智谱 等国内大模型
 *
 * 注意：maxTokens 为 undefined 时不传 max_tokens 字段，让大模型用默认值（不限制输出长度）
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
