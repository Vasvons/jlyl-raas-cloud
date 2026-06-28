import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';
import { smartFindLongestContent } from '../indexedInteractor';

/** 纳米搜索适配器
 *
 * 纳米搜索（n.cn）是 360 出品的 AI 搜索引擎，返回搜索结果 + AI 总结
 *
 * v1.4.4 修复"内容只有 139 字符"问题：
 *   之前 bug：responseSelector 用模糊的 [class*="answer"] 匹配到侧边栏简短摘要
 *   修复策略：重写 extractContent，用多策略精确提取 AI 总结正文
 *   1. 优先匹配 .answer-content / .ai-summary 等明确容器
 *   2. 兜底用 smartFindLongestContent 找最长文本块
 *   3. 限制最少 200 字符，过短则继续等待或走兜底
 *
 * 纳米不支持分享，shareUrl 返回 null，由云端生成静态页
 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  supportsShare = false;
  protected inputSelector = 'textarea, input[type="text"]';
  // 保留选择器用于 waitForSelector，实际提取在 extractContent 中重写
  protected responseSelector = '.answer-content, .ai-summary, .result-content, .summary-content, .ai-answer, .bot-answer, .reply-content, [class*="ai-summary"], [class*="answer-content"], [class*="summary-content"], [class*="ai-answer"], [class*="bot-answer"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  /**
   * 重写 extractContent：精确提取纳米 AI 总结正文
   *
   * 纳米页面结构：
   *   - 顶部：搜索结果列表（简短摘要，每个 ~100-200 字符）
   *   - 中部：AI 总结（完整回答，通常 500+ 字符）
   *   - 侧边栏：相关问题、推荐等
   *
   * 之前 bug：[class*="answer"] 匹配到顶部简短摘要，导致只提取 139 字符
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载
    await this.scrollToBottom(page);

    // 策略1：优先匹配明确的 AI 总结容器
    const preciseSelectors = [
      '.answer-content',
      '.ai-summary',
      '.result-content',
      '.summary-content',
      '.ai-answer',
      '.bot-answer',
      '.reply-content',
      '[class*="ai-summary"]',
      '[class*="answer-content"]',
      '[class*="summary-content"]',
      '[class*="ai-answer"]',
      '[class*="bot-answer"]',
    ];

    for (const sel of preciseSelectors) {
      try {
        const elements = await page.$$(sel);
        // 从后往前找（最新的回答通常在后面）
        for (let i = elements.length - 1; i >= 0; i--) {
          const text = (await elements[i].textContent()) || '';
          if (text.trim().length > 200) {
            // 找到足够长的内容，清理 HTML 后返回
            const cleanedHtml = await elements[i].evaluate((node: HTMLElement) => {
              const clone = node.cloneNode(true) as HTMLElement;
              const removeSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
                'img', 'video', 'audio', 'button', 'input', 'textarea',
                '.btn', '.button', '.toolbar', '.menu', '.sidebar',
                '[class*="btn"]', '[class*="button"]', '[class*="toolbar"]',
                '[class*="menu"]', '[class*="sidebar"]', '[class*="nav"]',
                '[role="button"]', '[aria-hidden="true"]',
              ];
              for (const r of removeSelectors) {
                clone.querySelectorAll(r).forEach(e => e.remove());
              }
              return clone.innerHTML;
            }).catch(() => '');
            console.log(`[纳米] 精确选择器 ${sel} 提取成功: ${text.trim().length} 字符`);
            return { text: text.trim(), html: cleanedHtml || `<div>${text.trim()}</div>` };
          }
        }
      } catch {}
    }

    // 策略2：用 smartFindLongestContent 找最长文本块（兜底）
    try {
      const smart = await smartFindLongestContent(page, 200);
      if (smart && smart.text.length > 200) {
        console.log(`[纳米] smartFindLongestContent 兜底提取: ${smart.text.length} 字符`);
        return smart;
      }
    } catch (e: any) {
      console.log(`[纳米] smartFindLongestContent 失败: ${e.message}`);
    }

    // 策略3：最终降级，取 body 文本
    try {
      const text = await page.evaluate(() => document.body.textContent || '');
      if (text.trim().length > 0) {
        console.log(`[纳米] body.textContent 兜底: ${text.trim().length} 字符`);
        return { text: text.trim(), html: `<div>${text.trim()}</div>` };
      }
    } catch {}

    return { text: '', html: '' };
  }
}
