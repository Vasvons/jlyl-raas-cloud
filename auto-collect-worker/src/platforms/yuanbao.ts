import { Page } from 'playwright';
import * as logger from '../logger';
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
    // v1.9: 只匹配 /s/ 分享路径（之前还匹配域名，任何含域名的复制文本都会被误捕获）
    await this.injectClipboardInterceptor(page, ['/s/']);

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    // v1.9 修复：hover 成功一个元素后立即停止——之前会继续 hover 兜底选择器（main 等），
    // 鼠标被移走导致已显示的操作栏消失，分享按钮永远找不到
    const answerSelectors = [
      '.agent-chat__msg__content',
      '[class*="chat-content"]',
      '.markdown-body',
      '[class*="response"]',
      '[class*="answer"]',
      // 兜底
      'main', '[class*="chat"]', '[class*="conversation"]',
    ];

    let hoveredAny = false;
    for (const sel of answerSelectors) {
      if (hoveredAny) break;
      try {
        const elements = await page.$$(sel);
        for (let i = elements.length - 1; i >= 0; i--) {
          const visible = await elements[i].isVisible().catch(() => false);
          if (visible) {
            await elements[i].hover({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1500);
            hoveredAny = true;
            break;
          }
        }
      } catch { /* 继续 */ }
    }

    // 步骤3: 健壮地查找并点击分享按钮
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      '[data-id="shareButton"]',
      '#shareButton',
      'button:has-text("分享")',
      'button:has-text("Share")',
      '[aria-label*="分享"]',
      '[data-testid*="share"]',
      '[class*="share"]:not([class*="shared"])',
    ], ['分享', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：hover 所有消息后重新扫描
      console.log('[腾讯元宝] 首次扫描未找到分享按钮，尝试 hover 所有消息后重新扫描...');
      const allMessages = await page.$$('[class*="message"], [class*="agent-chat"], [class*="response"]');
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
      const captured = await this.getCapturedShareUrl(page, '/s/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    // 步骤3.4: v1.9.4 分享按钮点击后先尝试二次点击弹出菜单中的「复制链接」项
    // （实地日志 2026-08-17：点击 [aria-label*="分享"] 成功但剪贴板无捕获，
    //   弹出的是下拉菜单而非 Tab 面板时，必须二次点击菜单项才复制链接）
    await this.clickShareMenuItem(page);
    const earlyCaptured = await this.getCapturedShareUrl(page, '/s/');
    if (earlyCaptured) {
      console.log(`[腾讯元宝] 二次点击菜单后捕获分享链接: ${earlyCaptured}`);
      return earlyCaptured;
    }

    // v1.9.10: 元宝分享弹窗勾选消息后需先点击「生成链接/创建链接」才会出现可复制的分享链接
    for (const genSel of [
      'button:has-text("生成链接")',
      'button:has-text("创建链接")',
      'button:has-text("生成分享链接")',
      ':text-is("生成链接")',
      ':text-is("创建链接")',
      'button:has-text("下一步")',
    ]) {
      try {
        const genBtn = await page.$(genSel);
        if (genBtn) {
          const visible = await genBtn.isVisible().catch(() => false);
          if (!visible) continue;
          await genBtn.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1500);
          console.log(`[腾讯元宝] 点击生成链接按钮: ${genSel}`);
          const genCaptured = await this.getCapturedShareUrl(page, '/s/');
          if (genCaptured) return genCaptured;
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤3.5: 元宝分享弹窗可能是"长图/链接"Tab 式，先尝试切换到"链接"Tab
    // （默认可能停在长图模式，直接点"复制"会复制图片而非链接）
    // v1.9.4: 扩展 Tab 选择器（实地反馈 2026-08-17 切 Tab 未命中，弹窗结构已变化）
    for (const tabSel of [
      '[class*="tab"]:has-text("链接")',
      '[role="tab"]:has-text("链接")',
      '[class*="tab-item"]:has-text("链接")',
      '[class*="Tab"]:has-text("链接")',
      'div[class*="share"] :text("链接分享")',
      'div:has-text("链接分享")',
      'span:has-text("链接")',
    ]) {
      try {
        const tab = await page.$(tabSel);
        if (tab) {
          const visible = await tab.isVisible().catch(() => false);
          if (!visible) continue;
          await tab.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1000);
          console.log(`[腾讯元宝] 切换到链接分享 Tab: ${tabSel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤4: 查找并点击"复制链接"按钮
    // v1.9.4: 扩展选择器（button 之外补充 div/span/role=button，弹窗按钮不一定是 <button>）
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      'button:has-text("Copy")',
      '[class*="copy-link"]',
      '[role="button"]:has-text("复制")',
      'div[class*="btn"]:has-text("复制")',
      'span[class*="btn"]:has-text("复制")',
      'div[class*="button"]:has-text("复制")',
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
    const capturedUrl = await this.getCapturedShareUrl(page, '/s/');
    if (capturedUrl) {
      console.log(`[腾讯元宝] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/s/');
    if (dialogUrl) return dialogUrl;

    // v1.9.4: 提取失败时转储当前弹窗/浮层文本，便于下轮定位弹窗结构
    try {
      const layerText = await page.evaluate(() => {
        const texts: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="popover"], [class*="popup"], [class*="share"]'))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            if (t) texts.push(t);
          }
        }
        return texts.join(' || ').slice(0, 500);
      }).catch(() => '');
      if (layerText) logger.warn(`[腾讯元宝] 分享弹窗内容转储: ${layerText}`);
    } catch { /* 忽略 */ }

    // v1.9.11: 元宝分享失败真实 DOM 诊断——转储所有含 aria-label/title 的可点击元素
    // 和页面可见文本开头，暴露真实的分享入口/分享面板结构（避免再盲猜）
    try {
      const ariaDump = await page.evaluate(() => {
        const els = document.querySelectorAll('button, a, [role="button"], [aria-label], [title], [class*="share"], [class*="menu"], [class*="dialog"], [class*="modal"]');
        const results: string[] = [];
        for (let i = 0; i < els.length && results.length < 25; i++) {
          const el = els[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const txt = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16);
          const cls = (el.getAttribute('class') || '').toString().slice(0, 30);
          if (!aria && !title && !txt && !/share|menu|dialog|modal/i.test(cls)) continue;
          results.push(`<${el.tagName.toLowerCase()} aria="${aria}" title="${title}" cls="${cls}" txt="${txt}" pos=(${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)})`);
        }
        return results.join(' | ');
      }).catch(() => '');
      if (ariaDump) logger.warn(`[腾讯元宝] 分享失败 aria/title 元素转储: ${ariaDump}`);
      const bodyHead = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      ).catch(() => '');
      if (bodyHead) logger.warn(`[腾讯元宝] 分享失败页面文本开头: ${bodyHead}`);
    } catch { /* 忽略 */ }

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[腾讯元宝] 未能提取到分享链接');
    return null;
  }
}
