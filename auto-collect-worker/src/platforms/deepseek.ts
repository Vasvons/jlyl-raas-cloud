import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** DeepSeek 适配器
 *
 * 参考 auth helper 软件的查询脚本（完整流程）：
 * 1. navigate → https://chat.deepseek.com/
 * 2. wait_for_url → https://chat.deepseek.com/ (timeout=10000)   ← 等待URL稳定
 * 3. fill → ._24fad49 textarea (keyword)                          ← 直接fill，不需要点击入口
 * 4. click-class → //span[text()="深度思考"]/parent::div             ← 激活深度思考
 *    (期望class: f79352dc ds-toggle-button ds-toggle-button--m ds-toggle-button--selected)
 * 5. click-class → //span[text()="智能搜索"]/parent::div            ← 激活智能搜索（联网）
 *    (期望class: f79352dc ds-toggle-button ds-toggle-button--m)
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
 */
export class DeepSeekAdapter extends BasePlatformAdapter {
  platformName = 'DeepSeek';
  loginUrl = 'https://chat.deepseek.com/sign_in';
  // 使用根域名：auth helper 也是导航到根域名，然后 wait_for_url 等待URL稳定
  chatUrl = 'https://chat.deepseek.com/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 ._24fad49 textarea（CSS Module 哈希类名）
  // 注意：._24fad49 是构建时生成的哈希，可能随版本变化，用 div[class] textarea 兜底
  protected inputSelector = '._24fad49 textarea, div[class] textarea, textarea, #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  // 响应选择器：参考 auth helper 的 .ds-markdown
  protected responseSelector = '.ds-markdown, .ds-message--content, [class*="message--content"], [class*="response"], [class*="answer"]';
  // 停止按钮：参考 auth helper 的 //div[@class="ds-flex _0a3d93b"]
  protected stopButtonSelector = 'div.ds-flex._0a3d93b, .stop-button, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'sign_in';

  /** DeepSeek 导航后处理：
   *  参考 auth helper 的流程：
   *  1. 等待 URL 稳定（auth helper 用 wait_for_url 等待10秒）
   *  2. 激活"深度思考"模式（通过 XPath 点击 span 的父 div）
   *  3. 激活"智能搜索"模式（联网搜索，通过 XPath 点击 span 的父 div）
   *
   *  注意：auth helper 是在 fill 之后才切换模式，但我们放在 afterNavigate 中
   *  因为 baseAdapter 的流程是 afterNavigate → waitForSelector(input) → fill → Enter
   *  切换模式不会影响输入框的存在性，放在 afterNavigate 中更简洁
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 步骤1: 等待 URL 稳定（参考 auth helper 的 wait_for_url）
    // DeepSeek 是 React SPA，导航后 URL 可能需要几秒才稳定
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('sign_in')) {
      return; // 未登录，交给 checkLoginStatus 处理
    }

    console.log(`[DeepSeek] 导航后: URL=${currentUrl}, title=${await page.title().catch(() => '')}`);

    // 步骤2: 激活"深度思考"模式
    // 参考 auth helper: click-class //span[text()="深度思考"]/parent::div
    // 期望切换后 class 包含 ds-toggle-button--selected
    try {
      const deepThinkBtn = await page.$('xpath=//span[text()="深度思考"]/parent::div').catch(() => null);
      if (deepThinkBtn) {
        // 检查是否已激活
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
        } else {
          console.log('[DeepSeek] "深度思考"模式已激活');
        }
      } else {
        console.log('[DeepSeek] 未找到"深度思考"按钮');
      }
    } catch (e: any) {
      console.log(`[DeepSeek] 激活"深度思考"失败: ${e.message}`);
    }

    // 步骤3: 激活"智能搜索"模式（联网搜索）
    // 参考 auth helper: click-class //span[text()="智能搜索"]/parent::div
    // 期望切换后 class 包含 ds-toggle-button--selected
    try {
      const searchBtn = await page.$('xpath=//span[text()="智能搜索"]/parent::div').catch(() => null);
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
          console.log('[DeepSeek] 已激活"智能搜索"模式（联网搜索）');
        } else {
          console.log('[DeepSeek] "智能搜索"模式已激活');
        }
      } else {
        console.log('[DeepSeek] 未找到"智能搜索"按钮');
      }
    } catch (e: any) {
      console.log(`[DeepSeek] 激活"智能搜索"失败: ${e.message}`);
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    const url = await this.extractShareLinkFromDialog(
      page,
      '[class*="share"], button:has-text("分享"), [data-testid*="share"], [aria-label*="分享"]',
      '[class*="dialog"], [class*="modal"], [class*="share-dialog"], [class*="share-modal"], [role="dialog"], [class*="popup"]'
    );
    return url || this.getCurrentPageShareUrl(page);
  }
}
