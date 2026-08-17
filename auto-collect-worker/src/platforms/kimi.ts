import { Page } from 'playwright';
import * as logger from '../logger';
import { BasePlatformAdapter } from './baseAdapter';

/** Kimi 适配器 */
export class KimiAdapter extends BasePlatformAdapter {
  platformName = 'Kimi';
  loginUrl = 'https://www.kimi.com/login';
  // Kimi 域名已从 kimi.moonshot.cn 迁移到 www.kimi.com
  // 旧域名会被重定向到新域名根路径，导致重定向检测误判
  chatUrl = 'https://www.kimi.com/chat';
  supportsShare = true;
  // v1.9.2: Kimi 改版后输入框为 contenteditable div（实地诊断 textarea=0, contenteditable=1）
  protected inputSelector = 'div[contenteditable="true"], textarea';
  // Kimi 的回答容器：message-content 是回答正文，toolbar 是操作栏
  protected responseSelector = '.chat-content-item-assistant, [class*="message-content"], [class*="assistant"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
  // v1.9.1 实地诊断（2026-08-16）：Kimi 改版（K3 英文界面），登录态失效后不跳登录页，
  // 而是渲染游客首页（/ 重定向，有输入框但查询不执行）。
  // .next-sidebar-history-list__login 为"Log in to sync"按钮，已登录不显示
  protected guestIndicators = ['.next-sidebar-history-list__login'];

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
      '[title*="分享"]',
      '[title*="share" i]',
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
      let shareClicked = false;
      for (let i = allMessages.length - 1; i >= 0; i--) {
        try {
          const visible = await allMessages[i].isVisible().catch(() => false);
          if (!visible) continue;
          await allMessages[i].hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(800);
          const clicked = await this.findAndClickShareButton(page, [], ['分享', 'Share', 'share']);
          if (clicked) { shareClicked = true; break; }

          // v1.9.6: Kimi 新版（K3）操作栏是纯图标按钮（无文字/aria），
          // 标准选择器匹配不到。hover 后扫描消息下方/附近出现的图标按钮，
          // 逐个点击试探（点击分享类图标会弹出分享面板或复制链接）。
          // v1.9.9: 限制扫描范围到 hover 的消息附近（含下方操作栏区域），
          // 排除左侧边栏图标（x<260）——旧版扫到的是侧边栏 new-icon-wrapper，点到无效果。
          if (!shareClicked) {
            const msgRect = await allMessages[i].boundingBox().catch(() => null);
            const iconBtns = await page.evaluate((rect) => {
              const candidates = document.querySelectorAll(
                'button, [role="button"], [class*="icon"], [class*="toolbar"] *, [class*="action"] *, [class*="btn"], [class*="share"]'
              );
              const results: string[] = [];
              for (let j = 0; j < candidates.length && results.length < 5; j++) {
                const el = candidates[j] as HTMLElement;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (r.width > 48 || r.height > 48) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                // 排除输入框相关
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') continue;
                // 排除已有明确文字的按钮（如"发送"）
                const txt = (el.innerText || '').trim();
                if (txt && txt.length > 0 && txt.length < 6) continue;
                // v1.9.9: 用 getAttribute('class') 提取 class（SVG 元素的 className 序列化后是 [object SVGAnimatedString]）
                const cls = (el.getAttribute('class') || '').trim().slice(0, 40);
                // 排除左侧边栏区域
                if (r.left < 260) continue;
                // 若知道消息区域，只收集消息附近的操作栏图标
                if (rect) {
                  const nearX = Math.abs(r.left - rect.x) < 200;
                  const nearY = (r.top > rect.y - 20) && (r.top < rect.y + rect.height + 120);
                  if (!(nearX && nearY)) continue;
                }
                results.push(`${el.tagName.toLowerCase()}|${cls}|${el.getAttribute('aria-label') || ''}|${el.getAttribute('title') || ''}`);
              }
              return results;
            }, msgRect ? { x: msgRect.x, y: msgRect.y, height: msgRect.height } : null).catch(() => []);
            for (const iconBtn of iconBtns) {
              const [tag, cls, aria, title] = iconBtn.split('|');
              logger.warn(`[Kimi] 尝试点击消息附近操作栏图标: class="${cls}" aria="${aria}" title="${title}"`);
              // 优先用 class 定位并点击
              let btn: any = null;
              if (cls) btn = await page.$(`[class*="${cls.split(' ')[0]}"]`).catch(() => null);
              if (!btn && aria) btn = await page.$(`[aria-label*="${aria}"]`).catch(() => null);
              if (btn) {
                const bVisible = await btn.isVisible().catch(() => false);
                if (bVisible) {
                  await btn.click({ timeout: 2000 }).catch(() => {});
                  await page.waitForTimeout(1500);
                  // 点击后检查：剪贴板捕获 / 分享面板出现
                  const cap = await this.getCapturedShareUrl(page, '/share/');
                  if (cap) return cap;
                  const dl = await this.extractShareUrlFromDialog(page, '/share/');
                  if (dl) return dl;
                  // 分享面板可能需要二次点"复制链接"
                  const menuClicked = await this.clickShareMenuItem(page);
                  if (menuClicked) {
                    const cap2 = await this.getCapturedShareUrl(page, '/share/');
                    if (cap2) return cap2;
                  }
                  // 没触发分享则关闭可能的浮层
                  await page.keyboard.press('Escape').catch(() => {});
                  await page.waitForTimeout(500);
                }
              }
            }
          }
        } catch { /* 继续 */ }
      }
      // 最终检查 clipboard
      const captured = await this.getCapturedShareUrl(page, '/share/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    // 步骤3.5: v1.9 — 点击分享按钮后，Kimi 可能弹出分享面板，需再点击"复制链接"按钮
    // （之前缺少此步骤：弹窗式分享必须显式点"复制链接"才会写入剪贴板）
    await page.waitForTimeout(1200);
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      'button:has-text("Copy link")',
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
          console.log(`[Kimi] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
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
