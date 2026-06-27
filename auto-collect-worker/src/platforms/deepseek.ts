import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';
import { QueryResult, randomDelay } from './base';
import { smartFindInputElement, smartFindClickableElement } from '../indexedInteractor';

/** DeepSeek 适配器
 *
 * 参考 auth helper 软件的查询脚本（完整流程）：
 * 1. navigate → https://chat.deepseek.com/
 * 2. wait_for_url → https://chat.deepseek.com/ (timeout=10000)   ← 等待URL稳定
 * 3. fill → ._24fad49 textarea (keyword)                          ← 直接fill，不需要点击入口
 * 4. click-class → //span[text()="深度思考"]/parent::div             ← 激活深度思考
 * 5. click-class → //span[text()="智能搜索"]/parent::div            ← 激活智能搜索（联网）
 * 6. fill → ._24fad49 textarea (keyword)                          ← 再次fill（切换模式后可能清空）
 * 7. key → Enter
 * 8. while → //div[@class="ds-flex _0a3d93b"] (is_exist=1)        ← 等待搜索按钮出现
 * 9. text → .ds-markdown
 *
 * 关键差异（与之前实现对比）：
 * - auth helper 直接 fill，不需要点击"新建对话"等入口按钮
 * - 输入框选择器是 CSS Module 哈希类名 ._24fad49 textarea
 * - 需要激活"深度思考"和"智能搜索"模式才会联网搜索
 * - 响应选择器是 .ds-markdown（不是 .ds-message--content）
 *
 * 重要：覆盖了 baseAdapter 的 query 方法，因为 ._24fad49 哈希类名不稳定，
 * 使用 Playwright locator API 的 auto-waiting 更稳健。
 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  // 输入框：保留兼容性，实际 query 方法中用 locator API
  protected inputSelector = 'textarea';
  // 响应选择器：参考 auth helper 的 .ds-markdown
  protected responseSelector = '.ds-markdown, .ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  // 停止按钮：参考 auth helper 的 //div[@class="ds-flex _0a3d93b"]
  protected stopButtonSelector = 'div.ds-flex._0a3d93b, .stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  /** 覆盖 query 方法：使用 Playwright locator API，避免 CSS Module 哈希类名不稳定问题 */
  async query(page: Page, keyword: string): Promise<QueryResult> {
    // 步骤1: 导航到根域名
    try {
      await page.goto(this.chatUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // 步骤2: 等待 URL 稳定（auth helper 用 wait_for_url 等待10秒）
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    if (currentUrl.includes('sign_in')) {
      throw new Error(`登录态失效: 页面被重定向到登录页 (URL=${currentUrl})`);
    }
    console.log(`[DeepSeek] 导航后: URL=${currentUrl}, title=${await page.title().catch(() => '')}`);

    // 步骤3: 查找输入框（使用 locator API + auto-waiting）
    // 不依赖 CSS Module 哈希类名，直接用 textarea 标签
    // DeepSeek 已登录状态下，页面上通常只有一个可见的 textarea
    const textareaLocator = page.locator('textarea').first();
    let inputFound = false;
    try {
      await textareaLocator.waitFor({ state: 'visible', timeout: 10000 });
      inputFound = true;
    } catch {
      // 第一个 textarea 不可见，尝试其他策略
      console.log('[DeepSeek] 第一个 textarea 不可见，尝试其他策略...');
    }

    if (!inputFound) {
      // 尝试 contenteditable div
      const editableLocator = page.locator('div[contenteditable="true"]').first();
      try {
        await editableLocator.waitFor({ state: 'visible', timeout: 5000 });
        inputFound = true;
        // 使用 contenteditable div 作为输入框
        await this.executeQueryWithEditable(page, keyword, editableLocator);
        return await this.extractResult(page);
      } catch {
        // 继续
      }
    }

    if (!inputFound) {
      // 第三轮兜底：用 indexedInteractor 的 smartFindInputElement 扫描页面所有可见可交互元素
      // 解决 DeepSeek 偶发 textarea 不可见但页面有其他可输入元素的问题
      console.log('[DeepSeek] locator 策略全部失败，启用 smartFindInputElement 兜底扫描...');
      try {
        const smartEl = await smartFindInputElement(page);
        if (smartEl) {
          console.log('[DeepSeek] smartFindInputElement 找到可输入元素，使用 click+type 输入');
          await this.activateModes(page);
          await smartEl.click({ timeout: 5000 }).catch(() => {});
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Delete');
          await page.keyboard.type(keyword, { delay: 50 });
          await randomDelay(500, 1500);
          await page.keyboard.press('Enter');
          return await this.extractResult(page);
        }
      } catch (e: any) {
        console.log(`[DeepSeek] smartFindInputElement 兜底失败: ${e.message}`);
      }
    }

    if (!inputFound) {
      const url = page.url();
      const title = await page.title().catch(() => '未知');
      throw new Error(`输入框未找到: textarea/contenteditable/smartFind 均失败 (URL=${url}, title=${title})`);
    }

    // 步骤4: 激活"深度思考"和"智能搜索"模式
    await this.activateModes(page);

    // 步骤5: 填入关键词（切换模式后可能清空，重新 fill）
    try {
      await textareaLocator.fill('');
      await textareaLocator.fill(keyword);
    } catch {
      // fill 失败时降级为 click + type
      console.log('[DeepSeek] fill 失败，降级为 click+type');
      await textareaLocator.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(keyword, { delay: 50 });
    }
    await randomDelay(500, 1500);

    // 步骤6: 按 Enter 提交
    await page.keyboard.press('Enter');

    return await this.extractResult(page);
  }

  /** 使用 contenteditable div 执行查询（备用路径） */
  private async executeQueryWithEditable(page: Page, keyword: string, editableLocator: any): Promise<void> {
    await this.activateModes(page);
    await editableLocator.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(keyword, { delay: 50 });
    await randomDelay(500, 1500);
    await page.keyboard.press('Enter');
  }

  /** 提取查询结果（等待响应 + 提取内容 + 提取分享链接） */
  private async extractResult(page: Page): Promise<QueryResult> {
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

  /** 激活"深度思考"和"智能搜索"模式 */
  private async activateModes(page: Page): Promise<void> {
    // 激活"深度思考"
    try {
      let deepThinkBtn = await page.$('xpath=//span[text()="深度思考"]/parent::div').catch(() => null);
      if (!deepThinkBtn) {
        // smartFind 兜底：按文本模糊查找
        deepThinkBtn = await smartFindClickableElement(page, '深度思考');
      }
      if (deepThinkBtn) {
        const isSelected = await page.evaluate(() => {
          const span = document.evaluate(
            '//span[text()="深度思考"]/parent::div', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (!span) return false;
          return (span.className || '').includes('ds-toggle-button--selected');
        }).catch(() => false);

        if (!isSelected) {
          await deepThinkBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          console.log('[DeepSeek] 已激活"深度思考"模式');
        }
      }
    } catch (e: any) {
      console.log(`[DeepSeek] 激活"深度思考"失败: ${e.message}`);
    }

    // 激活"智能搜索"（联网搜索）
    try {
      let searchBtn = await page.$('xpath=//span[text()="智能搜索"]/parent::div').catch(() => null);
      if (!searchBtn) {
        searchBtn = await smartFindClickableElement(page, '智能搜索');
      }
      if (searchBtn) {
        const isSelected = await page.evaluate(() => {
          const span = document.evaluate(
            '//span[text()="智能搜索"]/parent::div', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (!span) return false;
          return (span.className || '').includes('ds-toggle-button--selected');
        }).catch(() => false);

        if (!isSelected) {
          await searchBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          console.log('[DeepSeek] 已激活"智能搜索"模式');
        }
      }
    } catch (e: any) {
      console.log(`[DeepSeek] 激活"智能搜索"失败: ${e.message}`);
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // DeepSeek 分享链接格式：https://chat.deepseek.com/a/chat/s/{uuid}
    // 必须通过点击分享按钮获取，当前对话 URL 是私有的，不 fallback
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
      '[class*="icon-share"]',
    ];
    const dialogSelectors = [
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url && url.includes('/share/') || url?.includes('/s/')) return url;
      }
    }
    // 不 fallback 到 getCurrentPageShareUrl：当前对话 URL 是私有的，非登录用户看不到
    return null;
  }
}
