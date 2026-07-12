/**
 * 索引化交互器（云端巡检 Worker 版，借鉴桌面端 indexedInteractor.ts）
 *
 * 核心思想：当 CSS/XPath 选择器失效时，扫描页面所有可见可交互元素，
 * 按文本/属性模糊匹配兜底查找，解决 DeepSeek "输入框未找到"等痛点。
 *
 * 与桌面端 indexedInteractor.ts 的差异：
 *  - 仅保留 smartFindInputElement / smartFindClickableElement 两个核心函数
 *  - 不暴露 getState / clickByIndex / inputByIndex（巡检 Worker 不需要 step 执行器）
 */

import { Page, ElementHandle } from 'playwright';

/** 可交互元素的索引化描述（精简版） */
interface IndexedElement {
  tag: string;
  type: string;
  text: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  bbox?: { x: number; y: number; width: number; height: number };
}

/**
 * 扫描页面所有可见可交互元素，返回索引列表
 */
async function getState(page: Page): Promise<IndexedElement[]> {
  const rawElements = await page.evaluate(() => {
    const results: any[] = [];

    const interactiveSelector = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]):not([type="checkbox"]):not([type="radio"])',
      'textarea',
      'button',
      'a[href]',
      'select',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="textbox"]',
    ].join(', ');

    const elements = Array.from(document.querySelectorAll(interactiveSelector));

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // 跳过不可见元素
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const tag = el.tagName.toLowerCase();
      const type = (el as any).type || tag;
      const text =
        (el as any).placeholder ||
        (el as any).innerText?.trim().slice(0, 80) ||
        (el as any).value?.slice(0, 40) ||
        (el as any).title ||
        (el as any).getAttribute('aria-label') ||
        '';
      const enabled = !(el as any).disabled && !(el as any).getAttribute('aria-disabled');

      // 生成稳定选择器（三层优先级：data-testid > id > name > aria-label > 结构路径）
      let selector = '';
      if (el.getAttribute('data-testid')) {
        selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
      } else if (el.id) {
        selector = `#${el.id}`;
      } else if ((el as any).name) {
        selector = `${tag}[name="${(el as any).name}"]`;
      } else if (el.getAttribute('aria-label')) {
        selector = `${tag}[aria-label="${el.getAttribute('aria-label')}"]`;
      } else {
        selector = (function generateStructuralSelector(rootEl: Element): string {
          const parts: string[] = [];
          let node: Element | null = rootEl;
          let depth = 0;
          while (node && depth < 5) {
            const part = node.tagName.toLowerCase();
            if (node.id) {
              parts.unshift(`#${node.id}`);
              break;
            }
            const parent: Element | null = node.parentElement;
            if (parent) {
              const siblings: Element[] = Array.from(parent.children).filter((c: Element) => c.tagName === node!.tagName);
              const idx = siblings.indexOf(node) + 1;
              if (siblings.length > 1) {
                parts.unshift(`${part}:nth-of-type(${idx})`);
              } else {
                parts.unshift(part);
              }
            } else {
              parts.unshift(part);
            }
            node = parent;
            depth++;
          }
          return parts.join(' > ');
        })(el);
      }

      results.push({
        tag, type, text, selector, visible: true, enabled,
        bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }

    return results;
  });

  return rawElements;
}

/**
 * 智能查找可输入元素：用于"输入框未找到"兜底
 *
 * 查找优先级：
 * 1. textarea（最常见）
 * 2. [contenteditable="true"]
 * 3. [role="textbox"]
 * 4. input[type="text"] / input 无 type
 *
 * @param page Playwright Page
 * @param preferredText 可选：优先匹配 placeholder/aria-label 含此关键词的元素
 * @param options.includeHidden 可选：true 时不过滤 visible，覆盖 textarea 存在但被 overflow:hidden 隐藏的情况
 */
