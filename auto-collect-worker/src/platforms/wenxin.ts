import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';
import { QueryResult } from './base';
import { humanType, humanDelay } from '../behaviorHumanizer';

/**
 * 文心一言适配器（v3 — 2026-07-12 重写）
 *
 * 2026年6月25日起，文心一言官网迁移至 https://wenxin.baidu.com/
 *
 * v3 核心改进（修复内容 3 万~5 万字符问题）：
 *   根因：旧版 extractContent 用 [class*="answer"] 模糊选择器，匹配到
 *         conversation-flow-answer-container（2881字符）或更大的容器，
 *         包含推荐问题/搜索结果/UI元素，MAX_CONTENT_LENGTH=50000 截断后仍有 5 万字符
 *
 *   修复策略：重写 query()，改为"分享链接提取"模式
 *     1. 在对话页输入关键词，等待 AI 回答完成
 *     2. 点击分享按钮 [data-testid="menu-btn-share"] → 点击"复制链接"
 *     3. 通过 document.execCommand 拦截获取短链接 https://mr.baidu.com/r/...
 *     4. 导航到分享链接页面（重定向到 chat.baidu.com/csaitab/history/share?share_id=...）
 *     5. 从分享页用 .cosd-markdown-content 精确选择器提取纯净 AI 回答
 *     6. 分享页内容非常干净（只有问题+回答），不会抓到侧边栏/UI元素
 *
 *   实地调查发现（2026-07-12）：
 *     - 分享按钮：[data-testid="menu-btn-share"]（不是 button:has-text("分享")）
 *     - 复制方式：document.execCommand('copy')（不是 navigator.clipboard.writeText）
 *     - 复制格式：【和文心的对话】{url}
 *     - 分享页选择器：.cosd-markdown-content（66字符纯回答，最精确）
 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://wenxin.baidu.com/';
  chatUrl = 'https://wenxin.baidu.com/';
  supportsShare = true;
  protected inputSelector = '#chat-textarea, div[data-slate-node="element"], textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.cosd-markdown-content, .answer-container, [class*="answer-container"], [class*="markdown"]';
  protected stopButtonSelector = '[class*="pause"], [class*="stop"], .stop-btn, [class*="Stop"], [class*="loading"]';
  protected loginUrlPattern = 'login';

  /**
   * 重写 query()：分享链接提取模式
   *
   * 流程：
   *   1. 导航到聊天页 → 输入关键词 → 等待 AI 回答完成
   *   2. 通过分享按钮获取分享短链接
   *   3. 导航到分享链接页面，提取纯净 AI 回答
   *   4. 降级：分享链接获取失败时，从对话页用精确选择器提取
   */
  async query(page: Page, keyword: string): Promise<QueryResult> {
    // ============ 第一步：导航到聊天页 ============
    try {
      await page.goto(this.chatUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(3000);

    // 登录状态检查
    const currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sign_in')) {
      throw new Error(`登录态失效: 页面被重定向到登录页 (URL=${currentUrl})`);
    }

    // afterNavigate：点击"开启新对话"等入口按钮
    await this.afterNavigate(page);

    // ============ 第二步：找到输入框并输入关键词 ============
    const fallbackSelectors = [
      this.inputSelector,
      '#chat-textarea',
      'textarea',
      'div[contenteditable="true"]',
      'div[data-slate-node="element"]',
      '[role="textbox"]',
    ];

    let activeSelector = '';
    let inputFound = false;
    for (const selector of fallbackSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
        activeSelector = selector;
        inputFound = true;
        break;
      } catch {
        // 继续尝试
      }
    }

    if (!inputFound) {
      // 重试一次
      await page.waitForTimeout(5000);
      for (const selector of fallbackSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
          activeSelector = selector;
          inputFound = true;
          break;
        } catch {
          // 继续
        }
      }
    }

    if (!inputFound) {
      const url = page.url();
      const title = await page.title().catch(() => '未知');
      throw new Error(`输入框未找到: 所有选择器均超时 (URL=${url}, title=${title})`);
    }

    // 输入关键词（人性化输入）
    try {
      const inputEl = await page.$(activeSelector);
      if (inputEl) {
        await humanType(page, inputEl, keyword, { clear: true });
      } else {
        await page.fill(activeSelector, keyword);
      }
    } catch {
      try {
        await page.fill(activeSelector, keyword);
      } catch {
        await page.click(activeSelector).catch(() => {});
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(keyword, { delay: 50 });
      }
    }
    await humanDelay('medium');

    // 提交
    await page.press(activeSelector, 'Enter');

    // ============ 第三步：等待 AI 回答完成 ============
    await this.waitForResponse(page);

    // ============ 第四步：获取分享链接 ============
    const shareUrl = await this.extractShareLink(page);

    // ============ 第五步：提取内容 ============
    let content = '';
    let htmlContent = '';

    if (shareUrl) {
      // 优先方案：导航到分享链接页面，提取纯净内容
      console.log(`[文心一言] 分享链接获取成功: ${shareUrl}，导航到分享页提取内容`);
      const shareContent = await this.extractContentFromSharePage(page, shareUrl);
      if (shareContent) {
        content = shareContent.text;
        htmlContent = shareContent.html;
        console.log(`[文心一言] 从分享页提取成功: ${content.length} 字符`);
      }
    }

    // 降级方案：分享页提取失败时，从对话页用精确选择器提取
    if (!content) {
      console.log('[文心一言] 分享页提取失败，降级从对话页提取');
      const fallback = await this.extractContentFromChatPage(page);
      content = fallback.text;
      htmlContent = fallback.html;
    }

    return {
      content,
      shareUrl,
      htmlContent,
      supportsShare: this.supportsShare,
    };
  }

  /**
   * 从分享链接页面提取纯净 AI 回答
   *
   * 分享页 DOM 结构（实地调查 2026-07-12）：
   *   - .cosd-markdown-content（66 字符纯回答）— 最精确
   *   - .answer-container.cs-enable-selection（66 字符）— 备选
   *   - .cosd-markdown（66 字符）— 备选
   *   - .ai-entry-block.ai-markdown（66 字符）— 备选
   *
   * 分享页 URL 重定向链：
   *   https://mr.baidu.com/r/{短码} → https://chat.baidu.com/csaitab/history/share?share_id=...
   */
  private async extractContentFromSharePage(page: Page, shareUrl: string): Promise<{ text: string; html: string } | null> {
    try {
      // 导航到分享链接页面（短链接会自动重定向）
      await page.goto(shareUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {
        // networkidle 超时降级
      });
      await page.waitForTimeout(3000); // 等待 SPA 渲染

      // 精确选择器（按优先级排序，从最精确到最宽泛）
      const preciseSelectors = [
        '.cosd-markdown-content',                          // 最精确的纯回答容器
        '.ai-entry-block.ai-markdown',                     // markdown 入口块
        '.cosd-markdown',                                  // markdown 容器
        '.answer-container.cs-enable-selection',           // 回答容器
        '.cs-history-answer',                              // 历史回答
        '.cos-swiper-item.cs-history-answer',              // swiper 回答项
      ];

      for (const sel of preciseSelectors) {
        try {
          const elements = await page.$$(sel);
          // 从后往前找（最新的回答在后面）
          for (let i = elements.length - 1; i >= 0; i--) {
            const text = (await elements[i].textContent()) || '';
            const trimmed = text.trim();
            // 只接受有实质内容的回答（>20 字符）
            if (trimmed.length > 20) {
              // 清理 HTML
              const cleanedHtml = await elements[i].evaluate((node: HTMLElement) => {
                const clone = node.cloneNode(true) as HTMLElement;
                const removeSelectors = [
                  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
                  'button', 'input', 'textarea', 'select', 'form',
                  '[class*="btn"]', '[class*="button"]', '[class*="action"]',
                  '[class*="toolbar"]', '[class*="menu"]', '[class*="share"]',
                  '[class*="copy"]', '[class*="like"]', '[class*="feedback"]',
                  '[aria-hidden="true"]',
                ];
                for (const r of removeSelectors) {
                  clone.querySelectorAll(r).forEach(e => e.remove());
                }
                return clone.innerHTML;
              }).catch(() => '');
              console.log(`[文心一言] 分享页选择器 ${sel} 提取成功: ${trimmed.length} 字符`);
              return { text: trimmed, html: cleanedHtml || `<div>${trimmed}</div>` };
            }
          }
        } catch {
          // 继续
        }
      }

      // 兜底：取页面 body 文本（分享页本身很干净，body 文本也可用）
      const bodyText = await page.evaluate(() => {
        const body = document.body;
        if (!body) return '';
        const clone = body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, iframe, svg, button, [class*="btn"], [aria-hidden="true"]').forEach(e => e.remove());
        return clone.textContent || '';
      }).catch(() => '');
      const trimmedBody = bodyText.trim().replace(/\s+/g, ' ');
      if (trimmedBody.length > 20) {
        console.log(`[文心一言] 分享页 body 兜底提取: ${trimmedBody.length} 字符`);
        return { text: trimmedBody, html: `<div>${trimmedBody}</div>` };
      }

      return null;
    } catch (e: any) {
      console.log(`[文心一言] 分享页提取失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 降级方案：从对话页面提取 AI 回答（分享链接获取失败时使用）
   *
   * 使用精确选择器，避免抓到大容器
   */
  private async extractContentFromChatPage(page: Page): Promise<{ text: string; html: string }> {
    await this.scrollToBottom(page);

    // 精确选择器（按优先级排序）
    const preciseSelectors = [
      '.cosd-markdown-content',
      '.ai-entry-block.ai-markdown',
      '.cosd-markdown',
      '.answer-container.cs-enable-selection',
      '.cs-answer-container',
      '.chat-search-answer-generate-item',
    ];

    for (const sel of preciseSelectors) {
      try {
        const elements = await page.$$(sel);
        for (let i = elements.length - 1; i >= 0; i--) {
          const text = (await elements[i].textContent()) || '';
          const trimmed = text.trim();
          if (trimmed.length > 20) {
            const cleanedHtml = await elements[i].evaluate((node: HTMLElement) => {
              const clone = node.cloneNode(true) as HTMLElement;
              const removeSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
                'img', 'video', 'audio', 'button', 'input', 'textarea', 'select', 'form',
                '[class*="btn"]', '[class*="button"]', '[class*="action"]',
                '[class*="toolbar"]', '[class*="menu"]', '[class*="sidebar"]',
                '[class*="share"]', '[class*="copy"]', '[class*="like"]',
                '[class*="feedback"]', '[aria-hidden="true"]',
              ];
              for (const r of removeSelectors) {
                clone.querySelectorAll(r).forEach(e => e.remove());
              }
              return clone.innerHTML;
            }).catch(() => '');
            console.log(`[文心一言] 对话页选择器 ${sel} 提取成功: ${trimmed.length} 字符`);
            return { text: trimmed, html: cleanedHtml || `<div>${trimmed}</div>` };
          }
        }
      } catch {
        // 继续
      }
    }

    console.log('[文心一言] 对话页精确选择器均未匹配，返回空内容');
    return { text: '', html: '' };
  }

  /**
   * 文心一言分享链接提取（v3 重写）
   *
   * 实地调查发现（2026-07-12）：
   *   1. 分享按钮：[data-testid="menu-btn-share"]（不是 button:has-text("分享")）
   *   2. 点击后弹出底部工具栏：全选 / 分享图片 / 复制链接
   *   3. "复制链接"按钮：button:has-text("复制链接")
   *   4. 复制方式：document.execCommand('copy')（不是 navigator.clipboard.writeText）
   *   5. 复制格式：【和文心的对话】{url}
   *   6. 分享链接格式：https://mr.baidu.com/r/{短码}?f=ot&u={userHash}
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 document.execCommand 拦截脚本
    // 文心一言用 execCommand('copy') 复制，不是 navigator.clipboard.writeText
    await page.evaluate(() => {
      (window as any).__capturedShareText__ = null;
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          // 尝试从选区或焦点元素获取复制内容
          const selection = window.getSelection();
          if (selection && selection.toString()) {
            (window as any).__capturedShareText__ = selection.toString();
          }
          // 也尝试从隐藏 textarea 获取
          const ta = document.querySelector('textarea:focus') as HTMLTextAreaElement;
          if (ta && ta.value) {
            (window as any).__capturedShareText__ = ta.value;
          }
        }
        return origExec(cmd);
      };
      // 同时拦截 clipboard.writeText 作为兜底
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && text.includes('http')) {
          (window as any).__capturedShareText__ = text;
        }
        return origWrite(text);
      };
    }).catch(() => {});

    // 步骤2: 点击分享按钮 [data-testid="menu-btn-share"]
    const shareBtnSelectors = [
      '[data-testid="menu-btn-share"]',
      '.cos-icon-share1',
      '[class*="share"]:not([class*="shared"])',
    ];

    let shareBtnClicked = false;
    for (const sel of shareBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500); // 等待工具栏动画
          shareBtnClicked = true;
          console.log(`[文心一言] 点击分享按钮成功: ${sel}`);
          break;
        }
      } catch {
        // 继续
      }
    }

    if (!shareBtnClicked) {
      console.log('[文心一言] 未找到分享按钮');
      return null;
    }

    // 步骤3: 点击"复制链接"按钮
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      '[class*="copy-link"]',
    ];

    let copyBtnClicked = false;
    for (const sel of copyBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500); // 等待复制完成
          copyBtnClicked = true;
          console.log(`[文心一言] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch {
        // 继续
      }
    }

    // 步骤4: 从拦截到的文本中提取 URL
    if (copyBtnClicked) {
      const capturedText = await page.evaluate(() => (window as any).__capturedShareText__ as string | null).catch(() => null);
      if (capturedText) {
        // 复制格式：【和文心的对话】{url}
        const urlMatch = capturedText.match(/https?:\/\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[文心一言] 从复制内容提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
        // 如果捕获到的本身就是 URL
        if (capturedText.startsWith('http')) {
          console.log(`[文心一言] 捕获到分享链接: ${capturedText}`);
          return capturedText;
        }
      }
    }

    // 步骤5: 兜底 — 检查是否弹出了包含 URL 的对话框
    const dialogSelectors = ['[role="dialog"]', '[class*="share-dialog"]', '[class*="share-modal"]', '[class*="popup"]'];
    for (const dlgSel of dialogSelectors) {
      try {
        const dlg = await page.$(dlgSel).catch(() => null);
        if (!dlg) continue;
        const visible = await dlg.isVisible().catch(() => false);
        if (!visible) continue;
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(/https?:\/\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[文心一言] 从对话框提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch {
        // 继续
      }
    }

    // 步骤6: 关闭工具栏/对话框
    await page.keyboard.press('Escape').catch(() => {});

    console.log('[文心一言] 未能提取到分享链接');
    return null;
  }

  protected async afterNavigate(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      return;
    }

    const hasVisibleInput = await this.hasVisibleInput(page);
    if (hasVisibleInput) {
      return;
    }

    console.log(`[文心一言] 未找到可见输入框，尝试点击"开启新对话"按钮`);
    await this.tryClickEntryButton(page);
  }

  private async hasVisibleInput(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 2000, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  private async tryClickEntryButton(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const entryTexts = ['开启新对话', '开始对话', '立即体验', '开始使用', '新建对话', '开始聊天', '立即开始'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text === nt)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text.includes(nt) && text.length < 20)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(3000);
    }
  }

  /**
   * 重写 waitForResponse：文心一言回答完成检测
   * 文心一言没有明显的停止按钮，用"已完成"文本 + 固定等待
   */
  async waitForResponse(page: Page): Promise<void> {
    // 策略1：等待"智能体回答中"提示消失（表示回答完成）
    try {
      // 先等待"回答中"提示出现
      await page.waitForFunction(
        () => document.body.textContent?.includes('回答中') || document.body.textContent?.includes('生成中'),
        { timeout: 10000 }
      ).catch(() => {});

      // 然后等待"回答中"提示消失
      await page.waitForFunction(
        () => !document.body.textContent?.includes('回答中') && !document.body.textContent?.includes('生成中'),
        { timeout: 120000 }
      ).catch(() => {});

      // 额外等待 3 秒确保最终内容渲染完成
      await page.waitForTimeout(3000);
      console.log('[文心一言] AI 回答完成（"回答中"提示消失）');
      return;
    } catch {
      // 降级
    }

    // 策略2：固定等待 30 秒
    console.log('[文心一言] 等待回答超时，固定等待30秒');
    await page.waitForTimeout(30000);
  }
}
