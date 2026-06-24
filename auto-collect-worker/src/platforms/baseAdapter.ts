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
      // 区分"页面崩溃/浏览器异常"和"真正登录失效"
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
      // 其他异常（如导航超时）保留原逻辑，返回 false
      return false;
    }
  }

  async query(page: Page, keyword: string): Promise<QueryResult> {
    // 导航到聊天页（新对话）
    await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000); // 等待页面渲染完成

    // 等待输入框出现（增加超时到20秒，兼容慢加载页面）
    let activeSelector = this.inputSelector;
    let inputFound = false;
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 20000, state: 'visible' });
      inputFound = true;
    } catch {
      // 主选择器超时，尝试通用回退选择器
      const fallbackSelectors = [
        'textarea',
        'div[contenteditable="true"]',
        '#chat-input',
        '.chat-input',
        '[class*="chat-input"]',
        '[class*="input-area"] textarea',
        '[role="textbox"]',
      ];
      for (const fallback of fallbackSelectors) {
        if (fallback === this.inputSelector) continue; // 跳过已尝试的主选择器
        try {
          await page.waitForSelector(fallback, { timeout: 5000, state: 'visible' });
          activeSelector = fallback;
          inputFound = true;
          console.log(`[${this.platformName}] 主选择器超时，使用回退选择器: ${fallback}`);
          break;
        } catch {
          // 继续尝试下一个
        }
      }
    }

    if (!inputFound) {
      throw new Error(`输入框未找到: 主选择器(${this.inputSelector})及所有回退选择器均超时`);
    }

    // 清空输入框并填入关键词
    await page.fill(activeSelector, '');
    await page.fill(activeSelector, keyword);
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

  async extractShareLink(page: Page): Promise<string | null> {
    // 默认实现：尝试查找分享按钮并点击获取链接
    // 子类可覆盖实现具体逻辑
    try {
      return null;
    } catch {
      return null;
    }
  }

  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    if (!this.responseSelector) {
      // 无选择器时，尝试获取页面上最后一段长文本
      const text = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('div, section, article'));
        let lastLongText = '';
        for (const el of elements) {
          const t = el.textContent || '';
          if (t.length > lastLongText.length) lastLongText = t;
        }
        return lastLongText.trim();
      });
      return { text, html: `<div>${text}</div>` };
    }
    
    try {
      await page.waitForSelector(this.responseSelector, { timeout: 30000 });
      // 取最后一个匹配的元素（最新的回答）
      const elements = await page.$$(this.responseSelector);
      const lastEl = elements[elements.length - 1];
      if (lastEl) {
        const text = await lastEl.textContent() || '';
        const html = await lastEl.innerHTML() || '';
        return { text: text.trim(), html };
      }
    } catch (e) {
      console.error(`[${this.platformName}] 提取内容失败:`, (e as Error).message);
    }
    return { text: '', html: '' };
  }

  async waitForResponse(page: Page): Promise<void> {
    // 等待停止按钮出现后再消失（表示回答完成）
    if (this.stopButtonSelector) {
      try {
        await page.waitForSelector(this.stopButtonSelector, { timeout: 5000 });
        await page.waitForSelector(this.stopButtonSelector, { state: 'detached', timeout: 90000 });
      } catch {
        // 超时或按钮未出现，继续
      }
    } else {
      // 无停止按钮选择器时，等待固定时间
      await page.waitForTimeout(15000);
    }
  }
}
