/**
 * 账号续期器：定期从云端获取需要续期的账号，用 storageState 访问平台刷新 cookie
 */
import { chromium } from 'playwright';
import axios from 'axios';
import { info, warn, error } from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const RENEWAL_CHECK_INTERVAL = 5 * 60 * 1000; // 每5分钟检查一次续期任务

// 平台 chatUrl 映射（用于续期访问）
// 参考 auth helper 软件的脚本：DeepSeek 和文心一言使用根域名而非 /chat 路径
// DeepSeek: 导航到 /chat 会自动恢复旧对话，根域名不会
// 文心一言: 导航到 /chat 会被重定向回首页，根域名直接显示聊天界面
const PLATFORM_CHAT_URLS: Record<string, string> = {
  'DeepSeek': 'https://chat.deepseek.com/',
  'Kimi': 'https://www.kimi.com/chat',
  '豆包': 'https://www.doubao.com/chat/',
  '通义千问': 'https://www.qianwen.com/chat',
  '腾讯元宝': 'https://yuanbao.tencent.com/chat/',
  '文心一言': 'https://yiyan.baidu.com/',
  '纳米': 'https://www.n.cn/chat',
  '智谱AI': 'https://chatglm.cn/chat/',
};

/**
 * 执行账号续期
 * 单次续期失败不标记 expired（云端会累加失败计数，连续3次才标记）
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
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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
            // 续期访问：带重试，单次失败不标记 expired
            let pageLoaded = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                pageLoaded = true;
                break;
              } catch (navErr: any) {
                warn(`[Renewer] 账号 ${auth.id} (${platform}) 导航失败(尝试${attempt}/2): ${navErr.message}`);
                if (attempt < 2) await page.waitForTimeout(3000);
              }
            }

            if (!pageLoaded) {
              // 两次导航都失败，上报续期失败（云端会累加计数，不立即标记 expired）
              await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
                id: auth.id,
                success: false,
              }, { timeout: 10000 }).catch(() => {});
              error(`[Renewer] 账号 ${auth.id} (${platform}) 两次导航均失败，上报续期失败`);
              continue;
            }

            // 等待页面加载，让 cookie 刷新
            try {
              await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch {
              // networkidle 超时，额外等待2秒
              await page.waitForTimeout(2000);
            }

            // 重定向检测：如果访问 /chat 后被重定向到首页，说明登录态已失效
            // 此时不应上报续期成功，否则会掩盖账号失效问题
            const postNavUrl = page.url();

            // 1. 登录页检测：如果 URL 包含 sign_in 或 login，说明被重定向到登录页
            if (postNavUrl.includes('sign_in') || postNavUrl.includes('login')) {
              await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
                id: auth.id,
                success: false,
              }, { timeout: 10000 }).catch(() => {});
              warn(`[Renewer] 账号 ${auth.id} (${platform}) 登录态失效: 被重定向到登录页 (实际=${postNavUrl})`);
              continue;
            }

            // 2. 路径重定向检测：如果 chatUrl 有特定路径但实际 URL 路径不匹配，说明被重定向
            try {
              const chatUrlObj = new URL(chatUrl);
              const chatPath = chatUrlObj.pathname;
              if (chatPath && chatPath !== '/') {
                const currentUrlObj = new URL(postNavUrl);
                if (!currentUrlObj.pathname.startsWith(chatPath)) {
                  // 被重定向了，登录态已失效
                  await axios.post(`${SERVER_URL}/platform-auth/renew/complete`, {
                    id: auth.id,
                    success: false,
                  }, { timeout: 10000 }).catch(() => {});
                  warn(`[Renewer] 账号 ${auth.id} (${platform}) 登录态失效: 被重定向到首页 (期望=${chatUrl}, 实际=${postNavUrl})`);
                  continue;
                }
              }
            } catch {
              // URL 解析失败，继续
            }

            // 导出新的 storageState
            const newStorageState = await context.storageState();
            const newStorageStateStr = JSON.stringify(newStorageState);

            // 计算新的过期时间
            // 取最晚过期的 cookie（只要有一个长期 cookie 有效，登录态就有效）
            // 之前取最早 cookie 导致百度系短期统计 cookie 把过期时间拉到几小时，显示"已过期"
            let expiresAt: string | undefined;
            const validCookies = (newStorageState.cookies || []).filter((c: any) =>
              c.expires > 0 && c.expires > Date.now() / 1000
            );
            if (validCookies.length > 0) {
              const maxExpires = Math.max(...validCookies.map((c: any) => c.expires));
              expiresAt = new Date(maxExpires * 1000).toISOString();
            } else {
              // 所有 cookie 都是 session 类型（无 expires），默认30天后过期
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
          // 上报续期失败（云端会累加计数，不立即标记 expired）
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
