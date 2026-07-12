import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 豆包适配器
 *
 * 参考 auth helper 软件的查询脚本：
 * - 输入框：textarea.semi-input-textarea 或 textarea[data-testid="chat_input_input"]
 * - 发送按钮：div.send-btn-wrapper button（需要点击发送，而非按Enter）
 * - 停止按钮：div[class*="break-btn"]（圆形break按钮）
 */
export class DoubaoAdapter extends BasePlatformAdapter {
  platformName = '豆包';
  loginUrl = 'https://www.doubao.com/';
  chatUrl = 'https://www.doubao.com/chat/';
  supportsShare = true;
  // 输入框：参考 auth helper 的 XPath
  protected inputSelector = 'textarea.semi-input-textarea, textarea[data-testid="chat_input_input"], [data-testid="chat_input"] textarea, [class*="chat-input"] textarea, [class*="input-area"] textarea, textarea';
  // 响应选择器：豆包的消息内容容器
  // 历史问题：[data-testid="message_text_content"] 偶发匹配不到，走兜底被截断到 10000
  // 改进：覆盖更多选择器，加上 [class*="flow-markdown"] 和 div[data-testid] 的通用匹配
  // 如果都匹配不到，baseAdapter 的兜底会用 smartFindLongestContent 找最长文本
  protected responseSelector = '[class*="receive-message"], [class*="message-content"], [class*="message_text"], [data-testid="message_text_content"], [class*="answer"], [class*="bubble-content"], [class*="chat-content"], [class*="flow-markdown"], [class*="markdown-body"], [class*="render-content"], div[class*="content-wrapper"]';
  // 停止按钮：参考 auth helper 的 div[class*="break-btn"]
  protected stopButtonSelector = '[class*="break-btn"], [data-testid="stop_button"], .stop-btn, [class*="stop"], [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 豆包分享链接格式：https://www.doubao.com/share/{token}
    // 实地探查（2026-07-12）：分享是会话级别（非单条消息），在回答操作栏或会话菜单中
    // 流程：hover 回答/会话 → 操作栏出现 → 点击分享按钮 → 弹窗 → 复制链接

    // 步骤1: 注入 clipboard + execCommand 拦截
    await page.evaluate(() => {
      (window as any).__capturedShareUrl__ = null;
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && (text.includes('/share/') || text.includes('doubao.com'))) {
          (window as any).__capturedShareUrl__ = text;
        }
        return origWrite(text);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          if (selText.includes('/share/') || selText.includes('doubao.com')) {
            (window as any).__capturedShareUrl__ = selText;
          }
        }
        return origExec(cmd);
      };
    }).catch(() => {});

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    const answerSelectors = [
      '[class*="receive-message"]',
      '[class*="message-content"]',
      '[class*="answer"]',
      '[class*="bubble-content"]',
      '[class*="flow-markdown"]',
    ];

    for (const sel of answerSelectors) {
      try {
        const elements = await page.$$(sel);
        for (let i = elements.length - 1; i >= 0; i--) {
          const visible = await elements[i].isVisible().catch(() => false);
          if (visible) {
            await elements[i].hover({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch { /* 继续 */ }
    }

    // 步骤3: 查找并点击分享按钮
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
      '[class*="share"]:not([class*="shared"])',
      '[class*="share-conversation"]',
    ];

    let shareBtnClicked = false;
    for (const sel of shareBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500);
          shareBtnClicked = true;
          console.log(`[豆包] 点击分享按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    if (!shareBtnClicked) {
      console.log('[豆包] 未找到分享按钮');
      return null;
    }

    // 步骤4: 查找并点击"复制链接"按钮（如果有）
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      'button:has-text("Copy")',
      '[class*="copy-link"]',
    ];
    for (const sel of copyBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[豆包] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (capturedUrl) {
      const urlMatch = capturedUrl.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && (urlMatch[0].includes('/share/') || urlMatch[0].includes('doubao.com'))) {
        console.log(`[豆包] 从剪贴板拦截到分享链接: ${urlMatch[0]}`);
        return urlMatch[0];
      }
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogSelectors = ['[role="dialog"]', '[class*="share-dialog"]', '[class*="share-modal"]', '[class*="modal"]', '[class*="popup"]'];
    for (const dlgSel of dialogSelectors) {
      try {
        const dlg = await page.$(dlgSel).catch(() => null);
        if (!dlg) continue;
        const visible = await dlg.isVisible().catch(() => false);
        if (!visible) continue;
        const inputUrl = await dlg.evaluate((node: HTMLElement) => {
          const input = node.querySelector('input');
          return input?.value || input?.textContent || '';
        }).catch(() => '');
        if (inputUrl && (inputUrl.includes('/share/') || inputUrl.includes('doubao.com'))) {
          console.log(`[豆包] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(/https?:\/\/[^\s<>"']+\/share\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[豆包] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[豆包] 未能提取到分享链接');
    return null;
  }
}
