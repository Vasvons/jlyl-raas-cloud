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
