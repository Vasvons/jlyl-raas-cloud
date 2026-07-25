/**
 * 精灵记忆库业务逻辑（v3.2.4）
 *
 * 职责：
 * 1. 加载历史对话注入 messages
 * 2. 加载用户画像/摘要注入 systemPrompt
 * 3. 对话完成后异步保存到 pet_memory
 * 4. 超过阈值时自动触发长期摘要
 *
 * 设计原则：
 * - 短期记忆：最近 N 条对话直接拼到 messages（默认 50）
 * - 长期摘要：超过 30 条时自动用 LLM 总结，写入 pet_memory_summary
 * - 用户画像：从对话中提取偏好，单独存储
 */
import {
  savePetMemory,
  getPetMemoryBySession,
  listPetMemorySessions,
  deletePetMemorySession,
  deleteAllPetMemory,
  countPetMemoryBySession,
  getPetMemorySummary,
  upsertPetMemorySummary,
  getAllPetMemorySummaries,
} from '../../repository';
import { callModelStream } from './petChatService';

// 配置常量
const HISTORY_LOAD_LIMIT = 50;        // 加载历史对话条数
const AUTO_SUMMARY_THRESHOLD = 30;    // 超过此条数自动触发摘要
const MAX_SUMMARY_LENGTH = 800;       // 摘要最大字符数

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * 加载指定会话的历史对话（用于注入 /pet/chat 的 messages）
 */
export async function loadSessionHistory(
  userId: number,
  sessionId: string
): Promise<MemoryMessage[]> {
  const rows = await getPetMemoryBySession(userId, sessionId, HISTORY_LOAD_LIMIT);
  return rows.map((r: any) => ({
    role: r.role,
    content: r.content,
  }));
}

/**
 * 加载用户最近一个会话的 session_id（用于桌面端启动时恢复）
 */
export async function getLatestSessionId(userId: number): Promise<string | null> {
  const sessions = await listPetMemorySessions(userId);
  return sessions[0]?.session_id || null;
}

/**
 * 保存一条对话消息到 pet_memory
 */
export async function saveMessage(
  userId: number,
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  metadata?: any
): Promise<void> {
  await savePetMemory({ user_id: userId, session_id: sessionId, role, content, metadata });
}

/**
 * 异步保存一轮对话（user + assistant）
 */
export async function saveChatTurn(
  userId: number,
  sessionId: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  // 不阻塞主流程：用 setImmediate 异步执行
  setImmediate(async () => {
    try {
      await saveMessage(userId, sessionId, 'user', userMessage);
      await saveMessage(userId, sessionId, 'assistant', assistantMessage);

      // 检查是否需要自动摘要
      const count = await countPetMemoryBySession(userId, sessionId);
      if (count >= AUTO_SUMMARY_THRESHOLD) {
        await autoSummarizeSession(userId, sessionId).catch(err => {
          console.warn('[MemoryService] 自动摘要失败（不影响对话）:', err.message);
        });
      }
    } catch (err: any) {
      console.error('[MemoryService] 保存对话失败:', err.message);
    }
  });
}

/**
 * 加载用户长期摘要，拼成 systemPrompt 段落
 */
export async function loadUserSummaryForPrompt(userId: number): Promise<string> {
  const summaries = await getAllPetMemorySummaries(userId);
  if (summaries.length === 0) return '';

  const parts: string[] = [];
  for (const s of summaries) {
    const label = SUMMARY_TYPE_LABELS[s.summary_type] || s.summary_type;
    parts.push(`### ${label}\n${s.content}`);
  }
  return `# 用户画像与历史摘要\n\n${parts.join('\n\n')}`;
}

const SUMMARY_TYPE_LABELS: Record<string, string> = {
  user_profile: '用户画像',
  session_summary: '上次会话摘要',
  key_facts: '关键事实',
};

/**
 * 自动摘要：把整个会话压缩成不超过 MAX_SUMMARY_LENGTH 的摘要
 * 写入 pet_memory_summary 的 session_summary 类型
 */
async function autoSummarizeSession(userId: number, sessionId: string): Promise<void> {
  const history = await getPetMemoryBySession(userId, sessionId, 200);
  if (history.length < AUTO_SUMMARY_THRESHOLD) return;

  const modelConfig = await getPetModelConfigForSummary(userId);
  if (!modelConfig) {
    console.warn('[MemoryService] 无可用模型配置，跳过自动摘要');
    return;
  }

  // 构造对话文本
  const dialogText = history
    .map((h: any) => `${h.role === 'user' ? '用户' : '精灵'}: ${h.content}`)
    .join('\n');

  const summaryPrompt = `请把以下对话总结为不超过 ${MAX_SUMMARY_LENGTH} 字的摘要，重点提取：
1. 用户的核心需求和关注点
2. 已解决的问题和未解决的问题
3. 用户的偏好和习惯
4. 关键事实（如公司名、产品名、操作流程等）

只输出摘要正文，不要加标题或前后缀。

对话内容：
${dialogText}`;

  try {
    const result = await callModelStream({
      modelConfig,
      messages: [{ role: 'user', content: summaryPrompt }],
      systemPrompt: '你是一个对话摘要助手，擅长从冗长对话中提取关键信息。',
      onDelta: () => {},
    });

    if (result.fullText) {
      await upsertPetMemorySummary(userId, 'session_summary', result.fullText, {
        session_id: sessionId,
        message_count: history.length,
      });
      console.log(`[MemoryService] 会话 ${sessionId} 已自动摘要（${result.fullText.length} 字）`);
    }
  } catch (err: any) {
    console.warn('[MemoryService] 自动摘要调用 LLM 失败:', err.message);
  }
}

/**
 * 获取用于摘要的模型配置（复用精灵底座模型）
 */
async function getPetModelConfigForSummary(userId: number): Promise<any | null> {
  // 动态 import 避免循环依赖
  const { getPetModelConfigWithKey } = await import('../../repository');
  return await getPetModelConfigWithKey(userId);
}

/**
 * 清空指定会话
 */
export async function clearSession(userId: number, sessionId: string): Promise<number> {
  return await deletePetMemorySession(userId, sessionId);
}

/**
 * 清空用户所有记忆（含摘要）
 */
export async function clearAllMemory(userId: number): Promise<{ messages: number; summaries: number }> {
  const messages = await deleteAllPetMemory(userId);

  // 同时清空摘要
  let summaries = 0;
  const allSummaries = await getAllPetMemorySummaries(userId);
  for (const s of allSummaries) {
    // 摘要表无 delete 函数，用 upsert 空字符串等效清空
    await upsertPetMemorySummary(userId, s.summary_type, '', null);
    summaries++;
  }

  return { messages, summaries };
}

/**
 * 手动更新用户画像
 */
export async function updateUserProfile(userId: number, profile: string): Promise<void> {
  await upsertPetMemorySummary(userId, 'user_profile', profile, { manual: true });
}

/**
 * 生成新 session_id
 */
export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
