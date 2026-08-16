import { Page } from 'playwright';
import * as logger from '../logger';
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
  // v1.9.1 实地诊断（2026-08-16）：登录态失效后 /chat URL 不变，渲染游客首页
  // （.guest-home-action-text 为游客首页"API 服务/下载电脑端"按钮特征，已登录不显示）
  protected guestIndicators = ['.guest-home-action-text'];

  /**
   * v1.9.6: 千问回答为流式生成，stop 按钮检测在部分会话中不可靠
   * （回答未完成就提取 → 抓到侧边栏/部分文本被污染拦截）。
   * 增加「文本稳定」等待：主内容区域文本连续两次不变视为生成完成。
   */
  async waitForResponse(page: Page): Promise<void> {
    // 先尝试基类的 stop 按钮等待（快速路径）
    try {
      await super.waitForResponse(page);
    } catch { /* 忽略 */ }
    // 再做文本稳定检测（兜底）
    try {
      const snapshot = (): Promise<string> =>
        page.evaluate(() => {
          const main = document.querySelector('.answer-area, [class*="answer"], [class*="response"], main') || document.body;
          return ((main as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(-8000);
        }).catch(() => '');
      const deadline = Date.now() + 30000;
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
      logger.info('[通义千问] 回答文本稳定，生成完成');
    } catch { /* 忽略 */ }
  }

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
    // v1.9.4 提前短路：实地日志（2026-08-17）确认新版千问页面 DOM 中完全不存在
    // 任何分享元素（含隐藏元素），多轮 hover 扫描每次浪费 30+ 秒且必然失败。
    // 无分享入口时直接返回 null，由云端生成静态页兜底。
    if (!(await this.hasAnyShareElement(page))) {
      logger.info('[通义千问] 页面无可点击分享元素（新版可能已移除分享入口），跳过分享提取');
      return null;
    }

    // 步骤1: 注入 clipboard + execCommand 拦截
    await this.injectClipboardInterceptor(page, ['/share/']);

    // 步骤2: hover 在 AI 回答区域上，触发 share-selection 按钮显示
    // v1.9 修复：hover 成功一个元素后立即停止——之前会继续 hover 兜底选择器（main 等），
    // 鼠标被移走导致已显示的操作栏消失，分享按钮永远找不到
    const answerSelectors = [
      '.answer-area',
      '.markdown-body',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="message-content"]',
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
    // v1.9: 补充 hover 后新式操作栏的图标按钮匹配（title/aria-label 含"分享"的 SVG 图标按钮）
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      '[class*="share-selection"]',
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[title*="分享"]',
      '[data-testid*="share"]',
      '[class*="icon-share"]',
      '[class*="share"]:not([class*="shared"])',
    ], ['分享', 'Share', 'share']);

    if (!shareBtnClicked) {
      // 兜底：hover 消息后重新扫描（v1.9.5: 最多尝试 5 条——历史版本遍历全部消息，
      // 每条内部又跑两轮策略+诊断扫描，20 条消息浪费 2.5 分钟）
      logger.info('[通义千问] 首次扫描未找到分享按钮，尝试 hover 消息区域后重新扫描（最多5条）...');
      const allMessages = await page.$$('[class*="message"], [class*="answer"], [class*="response"]');
      let attempts = 0;
      for (let i = allMessages.length - 1; i >= 0 && attempts < 5; i--) {
        try {
          const visible = await allMessages[i].isVisible().catch(() => false);
          if (!visible) continue;
          attempts++;
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
    // v1.9: 先等待可能的选择面板出现，再确认
    await page.waitForTimeout(1000);
    const confirmBtnSelectors = [
      'button:has-text("确认分享")',
      'button:has-text("生成链接")',
      'button:has-text("复制链接")',
      '[class*="share-confirm"]',
      'button:has-text("分享")',
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
