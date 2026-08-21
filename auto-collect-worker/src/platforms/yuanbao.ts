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

  /**
   * v3.21.x: 元宝分享 API 拦截器（实地探查 2026-08-21 定论）
   *
   * 根因：元宝点击"复制链接"后，前端调 `POST /api/conversations/v2/share` 生成分享，
   * 响应体只返回顶层 `shareId`（如 {"shareId":"GyY2LUyTM0cX"}），由前端 JS 拼接完整链接
   * `https://yuanbao.tencent.com/s/{shareId}` 后再复制。
   *
   * 因此 worker 若只扫剪贴板 / XHR 响应里的完整 URL，永远抓不到 `/s/`：
   *   - navigator.clipboard.writeText 被 React 闭包缓存引用，运行时覆盖拦截不到
   *   - API 响应文本只有 shareId，没有 `/s/` 字符串
   *
   * 修复：专门 hook `/share` 相关 XHR/fetch 响应，解析 JSON 中的顶层 shareId，
   * 拼接 `https://yuanbao.tencent.com/s/{shareId}` 写入 __capturedShareUrl__，
   * 与后续 getCapturedShareUrl(page, '/s/') 无缝衔接。
   */
  protected async injectYuanbaoShareApiInterceptor(page: Page): Promise<void> {
    await page.evaluate(() => {
      // 保存当前已存在的 shareId 捕获，避免重复覆盖
      const setShareUrl = () => {
        try {
          const sid = (window as any).__ybShareId;
          if (!sid) return;
          (window as any).__capturedShareUrl__ = `https://yuanbao.tencent.com/s/${sid}`;
          (window as any).__lastClipboardText__ = `https://yuanbao.tencent.com/s/${sid}`;
        } catch { /* 忽略 */ }
      };
      // 解析响应文本，提取 shareId
      const parseResp = (t: string) => {
        try {
          if (typeof t !== 'string' || !t) return;
          // 1. 尝试 JSON 顶层 shareId（元宝 /api/conversations/v2/share 响应）
          if (t.trim().startsWith('{')) {
            const d = JSON.parse(t);
            if (d && typeof d.shareId === 'string' && d.shareId) {
              (window as any).__ybShareId = d.shareId;
              setShareUrl();
              return;
            }
          }
          // 2. 尝试正则提取 shareId/sharedId 字段
          const m = t.match(/"shareId"\s*:\s*"([^"]+)"/) || t.match(/"sharedId"\s*:\s*"([^"]+)"/);
          if (m && m[1]) {
            (window as any).__ybShareId = m[1];
            setShareUrl();
          }
        } catch { /* 忽略 */ }
      };
      // XHR 拦截
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
              const u = xhr.__u || '';
              if (/share|conversations\/v2/.test(u)) parseResp(xhr.responseText || '');
            } catch { /* 忽略 */ }
          }
          if (_o) return (_o as any).apply(this, arguments as any);
        };
        return _send.apply(this, arguments as any);
      };
      // fetch 拦截（元宝部分场景可能用 fetch）
      const _fetch = window.fetch;
      if (typeof _fetch === 'function') {
        window.fetch = function (this: any, input: any, init?: any) {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          return _fetch.call(this, input, init).then((resp: Response) => {
            try {
              if (resp && typeof resp.clone === 'function' && /share|conversations\/v2/.test(u)) {
                resp.clone().text().then((t: string) => parseResp(t)).catch(() => {});
              }
            } catch { /* 忽略 */ }
            return resp;
          });
        };
      }
      }).catch(() => {});
  }

  async extractShareLink(page: Page): Promise<string | null> {
    // 腾讯元宝分享链接格式：https://yuanbao.tencent.com/s/{shareId}
    // 实地探查（2026-07-12）：分享按钮 id="shareButton" 或 data-id="shareButton"
    // 流程：hover 回答 → 点击分享按钮 → 分享菜单弹窗 → 复制链接

    // v3.21.x: 先行注入专门的分享 API 拦截器（解析 /api/conversations/v2/share 响应的 shareId）
    // 必须在点击分享按钮之前注入，确保能捕获到 share 请求响应。
    await this.injectYuanbaoShareApiInterceptor(page);

    // 步骤1: 注入 clipboard + execCommand 拦截
    // v1.9: 只匹配 /s/ 分享路径（之前还匹配域名，任何含域名的复制文本都会被误捕获）
    // v3.20.x: 追加 yuanbao.tencent.com/chat/s/ 等变体——元宝分享链接可能有其他前缀
    await this.injectClipboardInterceptor(page, ['/s/', 'yuanbao.tencent.com/chat/s/', '/chat/share/']);

    // 步骤2: hover 在 AI 回答区域上，触发操作栏显示
    // v1.9 修复：hover 成功一个元素后立即停止——之前会继续 hover 兜底选择器（main 等），
    // 鼠标被移走导致已显示的操作栏消失，分享按钮永远找不到
    // v3.19.x 实地探查（2026-08-21）：元宝回答气泡 class 为 .agent-chat__bubble--agent，
    //   分享按钮在回答气泡右上角操作栏 .agent-chat__toolbar__right 内（aria-label=分享），
    //   旧 .agent-chat__msg__content 等选择器已过时，hover 到问题气泡（.agent-chat__bubble--human）
    //   或回答气泡都能让对应操作栏出现；分享面板由回答气泡的分享按钮触发。
    const answerSelectors = [
      '.agent-chat__bubble--agent',
      '.agent-chat__bubble--human',
      '.agent-chat__conv--human',
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

    // v3.19.x 实地探查（2026-08-21）：元宝分享面板为多选模式，结构：
    //   .agent-chat__share-bar-container → .agent-chat__share-bar__content__center 内
    //   4 个 .agent-chat__share-bar__item：复制链接 / 生成图片 / 转为文档 / 小程序码。
    //   "全选" checkbox 默认已勾选（消息前 checkbox 默认 checked），直接点"复制链接"即可
    //   生成 /s/ 链接并复制到剪贴板（真实 DOM 已确认）。
    //   优先用精确选择器点击"复制链接"，再兜底探针逐个点击。
    try {
      const copyBtnSelectors = [
        'div.agent-chat__share-bar__item:has-text("复制链接")',
        '[class*="share-bar"] [class*="item"]:has-text("复制链接")',
        '.agent-chat__share-bar__content__center [class*="item"]:has-text("复制链接")',
      ];
      for (const sel of copyBtnSelectors) {
        const btn = await page.$(sel);
        if (!btn) continue;
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const cap = await this.getCapturedShareUrl(page, '/s/');
        if (cap) {
          logger.info(`[腾讯元宝] 点击分享面板"复制链接"项捕获: ${cap} (sel=${sel})`);
          return cap;
        }
        const dlg = await this.extractShareUrlFromDialog(page, '/s/');
        if (dlg) return dlg;
      }
    } catch { /* 忽略 */ }

    // v3.19.x: 元宝点击分享后弹「点击全选以下消息」多选模式，旧全选/复制链接选择器匹配不到。
    //   触发元素常是纯 div 或图标按钮、aria/label 为空。加专属探针+逐个点击：
    //   扫描页面可见元素，优先点「全选」，再点「复制链接/生成链接」，逐个验证剪贴板。
    try {
      const shareLayerBtns = await page.evaluate(() => {
        const els = document.querySelectorAll('button, a, [role="button"], label, [class*="checkbox"], [class*="check"], [class*="select"], div, span');
        const results: Array<{ tag: string; cls: string; aria: string; text: string; x: number; y: number; kind: string }> = [];
        for (let i = 0; i < els.length; i++) {
          const el = els[i] as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.width > 500 || r.height > 80) continue;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const combined = text + ' ' + aria + ' ' + title;
          let kind = '';
          if (/全选|选择全部|选择以下消息/.test(combined)) kind = 'select-all';
          else if (/复制链接|生成链接|创建链接|复制分享链接/.test(combined)) kind = 'copy';
          else if (/^复制$|生成分享|创建分享/.test(text)) kind = 'copy';
          if (!kind) continue;
          const cls = (el.className || '').toString();
          results.push({ tag: el.tagName.toLowerCase(), cls: cls.slice(0, 40), aria: aria.slice(0, 20), text: text.slice(0, 20), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), kind });
        }
        return results;
      }).catch(() => [] as any[]);
      if (shareLayerBtns.length > 0) {
        logger.warn(`[腾讯元宝] 分享弹窗按钮探针(${shareLayerBtns.length}个): ${shareLayerBtns.map(b => `<${b.tag} class="${b.cls}" aria="${b.aria}" text="${b.text}" kind=${b.kind} pos=(${b.x},${b.y})`).join(' | ')}`);
        const selectAlls = shareLayerBtns.filter(b => b.kind === 'select-all');
        const copies = shareLayerBtns.filter(b => b.kind === 'copy');
        const ordered = [...selectAlls, ...copies, ...shareLayerBtns.filter(b => !selectAlls.includes(b) && !copies.includes(b))];
        for (const b of ordered.slice(0, 8)) {
          await page.mouse.click(b.x, b.y).catch(() => {});
          await page.waitForTimeout(1200);
          const cap = await this.getCapturedShareUrl(page, '/s/');
          if (cap) {
            logger.info(`[腾讯元宝] 分享弹窗按钮点击捕获: ${cap} (btn=${b.text || b.aria || b.cls})`);
            return cap;
          }
          const dlg = await this.extractShareUrlFromDialog(page, '/s/');
          if (dlg) return dlg;
        }
      }
    } catch { /* 忽略 */ }

    // v3.19.x: 增强分享弹窗 DOM 转储——探针未命中/点击未捕获时，dump 分享弹窗内所有
    //   元素（含"点击全选以下消息"提示、checkbox、按钮）的完整结构，供实地定位元宝真实全选/复制链接入口。
    try {
      const shareLayerDump = await page.evaluate(() => {
        const results: string[] = [];
        // 找所有可能包含"点击全选以下消息"/"全选"的弹层容器
        const layers = document.querySelectorAll(
          '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="popover"], [class*="share"], [class*="select"], [class*="check"], [class*="mask"], [class*="overlay"]'
        );
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i] as HTMLElement;
          const lr = layer.getBoundingClientRect();
          if (lr.width <= 0 || lr.height <= 0) continue;
          const layerText = (layer.innerText || '').replace(/\s+/g, ' ').trim();
          if (!/全选|选择|复制|链接|生成/.test(layerText) && !/share|select/i.test((layer.className || '').toString())) continue;
          const innerEls = layer.querySelectorAll('button, [role="button"], label, [class*="checkbox"], [class*="check"], [class*="select"], input[type="checkbox"], div, span');
          const items: string[] = [];
          for (let j = 0; j < innerEls.length && items.length < 20; j++) {
            const el = innerEls[j] as HTMLElement;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.width > 600 || r.height > 100) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
            const cls = (el.className || '').toString().slice(0, 45);
            const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16);
            const aria = el.getAttribute('aria-label') || '';
            const title = el.getAttribute('title') || '';
            items.push(`<${el.tagName.toLowerCase()} class="${cls}" aria="${aria.slice(0, 16)}" title="${title.slice(0, 16)}" text="${txt}" pos=(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)})`);
          }
          results.push(`[弹层${i} class="${(layer.className || '').toString().slice(0, 50)}" pos=(${Math.round(lr.left)},${Math.round(lr.top)},${Math.round(lr.width)}x${Math.round(lr.height)})]\n  ${items.join('\n  ')}`);
        }
        return results;
      }).catch(() => [] as string[]);
      if (shareLayerDump.length > 0) {
        logger.warn(`[腾讯元宝] 分享弹窗DOM转储(${shareLayerDump.length}个弹层):\n${shareLayerDump.join('\n')}`);
      }
    } catch { /* 忽略 */ }

    // v1.9.10: 元宝分享弹窗勾选消息后需先点击「生成链接/创建链接」才会出现可复制的分享链接
    // v1.9.14: 补充「生成分享/创建分享」等文案变体（实测弹窗停留在"点击全选以下消息"时
    //   copy 选择器全落空，需先激活"生成链接"；多个变体避免平台改版文案漏匹配）
    for (const genSel of [
      'button:has-text("生成链接")',
      'button:has-text("创建链接")',
      'button:has-text("生成分享链接")',
      'button:has-text("创建分享链接")',
      'button:has-text("生成分享")',
      'button:has-text("创建分享")',
      ':text-is("生成链接")',
      ':text-is("创建链接")',
      ':text-is("生成分享链接")',
      ':text-is("创建分享")',
      'button:has-text("下一步")',
      '[class*="generate"] button',
      '[class*="create-link"]',
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

    // v1.9.12: 兜底——全页面扫描含 链接/生成/复制 文本的叶子级可点击元素，逐个点击检查剪贴板
    // （元宝分享面板的复制/生成按钮可能是 div/span，且文案可能与标准"复制链接"不同）
    try {
      const linkLike = await page.evaluate(() => {
        const candidates = document.querySelectorAll('button, a[href], [role="button"], div, span, [class*="btn"], [class*="button"], [class*="item"], [class*="action"]');
        const results: string[] = [];
        for (let i = 0; i < candidates.length && results.length < 8; i++) {
          const el = candidates[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.width < 30 || rect.height < 20) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 12) continue;
          if (!/链接|生成|复制|link|copy/i.test(t)) continue;
          const cls = (el.getAttribute('class') || '').toString().split(' ')[0];
          results.push(cls || t);
        }
        return results;
      }).catch(() => []);
      for (const cls of linkLike.slice(0, 5)) {
        try {
          let el: any = await page.$(`[class*="${cls}"]`).catch(() => null);
          if (!el) el = await page.$(`:text-is("${cls}")`).catch(() => null);
          if (el) {
            const visible = await el.isVisible().catch(() => false);
            if (visible) {
              await el.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1800);
              const cap = await this.getCapturedShareUrl(page, '/s/');
              if (cap) {
                console.log(`[腾讯元宝] 兜底点击链接按钮捕获: ${cap}`);
                return cap;
              }
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(400);
            }
          }
        } catch { /* 继续 */ }
      }
    } catch { /* 忽略 */ }

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
