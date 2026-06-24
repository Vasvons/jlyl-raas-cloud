/**
 * 动态扩缩容：每分钟从云端获取推荐的并发数，动态调整 worker 并发度
 * 智能调度：根据队列压力、错误率、账号池余量综合调整
 */
import axios from 'axios';
import { info } from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const parsedConcurrency = parseInt(process.env.MAX_CONCURRENCY || '4');
const DEFAULT_CONCURRENCY = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 4;

/** 并发硬上限（与 docker-compose mem_limit 配套，2g 内存下安全值） */
const HARD_LIMIT = 4;

let currentConcurrency = DEFAULT_CONCURRENCY;
let lastAdjustTime = 0;

// 错误率统计（用于智能降并发）
let recentSuccess = 0;
let recentFailure = 0;
let lastErrorRateCheck = Date.now();

/**
 * 记录查询结果，用于错误率统计
 */
export function recordQueryResult(success: boolean): void {
  if (success) {
    recentSuccess++;
  } else {
    recentFailure++;
  }
}

/**
 * 计算错误率并决定是否降并发
 */
function getErrorRateAdjustedConcurrency(base: number): number {
  const total = recentSuccess + recentFailure;
  if (total < 10) return base; // 样本不足，不调整

  const errorRate = recentFailure / total;
  // 每 2 分钟重置一次统计
  if (Date.now() - lastErrorRateCheck > 120000) {
    recentSuccess = 0;
    recentFailure = 0;
    lastErrorRateCheck = Date.now();
    return base;
  }

  if (errorRate > 0.8) {
    // 错误率 > 80%，严重故障，降到 1
    return 1;
  } else if (errorRate > 0.5) {
    // 错误率 > 50%，降一半
    return Math.max(1, Math.floor(base / 2));
  } else if (errorRate > 0.3) {
    // 错误率 > 30%，降 1
    return Math.max(1, base - 1);
  }
  return base;
}

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
 * 智能调度：云端推荐值 × 错误率调整 × 硬上限
 */
export async function getCurrentConcurrency(): Promise<number> {
  const now = Date.now();
  if (now - lastAdjustTime > 60000) {
    let recommended = await fetchRecommendedConcurrency();
    // 硬上限钳制
    recommended = Math.min(recommended, HARD_LIMIT);
    // 错误率调整
    recommended = getErrorRateAdjustedConcurrency(recommended);
    // 最小 1，最大 HARD_LIMIT
    recommended = Math.max(1, Math.min(recommended, HARD_LIMIT));

    if (recommended !== currentConcurrency) {
      info(`智能调度: 并发数 ${currentConcurrency} → ${recommended} (错误率统计: 成功${recentSuccess}/失败${recentFailure})`);
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
