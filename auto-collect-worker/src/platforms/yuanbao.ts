import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 腾讯元宝适配器 */
export class YuanbaoAdapter extends BasePlatformAdapter {
  platformName = '腾讯元宝';
  loginUrl = 'https://yuanbao.tencent.com/';
  chatUrl = 'https://yuanbao.tencent.com/chat/';
  // 腾讯元宝支持分享功能（长图分享 + 可能的链接分享）
  // 积极尝试点击分享按钮提取链接，失败才降级为静态页
  supportsShare = true;
  // 扩展选择器：覆盖腾讯元宝可能的页面改版
  protected inputSelector = 'textarea, .chat-input textarea, [class*="input-area"] textarea, div[contenteditable="true"], [role="textbox"]';
  protected responseSelector = '.agent-chat__msg__content, [class*="chat-content"], .markdown-body, [class*="response"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 腾讯元宝分享链接格式：https://yuanbao.tencent.com/s/{shareId}
    // 实地探查（2026-07-12）：分享按钮 id="shareButton" 或 data-id="shareButton"
    // 流程：hover 回答 → 点击分享按钮 → 分享菜单弹窗 → 复制链接

    // 步骤1: 注入 clipboard + execCommand 拦截
    await page.evaluate(() => {
      (window as any).__capturedShareUrl__ = null;
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        if (text && (text.includes('/s/') || text.includes('yuanbao.tencent.com'))) {
          (window as any).__capturedShareUrl__ = text;
        }
        return origWrite(text);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          if (selText.includes('/s/') || selText.includes('yuanbao.tencent.com')) {
            (window as any).__capturedShareUrl__ = selText;
          }
        }
        return origExec(cmd);
      };
    }).catch(() => {});

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    const answerSelectors = [
      '.agent-chat__msg__content',
      '[class*="chat-content"]',
      '.markdown-body',
      '[class*="response"]',
      '[class*="answer"]',
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
      '[data-id="shareButton"]',
      '#shareButton',
      'button:has-text("分享")',
      'button:has-text("Share")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
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
          console.log(`[腾讯元宝] 点击分享按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    if (!shareBtnClicked) {
      console.log('[腾讯元宝] 未找到分享按钮');
      return null;
    }

    // 步骤4: 查找并点击"复制链接"按钮
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      'button:has-text("Copy")',
      '[class*="copy-link"]',
      '[class*="copy"]',
    ];
    for (const sel of copyBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[腾讯元宝] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (capturedUrl) {
      const urlMatch = capturedUrl.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && (urlMatch[0].includes('/s/') || urlMatch[0].includes('yuanbao.tencent.com'))) {
        console.log(`[腾讯元宝] 从剪贴板拦截到分享链接: ${urlMatch[0]}`);
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
        if (inputUrl && (inputUrl.includes('/s/') || inputUrl.includes('yuanbao.tencent.com'))) {
          console.log(`[腾讯元宝] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(/https?:\/\/[^\s<>"']+\/s\/[^\s<>"']+/);
        if (urlMatch) {
          console.log(`[腾讯元宝] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[腾讯元宝] 未能提取到分享链接');
    return null;
  }
}
