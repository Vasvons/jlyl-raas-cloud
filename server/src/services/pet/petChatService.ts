/**
 * 精灵底座聊天服务（v3.2 方案 A）
 *
 * 职责：
 * 1. 提供精灵默认系统提示词（含软件功能知识库）
 * 2. 调用模型厂商接口做流式对话补全
 *
 * 支持 OpenAI 兼容协议（覆盖 OpenAI/智谱/Kimi/DeepSeek/通义等大多数平台）
 */

import axios from 'axios';

// ---------- 系统提示词 ----------

const DEFAULT_SYSTEM_PROMPT = `你是"灵犀"，聚量引力 RaaS 平台的桌面精灵助理。
你运行在用户桌面端，通过聊天面板与用户交互。

你的核心职责：
1. 回答用户关于软件使用、GEO 优化、内容创作、平台运营的问题
2. 调用已注册的平台工具完成巡检查询、内容生成、发布等任务
3. 监控飞轮状态，提供优化建议
4. 当用户要求创建专家时，直接调用 create_expert 工具执行

回答风格：
- 简洁、友好、口语化
- 涉及操作步骤时用列表
- 不确定时坦诚告知，不编造
- 中文回答

重要约束：
- 调用工具后，必须用自然语言总结工具返回的结果
- 如果工具执行失败，明确告知用户失败原因和下一步建议`;

/** 软件功能知识库（管理端可编辑，未来扩展为可配置） */
const PET_KNOWLEDGE = `# 聚量引力 RaaS 平台功能说明

## 1. 平台架构
聚量引力 RaaS 是云端 + 桌面端分离架构的 GEO（Generative Engine Optimization）优化平台。
- 云端：任务调度、数据存储、AI 分析、Worker 执行
- 桌面端：Electron 应用，本地代理 18080 端口，三窗口（主窗口/桌面精灵/聊天面板）

## 2. 核心模块

### 聚量 GEO 中枢
- 真实查询：24/7 循环调度，多账号轮询查询关键词排名
- AEO 分析：每轮完成后自动生成 AEO 报告（AI 搜索引擎收录分析）
- 内容创作：AI 写作任务，支持专家角色、写作指令、企业知识库
- 内容发布：12 平台种子步骤，自动发布到自媒体账号

### 智能体公司
- 多专家协作：可创建多个 AI 专家角色
- 任务委派：精灵可委派任务给专家

## 3. 飞轮守护进程
- 自动守护：循环调度巡检任务
- AEO→创作：AEO 报告生成后自动触发写作
- 写作→发布：文章生成后自动触发发布
- 云端 Worker 开关：开启后任务由云端 Worker 执行，关闭后由本地 Worker 执行

## 4. 账号池管理
- normal（正常）/ banned（被封禁）/ offline（掉线）三态
- 巡检账号：用于关键词查询
- 发布账号：用于内容发布，可绑定代理

## 5. MCP 工具库（v3.2+）
精灵通过 MCP 工具操作软件功能：
- 巡检工具集：query_keywords / query_collect_records / query_account_health
- AEO 工具集：query_aeo_report / check_seo_score
- 写作工具集：generate_article / query_article_status / create_expert
- 发布工具集：publish_article / query_publish_records
- 版本发布工具集（v3.7+，仅管理员可用）：
  - list_releases：查询已发布版本历史
  - prepare_release_draft：准备发布草稿（自动扫描 dist49 打包产物、读取 git log 生成 changelog）
  - publish_release：执行版本发布（上传 OSS + 创建发布记录，需先 prepare_release_draft）
  - list_agents / update_rollout / delete_release：灰度管理与版本删除
  - 工作流：list_releases → prepare_release_draft → 询问发布类型/策略 → publish_release
  - 注意：调用 publish_release 前必须先调用 prepare_release_draft 获取草稿，发布类型和发布策略需向用户询问

## 6. 订阅体系
- 模块订阅：按板块订阅（聚量GEO中枢/智能体公司/灵犀站点引擎）
- 云端增强包：扩展 Worker 并发
- 私有部署：本地部署 Worker`;

export function getPetSystemPrompt(): string {
  return `${DEFAULT_SYSTEM_PROMPT}\n\n# 软件功能知识库\n${PET_KNOWLEDGE}`;
}

