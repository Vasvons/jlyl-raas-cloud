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
 * 之前内容长度只有3/12个字符的原因就是没激活联网模式
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

  /** 智谱AI导航后处理：
   *  1. 关闭可能的弹窗（"我知道了"按钮等）
   *  2. 点击"联网"按钮，确保AI会联网搜索（否则返回简短答案）
   *  3. 点击"推理"按钮（可能不存在，忽略错误）
   */
  protected async afterNavigate(page: Page): Promise<void> {
    await page.waitForTimeout(2000);

    // 步骤1: 关闭弹窗（参考 auth helper 的 //button[@class="close-btn"]）
    // 用 XPath 精确匹配（之前用 CSS selector 可能匹配不到）
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
      // 用 XPath 精确匹配 span 文本（与 auth helper 完全一致）
      const lianwangBtn = await page.$('xpath=//span[text()="联网"]').catch(() => null);
      if (lianwangBtn) {
        // 检查父元素是否已激活（避免重复点击取消激活）
        const isAlreadyActive = await page.evaluate(() => {
          const span = document.evaluate(
            '//span[text()="联网"]', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (!span) return false;
          // 检查父级元素的 class 是否包含 active/selected 等标识
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
    // 推理模式可能不存在，忽略错误
    try {
      const tuiliBtn = await page.$('xpath=//span[text()="推理"]').catch(() => null);
      if (tuiliBtn) {
        // 检查是否已激活
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
    // 智谱清言分享链接格式：https://chatglm.cn/share/{8位短码}
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
