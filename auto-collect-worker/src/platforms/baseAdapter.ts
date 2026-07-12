import { Page } from 'playwright';
import { PlatformAdapter, PlatformCredentials, QueryResult, randomDelay } from './base';
import { smartFindInputElement, smartFindLongestContent } from '../indexedInteractor';
import { humanType, humanDelay, humanClick } from '../behaviorHumanizer';
import * as logger from '../logger';

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

    // 第三轮：用 indexedInteractor 的 smartFindInputElement 兜底扫描页面所有可见可交互元素
    // 解决 DeepSeek/通义千问等平台偶发 textarea 不可见但页面有其他可输入元素的问题
    if (!inputFound) {
      console.log(`[${this.platformName}] 两轮选择器全部失败，启用 smartFindInputElement 兜底扫描...`);
      try {
        const smartEl = await smartFindInputElement(page);
        if (smartEl) {
          console.log(`[${this.platformName}] smartFindInputElement 找到可输入元素，使用 click+type 输入`);
          await smartEl.click({ timeout: 5000 }).catch(() => {});
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Delete');
          await page.keyboard.type(keyword, { delay: 50 });
          await randomDelay(500, 1500);
          await page.keyboard.press('Enter');
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
      } catch (e: any) {
        console.log(`[${this.platformName}] smartFindInputElement 兜底失败: ${e.message}`);
      }
    }

    if (!inputFound) {
      // 输出页面 URL 和标题辅助排查
      const url = page.url();
      const title = await page.title().catch(() => '未知');
      throw new Error(`输入框未找到: 主选择器(${this.inputSelector})及所有回退选择器均超时 (URL=${url}, title=${title})`);
    }

    // 清空输入框并填入关键词（v1.3+ 行为人性化：逐字符输入 + 随机间隔）
    // 部分平台 fill 失败（如 contenteditable），降级为 humanType
    try {
      // 优先用 humanType 逐字符输入（反检测核心：避免瞬时输入被识别为自动化）
      const inputEl = await page.$(activeSelector);
      if (inputEl) {
        await humanType(page, inputEl, keyword, { clear: true });
      } else {
        // 兜底：fill + 固定 delay
        await page.fill(activeSelector, '');
        await page.fill(activeSelector, keyword);
      }
    } catch {
      console.log(`[${this.platformName}] humanType 失败，降级为 fill+type`);
      try {
        await page.fill(activeSelector, '');
        await page.fill(activeSelector, keyword);
      } catch {
        await page.click(activeSelector).catch(() => {});
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(keyword, { delay: 50 });
      }
    }
    // 提交前随机停顿（模拟人类思考）
    await humanDelay('medium');

    // 提交
    await page.press(activeSelector, 'Enter');

    // 等待 AI 回答完成
    await this.waitForResponse(page);

    // 提取内容
    const { text, html } = await this.extractContent(page);
    const shareUrl = await this.extractShareLink(page);

    // ============ 账号异常检测（v1.8+ 重要）============
    // 查询成功但内容异常短，通常意味着账号登录态失效或 token 过期
    // 之前 bug：这种情况被当作正常查询成功处理，只在日志中通过"内容长度=12"间接体现
    // 现在改为明确检测并抛出异常，让上层标记账号 offline
    const anomaly = await this.detectAccountAnomaly(page, text);
    if (anomaly) {
      throw new Error(anomaly);
    }

    return {
      content: text,
      shareUrl,
      htmlContent: html,
      supportsShare: this.supportsShare,
    };
  }

  /**
   * 检测账号异常（登录态失效、token 过期、被封禁等）
   *
   * 触发条件：内容长度 < 200 字符（正常 AI 回答至少 500+ 字符）
   * 检测策略：
   * 1. 页面文本包含明确的登录失效/token 过期关键词 → 抛"登录态失效"
   * 2. 内容极短（< 50 字符）且不含查询关键词 → 抛"账号异常：内容过短"
   * 3. 页面 URL 被重定向到登录页 → 抛"登录态失效"
   *
   * @returns 错误消息（如"登录态失效: token 过期"）或 null（正常）
   */
  protected async detectAccountAnomaly(page: Page, content: string): Promise<string | null> {
    const contentLen = content.trim().length;

    // 正常内容长度（> 200 字符）直接放行
    if (contentLen >= 200) return null;

    // ===== 1. 检测页面中的登录失效/token 过期关键词 =====
    try {
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '').catch(() => '');
      const pageLower = pageText.toLowerCase();

      // 明确的登录失效关键词
      const loginExpiredKeywords = [
        'token is expired', 'token expired', '登录已失效', '登录失效',
        '请重新登录', '请先登录', '未登录', 'login expired',
        '会话已过期', 'session expired', '认证失败', 'authentication failed',
        '请扫码登录', '请登录后',
      ];
      for (const kw of loginExpiredKeywords) {
        if (pageLower.includes(kw.toLowerCase())) {
          const msg = `登录态失效: 检测到页面关键词"${kw}" (内容长度=${contentLen})`;
          console.warn(`[${this.platformName}] ⚠️ ${msg}`);
          return msg;
        }
      }

      // 智谱AI 特有：token 过期会显示"本次回答已被终止 重新回答"
      // Kimi 特有：登录态失效会显示"© 2026 北京月之暗面科技有限公司"页脚
      // 这些是平台特定的登录失效信号
      const platformSignals: Record<string, string[]> = {
        '智谱AI': ['本次回答已被终止', 'token is expired', 'ChatGLM语音梦幻杰'],
        'Kimi': ['北京月之暗面科技有限公司', '京ICP备'],
        '豆包': ['登录抖音', '请登录', '未登录'],
        '通义千问': ['请登录', '登录阿里', '未登录'],
        '腾讯元宝': ['请登录', '登录腾讯', '未登录'],
        '文心一言': ['请登录', '登录百度', '未登录'],
        'DeepSeek': ['sign in', 'sign_in', '请登录'],
        '纳米': ['请登录', '360登录', '未登录'],
      };
      const signals = platformSignals[this.platformName] || [];
      for (const sig of signals) {
        if (pageText.includes(sig)) {
          const msg = `登录态失效: 检测到平台信号"${sig}" (内容长度=${contentLen})`;
          console.warn(`[${this.platformName}] ⚠️ ${msg}`);
          return msg;
        }
      }
    } catch { /* 忽略 evaluate 失败 */ }

    // ===== 2. 检测页面 URL 被重定向到登录页 =====
    try {
      const currentUrl = page.url().toLowerCase();
      if (currentUrl.includes('login') || currentUrl.includes('sign_in') || currentUrl.includes('signin')) {
        const msg = `登录态失效: 查询后页面被重定向到登录页 (URL=${page.url()}, 内容长度=${contentLen})`;
        console.warn(`[${this.platformName}] ⚠️ ${msg}`);
        return msg;
      }
    } catch { /* 忽略 */ }

    // ===== 3. 内容极短但未检测到明确信号 → 仍标记为可疑 =====
    // 内容 < 50 字符，几乎可以肯定不是正常的 AI 回答
    if (contentLen < 50) {
      const preview = content.trim().substring(0, 50).replace(/\n/g, ' ');
      const msg = `账号异常：内容过短(${contentLen}字符) 预览="${preview}" 可能登录态失效或token过期`;
      console.warn(`[${this.platformName}] ⚠️ ${msg}`);
      return msg;
    }

    // 内容 50-200 字符，可能是占位符或错误提示，记录警告但不抛异常
    if (contentLen < 200) {
      const preview = content.trim().substring(0, 80).replace(/\n/g, ' ');
      console.warn(`[${this.platformName}] ⚠️ 内容较短(${contentLen}字符) 预览="${preview}" 可疑，但未达到异常阈值`);
    }

    return null;
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

  /**
   * 注入 clipboard + execCommand 拦截，捕获复制到剪贴板的分享 URL
   * 所有适配器的 extractShareLink 都应在点击分享按钮前调用此方法
   *
   * @param urlPatterns URL 匹配模式数组（如 ['/share/', 'kimi.com']），匹配其中一个即认为捕获成功
   */
  protected async injectClipboardInterceptor(page: Page, urlPatterns: string[]): Promise<void> {
    await page.evaluate((patterns: string[]) => {
      (window as any).__capturedShareUrl__ = null;
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && patterns.some(p => text.includes(p))) {
          (window as any).__capturedShareUrl__ = text;
        }
        return origWrite(text);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          if (patterns.some(p => selText.includes(p))) {
            (window as any).__capturedShareUrl__ = selText;
          }
        }
        return origExec(cmd);
      };
    }, urlPatterns).catch(() => {});
  }

  /**
   * 从拦截到的剪贴板内容提取 URL
   * @param urlPattern URL 中必须包含的子串（如 '/share/'）
   * @returns 匹配到的 URL 或 null
   */
  protected async getCapturedShareUrl(page: Page, urlPattern: string): Promise<string | null> {
    const captured = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (captured) {
      const urlMatch = captured.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && urlMatch[0].includes(urlPattern)) {
        return urlMatch[0];
      }
    }
    return null;
  }

  /**
   * 健壮地查找并点击分享按钮
   *
   * 策略：
   * 1. 先尝试传入的 CSS 选择器列表（精确匹配）
   * 2. 用 Playwright Locator filter({ hasText }) 按文本匹配
   * 3. 用属性选择器匹配 aria-label / title / data-testid / class 含 "share"
   * 4. 如果以上都失败，hover 所有消息/回答区域（很多平台操作栏 hover 才显示），然后重试 1-3
   *
   * 关键：所有点击都用 Playwright 的 click()（真实鼠标事件 mousedown→mouseup→click），
   *       不用 evaluate + element.click()（JS 原生 click 对 React/Vue 不生效）
   *
   * @param page Playwright Page
   * @param selectors CSS 选择器列表（按优先级排序）
   * @param shareTexts 分享按钮可能的文案（如 ['分享', 'Share', '复制链接']）
   * @returns 是否成功点击了分享按钮
   */
  protected async findAndClickShareButton(
    page: Page,
    selectors: string[],
    shareTexts: string[] = ['分享', 'Share', '分享对话', '复制链接', 'Copy link', 'Copy Link']
  ): Promise<boolean> {
    // 第一轮：直接尝试三个策略
    const found = await this._tryClickShareButton(page, selectors, shareTexts);
    if (found) return true;

    // 第二轮：hover 消息/回答区域后重试
    // 大部分 AI 平台（DeepSeek/Kimi/豆包/通义千问等）的操作栏 hover 才显示
    logger.warn(`[${this.platformName}] 第一轮未找到分享按钮，尝试 hover 消息区域后重试...`);
    await this._hoverMessageAreas(page);

    const found2 = await this._tryClickShareButton(page, selectors, shareTexts);
    if (found2) return true;

    logger.warn(`[${this.platformName}] 未找到分享按钮（hover 后仍失败）`);
    return false;
  }

  /** 内部方法：尝试三个策略查找并点击分享按钮 */
  private async _tryClickShareButton(
    page: Page,
    selectors: string[],
    shareTexts: string[]
  ): Promise<boolean> {
    // 策略1：尝试传入的 CSS 选择器（Playwright click，真实鼠标事件）
    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500);
          logger.info(`[${this.platformName}] 点击分享按钮成功(选择器): ${sel}`);
          return true;
        }
      } catch { /* 继续 */ }
    }

    // 策略2：用 Playwright Locator filter({ hasText }) 按文本匹配
    try {
      const textRegex = new RegExp(shareTexts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
      const textMatches = page.locator('button, a, [role="button"], [class*="icon"]')
        .filter({ hasText: textRegex });
      const textCount = await textMatches.count().catch(() => 0);
      if (textCount > 0) {
        for (let i = textCount - 1; i >= 0; i--) {
          try {
            const el = textMatches.nth(i);
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            const text = (await el.textContent().catch(() => '') || '').trim().substring(0, 30);
            await el.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1500);
            logger.info(`[${this.platformName}] 点击分享按钮成功(hasText): text="${text}"`);
            return true;
          } catch { /* 继续 */ }
        }
      }
    } catch { /* 继续 */ }

    // 策略3：用属性选择器匹配 aria-label / title / data-testid / class 含 "share"
    const attrSelectors = [
      '[aria-label*="分享"]',
      '[aria-label*="share" i]',
      '[title*="分享"]',
      '[title*="share" i]',
      '[data-testid*="share"]',
      '[data-testid*="share" i]',
      '[class*="share"]:not([class*="shared"]):not([class*="sharing"])',
    ];
    for (const sel of attrSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          for (let i = count - 1; i >= 0; i--) {
            try {
              const el = loc.nth(i);
              const visible = await el.isVisible().catch(() => false);
              if (!visible) continue;
              const className = await el.getAttribute('class').catch(() => '') || '';
              await el.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(1500);
              logger.info(`[${this.platformName}] 点击分享按钮成功(属性): sel="${sel}" class="${className.substring(0, 50)}"`);
              return true;
            } catch { /* 继续 */ }
          }
        }
      } catch { /* 继续 */ }
    }

    return false;
  }

  /** hover 消息/回答区域，触发操作栏显示 */
  private async _hoverMessageAreas(page: Page): Promise<void> {
    // 所有可能包含 AI 回答的容器选择器
    const messageSelectors = [
      '[class*="message"]:not([class*="input"]):not([class*="send"])',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="reply"]',
      '[class*="chat-item"]',
      '[class*="conversation-item"]',
      '[class*="bubble"]',
      'article',
      '[class*="markdown"]',
      '[class*="content"]:not([class*="input-content"])',
    ];

    for (const sel of messageSelectors) {
      try {
        const elements = await page.$$(sel);
        // hover 最后几个元素（最新的回答通常在后面）
        const startIdx = Math.max(0, elements.length - 5);
        for (let i = elements.length - 1; i >= startIdx; i--) {
          try {
            const visible = await elements[i].isVisible().catch(() => false);
            if (!visible) continue;
            await elements[i].hover({ timeout: 1000 }).catch(() => {});
            await page.waitForTimeout(300); // 等待操作栏动画
          } catch { /* 继续 */ }
        }
      } catch { /* 继续 */ }
    }
  }

  /**
   * 从弹窗中提取分享链接（兜底策略）
   * @param urlPattern URL 中必须包含的子串
   */
  protected async extractShareUrlFromDialog(page: Page, urlPattern: string): Promise<string | null> {
    const dialogSelectors = [
      '[role="dialog"]', '[class*="share-dialog"]', '[class*="share-modal"]',
      '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
    ];
    for (const dlgSel of dialogSelectors) {
      try {
        const dlg = await page.$(dlgSel).catch(() => null);
        if (!dlg) continue;
        const visible = await dlg.isVisible().catch(() => false);
        if (!visible) continue;

        // 从 input 中提取
        const inputUrl = await dlg.evaluate((node: HTMLElement) => {
          const input = node.querySelector('input');
          return input?.value || input?.textContent || '';
        }).catch(() => '');
        if (inputUrl && inputUrl.includes(urlPattern)) {
          console.log(`[${this.platformName}] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }

        // 从文本中匹配 URL
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(new RegExp(`https?://[^\\s<>"']+${urlPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s<>"']*`));
        if (urlMatch) {
          console.log(`[${this.platformName}] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }
    return null;
  }

  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载，再滚动回顶部（确保所有内容渲染完成）
    await this.scrollToBottom(page);

    if (!this.responseSelector) {
      // 无选择器时，直接用 smartFindLongestContent 扫描最长文本
      const smart = await smartFindLongestContent(page, 50);
      if (smart) {
        console.log(`[${this.platformName}] smartFindLongestContent 提取成功: ${smart.text.length} 字符`);
        return { text: smart.text, html: smart.html };
      }
      return { text: '', html: '' };
    }

    try {
      // 等待回答选择器出现
      await page.waitForSelector(this.responseSelector, { timeout: 30000 });
      // 再次滚动确保完整渲染
      await this.scrollToBottom(page);
      // 取最后一个匹配的元素（最新的回答）
      const elements = await page.$$(this.responseSelector);

      // 收集所有候选元素及其质量评分
      interface MatchCandidate {
        text: string;
        html: string;
        score: number;
        index: number;
      }
      const candidates: MatchCandidate[] = [];

      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        // 跳过导航/侧边栏元素（class/id/role 匹配）
        const isNav = await el.evaluate((node: HTMLElement) => {
          const navPatterns = /sidebar|side-bar|sidenav|side-nav|navigation|nav-bar|navbar|menu|aside|left-bar|leftbar|right-bar|rightbar|history|conversation-list|chat-list|session/i;
          const cls = node.className || '';
          const id = node.id || '';
          const role = node.getAttribute('role') || '';
          return navPatterns.test(cls) || navPatterns.test(id) || role === 'navigation' || role === 'menu';
        }).catch(() => false);
        if (isNav) continue;

        const text = (await el.textContent()) || '';
        if (text.trim().length === 0) continue;

        // 清理 HTML
        const cleanedHtml = await el.evaluate((node: HTMLElement) => {
          const clone = node.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('style, script, noscript').forEach(e => e.remove());
          const removeSelectors = [
            'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
            'img', 'video', 'audio', 'source',
            'button', 'input', 'textarea', 'select', 'form',
            '.btn', '.button', '.action', '.toolbar', '.menu', '.sidebar',
            '.navigation', '.nav', '.header', '.footer',
            '[class*="btn"]', '[class*="button"]', '[class*="action"]',
            '[class*="toolbar"]', '[class*="menu"]', '[class*="sidebar"]',
            '[class*="navigation"]', '[class*="nav-"]', '[class*="header"]',
            '[class*="footer"]', '[class*="copy"]', '[class*="share"]',
            '[class*="like"]', '[class*="feedback"]', '[class*="rating"]',
            '[role="button"]', '[role="navigation"]', '[role="toolbar"]',
            '[aria-hidden="true"]',
          ];
          for (const sel of removeSelectors) {
            clone.querySelectorAll(sel).forEach(e => e.remove());
          }
          return clone.innerHTML;
        }).catch(() => '');

        const cleanedText = cleanedHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

        // 评分：优先散文内容（含 <p> 标签）
        const quality = await el.evaluate((node: HTMLElement) => {
          const pCount = node.querySelectorAll('p').length;
          const linkCount = node.querySelectorAll('a').length;
          const textLen = (node.textContent || '').length;
          const hasMarkdown = /markdown|prose|content-body|message-content|answer-content|response-content/i.test(node.className || '');
          return { pCount, linkCount, textLen, hasMarkdown };
        }).catch(() => ({ pCount: 0, linkCount: 0, textLen: text.length, hasMarkdown: false }));

        let score = cleanedText.length;
        if (quality.pCount > 0) score *= 3; // 含 <p> 标签 = 散文，3 倍加权
        if (quality.hasMarkdown) score *= 2;
        if (quality.linkCount > 3) {
          const linkRatio = quality.linkCount / Math.max(cleanedText.length, 1);
          score *= (1 - Math.min(linkRatio * 10, 0.8));
        }

        candidates.push({ text: text.trim(), html: cleanedHtml || `<div>${escapeHtml(text.trim())}</div>`, score, index: i });
      }

      // 按评分排序，取最高分
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        console.log(`[${this.platformName}] 提取内容成功: ${best.text.length} 字符 (score=${Math.round(best.score)}, 从 ${candidates.length} 个候选中选择, selector: ${this.responseSelector.split(',')[0]}...)`);
        return { text: best.text, html: best.html };
      }

      // 选择器匹配到元素但内容为空，走兜底
      console.log(`[${this.platformName}] responseSelector 匹配到 ${elements.length} 个元素但无有效内容，走兜底`);
    } catch (e) {
      console.log(`[${this.platformName}] responseSelector 等待超时: ${(e as Error).message}，走兜底`);
    }

    // 兜底1：用 smartFindLongestContent 扫描页面所有长文本元素
    // 替代之前的 document.body.textContent + substring(0, 10000) 截断
    // 解决：1) 豆包每次 10000 字符截断 2) 避免提取侧边栏/导航等无关内容
    try {
      const smart = await smartFindLongestContent(page, 50);
      if (smart) {
        console.log(`[${this.platformName}] smartFindLongestContent 兜底提取: ${smart.text.length} 字符`);
        return { text: smart.text, html: smart.html };
      }
    } catch (e) {
      console.error(`[${this.platformName}] smartFindLongestContent 兜底失败:`, (e as Error).message);
    }

    // 兜底2：最终降级，取 body 文本（不截断，保留完整内容）
    try {
      const text = await page.evaluate(() => document.body.textContent || '');
      if (text.trim().length > 0) {
        console.log(`[${this.platformName}] body.textContent 兜底提取: ${text.trim().length} 字符`);
        return { text: text.trim(), html: `<div>${escapeHtml(text.trim())}</div>` };
      }
    } catch (e) {
      console.error(`[${this.platformName}] body.textContent 兜底失败:`, (e as Error).message);
    }
    return { text: '', html: '' };
  }

  /**
   * 滚动到页面底部，触发 SPA 懒加载，确保 AI 回答完整渲染
   * 注意：之前有 totalHeight > 10000 的限制，导致长回答被截断
   *       现改为按 scrollHeight 完整滚动，最多 30 秒
   */
  protected async scrollToBottom(page: Page): Promise<void> {
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          let lastScrollHeight = 0;
          let stableCount = 0;
          const distance = 300;
          const startTime = Date.now();
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            // 检测页面高度是否稳定（连续 3 次不变则认为加载完成）
            if (scrollHeight === lastScrollHeight) {
              stableCount++;
              if (stableCount >= 3) {
                clearInterval(timer);
                resolve();
                return;
              }
            } else {
              stableCount = 0;
            }
            lastScrollHeight = scrollHeight;
            // 到达底部
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
              return;
            }
            // 超时 30 秒
            if (Date.now() - startTime > 30000) {
              clearInterval(timer);
              resolve();
              return;
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

/** HTML 特殊字符转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