/**
 * v3.2.4：构造完整 systemPrompt
 * - 基础提示词
 * - 知识库段落（来自 pet_knowledge 表，管理端可编辑）
 * - 用户画像/摘要段落（来自 pet_memory_summary 表）
 */
export function buildPetSystemPrompt(knowledge: string, userSummary: string): string {
  let prompt = DEFAULT_SYSTEM_PROMPT;
  if (knowledge) {
    prompt += `\n\n# 软件功能知识库\n${knowledge}`;
  } else {
    // 降级：知识库为空时用硬编码
    prompt += `\n\n# 软件功能知识库\n${PET_KNOWLEDGE}`;
  }
  if (userSummary) {
    prompt += `\n\n${userSummary}`;
  }
  return prompt;
}

export function getDefaultPetKnowledge(): string {
  return PET_KNOWLEDGE;
}

// ---------- 模型调用 ----------

export interface ModelConfig {
  platform: string;
  model_name: string;
  api_key: string;
  base_url?: string | null;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** v3.7：tool 消息必须带 tool_call_id；assistant 消息带 tool_calls 时也用 */
  tool_call_id?: string;
  /** v3.7：assistant 消息携带工具调用请求 */
  tool_calls?: any[];
  /** v3.7：assistant 消息中 tool_calls 的占位 content（通常为 null 或空字符串） */
  name?: string;
}

export interface CallModelStreamParams {
  modelConfig: ModelConfig;
  messages: ChatMessage[];
  systemPrompt?: string;
  /** v3.7：OpenAI function calling 工具列表（MCP 工具转换后） */
  tools?: any[];
  onDelta: (text: string) => void;
  /** v3.7：工具调用回调，模型返回 tool_calls 时触发（在 done 之前） */
  onToolCall?: (toolCalls: any[]) => void;
}

export interface CallModelStreamResult {
  fullText: string;
  usage?: any;
  /** v3.7：模型返回的工具调用列表（finish_reason='tool_calls' 时非空） */
  toolCalls?: any[];
}

/**
 * 调用模型流式接口（OpenAI 兼容协议）
 *
 * 支持：OpenAI / 智谱 / Kimi / DeepSeek / 通义 / Ollama 等
 * 不支持：文心一言（需单独适配，未来扩展）
 *
 * v3.7：支持 function calling（tools 参数 + tool_calls 流式解析）
 */
