import { Page } from 'playwright';
import * as logger from '../logger';
import { BasePlatformAdapter } from './baseAdapter';

/**
 * 智谱AI适配器（v2 — 回退到 24-25 号可工作的简单实现）
 *
 * 历史教训：
 * - 24-25 号用最简单的实现（chatUrl=/chat/、textarea、.markdown-body）正确执行了搜索
 * - 后续按 auth helper 脚本"严格对齐"反而打乱了状态：
 *   1) chatUrl 从 /chat/ 改成 /，导致进入首页而非聊天页
 *   2) 强制点击"联网"按钮，但用户反馈"联网默认就开着"，点击反而会关闭已激活状态
 *   3) 复杂的 responseSelector 和 waitForResponse 反而匹配不到
 *
 * 关键认知（用户实测）：
 * - 联网按钮在"聊天框左下角的选择模式弹窗里"，默认已激活，无需代码点击
 * - 分享链接按钮在"右上角"，文案是"复制对话链接"，点击后链接复制到剪贴板
 *
 * 因此本版本：
 * - chatUrl 回到 /chat/
 * - 删除 afterNavigate 覆盖（不点击联网按钮）
 * - 删除 extractContent 覆盖（用基类的 smartFindLongestContent 兜底）
 * - 删除 waitForResponse 覆盖（用基类的停止按钮等待）
 * - 专门重写 extractShareLink：点击"复制对话链接"按钮 + 拦截 clipboard.writeText
 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  // 关键：用 /chat/ 而非 /，直接进入聊天页（24-25 号可工作的配置）
  chatUrl = 'https://chatglm.cn/chat/';
  supportsShare = true;
  // 简单选择器（24-25 号可工作的配置）
  protected inputSelector = 'textarea';
  protected responseSelector = '.markdown-body, [class*="markdown"], [class*="message"], [class*="answer"], [class*="msg-content"], [class*="msg_content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  /**
   * v1.9.11: 智谱回答为流式生成，基类 stop 按钮等待不可靠（[class*="stop"] 常不匹配）。
   * 若在回答未生成完时就提取分享，右上角分享按钮处于 disabled 状态，点击无效导致拿不到链接
   * （实地日志 2026-08-17 16:08：对话仍"搜索中"时 share-icon-box 为 disabled，16:08 查询失败；
   * 而 15:52 回答完成后 share-icon-box 启用，成功捕获 chatglm.cn/share/ 链接）。
   * 增加「文本稳定」等待：对话区域文本连续两次不变视为生成完成。
   */
  async waitForResponse(page: Page): Promise<void> {
    // 先尝试基类的 stop 按钮等待（快速路径）
    try {
      await super.waitForResponse(page);
    } catch { /* 忽略 */ }
    // 再做文本稳定检测（兜底，确保回答完整生成后再提取）
    try {
      const snapshot = (): Promise<string> =>
        page.evaluate(() => {
          const el = document.querySelector('.conversation-inner, [class*="conversation"], main, [class*="dialogue"]') || document.body;
          return ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(-8000);
        }).catch(() => '');
      const deadline = Date.now() + 45000;
      let last = await snapshot();
      let stable = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const cur = await snapshot();
        if (cur === last) {
          stable++;
          if (stable >= 2) break;
        } else {
          stable = 0;
        }
        last = cur;
      }
      logger.info('[智谱AI] 回答文本稳定，生成完成');
    } catch { /* 忽略 */ }
  }

  /**
   * 智谱分享链接提取（v2）
   *
   * 用户实测：右上角有"复制对话链接"按钮，点击后链接复制到剪贴板。
   * 策略：
   * 1. 注入 clipboard.writeText 拦截脚本，捕获复制到剪贴板的 URL
   * 2. 找到"复制对话链接"按钮并点击
   * 3. 从拦截到的 URL 返回
   * 4. 兜底：从对话框文本中匹配 URL
   * 5. 兜底：从当前页面 URL 提取 /share/{短码}
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 clipboard.writeText 拦截脚本
    // v1.9: 只匹配 /share/ 分享路径（之前还匹配 'http'，任何 URL 复制都会被误捕获）
    await this.injectClipboardInterceptor(page, ['/share/']);

    // 步骤1.5 (v2.1.x): 检测分享按钮 disabled 状态
    // 实测：智谱分享按钮（share-icon-box）在"搜索中/回答未完成/会话模式不支持分享"时带 disabled，
    // 点击无效。这里先探针检测并打印状态；若禁用，尝试 hover 消息激活后重测，仍禁用则明确跳过，
    // 避免白白走完整个分享流程却拿不到链接。
    const shareDisabled = await page.evaluate(() => {
      const results: string[] = [];
      const els = document.querySelectorAll('[class*="share-icon-box"], [class*="agent-share"], [class*="share-icon"]');
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cls = (el.className || '').toString();
        const disabled = el.hasAttribute('disabled') || /disabled|disable/.test(cls) || (el.getAttribute('aria-disabled') === 'true');
        results.push(`<${el.tagName.toLowerCase()} class="${cls.slice(0, 40)}" disabled=${disabled} pos=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)})`);
      }
      return results;
    }).catch(() => [] as string[]);
    if (shareDisabled.length > 0) {
      logger.warn(`[智谱AI] 分享按钮 disabled 状态探针: ${shareDisabled.join(' | ')}`);
    } else {
      logger.warn('[智谱AI] 未找到分享按钮元素（可能已改版）');
    }

    // 若分享图标带 disabled，先 hover 最后一条助手消息尝试激活，再重测
    const stillDisabled = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="share-icon-box"][class*="disabled"], [class*="agent-share"][class*="disabled"], [aria-disabled="true"][class*="share"]');
      return els.length > 0;
    }).catch(() => false);
    if (stillDisabled) {
      try {
        const msgs = await page.$$('[class*="message"], .markdown-body, [class*="assistant"], [class*="answer"]');
        for (let i = msgs.length - 1; i >= 0; i--) {
          const visible = await msgs[i].isVisible().catch(() => false);
          if (visible) { await msgs[i].hover({ timeout: 1500 }).catch(() => {}); break; }
        }
        await page.waitForTimeout(800);
        const disabledAfterHover = await page.evaluate(() => {
          const els = document.querySelectorAll('[class*="share-icon-box"][class*="disabled"], [class*="agent-share"][class*="disabled"], [aria-disabled="true"][class*="share"]');
          return els.length > 0;
        }).catch(() => true);
        if (disabledAfterHover) {
          logger.warn('[智谱AI] 分享按钮 hover 后仍为 disabled（会话模式不支持分享或账号受限），跳过分享提取');
          return null;
        }
      } catch { /* 忽略 */ }
    }

    // 步骤2: 健壮地查找并点击"复制对话链接"按钮
    let clickedBtn = await this.findAndClickShareButton(page, [
      'button:has-text("复制对话链接")',
      'button:has-text("复制链接")',
      '[class*="share"]:has-text("复制")',
      '[aria-label*="复制对话"]',
      '[aria-label*="复制链接"]',
      '[aria-label*="分享"]',
      '[title*="分享"]',
      '[title*="复制链接"]',
      '[class*="share"]:not([class*="shared"])',
      '[class*="copy-link"]',
      '[class*="copyLink"]',
      '[data-testid*="share"]',
      '[data-testid*="copy"]',
    ], ['复制对话链接', '复制链接', '分享', 'share', 'copy']);

    // 步骤2.5: 首次未找到时，hover 消息区域触发操作栏后重试（v1.9）
    // 智谱消息操作栏（含分享图标）hover 回答区域才显示
    if (!clickedBtn) {
      logger.warn('[智谱AI] 顶部未找到分享按钮，尝试 hover 消息区域后重试...');
      const answerSelectors = ['.markdown-body', '[class*="message-content"]', '[class*="answer"]', '[class*="assistant"]'];
      let hoveredAny = false;
      for (const sel of answerSelectors) {
        if (hoveredAny) break;
        try {
          const elements = await page.$$(sel);
          for (let i = elements.length - 1; i >= 0; i--) {
            const visible = await elements[i].isVisible().catch(() => false);
            if (visible) {
              await elements[i].hover({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1200);
              hoveredAny = true;
              break;
            }
          }
        } catch { /* 继续 */ }
      }
      if (hoveredAny) {
        clickedBtn = await this.findAndClickShareButton(page, [
          '[class*="share"]:not([class*="shared"])',
          '[aria-label*="分享"]',
          '[title*="分享"]',
        ], ['分享', 'share']);
      }
    }

    // 步骤3: 如果按钮点击成功，先二次点击弹出菜单中的「复制链接」项
    // v1.9.4: share-icon 点击后弹出下拉菜单，必须二次点击「复制对话链接/复制链接」才写剪贴板
    // （实地日志 2026-08-17：点击 share-icon 成功但剪贴板始终无捕获，即缺此步骤）
    if (clickedBtn) {
      await this.clickShareMenuItem(page);
      const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
      if (capturedUrl) {
        console.log(`[智谱AI] 从 clipboard 拦截到分享链接: ${capturedUrl}`);
        return capturedUrl;
      }
      // 检查是否弹出了对话框
      const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
      if (dialogUrl) return dialogUrl;
    }

    // v1.9.9: 分享图标（share-icon）点击后常无任何面板弹出（实地日志 2026-08-17）。
    // 用户实测智谱真实分享按钮在「右上角」操作栏（agent-share-container → agent-share → share-icon），
    // disabled 状态在 hover 消息后才激活。当前版本新增：专门扫描 `agent-share-container` 并点击。
    try {
      const shareBtnFound = await page.evaluate(() => {
        const container = document.querySelector('[class*="agent-share-container"], [class*="agent-share"]');
        if (!container) return '';
        const shareIcon = container.querySelector('[class*="share-icon"], button[aria-label*="分享"]');
        if (!shareIcon) return '';
        const cls = (shareIcon.className || '').toString().split(' ')[0];
        return cls;
      }).catch(() => '');
      if (shareBtnFound) {
        const shareBtn = await page.$(`[class*="${shareBtnFound}"]`).catch(() => null);
        if (shareBtn) {
          const visible = await shareBtn.isVisible().catch(() => false);
          if (visible) {
            await shareBtn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1500);
            logger.info(`[智谱AI] 点击右上角分享容器图标成功: ${shareBtnFound}`);
            // 点击容器图标后会弹出分享面板，此时再找复制链接按钮
            const menuClicked = await this.clickShareMenuItem(page);
            const cap = await this.getCapturedShareUrl(page, '/share/');
            if (cap) {
              logger.info(`[智谱AI] 点击右上角分享图标后捕获到分享链接: ${cap}`);
              return cap;
            }
            const dlg = await this.extractShareUrlFromDialog(page, '/share/');
            if (dlg) return dlg;
          }
        }
      }
      //  fallback: 逐个点击顶部操作栏按钮（operation-btn）
      const headerBtns = await page.evaluate(() => {
        const btns = document.querySelectorAll(
          '[class*="operation-btn"], [class*="operationBtn"], header [class*="btn"], [class*="toolbar"] [class*="btn"], [class*="header"] [class*="icon"], [class*="agent-share"]'
        );
        const results: string[] = [];
        for (let i = 0; i < btns.length; i++) {
          const el = btns[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const cls = (el.className || '').toString().split(' ')[0];
          // 跳过明显的搜索按钮
          if (/search/i.test(cls) || /搜索/.test(el.getAttribute('aria-label') || '')) continue;
          results.push(cls);
        }
        return results;
      }).catch(() => []);
      if (headerBtns.length > 0) {
        logger.warn(`[智谱AI] 顶部操作栏按钮转储: ${headerBtns.join(' || ')}`);
        for (const cls of headerBtns.slice(0, 6)) {
          if (!cls) continue;
          try {
            const btn = await page.$(`[class*="${cls}"]`).catch(() => null);
            if (btn) {
              const visible = await btn.isVisible().catch(() => false);
              if (!visible) continue;
              await btn.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1500);
              await this.clickShareMenuItem(page);
              const cap = await this.getCapturedShareUrl(page, '/share/');
              if (cap) {
                logger.info(`[智谱AI] 点击操作栏按钮捕获到分享链接: ${cap}`);
                return cap;
              }
              const dlg = await this.extractShareUrlFromDialog(page, '/share/');
              if (dlg) return dlg;
              // 没触发分享则关闭可能的浮层，继续试下一个
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(500);
            }
          } catch { /* 继续 */ }
        }
      }
    } catch { /* 忽略 */ }

    // 步骤4: 兜底从当前页面 URL 提取显式分享 URL（/share/{短码}）
    // v1.9: getCurrentPageShareUrl 已移除私有对话URL模式，仅匹配显式分享链接，安全
    const currentUrl = await this.getCurrentPageShareUrl(page);
    if (currentUrl) {
      console.log(`[智谱AI] 从当前 URL 提取到分享链接: ${currentUrl}`);
      return currentUrl;
    }

    console.log('[智谱AI] 未能提取到分享链接');
    return null;
  }
}
