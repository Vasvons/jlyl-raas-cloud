import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** Kimi 适配器 */
export class KimiAdapter extends BasePlatformAdapter {
  platformName = 'Kimi';
  loginUrl = 'https://www.kimi.com/login';
  // Kimi 域名已从 kimi.moonshot.cn 迁移到 www.kimi.com
  // 旧域名会被重定向到新域名根路径，导致重定向检测误判
  chatUrl = 'https://www.kimi.com/chat';
  supportsShare = true;
  protected inputSelector = 'textarea';
  protected responseSelector = '.chat-content-item-assistant, [class*="assistant"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // Kimi 分享链接格式：https://www.kimi.com/share/{shareId}
    // 实地探查（2026-07-12）：分享按钮在回答的操作栏中，需要 hover 才显示
    // 流程：hover 回答 → 操作栏出现 → 点击分享按钮 → 链接复制到剪贴板 或 弹窗显示

    // 步骤1: 注入 clipboard + execCommand 拦截
    await page.evaluate(() => {
      (window as any).__capturedShareUrl__ = null;
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && (text.includes('/share/') || text.includes('kimi.com'))) {
          (window as any).__capturedShareUrl__ = text;
        }
        return origWrite(text);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          if (selText.includes('/share/') || selText.includes('kimi.com')) {
            (window as any).__capturedShareUrl__ = selText;
          }
        }
        return origExec(cmd);
      };
    }).catch(() => {});

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    const answerSelectors = [
      '.chat-content-item-assistant',
      '[class*="assistant"]',
      '[class*="answer"]',
      '[class*="message-assistant"]',
      '[class*="bot-message"]',
      '[class*="response"]',
    ];

    let hovered = false;
    for (const sel of answerSelectors) {
      try {
        const elements = await page.$$(sel);
        // 找最后一个（最新的回答）
        for (let i = elements.length - 1; i >= 0; i--) {
          const visible = await elements[i].isVisible().catch(() => false);
          if (visible) {
            await elements[i].hover({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000); // 等待操作栏动画
            hovered = true;
            console.log(`[Kimi] hover 回答区域成功: ${sel} index=${i}`);
            break;
          }
        }
        if (hovered) break;
      } catch { /* 继续 */ }
    }

    // 步骤3: 查找并点击分享按钮
    const shareBtnSelectors = [
      'button:has-text("分享")',
      'button:has-text("分享对话")',
      '[aria-label*="分享"]',
      '[aria-label*="share"]',
      '[class*="share"]:not([class*="share-text"]):not([class*="shared"])',
      '[data-testid*="share"]',
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
          console.log(`[Kimi] 点击分享按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    if (!shareBtnClicked) {
      console.log('[Kimi] 未找到分享按钮');
      return null;
    }

    // 步骤4: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (capturedUrl) {
      const urlMatch = capturedUrl.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && urlMatch[0].includes('/share/')) {
        console.log(`[Kimi] 从剪贴板拦截到分享链接: ${urlMatch[0]}`);
        return urlMatch[0];
      }
    }

    // 步骤5: 兜底 — 从弹窗中提取
    const dialogSelectors = ['[role="dialog"]', '[class*="share-dialog"]', '[class*="share-modal"]', '[class*="modal"]', '[class*="popup"]'];
    for (const dlgSel of dialogSelectors) {
      try {
        const dlg = await page.$(dlgSel).catch(() => null);
        if (!dlg) continue;
        const visible = await dlg.isVisible().catch(() => false);
        if (!visible) continue;
        // input 中的 URL
        const inputUrl = await dlg.evaluate((node: HTMLElement) => {
          const input = node.querySelector('input');
          return input?.value || input?.textContent || '';
        }).catch(() => '');
        if (inputUrl && inputUrl.includes('/share/')) {
          console.log(`[Kimi] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }
        // 文本中的 URL
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(/https?:\/\/[^\s<>"']+\/share\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[Kimi] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[Kimi] 未能提取到分享链接');
    return null;
  }
}