export async function smartFindInputElement(
  page: Page,
  preferredText?: string,
  options?: { includeHidden?: boolean },
): Promise<ElementHandle | null> {
  const includeHidden = options?.includeHidden ?? false;
  const elements = await getState(page);

  // 仅保留可输入元素
  const inputs = elements.filter(
    (e) =>
      (includeHidden || e.enabled) &&
      (e.tag === 'textarea' ||
        e.tag === 'input' ||
        e.selector.includes('contenteditable') ||
        e.selector.includes('role="textbox"') ||
        e.selector.includes('[role="textbox"]')),
  );

  if (inputs.length === 0) {
    // 终极兜底：用 evaluate 直接查找页面所有 textarea/input/contenteditable，不管 visible
    // 解决 DeepSeek 偶发 textarea 被 overflow:hidden 隐藏但实际可用的情况
    console.log('[smartFindInputElement] 索引扫描未找到可输入元素，启用 evaluate 直接查找...');
    const selector = await page.evaluate(() => {
      const candidates = [
        'textarea',
        'div[contenteditable="true"]',
        '[role="textbox"]',
        'input[type="text"]',
        'input:not([type])',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) {
          // 返回选择器 + 元素引用 ID（用 id 或构造选择器）
          if (el.id) return `#${el.id}`;
          return sel;
        }
      }
      return null;
    });
    if (selector) {
      console.log(`[smartFindInputElement] evaluate 找到元素: ${selector}`);
      const el = await page.$(selector);
      if (el) return el;
    }
    return null;
  }

  // 优先按文本匹配
  if (preferredText) {
    const lower = preferredText.toLowerCase();
    const matched = inputs.find(
      (e) => e.text.toLowerCase().includes(lower) || e.selector.toLowerCase().includes(lower),
    );
    if (matched) {
      const el = await page.$(matched.selector);
      if (el) return el;
    }
  }

  // 取第一个 textarea（最常见）
  const textarea = inputs.find((e) => e.tag === 'textarea');
  if (textarea) {
    const el = await page.$(textarea.selector);
    if (el) return el;
  }

  // 取第一个 contenteditable
  const editable = inputs.find((e) => e.selector.includes('contenteditable'));
  if (editable) {
    const el = await page.$(editable.selector);
    if (el) return el;
  }

  // 取第一个 input
  const input = inputs.find((e) => e.tag === 'input');
  if (input) {
    const el = await page.$(input.selector);
    if (el) return el;
  }

  // 兜底：取第一个
  const first = inputs[0];
  if (first) {
    const el = await page.$(first.selector);
    if (el) return el;
  }

  return null;
}

/**
 * 智能查找可点击元素：用于"按钮未找到"兜底
 *
 * @param page Playwright Page
 * @param text 按钮文本（如 "联网"、"深度思考"）
 */
export async function smartFindClickableElement(
  page: Page,
  text: string,
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  // 1. 优先按文本精确查找
  try {
    const el = await page.$(`text=${text}`);
    if (el) return el as ElementHandle<SVGElement | HTMLElement>;
  } catch {}

  // 2. XPath 文本匹配
  try {
    const el = await page.$(`xpath=//*[contains(text(), "${text}")]`);
    if (el) return el as ElementHandle<SVGElement | HTMLElement>;
  } catch {}

  // 3. 索引列表模糊匹配
  const elements = await getState(page);
  const lower = text.toLowerCase();
  const matched = elements.find(
    (e) => e.enabled && (e.text.toLowerCase().includes(lower) || e.selector.toLowerCase().includes(lower)),
  );
  if (matched) {
    const el = await page.$(matched.selector);
    if (el) return el as ElementHandle<SVGElement | HTMLElement>;
  }

  return null;
}

/**
 * 智能提取最长文本元素：用于内容提取兜底
 *
 * 当 responseSelector 匹配到的内容过短时，扫描页面所有 div/section/article，
 * 取最长的可见文本元素，避免提取到占位符或 loading 状态。
 *
 * @param page Playwright Page
 * @param minLength 最小可接受长度（默认 50 字符）
 */
