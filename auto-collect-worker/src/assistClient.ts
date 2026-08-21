import axios from 'axios';
import * as logger from './logger';

/**
 * 远程人工协助验证客户端（v3.22）
 *
 * Worker 侧与云端 /real-collect/assist 路由的通信封装：
 *   - reportAssist：上报会话状态 + 最新截图，响应告知桌面端观察者是否在线
 *   - pullAssistCommands：拉取桌面端发来的鼠标/键盘操作指令增量
 *   - persistStorageState：验证通过后导出 context cookie 回写账号池
 *     （复用 /platform-auth/renew/complete 通道，让 x5sec 凭证跨查询复用）
 */
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

export interface AssistCommand {
  seq: number;
  type: 'mouse_move' | 'mouse_down' | 'mouse_up' | 'click' | 'type';
  x?: number;
  y?: number;
  text?: string;
}

/**
 * 上报协助会话（无桌面端观察者时响应 observerOnline=false，调用方应放弃等待）
 */
export async function reportAssist(payload: {
  sessionId: string;
  platform: string;
  keyword: string;
  status: 'pending' | 'resolved' | 'timeout';
  screenshot?: string | null;
  shotWidth?: number;
  shotHeight?: number;
}): Promise<{ observerOnline: boolean } | null> {
  try {
    const resp = await axios.post(
      `${SERVER_URL}/real-collect/assist/report`,
      payload,
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
    const d = resp.data;
    if (d && d.code === 200 && d.data) return { observerOnline: !!d.data.observerOnline };
    return null;
  } catch (e: any) {
    logger.warn(`[远程协助] report 失败: ${e.message}`);
    return null;
  }
}

/** 拉取操作指令增量（since 之后的新指令；拉取即消费） */
export async function pullAssistCommands(
  sessionId: string,
  sinceSeq: number
): Promise<AssistCommand[]> {
  try {
    const resp = await axios.get(
      `${SERVER_URL}/real-collect/assist/${sessionId}/commands`,
      { params: { since: sinceSeq }, timeout: 5000 }
    );
    const d = resp.data;
    if (d && d.code === 200 && d.data && Array.isArray(d.data.commands)) {
      return d.data.commands as AssistCommand[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 验证通过后持久化登录态：把含 baxia x5sec cookie 的新 storageState 回写账号池。
 * 复用续期通道（success=true 分支会更新 storage_state 并重置续期失败计数）。
 */
export async function persistStorageState(authId: number, storageStateJson: string): Promise<boolean> {
  try {
    const resp = await axios.post(
      `${SERVER_URL}/platform-auth/renew/complete`,
      { id: authId, success: true, storageState: storageStateJson },
      { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
    );
    return resp.data && resp.data.code === 200;
  } catch (e: any) {
    logger.warn(`[远程协助] storageState 回写失败: ${e.message}`);
    return false;
  }
}