export async function callModelStream(params: CallModelStreamParams): Promise<CallModelStreamResult> {
  const { modelConfig, messages, systemPrompt, onDelta, onToolCall } = params;

  // 构造请求体
  const finalMessages: ChatMessage[] = [];
  if (systemPrompt) {
    finalMessages.push({ role: 'system', content: systemPrompt });
  }
  finalMessages.push(...messages.filter(m => m.role !== 'system'));

  // 确定 baseUrl（不同平台默认值）
  const baseUrl = resolveBaseUrl(modelConfig);
  const url = `${baseUrl}/chat/completions`;

  // 请求头
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${modelConfig.api_key}`,
  };

  // 请求体
  // v3.2.3：pg 查询 numeric/decimal 字段默认是字符串，需显式 Number() 转换
  // 否则 DeepSeek 等厂商会报 "invalid type: string \"0.70\", expected f32"
  const maxTokens = modelConfig.max_tokens != null ? Number(modelConfig.max_tokens) : undefined;
  const temperature = modelConfig.temperature != null ? Number(modelConfig.temperature) : undefined;

  const body: any = {
    model: modelConfig.model_name,
    messages: finalMessages,
    stream: true,
  };
  if (maxTokens && !Number.isNaN(maxTokens)) body.max_tokens = maxTokens;
  if (temperature !== undefined && !Number.isNaN(temperature)) {
    body.temperature = temperature;
  }
  // v3.7：注入 tools（OpenAI function calling 格式）
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }

  // 流式请求
  let response;
  try {
    response = await axios.post(url, body, {
      headers,
      responseType: 'stream',
      timeout: 60000,
      validateStatus: () => true, // 不抛异常，手动处理错误状态码
    });
  } catch (e: any) {
    // 网络层错误（DNS 解析失败、连接被拒等）
    throw new Error(`无法连接模型厂商 API: ${e.message}（URL: ${url}）`);
  }

  // 非 2xx 响应：读取 stream 内容并包装错误信息
  if (response.status < 200 || response.status >= 300) {
    let errBody = '';
    try {
      const stream = response.data as NodeJS.ReadableStream;
      errBody = await new Promise<string>((resolve) => {
        let data = '';
        stream.on('data', (c: Buffer) => { data += c.toString('utf-8'); });
        stream.on('end', () => resolve(data));
        stream.on('error', () => resolve(''));
        setTimeout(() => resolve(data || ''), 3000);
      });
    } catch { /* ignore */ }

    if (response.status === 404) {
      throw new Error(`模型厂商 API 返回 404（URL: ${url}，model: ${modelConfig.model_name}）。请检查 base_url 是否正确（通常需以 /v1 结尾），以及 model_name 是否存在。响应: ${errBody.slice(0, 200)}`);
    } else if (response.status === 401) {
      throw new Error(`模型厂商 API 鉴权失败（401）。请检查 API Key 是否正确。响应: ${errBody.slice(0, 200)}`);
    } else {
      throw new Error(`模型厂商 API 返回 ${response.status}。响应: ${errBody.slice(0, 200)}`);
    }
  }

  let fullText = '';
  let usage: any = undefined;
  // v3.7：工具调用累积器（按 index 分片累积 arguments 字符串）
  // 流式响应里 delta.tool_calls 是分片的：第一片带 id/name，后续片只带 arguments 增量
  const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let finishReason: string | undefined;

  return new Promise<CallModelStreamResult>((resolve, reject) => {
    let buffer = '';
    const stream = response.data as NodeJS.ReadableStream;
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      // 按行处理 SSE
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一行可能不完整，保留

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          // 文本增量
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            fullText += delta.content;
            onDelta(delta.content);
          }

          // v3.7：工具调用增量（分片累积）
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const existing = toolCallAccumulator.get(idx) || { id: '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                existing.arguments += tc.function.arguments;
              }
              toolCallAccumulator.set(idx, existing);
            }
          }

          // finish_reason 标识本轮结束（content 或 tool_calls 完成）
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          // 部分平台把 usage 放在最后一个 chunk
          if (parsed.usage) {
            usage = parsed.usage;
          }
        } catch (e) {
          // 忽略解析错误的行
        }
      }
    });

    stream.on('end', () => {
      // v3.7：finish_reason='tool_calls' 表示模型请求工具调用
      const toolCallsList = Array.from(toolCallAccumulator.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([_, v]) => ({
          id: v.id,
          type: 'function',
          function: { name: v.name, arguments: v.arguments },
        }));

      if (toolCallsList.length > 0 && finishReason === 'tool_calls') {
        // 通过回调通知调用方（用于 SSE 实时下发）
        if (onToolCall) {
          try { onToolCall(toolCallsList); } catch (e) { /* ignore */ }
        }
        resolve({ fullText, usage, toolCalls: toolCallsList });
      } else {
        resolve({ fullText, usage });
      }
    });

    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/** 解析 baseUrl（按平台补默认值） */
function resolveBaseUrl(config: ModelConfig): string {
  let url = '';
  if (config.base_url) {
    url = config.base_url.replace(/\/+$/, '');
  } else {
    const platform = (config.platform || '').toLowerCase();
    const defaults: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      zhipu: 'https://open.bigmodel.cn/api/paas/v4',
      glm: 'https://open.bigmodel.cn/api/paas/v4',
      kimi: 'https://api.moonshot.cn/v1',
      moonshot: 'https://api.moonshot.cn/v1',
      deepseek: 'https://api.deepseek.com/v1',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      tongyi: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ollama: 'http://127.0.0.1:11434/v1',
    };
    url = defaults[platform] || 'https://api.openai.com/v1';
  }
  // v3.2.2：用户可能把完整 endpoint 填进 base_url（如 .../v1/chat/completions），自动剥离避免重复拼接
  url = url.replace(/\/chat\/completions\/?$/i, '');
  return url;
}
