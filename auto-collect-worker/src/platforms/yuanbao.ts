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
    // 腾讯元宝分享链接策略：
    // 1. 点击分享按钮，从弹窗提取链接
    // 2. 如果都失败，返回 null，由云端生成静态页
    // 注意：不 fallback 到当前页面 URL，因为 /chat/{id} 是私有对话URL

    const shareBtnSelectors = [
      'button:has-text("分享")',
      'button:has-text("Share")',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
      '[class*="operation"] [class*="share"]',
      '[class*="action"] [class*="share"]',
      '[class*="message"] [class*="share"]',
      '[class*="bubble"] [class*="share"]',
    ];
    const dialogSelectors = [
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[class*="share-popup"]',
      '[class*="share-content"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];

    // 策略1: 点击分享按钮，从弹窗提取链接
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }

    // 策略2: 点击"复制链接"按钮后重新提取
    try {
      const copyBtn = await page.$('button:has-text("复制链接"), button:has-text("复制"), [class*="copy"]');
      if (copyBtn) {
        await copyBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
        for (const dlgSel of dialogSelectors) {
          const url = await this.extractShareLinkFromDialog(page, '[class*="share"]', dlgSel);
          if (url) return url;
        }
      }
    } catch {
      // 继续
    }

    // 不 fallback 到 getCurrentPageShareUrl：/chat/{id} 是私有对话URL
    return null;
  }
}
