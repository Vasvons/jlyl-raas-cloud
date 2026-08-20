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

    // 步骤2+3 (v2.1.x): hover 操作栏并点击分享图标
    // 新版千问分享按钮是 hover 回答后出现的 qs-bottom-icon 图标操作栏，
    // 图标 class/aria 不含 "share" 字样，findAndClickShareButton 匹配不到（实测全落空）。
    // 改为通用 hover 图标探针 + 逐个点击验证（含探针日志定位真实分享图标）。
    let shareBtnClicked = false;
    const barResult = await this.hoverAndClickShareIcon(page, {
      answerSelectors: [
        '.answer-area', '.markdown-body', '[class*="answer"]', '[class*="response"]',
        '[class*="message-content"]', 'main', '[class*="chat"]', '[class*="conversation"]',
      ],
      iconHints: ['qs-bottom-icon'],
      urlPattern: '/share/',
    });
    if (barResult === '__SHARE_PANEL__') {
      // 已点出分享面板（进入多选模式），走下方确认流程
      shareBtnClicked = true;
    } else if (typeof barResult === 'string') {
      // 点击图标后直接复制到剪贴板
      logger.info(`[通义千问] 操作栏图标点击直接捕获分享链接: ${barResult}`);
      return barResult;
    } else {
      // 未定位到分享图标或点出面板，关闭可能的浮层
      await page.keyboard.press('Escape').catch(() => {});
      // 保持旧式兜底（hover 消息 + findAndClickShareButton + 菜单项扫描）
    }

    if (!shareBtnClicked) {
      // v1.9.10: 兜底——千问新版分享可能是消息操作行中的图标（无 class/aria 含 share），
      // findAndClickShareButton 匹配不到。先直接尝试 clickShareMenuItem 的叶子级扫描
      // （可识别"编辑 复制 分享"式操作行并点到具体的"分享"项）。
      const menuClicked = await this.clickShareMenuItem(page);
      if (menuClicked) {
        const cap = await this.getCapturedShareUrl(page, '/share/');
        if (cap) {
          logger.info(`[通义千问] 分享菜单项点击后捕获到分享链接: ${cap}`);
          return cap;
        }
        const dlg = await this.extractShareUrlFromDialog(page, '/share/');
        if (dlg) return dlg;
      }
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
          if (clicked) {
            await this.clickShareMenuItem(page);
            const c2 = await this.getCapturedShareUrl(page, '/share/');
            if (c2) return c2;
            const d2 = await this.extractShareUrlFromDialog(page, '/share/');
            if (d2) return d2;
            break;
          }
        } catch { /* 继续 */ }
      }
      const captured = await this.getCapturedShareUrl(page, '/share/');
      if (captured) return captured;
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    // 步骤4: 如果进入了多选模式，查找底部"分享"按钮
    // v3.19.x：千问分享是多选模式，全选后底部 btn-group 出现「分享/复制链接」按钮组。
    //   旧 confirmBtnSelectors 只匹配 <button> 文本「分享/复制链接」，而 btn-group 内按钮
    //   可能是 div/span 图标按钮或文案不同，导致全选成功但拿不到链接（日志 btn-group-XJWF_N 被截断）。
    //   改为：转储 btn-group 内所有按钮 + 优先点 aria/title 含 分享/复制/链接 的，否则逐个点击验证剪贴板。
    await page.waitForTimeout(1000);
    const btnGroupClicked = await page.evaluate(() => {
      const groups = document.querySelectorAll('[class*="btn-group"], [class*="btnGroup"], [class*="share-selection"] ~ [class*="btn"]');
      const candidates: Array<{ tag: string; cls: string; aria: string; title: string; text: string; x: number; y: number }> = [];
      for (let g = 0; g < groups.length; g++) {
        const els = groups[g].querySelectorAll('button, [role="button"], [class*="btn"], [class*="button"], [class*="item"], [class*="action"], div, span');
        for (let i = 0; i < els.length; i++) {
          const el = els[i] as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.width > 160 || r.height > 48) continue;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const cls = (el.className || '').toString();
          candidates.push({ tag: el.tagName.toLowerCase(), cls: cls.slice(0, 40), aria, title, text: text.slice(0, 12), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        }
      }
      return candidates;
    }).catch(() => [] as any[]);

    if (btnGroupClicked.length > 0) {
      logger.warn(`[通义千问] 底部分享按钮组(${btnGroupClicked.length}个): ${btnGroupClicked.map(b => `<${b.tag} class="${b.cls}" aria="${b.aria}" title="${b.title}" text="${b.text}" pos=(${b.x},${b.y})`).join(' | ')}`);
      // 优先点击 aria/title/text 含 分享/复制链接/链接 的
      const priority = btnGroupClicked.filter(b => /分享|复制链接|分享链接|链接|share|copy/i.test(b.aria + b.title + b.text));
      const ordered = [...priority, ...btnGroupClicked.filter(b => !priority.includes(b))];
      for (const b of ordered.slice(0, 6)) {
        await page.mouse.click(b.x, b.y).catch(() => {});
        await page.waitForTimeout(1500);
        const cap = await this.getCapturedShareUrl(page, '/share/');
        if (cap) {
          logger.info(`[通义千问] 点击底部按钮组捕获分享链接: ${cap} (btn=${b.text || b.aria || b.cls})`);
          return cap;
        }
        const dlg = await this.extractShareUrlFromDialog(page, '/share/');
        if (dlg) return dlg;
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }
    } else {
      // 旧选择器兜底（btn-group 未识别时的兼容）
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
