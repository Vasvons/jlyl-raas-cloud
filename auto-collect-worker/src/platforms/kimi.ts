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
  // Kimi 的回答容器：message-content 是回答正文，toolbar 是操作栏
  protected responseSelector = '.chat-content-item-assistant, [class*="message-content"], [class*="assistant"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // Kimi 分享链接格式：https://www.kimi.com/share/{shareId}
    // 实地探查（2026-07-12）：分享按钮在回答的操作栏中，需要 hover 才显示
    // 流程：hover 回答 → 操作栏出现 → 点击分享按钮 → 链接复制到剪贴板 或 弹窗显示

    // 步骤1: 注入 clipboard + execCommand 拦截
    await this.injectClipboardInterceptor(page, ['/share/', 'kimi.com']);

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    // Kimi 的操作栏（toolbar）默认 display:none，需要 hover 回答区域才显示
    const answerSelectors = [
      '.chat-content-item-assistant',
      '[class*="message-content"]',
      '[class*="assistant"]',
      '[class*="answer"]',
      '[class*="message-assistant"]',
      '[class*="bot-message"]',
      '[class*="response"]',
      // 兜底：尝试 hover 页面主内容区域
      'main', '[class*="chat"]', '[class*="conversation"]',
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
            await page.waitForTimeout(1500); // 等待操作栏动画
            hovered = true;
            console.log(`[Kimi] hover 回答区域成功: ${sel} index=${i}`);
            break;
          }
        }
        if (hovered) break;
      } catch { /* 继续 */ }
    }

    // 步骤3: 健壮地查找并点击分享按钮（选择器 + 兜底扫描）
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      'button:has-text("分享")',
      'button:has-text("分享对话")',
      '[aria-label*="分享"]',
      '[aria-label*="share"]',
      '[class*="share"]:not([class*="share-text"]):not([class*="shared"])',
      '[data-testid*="share"]',
      // Kimi 的 toolbar 中的分享按钮
      '[class*="toolbar"] [class*="share"]',
      '[class*="action"] [class*="share"]',
    ], ['分享', '分享对话', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：尝试 hover 所有 message 元素后重新扫描
      console.log('[Kimi] 首次扫描未找到分享按钮，尝试 hover 所有消息元素后重新扫描...');
      const allMessages = await page.$$('[class*="message"], [class*="chat-content"], [class*="conversation-turn"]');
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
      // 最终检查 clipboard
      const captured = await this.getCapturedShareUrl(page, '/share/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    // 步骤4: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
    if (capturedUrl) {
      console.log(`[Kimi] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤5: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
    if (dialogUrl) return dialogUrl;

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[Kimi] 未能提取到分享链接');
    return null;
  }
}
