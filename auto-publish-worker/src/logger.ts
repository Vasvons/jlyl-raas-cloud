/**
 * 云端发布 Worker 日志器（简化版）
 *
 * 与 auto-collect-worker 的 logger 差异：
 *  - 不批量上报到云端（发布日志直接通过 publish/records/:id/result 的 error_msg 回传）
 *  - 仅控制台输出，便于 docker logs 查看
 */

let currentRecordId: number | undefined = undefined;

export function setRecordId(recordId: number | undefined): void {
  currentRecordId = recordId;
}

export function info(message: string): void {
  console.log(`[PublishWorker] ${formatMsg(message)}`);
}

export function warn(message: string): void {
  console.warn(`[PublishWorker] ⚠ ${formatMsg(message)}`);
}

export function error(message: string): void {
  console.error(`[PublishWorker] ✗ ${formatMsg(message)}`);
}

function formatMsg(message: string): string {
  return currentRecordId ? `[record ${currentRecordId}] ${message}` : message;
}

/** 进程退出前刷新（兼容接口，此实现无需刷新） */
export async function flushLogs(): Promise<void> {
  // 无操作
}
