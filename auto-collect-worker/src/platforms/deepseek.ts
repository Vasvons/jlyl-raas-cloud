import { Page } from 'playwright';
import { PlatformAdapter, PlatformCredentials, QueryResult } from './base';

export class DeepSeekAdapter extends PlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;

  async login(page: Page, credentials: PlatformCredentials): Promise<boolean> {
    await page.goto(this.loginUrl, { waitUntil: 'networkidle' });
    // TODO: 实现具体登录逻辑，需要根据DeepSeek实际页面结构调整
    return await this.checkLoginStatus(page);
  }

  async checkLoginStatus(page: Page): Promise<boolean> {
    await page.goto(this.chatUrl, { waitUntil: 'networkidle' });
    return !page.url().includes('sign_in');
  }

  async query(page: Page, keyword: string): Promise<QueryResult> {
    await page.goto(this.chatUrl, { waitUntil: 'networkidle' });
    const inputSelector = 'textarea';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.fill(inputSelector, keyword);
    await page.press(inputSelector, 'Enter');
    await this.waitForResponse(page);
    const { text, html } = await this.extractContent(page);
    const shareUrl = await this.extractShareLink(page);
    return {
      content: text,
      shareUrl,
      htmlContent: html,
      supportsShare: this.supportsShare
    };
  }

  async extractShareLink(page: Page): Promise<string | null> {
    try {
      // TODO: 根据DeepSeek实际页面结构调整
      return null;
    } catch (e) {
      console.error('[DeepSeek] 提取分享链接失败:', e);
      return null;
    }
  }

  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // TODO: 调整为实际选择器
    const responseSelector = '.ds-message--content';
    await page.waitForSelector(responseSelector, { timeout: 30000 });
    const text = await page.textContent(responseSelector) || '';
    const html = await page.innerHTML(responseSelector) || '';
    return { text: text.trim(), html };
  }

  async waitForResponse(page: Page): Promise<void> {
    try {
      await page.waitForSelector('.stop-button', { state: 'detached', timeout: 60000 });
    } catch (e) {}
  }
}
