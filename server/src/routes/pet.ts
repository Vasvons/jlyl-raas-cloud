/**
 * 精灵底座路由（v3.2 方案 A）
 *
 * 云端代理转发精灵对话流量：
 *   - 桌面端精灵调用 /pet/chat（SSE 流式）
 *   - 云端读取管理端配置的 use_for_pet=true 模型
 *   - 用解密后的 API Key 调模型厂商接口
 *   - 流式响应转发回桌面端
 *
 * 代理端零配置：不感知 API Key，所有调用走云端统一计费
 * 管理端在「设置 → 精灵底座配置」开启 use_for_pet 开关的模型作为精灵底座
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth';
import {
  getPetModelConfigWithKey, getPetModelConfigForAdmin, upsertPetModelConfig,
  // v3.2.4：知识库 CRUD
  listPetKnowledge, getPetKnowledgeById, createPetKnowledge, updatePetKnowledge,
  deletePetKnowledge, getActivePetKnowledgeForPrompt,
  // v3.2.4：记忆库 CRUD
  savePetMemory, getPetMemoryBySession, listPetMemorySessions,
  deletePetMemorySession, deleteAllPetMemory,
  // v3.2.4：摘要 CRUD
  getAllPetMemorySummaries, upsertPetMemorySummary,
} from '../repository';
import { callModelStream, getPetSystemPrompt, getDefaultPetKnowledge, buildPetSystemPrompt } from '../services/pet/petChatService';
import {
  loadSessionHistory, getLatestSessionId, saveMessage, saveChatTurn,
  loadUserSummaryForPrompt, clearSession, clearAllMemory, generateSessionId,
} from '../services/pet/memoryService';

const router = Router();

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

/**
 * POST /pet/chat
 * 流式对话接口（SSE）
 *
 * Body:
 *   { messages: [{role, content}], systemPrompt?: string, sessionId?: string, tools?: any[] }
 *
 * v3.2.4：自动加载知识库 + 用户摘要注入 systemPrompt；异步保存对话到 pet_memory
 * v3.7：支持 tools 参数（OpenAI function calling 格式），模型返回 tool_calls 时
 *       通过 SSE tool_call 事件下发到桌面端，桌面端本地执行 MCP 工具后再次调用本接口继续生成
 *
 * Response: text/event-stream
 *   data: {"type":"text_delta","text":"..."}        // 增量文本
 *   data: {"type":"tool_call","toolCalls":[...]}    // 工具调用请求（v3.7）
 *   data: {"type":"done","fullText":"..."}          // 完成
 *   data: {"type":"error","message":"..."}          // 错误
 */
