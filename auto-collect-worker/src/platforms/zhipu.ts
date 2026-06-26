import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 智谱AI适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - URL：https://chatglm.cn/（根域名）
 * - 流程：navigate → 关闭弹窗(close-btn) → 点击"联网" → fill textarea → Enter → 等待停止按钮消失 → 提取内容
 * - 输入框：.input-box-inner textarea
 * - 响应选择器：.answer-content .flex1
 * - 停止按钮：div.enter.is-main-chat.searching
 *
 * 关键：必须点击"联网"按钮，否则默认非联网模式，AI不搜索直接返回简短答案
 * （这就是之前内容长度只有12个字符的原因）
 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  chatUrl = 'https://chatglm.cn/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 .input-box-inner textarea
  protected inputSelector = '.input-box-inner textarea, textarea, [class*="input-box"] textarea, [class*="chat-input"] textarea';
  // 响应选择器：参考 auth helper 的 .answer-content .flex1
  // 必须用 .answer-content .flex1 优先匹配（容器元素文本可能很短）
  protected responseSelector = '.answer-content .flex1, .answer-content, [class*="answer-content"], .markdown-body';
  // 停止按钮：参考 auth helper 的 div.enter.is-main-chat.searching
  protected stopButtonSelector = 'div.enter.is-main-chat.searching, [class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  /** 智谱AI导航后处理：
   *  1. 关闭可能的弹窗（"我知道了"按钮等）
   *  2. 点击"联网"按钮，确保AI会联网搜索（否则返回简短答案）
   */
  protected async afterNavigate(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    // 步骤1: 关闭弹窗（参考 auth helper 的 //button[@class="close-btn"]）
    try {
      const closeBtn = await page.$('button.close-btn, [class*="close-btn"], [aria-label*="关闭"]');
      if (closeBtn) {
        await closeBtn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {
      // 继续
    }

    // 步骤2: 点击"联网"按钮（参考 auth helper 的 //span[text()="联网"]）
    // 这是关键步骤！默认是非联网模式，AI不搜索直接返回简短答案
    try {
      // 查找包含"联网"文本的可点击元素
      const clicked = await page.evaluate(() => {
        // 优先匹配 span 元素（auth helper 用的是 //span[text()="联网"]）
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          if (span.textContent?.trim() === '联网') {
            // 检查是否已经激活（有些平台激活后会有特殊样式）
            const parent = span.closest('button, [role="button"], [class*="mode"], [class*="tab"]');
            if (parent) {
              // 检查是否已激活（避免重复点击取消激活）
              const classList = parent.className || '';
              const isSelected = classList.includes('active') ||
                                classList.includes('selected') ||
                                classList.includes('checked');
              if (isSelected) return { clicked: false, reason: 'already_active' };
            }
            (span as HTMLElement).click();
            return { clicked: true, reason: 'span' };
          }
        }
        // 退而求其次：查找包含"联网"的按钮
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of buttons) {
          if (btn.textContent?.trim() === '联网' || btn.textContent?.includes('联网')) {
            (btn as HTMLElement).click();
            return { clicked: true, reason: 'button' };
          }
        }
        return { clicked: false, reason: 'not_found' };
      }).catch(() => ({ clicked: false, reason: 'evaluate_failed' }));

      if (clicked && (clicked as any).clicked) {
        console.log(`[智谱AI] 已点击"联网"按钮 (${(clicked as any).reason})`);
        await page.waitForTimeout(1000);
      } else {
        console.log(`[智谱AI] 未找到"联网"按钮或已激活 (${(clicked as any)?.reason})`);
      }
    } catch (e: any) {
      console.log(`[智谱AI] 点击"联网"按钮失败: ${e.message}`);
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 智谱清言分享链接格式：https://chatglm.cn/share/{8位短码}
    // 策略1: 点击分享按钮，从弹窗提取链接
    const shareBtnSelectors = [
      '[class*="share"]',
      '[class*="Share"]',
      'button:has-text("分享")',
      'button:has-text("Share")',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
      '[class*="operation"] [class*="share"]',
      '[class*="action"] [class*="share"]',
      // 智谱可能在消息气泡上有分享图标
      '[class*="message"] [class*="share"]',
      '[class*="bubble"] [class*="share"]',
    ];
    const dialogSelectors = [
      '[class*="dialog"]',
      '[class*="modal"]',
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="share-popup"]',
      '[class*="share-content"]',
    ];

    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }

    // 策略2: 点击分享按钮后，可能弹出"复制链接"按钮，点击后再从URL提取
    try {
      const copyBtn = await page.$('button:has-text("复制链接"), button:has-text("复制"), [class*="copy"]');
      if (copyBtn) {
        await copyBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch {
      // 继续
    }

    // 策略3: 从当前页面URL提取 /share/{短码} 格式
    const currentUrl = await this.getCurrentPageShareUrl(page);
    if (currentUrl) return currentUrl;

    return null;
  }
}
