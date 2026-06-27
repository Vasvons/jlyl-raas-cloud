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
 */
export async function smartFindInputElement(
  page: Page,
  preferredText?: string,
): Promise<ElementHandle | null> {
  const elements = await getState(page);

  // 仅保留可输入元素
  const inputs = elements.filter(
    (e) =>
      e.enabled &&
      (e.tag === 'textarea' ||
        e.tag === 'input' ||
        e.selector.includes('contenteditable') ||
        e.selector.includes('role="textbox"') ||
        e.selector.includes('[role="textbox"]')),
  );

  if (inputs.length === 0) return null;

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

    let bestText = '';
    let bestHtml = '';

    for (const el of candidates) {
      // 跳过不可见
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const text = (el.textContent || '').trim();
      // 跳过过短文本（通常是占位符、按钮文字等）
      if (text.length < minLen) continue;
      // 跳过包含过多子元素重复文本的容器（如整个页面 body）
      // 启发式：如果文本长度 / 子元素数量 > 20，认为是内容容器
      const childCount = el.querySelectorAll('*').length;
      if (childCount > 0 && text.length / childCount < 5) continue;

      if (text.length > bestText.length) {
        bestText = text;
        bestHtml = el.innerHTML || '';
      }
    }

    if (bestText.length < minLen) return null;
    return { text: bestText, html: bestHtml };
  }, minLength);

  return result || null;
}
