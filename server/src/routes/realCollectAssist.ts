import { Router } from 'express';
import { authMiddleware } from '../auth';

/**
 * 远程人工协助验证（v3.22：baxia 人机验证远程拖滑块）
 *
 * 背景：云端巡检 Worker（headless）在服务器 IP 上反复触发阿里 baxia 人机验证弹层，
 * 回答被全屏遮挡无法生成。baxia 验证凭证（x5sec cookie）绑定 IP + 指纹，
 * 用户在本地浏览器验证救不了服务器环境——必须让验证发生在 Worker 自己的会话里。
 *
 * 架构（三方协作，全内存存储，会话生命周期分钟级）：
 *   1. Worker：detectPageRisk 检测到 baxia → POST /report 上报会话+截图
 *      → 响应告知是否有桌面端观察者在线；无观察者直接放弃（不拖慢巡检）
 *   2. 桌面端：GET /pending 轮询（2s，兼做观察者心跳）→ 弹窗显示 Worker 页面截图
 *      → 用户在截图上拖动滑块 → 鼠标事件换算坐标 POST /command
 *   3. Worker：GET /commands 拉指令增量 → page.mouse 逐条执行（复刻人工拖动轨迹）
 *      → baxia 弹层消失 = 验证通过 → POST /report {status:'resolved'}
 *      → 导出 context.storageState 回写账号池（复用 /platform-auth/renew/complete）
 *
 * 配套要求：千问账号使用固定指纹（getStableFingerprint），否则下次 newContext
 * 指纹变化，x5sec 失效又要重新验证。
 */
const router = Router();

export interface AssistCommand {
  seq: number;
  type: 'mouse_move' | 'mouse_down' | 'mouse_up' | 'click' | 'type';
  x?: number;
  y?: number;
  text?: string;
  ts: number;
}

