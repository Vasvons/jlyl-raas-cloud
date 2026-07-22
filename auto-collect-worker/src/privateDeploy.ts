/**
 * 私有部署激活与心跳（v2.5.36 阶段六）
 *
 * 当环境变量 LICENSE_KEY 存在时启用：
 * 1. 启动时计算服务器指纹 → 调用 /worker/private-deploy/activate 激活
 * 2. 激活成功后每 60 秒上报心跳 → /worker/private-deploy/heartbeat
 * 3. 拉取任务时带上 agent_user_id（仅消费该代理的任务）
 *
 * 若 LICENSE_KEY 未设置，本模块为 no-op（不影响原有云端 worker 行为）
 */
import axios from 'axios';
import os from 'os';
import crypto from 'crypto';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const LICENSE_KEY = process.env.LICENSE_KEY || '';
const SERVER_NAME = process.env.SERVER_NAME || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '8', 10);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activatedAgentUserId: number | null = null;

/** 计算服务器指纹（基于 hostname + CPU + MAC 地址的哈希，一机一码） */
function computeServerFingerprint(): string {
  const hostname = os.hostname();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const cpuCount = String(cpus.length);
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface): iface is os.NetworkInterfaceInfo => !!iface && !iface.internal)
    .map((iface) => iface.mac)
    .filter((mac) => mac && mac !== '00:00:00:00:00:00')
    .sort()
    .join(',');
  const raw = `${hostname}|${cpuModel}|${cpuCount}|${macs}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** 是否已启用私有部署模式 */
export function isPrivateDeployMode(): boolean {
  return !!LICENSE_KEY;
}

/** 获取激活后的 agent_user_id（用于任务路由过滤） */
export function getAgentUserId(): number | null {
  return activatedAgentUserId;
}

/** 激活私有部署 */
export async function activatePrivateDeploy(): Promise<boolean> {
  if (!LICENSE_KEY) {
    return false;
  }

  const fingerprint = computeServerFingerprint();
  logger.info(`[PrivateDeploy] 正在激活私有部署...`);
  logger.info(`[PrivateDeploy]   LICENSE_KEY=${LICENSE_KEY}`);
  logger.info(`[PrivateDeploy]   SERVER_NAME=${SERVER_NAME || '未命名'}`);
  logger.info(`[PrivateDeploy]   指纹=${fingerprint.substring(0, 24)}...`);
  logger.info(`[PrivateDeploy]   MAX_CONCURRENCY=${MAX_CONCURRENCY}`);
  logger.info(`[PrivateDeploy]   CLOUD_API_URL=${SERVER_URL}`);

  try {
    const resp = await axios.post(
      `${SERVER_URL}/worker/private-deploy/activate`,
      {
        license_key: LICENSE_KEY,
        server_fingerprint: fingerprint,
        server_name: SERVER_NAME,
        max_concurrency: MAX_CONCURRENCY,
      },
      { timeout: 30000 }
    );

    if (resp.data?.code === 200 && resp.data?.data) {
      activatedAgentUserId = Number(resp.data.data.agent_user_id) || null;
      logger.info(`[PrivateDeploy] 激活成功！agent_user_id=${activatedAgentUserId}`);
      logger.info(`[PrivateDeploy]   到期时间: ${resp.data.data.expire_at || '永久'}`);
      return true;
    } else {
      logger.error(`[PrivateDeploy] 激活失败: ${resp.data?.message || '未知错误'}`);
      return false;
    }
  } catch (e: any) {
    logger.error(`[PrivateDeploy] 激活请求异常: ${e.message}`);
    return false;
  }
}

/** 启动心跳定时器（每 60 秒） */
export function startHeartbeat(): void {
  if (!LICENSE_KEY || heartbeatTimer) return;

  const fingerprint = computeServerFingerprint();

  const doHeartbeat = async () => {
    try {
      const mem = process.memoryUsage();
      const resp = await axios.post(
        `${SERVER_URL}/worker/private-deploy/heartbeat`,
        {
          license_key: LICENSE_KEY,
          server_fingerprint: fingerprint,
          cpu_percent: 0,
          memory_mb: Math.round(mem.rss / 1024 / 1024),
          current_tasks: 0,
        },
        { timeout: 10000 }
      );

      if (resp.data?.code !== 200) {
        logger.warn(`[PrivateDeploy] 心跳响应异常: ${resp.data?.message || '未知'}`);
      }
    } catch (e: any) {
      logger.warn(`[PrivateDeploy] 心跳上报失败: ${e.message}`);
    }
  };

  // 立即上报一次
  doHeartbeat();

  // 每 60 秒上报
  heartbeatTimer = setInterval(doHeartbeat, 60 * 1000);
  logger.info(`[PrivateDeploy] 心跳定时器已启动（每 60 秒上报）`);
}

/** 停止心跳定时器 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    logger.info(`[PrivateDeploy] 心跳定时器已停止`);
  }
}
