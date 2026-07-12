import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 通义千问适配器 */
export class QianwenAdapter extends BasePlatformAdapter {
  platformName = '通义千问';
  loginUrl = 'https://www.qianwen.com';
  chatUrl = 'https://www.qianwen.com/chat';
  supportsShare = true;
  protected inputSelector = 'textarea, [contenteditable="true"], #chat-input, [class*="chat-input"] textarea, [class*="input-area"] textarea';
  protected responseSelector = '.answer-area, .markdown-body, [class*="answer"], [class*="response"], [class*="message-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  /**
   * 通义千问分享链接提取
   *
   * 实地探查（2026-07-12）：
   *   - 分享按钮：.share-selection-NEsSb3（hover 显示，默认 display:none）
   *   - 分享链接格式：https://www.qianwen.com/share/chat/{share_id}
   *   - 分享流程：hover 回答 → 点击 share-selection → 多选模式 → 点底部"分享"按钮 → 链接复制到剪贴板
   *   - Toast 提示："对话链接已复制至粘贴板"
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 clipboard + execCommand 拦截
    await page.evaluate(() => {
      (window as any).__capturedShareUrl__ = null;
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && (text.includes('/share/') || text.includes('qianwen.com'))) {
          (window as any).__capturedShareUrl__ = text;
        }
        return origWrite(text);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          if (selText.includes('/share/') || selText.includes('qianwen.com')) {
            (window as any).__capturedShareUrl__ = selText;
          }
        }
        return origExec(cmd);
      };
    }).catch(() => {});

    // 步骤2: hover 在 AI 回答区域上，触发 share-selection 按钮显示
    const answerSelectors = [
      '.answer-area',
      '.markdown-body',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="message-content"]',
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

    // 步骤3: 查找并点击分享按钮（hover 后显示的 share-selection 或分享图标）
    const shareBtnSelectors = [
      '[class*="share-selection"]',
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
      '[class*="icon-share"]',
      '[class*="share"]:not([class*="shared"])',
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
          console.log(`[通义千问] 点击分享按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    if (!shareBtnClicked) {
      console.log('[通义千问] 未找到分享按钮');
      return null;
    }

    // 步骤4: 如果进入了多选模式，查找底部"分享"按钮
    const confirmBtnSelectors = [
      'button:has-text("分享")',
      'button:has-text("确认分享")',
      'button:has-text("生成链接")',
      'button:has-text("复制链接")',
      '[class*="share-confirm"]',
    ];
    for (const sel of confirmBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[通义千问] 点击确认分享按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (capturedUrl) {
      const urlMatch = capturedUrl.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && (urlMatch[0].includes('/share/') || urlMatch[0].includes('qianwen.com'))) {
        console.log(`[通义千问] 从剪贴板拦截到分享链接: ${urlMatch[0]}`);
        return urlMatch[0];
      }
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogSelectors = ['[role="dialog"]', '[class*="share-dialog"]', '[class*="modal"]', '[class*="popup"]'];
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
        if (inputUrl && (inputUrl.includes('/share/') || inputUrl.includes('qianwen.com'))) {
          console.log(`[通义千问] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(/https?:\/\/[^\s<>"']+\/share\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[通义千问] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }

    // 步骤7: 兜底 — 从页面 URL 提取 shareId
    try {
      const currentUrl = page.url();
      const shareIdMatch = currentUrl.match(/[?&]shareId=([a-zA-Z0-9-]{8,})/);
      if (shareIdMatch) {
        return `https://www.qianwen.com/share/chat/${shareIdMatch[1]}`;
      }
    } catch {}

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[通义千问] 未能提取到分享链接');
    return null;
  }
}
