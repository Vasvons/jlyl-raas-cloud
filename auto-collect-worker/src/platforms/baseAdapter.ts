import { Page } from 'playwright';
import { PlatformAdapter, PlatformCredentials, QueryResult, randomDelay } from './base';

/**
 * 通用平台适配器基类实现
 * 大部分 AI 平台的查询流程相似：打开聊天页 → 填入 textarea → 回车 → 等待 → 提取
 * 子类只需提供选择器配置即可
 */
export abstract class BasePlatformAdapter extends PlatformAdapter {
  abstract platformName: string;
  abstract loginUrl: string;
  abstract chatUrl: string;
  abstract supportsShare: boolean;

  // 子类可覆盖的选择器
  protected inputSelector: string = 'textarea';
  protected responseSelector: string = '';
  protected stopButtonSelector: string = '';
  protected loginUrlPattern: string = 'login'; // URL 中包含此字符串表示未登录

  async login(page: Page, credentials: PlatformCredentials): Promise<boolean> {
    // storageState 已含登录态，通常不需要自动登录
    return await this.checkLoginStatus(page);
  }

  async checkLoginStatus(page: Page): Promise<boolean> {
    try {
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000); // 等待重定向
      const currentUrl = page.url();
      // 如果被重定向到登录页，说明未登录
      return !currentUrl.includes(this.loginUrlPattern) && !currentUrl.includes('sign_in');
    } catch (e: any) {
      // 区分"页面崩溃/浏览器异常"和"真正登录失效"和"导航超时"
      // 页面崩溃时不要误判为登录态失效，抛出异常让上层作为查询失败处理
      // 否则会导致账号被错误标记为 failed，账号池被快速消耗
      if (page.isClosed()) {
        throw new Error(`checkLoginStatus 失败: 页面已关闭 (${e.message})`);
      }
      // Page crashed 等浏览器级异常也抛出，不当作登录失效
      const errMsg = String(e?.message || '');
      if (errMsg.includes('Page crashed') || errMsg.includes('Target closed') || errMsg.includes('Browser closed')) {
        throw new Error(`checkLoginStatus 失败: 浏览器异常 (${errMsg})`);
      }
      // 导航超时（net::ERR_TIMED_OUT、Timeout exceeded）也抛出，不当作登录失效
      // 因为超时可能是网络问题或页面加载慢，不代表登录态失效
      if (errMsg.includes('Timeout') || errMsg.includes('timeout') || errMsg.includes('ERR_TIMED_OUT') || errMsg.includes('ERR_INTERNET_DISCONNECTED')) {
        throw new Error(`checkLoginStatus 失败: 导航超时 (${errMsg})`);
      }
      // 其他异常（如 URL 确实包含 login）返回 false
      return false;
    }
  }

  /** 导航后特殊处理钩子（子类可重写，用于点击"开始对话"等入口按钮） */
  protected async afterNavigate(page: Page): Promise<void> {
    // 默认无操作
  }

  async query(page: Page, keyword: string): Promise<QueryResult> {
    // 导航到聊天页（新对话）
    // 使用 networkidle 等待 SPA 页面 JS 渲染完成（比 domcontentloaded 更可靠）
    try {
      await page.goto(this.chatUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // networkidle 超时（部分平台长连接不会 idle），降级为 domcontentloaded
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(3000); // 等待 SPA 渲染完成

    // ============ 登录状态检查 ============
    // 如果账号未登录/storageState 过期，页面会被重定向到登录页或营销首页
    // 此时不应继续等待输入框（必然超时），而是直接抛异常让上层标记账号 offline
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => '');

    // 检查1: URL 是否包含登录关键词（被重定向到登录页）
    const urlLower = currentUrl.toLowerCase();
    if (urlLower.includes('login') || urlLower.includes('sign_in') || urlLower.includes('signin')) {
      throw new Error(`登录态失效: 页面被重定向到登录页 (URL=${currentUrl})`);
    }

    // 检查1.5: 重定向检测——如果 chatUrl 包含特定路径（如 /chat）但导航后 URL 不包含该路径，
    // 说明未登录被重定向到营销首页（DeepSeek/文心一言/通义千问等都会这样）
    try {
      const chatUrlObj = new URL(this.chatUrl);
      const chatPath = chatUrlObj.pathname;
      if (chatPath && chatPath !== '/') {
        const currentUrlObj = new URL(currentUrl);
        // 如果当前 URL 路径不包含 chatUrl 的路径，说明被重定向了
        if (!currentUrlObj.pathname.startsWith(chatPath)) {
          throw new Error(`登录态失效: 页面被重定向到首页 (期望=${this.chatUrl}, 实际=${currentUrl}, title=${pageTitle})`);
        }
      }
    } catch (e: any) {
      // 如果是登录态失效异常，继续抛出
      if (e.message && e.message.includes('登录态失效')) throw e;
      // URL 解析失败，继续其他检查
    }

    // 检查2: 页面是否有明显的登录按钮（说明未登录，被重定向到营销/首页）
    // 注意：部分平台（如通义千问）的营销首页即使已登录也会显示"登录"按钮
    // 因此需要二次校验：如果页面同时存在用户头像/用户名等已登录标志，则不判定为登录失效
    const hasLoginButton = await page.evaluate(() => {
      const loginTexts = ['登录', '登 录', 'Sign in', 'Sign In', 'Log in', 'Log In', '登录/注册'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (loginTexts.some(lt => text === lt || text.includes(lt))) {
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (hasLoginButton) {
      // 二次校验：检查是否有已登录标志（用户头像、用户名、个人中心等）
      // 如果存在已登录标志，说明账号实际已登录，只是营销首页仍显示登录按钮
      const hasLoggedInIndicator = await page.evaluate(() => {
        // 已登录标志选择器：用户头像、用户名、个人中心、退出登录等
        const loggedInSelectors = [
          '[class*="avatar"]', '[class*="Avatar"]',
          '[class*="user-info"]', '[class*="userInfo"]', '[class*="user-menu"]', '[class*="userMenu"]',
          '[class*="nickname"]', '[class*="userName"]', '[class*="user-name"]',
          '[class*="account"]', '[class*="profile"]',
          'img[class*="avatar"]', 'img[class*="Avatar"]',
          // 退出登录按钮的存在也说明已登录
          'button:has-text("退出")', 'a:has-text("退出")', 'button:has-text("登出")', 'a:has-text("登出")',
        ];
        for (const sel of loggedInSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              // 排除隐藏元素
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true;
              }
            }
          } catch {
            // 继续
          }
        }
        // 检查 localStorage/sessionStorage 中的登录态 token
        try {
          const tokens = ['token', 'Token', 'access_token', 'accessToken', 'userToken', 'userInfo', 'user_info', 'loginState', 'isLogin'];
          for (const key of tokens) {
            if (localStorage.getItem(key) || sessionStorage.getItem(key)) {
              return true;
            }
          }
        } catch {
          // 继续
        }
        return false;
      }).catch(() => false);

      if (!hasLoggedInIndicator) {
        throw new Error(`登录态失效: 页面检测到登录按钮 (URL=${currentUrl}, title=${pageTitle})`);
      }
      // 已登录标志存在，继续执行（不抛异常）
    }

    // 导航后特殊处理钩子（子类可重写，用于点击"开始对话"等入口按钮）
    await this.afterNavigate(page);

    // 等待输入框出现（带重试机制）
    let activeSelector = this.inputSelector;
    let inputFound = false;

    // 第一轮：主选择器 + 回退选择器
    const fallbackSelectors = [
      this.inputSelector,
      'textarea',
      'div[contenteditable="true"]',
      '#chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      '[class*="input-area"] textarea',
      '[class*="input-area"] [contenteditable="true"]',
      '[role="textbox"]',
      '[class*="editor"]',
      '[class*="prompt"] textarea',
      '[class*="prompt"] [contenteditable="true"]',
      'form textarea',
      'form [contenteditable="true"]',
    ];

    for (const selector of fallbackSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
        activeSelector = selector;
        inputFound = true;
        if (selector !== this.inputSelector) {
          console.log(`[${this.platformName}] 主选择器超时，使用回退选择器: ${selector}`);
        }
        break;
      } catch {
        // 继续尝试下一个
      }
    }

    // 第二轮：如果还没找到，等待5秒后重试一次（部分 SPA 需要更长时间渲染）
    if (!inputFound) {
      console.log(`[${this.platformName}] 第一轮选择器全部超时，等待5秒后重试...`);
      await page.waitForTimeout(5000);
      for (const selector of fallbackSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
          activeSelector = selector;
          inputFound = true;
          console.log(`[${this.platformName}] 第二轮重试找到选择器: ${selector}`);
          break;
        } catch {
          // 继续
        }
      }
    }

    if (!inputFound) {
      // 输出页面 URL 和标题辅助排查
      const url = page.url();
      const title = await page.title().catch(() => '未知');
      throw new Error(`输入框未找到: 主选择器(${this.inputSelector})及所有回退选择器均超时 (URL=${url}, title=${title})`);
    }

    // 清空输入框并填入关键词
    // 部分平台 fill 失败（如 contenteditable），降级为 click + type
    try {
      await page.fill(activeSelector, '');
      await page.fill(activeSelector, keyword);
    } catch {
      console.log(`[${this.platformName}] fill 失败，降级为 click+type`);
      await page.click(activeSelector);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(keyword, { delay: 50 });
    }
    await randomDelay(500, 1500);

    // 提交
    await page.press(activeSelector, 'Enter');

    // 等待 AI 回答完成
    await this.waitForResponse(page);

    // 提取内容
    const { text, html } = await this.extractContent(page);
    const shareUrl = await this.extractShareLink(page);

    return {
      content: text,
      shareUrl,
      htmlContent: html,
      supportsShare: this.supportsShare,
    };
  }

  /**
   * 从分享对话框提取链接的通用实现（不依赖 clipboard）
   * 策略：点击分享按钮 → 等待对话框 → 多策略查找URL → 关闭对话框
   * 子类可覆盖 extractShareLink 实现具体逻辑，或直接调用此方法
   */
  protected async extractShareLinkFromDialog(
    page: Page,
    shareBtnSelector: string,
    dialogSelector: string
  ): Promise<string | null> {
    let dialogOpened = false;
    try {
      // 1. 查找并点击分享按钮
      const shareBtn = await page.$(shareBtnSelector);
      if (!shareBtn) return null;
      await shareBtn.click({ timeout: 3000 }).catch(() => {});

      // 2. 等待对话框出现（最多3秒）
      try {
        await page.waitForSelector(dialogSelector, { timeout: 3000, state: 'visible' });
        dialogOpened = true;
      } catch {
        return null;
      }

      // 3. 多策略查找分享URL
      let shareUrl: string | null = null;

      // 策略1: readonly input 或 share-link input 的值
      if (!shareUrl) {
        const linkInput = await page.$(
          `${dialogSelector} input[readonly], ${dialogSelector} input[class*="share"], ${dialogSelector} input[class*="link"], ${dialogSelector} input[class*="url"], ${dialogSelector} [class*="share-link"], ${dialogSelector} [class*="link-input"]`
        ).catch(() => null);
        if (linkInput) {
          const val = await linkInput.inputValue().catch(() => '');
          if (val && val.startsWith('http')) shareUrl = val;
          if (!shareUrl) {
            const text = await linkInput.textContent().catch(() => '');
            if (text && text.trim().startsWith('http')) shareUrl = text.trim();
          }
        }
      }

      // 策略2: 任意包含 http 值的 input
      if (!shareUrl) {
        const inputs = await page.$(`${dialogSelector} input`).catch(() => null);
        if (inputs) {
          const allInputs = await page.$$(`${dialogSelector} input`);
          for (const inp of allInputs) {
            const val = await inp.inputValue().catch(() => '');
            if (val && val.startsWith('http')) { shareUrl = val; break; }
          }
        }
      }

      // 策略3: 锚点 href 包含分享标识
      if (!shareUrl) {
        const link = await page.$(
          `${dialogSelector} a[href*="/share"], ${dialogSelector} a[href*="/c/"], ${dialogSelector} a[href*="conversation"], ${dialogSelector} a[href*="chat"]`
        ).catch(() => null);
        if (link) {
          const href = await link.getAttribute('href').catch(() => '');
          if (href) {
            if (href.startsWith('http')) shareUrl = href;
            else if (href.startsWith('/')) shareUrl = new URL(href, page.url()).href;
          }
        }
      }

      // 策略4: 对话框文本中匹配 URL
      if (!shareUrl) {
        const dialogText = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el?.textContent || '';
        }, dialogSelector).catch(() => '');
        const urlMatch = dialogText.match(/https?:\/\/[^\s<>"']+/);
        if (urlMatch) shareUrl = urlMatch[0];
      }

      return shareUrl;
    } catch {
      return null;
    } finally {
      // 关闭对话框（Escape 或点击遮罩/关闭按钮）
      if (dialogOpened) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
      }
    }
  }

  /**
   * 检查当前页面URL是否本身就是可分享的对话URL
   * 部分平台发送消息后URL会变为包含对话ID的链接，该链接即为分享链接
   *
   * 8个平台的对话/分享URL格式：
   * - DeepSeek:  https://chat.deepseek.com/c/{id}  或 /chat/{id}
   * - 豆包:      https://www.doubao.com/chat/{数字ID}（对话URL即分享URL）
   * - 通义千问:  私有对话URL不可直接分享，需点击分享按钮获取 share?shareId={UUID}（见 QianwenAdapter.extractShareLink）
   * - 文心一言:  https://yiyan.baidu.com/chat/{id} 或 /artifactShare/{短码}
   * - Kimi:      https://kimi.moonshot.cn/chats/{chatId} 或 /share/{shareId}
   * - 智谱清言:  https://chatglm.cn/share/{8位短码}
   * - 腾讯元宝:  https://yuanbao.tencent.com/chat/{id}
   * - 纳米:      https://www.n.cn/share/{type}?id={shareId}
   */
  protected async getCurrentPageShareUrl(page: Page): Promise<string | null> {
    try {
      const url = page.url();
      // 排除登录页/首页
      if (!url.startsWith('http') || url.includes('login') || url.includes('sign_in')) {
        return null;
      }

      // 各平台的对话/分享 URL 模式
      const conversationPatterns = [
        // DeepSeek: /c/{id} 或 /chat/{id}
        /\/c\/[a-zA-Z0-9_-]{8,}/,
        /\/chat\/[a-zA-Z0-9_-]{8,}/,
        // 豆包: /chat/{数字ID}（对话URL即分享URL）
        /\/chat\/\d{6,}/,
        // 通义千问: /qianwen/{id} 或 /share?shareId={UUID}
        /\/qianwen\/[a-zA-Z0-9_-]{8,}/,
        /[?&]shareId=[a-zA-Z0-9-]{8,}/,
        // 文心一言: /chat/{id} 或 /artifactShare/{短码}
        /\/artifactShare\/[a-zA-Z0-9_-]{4,}/,
        // Kimi: /chats/{chatId} 或 /share/{shareId}
        /\/chats\/[a-zA-Z0-9_-]{8,}/,
        /\/share\/[a-zA-Z0-9_-]{8,}/,
        // 智谱清言: /share/{8位短码}
        /\/share\/[a-zA-Z0-9_-]{4,}/,
        // 腾讯元宝: /chat/{id}
        // 已被上面的 /chat/{id} 覆盖
        // 纳米: /share/{type}?id={shareId}
        /\/share\/[a-zA-Z0-9_-]+\?id=[a-zA-Z0-9_-]{4,}/,
        // 通用查询参数模式
        /[?&](?:conversationId|sessionId|chatId)=[a-zA-Z0-9_-]{8,}/,
      ];

      for (const pattern of conversationPatterns) {
        if (pattern.test(url)) {
          return url;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 默认实现：尝试从当前页面URL获取（部分平台URL即分享链接）
    return this.getCurrentPageShareUrl(page);
  }

  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载，再滚动回顶部（确保所有内容渲染完成）
    await this.scrollToBottom(page);

    if (!this.responseSelector) {
      // 无选择器时，尝试获取页面上最后一段长文本
      // 优先查找常见的 AI 回答容器，避免获取到侧边栏/导航等无关内容
      const text = await page.evaluate(() => {
        // 1. 优先查找常见的 AI 回答容器
        const answerSelectors = [
          '[class*="answer"]', '[class*="response"]', '[class*="message"]',
          '[class*="chat-content"]', '[class*="chat-content"]',
          '[class*="bubble"]', '[class*="content"]', 'article', 'main'
        ];
        for (const sel of answerSelectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) {
            // 取最后一个（最新的回答）
            const lastEl = els[els.length - 1];
            const t = (lastEl.textContent || '').trim();
            if (t.length > 50) return t;
          }
        }
        // 2. 兜底：获取页面上最长的 div 文本
        const elements = Array.from(document.querySelectorAll('div, section, article'));
        let lastLongText = '';
        for (const el of elements) {
          const t = (el.textContent || '').trim();
          if (t.length > lastLongText.length) lastLongText = t;
        }
        return lastLongText;
      });
      return { text, html: `<div>${text}</div>` };
    }

    try {
      // 等待回答选择器出现
      await page.waitForSelector(this.responseSelector, { timeout: 30000 });
      // 再次滚动确保完整渲染
      await this.scrollToBottom(page);
      // 取最后一个匹配的元素（最新的回答）
      const elements = await page.$$(this.responseSelector);
      const lastEl = elements[elements.length - 1];
      if (lastEl) {
        const text = (await lastEl.textContent()) || '';
        const html = (await lastEl.innerHTML()) || '';
        return { text: text.trim(), html };
      }
    } catch (e) {
      console.error(`[${this.platformName}] 提取内容失败:`, (e as Error).message);
      // 兜底：尝试获取页面所有文本
      try {
        const text = await page.evaluate(() => document.body.textContent || '');
        if (text.trim().length > 0) {
          return { text: text.trim().substring(0, 10000), html: `<div>${text}</div>` };
        }
      } catch {}
    }
    return { text: '', html: '' };
  }

  /**
   * 滚动到页面底部，触发 SPA 懒加载，确保 AI 回答完整渲染
   */
  protected async scrollToBottom(page: Page): Promise<void> {
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 200;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= scrollHeight || totalHeight > 10000) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });
      // 滚动回顶部
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    } catch {
      // 滚动失败不影响主流程
    }
  }

  async waitForResponse(page: Page): Promise<void> {
    // 等待停止按钮出现后再消失（表示回答完成）
    if (this.stopButtonSelector) {
      try {
        // 先等待停止按钮出现（表示 AI 开始生成）
        await page.waitForSelector(this.stopButtonSelector, { timeout: 10000 });
        // 然后等待停止按钮消失（表示 AI 生成完成）
        await page.waitForSelector(this.stopButtonSelector, { state: 'detached', timeout: 120000 });
        // 额外等待 2 秒确保最终内容渲染完成
        await page.waitForTimeout(2000);
      } catch {
        // 停止按钮超时，再等待固定时间
        console.log(`[${this.platformName}] 停止按钮等待超时，额外等待10秒`);
        await page.waitForTimeout(10000);
      }
    } else {
      // 无停止按钮选择器时，等待更长时间（30秒）让 AI 完成生成
      // 然后滚动页面触发懒加载
      await page.waitForTimeout(30000);
    }
  }
}
