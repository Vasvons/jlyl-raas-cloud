/**
 * 索引化交互器（借鉴 BrowserAct 的 state/click/input 命令设计）
 *
 * 核心思想：不再依赖容易失效的 CSS/XPath 选择器，而是：
 * 1. state 命令：扫描页面所有可交互元素，返回 [{index, tag, type, text, selector}] 索引列表
 * 2. click <index>：按索引点击元素
 * 3. input <index> <text>：按索引填写输入框
 *
 * 三层选择器优先级（借鉴 BrowserAct Skill Forge）：
 *   data-testid > id > name > aria-label > 结构路径（CSS）
 *
 * 与 stepExecutor 的关系：
 *  - stepExecutor 原有的 click/fill 等步骤保持兼容（基于选择器）
 *  - 新增 state/clickIndex/inputIndex 三种步骤类型，基于索引交互
 *  - 当选择器找不到元素时，可降级到索引化交互（兜底）
 */

import { Page, ElementHandle } from 'playwright';

/**
 * 可交互元素的索引化描述
 */
export interface IndexedElement {
  /** 索引号（在当前页面状态中的唯一编号） */
  index: number;
  /** 标签名（INPUT/BUTTON/A/DIV 等） */
  tag: string;
  /** 元素类型（input 的 type 属性，或 button/a 的标签名） */
  type: string;
  /** 可见文本（按钮文字、链接文字、placeholder 等） */
  text: string;
  /** 稳定选择器（按三层优先级生成） */
  selector: string;
  /** 是否可见 */
  visible: boolean;
  /** 是否可交互（未禁用） */
  enabled: boolean;
  /** 边界框（用于 click_by_xy 兜底） */
  bbox?: { x: number; y: number; width: number; height: number };
}

/**
 * state 命令：扫描页面可交互元素，返回索引列表
 *
 * 扫描范围：
 *  - input（text/search/password/email/number/url/tel）
 *  - textarea
 *  - button
 *  - a（带 href 的链接）
 *  - [contenteditable="true"]
 *  - [role="button"] / [role="link"] / [role="textbox"]
 *  - select
 *
 * @param page Playwright Page 或 Frame
 * @param filter 可选过滤条件（如 { tag: 'input' } 只返回输入框）
 */