export async function smartFindLongestContent(
  page: Page,
  minLength: number = 50,
): Promise<{ text: string; html: string } | null> {
  const result = await page.evaluate((minLen) => {
    const candidates = Array.from(document.querySelectorAll(
      'div, section, article, [class*="answer"], [class*="response"], [class*="message"], [class*="markdown"]'
    )) as HTMLElement[];

    // 导航/侧边栏关键词 — class/id 包含这些的元素一律跳过
    const navPatterns = /sidebar|side-bar|sidenav|side-nav|navigation|nav-bar|navbar|menu|aside|left-bar|leftbar|right-bar|rightbar|history|conversation-list|chat-list|session/i;

    interface Candidate {
      text: string;
      html: string;
      score: number;
    }
    const scored: Candidate[] = [];

    for (const el of candidates) {
      // 跳过不可见
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // 跳过 <style> / <script> / <noscript> 元素本身
      const tag = el.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;

      // 跳过导航/侧边栏元素（class/id/role 匹配）
      const className = el.className || '';
      const id = el.id || '';
      const role = el.getAttribute('role') || '';
      if (navPatterns.test(className) || navPatterns.test(id) || role === 'navigation' || role === 'menu') continue;

      // 提取文本时排除 <style>/<script> 子元素的内容
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('style, script, noscript').forEach(e => e.remove());
      const text = (clone.textContent || '').trim();
      if (text.length < minLen) continue;

      // 跳过 CSS/JS 代码特征
      const cssCharRatio = (text.match(/[{};:]/g) || []).length / text.length;
      if (cssCharRatio > 0.15 && text.length > 500) continue;

      // ===== 评分系统 =====
      let score = text.length;

      // [加分] 含 <p> 标签 = 散文内容（AI 回答的核心特征）
      const pCount = el.querySelectorAll('p').length;
      if (pCount > 0) {
        score *= 3; // 3 倍加权
      }

      // [加分] 含 markdown 相关 class
      if (/markdown|prose|content-body|message-content|answer-content|response-content/i.test(className)) {
        score *= 2;
      }

      // [加分] 含标题标签（h1-h6 = 结构化内容）
      const headingCount = el.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
      if (headingCount > 0) {
        score *= 1.5;
      }

      // [加分] 含列表标签（ul/ol = 结构化内容）
      const listCount = el.querySelectorAll('ul, ol').length;
      if (listCount > 0) {
        score *= 1.3;
      }

      // [减分] 链接密度高 = 导航/侧边栏
      const linkCount = el.querySelectorAll('a').length;
      if (linkCount > 3) {
        const linkTextLen = Array.from(el.querySelectorAll('a'))
          .reduce((sum, a) => sum + (a.textContent || '').length, 0);
        const linkRatio = linkTextLen / text.length;
        score *= (1 - linkRatio * 0.8); // 链接文本占比越高，扣分越多
      }

      // [减分] 子元素过多但文本少 = UI 容器（如下拉菜单、工具栏）
      const childCount = el.querySelectorAll('*').length;
      if (childCount > 0 && text.length / childCount < 10) {
        score *= 0.3;
      }

      // [减分] 屏幕左边缘或右边缘 = 侧边栏位置
      if (rect.left < 50 || rect.right > window.innerWidth - 50) {
        score *= 0.5;
      }

      // [减分] 含表单元素 = 输入区
      if (el.querySelector('textarea, input[type="text"], [contenteditable="true"]')) {
        score *= 0.3;
      }

      scored.push({ text, html: clone.innerHTML || '', score });
    }

    if (scored.length === 0) return null;

    // 按评分排序，取最高分
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    if (best.text.length < minLen) return null;
    return { text: best.text, html: best.html };
  }, minLength);

  return result || null;
}
