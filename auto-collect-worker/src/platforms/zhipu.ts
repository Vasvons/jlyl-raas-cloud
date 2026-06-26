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

  /** extractContent 不再覆盖，走 baseAdapter 的轮询+稳定检测+通用兜底
   * 之前的覆盖实现稳定检测阈值太低（4秒），且选择器优先级遍历可能匹配到小元素。
   * baseAdapter 的轮询逻辑（8秒稳定+通用兜底）更健壮。 */

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
    // 之前内容长度只有3/12个字符的原因就是没激活联网模式
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
          // 点击后重新检测是否真的激活了
          const isNowActive = await page.evaluate(() => {
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
          if (isNowActive) {
            console.log('[智谱AI] 已点击"联网"按钮并确认激活成功');
          } else {
            console.log('[智谱AI] 点击"联网"按钮后未检测到激活状态，可能需要二次点击');
            // 二次点击尝试
            await lianwangBtn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000);
            console.log('[智谱AI] 已二次点击"联网"按钮');
          }
        } else {
          console.log('[智谱AI] "联网"按钮已激活，无需重复点击');
        }
      } else {
        // 尝试更宽泛的查找：可能"联网"文字被包裹在其他元素中
        const altBtn = await page.$('xpath=//*[contains(text(),"联网") and not(contains(text(),"断开"))]').catch(() => null);
        if (altBtn) {
          console.log('[智谱AI] 主选择器未找到"联网"按钮，尝试宽泛查找并点击');
          await altBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1000);
        } else {
          console.log('[智谱AI] 警告: 未找到"联网"按钮，AI可能不会联网搜索，将返回简短答案');
        }
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
    // 智谱清言分享链接格式：https://chatglm.cn/share/{8位短码}
    // 必须通过点击分享按钮获取，当前对话 URL 是私有的，不 fallback
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
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
        // 智谱分享链接必须包含 /share/ 才是公开可访问的
        if (url && url.includes('/share/')) return url;
      }
    }
    // 不 fallback 到 getCurrentPageShareUrl：当前对话 URL 是私有的
    return null;
  }
}
