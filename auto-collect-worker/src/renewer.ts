/**
 * 账号续期器：定期从云端获取需要续期的账号，用 storageState 访问平台刷新 cookie
 */
import { chromium } from 'playwright';
import axios from 'axios';
import { info, warn, error } from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const RENEWAL_CHECK_INTERVAL = 5 * 60 * 1000; // 每5分钟检查一次续期任务

// 平台 chatUrl 映射（用于续期访问）
const PLATFORM_CHAT_URLS: Record<string, string> = {
  'DeepSeek': 'https://chat.deepseek.com/',
  'Kimi': 'https://kimi.moonshot.cn/chat',
  '豆包': 'https://www.doubao.com/chat/',
  '通义千问': 'https://tongyi.aliyun.com/qianwen/',
  '腾讯元宝': 'https://yuanbao.tencent.com/chat/',
  '文心一言': 'https://yiyan.baidu.com/',
  '纳米': 'https://www.n.cn/chat',
  '智谱AI': 'https://chatglm.cn/chat/',
};

/**
 * 执行账号续期
 */
let isRenewing = false;

async function performRenewal(): Promise<void> {
  if (isRenewing) {
    return; // 上一次续期还在进行
  }
  isRenewing = true;
  try {
    // 1. 获取需要续期的账号列表
    const listResp = await axios.get(`${SERVER_URL}/platform-auth/renew/pending`, { timeout: 10000 });
    if (listResp.data?.code !== 200 || !listResp.data?.data?.length) {
      return; // 无需续期
    }

    const pendingAuths = listResp.data.data;
    info(`[Renewer] 发现 ${pendingAuths.length} 个账号需要续期`);

    // 2. 逐个续期
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      for (const auth of pendingAuths) {
        let success = false;
        try {
          // 获取账号 storageState
          const fetchResp = await axios.post(`${SERVER_URL}/platform-auth/renew/fetch`, {
            id: auth.id,
          }, { timeout: 10000 });

          if (fetchResp.data?.code !== 200 || !fetchResp.data?.data?.storageState) {
            warn(`[Renewer] 获取账号 ${auth.id} storageState 失败`);
            continue;
          }

          const { platform, storageState } = fetchResp.data.data;
          const chatUrl = PLATFORM_CHAT_URLS[platform];
          if (!chatUrl) {
            warn(`[Renewer] 未知平台 ${platform}，跳过`);
            continue;
          }

          // 用旧 storageState 创建 context，访问平台
          let parsedState: any;
          try {
            parsedState = JSON.parse(storageState);
          } catch {
            warn(`[Renewer] 账号 ${auth.id} storageState JSON 解析失败，跳过续期`);
            await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
              id: auth.id,
              success: false,
            }, { timeout: 10000 }).catch(() => {});
            continue;
          }

          const context = await browser.newContext({
            storageState: parsedState,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          });

          try {
            const page = await context.newPage();
            await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // 等待页面加载，让 cookie 刷新
            try {
              await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch {
              // networkidle 超时，额外等待2秒
              await page.waitForTimeout(2000);
            }

            // 导出新的 storageState
            const newStorageState = await context.storageState();
            const newStorageStateStr = JSON.stringify(newStorageState);

            // 计算新的过期时间（最早 cookie 的过期时间 + 7天，或默认30天后）
            let expiresAt: string | undefined;
            const validCookies = (newStorageState.cookies || []).filter((c: any) =>
              c.expires > 0 && c.expires > Date.now() / 1000
            );
            if (validCookies.length > 0) {
              const minExpires = Math.min(...validCookies.map((c: any) => c.expires));
              expiresAt = new Date(minExpires * 1000).toISOString();
            } else {
              expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            }

            // 上报续期成功
            await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
              id: auth.id,
              success: true,
              storageState: newStorageStateStr,
              expiresAt,
            }, { timeout: 10000 });

            success = true;
            info(`[Renewer] 账号 ${auth.id} (${platform}) 续期成功`);
          } finally {
            await context.close();
          }
        } catch (e: any) {
          // 上报续期失败
          await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
            id: auth.id,
            success: false,
          }, { timeout: 10000 }).catch(() => {});
          error(`[Renewer] 账号 ${auth.id} 续期失败: ${e.message}`);
          success = false;
        }

        // 续期间隔：成功10秒反爬，失败2秒快速跳过
        await new Promise(resolve => setTimeout(resolve, success ? 10000 : 2000));
      }
    } finally {
      await browser.close();
    }
  } catch (e: any) {
    error(`[Renewer] 续期检查失败: ${e.message}`);
  } finally {
    isRenewing = false;
  }
}

/**
 * 启动续期检查定时器
 */
let renewerTimer: ReturnType<typeof setInterval> | null = null;
let renewerStartupTimeout: ReturnType<typeof setTimeout> | null = null;

export function startRenewer(): void {
  info('[Renewer] 账号续期器已启动(每5分钟检查一次)');
  renewerTimer = setInterval(() => {
    performRenewal().catch(e => {
      error(`[Renewer] 续期异常: ${e.message}`);
    });
  }, RENEWAL_CHECK_INTERVAL);

  // 启动后 30 秒执行一次
  renewerStartupTimeout = setTimeout(() => {
    performRenewal().catch(() => {});
    renewerStartupTimeout = null;
  }, 30000);
}

export function stopRenewer(): void {
  if (renewerTimer) {
    clearInterval(renewerTimer);
    renewerTimer = null;
  }
  if (renewerStartupTimeout) {
    clearTimeout(renewerStartupTimeout);
    renewerStartupTimeout = null;
  }
}
