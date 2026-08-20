import { Page } from 'playwright';
import { PlatformAdapter, PlatformCredentials, QueryResult, randomDelay } from './base';
import { smartFindInputElement, smartFindLongestContent } from '../indexedInteractor';
import { humanType, humanDelay, humanClick } from '../behaviorHumanizer';
import * as logger from '../logger';

/**
 * 通用平台适配器基类实现
 * 大部分 AI 平台的查询流程相似：打开聊天页 → 填入 textarea → 回车 → 等待 → 提取
 * 子类只需提供选择器配置即可
 */
export abstract class BasePlatformAdapter extends PlatformAdapter {
  abstract platformName: string;
  abstract loginUrl: string;
  abstract chatUrl: string;
  abstract supportsShare: boolean;

  // 子类可覆盖的选择器
  protected inputSelector: string = 'textarea';
  protected responseSelector: string = '';
  protected stopButtonSelector: string = '';
  protected loginUrlPattern: string = 'login'; // URL 中包含此字符串表示未登录

  async login(page: Page, credentials: PlatformCredentials): Promise<boolean> {
    // storageState 已含登录态，通常不需要自动登录
    return await this.checkLoginStatus(page);
  }

  async checkLoginStatus(page: Page): Promise<boolean> {
    try {
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000); // 等待重定向
      const currentUrl = page.url();
      // 如果被重定向到登录页，说明未登录
      return !currentUrl.includes(this.loginUrlPattern) && !currentUrl.includes('sign_in');
    } catch (e: any) {
      // 区分"页面崩溃/浏览器异常"和"真正登录失效"和"导航超时"
      // 页面崩溃时不要误判为登录态失效，抛出异常让上层作为查询失败处理
      // 否则会导致账号被错误标记为 failed，账号池被快速消耗
      if (page.isClosed()) {
        throw new Error(`checkLoginStatus 失败: 页面已关闭 (${e.message})`);
      }
      // Page crashed 等浏览器级异常也抛出，不当作登录失效
      const errMsg = String(e?.message || '');
      if (errMsg.includes('Page crashed') || errMsg.includes('Target closed') || errMsg.includes('Browser closed')) {
        throw new Error(`checkLoginStatus 失败: 浏览器异常 (${errMsg})`);
      }
      // 导航超时（net::ERR_TIMED_OUT、Timeout exceeded）也抛出，不当作登录失效
      // 因为超时可能是网络问题或页面加载慢，不代表登录态失效
      if (errMsg.includes('Timeout') || errMsg.includes('timeout') || errMsg.includes('ERR_TIMED_OUT') || errMsg.includes('ERR_INTERNET_DISCONNECTED')) {
        throw new Error(`checkLoginStatus 失败: 导航超时 (${errMsg})`);
      }
      // 其他异常（如 URL 确实包含 login）返回 false
      return false;
    }
  }

  /** 导航后特殊处理钩子（子类可重写，用于点击"开始对话"等入口按钮） */
  protected async afterNavigate(page: Page): Promise<void> {
    // 默认无操作
  }

  /**
   * 游客模式特征选择器（v1.9.1）
   *
   * 背景：部分平台登录态失效后不会重定向到登录页（URL 不变、不报错），
   * 而是渲染"游客首页"——游客首页也有输入框（能输入、能回车），
   * 但查询不会真正执行，最终把首页/侧边栏文本当"AI 回答"入库，产生垃圾记录。
   *
   * 特征选择器来自实地诊断（2026-08-16）：
   *   - 通义千问: .guest-home-action-text（游客首页"API 服务/下载电脑端"按钮）
   *   - Kimi: .next-sidebar-history-list__login（"Log in to sync"按钮，已登录不显示）
   *
   * 命中任一可见特征 → 判定登录态失效 → 抛异常 → 云端标记 offline → 人工重新登录
   */
  protected guestIndicators: string[] = [];

  /**
   * 页面框架/侧边栏文本标记（v1.9.3）
   *
   * 提取的"AI 回答"中命中 2 个以上标记 → 判定为抓到了侧边栏/框架文本而非真实回答，
   * 抛"内容提取异常"防止垃圾数据入库（子类可按平台扩展）
   */
  protected sidebarMarkers: string[] = ['新对话', '新建对话', '创建新项目', '云盘', '云空间', '定时任务', '最近对话', 'New Chat', 'My Kimi', 'Log in to sync'];

  /**
   * 提交查询（v1.9.3 钩子方法）
   *
   * 默认按 Enter 提交。豆包等平台 Enter 不发送（需点击发送按钮），子类可重写。
   * 参考 auth helper 实测：豆包发送按钮为 div.send-btn-wrapper button
   */
  protected async submitInput(page: Page, activeSelector: string): Promise<void> {
    await page.press(activeSelector, 'Enter');
  }

  /** 读取输入框当前文本（textarea/input 用 value，contenteditable 用 innerText） */
  protected async readInputValue(page: Page, selector: string): Promise<string> {
    try {
      return await page.$eval(selector, (el: any) => {
        if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return el.value || '';
        return (el && (el.innerText || el.textContent)) || '';
      }).catch(() => '');
    } catch {
      return '';
    }
  }

  /**
   * 提交结果验证（v1.9.4）
   *
   * 实地诊断（2026-08-17 豆包）：点击发送按钮后查询可能仍未真正发送
   * （发送按钮选择器误匹配其他按钮），随后 waitForResponse 超时、extractContent
   * 抓到侧边栏文本，被污染拦截连续失败 5 次触发熔断。
   *
   * 绝大多数聊天平台提交成功后会清空输入框。本方法在提交后检查输入框：
   * - 输入框已清空 → 提交成功，直接返回
   * - 输入框仍保留完整关键词 → 疑似未发送，用 Enter 兜底重发一次
   * - 重发后仍未清空 → 抛"提交失败"（普通失败，不标记账号 offline）
   */
  protected async verifySubmission(page: Page, activeSelector: string, keyword: string): Promise<void> {
    const kw = keyword.trim();
    if (!kw) return;
    await page.waitForTimeout(3000);
    let value = await this.readInputValue(page, activeSelector);
    if (!value || !value.includes(kw)) return; // 输入框已清空 → 提交成功
    logger.warn(`[${this.platformName}] 提交后输入框未清空，疑似未真正发送，尝试 Enter 兜底重发`);
    try {
      await page.press(activeSelector, 'Enter');
    } catch {
      /* 输入框可能已失焦，忽略 */
    }
    await page.waitForTimeout(3000);
    value = await this.readInputValue(page, activeSelector);
    if (value && value.includes(kw)) {
      // v1.9.4: 抛错前检测页面是否为游客/登录页——Kimi 等平台游客首页也有输入框，
      // 能输入能回车但查询不会真正执行（guestIndicators 选择器改版失配时兜底）。
      // 命中登录特征则抛"登录态失效"让上层标记账号 offline，避免普通失败空转到熔断
      try {
        const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '').catch(() => '');
        // v1.9.5: 风控验证码检测——纳米等平台查询频率过高触发拼图验证，输入框同样不清空，
        // 报"触发风控验证码"比"提交失败"更准确（提示降频而非排查发送按钮）
        const captchaTexts = ['拼图验证', '请完成下方拼图验证', '频繁使用，需要验证', '请完成安全验证', '拖动滑块', '人机验证'];
        const captchaHit = captchaTexts.find(t => pageText.includes(t));
        if (captchaHit) {
          throw new Error(`触发风控验证码: 检测到"${captchaHit}"，查询被平台拦截 (URL=${page.url()})`);
        }
        const guestTexts = ['登录后创建新会话', '微信扫码登录', '请登录后继续', '登录/注册', '立即登录'];
        const hit = guestTexts.find(t => pageText.includes(t));
        if (hit) {
          throw new Error(`登录态失效: 页面含游客特征"${hit}"且查询无法发送 (URL=${page.url()})`);
        }
      } catch (e: any) {
        if (String(e.message).startsWith('登录态失效') || String(e.message).startsWith('触发风控验证码')) throw e;
        /* 检测异常则继续抛普通提交失败 */
      }
      throw new Error(`提交失败: 发送后输入框文本未清空，查询未真正发送（关键词=${kw.substring(0, 20)}）`);
    }
  }

  /** 检测当前页面是否为游客模式首页（命中任一可见特征元素即返回 true） */
  protected async detectGuestMode(page: Page): Promise<boolean> {
    if (this.guestIndicators.length === 0) return false;
    for (const sel of this.guestIndicators) {
      try {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            console.warn(`[${this.platformName}] 检测到游客模式特征: ${sel}`);
            return true;
          }
        }
      } catch { /* 继续 */ }
    }
    return false;
  }

  /**
   * 快速扫描页面 DOM 中是否存在任何分享相关的「可点击元素」（v1.9.4）
   * 扫描范围与 findAndClickShareButton 的诊断扫描一致：button/a/[role="button"]。
   * 注意：不能扫描所有 DOM 元素的 class——侧边栏/样式容器常有 class 含 "share"
   * 的非可点击元素（如 share-border 装饰类），会导致短路永不触发（实测踩坑）。
   * 用于分享提取前提前短路：无可点击分享入口时（平台改版移除分享），
   * 不再执行多轮 hover 扫描（通义千问实测每次浪费 30+ 秒），直接走静态页兜底。
   * 扫描异常时返回 true（不短路，保守执行完整提取流程）。
   *
   * v1.9.9: 修复「只认可见元素」导致的漏判——千问等平台分享按钮是 hover 才显示
   * （默认 display:none），旧逻辑直接短路跳过，导致千问永远不产出分享链接。
   * 改为「只认消息/回答容器内的分享元素」（含隐藏的 hover 型按钮），
   * 既排除侧边栏 share 装饰的误判，又能识别 hover 显示的真实分享入口。
   */
  protected async hasAnyShareElement(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        // 元素是否位于消息/回答容器内（hover 才显示的操作栏分享按钮都挂在消息容器下）
        const inMessageContainer = (el: Element): boolean => {
          let node: Element | null = el;
          let depth = 0;
          while (node && depth < 8) {
            const cls = (node.className || '').toString().toLowerCase();
            const role = node.getAttribute && (node.getAttribute('role') || '');
            if (
              /message|answer|response|chat-item|chat-content|bubble|conversation-turn|msg-|reply|assistant|bot-message|dialogue|agent-chat/i.test(cls) ||
              /article|main/i.test(role)
            ) {
              return true;
            }
            node = node.parentElement;
            depth++;
          }
          return false;
        };

        const clickables = document.querySelectorAll(
          'button, a, [role="button"], [class*="share"], [class*="icon-share"], [class*="share-selection"]'
        );
        for (let i = 0; i < clickables.length; i++) {
          const el = clickables[i] as HTMLElement;
          // 仅关注消息容器内的分享元素（侧边栏/导航的 share 装饰不算）
          if (!inMessageContainer(el)) continue;
          const cls = (el.className || '').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const tid = (el.getAttribute('data-testid') || '').toLowerCase();
          const did = (el.getAttribute('data-id') || '').toLowerCase();
          const text = (el.textContent || '').trim();
          const isShare =
            (cls.includes('share') && !cls.includes('shared') && !cls.includes('sharing')) ||
            cls.includes('icon-share') || cls.includes('share-selection') ||
            aria.includes('分享') || aria.includes('share') ||
            title.includes('分享') || title.includes('share') ||
            tid.includes('share') || did.includes('share') ||
            text === '分享' || text === 'Share' || text.includes('复制链接') || text.includes('复制对话链接');
          if (!isShare) continue;
          // 隐藏的分享元素 = hover 才显示的操作栏按钮，同样是可用分享入口
          return true;
        }
        return false;
      }).catch(() => true);
    } catch {
      return true;
    }
  }

  /**
   * 点击分享按钮后，查找并点击新弹出菜单/浮层中的「复制链接」类菜单项（v1.9.4）
   * 智谱/元宝等平台点击分享图标后会弹出下拉菜单或分享面板，
   * 必须二次点击菜单中的「复制链接/复制对话链接」才会写入剪贴板。
   * 仅点击新出现的可见元素，选择器从精确到宽泛排列。
   */
  protected async clickShareMenuItem(page: Page): Promise<boolean> {
    await page.waitForTimeout(1000);

    // v1.9.9: 部分平台（元宝）分享弹窗需先勾选消息（"点击全选以下消息"）才激活"复制链接"。
    // 先尝试点击"全选/选择全部"复选框，再找复制按钮。
    // v1.9.10: 元宝弹窗文案是"点击全选以下消息"，旧选择器只匹配"全选"精确文本导致漏匹配；
    // 补充文本包含匹配 + 弹窗内文本扫描兜底。
    try {
      const selectAllSelectors = [
        'button:has-text("全选")',
        ':text-is("全选")',
        'button:has-text("选择全部")',
        ':text-is("选择全部")',
        '[class*="select-all"]',
        '[class*="selectAll"]',
        'label:has-text("全选")',
        '[class*="checkbox"]:has-text("全选")',
      ];
      // 注意：不用 div/span:has-text("全选") 这类宽泛选择器——可能点到含"全选"文本的整个容器
      // （如"点击全选以下消息"所在的分享面板容器），误关分享模式。精确定位走下方 evaluate 兜底。
      let selAllClicked = false;
      for (const sel of selectAllSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            await el.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(800);
            logger.info(`[${this.platformName}] 分享弹窗勾选全选: ${sel}`);
            selAllClicked = true;
            break;
          }
        } catch { /* 继续 */ }
      }
      // v1.9.10: 选择器兜底失败时，用 evaluate 扫描含"全选/点击全选以下消息"文本的元素并点击
      // v2.1.x: 修复「点到容器而非复选框」——元宝弹窗文案是"点击全选以下消息"所在的面板容器
      // 也含该文本，直接点容器会误关/误切换分享模式。改为只取「面积最小的叶子元素」
      // （复选框/开关 label），并用 tag+class 精确点击。
      if (!selAllClicked) {
        const selAllTarget = await page.evaluate(() => {
          // v2.2.x：元宝/豆包等平台"点击全选以下消息"的「全选」触发元素可能是 div/span
          // （文案挂在纯 div 上，不是 button/label/checkbox），旧候选列表漏掉导致永远点不到全选。
          // 扩大到 div/span，但用「面积最小 + 文本精确匹配 + 排除含子可点击元素的容器」来避免误点整个面板。
          const candidates = document.querySelectorAll('button, a, [role="button"], label, [class*="checkbox"], [class*="check"], [class*="switch"], [class*="select"], div, span');
          let best: HTMLElement | null = null;
          let bestArea = Infinity;
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i] as HTMLElement;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!t || (t !== '全选' && t !== '选择全部' && !t.includes('点击全选以下消息') && !t.includes('全部选中'))) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            const area = r.width * r.height;
            // 只取叶子级（自身文本短），避免点到容器
            if (t.length > 20 && !t.includes('点击全选以下消息')) continue;
            // 若候选内部还有更小的可点击子元素（含全选/勾选语义），跳过这个容器，取子元素
            const innerClickable = el.querySelectorAll('button, [role="button"], label, [class*="checkbox"], [class*="check"], [class*="switch"], input[type="checkbox"]');
            if (innerClickable.length > 0) {
              const anyVisible = Array.from(innerClickable).some(c => {
                const cr = (c as HTMLElement).getBoundingClientRect();
                const cs = window.getComputedStyle(c as HTMLElement);
                return cr.width > 0 && cr.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
              });
              if (anyVisible) continue;
            }
            if (area < bestArea) { bestArea = area; best = el; }
          }
          if (!best) return '';
          const cls = (best.getAttribute('class') || '').toString().split(' ')[0];
          return `${best.tagName.toLowerCase()}|${cls}|${(best.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12)}`;
        }).catch(() => '');
        if (selAllTarget) {
          try {
            const [tag, cls, txt] = selAllTarget.split('|');
            let el: any = null;
            if (cls) el = await page.$(`${tag}[class*="${cls}"]`).catch(() => null);
            if (!el && cls) el = await page.$(`[class*="${cls}"]`).catch(() => null);
            if (!el && txt) el = await page.$(`:text-is("${txt}")`).catch(() => null);
            if (el) {
              const visible = await el.isVisible().catch(() => false);
              if (visible) {
                await el.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(800);
                logger.info(`[${this.platformName}] 分享弹窗全选叶子元素点击: ${selAllTarget}`);
              }
            }
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }

    const menuSelectors = [
      'button:has-text("复制对话链接")',
      ':text-is("复制对话链接")',
      'button:has-text("复制链接")',
      ':text-is("复制链接")',
      '[class*="menu"] :text-is("复制链接")',
      '[class*="dropdown"] :text-is("复制链接")',
      '[class*="popover"] :text-is("复制链接")',
      '[class*="modal"] :text-is("复制链接")',
      '[role="menuitem"]:has-text("复制")',
      '[class*="dialog"] button:has-text("复制")',
      '[class*="modal"] button:has-text("复制")',
    ];
    for (const sel of menuSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          await el.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1500);
          logger.info(`[${this.platformName}] 二次点击分享菜单项成功: ${sel}`);
          return true;
        }
      } catch { /* 继续 */ }
    }

    // v1.9.6: 智谱/元宝等平台的分享面板是自绘弹层（class 不含 menu/dropdown/popover/modal），
    // 上方选择器匹配不到。改为扫描页面当前「所有可见按钮」，匹配含 复制/链接/link/copy 文本的，
    // 同时兼容图标按钮（aria-label/title 含 复制/分享链接）。
    // v1.9.10: 候选可能是含多个动作的整行容器（Kimi 实测 "编辑 复制 分享" 在同一个
    // segment-user-action-row 内），点整行会点到"编辑/复制"。优先返回行内文本恰为
    // "分享/Share/复制链接/复制" 的叶子子元素，确保点到正确的分享项。
    try {
      const scanResult = await page.evaluate(() => {
        const keywords = ['复制', '链接', 'copy', 'link', 'Copy', 'Link', '分享链接', '复制链接', '复制对话链接'];
        const btns = document.querySelectorAll('button, a[href], [role="button"], [class*="btn"], [class*="button"], [class*="item"], [class*="action"]');
        const results: string[] = [];
        for (let i = 0; i < btns.length && results.length < 12; i++) {
          const el = btns[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const cls = (el.className || '').toString();
          const combined = text + ' ' + aria + ' ' + title;
          // 只匹配"明确是分享/复制"的元素，避免误点「复制文本内容」等普通按钮
          const isShareCopy = /复制链接|复制对话链接|分享链接|复制链接|copy link|copylink|copy conversation|分享对话|生成分享链接/i.test(combined) ||
            (keywords.some(k => combined.includes(k)) && /分享|share/i.test(combined));
          if (!isShareCopy) continue;
          // 排除文案过长的普通按钮
          if (text.length > 15 && !/复制链接|分享链接|复制对话链接/.test(text)) continue;
          // v1.9.10: 若容器内有子元素文本恰为 分享/Share/复制链接/复制/Copy，优先返回子元素
          const leafTexts = ['分享', 'Share', '复制链接', '复制对话链接', '复制', 'Copy link', 'Copy'];
          let leaf: HTMLElement | null = null;
          const children = Array.from(el.querySelectorAll('*')) as HTMLElement[];
          for (let c = children.length - 1; c >= 0; c--) {
            const childText = (children[c].innerText || '').replace(/\s+/g, ' ').trim();
            if (leafTexts.includes(childText)) {
              const cr = children[c].getBoundingClientRect();
              if (cr.width > 0 && cr.height > 0) { leaf = children[c]; break; }
            }
          }
          const target = leaf || el;
          const tCls = (target.getAttribute('class') || target.className || '').toString();
          const tText = (target.innerText || '').replace(/\s+/g, ' ').trim();
          const tRect = target.getBoundingClientRect();
          results.push(`<${target.tagName.toLowerCase()} class="${tCls.slice(0, 40)}" aria="${target.getAttribute('aria-label') || ''}" text="${tText.slice(0, 20)}" pos=(${Math.round(tRect.left)},${Math.round(tRect.top)},${Math.round(tRect.width)}x${Math.round(tRect.height)})`);
        }
        return results;
      }).catch(() => []);
      if (scanResult.length > 0) {
        logger.warn(`[${this.platformName}] 分享面板按钮扫描找到 ${scanResult.length} 个候选，尝试逐个点击...`);
        for (const desc of scanResult.slice(0, 6)) {
          try {
            // 解析描述中的 class，构造选择器
            const clsMatch = desc.match(/class="([^"]*)"/);
            const txtMatch = desc.match(/text="([^"]*)"/);
            let target: any = null;
            if (clsMatch && clsMatch[1]) {
              const cls = clsMatch[1];
              // class 可能含特殊字符，用属性选择器
              target = await page.$(`[class*="${cls.split(' ')[0]}"]`).catch(() => null);
            }
            if (!target && txtMatch && txtMatch[1]) {
              // v1.9.10: 优先精确文本匹配（叶子元素），其次包含匹配
              target = await page.$(`:text-is("${txtMatch[1]}")`).catch(() => null);
            }
            if (!target && txtMatch && txtMatch[1]) {
              target = await page.$(`button:has-text("${txtMatch[1]}")`).catch(() => null);
            }
            if (target) {
              const visible = await target.isVisible().catch(() => false);
              if (!visible) continue;
              await target.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1500);
              logger.info(`[${this.platformName}] 分享面板按钮点击成功: ${desc}`);
              return true;
            }
          } catch { /* 继续 */ }
        }
      }
    } catch { /* 忽略 */ }

    // v1.9.9: 弹窗作用域扫描——先定位当前最大可见弹层（modal/dialog/popover/share/menu 中面积最大者），
    // 只在弹层内部找含 复制/链接/Copy 文案的按钮（含纯"复制"），避免误点页面其他地方的同名按钮。
    // 元宝/智谱的分享面板是自绘覆盖层，按钮可能是 div/span，且文案可能只有"复制"。
    // v1.9.10: 排除工具栏/全局的复制按钮（class 含 ToolbarCopy/toolbar-copy 的误点——元宝 ToolbarCopy_icon 是工具栏复制内容按钮，不是分享链接复制按钮）。
    try {
      const dialogBtn = await page.evaluate(() => {
        const floatings = document.querySelectorAll(
          '[class*="modal"], [class*="dialog"], [class*="popover"], [class*="popup"], [class*="overlay"], [class*="share"], [class*="menu"], [class*="panel"]'
        );
        let best: HTMLElement | null = null;
        let bestArea = 0;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        for (let i = 0; i < floatings.length; i++) {
          const el = floatings[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const area = rect.width * rect.height;
          // 排除占满全屏的底层容器（覆盖层），只取中部弹层
          if (area > bestArea && area < vw * vh * 0.95) {
            bestArea = area;
            best = el;
          }
        }
        if (!best) return '';
        // 在弹层内找 复制/链接 按钮
        const btns = best.querySelectorAll('button, a[href], [role="button"], [class*="btn"], [class*="button"], [class*="item"], [class*="action"], span, div');
        for (let j = 0; j < btns.length; j++) {
          const el = btns[j] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          // v1.9.10: 排除 toolbar/全局的复制按钮（class 含 ToolbarCopy/toolbar-copy 或其他全局复制按钮）
          const cls = (el.getAttribute('class') || el.className || '').toString();
          if (/ToolbarCopy|toolbar-?copy|toolbar_?copy/i.test(cls)) continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const combined = (text + ' ' + aria + ' ' + title).trim();
          if (!combined) continue;
          const isCopy = /^(复制|复制链接|复制对话链接|Copy|Copy Link|复制链接分享)$/i.test(combined) ||
            /复制链接|复制对话链接|copy link|Copy Link/i.test(combined) ||
            (/^(复制|Copy)$/i.test(combined) && rect.width < 200 && rect.height < 60);
          if (!isCopy) continue;
          // 只返回可定位的最小元素（叶子级：无子元素或子元素都不可见）
          const c = (el.getAttribute('class') || el.className || '').toString().slice(0, 40);
          return `${el.tagName.toLowerCase()}|${c.split(' ')[0]}|${text.slice(0, 15)}|${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }
        return '';
      }).catch(() => '');
      if (dialogBtn) {
        const [tag, cls, txt] = dialogBtn.split('|');
        logger.warn(`[${this.platformName}] 弹窗作用域找到复制按钮: <${tag} class="${cls}" text="${txt}">`);
        try {
          let target: any = null;
          if (cls) target = await page.$(`[class*="${cls}"]`).catch(() => null);
          if (!target && txt) target = await page.$(`:has-text("${txt}")`).catch(() => null);
          if (target) {
            const visible = await target.isVisible().catch(() => false);
            if (visible) {
              await target.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1500);
              logger.info(`[${this.platformName}] 弹窗作用域复制按钮点击成功: ${txt || cls || tag}`);
              return true;
            }
          }
        } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }

    // v1.9.6: 分享面板若直接展示链接 input（readonly），直接从面板中读值
    try {
      const linkVal = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[readonly], input[class*="link"], input[class*="url"], [class*="share-link"], [class*="link-input"], [class*="copy-link-input"]');
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i] as HTMLInputElement;
          const val = el.value || '';
          if (val && val.startsWith('http')) return val;
          const text = (el.textContent || '').trim();
          if (text.startsWith('http')) return text;
        }
        return '';
      }).catch(() => '');
      if (linkVal) {
        logger.info(`[${this.platformName}] 从分享面板链接输入框直接读取到: ${linkVal}`);
        // 尝试触发复制（点击链接 input 选中后 Ctrl+C 或直接返回链接）
        try {
          await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[readonly], input[class*="link"], input[class*="url"], [class*="share-link"]');
            for (let i = 0; i < inputs.length; i++) {
              const el = inputs[i] as HTMLInputElement;
              if (el.value && el.value.startsWith('http')) {
                el.focus();
                el.select();
                break;
              }
            }
          }).catch(() => {});
          await page.keyboard.press('Control+C').catch(() => {});
          await page.waitForTimeout(1000);
        } catch { /* 忽略 */ }
        // 返回读到的链接（上层会做 URL 匹配校验）
        return true;
      }
    } catch { /* 忽略 */ }

    // v1.9.7: 分享面板结构诊断升级——找不到复制链接时，转储「页面所有可见可点击元素」，
    // 暴露真实分享面板按钮（智谱/元宝分享面板可能是自绘覆盖层，class 不含 menu/modal/dialog）
    // v1.9.8: 按 z-index 排序 + 过滤屏幕中部元素，跳过侧边栏/导航噪音（上一版被侧边栏图标占满）
    // v1.9.9: 过滤左侧边栏区域（x<260，元宝/智谱/千问侧边栏图标 z=0 占满 top-30），
    //         并扩大采样到前 40 个，让分享弹窗按钮浮出水面。
    try {
      const allBtnDump = await page.evaluate(() => {
        const results: Array<{ z: number; desc: string }> = [];
        const els = document.querySelectorAll('button, a[href], [role="button"], [class*="btn"], [class*="icon"], [class*="action"], [class*="item"], [class*="link"], [class*="copy"], [class*="share"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"]');
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        for (let i = 0; i < els.length; i++) {
          const el = els[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.width < 16 || rect.height < 16) continue;
          // v1.9.9: 排除左侧边栏区域（多数平台侧边栏宽度 <260px）
          if (rect.left < 260 && rect.left + rect.width < 260) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          // 排除完全在视口外的元素
          if (rect.left > vw || rect.top > vh || rect.right < 0 || rect.bottom < 0) continue;
          const z = Number(style.zIndex) || 0;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 14);
          const cls = (el.className || '').toString().slice(0, 40);
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const tid = el.getAttribute('data-testid') || '';
          results.push({ z, desc: `<${el.tagName.toLowerCase()} z=${z} class="${cls}" aria="${aria.slice(0, 18)}" title="${title.slice(0, 18)}" tid="${tid.slice(0, 18)}" text="${text}" pos=(${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)})` });
        }
        // 按 z-index 降序，取前 40
        results.sort((a, b) => b.z - a.z);
        return results.slice(0, 40).map(r => r.desc).join(' | ');
      }).catch(() => '');
      if (allBtnDump) {
        logger.warn(`[${this.platformName}] 页面可点击元素按z-index转储(前40,过滤左侧边栏): ${allBtnDump}`);
      }
    } catch { /* 忽略 */ }

    // v1.9.5: 未找到菜单项时转储页面上新出现的浮层/菜单元素，辅助定位各平台分享面板结构
    try {
      const dump = await page.evaluate(() => {
        const results: string[] = [];
        const floatings = document.querySelectorAll(
          '[class*="menu"], [class*="dropdown"], [class*="popover"], [class*="modal"], [class*="dialog"], [role="menu"], [role="dialog"]'
        );
        for (let i = 0; i < floatings.length && results.length < 6; i++) {
          const el = floatings[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          results.push(`<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 50)}" text="${text}">`);
        }
        return results.join(' | ');
      }).catch(() => '');
      if (dump) {
        logger.warn(`[${this.platformName}] 未找到"复制链接"菜单项，当前可见浮层/菜单: ${dump}`);
      } else {
        logger.warn(`[${this.platformName}] 未找到"复制链接"菜单项，且无可见浮层/菜单（分享按钮可能未弹出面板）`);
      }
    } catch { /* 忽略 */ }
    return false;
  }

  async query(page: Page, keyword: string): Promise<QueryResult> {
    // 导航到聊天页（新对话）
    // 使用 networkidle 等待 SPA 页面 JS 渲染完成（比 domcontentloaded 更可靠）
    try {
      await page.goto(this.chatUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // networkidle 超时（部分平台长连接不会 idle），降级为 domcontentloaded
      await page.goto(this.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(3000); // 等待 SPA 渲染完成

    // ============ 登录状态检查 ============
    // 如果账号未登录/storageState 过期，页面会被重定向到登录页或营销首页
    // 此时不应继续等待输入框（必然超时），而是直接抛异常让上层标记账号 offline
    let currentUrl = page.url();
    let pageTitle = await page.title().catch(() => '');

    // 检查1: URL 是否包含登录关键词（被重定向到登录页）
    const urlLower = currentUrl.toLowerCase();
    if (urlLower.includes('login') || urlLower.includes('sign_in') || urlLower.includes('signin')) {
      throw new Error(`登录态失效: 页面被重定向到登录页 (URL=${currentUrl})`);
    }

    // 先执行 afterNavigate（让子类有机会点击"开始对话"等入口按钮进入 /chat 路径）
    // 注意：必须在检查1.5（重定向检测）之前执行，否则像文心一言这样登录后停在首页、
    // 需要点击"开始对话"按钮才能进入 /chat 路径的平台，会被检查1.5 误判为登录态失效
    await this.afterNavigate(page);

    // afterNavigate 后重新获取 URL 和标题（可能已经从首页跳转到 /chat）
    currentUrl = page.url();
    pageTitle = await page.title().catch(() => '');

    // 检查1.6: 游客模式检测（v1.9.1 阻塞式）
    // 千问/Kimi 等平台登录态失效后 URL 不变、不重定向，而是渲染游客首页
    // （游客首页也有输入框，能输入能回车，但查询不会真正执行）
    // 游客首页特征元素已登录时不显示，命中即判定登录态失效，防止抓首页文本产生垃圾记录
    if (await this.detectGuestMode(page)) {
      throw new Error(`登录态失效: 页面为游客模式首页（检测到未登录特征元素，URL=${currentUrl}）`);
    }

    // 检查1.5: 重定向检测——非阻塞式警告
    // 如果 chatUrl 含特定路径（如 /chat）但导航后 URL 路径为根 / 或空，
    // 说明被重定向到营销首页。但不立即抛异常，而是记录警告并继续流程。
    // 原因：很多平台首页本身就含聊天输入框（如 DeepSeek），即使被重定向也能正常查询。
    // 如果账号真的未登录，后续"等待输入框"会失败，抛"输入框未找到"（属于"其他失败"，
    // 不标记 offline），账号继续可用，下次重试。
    // 这避免了"重定向到首页=登录态失效"的误判，同时不损失对真正未登录账号的容错。
    try {
      const chatUrlObj = new URL(this.chatUrl);
      const chatPath = chatUrlObj.pathname.replace(/\/+$/, ''); // 去掉末尾斜杠
      if (chatPath && chatPath !== '/') {
        const currentUrlObj = new URL(currentUrl);
        const currentPath = currentUrlObj.pathname.replace(/\/+$/, '');
        if (currentPath === '' || currentPath === '/') {
          // 记录警告但不抛异常，让流程继续到"等待输入框"
          console.log(`[${this.platformName}] 警告: 页面被重定向到首页 (期望=${this.chatUrl}, 实际=${currentUrl}, title=${pageTitle})，继续尝试查找输入框`);
        }
      }
    } catch {
      // URL 解析失败，继续其他检查
    }

    // 检查2: 页面是否有明显的登录按钮——非阻塞式警告
    // 仅在 URL 路径为根 /（疑似被重定向到首页）时才执行检测
    // 但不抛异常，改为记录警告并继续流程。原因：
    // 1. 很多平台首页即使已登录也显示"登录"按钮（如通义千问）
    // 2. 二次校验选择器可能不匹配某些平台的已登录标志，导致误判
    // 3. 如果账号真的未登录，后续"等待输入框"会失败，抛"输入框未找到"（不标记 offline）
    let currentPathForCheck2 = '';
    try {
      currentPathForCheck2 = new URL(currentUrl).pathname.replace(/\/+$/, '');
    } catch {}

    const isOnExpectedPage = currentPathForCheck2 !== '' && currentPathForCheck2 !== '/';

    if (!isOnExpectedPage) {
      const hasLoginButton = await page.evaluate(() => {
        const loginTexts = ['登录', '登 录', 'Sign in', 'Sign In', 'Log in', 'Log In', '登录/注册'];
        const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (loginTexts.some(lt => text === lt || text.includes(lt))) {
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (hasLoginButton) {
        // 二次校验：检查是否有已登录标志
        const hasLoggedInIndicator = await page.evaluate(() => {
          const loggedInSelectors = [
            '[class*="avatar"]', '[class*="Avatar"]',
            '[class*="user-info"]', '[class*="userInfo"]', '[class*="user-menu"]', '[class*="userMenu"]',
            '[class*="nickname"]', '[class*="userName"]', '[class*="user-name"]',
            '[class*="account"]', '[class*="profile"]',
            'img[class*="avatar"]', 'img[class*="Avatar"]',
            'button:has-text("退出")', 'a:has-text("退出")', 'button:has-text("登出")', 'a:has-text("登出")',
          ];
          for (const sel of loggedInSelectors) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return true;
                }
              }
            } catch {
              // 继续
            }
          }
          try {
            const tokens = ['token', 'Token', 'access_token', 'accessToken', 'userToken', 'userInfo', 'user_info', 'loginState', 'isLogin'];
            for (const key of tokens) {
              if (localStorage.getItem(key) || sessionStorage.getItem(key)) {
                return true;
              }
            }
          } catch {
            // 继续
          }
          return false;
        }).catch(() => false);

        if (!hasLoggedInIndicator) {
          // 记录警告但不抛异常，让流程继续到"等待输入框"
          console.log(`[${this.platformName}] 警告: 页面检测到登录按钮但未找到已登录标志 (URL=${currentUrl}, title=${pageTitle})，继续尝试查找输入框`);
        }
      }
    }

    // 等待输入框出现（带重试机制）
    let activeSelector = this.inputSelector;
    let inputFound = false;

    // 第一轮：主选择器 + 回退选择器
    // 包含 Slate.js 编辑器选择器（文心一言等平台使用 data-slate-node="element"）
    // 包含 CSS Module 哈希类名选择器（DeepSeek 等平台使用 _xxxxxx 类名）
    const fallbackSelectors = [
      this.inputSelector,
      'textarea',
      'div[contenteditable="true"]',
      '[contenteditable]:not([contenteditable="false"])',
      'div[data-slate-node="element"]',
      '[data-slate-node="element"]',
      '#chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      '[class*="input-area"] textarea',
      '[class*="input-area"] [contenteditable]:not([contenteditable="false"])',
      'div[class] textarea',
      '[role="textbox"]',
      '[class*="editor"]',
      '[class*="prompt"] textarea',
      '[class*="prompt"] [contenteditable]:not([contenteditable="false"])',
      'form textarea',
      'form [contenteditable]:not([contenteditable="false"])',
    ];

    for (const selector of fallbackSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
        activeSelector = selector;
        inputFound = true;
        if (selector !== this.inputSelector) {
          console.log(`[${this.platformName}] 主选择器超时，使用回退选择器: ${selector}`);
        }
        break;
      } catch {
        // 继续尝试下一个
      }
    }

    // 第二轮：如果还没找到，等待5秒后重试一次（部分 SPA 需要更长时间渲染）
    if (!inputFound) {
      console.log(`[${this.platformName}] 第一轮选择器全部超时，等待5秒后重试...`);
      await page.waitForTimeout(5000);
      for (const selector of fallbackSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
          activeSelector = selector;
          inputFound = true;
          console.log(`[${this.platformName}] 第二轮重试找到选择器: ${selector}`);
          break;
        } catch {
          // 继续
        }
      }
    }

    // 第三轮：用 indexedInteractor 的 smartFindInputElement 兜底扫描页面所有可见可交互元素
    // 解决 DeepSeek/通义千问等平台偶发 textarea 不可见但页面有其他可输入元素的问题
    if (!inputFound) {
      console.log(`[${this.platformName}] 两轮选择器全部失败，启用 smartFindInputElement 兜底扫描...`);
      try {
        const smartEl = await smartFindInputElement(page);
        if (smartEl) {
          console.log(`[${this.platformName}] smartFindInputElement 找到可输入元素，使用 click+type 输入`);
          await smartEl.click({ timeout: 5000 }).catch(() => {});
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Delete');
          await page.keyboard.type(keyword, { delay: 50 });
          await randomDelay(500, 1500);
          await page.keyboard.press('Enter');
          // 等待 AI 回答完成
          await this.waitForResponse(page);
          // 提取内容
          const { text, html } = await this.extractContent(page);
          const rawShareUrl = await this.extractShareLink(page);
          // v1.9: 分享链接公开性验证——无登录访客看不到内容的链接判定为私有，降级静态页
          const shareUrl = rawShareUrl ? await this.verifyShareLinkPublic(page, rawShareUrl, text) : null;
          return {
            content: text,
            shareUrl,
            htmlContent: html,
            supportsShare: this.supportsShare,
          };
        }
      } catch (e: any) {
        console.log(`[${this.platformName}] smartFindInputElement 兜底失败: ${e.message}`);
      }
    }

    if (!inputFound) {
      // 输出页面 URL 和标题辅助排查
      const url = page.url();
      const title = await page.title().catch(() => '未知');
      throw new Error(`输入框未找到: 主选择器(${this.inputSelector})及所有回退选择器均超时 (URL=${url}, title=${title})`);
    }

    // 清空输入框并填入关键词（v1.3+ 行为人性化：逐字符输入 + 随机间隔）
    // 部分平台 fill 失败（如 contenteditable），降级为 humanType
    try {
      // 优先用 humanType 逐字符输入（反检测核心：避免瞬时输入被识别为自动化）
      const inputEl = await page.$(activeSelector);
      if (inputEl) {
        await humanType(page, inputEl, keyword, { clear: true });
      } else {
        // 兜底：fill + 固定 delay
        await page.fill(activeSelector, '');
        await page.fill(activeSelector, keyword);
      }
    } catch {
      console.log(`[${this.platformName}] humanType 失败，降级为 fill+type`);
      try {
        await page.fill(activeSelector, '');
        await page.fill(activeSelector, keyword);
      } catch {
        await page.click(activeSelector).catch(() => {});
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(keyword, { delay: 50 });
      }
    }
    // v3.19.x: 输入后校验——contenteditable/React 受控组件上 humanType 可能静默失败
    // （键盘逐字符输入不触发输入的 onChange），导致输入框实际为空、发送按钮 disabled、
    // 查询未真正发送（纳米日志"发送按钮 cursor-not-allowed"、内容 139 字符即此根因）。
    // 【重要 v3.19.x】只在校验到"输入框为空/不含关键词"时才注入；读值非空时不重写。
    //   之前对 contenteditable 一律强制派发 input/change 事件，误伤了千问/Kimi/元宝等
    //   正常 contenteditable 平台（千问内容被破坏到 11 字符）。contenteditable 读值非空
    //   但发送按钮 disabled 的专项处理，放到各平台自己的 submitInput（如纳米）里做。
    try {
      const typedValue = await this.readInputValue(page, activeSelector);
      if (!typedValue || !typedValue.includes(keyword.trim())) {
        logger.warn(`[${this.platformName}] humanType 后输入框未写入关键词（读值="${typedValue.slice(0, 30)}"），用 evaluate 直接注入`);
        await page.evaluate(({ sel, kw }: { sel: string; kw: string }) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return;
          const isTextarea = el.tagName === 'TEXTAREA';
          const isInput = el.tagName === 'INPUT';
          if (isTextarea || isInput) {
            // React 受控组件需用原生 value setter + input 事件
            const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, kw);
            else (el as any).value = kw;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            // contenteditable：设置 textContent + input 事件
            el.textContent = kw;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: kw }));
          }
          (el as HTMLElement).focus();
        }, { sel: activeSelector, kw: keyword });
        await page.waitForTimeout(500);
      }
    } catch { /* 校验失败不阻塞主流程 */ }
    // 提交前随机停顿（模拟人类思考）
    await humanDelay('medium');

    // 提交（v1.9.3：改为钩子方法，豆包等平台需要点击发送按钮而非按 Enter）
    await this.submitInput(page, activeSelector);

    // v1.9.4: 提交结果验证——输入框未清空说明查询未真正发送，Enter 兜底重发/抛错
    await this.verifySubmission(page, activeSelector, keyword);

    // 等待 AI 回答完成
    await this.waitForResponse(page);

    // 提取内容
    let { text, html } = await this.extractContent(page);

    // v1.9.4: 内容过短（<200字符）可能是回答仍在流式生成或提取时机过早，
    // 等待 15 秒后重新提取一次，取更长的结果（智谱实测 162 字符即问题复现）
    if (text.trim().length < 200) {
      console.warn(`[${this.platformName}] 首次提取内容过短(${text.trim().length}字符)，等待15秒后重试提取...`);
      await page.waitForTimeout(15000);
      try {
        const retry = await this.extractContent(page);
        if (retry.text.trim().length > text.trim().length) {
          text = retry.text;
          html = retry.html;
        }
      } catch {
        /* 重试失败保留首次结果 */
      }
    }

    // ============ 侧边栏文本污染校验（v1.9.3 重要）============
    // 实地诊断（2026-08-16 豆包）：提交失败（如豆包需点发送按钮而非 Enter）时
    // AI 回答从未生成，extractContent 兜底抓到侧边栏+历史会话列表文本入库，
    // 历史标题含品牌词导致大量假命中。命中 2 个以上框架标记即判定为污染，抛错不入库
    const markerHits = this.sidebarMarkers.filter(m => text.includes(m)).length;
    if (markerHits >= 2) {
      throw new Error(`内容提取异常: 抓取到页面框架/侧边栏文本（命中${markerHits}个标记），AI 回答可能未生成 (内容长度=${text.trim().length})`);
    }

    const rawShareUrl = await this.extractShareLink(page);
    // v1.9: 分享链接公开性验证——无登录访客看不到内容的链接判定为私有，降级静态页
    const shareUrl = rawShareUrl ? await this.verifyShareLinkPublic(page, rawShareUrl, text) : null;

    // ============ 账号异常检测（v1.8+ 重要）============
    // 查询成功但内容异常短，通常意味着账号登录态失效或 token 过期
    // 之前 bug：这种情况被当作正常查询成功处理，只在日志中通过"内容长度=12"间接体现
    // 现在改为明确检测并抛出异常，让上层标记账号 offline
    const anomaly = await this.detectAccountAnomaly(page, text);
    if (anomaly) {
      throw new Error(anomaly);
    }

    return {
      content: text,
      shareUrl,
      htmlContent: html,
      supportsShare: this.supportsShare,
    };
  }

  /**
   * 检测账号异常（登录态失效、token 过期、被封禁等）
   *
   * 触发条件：内容长度 < 200 字符（正常 AI 回答至少 500+ 字符）
   * 检测策略：
   * 1. 页面文本包含明确的登录失效/token 过期关键词 → 抛"登录态失效"
   * 2. 内容极短（< 50 字符）且不含查询关键词 → 抛"账号异常：内容过短"
   * 3. 页面 URL 被重定向到登录页 → 抛"登录态失效"
   *
   * @returns 错误消息（如"登录态失效: token 过期"）或 null（正常）
   */
  protected async detectAccountAnomaly(page: Page, content: string): Promise<string | null> {
    const contentLen = content.trim().length;

    // ===== 0. 风控验证码检测（v1.9.2，与内容长度无关）=====
    // 实地诊断（2026-08-16 纳米）：查询频率过高触发拼图验证，AI 回答被拦截，
    // 此时页面文本是智能体广场/框架文本（400+ 字符），能通过原有长度检查混入正常记录
    try {
      const pageText0 = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '').catch(() => '');
      const captchaKeywords = ['拼图验证', '请完成下方拼图验证', '频繁使用，需要验证', '请完成安全验证', '拖动滑块', '人机验证'];
      for (const kw of captchaKeywords) {
        if (pageText0.includes(kw)) {
          const msg = `触发风控验证码: 检测到"${kw}"，查询被平台拦截`;
          console.warn(`[${this.platformName}] ⚠️ ${msg}`);
          return msg;
        }
      }
    } catch { /* 忽略 evaluate 失败 */ }

    // 正常内容长度（> 200 字符）直接放行
    if (contentLen >= 200) return null;

    // ===== 1. 检测页面中的登录失效/token 过期关键词 =====
    try {
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '').catch(() => '');
      const pageLower = pageText.toLowerCase();

      // 明确的登录失效关键词
      const loginExpiredKeywords = [
        'token is expired', 'token expired', '登录已失效', '登录失效',
        '请重新登录', '请先登录', '未登录', 'login expired',
        '会话已过期', 'session expired', '认证失败', 'authentication failed',
        '请扫码登录', '请登录后',
      ];
      for (const kw of loginExpiredKeywords) {
        if (pageLower.includes(kw.toLowerCase())) {
          const msg = `登录态失效: 检测到页面关键词"${kw}" (内容长度=${contentLen})`;
          console.warn(`[${this.platformName}] ⚠️ ${msg}`);
          return msg;
        }
      }

      // 智谱AI 特有：token 过期会显示"本次回答已被终止 重新回答"
      // Kimi 特有：登录态失效会显示"© 2026 北京月之暗面科技有限公司"页脚
      // 这些是平台特定的登录失效信号
      const platformSignals: Record<string, string[]> = {
        '智谱AI': ['本次回答已被终止', 'token is expired', 'ChatGLM语音梦幻杰'],
        'Kimi': ['北京月之暗面科技有限公司', '京ICP备'],
        '豆包': ['登录抖音', '请登录', '未登录'],
        '通义千问': ['请登录', '登录阿里', '未登录'],
        '腾讯元宝': ['请登录', '登录腾讯', '未登录'],
        '文心一言': ['请登录', '登录百度', '未登录'],
        'DeepSeek': ['sign in', 'sign_in', '请登录'],
        '纳米': ['请登录', '360登录', '未登录'],
      };
      const signals = platformSignals[this.platformName] || [];
      for (const sig of signals) {
        if (pageText.includes(sig)) {
          const msg = `登录态失效: 检测到平台信号"${sig}" (内容长度=${contentLen})`;
          console.warn(`[${this.platformName}] ⚠️ ${msg}`);
          return msg;
        }
      }
    } catch { /* 忽略 evaluate 失败 */ }

    // ===== 2. 检测页面 URL 被重定向到登录页 =====
    try {
      const currentUrl = page.url().toLowerCase();
      if (currentUrl.includes('login') || currentUrl.includes('sign_in') || currentUrl.includes('signin')) {
        const msg = `登录态失效: 查询后页面被重定向到登录页 (URL=${page.url()}, 内容长度=${contentLen})`;
        console.warn(`[${this.platformName}] ⚠️ ${msg}`);
        return msg;
      }
    } catch { /* 忽略 */ }

    // ===== 3. 内容极短但未检测到明确信号 → 仍标记为可疑 =====
    // 内容 < 50 字符，几乎可以肯定不是正常的 AI 回答
    if (contentLen < 50) {
      const preview = content.trim().substring(0, 50).replace(/\n/g, ' ');
      const msg = `账号异常：内容过短(${contentLen}字符) 预览="${preview}" 可能登录态失效或token过期`;
      console.warn(`[${this.platformName}] ⚠️ ${msg}`);
      return msg;
    }

    // 内容 50-200 字符，可能是占位符或错误提示，记录警告但不抛异常
    if (contentLen < 200) {
      const preview = content.trim().substring(0, 80).replace(/\n/g, ' ');
      console.warn(`[${this.platformName}] ⚠️ 内容较短(${contentLen}字符) 预览="${preview}" 可疑，但未达到异常阈值`);
    }

    return null;
  }

  /**
   * 从分享对话框提取链接的通用实现（不依赖 clipboard）
   * 策略：点击分享按钮 → 等待对话框 → 多策略查找URL → 关闭对话框
   * 子类可覆盖 extractShareLink 实现具体逻辑，或直接调用此方法
   */
  protected async extractShareLinkFromDialog(
    page: Page,
    shareBtnSelector: string,
    dialogSelector: string
  ): Promise<string | null> {
    let dialogOpened = false;
    try {
      // 1. 查找并点击分享按钮
      const shareBtn = await page.$(shareBtnSelector);
      if (!shareBtn) return null;
      await shareBtn.click({ timeout: 3000 }).catch(() => {});

      // 2. 等待对话框出现（最多3秒）
      try {
        await page.waitForSelector(dialogSelector, { timeout: 3000, state: 'visible' });
        dialogOpened = true;
      } catch {
        return null;
      }

      // 3. 多策略查找分享URL
      let shareUrl: string | null = null;

      // 策略1: readonly input 或 share-link input 的值
      if (!shareUrl) {
        const linkInput = await page.$(
          `${dialogSelector} input[readonly], ${dialogSelector} input[class*="share"], ${dialogSelector} input[class*="link"], ${dialogSelector} input[class*="url"], ${dialogSelector} [class*="share-link"], ${dialogSelector} [class*="link-input"]`
        ).catch(() => null);
        if (linkInput) {
          const val = await linkInput.inputValue().catch(() => '');
          if (val && val.startsWith('http')) shareUrl = val;
          if (!shareUrl) {
            const text = await linkInput.textContent().catch(() => '');
            if (text && text.trim().startsWith('http')) shareUrl = text.trim();
          }
        }
      }

      // 策略2: 任意包含 http 值的 input
      if (!shareUrl) {
        const inputs = await page.$(`${dialogSelector} input`).catch(() => null);
        if (inputs) {
          const allInputs = await page.$$(`${dialogSelector} input`);
          for (const inp of allInputs) {
            const val = await inp.inputValue().catch(() => '');
            if (val && val.startsWith('http')) { shareUrl = val; break; }
          }
        }
      }

      // 策略3: 锚点 href 包含分享标识
      if (!shareUrl) {
        const link = await page.$(
          `${dialogSelector} a[href*="/share"], ${dialogSelector} a[href*="/c/"], ${dialogSelector} a[href*="conversation"], ${dialogSelector} a[href*="chat"]`
        ).catch(() => null);
        if (link) {
          const href = await link.getAttribute('href').catch(() => '');
          if (href) {
            if (href.startsWith('http')) shareUrl = href;
            else if (href.startsWith('/')) shareUrl = new URL(href, page.url()).href;
          }
        }
      }

      // 策略4: 对话框文本中匹配 URL
      if (!shareUrl) {
        const dialogText = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el?.textContent || '';
        }, dialogSelector).catch(() => '');
        const urlMatch = dialogText.match(/https?:\/\/[^\s<>"']+/);
        if (urlMatch) shareUrl = urlMatch[0];
      }

      return shareUrl;
    } catch {
      return null;
    } finally {
      // 关闭对话框（Escape 或点击遮罩/关闭按钮）
      if (dialogOpened) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
      }
    }
  }

  /**
   * v1.9: 分享链接公开可见性验证
   *
   * 背景：豆包/腾讯元宝等平台的分享链接策略收紧——分享页需要登录才能查看内容，
   * 未登录访客打开只看到页面框架（菜单栏/工具栏/UI元素），看不到 AI 回答。
   * Worker 用登录态捕获到的链接对客户（未登录）无效。
   *
   * 策略：用无登录态的干净 BrowserContext 打开分享链接（模拟客户视角），
   * 检查页面是否包含回答内容的验证片段：
   * - 包含 → 链接公开有效，返回链接
   * 不包含（重试1次后仍失败）→ 判定为私有链接，返回 null（云端自动生成静态页兜底）
   * - 验证流程自身异常 → 信任链接（不阻塞主流程）
   *
   * 子类可通过 verifyShareLink = false 关闭（如已知分享必然公开的平台）
   */
  protected verifyShareLink = true;

  protected async verifyShareLinkPublic(page: Page, shareUrl: string, content: string): Promise<string | null> {
    if (!this.verifyShareLink) return shareUrl;

    const snippet = this.extractVerifySnippet(content);
    // v1.9.11: 同时提取回答开头片段作兜底校验（部分分享页 markdown 渲染差异导致中段片段不匹配）
    const headSnippet = this.extractVerifySnippet(content, 'head');
    if (!snippet && !headSnippet) {
      // 内容太短无法提取验证片段，信任链接
      return shareUrl;
    }

    let ctx: any = null;
    try {
      const browser = page.context().browser();
      if (!browser) return shareUrl;

      // 无 storageState 的干净 context = 未登录访客视角
      ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // 拦截图片/字体/媒体资源，降低内存与流量开销
      await ctx.route(
        '**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm}',
        (route: any) => route.abort().catch(() => {})
      );
      const p = await ctx.newPage();

      let pageTextHead = '';
      // v1.9.11: 3 次尝试，每次等待 5 秒（SPA 渲染 + 分享链接延迟生效）
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await p.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await p.waitForTimeout(5000); // 等待 SPA 渲染
          const bodyText = await p.evaluate(() =>
            (document.body?.innerText || '').replace(/\s+/g, '')
          ).catch(() => '');
          if (snippet && bodyText.includes(snippet)) {
            logger.info(`[${this.platformName}] 分享链接验证通过(公开可见): ${shareUrl}`);
            return shareUrl;
          }
          if (headSnippet && bodyText.includes(headSnippet)) {
            logger.info(`[${this.platformName}] 分享链接验证通过(开头片段,公开可见): ${shareUrl}`);
            return shareUrl;
          }
          if (attempt === 0) pageTextHead = bodyText.replace(/\s+/g, ' ').slice(0, 120);
        } catch (e: any) {
          if (attempt === 2) logger.warn(`[${this.platformName}] 分享链接验证访问失败: ${e.message}`);
        }
      }

      logger.warn(`[${this.platformName}] 分享链接验证失败(未登录访客看不到内容，判定私有链接，降级静态页): ${shareUrl}${pageTextHead ? ` | 页面文本开头="${pageTextHead}"` : ''}`);
      return null;
    } catch (e: any) {
      // 验证流程自身异常（无法创建 context 等），信任链接不阻塞主流程
      logger.warn(`[${this.platformName}] 分享链接验证流程异常(信任链接): ${e.message}`);
      return shareUrl;
    } finally {
      await ctx?.close().catch(() => {});
    }
  }

  /** 从回答内容提取验证片段：默认取中段 40 字符，mode=head 取开头 40 字符（去空白和 markdown 符号） */
  private extractVerifySnippet(content: string, mode: 'middle' | 'head' = 'middle'): string | null {
    const clean = content.replace(/\s+/g, '').replace(/[#*`>\[\]()~|]/g, '');
    if (clean.length < 60) return null;
    if (mode === 'head') {
      return clean.substring(0, 40);
    }
    const start = Math.floor(clean.length * 0.3);
    return clean.substring(start, start + 40);
  }

  /**
   * 检查当前页面URL是否本身就是分享URL
   *
   * v1.9 重要修正：移除了所有「私有对话URL」模式（/chat/{id}、/c/{id}、/chats/{id}、
   * conversationId/chatId/sessionId 查询参数等）。这些对话URL只有登录账号本人可见，
   * 未登录访客打开只显示页面框架（菜单栏/工具栏），历史上导致了大量坏链。
   * 仅保留显式分享操作的 URL 模式（/share/、/artifactShare/、shareId=）。
   */
  protected async getCurrentPageShareUrl(page: Page): Promise<string | null> {
    try {
      const url = page.url();
      // 排除登录页/首页
      if (!url.startsWith('http') || url.includes('login') || url.includes('sign_in')) {
        return null;
      }

      // 仅匹配显式分享 URL 模式（对未登录访客公开）
      const sharePatterns = [
        // 通义千问: /share/chat/{id} 或 ?shareId={UUID}
        /\/share\/chat\/[a-zA-Z0-9_-]{8,}/,
        /[?&]shareId=[a-zA-Z0-9-]{8,}/,
        // 文心一言: /artifactShare/{短码}
        /\/artifactShare\/[a-zA-Z0-9_-]{4,}/,
        // 纳米: /share/{type}?id={shareId}
        /\/share\/[a-zA-Z0-9_-]+\?id=[a-zA-Z0-9_-]{4,}/,
        // 通用显式分享: /share/{token}（DeepSeek/Kimi/智谱/豆包，点击分享按钮后生成）
        /\/share\/[a-zA-Z0-9_-]{8,}/,
      ];

      for (const pattern of sharePatterns) {
        if (pattern.test(url)) {
          return url;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 默认实现：尝试从当前页面URL获取（部分平台URL即分享链接）
    return this.getCurrentPageShareUrl(page);
  }

  /**
   * 注入 clipboard + execCommand 拦截，捕获复制到剪贴板的分享 URL
   * 所有适配器的 extractShareLink 都应在点击分享按钮前调用此方法
   *
   * @param urlPatterns URL 匹配模式数组（如 ['/share/', 'kimi.com']），匹配其中一个即认为捕获成功
   */
  protected async injectClipboardInterceptor(page: Page, urlPatterns: string[]): Promise<void> {
    await page.evaluate((patterns: string[]) => {
      (window as any).__capturedShareUrl__ = null;
      (window as any).__lastClipboardText__ = null;
      const record = (text: unknown) => {
        if (typeof text !== 'string' || !text) return;
        (window as any).__lastClipboardText__ = text;
        if (patterns.some(p => text.includes(p))) {
          (window as any).__capturedShareUrl__ = text;
        }
      };
      const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text: string) => {
        // v1.9.12: 始终记录最后一次复制文本（诊断用），匹配模式才标记为分享链接
        record(text);
        return origWrite(text);
      };
      // v1.9.13: 拦截 navigator.clipboard.write()（ClipboardItem 方式）。
      //   豆包/Kimi 等平台"复制链接"可能用 write([new ClipboardItem({'text/plain': blob})])，
      //   旧版只拦 writeText/execCommand 导致"点了复制但剪贴板零捕获"。
      const origWriteItems = navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = async (items: any) => {
        try {
          if (Array.isArray(items)) {
            for (const it of items) {
              if (it && typeof it.getType === 'function') {
                try {
                  const blob = await it.getType('text/plain');
                  if (blob && typeof blob.text === 'function') {
                    record(await blob.text());
                  }
                } catch { /* 无 text/plain 类型 */ }
              } else if (it && typeof it === 'object') {
                const data = (it as any)['text/plain'];
                if (data instanceof Blob) record(await data.text());
                else if (typeof data === 'string') record(data);
              }
            }
          }
        } catch { /* 忽略 */ }
        return origWriteItems(items);
      };
      const origExec = document.execCommand.bind(document);
      document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const selection = window.getSelection();
          const selText = selection ? selection.toString() : '';
          record(selText);
        }
        return origExec(cmd);
      };
      // v1.9.13: copy 事件兜底——应用可能在 copy 处理器里用 clipboardData.setData() 填充分享链接
      document.addEventListener('copy', (e: Event) => {
        try {
          const cd = (e as ClipboardEvent).clipboardData;
          if (cd && typeof cd.getData === 'function') {
            record(cd.getData('text/plain'));
          }
        } catch { /* 忽略 */ }
        const selection = window.getSelection();
        record(selection ? selection.toString() : '');
      });
      // v3.20.x: XHR 响应 URL 扫描——豆包/元宝等平台"复制链接"不走标准剪贴板
      // （React 闭包缓存了原生 writeText 引用，覆写 navigator.clipboard 拦截不到），
      // 而是调用后端 API 生成分享链接（如豆包 /share/save 返回 share_url）。
      // 扫描所有 XHR 响应体中的 https URL，命中 urlPatterns（/s/、/thread/ 等）即记录，
      // 与剪贴板拦截互补，覆盖"API 生成链接"类平台的分享提取。
      const _open = XMLHttpRequest.prototype.open;
      (XMLHttpRequest.prototype as any).open = function (this: any, m: string, u: string) {
        this.__u = u;
        return _open.apply(this, arguments as any);
      };
      const _send = XMLHttpRequest.prototype.send;
      (XMLHttpRequest.prototype as any).send = function (this: any, b: any) {
        const xhr = this;
        const _o = xhr.onreadystatechange;
        xhr.onreadystatechange = function (this: any) {
          if (xhr.readyState === 4) {
            try {
              const t = xhr.responseText || '';
              if (t && t.length < 100000) {
                const urls = t.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
                for (let ui = 0; ui < urls.length; ui++) {
                  if (patterns.some(p => urls[ui].includes(p))) {
                    record(urls[ui]);
                    break;
                  }
                }
              }
            } catch { /* 忽略 */ }
          }
          if (_o) return (_o as any).apply(this, arguments as any);
        };
        return _send.apply(this, arguments as any);
      };
      // v3.20.x: fetch 响应 URL 扫描——元宝等平台"复制链接"用 fetch 而非 XHR 调用分享 API，
      // 只 hook XHR 扫不到。用 response.clone() 读取响应体，不破坏原响应流。
      const _fetch = window.fetch;
      if (typeof _fetch === 'function') {
        window.fetch = function (this: any, input: any, init?: any) {
          return _fetch.call(this, input, init).then((resp: Response) => {
            try {
              if (resp && typeof resp.clone === 'function') {
                resp.clone().text().then((t: string) => {
                  if (t && t.length < 100000) {
                    const urls = t.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
                    for (let ui = 0; ui < urls.length; ui++) {
                      if (patterns.some(p => urls[ui].includes(p))) {
                        record(urls[ui]);
                        break;
                      }
                    }
                  }
                }).catch(() => { /* 忽略 */ });
              }
            } catch { /* 忽略 */ }
            return resp;
          });
        };
      }
    }, urlPatterns).catch(() => {});
  }

  /**
   * v3.20.x: 注入 XHR 响应拦截，从分享生成 API 的响应 JSON 中提取分享链接
   *
   * 背景：豆包等平台"复制链接"不走标准剪贴板 API（React 闭包缓存了原生 writeText 引用，
   * 运行时覆写 navigator.clipboard.writeText 拦截不到），而是调用后端 API 生成分享链接，
   * 前端拿到响应后拼接/复制。分享链接真实来源是 API 响应体，必须拦 XHR 响应。
   *
   * 拦截目标：请求 URL 含 apiPathPattern 的 XHR 响应，解析 JSON，取 data[urlField]
   * （如 share_url），写入 (window as any).__capturedShareUrl__ 供 getCapturedShareUrl 读取。
   *
   * @param page Playwright Page
   * @param apiPathPattern 请求路径匹配子串（如 '/share/save'）
   * @param urlField 响应 JSON 中存放分享链接的字段名（如 'share_url'）
   */
  protected async injectShareApiInterceptor(page: Page, apiPathPattern: string, urlField: string): Promise<void> {
    await page.evaluate(
      ({ apiPath, field }) => {
        (window as any).__capturedShareUrl__ = null;
        const _open = XMLHttpRequest.prototype.open;
        (XMLHttpRequest.prototype as any).open = function (this: any, m: string, u: string) {
          this.__u = u;
          return _open.apply(this, arguments as any);
        };
        const _send = XMLHttpRequest.prototype.send;
        (XMLHttpRequest.prototype as any).send = function (this: any, b: any) {
          const xhr = this;
          const _o = xhr.onreadystatechange;
          xhr.onreadystatechange = function (this: any) {
            if (xhr.readyState === 4) {
              try {
                const t = xhr.responseText || '';
                if ((xhr.__u || '').includes(apiPath) && t) {
                  const d = JSON.parse(t);
                  const url = d && d.data && typeof d.data[field] === 'string' ? d.data[field] : null;
                  if (url) (window as any).__capturedShareUrl__ = url;
                }
              } catch { /* 忽略 */ }
            }
            if (_o) return (_o as any).apply(this, arguments as any);
          };
          return _send.apply(this, arguments as any);
        };
      },
      { apiPath: apiPathPattern, field: urlField }
    ).catch(() => {});
  }

  /**
   * 从拦截到的剪贴板内容提取 URL
   * @param urlPattern URL 中必须包含的子串（如 '/share/'）
   * @returns 匹配到的 URL 或 null
   */
  protected async getCapturedShareUrl(page: Page, urlPattern: string): Promise<string | null> {
    // 1. 从剪贴板拦截捕获
    const captured = await page.evaluate(() => (window as any).__capturedShareUrl__ as string | null).catch(() => null);
    if (captured) {
      const urlMatch = captured.match(/https?:\/\/[^\s<>"']+/);
      if (urlMatch && urlMatch[0].includes(urlPattern)) {
        return urlMatch[0];
      }
      // v1.9.12: 捕获到了 URL 但不符合当前平台模式——记录实际复制的 URL 便于定位平台分享格式
      const anyUrl = captured.match(/https?:\/\/[^\s<>"']+/);
      if (anyUrl) {
        logger.warn(`[${this.platformName}] 剪贴板捕获到 URL 但不含模式"${urlPattern}": ${anyUrl[0].slice(0, 120)}`);
      }
    } else {
      // v1.9.12: 未按模式捕获时，检查是否有任何复制动作发生（诊断各平台实际复制了什么）
      const lastText = await page.evaluate(() => (window as any).__lastClipboardText__ as string | null).catch(() => null);
      if (lastText) {
        const clipped = lastText.length > 160 ? lastText.slice(0, 160) + '...' : lastText;
        logger.warn(`[${this.platformName}] 剪贴板有复制动作但无"${urlPattern}"模式链接，复制的文本: "${clipped}"`);
      }
    }
    // 2. v1.9.6: 分享面板直接展示链接 input（readonly/class 含 link）时，从 DOM 读值
    try {
      const panelUrl = await page.evaluate((pattern: string) => {
        const inputs = document.querySelectorAll(
          'input[readonly], input[class*="link"], input[class*="url"], [class*="share-link"], [class*="link-input"], [class*="copy-link-input"], [class*="shareUrl"], textarea[readonly]'
        );
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i] as HTMLInputElement;
          const val = el.value || (el as any).innerText || '';
          if (val && val.startsWith('http') && val.includes(pattern)) return val;
        }
        // 兜底：扫描浮层/面板中的文本含 http 链接
        const panels = document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="popover"], [class*="panel"], [class*="share"]');
        for (let i = 0; i < panels.length; i++) {
          const text = (panels[i] as HTMLElement).innerText || '';
          const m = text.match(/https?:\/\/[^\s<>"']+/);
          if (m && m[0].includes(pattern)) return m[0];
        }
        return '';
      }, urlPattern).catch(() => '');
      if (panelUrl) return panelUrl;
    } catch { /* 忽略 */ }
    return null;
  }

  /**
   * 健壮地查找并点击分享按钮
   *
   * 策略：
   * 1. 先尝试传入的 CSS 选择器列表（精确匹配）
   * 2. 用 Playwright Locator filter({ hasText }) 按文本匹配
   * 3. 用属性选择器匹配 aria-label / title / data-testid / class 含 "share"
   * 4. 如果以上都失败，hover 所有消息/回答区域（很多平台操作栏 hover 才显示），然后重试 1-3
   *
   * 关键：所有点击都用 Playwright 的 click()（真实鼠标事件 mousedown→mouseup→click），
   *       不用 evaluate + element.click()（JS 原生 click 对 React/Vue 不生效）
   *
   * @param page Playwright Page
   * @param selectors CSS 选择器列表（按优先级排序）
   * @param shareTexts 分享按钮可能的文案（如 ['分享', 'Share', '复制链接']）
   * @returns 是否成功点击了分享按钮
   */
  protected async findAndClickShareButton(
    page: Page,
    selectors: string[],
    shareTexts: string[] = ['分享', 'Share', '分享对话', '复制链接', 'Copy link', 'Copy Link']
  ): Promise<boolean> {
    // 第一轮：直接尝试三个策略
    const found = await this._tryClickShareButton(page, selectors, shareTexts);
    if (found) return true;

    // 第二轮：hover 消息/回答区域后重试
    // 大部分 AI 平台（DeepSeek/Kimi/豆包/通义千问等）的操作栏 hover 才显示
    logger.warn(`[${this.platformName}] 第一轮未找到分享按钮，尝试 hover 消息区域后重试...`);
    await this._hoverMessageAreas(page);

    const found2 = await this._tryClickShareButton(page, selectors, shareTexts);
    if (found2) return true;

    logger.warn(`[${this.platformName}] 未找到分享按钮（hover 后仍失败）`);

    // 诊断日志：扫描页面上所有含"分享"/"share"的元素，帮助排查
    try {
      const diagnostics = await page.evaluate(() => {
        const results: string[] = [];
        const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="icon"], [class*="btn"], [data-testid], [aria-label]'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim().substring(0, 30);
          const ariaLabel = el.getAttribute('aria-label') || '';
          const className = (el.className || '').toString().substring(0, 60);
          const testid = el.getAttribute('data-testid') || '';
          const title = el.getAttribute('title') || '';
          const tag = el.tagName.toLowerCase();

          const hasShare = text.includes('分享') || text.toLowerCase().includes('share') ||
                           ariaLabel.includes('分享') || ariaLabel.toLowerCase().includes('share') ||
                           className.toLowerCase().includes('share') ||
                           testid.toLowerCase().includes('share') ||
                           title.includes('分享') || title.toLowerCase().includes('share');
          if (!hasShare) continue;

          const rect = el.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          const style = window.getComputedStyle(el as HTMLElement);
          const displayVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';

          results.push(`<${tag}> text="${text}" aria="${ariaLabel}" class="${className}" testid="${testid}" title="${title}" visible=${visible && displayVisible} pos=(${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)})`);
        }
        return results;
      }).catch(() => []);

      if (diagnostics.length > 0) {
        logger.warn(`[${this.platformName}] 页面上含"分享/share"的元素共 ${diagnostics.length} 个：`);
        for (const d of diagnostics.slice(0, 10)) {
          logger.warn(`  ${d}`);
        }
      } else {
        logger.warn(`[${this.platformName}] 页面上未找到任何含"分享/share"的元素`);
      }
    } catch { /* 忽略 */ }

    return false;
  }

  /**
   * v2.1.x: 通用「hover 消息后点击操作栏分享图标」+ 探针日志
   *
   * 背景：千问/纳米/DeepSeek 等平台新版分享按钮是 hover 消息后才显示的图标操作栏，
   * 图标 class/aria 常不含 "share" 字样，findAndClickShareButton 匹配不到（实测全落空）。
   *
   * 本方法：
   * 1. hover 回答区域
   * 2. 枚举操作栏候选图标（优先 iconHints 类名，其次消息容器内 16-48px 的纯图标元素），
   *    打印探针日志（index/aria/title/class/位置）——用于定位分享图标的真实标识
   * 3. 优先点击 aria/title 含分享/share 的候选；若无则从最右侧图标逐个尝试
   * 4. 每次点击后验证：剪贴板是否捕获到 shareUrl，或是否出现分享面板（全选/复制链接/生成链接等）
   * @returns 捕获到 shareUrl 时返回该 URL；只弹出分享面板（分享需二次确认）返回 special:__SHARE_PANEL__；否则 null
   */
  protected async hoverAndClickShareIcon(
    page: Page,
    opts: {
      answerSelectors: string[];
      iconHints?: string[];
      urlPattern: string;
      panelTexts?: string[]; // 分享面板出现的关键词（缺省用通用分享文案）
      maxIcons?: number;
    }
  ): Promise<string | null> {
    const panelTexts = opts.panelTexts || ['点击全选', '全选以下消息', '复制链接', '生成链接', '创建链接', '复制对话链接', '确认分享', 'Create and copy', 'Copy link'];
    const maxIcons = opts.maxIcons || 8;

    // 1. hover 回答区域（成功后立即停止，避免鼠标移走导致操作栏消失）
    // v3.20.x：回答可能在视口外（如千问回答流很长、问题气泡被滚到视口上方 y=-84），
    //   先 scrollIntoViewIfNeeded 让目标进入视口，hover 才有效、后续坐标点击才命中。
    let hoveredAny = false;
    for (const sel of opts.answerSelectors) {
      if (hoveredAny) break;
      try {
        const elements = await page.$$(sel);
        for (let i = elements.length - 1; i >= 0; i--) {
          const visible = await elements[i].isVisible().catch(() => false);
          if (!visible) continue;
          await elements[i].scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(300);
          await elements[i].hover({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1200);
          hoveredAny = true;
          break;
        }
      } catch { /* 继续 */ }
    }

    // 2. 枚举操作栏候选图标（含探针信息）
    const hintCss = (opts.iconHints || []).map(h => `[class*="${h}"]`).join(', ');
    const icons = await page.evaluate(({ hintCss, maxIcons }: { hintCss: string; maxIcons: number }) => {
      const isInMessage = (el: Element): boolean => {
        let node: Element | null = el;
        let depth = 0;
        while (node && depth < 8) {
          const cls = (node.className || '').toString().toLowerCase();
          const role = node.getAttribute && (node.getAttribute('role') || '');
          if (/message|answer|response|chat-item|chat-content|bubble|conversation-turn|msg-|reply|assistant|bot-message|dialogue|agent-chat|toolbar/i.test(cls) || /article|main/i.test(role)) return true;
          node = node.parentElement;
          depth++;
        }
        return false;
      };
      const describe = (el: Element): string | null => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        if (r.width < 14 || r.height < 14 || r.width > 52 || r.height > 52) return null; // 只要小图标
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const cls = (el.className || '').toString();
        const isIconOnly = text === '' || (text.length <= 1 && /like|share|more|copy|refresh|repeat|more/i.test(cls) === false);
        if (!isIconOnly) return null; // 只要纯图标
        return `${el.tagName.toLowerCase()}|${cls.slice(0, 40)}|${el.getAttribute('aria-label') || ''}|${el.getAttribute('title') || ''}|${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
      };
      const seen = new Set<string>();
      const results: Array<{ o: number; d: string; hint: boolean }> = [];
      // 优先 iconHints 命中的
      if (hintCss) {
        const hit = document.querySelectorAll(hintCss);
        for (let i = 0; i < hit.length; i++) {
          const d = describe(hit[i]);
          if (d) { const key = d.split('|')[0] + ':' + d.split('|').slice(1).join(':'); if (!seen.has(key)) { seen.add(key); results.push({ o: i, d, hint: true }); } }
        }
      }
      // 其次消息容器内的图标按钮
      const all = document.querySelectorAll('button, [role="button"], [class*="icon"], [class*="action-item"], [class*="operation"]');
      for (let i = 0; i < all.length && results.length < maxIcons; i++) {
        const el = all[i];
        if (!isInMessage(el)) continue;
        const d = describe(el);
        if (!d) continue;
        const key = d.split('|')[0] + ':' + d.split('|').slice(1).join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        if (results.length >= maxIcons) break;
        results.push({ o: i, d, hint: false });
      }
      // 探针：按位置排序（x 升序），并带 hint 标记 + 可重定位选择器（点击前 scrollIntoView 用）
      const parsed = results.map((r, idx) => {
        const parts = r.d.split('|');
        const pos = parts[4].split(',');
        const tag = parts[0];
        const cls = parts[1];
        const sel = r.hint ? hintCss : `${tag}[class*="${(cls || '').split(' ')[0]}"]`;
        return { idx, o: r.o, sel, x: Number(pos[0]), y: Number(pos[1]), hint: r.hint, desc: `${idx}#${r.d}` };
      }).sort((a, b) => a.x - b.x);
      return parsed.map(p => ({ idx: p.idx, o: p.o, sel: p.sel, x: p.x, y: p.y, hint: p.hint, desc: p.desc }));
    }, { hintCss, maxIcons }).catch(() => [] as any[]);

    if (!icons || icons.length === 0) {
      logger.warn(`[${this.platformName}] hover 后操作栏未找到图标候选，无法点击分享`);
      return null;
    }
    logger.warn(`[${this.platformName}] 分享操作栏图标探针(${icons.length}个): ${icons.map(i => i.desc).join(' | ')}`);

    // 3. 计算点击顺序：优先 hint 命中且 index 在右侧（分享多在最右）；无 hint 时从最右侧图标往前逐个试
    const ordered = [...icons].sort((a, b) => Number(b.hint) - Number(a.hint) || b.x - a.x);

    // 4. 逐个点击验证
    for (const icon of ordered.slice(0, Math.min(maxIcons, ordered.length))) {
      // v3.20.x：点击前滚动图标到可见（千问回答流很长，操作栏可能被滚到视口外 y=-84），
      //   滚动后重新读取坐标再点击（scrollIntoView 会改变元素位置）
      let clickX = icon.x;
      let clickY = icon.y;
      try {
        const pos = await page.evaluate(({ sel, o }: { sel: string; o: number }) => {
          if (!sel) return null;
          const els = document.querySelectorAll(sel);
          const el = els[o] || els[0] || null;
          if (!el) return null;
          (el as HTMLElement).scrollIntoView({ block: 'center' });
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left), y: Math.round(r.top) };
          return null;
        }, { sel: icon.sel, o: icon.o }).catch(() => null);
        if (pos && pos.x > 0 && pos.y > 0) {
          clickX = pos.x;
          clickY = pos.y;
        }
        await page.waitForTimeout(400);
      } catch { /* 忽略 */ }
      // 用真实坐标点击（Playwright 真实鼠标事件）
      const clicked = await page.mouse.click(clickX + 4, clickY + 4).catch(() => false).then(() => true);
      if (!clicked) continue;
      await page.waitForTimeout(1300);
      // 先查剪贴板是否直接捕获
      const cap = await this.getCapturedShareUrl(page, opts.urlPattern);
      if (cap) {
        logger.info(`[${this.platformName}] 点击操作栏图标[${icon.idx}]直接复制分享链接: ${cap}`);
        return cap;
      }
      // 再查是否弹出分享面板（多选/复制链接等二次步骤）
      const panelShown = await page.evaluate((texts: string[]) => {
        const els = document.querySelectorAll('button, [role="button"], label, div, span, [class*="checkbox"], [class*="check"]');
        for (let i = 0; i < els.length; i++) {
          const t = ((els[i] as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
          const r = (els[i] as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          for (const kw of texts) if (t.includes(kw)) return true;
        }
        return false;
      }, panelTexts).catch(() => false);
      if (panelShown) {
        logger.info(`[${this.platformName}] 点击操作栏图标[${icon.idx}]后出现分享面板`);
        return '__SHARE_PANEL__';
      }
      // 关闭可能弹出的无关浮层，试下一个
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
    return null;
  }

  /** 内部方法：尝试三个策略查找并点击分享按钮 */
  private async _tryClickShareButton(
    page: Page,
    selectors: string[],
    shareTexts: string[]
  ): Promise<boolean> {
    // 策略1：尝试传入的 CSS 选择器（Playwright click，真实鼠标事件）
    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500);
          logger.info(`[${this.platformName}] 点击分享按钮成功(选择器): ${sel}`);
          return true;
        }
      } catch { /* 继续 */ }
    }

    // 策略2a：精确文本匹配（textContent.trim() === "分享" 或 "Share"）
    // 避免"小程序分享问题排查"等含"分享"但非分享按钮的元素被误匹配
    try {
      for (const text of shareTexts) {
        const exactMatches = page.locator('button, a, [role="button"], [class*="icon"]')
          .filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        const exactCount = await exactMatches.count().catch(() => 0);
        if (exactCount > 0) {
          for (let i = exactCount - 1; i >= 0; i--) {
            try {
              const el = exactMatches.nth(i);
              const visible = await el.isVisible().catch(() => false);
              if (!visible) continue;
              await el.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(1500);
              logger.info(`[${this.platformName}] 点击分享按钮成功(精确文本): text="${text}"`);
              return true;
            } catch { /* 继续 */ }
          }
        }
      }
    } catch { /* 继续 */ }

    // 策略2b：包含文本匹配（兜底，但排除明显非按钮的元素）
    try {
      const textRegex = new RegExp(shareTexts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
      const textMatches = page.locator('button, a, [role="button"], [class*="icon"]')
        .filter({ hasText: textRegex });
      const textCount = await textMatches.count().catch(() => 0);
      if (textCount > 0) {
        for (let i = textCount - 1; i >= 0; i--) {
          try {
            const el = textMatches.nth(i);
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            const text = (await el.textContent().catch(() => '') || '').trim().substring(0, 50);
            // 排除明显非分享按钮的元素（文案过长或含"问题排查"等）
            if (text.length > 20 || text.includes('问题') || text.includes('排查') || text.includes('帮助')) {
              continue;
            }
            await el.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1500);
            logger.info(`[${this.platformName}] 点击分享按钮成功(包含文本): text="${text}"`);
            return true;
          } catch { /* 继续 */ }
        }
      }
    } catch { /* 继续 */ }

    // 策略3：用属性选择器匹配 aria-label / title / data-testid / class 含 "share"
    const attrSelectors = [
      '[aria-label*="分享"]',
      '[aria-label*="share" i]',
      '[title*="分享"]',
      '[title*="share" i]',
      '[data-testid*="share"]',
      '[data-testid*="share" i]',
      '[class*="share"]:not([class*="shared"]):not([class*="sharing"])',
    ];
    for (const sel of attrSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          for (let i = count - 1; i >= 0; i--) {
            try {
              const el = loc.nth(i);
              const visible = await el.isVisible().catch(() => false);
              if (!visible) continue;
              const className = await el.getAttribute('class').catch(() => '') || '';
              await el.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(1500);
              logger.info(`[${this.platformName}] 点击分享按钮成功(属性): sel="${sel}" class="${className.substring(0, 50)}"`);
              return true;
            } catch { /* 继续 */ }
          }
        }
      } catch { /* 继续 */ }
    }

    return false;
  }

  /** hover 消息/回答区域，触发操作栏显示 */
  private async _hoverMessageAreas(page: Page): Promise<void> {
    // 所有可能包含 AI 回答的容器选择器
    const messageSelectors = [
      '[class*="message"]:not([class*="input"]):not([class*="send"])',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="reply"]',
      '[class*="chat-item"]',
      '[class*="conversation-item"]',
      '[class*="bubble"]',
      'article',
      '[class*="markdown"]',
      '[class*="content"]:not([class*="input-content"])',
    ];

    for (const sel of messageSelectors) {
      try {
        const elements = await page.$$(sel);
        // hover 最后几个元素（最新的回答通常在后面）
        const startIdx = Math.max(0, elements.length - 5);
        for (let i = elements.length - 1; i >= startIdx; i--) {
          try {
            const visible = await elements[i].isVisible().catch(() => false);
            if (!visible) continue;
            await elements[i].hover({ timeout: 1000 }).catch(() => {});
            await page.waitForTimeout(300); // 等待操作栏动画
          } catch { /* 继续 */ }
        }
      } catch { /* 继续 */ }
    }
  }

  /**
   * 从弹窗中提取分享链接（兜底策略）
   * @param urlPattern URL 中必须包含的子串
   */
  protected async extractShareUrlFromDialog(page: Page, urlPattern: string): Promise<string | null> {
    const dialogSelectors = [
      '[role="dialog"]', '[class*="share-dialog"]', '[class*="share-modal"]',
      '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
    ];
    for (const dlgSel of dialogSelectors) {
      try {
        const dlg = await page.$(dlgSel).catch(() => null);
        if (!dlg) continue;
        const visible = await dlg.isVisible().catch(() => false);
        if (!visible) continue;

        // 从 input 中提取
        const inputUrl = await dlg.evaluate((node: HTMLElement) => {
          const input = node.querySelector('input');
          return input?.value || input?.textContent || '';
        }).catch(() => '');
        if (inputUrl && inputUrl.includes(urlPattern)) {
          console.log(`[${this.platformName}] 从弹窗 input 提取到分享链接: ${inputUrl}`);
          return inputUrl.trim();
        }

        // 从文本中匹配 URL
        const text = await dlg.textContent().catch(() => '');
        const urlMatch = text?.match(new RegExp(`https?://[^\\s<>"']+${urlPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s<>"']*`));
        if (urlMatch) {
          console.log(`[${this.platformName}] 从弹窗文本提取到分享链接: ${urlMatch[0]}`);
          return urlMatch[0];
        }
      } catch { /* 继续 */ }
    }
    return null;
  }

  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载，再滚动回顶部（确保所有内容渲染完成）
    await this.scrollToBottom(page);

    if (!this.responseSelector) {
      // 无选择器时，直接用 smartFindLongestContent 扫描最长文本
      const smart = await smartFindLongestContent(page, 50);
      if (smart) {
        console.log(`[${this.platformName}] smartFindLongestContent 提取成功: ${smart.text.length} 字符`);
        return { text: smart.text, html: smart.html };
      }
      return { text: '', html: '' };
    }

    try {
      // 等待回答选择器出现
      await page.waitForSelector(this.responseSelector, { timeout: 30000 });
      // 再次滚动确保完整渲染
      await this.scrollToBottom(page);
      // 取最后一个匹配的元素（最新的回答）
      const elements = await page.$$(this.responseSelector);

      // 收集所有候选元素及其质量评分
      interface MatchCandidate {
        text: string;
        html: string;
        score: number;
        index: number;
      }
      const candidates: MatchCandidate[] = [];

      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        // 跳过导航/侧边栏元素（class/id/role 匹配）
        const isNav = await el.evaluate((node: HTMLElement) => {
          const navPatterns = /sidebar|side-bar|sidenav|side-nav|navigation|nav-bar|navbar|menu|aside|left-bar|leftbar|right-bar|rightbar|history|conversation-list|chat-list|session/i;
          const cls = node.className || '';
          const id = node.id || '';
          const role = node.getAttribute('role') || '';
          return navPatterns.test(cls) || navPatterns.test(id) || role === 'navigation' || role === 'menu';
        }).catch(() => false);
        if (isNav) continue;

        const text = (await el.textContent()) || '';
        if (text.trim().length === 0) continue;

        // 清理 HTML
        const cleanedHtml = await el.evaluate((node: HTMLElement) => {
          const clone = node.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('style, script, noscript').forEach(e => e.remove());
          const removeSelectors = [
            'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
            'img', 'video', 'audio', 'source',
            'button', 'input', 'textarea', 'select', 'form',
            '.btn', '.button', '.action', '.toolbar', '.menu', '.sidebar',
            '.navigation', '.nav', '.header', '.footer',
            '[class*="btn"]', '[class*="button"]', '[class*="action"]',
            '[class*="toolbar"]', '[class*="menu"]', '[class*="sidebar"]',
            '[class*="navigation"]', '[class*="nav-"]', '[class*="header"]',
            '[class*="footer"]', '[class*="copy"]', '[class*="share"]',
            '[class*="like"]', '[class*="feedback"]', '[class*="rating"]',
            '[role="button"]', '[role="navigation"]', '[role="toolbar"]',
            '[aria-hidden="true"]',
          ];
          for (const sel of removeSelectors) {
            clone.querySelectorAll(sel).forEach(e => e.remove());
          }
          return clone.innerHTML;
        }).catch(() => '');

        const cleanedText = cleanedHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

        // 评分：优先散文内容（含 <p> 标签）
        const quality = await el.evaluate((node: HTMLElement) => {
          const pCount = node.querySelectorAll('p').length;
          const linkCount = node.querySelectorAll('a').length;
          const textLen = (node.textContent || '').length;
          const hasMarkdown = /markdown|prose|content-body|message-content|answer-content|response-content/i.test(node.className || '');
          return { pCount, linkCount, textLen, hasMarkdown };
        }).catch(() => ({ pCount: 0, linkCount: 0, textLen: text.length, hasMarkdown: false }));

        let score = cleanedText.length;
        if (quality.pCount > 0) score *= 3; // 含 <p> 标签 = 散文，3 倍加权
        if (quality.hasMarkdown) score *= 2;
        if (quality.linkCount > 3) {
          const linkRatio = quality.linkCount / Math.max(cleanedText.length, 1);
          score *= (1 - Math.min(linkRatio * 10, 0.8));
        }

        candidates.push({ text: text.trim(), html: cleanedHtml || `<div>${escapeHtml(text.trim())}</div>`, score, index: i });
      }

      // 按评分排序，取最高分
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        console.log(`[${this.platformName}] 提取内容成功: ${best.text.length} 字符 (score=${Math.round(best.score)}, 从 ${candidates.length} 个候选中选择, selector: ${this.responseSelector.split(',')[0]}...)`);
        return { text: best.text, html: best.html };
      }

      // 选择器匹配到元素但内容为空，走兜底
      console.log(`[${this.platformName}] responseSelector 匹配到 ${elements.length} 个元素但无有效内容，走兜底`);
    } catch (e) {
      console.log(`[${this.platformName}] responseSelector 等待超时: ${(e as Error).message}，走兜底`);
    }

    // 兜底1：用 smartFindLongestContent 扫描页面所有长文本元素
    // 替代之前的 document.body.textContent + substring(0, 10000) 截断
    // 解决：1) 豆包每次 10000 字符截断 2) 避免提取侧边栏/导航等无关内容
    try {
      const smart = await smartFindLongestContent(page, 50);
      if (smart) {
        console.log(`[${this.platformName}] smartFindLongestContent 兜底提取: ${smart.text.length} 字符`);
        return { text: smart.text, html: smart.html };
      }
    } catch (e) {
      console.error(`[${this.platformName}] smartFindLongestContent 兜底失败:`, (e as Error).message);
    }

    // 兜底2：最终降级，取 body 文本（不截断，保留完整内容）
    try {
      const text = await page.evaluate(() => document.body.textContent || '');
      if (text.trim().length > 0) {
        console.log(`[${this.platformName}] body.textContent 兜底提取: ${text.trim().length} 字符`);
        return { text: text.trim(), html: `<div>${escapeHtml(text.trim())}</div>` };
      }
    } catch (e) {
      console.error(`[${this.platformName}] body.textContent 兜底失败:`, (e as Error).message);
    }
    return { text: '', html: '' };
  }

  /**
   * 滚动到页面底部，触发 SPA 懒加载，确保 AI 回答完整渲染
   * 注意：之前有 totalHeight > 10000 的限制，导致长回答被截断
   *       现改为按 scrollHeight 完整滚动，最多 30 秒
   */
  protected async scrollToBottom(page: Page): Promise<void> {
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          let lastScrollHeight = 0;
          let stableCount = 0;
          const distance = 300;
          const startTime = Date.now();
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            // 检测页面高度是否稳定（连续 3 次不变则认为加载完成）
            if (scrollHeight === lastScrollHeight) {
              stableCount++;
              if (stableCount >= 3) {
                clearInterval(timer);
                resolve();
                return;
              }
            } else {
              stableCount = 0;
            }
            lastScrollHeight = scrollHeight;
            // 到达底部
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
              return;
            }
            // 超时 30 秒
            if (Date.now() - startTime > 30000) {
              clearInterval(timer);
              resolve();
              return;
            }
          }, 100);
        });
      });
      // 滚动回顶部
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    } catch {
      // 滚动失败不影响主流程
    }
  }

  async waitForResponse(page: Page): Promise<void> {
    // 等待停止按钮出现后再消失（表示回答完成）
    if (this.stopButtonSelector) {
      try {
        // 先等待停止按钮出现（表示 AI 开始生成）
        await page.waitForSelector(this.stopButtonSelector, { timeout: 10000 });
        // 然后等待停止按钮消失（表示 AI 生成完成）
        await page.waitForSelector(this.stopButtonSelector, { state: 'detached', timeout: 120000 });
        // 额外等待 2 秒确保最终内容渲染完成
        await page.waitForTimeout(2000);
      } catch {
        // 停止按钮超时，再等待固定时间
        console.log(`[${this.platformName}] 停止按钮等待超时，额外等待10秒`);
        await page.waitForTimeout(10000);
      }
    } else {
      // 无停止按钮选择器时，等待更长时间（30秒）让 AI 完成生成
      // 然后滚动页面触发懒加载
      await page.waitForTimeout(30000);
    }
  }
}

/** HTML 特殊字符转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