router.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ code: 401, message: '未授权' });
  }

  const { messages, systemPrompt, sessionId, tools } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ code: 400, message: '缺少 messages' });
  }

  // 1. 获取精灵底座模型配置（含解密 API Key）
  const modelConfig = await getPetModelConfigWithKey(userId);
  if (!modelConfig) {
    return res.status(400).json({
      code: 4003,
      message: '尚未配置精灵底座模型，请联系管理端在「设置 → 精灵底座配置」中开启',
    });
  }

  // 2. 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // 3. 客户端断开时清理
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  // 4. v3.2.4：构造 systemPrompt（自动加载知识库 + 用户摘要）
  let finalSystemPrompt: string;
  if (systemPrompt) {
    // 客户端显式传入 systemPrompt 时优先用
    finalSystemPrompt = systemPrompt;
  } else {
    try {
      // 并行加载知识库和用户摘要
      const [knowledge, userSummary] = await Promise.all([
        getActivePetKnowledgeForPrompt(),
        loadUserSummaryForPrompt(userId),
      ]);
      finalSystemPrompt = buildPetSystemPrompt(knowledge, userSummary);
    } catch (err: any) {
      console.warn('[PetChat] 加载知识库/摘要失败，降级用默认 systemPrompt:', err.message);
      finalSystemPrompt = getPetSystemPrompt();
    }
  }

  // 5. 调模型流式接口
  try {
    const result = await callModelStream({
      modelConfig,
      messages,
      systemPrompt: finalSystemPrompt,
      tools, // v3.7：透传工具定义
      onDelta: (text) => {
        if (aborted) return;
        res.write(`data: ${JSON.stringify({ type: 'text_delta', text })}\n\n`);
      },
      onToolCall: (toolCalls) => {
        if (aborted) return;
        // v3.7：下发工具调用请求到桌面端
        res.write(`data: ${JSON.stringify({ type: 'tool_call', toolCalls })}\n\n`);
      },
    });

    if (!aborted) {
      // v3.7：如果有工具调用，done 事件附带 toolCalls 让桌面端知道本轮要执行工具
      const donePayload: any = { type: 'done', fullText: result.fullText };
      if (result.toolCalls && result.toolCalls.length > 0) {
        donePayload.toolCalls = result.toolCalls;
        donePayload.hasToolCall = true;
      }
      res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
      res.end();

      // v3.2.4：异步保存对话到 pet_memory（仅在无工具调用时保存，工具调用流程由桌面端继续触发下一轮）
      if (sessionId && result.fullText && !result.toolCalls?.length) {
        // 取最后一条 user message 内容
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          saveChatTurn(userId, sessionId, lastUserMsg.content, result.fullText).catch(err => {
            console.warn('[PetChat] 异步保存对话失败（不影响响应）:', err.message);
          });
        }
      }
    }
  } catch (e: any) {
    console.error('[PetChat] 模型调用失败:', e.message);
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message || '模型调用失败' })}\n\n`);
      res.end();
    }
  }
});

/**
 * GET /pet/model-config
 * v3.2.3：管理端读取精灵底座独立配置（不返回 api_key 明文）
 * 返回 pet_model_config 表中的单行配置
 */
router.get('/model-config', authMiddleware, async (req: Request, res: Response) => {
  try {
    const config = await getPetModelConfigForAdmin();
    if (!config) {
      return res.json({
        code: 200,
        data: {
          configured: false,
          message: '尚未配置精灵底座模型',
        },
      });
    }
    return res.json({
      code: 200,
      data: {
        configured: true,
        id: config.id,
        platform: config.platform,
        model_name: config.model_name,
        base_url: config.base_url,
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        is_active: config.is_active,
        has_api_key: config.has_api_key,
        // 不返回 api_key 明文
        api_key_masked: config.has_api_key ? '********' : null,
        update_time: config.update_time,
      },
    });
  } catch (err: any) {
    console.error('[PetConfig] GET /pet/model-config 失败:', err.message);
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * PUT /pet/model-config
 * v3.2.3：管理端保存精灵底座独立配置（upsert）
 * Body: { platform, model_name, api_key?, base_url?, max_tokens?, temperature?, is_active? }
 * - api_key 为空字符串或 undefined 时不更新（保留原密文）
 * - api_key 为非空字符串时加密后覆盖
 */
router.put('/model-config', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { platform, model_name, api_key, base_url, max_tokens, temperature, is_active } = req.body || {};

    if (!platform || !model_name) {
      return res.status(400).json({ code: 400, message: 'platform 和 model_name 必填' });
    }

    // 数值字段类型转换（前端可能传字符串）
    const maxTokensNum = max_tokens != null && max_tokens !== '' ? Number(max_tokens) : undefined;
    const temperatureNum = temperature != null && temperature !== '' ? Number(temperature) : undefined;
    if (maxTokensNum !== undefined && Number.isNaN(maxTokensNum)) {
      return res.status(400).json({ code: 400, message: 'max_tokens 必须是数字' });
    }
    if (temperatureNum !== undefined && Number.isNaN(temperatureNum)) {
      return res.status(400).json({ code: 400, message: 'temperature 必须是数字' });
    }

    const id = await upsertPetModelConfig({
      platform: String(platform).trim(),
      model_name: String(model_name).trim(),
      api_key: api_key,
      base_url: base_url,
      max_tokens: maxTokensNum,
      temperature: temperatureNum,
      is_active: is_active ?? true,
    });

    console.log(`[PetConfig] PUT /pet/model-config 保存成功 id=${id} platform=${platform} model=${model_name}`);

    return res.json({
      code: 200,
      data: { id, message: '保存成功' },
    });
  } catch (err: any) {
    console.error('[PetConfig] PUT /pet/model-config 失败:', err.message);
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * GET /pet/model-status
 * 查询当前精灵底座模型配置状态（不返回 API Key）
 * v3.2.2：新增 liveCheck=true 时发一个真实的最小请求验证模型厂商可用性
 */
router.get('/model-status', authMiddleware, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const config = await getPetModelConfigWithKey(userId);
  if (!config) {
    return res.json({
      code: 200,
      data: {
        configured: false,
        message: '尚未配置精灵底座模型',
      },
    });
  }

  const liveCheck = req.query.liveCheck === 'true';
  let liveStatus: { ok: boolean; message?: string; url?: string; status?: number } | undefined;

  if (liveCheck) {
    // 发一个最小请求（max_tokens=1）验证模型厂商可达性
    try {
      const { callModelStream } = await import('../services/pet/petChatService');
      const result = await callModelStream({
        modelConfig: config,
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: undefined,
        onDelta: () => {},
      });
      liveStatus = { ok: true, message: `连通正常，收到 ${result.fullText.length} 字符响应` };
    } catch (e: any) {
      liveStatus = { ok: false, message: e.message || '调用失败' };
    }
  }

  return res.json({
    code: 200,
    data: {
      configured: true,
      platform: config.platform,
      model_name: config.model_name,
      base_url: config.base_url || null,
      message: `当前精灵底座：${config.platform} / ${config.model_name}`,
      liveStatus,
    },
  });
});

/**
 * GET /pet/knowledge
 * 获取精灵默认知识库（软件功能说明文档）
 * 用于管理端在「精灵底座配置」中预览/编辑
 */
router.get('/knowledge', authMiddleware, async (req: Request, res: Response) => {
  return res.json({
    code: 200,
    data: {
      system_prompt: getPetSystemPrompt(),
      knowledge: getDefaultPetKnowledge(),
    },
  });
});

// ============ v3.2.4：知识库 CRUD ============

/**
 * GET /pet/knowledge/list
 * 列表（includeInactive=true 显示停用项，仅管理端用）
 */
router.get('/knowledge/list', authMiddleware, async (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const list = await listPetKnowledge(includeInactive);
    return res.json({ code: 200, data: list });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * GET /pet/knowledge/:id
 */
router.get('/knowledge/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const item = await getPetKnowledgeById(Number(req.params.id));
    if (!item) return res.status(404).json({ code: 404, message: '不存在' });
    return res.json({ code: 200, data: item });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * POST /pet/knowledge
 */
router.post('/knowledge', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { title, content, category, sort_order, is_active } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ code: 400, message: 'title 和 content 必填' });
    }
    const id = await createPetKnowledge({
      title: String(title).trim(),
      content: String(content),
      category: category ? String(category) : 'general',
      sort_order: sort_order != null ? Number(sort_order) : 0,
      is_active: is_active ?? true,
    });
    return res.json({ code: 200, data: { id, message: '创建成功' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * PUT /pet/knowledge/:id
 */
router.put('/knowledge/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { title, content, category, sort_order, is_active } = req.body || {};
    const ok = await updatePetKnowledge(Number(req.params.id), {
      title: title !== undefined ? String(title).trim() : undefined,
      content: content !== undefined ? String(content) : undefined,
      category: category !== undefined ? String(category) : undefined,
      sort_order: sort_order != null ? Number(sort_order) : undefined,
      is_active: is_active !== undefined ? !!is_active : undefined,
    });
    if (!ok) return res.status(404).json({ code: 404, message: '不存在或无更新字段' });
    return res.json({ code: 200, data: { message: '更新成功' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * DELETE /pet/knowledge/:id
 */
router.delete('/knowledge/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const ok = await deletePetKnowledge(Number(req.params.id));
    if (!ok) return res.status(404).json({ code: 404, message: '不存在' });
    return res.json({ code: 200, data: { message: '删除成功' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ v3.2.4：记忆库 CRUD ============

/**
 * GET /pet/memory/sessions
 * 获取用户所有会话列表（按最近时间倒序）
 */
router.get('/memory/sessions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessions = await listPetMemorySessions(userId);
    return res.json({ code: 200, data: sessions });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * GET /pet/memory?sessionId=xxx&limit=50
 * 获取指定会话的对话历史
 */
router.get('/memory', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = String(req.query.sessionId || '');
    const limit = Number(req.query.limit) || 50;
    if (!sessionId) {
      return res.status(400).json({ code: 400, message: '缺少 sessionId' });
    }
    const messages = await getPetMemoryBySession(userId, sessionId, limit);
    return res.json({ code: 200, data: messages });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * GET /pet/memory/latest-session
 * 获取用户最近一个会话的 session_id（用于桌面端启动时恢复）
 */
router.get('/memory/latest-session', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = await getLatestSessionId(userId);
    return res.json({ code: 200, data: { sessionId } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * POST /pet/memory
 * 手动保存一条消息（一般由 /pet/chat 自动保存，此接口备用）
 */
router.post('/memory', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { sessionId, role, content, metadata } = req.body || {};
    if (!sessionId || !role || !content) {
      return res.status(400).json({ code: 400, message: 'sessionId/role/content 必填' });
    }
    const id = await savePetMemory({
      user_id: userId,
      session_id: String(sessionId),
      role: String(role),
      content: String(content),
      metadata,
    });
    return res.json({ code: 200, data: { id, message: '保存成功' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * DELETE /pet/memory?sessionId=xxx
 * 清空指定会话
 */
router.delete('/memory', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) {
      return res.status(400).json({ code: 400, message: '缺少 sessionId' });
    }
    const deleted = await clearSession(userId, sessionId);
    return res.json({ code: 200, data: { deleted, message: '已清空会话' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * DELETE /pet/memory/all
 * 清空用户所有记忆（含摘要）
 */
router.delete('/memory/all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const result = await clearAllMemory(userId);
    return res.json({ code: 200, data: { ...result, message: '已清空所有记忆' } });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * GET /pet/memory/summary
 * 获取用户所有长期摘要
 */
router.get('/memory/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const summaries = await getAllPetMemorySummaries(userId);
    return res.json({ code: 200, data: summaries });
  } catch (err: any) {
    return res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * POST /pet/memory/generate-session-id
 * 生成新 session_id（桌面端「新对话」按钮调用）
 */
router.post('/memory/generate-session-id', authMiddleware, async (req: Request, res: Response) => {
  return res.json({ code: 200, data: { sessionId: generateSessionId() } });
});

export default router;
