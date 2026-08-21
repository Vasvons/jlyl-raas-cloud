import { Router } from 'express';
import { authMiddleware } from '../auth';
import { query } from '../db';

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
  /**
   * v3.22.4: 会话归属用户（platform_auth.user_id，Worker 上报 authId 时查库关联）。
   * 弹窗用户隔离：普通用户只能看到/操作自己账号触发的验证会话；
   * 管理员（level=1）可协助任意用户的会话。null=无归属（兜底，仅管理员可见）。
   */
  userId: number | null;
  /**
   * v3.22.2: Worker 重放轨迹后的判定结果。
   * failed=重放完成但 baxia 弹层仍在（本次拖动未通过，等待用户重试）；
   * 桌面端据此显示"请重试"提示/挂起通知。重放通过时由 status=resolved 表达。
   */
  replayResult: 'failed' | null;
  /** 最近一次 replayResult 更新时间（桌面端按此去重提示） */
  replayAt: number;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, AssistSession>();
const MAX_SESSIONS = 50;
/** v3.22.4: 每个用户最近一次轮询 pending 的时间戳（观察者在线判定按用户隔离） */
const observerLastSeenMap = new Map<number, number>();
/** v3.22.4: 管理员（level=1）最近一次轮询时间——管理员可协助任意用户的会话 */
let adminLastSeen = 0;
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
  // 观察者心跳 Map 兜底限量（防长期运行膨胀）
  if (observerLastSeenMap.size > 200) {
    const entries = Array.from(observerLastSeenMap.entries()).sort((a, b) => a[1] - b[1]);
    for (const [uid] of entries.slice(0, observerLastSeenMap.size - 200)) observerLastSeenMap.delete(uid);
  }
}

/** v3.22.4: 当前请求用户是否可访问该会话（管理员可协助任意会话；普通用户仅自己的） */
function canAccessSession(s: AssistSession, req: any): boolean {
  if (req?.user?.level === '1') return true;
  const uid = Number(req?.user?.id);
  return s.userId != null && Number.isFinite(uid) && s.userId === uid;
}

/** v3.22.4: 会话归属用户的观察者是否在线（本人在线 或 任一管理员在线） */
function isObserverOnline(s: AssistSession, now: number): boolean {
  if (now - adminLastSeen < OBSERVER_OFFLINE_MS) return true;
  if (s.userId != null) {
    return now - (observerLastSeenMap.get(s.userId) || 0) < OBSERVER_OFFLINE_MS;
  }
  // 无归属会话（兜底）：任一用户在线即可
  for (const t of observerLastSeenMap.values()) {
    if (now - t < OBSERVER_OFFLINE_MS) return true;
  }
  return false;
}

