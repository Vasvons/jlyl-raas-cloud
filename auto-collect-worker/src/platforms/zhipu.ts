import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 智谱AI适配器
 *
 * 参考 auth helper 软件的查询脚本（完整流程）：
 * 1. navigate → https://chatglm.cn/
 * 2. click → //button[@class="close-btn"] (is_try=1, is_exist=1)   ← 关闭弹窗
 * 3. click → //span[text()="联网"]                                   ← 激活联网搜索
 * 4. click → //span[text()="推理"] (is_try=1, is_exist=1)           ← 推理模式可能不存在
 * 5. fill → .input-box-inner textarea
 * 6. key → Enter
 * 7. while → //div[@class="enter is-main-chat searching"] (is_exist=0)  ← 等待搜索完成
 * 8. text → .answer-content .flex1
 *
 * 关键：必须点击"联网"按钮，否则默认非联网模式，AI不搜索直接返回简短答案
 * 之前内容长度只有3/12个字符的原因是没激活联网模式
 *
 * 重要：覆盖了 extractContent 和 waitForResponse 方法
 * - extractContent: 使用更精确的选择器，避免匹配到侧边栏等小元素
 * - waitForResponse: 使用 XPath 定位停止按钮，与 auth helper 一致
 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  chatUrl = 'https://chatglm.cn/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 .input-box-inner textarea
  protected inputSelector = '.input-box-inner textarea, [class*="input-box"] textarea, textarea';
  // 响应选择器：参考 auth helper 的 .answer-content .flex1
  protected responseSelector = '.answer-content .flex1, .answer-content, [class*="answer-content"], .markdown-body';
  // 停止按钮：参考 auth helper 的 //div[@class="enter is-main-chat searching"]
  protected stopButtonSelector = 'div.enter.is-main-chat.searching, [class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  /** 覆盖 waitForResponse：使用 XPath 精确匹配停止按钮，与 auth helper 一致 */
  async waitForResponse(page: Page): Promise<void> {
    // auth helper 用 while 循环检查 //div[@class="enter is-main-chat searching"] 是否存在
    // 存在表示正在搜索，消失表示搜索完成
    const stopButtonXPath = '//div[contains(@class, "enter") and contains(@class, "searching")]';

    try {
      // 1. 等待停止按钮出现（表示 AI 开始搜索）
      await page.waitForSelector(`xpath=${stopButtonXPath}`, { timeout: 15000 });
      console.log('[智谱AI] 检测到搜索开始，等待完成...');

      // 2. 等待停止按钮消失（表示搜索完成）
      // 最多等待 180 秒（联网搜索+推理模式可能较慢）
      const maxWait = 180000;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWait) {
        const stillSearching = await page.$(`xpath=${stopButtonXPath}`).catch(() => null);
        if (!stillSearching) {
          console.log('[智谱AI] 搜索已完成');
          break;
        }
        await page.waitForTimeout(2000);
      }

      // 3. 额外等待 3 秒确保最终内容渲染完成
      await page.waitForTimeout(3000);
    } catch (e: any) {
      console.log(`[智谱AI] 停止按钮等待超时，额外等待15秒: ${e.message}`);
      await page.waitForTimeout(15000);
    }
  }

  /** 覆盖 extractContent：使用更精确的选择器，避免匹配到侧边栏等小元素
   * 关键：取最长的匹配元素（AI 回答通常是最长的内容块） */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 先滚动到页面底部，确保 AI 回答完整渲染
    await this.scrollToBottom(page);

    // 按优先级尝试多个选择器
    const selectors = [
      '.answer-content .flex1',           // auth helper 的选择器
      '.answer-content .markdown-body',   // markdown 渲染容器
      '[class*="answer-content"] [class*="markdown"]',
      '[class*="message-content"] [class*="markdown"]',
      '.markdown-body:not([class*="sidebar"]):not([class*="menu"])',
    ];

    let bestText = '';
    let bestHtml = '';

    for (const selector of selectors) {
      try {
        const elements = await page.$$(selector);
        if (elements.length === 0) continue;

        // 取所有匹配元素中最长的（避免匹配到侧边栏的小元素）
        for (const el of elements) {
          const text = (await el.textContent()) || '';
          const html = (await el.innerHTML()) || '';
          if (text.trim().length > bestText.trim().length) {
            bestText = text;
            bestHtml = html;
          }
        }
      } catch {
        // 继续
      }
    }

    if (bestText.trim().length > 0) {
      console.log(`[智谱AI] 提取内容成功: ${bestText.trim().length} 字符`);
      return { text: bestText.trim(), html: bestHtml };
    }

    // 兜底：用 XPath 查找最后一个 AI 回答容器
    try {
      const answerEl = await page.$('xpath=//div[contains(@class, "answer-content")][last()]').catch(() => null);
      if (answerEl) {
        const text = (await answerEl.textContent()) || '';
        const html = (await answerEl.innerHTML()) || '';
        if (text.trim().length > 0) {
          console.log(`[智谱AI] XPath 兜底提取成功: ${text.trim().length} 字符`);
          return { text: text.trim(), html };
        }
      }
    } catch {
      // 继续
    }

    console.log('[智谱AI] 未能提取到内容');
    return { text: '', html: '' };
  }

  /** 智谱AI导航后处理：
   *  1. 关闭可能的弹窗（"我知道了"按钮等）
   *  2. 点击"联网"按钮，确保AI会联网搜索（否则返回简短答案）
   *  3. 点击"推理"按钮（可能不存在，忽略错误）
   */
  protected async afterNavigate(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    // 步骤1: 关闭弹窗（参考 auth helper 的 //button[@class="close-btn"]）
    try {
      const closeBtn = await page.$('xpath=//button[@class="close-btn"]').catch(() => null);
      if (closeBtn) {
        await closeBtn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        console.log('[智谱AI] 已关闭弹窗');
      }
    } catch {
      // 继续
    }

    // 步骤2: 点击"联网"按钮（参考 auth helper 的 //span[text()="联网"]）
    // 关键：必须点击"联网"激活联网搜索模式，否则AI不搜索直接返回简短答案
    try {
      const lianwangBtn = await page.$('xpath=//span[text()="联网"]').catch(() => null);
      if (lianwangBtn) {
        const isAlreadyActive = await page.evaluate(() => {
          const span = document.evaluate(
            '//span[text()="联网"]', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (!span) return false;
          const parent = span.parentElement;
          if (!parent) return false;
          const cls = parent.className || '';
          return cls.includes('active') || cls.includes('selected') || cls.includes('checked');
        }).catch(() => false);

        if (!isAlreadyActive) {
          await lianwangBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1000);
          console.log('[智谱AI] 已点击"联网"按钮，激活联网搜索模式');
        } else {
          console.log('[智谱AI] "联网"按钮已激活，无需重复点击');
        }
      } else {
        console.log('[智谱AI] 未找到"联网"按钮（可能已激活或页面结构变化）');
      }
    } catch (e: any) {
      console.log(`[智谱AI] 点击"联网"按钮失败: ${e.message}`);
    }

    // 步骤3: 点击"推理"按钮（参考 auth helper 的 //span[text()="推理"]，is_try=1 可选）
    try {
      const tuiliBtn = await page.$('xpath=//span[text()="推理"]').catch(() => null);
      if (tuiliBtn) {
        const isAlreadyActive = await page.evaluate(() => {
          const span = document.evaluate(
            '//span[text()="推理"]', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (!span) return false;
          const parent = span.parentElement;
          if (!parent) return false;
          const cls = parent.className || '';
          return cls.includes('active') || cls.includes('selected') || cls.includes('checked');
        }).catch(() => false);

        if (!isAlreadyActive) {
          await tuiliBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          console.log('[智谱AI] 已点击"推理"按钮');
        }
      }
    } catch {
      // 推理按钮可选，忽略错误
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    const shareBtnSelectors = [
      '[class*="share"]', '[class*="Share"]',
      'button:has-text("分享")', 'button:has-text("Share")',
      '[data-testid*="share"]', '[aria-label*="分享"]',
    ];
    const dialogSelectors = [
      '[class*="dialog"]', '[class*="modal"]', '[class*="share-dialog"]',
      '[class*="share-modal"]', '[role="dialog"]', '[class*="popup"]',
    ];
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }
    return this.getCurrentPageShareUrl(page);
  }
}