interface AssistSession {
  sessionId: string;
  platform: string;
  keyword: string;
  /** pending=等待人工 | resolved=验证通过 | timeout=超时放弃 */
  status: 'pending' | 'resolved' | 'timeout';
  /** 最新截图 base64（JPEG，不含 data: 前缀） */
  screenshot: string | null;
  shotWidth: number;
  shotHeight: number;
  commands: AssistCommand[];
  commandSeq: number;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, AssistSession>();
const MAX_SESSIONS = 50;
/** 桌面端最近一次轮询 pending 的时间戳（观察者在线判定） */
let observerLastSeen = 0;
/** 观察者在线窗口：桌面端 2s 轮询一次，10s 未轮询视为离线 */
const OBSERVER_OFFLINE_MS = 10 * 1000;
/** 会话保留时长（resolved/timeout 后保留 5 分钟供桌面端展示结果） */
const SESSION_TTL_MS = 10 * 60 * 1000;

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  // 兜底限量
  if (sessions.size > MAX_SESSIONS) {
    const sorted = Array.from(sessions.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of sorted.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(s.sessionId);
  }
}

// ============ Worker 侧接口（无鉴权，Worker 内部调用，同 dequeue 模式）============

/**
 * Worker 上报协助会话（创建/更新状态/上传最新截图）
 * 响应 observerOnline：无桌面端观察者时 Worker 应放弃等待，快速走失败路径
 */
router.post('/report', async (req, res) => {
  try {
    cleanExpiredSessions();
    const { sessionId, platform, keyword, status, screenshot, shotWidth, shotHeight } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ code: 400, message: '缺少sessionId' });
    }
    const now = Date.now();
    let s = sessions.get(sessionId);
    if (!s) {
      if (status !== 'pending') {
        return res.json({ code: 200, data: { observerOnline: false } });
      }
      s = {
        sessionId, platform: platform || '', keyword: keyword || '',
        status: 'pending', screenshot: null, shotWidth: shotWidth || 1440, shotHeight: shotHeight || 900,
        commands: [], commandSeq: 0, createdAt: now, updatedAt: now,
      };
      sessions.set(sessionId, s);
      console.log(`[RemoteAssist] 新会话 ${sessionId} platform=${platform} keyword=${String(keyword || '').slice(0, 20)}`);
    }
    if (screenshot && typeof screenshot === 'string' && screenshot.length > 100) {
      s.screenshot = screenshot;
      s.shotWidth = shotWidth || s.shotWidth;
      s.shotHeight = shotHeight || s.shotHeight;
    }
    if (status === 'resolved' || status === 'timeout') {
      s.status = status;
      console.log(`[RemoteAssist] 会话 ${sessionId} → ${status}`);
    }
    s.updatedAt = now;
    const observerOnline = now - observerLastSeen < OBSERVER_OFFLINE_MS;
    res.json({ code: 200, data: { observerOnline } });
  } catch (e: any) {
    console.error('[RemoteAssist] report失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

/** Worker 拉取操作指令增量（since 之后的新指令） */
router.get('/:sessionId/commands', async (req, res) => {
  try {
    const s = sessions.get(String(req.params.sessionId));
    if (!s) return res.json({ code: 200, data: { commands: [] } });
    const since = Number(req.query.since) || 0;
    const commands = s.commands.filter(c => c.seq > since);
    // 指令拉取即消费点：清理已被拉取的旧指令，防内存膨胀
    if (commands.length > 0) {
      const maxSeq = commands[commands.length - 1].seq;
      s.commands = s.commands.filter(c => c.seq > maxSeq);
    }
    res.json({ code: 200, data: { commands, status: s.status } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// ============ 桌面端接口（登录鉴权）============

/** 桌面端轮询待验证会话（2s 一次，兼做观察者心跳） */
router.get('/pending', authMiddleware, async (req, res) => {
  try {
    observerLastSeen = Date.now();
    cleanExpiredSessions();
    // 返回最近一个 pending 会话（同一时刻通常只有一个平台触发风控）
    const pending = Array.from(sessions.values())
      .filter(s => s.status === 'pending' && s.screenshot)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    // 附带最近 30 秒内结束的会话（让弹窗能显示"验证成功"的收尾状态）
    const recentDone = Array.from(sessions.values())
      .filter(s => s.status !== 'pending' && Date.now() - s.updatedAt < 30 * 1000)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    res.json({
      code: 200,
      data: {
        pending: pending ? {
          sessionId: pending.sessionId, platform: pending.platform, keyword: pending.keyword,
          shotWidth: pending.shotWidth, shotHeight: pending.shotHeight,
        } : null,
        recentDone: recentDone ? { sessionId: recentDone.sessionId, platform: recentDone.platform, status: recentDone.status } : null,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/** 桌面端拉最新截图（弹窗内 1s 刷新） */
router.get('/:sessionId/screenshot', authMiddleware, async (req, res) => {
  try {
    const s = sessions.get(String(req.params.sessionId));
    if (!s || !s.screenshot) return res.json({ code: 404, message: '会话不存在或无截图' });
    res.json({
      code: 200,
      data: {
        image: s.screenshot,
        width: s.shotWidth,
        height: s.shotHeight,
        status: s.status,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

/** 桌面端发送鼠标/键盘操作指令（坐标为 Worker 页面 viewport 坐标，由桌面端换算） */
router.post('/:sessionId/command', authMiddleware, async (req, res) => {
  try {
    const s = sessions.get(String(req.params.sessionId));
    if (!s) return res.json({ code: 404, message: '会话不存在' });
    if (s.status !== 'pending') return res.json({ code: 400, message: `会话已结束(${s.status})` });
    const { type, x, y, text } = req.body || {};
    const validTypes = ['mouse_move', 'mouse_down', 'mouse_up', 'click', 'type'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ code: 400, message: `无效指令类型: ${type}` });
    }
    s.commandSeq += 1;
    s.commands.push({ seq: s.commandSeq, type, x, y, text, ts: Date.now() });
    // 指令队列兜底限量（拖动滑块会产生大量 mouse_move）
    if (s.commands.length > 500) s.commands.splice(0, s.commands.length - 500);
    s.updatedAt = Date.now();
    res.json({ code: 200, data: { seq: s.commandSeq } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