/** v3.22.4: 根据账号 ID 查归属用户（platform_auth.user_id），失败返回 null */
async function lookupUserIdByAuthId(authId: number): Promise<number | null> {
  try {
    const r = await query('SELECT user_id FROM platform_auth WHERE id = $1', [authId]);
    const uid = (r as any)?.rows?.[0]?.user_id;
    return uid != null ? Number(uid) : null;
  } catch {
    return null;
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
    const { sessionId, platform, keyword, status, screenshot, shotWidth, shotHeight, authId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ code: 400, message: '缺少sessionId' });
    }
    const now = Date.now();
    let s = sessions.get(sessionId);
    if (!s) {
      if (status !== 'pending') {
        return res.json({ code: 200, data: { observerOnline: false } });
      }
      // v3.22.4: 按 Worker 借用的账号 ID 关联归属用户（弹窗用户隔离的依据）
      const userId = (typeof authId === 'number' && Number.isFinite(authId))
        ? await lookupUserIdByAuthId(authId)
        : null;
      s = {
        sessionId, platform: platform || '', keyword: keyword || '',
        status: 'pending', screenshot: null, shotWidth: shotWidth || 1440, shotHeight: shotHeight || 900,
        commands: [], commandSeq: 0, userId, replayResult: null, replayAt: 0, createdAt: now, updatedAt: now,
      };
      sessions.set(sessionId, s);
      console.log(`[RemoteAssist] 新会话 ${sessionId} platform=${platform} userId=${userId} keyword=${String(keyword || '').slice(0, 20)}`);
    }
    if (screenshot && typeof screenshot === 'string' && screenshot.length > 100) {
      s.screenshot = screenshot;
      s.shotWidth = shotWidth || s.shotWidth;
      s.shotHeight = shotHeight || s.shotHeight;
    }
    // v3.22.2: Worker 上报"轨迹重放完成但弹层仍在"→ 通知桌面端提示重试
    if (req.body?.replayResult === 'failed' && s.status === 'pending') {
      s.replayResult = 'failed';
      s.replayAt = now;
    }
    if (status === 'resolved' || status === 'timeout') {
      s.status = status;
      s.replayResult = null;
      console.log(`[RemoteAssist] 会话 ${sessionId} → ${status}`);
    }
    s.updatedAt = now;
    // v3.22.4: 观察者在线按会话归属用户判定（本人或任一管理员）
    const observerOnline = isObserverOnline(s, now);
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
    const now = Date.now();
    const uid = Number((req as any).user?.id);
    const isAdmin = (req as any).user?.level === '1';
    // v3.22.4: 观察者心跳按用户隔离（管理员心跳单独记录，可协助任意会话）
    if (isAdmin) adminLastSeen = now;
    if (Number.isFinite(uid)) observerLastSeenMap.set(uid, now);
    cleanExpiredSessions();
    // v3.22.4: 会话按归属用户过滤——普通用户只见自己的，管理员见全部
    const visible = Array.from(sessions.values()).filter(s => canAccessSession(s, req));
    // 返回最近一个 pending 会话（同一时刻通常只有一个平台触发风控）
    const pending = visible
      .filter(s => s.status === 'pending' && s.screenshot)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    // 附带最近 30 秒内结束的会话（让弹窗能显示"验证成功"的收尾状态）
    const recentDone = visible
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
    // v3.22.4: 归属校验——他人会话与"不存在"同语义（404），不暴露存在性
    if (!s || !s.screenshot || !canAccessSession(s, req)) return res.json({ code: 404, message: '会话不存在或无截图' });
    res.json({
      code: 200,
      data: {
        image: s.screenshot,
        width: s.shotWidth,
        height: s.shotHeight,
        status: s.status,
        /** v3.22.2: 最近一次轨迹重放的判定（failed=未通过需重试），replayAt 供桌面端去重 */
        replayResult: s.replayResult,
        replayAt: s.replayAt,
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
    // v3.22.4: 归属校验（同 screenshot，404 不暴露存在性）
    if (!s || !canAccessSession(s, req)) return res.json({ code: 404, message: '会话不存在' });
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

/**
 * v3.22.1: 批量轨迹指令（完整拖动手势一次性入队）
 *
 * 单条转发的问题：拖动过程被 600ms 轮询切成碎片，Worker 端每次只执行零星几个
 * move，鼠标按下-移动-抬起的手势时序被打散，baxia 滑块对碎片化事件流不响应。
 * 改为桌面端本地收集完整轨迹（按下→移动序列→抬起），松手时一次性批量发送，
 * Worker 端按相邻 ts 差值连续重放，复刻真人的完整手势速度特征。
 */
router.post('/:sessionId/command/batch', authMiddleware, async (req, res) => {
  try {
    const s = sessions.get(String(req.params.sessionId));
    // v3.22.4: 归属校验（同 screenshot，404 不暴露存在性）
    if (!s || !canAccessSession(s, req)) return res.json({ code: 404, message: '会话不存在' });
    if (s.status !== 'pending') return res.json({ code: 400, message: `会话已结束(${s.status})` });
    const commands: Array<{ type: string; x?: number; y?: number; text?: string; ts?: number }> = req.body?.commands;
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > 300) {
      return res.status(400).json({ code: 400, message: 'commands 必须为 1-300 条的数组' });
    }
    const validTypes = ['mouse_move', 'mouse_down', 'mouse_up', 'click', 'type'];
    const now = Date.now();
    let first = -1;
    for (const c of commands) {
      if (!c || !validTypes.includes(c.type)) continue;
      s.commandSeq += 1;
      if (first < 0) first = s.commandSeq;
      // ts 为桌面端采集时刻（毫秒时间戳），供 Worker 按真实时间间隔重放
      s.commands.push({ seq: s.commandSeq, type: c.type as AssistCommand['type'], x: c.x, y: c.y, text: c.text, ts: c.ts || now });
    }
    if (s.commands.length > 500) s.commands.splice(0, s.commands.length - 500);
    s.updatedAt = Date.now();
    res.json({ code: 200, data: { count: commands.length, firstSeq: first } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