export async function getState(
  page: Page | { $eval: Function; $$eval: Function; evaluate: Function },
  filter?: { tag?: string; text?: string }
): Promise<IndexedElement[]> {
  const rawElements = await (page as any).evaluate(() => {
    const results: any[] = [];

    // 可交互元素的 CSS 选择器
    const interactiveSelector = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]):not([type="checkbox"]):not([type="radio"])',
      'input[type="submit"]',
      'input[type="button"]',
      'textarea',
      'button',
      'a[href]',
      'select',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
    ].join(', ');

    const elements = Array.from(document.querySelectorAll(interactiveSelector));

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // 跳过不可见元素
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      // 检查 visibility
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

      // 生成稳定选择器（三层优先级）
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
        // 结构路径（兜底）
        selector = generateStructuralSelector(el);
      }

      results.push({
        tag,
        type,
        text,
        selector,
        visible: true,
        enabled,
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    }

    function generateStructuralSelector(el: Element): string {
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 5) {
        const part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`#${node.id}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === node!.tagName);
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
    }

    return results;
  });

  // 添加索引号 + 应用过滤
  const indexed: IndexedElement[] = rawElements.map((e: any, i: number) => ({
    index: i,
    ...e,
  }));

  if (filter?.tag) {
    return indexed.filter((e) => e.tag.toLowerCase() === filter.tag!.toLowerCase());
  }
  if (filter?.text) {
    const lower = filter.text.toLowerCase();
    return indexed.filter((e) => e.text.toLowerCase().includes(lower));
  }

  return indexed;
}

/**
 * click <index>：按索引点击元素
 */
export async function clickByIndex(
  page: Page,
  index: number,
  options?: { timeout?: number; force?: boolean }
): Promise<boolean> {
  const elements = await getState(page);
  const target = elements.find((e) => e.index === index);
  if (!target) {
    throw new Error(`索引 ${index} 不存在（当前页面共 ${elements.length} 个可交互元素）`);
  }
  if (!target.enabled) {
    throw new Error(`元素索引 ${index}（${target.tag}）已禁用`);
  }

  // 优先用选择器点击
  try {
    const el = await page.$(target.selector);
    if (el) {
      await el.click({ timeout: options?.timeout || 5000, force: options?.force });
      return true;
    }
  } catch {
    // 选择器失败，降级到坐标点击
  }

  // 兜底：用 bbox 坐标点击
  if (target.bbox) {
    const cx = target.bbox.x + target.bbox.width / 2;
    const cy = target.bbox.y + target.bbox.height / 2;
    await page.mouse.click(cx, cy);
    return true;
  }

  throw new Error(`索引 ${index} 点击失败：选择器和坐标均不可用`);
}

/**
 * input <index> <text>：按索引填写输入框
 */
export async function inputByIndex(
  page: Page,
  index: number,
  text: string,
  options?: { timeout?: number; force?: boolean; clear?: boolean }
): Promise<boolean> {
  const elements = await getState(page);
  const target = elements.find((e) => e.index === index);
  if (!target) {
    throw new Error(`索引 ${index} 不存在`);
  }
  if (!target.enabled) {
    throw new Error(`元素索引 ${index}（${target.tag}）已禁用`);
  }

  // 优先用选择器
  try {
    const el = await page.$(target.selector) as ElementHandle<HTMLInputElement | HTMLTextAreaElement> | null;
    if (el) {
      if (options?.clear !== false) {
        await el.fill('', { force: true }).catch(() => {});
      }
      await el.fill(text, { timeout: options?.timeout || 5000, force: options?.force });
      return true;
    }
  } catch {
    // 降级
  }

  // 兜底：点击聚焦 + 键盘输入
  if (target.bbox) {
    const cx = target.bbox.x + target.bbox.width / 2;
    const cy = target.bbox.y + target.bbox.height / 2;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(100);
    if (options?.clear !== false) {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
    }
    await page.keyboard.type(text, { delay: 50 });
    return true;
  }

  throw new Error(`索引 ${index} 输入失败`);
}

/**
 * 智能查找元素：先按选择器找，找不到则按文本/属性匹配
 *
 * 用于 stepExecutor 的 click/fill 步骤增强：
 * 当原选择器找不到时，自动用 indexedInteractor 兜底
 *
 * @param page Playwright Page
 * @param selector 原始选择器（支持 css / xpath / "text=xxx" / "placeholder=xxx"）
 */
export async function smartFindElement(
  page: Page,
  selector: string,
  options?: { timeout?: number }
): Promise<ElementHandle | null> {
  const timeout = options?.timeout || 5000;

  // 1. 优先按原选择器查找
  try {
    if (selector.startsWith('//')) {
      const el = await page.$(`xpath=${selector}`);
      if (el) return el;
    } else if (selector.startsWith('text=')) {
      const text = selector.slice(5);
      const el = await page.$(`text=${text}`);
      if (el) return el;
    } else if (selector.startsWith('placeholder=')) {
      const placeholder = selector.slice(12);
      const el = await page.$(`[placeholder="${placeholder}"]`);
      if (el) return el;
    } else {
      const el = await page.$(selector);
      if (el) return el;
    }
  } catch {
    // 继续 fallback
  }

  // 2. 降级：扫描索引列表，按文本/属性模糊匹配
  const elements = await getState(page);
  const selectorLower = selector.toLowerCase();

  // 尝试从 selector 中提取关键词
  let keyword = selectorLower;
  if (keyword.startsWith('text=')) keyword = keyword.slice(5);
  else if (keyword.startsWith('placeholder=')) keyword = keyword.slice(12);
  else keyword = keyword.replace(/[.#\[\]:"=]/g, ' ').trim();

  if (!keyword) return null;

  // 模糊匹配文本
  const matched = elements.find(
    (e) =>
      e.text.toLowerCase().includes(keyword) ||
      e.selector.toLowerCase().includes(keyword)
  );

  if (matched) {
    try {
      const el = await page.$(matched.selector);
      if (el) return el;
    } catch {}
  }

  // 3. 最终兜底：等待原选择器出现
  try {
    if (selector.startsWith('//')) {
      return await page.waitForSelector(`xpath=${selector}`, { timeout, state: 'attached' });
    }
    return await page.waitForSelector(selector, { timeout, state: 'attached' });
  } catch {
    return null;
  }
}
