import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';
import { smartFindClickableElement, smartFindLongestContent } from '../indexedInteractor';

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
      // 内容过短检测：如果提取到的内容 < 50 字符，可能是 loading 占位符或未激活联网的简短回答
      // 历史问题：未激活联网时 AI 返回的内容长度只有 3 字符
      if (bestText.trim().length < 50) {
        console.log(`[智谱AI] 提取内容过短 (${bestText.trim().length} 字符)，启用 smartFindLongestContent 兜底扫描...`);
        const smartResult = await smartFindLongestContent(page, 50);
        if (smartResult && smartResult.text.length > bestText.trim().length) {
          console.log(`[智谱AI] smartFindLongestContent 兜底成功: ${smartResult.text.length} 字符`);
          return { text: smartResult.text, html: smartResult.html };
        }
        // smartFind 也找不到更长内容，返回原内容（可能是 AI 真的返回简短答案）
        console.log(`[智谱AI] smartFindLongestContent 未找到更长内容，返回原内容 (${bestText.trim().length} 字符)`);
      }
      console.log(`[智谱AI] 提取内容成功: ${bestText.trim().length} 字符`);
      return { text: bestText.trim(), html: bestHtml };
    }

    // 兜底1：用 XPath 查找最后一个 AI 回答容器
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

    // 兜底2：smartFindLongestContent 扫描页面所有长文本元素
    try {
      const smartResult = await smartFindLongestContent(page, 50);
      if (smartResult) {
        console.log(`[智谱AI] smartFindLongestContent 兜底成功: ${smartResult.text.length} 字符`);
        return { text: smartResult.text, html: smartResult.html };
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
    // 历史问题：未激活联网时 AI 返回的内容长度只有 3-97 字符
    // 改进：最多重试 3 次，每次失败换不同的查找/点击策略
    let lianwangActivated = false;
    for (let attempt = 1; attempt <= 3 && !lianwangActivated; attempt++) {
      try {
        console.log(`[智谱AI] 第 ${attempt} 次尝试激活"联网"模式...`);

        // 检查当前是否已激活
        const isAlreadyActive = await page.evaluate(() => {
          // 优先用 XPath
          const span = document.evaluate(
            '//span[text()="联网"]', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue as HTMLElement | null;
          if (span) {
            const parent = span.parentElement;
            if (parent) {
              const cls = parent.className || '';
              if (cls.includes('active') || cls.includes('selected') || cls.includes('checked')) {
                return true;
              }
            }
          }
          // 兜底：找所有含"联网"文本的元素，检查其父级 class
          const allSpans = Array.from(document.querySelectorAll('span, div, button'));
          for (const el of allSpans) {
            if ((el.textContent || '').trim() === '联网') {
              const parent = el.parentElement;
              if (parent) {
                const cls = parent.className || '';
                if (cls.includes('active') || cls.includes('selected') || cls.includes('checked')) {
                  return true;
                }
              }
            }
          }
          return false;
        }).catch(() => false);

        if (isAlreadyActive) {
          console.log('[智谱AI] "联网"已激活，无需重复点击');
          lianwangActivated = true;
          break;
        }

        // 策略1（attempt=1）：XPath 精确匹配
        // 策略2（attempt=2）：smartFindClickableElement 模糊匹配
        // 策略3（attempt=3）：evaluate 直接 click + pointerdown 事件
        let btn: any = null;
        if (attempt === 1) {
          btn = await page.$('xpath=//span[text()="联网"]').catch(() => null);
          if (!btn) {
            btn = await page.$('xpath=//*[text()="联网"]').catch(() => null);
          }
        } else if (attempt === 2) {
          btn = await smartFindClickableElement(page, '联网');
        } else {
          // 策略3：evaluate 直接查找并点击
          const clicked = await page.evaluate(() => {
            const candidates = [
              'span', 'div', 'button', '[role="button"]', '[role="switch"]',
            ];
            for (const tag of candidates) {
              const els = Array.from(document.querySelectorAll(tag));
              for (const el of els) {
                if ((el.textContent || '').trim() === '联网') {
                  (el as HTMLElement).click();
                  // 同时派发 pointerdown/mousedown 事件，覆盖 React onClick 监听
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                  return true;
                }
              }
            }
            return false;
          }).catch(() => false);
          if (clicked) {
            await page.waitForTimeout(1500);
            // 验证激活状态
            const active = await page.evaluate(() => {
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
            if (active) {
              lianwangActivated = true;
              console.log('[智谱AI] evaluate 直接点击成功，已激活联网模式');
            } else {
              console.log('[智谱AI] evaluate 点击了但未检测到激活');
            }
            continue;
          }
        }

        if (btn) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500);
          // 验证激活状态
          const nowActive = await page.evaluate(() => {
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
          if (nowActive) {
            lianwangActivated = true;
            console.log(`[智谱AI] 第 ${attempt} 次尝试成功，已激活联网模式`);
          } else {
            console.log(`[智谱AI] 第 ${attempt} 次点击后未检测到激活状态`);
          }
        } else {
          console.log(`[智谱AI] 第 ${attempt} 次尝试未找到"联网"按钮`);
        }
      } catch (e: any) {
        console.log(`[智谱AI] 第 ${attempt} 次激活联网失败: ${e.message}`);
      }
    }

    if (!lianwangActivated) {
      console.log('[智谱AI] ⚠️ 3 次尝试均未激活联网模式，AI 可能返回简短答案');
    }

    // 步骤3: 点击"推理"按钮（参考 auth helper 的 //span[text()="推理"]，is_try=1 可选）
    try {
      let tuiliBtn = await page.$('xpath=//span[text()="推理"]').catch(() => null);
      if (!tuiliBtn) {
        tuiliBtn = await smartFindClickableElement(page, '推理');
      }
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
