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
import { getPetModelConfigWithKey } from '../repository';
import { callModelStream, getPetSystemPrompt, getDefaultPetKnowledge } from '../services/pet/petChatService';

const router = Router();

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

/**
 * POST /pet/chat
 * 流式对话接口（SSE）
 *
 * Body:
 *   { messages: [{role, content}], systemPrompt?: string }
 *
 * Response: text/event-stream
 *   data: {"type":"text_delta","text":"..."}      // 增量文本
 *   data: {"type":"done","fullText":"..."}        // 完成
 *   data: {"type":"error","message":"..."}        // 错误
 */
router.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ code: 401, message: '未授权' });
  }

  const { messages, systemPrompt } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ code: 400, message: '缺少 messages' });
  }

  // 1. 获取精灵底座模型配置（含解密 API Key）
  const modelConfig = await getPetModelConfigWithKey(userId);
  if (!modelConfig) {
    // v3.2.1：返回 4xx 状态码，让桌面端 cloudPetClient 能通过 response.ok 识别错误
    return res.status(400).json({
      code: 4003,
      message: '尚未配置精灵底座模型，请联系管理端在「设置 → 精灵底座配置」中开启',
    });
  }

  // 2. 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx 不缓冲
  res.flushHeaders?.();

  // 3. 客户端断开时清理
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  // 4. 构造系统提示词（自定义优先，否则用默认 + 软件知识）
  const finalSystemPrompt = systemPrompt || getPetSystemPrompt();

  // 5. 调模型流式接口
  try {
    const result = await callModelStream({
      modelConfig,
      messages,
      systemPrompt: finalSystemPrompt,
      onDelta: (text) => {
        if (aborted) return;
        res.write(`data: ${JSON.stringify({ type: 'text_delta', text })}\n\n`);
      },
    });

    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: 'done', fullText: result.fullText })}\n\n`);
      res.end();
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

export default router;
