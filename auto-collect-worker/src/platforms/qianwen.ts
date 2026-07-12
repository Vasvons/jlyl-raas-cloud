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
    await this.injectClipboardInterceptor(page, ['/share/', 'qianwen.com']);

    // 步骤2: hover 在 AI 回答区域上，触发 share-selection 按钮显示
    const answerSelectors = [
      '.answer-area',
      '.markdown-body',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="message-content"]',
      // 兜底
      'main', '[class*="chat"]', '[class*="conversation"]',
    ];

    for (const sel of answerSelectors) {
      try {
        const elements = await page.$$(sel);
        for (let i = elements.length - 1; i >= 0; i--) {
          const visible = await elements[i].isVisible().catch(() => false);
          if (visible) {
            await elements[i].hover({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1500);
            break;
          }
        }
      } catch { /* 继续 */ }
    }

    // 步骤3: 健壮地查找并点击分享按钮
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      '[class*="share-selection"]',
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
      '[class*="icon-share"]',
      '[class*="share"]:not([class*="shared"])',
    ], ['分享', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：hover 所有消息后重新扫描
      console.log('[通义千问] 首次扫描未找到分享按钮，尝试 hover 所有消息后重新扫描...');
      const allMessages = await page.$$('[class*="message"], [class*="answer"], [class*="response"]');
      for (let i = allMessages.length - 1; i >= 0; i--) {
        try {
          const visible = await allMessages[i].isVisible().catch(() => false);
          if (!visible) continue;
          await allMessages[i].hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(800);
          const clicked = await this.findAndClickShareButton(page, [], ['分享', 'Share', 'share']);
          if (clicked) break;
        } catch { /* 继续 */ }
      }
      const captured = await this.getCapturedShareUrl(page, '/share/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
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
    const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
    if (capturedUrl) {
      console.log(`[通义千问] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
    if (dialogUrl) return dialogUrl;

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
