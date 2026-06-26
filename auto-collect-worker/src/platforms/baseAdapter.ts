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
    let currentUrl = page.url();
    let pageTitle = await page.title().catch(() => '');

    // 检查1: URL 是否包含登录关键词（被重定向到登录页）
    const urlLower = currentUrl.toLowerCase();
    if (urlLower.includes('login') || urlLower.includes('sign_in') || urlLower.includes('signin')) {
      throw new Error(`登录态失效: 页面被重定向到登录页 (URL=${currentUrl})`);
    }

    // 先执行 afterNavigate（让子类有机会点击"开始对话"等入口按钮进入 /chat 路径）
    // 注意：必须在检查1.5（重定向检测）之前执行，否则像文心一言这样登录后停在首页、
    // 需要点击"开始对话"按钮才能进入 /chat 路径的平台，会被检查1.5 误判为登录态失效
    await this.afterNavigate(page);

    // afterNavigate 后重新获取 URL 和标题（可能已经从首页跳转到 /chat）
    currentUrl = page.url();
    pageTitle = await page.title().catch(() => '');

    // 检查1.5: 重定向检测——非阻塞式警告
    // 如果 chatUrl 含特定路径（如 /chat）但导航后 URL 路径为根 / 或空，
    // 说明被重定向到营销首页。但不立即抛异常，而是记录警告并继续流程。
    // 原因：很多平台首页本身就含聊天输入框（如 DeepSeek），即使被重定向也能正常查询。
    // 如果账号真的未登录，后续"等待输入框"会失败，抛"输入框未找到"（属于"其他失败"，
    // 不标记 offline），账号继续可用，下次重试。
    // 这避免了"重定向到首页=登录态失效"的误判，同时不损失对真正未登录账号的容错。
    try {
      const chatUrlObj = new URL(this.chatUrl);
      const chatPath = chatUrlObj.pathname.replace(/\/+$/, ''); // 去掉末尾斜杠
      if (chatPath && chatPath !== '/') {
        const currentUrlObj = new URL(currentUrl);
        const currentPath = currentUrlObj.pathname.replace(/\/+$/, '');
        if (currentPath === '' || currentPath === '/') {
          // 记录警告但不抛异常，让流程继续到"等待输入框"
          console.log(`[${this.platformName}] 警告: 页面被重定向到首页 (期望=${this.chatUrl}, 实际=${currentUrl}, title=${pageTitle})，继续尝试查找输入框`);
        }
      }
    } catch {
      // URL 解析失败，继续其他检查
    }

    // 检查2: 页面是否有明显的登录按钮——非阻塞式警告
    // 仅在 URL 路径为根 /（疑似被重定向到首页）时才执行检测
    // 但不抛异常，改为记录警告并继续流程。原因：
    // 1. 很多平台首页即使已登录也显示"登录"按钮（如通义千问）
    // 2. 二次校验选择器可能不匹配某些平台的已登录标志，导致误判
    // 3. 如果账号真的未登录，后续"等待输入框"会失败，抛"输入框未找到"（不标记 offline）
    let currentPathForCheck2 = '';
    try {
      currentPathForCheck2 = new URL(currentUrl).pathname.replace(/\/+$/, '');
    } catch {}

    const isOnExpectedPage = currentPathForCheck2 !== '' && currentPathForCheck2 !== '/';

    if (!isOnExpectedPage) {
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
        // 二次校验：检查是否有已登录标志
        const hasLoggedInIndicator = await page.evaluate(() => {
          const loggedInSelectors = [
            '[class*="avatar"]', '[class*="Avatar"]',
            '[class*="user-info"]', '[class*="userInfo"]', '[class*="user-menu"]', '[class*="userMenu"]',
            '[class*="nickname"]', '[class*="userName"]', '[class*="user-name"]',
            '[class*="account"]', '[class*="profile"]',
            'img[class*="avatar"]', 'img[class*="Avatar"]',
            'button:has-text("退出")', 'a:has-text("退出")', 'button:has-text("登出")', 'a:has-text("登出")',
          ];
          for (const sel of loggedInSelectors) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return true;
                }
              }
            } catch {
              // 继续
            }
          }
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
          // 记录警告但不抛异常，让流程继续到"等待输入框"
          console.log(`[${this.platformName}] 警告: 页面检测到登录按钮但未找到已登录标志 (URL=${currentUrl}, title=${pageTitle})，继续尝试查找输入框`);
        }
      }
    }

    // 等待输入框出现（带重试机制）
    let activeSelector = this.inputSelector;
    let inputFound = false;

    // 第一轮：主选择器 + 回退选择器
    // 包含 Slate.js 编辑器选择器（文心一言等平台使用 data-slate-node="element"）
    // 包含 CSS Module 哈希类名选择器（DeepSeek 等平台使用 _xxxxxx 类名）
    const fallbackSelectors = [
      this.inputSelector,
      'textarea',
      'div[contenteditable="true"]',
      'div[data-slate-node="element"]',
      '[data-slate-node="element"]',
      '#chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      '[class*="input-area"] textarea',
      '[class*="input-area"] [contenteditable="true"]',
      'div[class] textarea',
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

    // 提交查询
    // 关键修复：用 page.keyboard.press('Enter') 而非 page.press(selector, 'Enter')
    // page.press(selector, 'Enter') 在某些平台（如豆包、元宝）不能触发发送，
    // 因为 fill 后焦点可能不在目标元素上，或 contenteditable 元素的 Enter 行为不同。
    // page.keyboard.press('Enter') 直接对当前焦点元素按键，与 DeepSeek 适配器一致。
    // 备用：Enter 后检查是否出现 AI 回答容器，若未出现则尝试点击发送按钮。
    const urlBeforeSubmit = page.url();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // 检查 Enter 是否成功发送查询（URL 变化或出现回答容器）
    const urlAfterSubmit = page.url();
    let querySent = urlAfterSubmit !== urlBeforeSubmit;
    if (!querySent && this.responseSelector) {
      // 检查是否出现了 AI 回答容器（即使内容还没生成）
      try {
        const hasResponseContainer = await page.$(this.responseSelector).catch(() => null);
        if (hasResponseContainer) querySent = true;
      } catch {}
    }

    if (!querySent) {
      // Enter 可能没发送成功，尝试点击发送按钮
      console.log(`[${this.platformName}] Enter 未触发查询发送 (URL未变化=${urlBeforeSubmit}→${urlAfterSubmit})，尝试点击发送按钮`);
      const sendBtnSelectors = [
        'button[data-testid*="send"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]',
        'button:has-text("发送")', '[class*="send-btn"]', '[class*="sendBtn"]',
        '[class*="submit"]', '[data-testid*="send"]',
        // 豆包: div.send-btn-wrapper button
        '.send-btn-wrapper button', 'div[class*="send-btn"] button',
      ];
      for (const btnSel of sendBtnSelectors) {
        try {
          const btn = await page.$(btnSel);
          if (btn) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            console.log(`[${this.platformName}] 点击发送按钮成功: ${btnSel}`);
            querySent = true;
            break;
          }
        } catch {}
      }
    }

    if (!querySent) {
      console.log(`[${this.platformName}] 警告: 无法确认查询是否发送，继续等待 AI 回答`);
    }

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
        // DeepSeek: /c/{id} 或 /chat/{id} 或 /a/chat/s/{uuid}（新格式）
        /\/c\/[a-zA-Z0-9_-]{8,}/,
        /\/chat\/[a-zA-Z0-9_-]{8,}/,
        /\/a\/chat\/s\/[a-zA-Z0-9_-]{8,}/,
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
    // 滚动到底部触发懒加载，确保 AI 回答完整渲染
    await this.scrollToBottom(page);

    if (!this.responseSelector) {
      // 无选择器时，尝试获取页面上最长的可见文本块
      // 优先查找常见的 AI 回答容器，避免获取到侧边栏/导航等无关内容
      const text = await page.evaluate(() => {
        // 1. 优先查找常见的 AI 回答容器
        const answerSelectors = [
          '[class*="answer"]', '[class*="response"]', '[class*="message"]',
          '[class*="chat-content"]', '[class*="chat-content"]',
          '[class*="bubble"]', '[class*="content"]', 'article', 'main'
        ];
        let bestText = '';
        for (const sel of answerSelectors) {
          const els = Array.from(document.querySelectorAll(sel));
          for (const el of els) {
            // 用 textContent 而非 innerText（innerText 受视口影响）
            const t = ((el as HTMLElement).textContent || '').trim();
            if (t.length > bestText.length) bestText = t;
          }
          if (bestText.length > 50) return bestText;
        }
        // 2. 兜底：获取页面上最长的 div 可见文本
        const elements = Array.from(document.querySelectorAll('div, section, article'));
        let lastLongText = '';
        for (const el of elements) {
          const t = ((el as HTMLElement).textContent || '').trim();
          if (t.length > lastLongText.length) lastLongText = t;
        }
        return lastLongText;
      });
      return { text, html: `<div>${text}</div>` };
    }

    try {
      // 持续轮询等待 AI 回答内容出现并稳定
      // 关键策略：用 page.evaluate 在浏览器上下文中一次性查找"最长的可见文本块"
      // 而非用 page.$$(responseSelector) 遍历元素（后者会匹配嵌套子元素导致只取到部分内容）
      //
      // 之前"取最长匹配元素"的问题：
      //   responseSelector 如 [class*="answer"] 会匹配父容器和子容器多个层级，
      //   流式输出时某个子 <p> 的 innerText 可能暂时最长被当作 bestText，
      //   导致只取到部分内容（几百字符）。
      //
      // 新策略：在浏览器内查找所有候选块级元素，排除侧边栏/导航等，
      // 取 innerText 最长的一个。这个元素通常是包含完整 AI 回答的最外层容器。
      let bestText = '';
      let bestHtml = '';
      let prevLen = 0;
      let stableCount = 0;
      let hasMeaningfulContent = false;

      for (let i = 0; i < 30; i++) {
        await this.scrollToBottom(page);

        // 在浏览器上下文中查找最长的可见文本块
        const result = await page.evaluate((sel) => {
          // 排除的元素选择器（侧边栏/导航/页脚/操作栏等）
          const excludeSelectors = [
            'nav', 'header', 'footer', 'aside',
            '[class*="sidebar"]', '[class*="Sidebar"]',
            '[class*="nav"]', '[class*="Nav"]',
            '[class*="menu"]', '[class*="Menu"]',
            '[class*="header"]', '[class*="Header"]',
            '[class*="footer"]', '[class*="Footer"]',
            '[class*="toolbar"]', '[class*="Toolbar"]',
            '[class*="operation"]', '[class*="action"]',
            // 排除输入框区域
            '[class*="input"]', '[class*="Input"]',
            '[contenteditable]', 'textarea', 'input',
          ];
          const excludeSet = new Set<Element>();
          for (const ex of excludeSelectors) {
            try { document.querySelectorAll(ex).forEach(el => {
              excludeSet.add(el);
              el.querySelectorAll('*').forEach(c => excludeSet.add(c));
            }); } catch {}
          }

          // 候选选择器：优先用 responseSelector，加上通用 markdown/answer 容器
          const candidateSelectors = sel.split(',').map((s: string) => s.trim()).filter(Boolean);
          candidateSelectors.push(
            '[class*="markdown"]', '[class*="Markdown"]',
            'article', 'main', '.chat-content', '[class*="chat-content"]'
          );

          let best = { text: '', html: '', selector: '' };
          const seen = new Set<Element>();

          for (const cs of candidateSelectors) {
            try {
              const els = Array.from(document.querySelectorAll(cs));
              for (const el of els) {
                if (excludeSet.has(el) || seen.has(el)) continue;
                seen.add(el);
                // 关键修复：用 textContent 而非 innerText
                // innerText 只返回视口内可见文本，AI 回答超出视口时只取到部分内容（几百字符）
                // textContent 返回所有文本（包括超出视口的部分），能拿到完整 AI 回答
                // 排除侧边栏等隐藏元素已通过 excludeSet 处理
                const t = ((el as HTMLElement).textContent || '').trim();
                // 只考虑长度 >= 50 的文本块
                if (t.length > best.text.length && t.length >= 50) {
                  best = {
                    text: t,
                    html: (el as HTMLElement).innerHTML || '',
                    selector: cs,
                  };
                }
              }
            } catch {}
          }

          return best;
        }, this.responseSelector).catch(() => ({ text: '', html: '', selector: '' }));

        const currentText = result.text || '';
        const currentHtml = result.html || '';
        const currentLen = currentText.trim().length;

        if (currentLen > bestText.trim().length) {
          bestText = currentText;
          bestHtml = currentHtml;
        }

        // 诊断日志：前3轮和每10轮输出一次
        if (i < 3 || i % 10 === 9) {
          console.log(`[${this.platformName}] extractContent 轮询#${i + 1}: 当前最长=${currentLen}字符, 历史最长=${bestText.trim().length}字符`);
        }

        if (currentLen >= 30) {
          hasMeaningfulContent = true;
          if (currentLen === prevLen) {
            stableCount++;
            if (stableCount >= 4) {
              console.log(`[${this.platformName}] 提取内容成功: ${bestText.trim().length} 字符 (轮询第${i + 1}轮稳定)`);
              return { text: bestText.trim(), html: bestHtml };
            }
          } else {
            stableCount = 0;
            prevLen = currentLen;
          }
        }

        await page.waitForTimeout(2000);
      }

      // 轮询结束，如果有有意义的内容就返回
      if (hasMeaningfulContent && bestText.trim().length >= 30) {
        console.log(`[${this.platformName}] 提取内容成功(轮询超时): ${bestText.trim().length} 字符`);
        return { text: bestText.trim(), html: bestHtml };
      }

      console.log(`[${this.platformName}] 提取内容失败: 轮询60秒后仍无有意义内容 (最长=${bestText.trim().length}字符)`);
    } catch (e) {
      console.error(`[${this.platformName}] 提取内容失败:`, (e as Error).message);
      return { text: '', html: '' };
    }
    return { text: '', html: '' };
  }

  /**
   * 滚动到页面底部，触发 SPA 懒加载，确保 AI 回答完整渲染
   */
  protected async scrollToBottom(page: Page): Promise<void> {
    try {
      // 滚动聊天容器到底部（触发懒加载，确保 AI 回答完整渲染）
      // 注意：不要滚回顶部！innerText 只返回视口内可见文本，
      // 滚回顶部会导致 AI 回答移出视口，innerText 只取到部分内容（几百字符）。
      await page.evaluate(() => {
        // 1. 尝试滚动所有可能的聊天容器到底部
        const scrollContainers: HTMLElement[] = [];
        const selLists = [
          '[class*="chat"]', '[class*="message"]', '[class*="conversation"]',
          '[class*="dialog"]', 'main',
        ];
        for (const s of selLists) {
          const els = document.querySelectorAll(s);
          for (let i = 0; i < els.length; i++) {
            const el = els[i] as HTMLElement;
            if (el.scrollHeight > el.clientHeight) scrollContainers.push(el);
          }
        }

        // 去重
        const containerSet = new Set<HTMLElement>(scrollContainers);
        containerSet.forEach(container => {
          container.scrollTop = container.scrollHeight;
        });

        // 2. 同时滚动 window 到底部（部分平台用 body 滚动）
        window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});
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
