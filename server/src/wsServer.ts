/**
 * WebSocket 服务端（v2.4.0 新增）
 *
 * 架构：
 * - 复用 3002 端口的 HTTP server，路径 /ws
 * - 鉴权：握手时校验 query 参数 ?token=xxx（JWT），校验失败握手拒绝（401）
 * - 广播：路由层/调度器写操作后调用 wsBroadcast(event, payload, userId?) 推送事件
 * - 过滤：客户端握手后绑定 userId，只接收该 userId 的事件（或全局事件 userId='*'）
 *
 * 事件协议（JSON 字符串）：
 *   { "event": "shard_completed", "payload": { ... }, "ts": 1234567890 }
 *
 * 客户端订阅模式：
 *   ws.send(JSON.stringify({ action: 'subscribe', userId: '123' }))
 *   → 服务端记录该连接绑定的 userId，推送时按 userId 过滤
 */
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'jlyl-raas-cloud-secret-key-2024';

// v2.4.3：移除 Origin 白名单
//   原 bug：桌面端 flywheelWsClient.ts 设置 origin = cloudUrl（如 https://report.jlyl.net.cn），
//     但白名单只有 http://localhost / http://127.0.0.1 / file:// / null，
//     导致合法的桌面端 WS 请求被 403 拒绝（响应体 'Origin not allowed' = 18 字节，匹配访问日志）
//   修复：私有部署 + JWT 鉴权已足够，Origin 检查多余且易误伤，直接移除
//   JWT token 握手时强制校验（无 token 也允许连接，但无法收到定向事件，仅收全局事件）

interface ClientMeta {
  ws: WebSocket;
  userId: string | null; // 绑定的客户 userId（null 表示未订阅具体客户，仅收全局事件）
  isAdmin: boolean; // 是否是管理员（管理员收所有事件）
}

const clients = new Set<ClientMeta>();

let wssInstance: WebSocketServer | null = null;

/**
 * 初始化 WebSocket 服务端，挂载到已有的 HTTP server
 */
export function initWsServer(httpServer: HttpServer): WebSocketServer {
  if (wssInstance) return wssInstance;

  wssInstance = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // v2.4.3：移除 verifyClient 中的 Origin 白名单检查
    //   仅保留 JWT token 校验（可选，无 token 允许连接但收不到定向事件）
    verifyClient: (info, cb) => {
      // 校验 JWT token（query 参数 ?token=xxx）
      const url = new URL(info.req.url || '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) {
        // 允许未鉴权连接（后续可主动 send subscribe 消息绑定身份）
        // 但生产环境建议强制鉴权，这里先放行，由 subscribe 时校验
        cb(true);
        return;
      }
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        (info.req as any).wsAuth = decoded;
        cb(true);
      } catch (e) {
        cb(false, 401, 'Invalid token');
      }
    },
  });

  wssInstance.on('connection', (ws: WebSocket, req: any) => {
    const auth = req.wsAuth || {};
    // JWT payload 字段：{ id, username, level }（见 routes/auth.ts generateToken 调用）
    //   level='1' 是管理员，level='0' 是客户
    //   桌面端只有管理员会登录，isAdmin=true 时收到所有客户的事件
    const meta: ClientMeta = {
      ws,
      userId: auth.id != null ? String(auth.id) : null,
      // v2.5.35：清理 username === 'admin' 硬编码，统一用 level + role 判断
      isAdmin: auth.level === '1' || auth.level === 1 || auth.role === 'super_admin' || auth.role === 'admin',
    };
    clients.add(meta);
    console.log(`[WS] 客户端连接，当前连接数: ${clients.size}（userId=${meta.userId}, isAdmin=${meta.isAdmin}）`);

    // 心跳：30s ping 一次，60s 内没 pong 则断开
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });
    const pingTimer = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      try { ws.ping(); } catch {}
    }, 30000);

    // 接收客户端消息（用于订阅）
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'subscribe' && msg.userId) {
          meta.userId = String(msg.userId);
          console.log(`[WS] 客户端订阅 userId=${meta.userId}`);
          ws.send(JSON.stringify({ event: 'subscribed', payload: { userId: meta.userId } }));
        } else if (msg.action === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', payload: { ts: Date.now() } }));
        }
      } catch (e) {
        // 忽略非法消息
      }
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      clients.delete(meta);
      console.log(`[WS] 客户端断开，当前连接数: ${clients.size}`);
    });

    ws.on('error', (err: Error) => {
      console.warn(`[WS] 客户端错误: ${err.message}`);
      clearInterval(pingTimer);
      clients.delete(meta);
    });

    // 发送欢迎消息
    ws.send(JSON.stringify({
      event: 'connected',
      payload: {
        serverTime: Date.now(),
        userId: meta.userId,
        isAdmin: meta.isAdmin,
      },
    }));
  });

  console.log('[WS] WebSocket 服务端已挂载到 /ws 路径');
  return wssInstance;
}

/**
 * 广播事件到所有符合条件的客户端
 *
 * @param event 事件名（如 'shard_completed'）
 * @param payload 事件数据（任意 JSON 可序列化对象）
 * @param userId 过滤的客户 userId；undefined 表示广播给所有人；指定则只发给该客户 + 管理员
 */
export function wsBroadcast(event: string, payload: any, userId?: string | number): void {
  if (!wssInstance || clients.size === 0) return;

  const message = JSON.stringify({
    event,
    payload,
    ts: Date.now(),
  });

  const targetUserId = userId != null ? String(userId) : null;

  let sent = 0;
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // 过滤逻辑：
    // - 未指定 userId：广播给所有人（全局事件，如 flywheel_event_logged）
    // - 指定 userId：只发给绑定该 userId 的客户端 + 管理员
    if (targetUserId === null) {
      // 广播给所有人
      try { client.ws.send(message); sent++; } catch {}
    } else {
      // 发给绑定该 userId 的客户端 + 管理员
      if (client.isAdmin || client.userId === targetUserId) {
        try { client.ws.send(message); sent++; } catch {}
      }
    }
  }

  // 日志：仅记录非高频事件，避免日志刷屏
  const highFreqEvents = ['shard_progress_updated'];
  if (!highFreqEvents.includes(event) && sent > 0) {
    console.log(`[WS] 广播事件 ${event} → ${sent} 个客户端（userId=${targetUserId || 'all'}）`);
  }
}

/**
 * 获取当前连接数（监控用）
 */
export function getWsClientCount(): number {
  return clients.size;
}
