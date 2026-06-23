/**
 * 动态扩缩容：每分钟从云端获取推荐的并发数，动态调整 worker 并发度
 */
import axios from 'axios';
import { info } from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const parsedConcurrency = parseInt(process.env.MAX_CONCURRENCY || '8');
const DEFAULT_CONCURRENCY = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 8;

let currentConcurrency = DEFAULT_CONCURRENCY;
let lastAdjustTime = 0;

/**
 * 从云端获取推荐的并发数
 */
export async function fetchRecommendedConcurrency(): Promise<number> {
  try {
    const resp = await axios.get(`${SERVER_URL}/real-collect/logs/queue-pressure`, { timeout: 5000 });
    if (resp.data?.code === 200 && resp.data?.data?.recommendedConcurrency) {
      return resp.data.data.recommendedConcurrency;
    }
  } catch {
    // 获取失败，保持当前值
  }
  return currentConcurrency;
}

/**
 * 获取当前并发数（每分钟最多调整一次）
 */
export async function getCurrentConcurrency(): Promise<number> {
  const now = Date.now();
  if (now - lastAdjustTime > 60000) {
    const recommended = await fetchRecommendedConcurrency();
    if (recommended > 0 && recommended !== currentConcurrency) {
      info(`动态调整并发数: ${currentConcurrency} → ${recommended}`);
      currentConcurrency = recommended;
    }
    // 无论是否变化，fetch 成功后更新 lastAdjustTime
    lastAdjustTime = now;
  }
  return currentConcurrency;
}

/**
 * 同步获取当前并发数（用于已缓存的场景）
 */
export function getCachedConcurrency(): number {
  return currentConcurrency;
}
