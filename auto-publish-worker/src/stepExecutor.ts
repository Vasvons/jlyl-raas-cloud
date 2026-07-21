import { Page, Frame, ElementHandle } from 'playwright';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getState, clickByIndex, inputByIndex, smartFindElement } from './indexedInteractor';
import { humanClick, humanType, humanDelay, randomizedWait } from './behaviorHumanizer';

/**
 * step_list 通用执行器（spec 6.3）
 *
 * 支持 18 种 step 类型（原 15 种 + 新增 3 种索引化交互 + v1.5.6 新增 ai_action）：
 *   navigate / click / fill / press / content / input_files / hover
 *   wait_for_selector / wait_for_url / iframe_selector
 *   tags / timing / branch / evaluate_edit / get_by_xy
 *   state / click_index / input_index  ← 索引化交互（借鉴 BrowserAct state/click/input 命令）
 *   ai_action                          ← v1.5.6 新增（混合模式：截图给多模态 LLM 识别元素坐标）
 *
 * 关键字段：
 *   - is_try=true    失败不中断（仅记录 warning）
 *   - is_exist       wait_for_selector 时仅检测存在性，不要求必须存在
 *   - nth            选择第 N 个匹配元素（从 0 开始）
 *   - force          click/fill 时跳过 actionability 检查
 *   - branch_steps   branch 类型条件成立时执行
 *   - else_list      branch 类型条件不成立时执行
 *   - humanize=true  启用人性化行为（贝塞尔曲线鼠标 + 随机延迟 + 逐字符输入）
 *   - value 中的占位符 {title} {content} {tags} {cover_image_url} 会被文章数据替换
 *
 * 三层选择器优先级（借鉴 BrowserAct Skill Forge）：
 *   data-testid > id > name > aria-label > 结构路径（CSS）
 *   当原选择器找不到元素时，自动降级到 smartFindElement 模糊匹配兜底
 */

export interface Step {
  type: string;
  selector?: string;
  value?: string;
  descript?: string;
  is_wait?: number;
  is_exist?: boolean;
  is_try?: boolean;
  nth?: number;
  timeout?: number;
  force?: boolean;
  branch_steps?: Step[];
  is_list?: Step[];
  else_list?: Step[];
  /** branch 类型的条件求值表达式（在页面上下文中执行，返回 boolean） */
  condition?: string;
  /** input_files 类型的文件路径列表 */
  files?: string[];
  /** get_by_xy 类型的坐标 */
  x?: number;
  y?: number;
  /** get_by_xy 类型：优先使用 window.__jlyl_cover_img_x/y 的真实坐标点击（解决 selector 中心点点击未命中问题） */
  use_window_coords?: boolean;
  /** timing 类型的等待毫秒数（也可用 is_wait 字段） */
  ms?: number;
  /** iframe_selector 类型的 iframe 定位器 */
  iframe?: string;
  /** 是否启用人性化行为（贝塞尔曲线鼠标 + 随机延迟 + 逐字符输入），默认 false */
  humanize?: boolean;
  /** state 类型的过滤条件（{ tag?: string, text?: string }） */
  filter?: { tag?: string; text?: string };
  /** state 类型的结果存储到 lastEvalResult（供后续 click_index/input_index 使用） */
  capture_state?: boolean;
  /** v1.5.6 ai_action 类型：操作意图描述（如"找到标题输入框"） */
  intent?: string;
  /** v1.5.6 ai_action 类型：动作类型 fill/click/verify */
  ai_action?: 'fill' | 'click' | 'verify';
  /** v1.5.6 ai_action 类型：最大重试次数（默认 2） */
  max_retries?: number;
  /** v1.7.0 ai_fallback：确定性步骤失败时自动调用 AI 视觉识别兜底 */
  ai_fallback?: boolean;
  /** v1.7.0 ai_fallback 触发时的 intent 描述（默认用 descript） */
  ai_intent?: string;
  /** v1.7.5 evaluate_edit 类型的参数，会通过 page.evaluate 第二个参数传入（arguments[0]） */
  args?: string;
  /** v1.7.16 input_files_chooser 类型：触发文件选择对话框的 JS 表达式（点击封面选择器/菜单项/弹窗按钮） */
  trigger_click?: string;
  /** v1.9.37 tags 类型：是否为每个标签自动补 # 前缀（抖音等平台要求 # 开头才识别为话题） */
  add_hash?: boolean;
  /** v1.9.38 content/fill 类型：粘贴/填入前先 Ctrl+A + Delete 清空已有内容（企鹅号等平台编辑页会加载草稿） */
  clear_first?: boolean;
  /** v1.7.11 input_files 类型：自定义上传完成信号选择器（百家号封面弹窗等），匹配即完成不等待 30s */
  upload_complete_selector?: string;
  /** v1.7.11 input_files 类型：自定义上传完成等待超时（ms，默认 15000） */
  upload_complete_timeout?: number;
}

export interface StepExecutionContext {
  page: Page;
  platform: string;
  article: {
    title: string;
    content_html: string;
    tags?: string[];
    cover_image_url?: string;
  };
  scheduledAt?: Date;
  onLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** evaluate_edit 步骤的返回值（最后一次） */
  lastEvalResult?: any;
}

/**
 * 执行单个 step
 * @returns true 表示成功（或 is_try 容错）；false 表示失败且未容错
 */
export async function executeStep(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const { onLog } = ctx;
  const label = step.descript || `${step.type}${step.selector ? ' ' + step.selector : ''}`;
  onLog?.(`[step] → ${label}`, 'info');

  try {
    switch (step.type) {
      case 'navigate':         return await execNavigate(step, ctx);
      case 'click':            return await execClick(step, ctx);
      case 'fill':             return await execFill(step, ctx);
      case 'press':            return await execPress(step, ctx);
      case 'content':          return await execContent(step, ctx);
      case 'input_files':      return await execInputFiles(step, ctx);
      case 'input_files_chooser': return await execInputFilesChooser(step, ctx);
      case 'hover':            return await execHover(step, ctx);
      case 'wait_for_selector':return await execWaitForSelector(step, ctx);
      case 'wait_for_url':     return await execWaitForUrl(step, ctx);
      case 'iframe_selector':  return await execIframeSelector(step, ctx);
      case 'tags':             return await execTags(step, ctx);
      case 'timing':           return await execTiming(step, ctx);
      case 'branch':           return await execBranch(step, ctx);
      case 'evaluate_edit':    return await execEvaluateEdit(step, ctx);
      case 'get_by_xy':        return await execGetByXY(step, ctx);
      case 'state':            return await execState(step, ctx);
      case 'click_index':      return await execClickIndex(step, ctx);
      case 'input_index':      return await execInputIndex(step, ctx);
      case 'keyboard_type':    return await execKeyboardType(step, ctx);
      case 'ai_action': {
        // v2.5.0：云端直调 LLM 视觉识别
        const { executeAiAction } = await import('./aiActionExecutor');
        const intent = step.intent || step.descript || '';
        const action = step.ai_action || 'click';
        const maxRetries = step.max_retries || 2;
        if (!intent) {
          if (step.is_try) {
            ctx.onLog?.(`ai_action 缺少 intent，跳过`, 'warn');
            return true;
          }
          throw new Error(`ai_action 缺少 intent 描述`);
        }
        ctx.onLog?.(`AI 视觉动作: ${intent}（action=${action}, 最大重试=${maxRetries}）`);
        const result = await executeAiAction(ctx.page, intent, action, step.value, maxRetries);
        if (!result.success) {
          if (step.is_try) {
            ctx.onLog?.(`ai_action 失败但 is_try=true，跳过: ${result.error}`, 'warn');
            return true;
          }
          throw new Error(`AI 视觉动作失败: ${result.error}`);
        }
        ctx.onLog?.(`AI 视觉动作成功: (${result.x}, ${result.y}) confidence=${result.confidence}`);
        return true;
      }
      default:
        throw new Error(`未知 step 类型: ${step.type}`);
    }
  } catch (err: any) {
    if (step.is_try) {
      onLog?.(`[step] ⚠ ${label} 失败但已容错跳过: ${err.message}`, 'warn');
      return true;
    }
    onLog?.(`[step] ✗ ${label} 失败: ${err.message}`, 'error');
    throw err;
  }
}

/**
 * 执行 step 列表（顺序执行，任一失败则中断除非 is_try）
 */
export async function executeSteps(steps: Step[], ctx: StepExecutionContext): Promise<void> {
  for (const step of steps) {
    await executeStep(step, ctx);
  }
}

// ============ 占位符替换 ============

function resolveValue(raw: string | undefined, ctx: StepExecutionContext): string | undefined {
  if (!raw) return raw;
  const { article } = ctx;
  return raw
    .replace(/\{title\}/g, article.title || '')
    .replace(/\{content\}/g, article.content_html || '')
    .replace(/\{tags\}/g, (article.tags || []).join(','))
    .replace(/\{cover_image_url\}/g, article.cover_image_url || '');
}

// ============ 选择器解析 ============

/**
 * 解析多格式选择器字符串
 *
 * step_list 中 selector 字段支持：
 *   - "css selector"
 *   - "//xpath"
 *   - "css1 | //xpath1 | css2"（多种选择器任一匹配，用 "|" 分割）
 *
 * 重要：分隔符必须是 " | "（前后有空格的管道符），否则会被当作选择器的一部分。
 * XPath 选择器内的 "/" 不能作为分隔符（"//input" 中的 "//" 是 XPath 起始符）。
 *
 * @returns 字符串数组（每个元素是一个独立选择器）
 */
function parseSelectors(selector: string): string[] {
  // 仅以 " | " (管道符前后必须有空白) 作为分隔符
  // 不再用 "/" 作为分隔符，因为 XPath 起始符 "//" 包含 "/"
  const parts = selector.split(/\s+\|\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [selector.trim()];
}

/**
 * 在页面上查找第一个匹配的元素（多选择器任一匹配）
 */
async function findElement(page: Page, selector: string, nth?: number): Promise<ElementHandle | null> {
  const selectors = parseSelectors(selector);
  for (const sel of selectors) {
    // shadow: 前缀：在 Shadow DOM 内查询（仅支持 open shadow root）
    if (sel.startsWith('shadow:')) {
      const innerSelector = sel.slice(7);
      try {
        const handle = await page.evaluateHandle((s) => {
          const hosts = Array.from(document.querySelectorAll('*'));
          for (const host of hosts) {
            // 用标准 host.shadowRoot 替代非标准 __openShadow
            // 注意：closed shadow root 的 shadowRoot 返回 null，无法通过 JS 访问
            const shadow = (host as any).shadowRoot as ShadowRoot | undefined;
            if (shadow) {
              const el = shadow.querySelector(s);
              if (el) return el;
            }
          }
          return null;
        }, innerSelector);
        const el = handle.asElement();
        if (el) return el;
      } catch {
        // 继续尝试下一个选择器
      }
      continue;
    }

    // 原 CSS/XPath 逻辑（保持不变）
    try {
      if (sel.startsWith('//')) {
        // XPath
        const handle = await page.$(`xpath=${sel}`);
        if (handle) {
          if (nth !== undefined && nth > 0) {
            const all = await page.$$(`xpath=${sel}`);
            return all[nth] || handle;
          }
          return handle;
        }
      } else {
        const handle = await page.$(sel);
        if (handle) {
          if (nth !== undefined && nth > 0) {
            const all = await page.$$(sel);
            return all[nth] || handle;
          }
          return handle;
        }
      }
    } catch {
      // 单个选择器解析失败，继续尝试下一个
    }
  }
  return null;
}

// ============ 各 step 类型实现 ============

async function execNavigate(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const url = resolveValue(step.value, ctx)!;
  const timeout = step.timeout || 30000;
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  // 额外等待网络空闲（可选，提升 SPA 稳定性）
  try {
    await ctx.page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8000) });
  } catch {
    // 网络空闲等待失败不阻断
  }
  return true;
}

async function execClick(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const timeout = step.timeout || 5000;
  let el = await waitForElement(ctx.page, selector, timeout);

  // 兜底：原选择器找不到时，用 smartFindElement 模糊匹配
  if (!el) {
    el = await smartFindElement(ctx.page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'click');
    if (aiOk) return true;
    if (step.is_try) return true;
    throw new Error(`元素未找到: ${selector}`);
  }

  // 人性化点击（可选）
  if (step.humanize) {
    await humanClick(ctx.page, el, { force: step.force, timeout });
  } else {
    await el.click({ force: step.force, timeout });
  }
  return true;
}

async function execFill(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const value = resolveValue(step.value, ctx)!;
  const timeout = step.timeout || 5000;
  let el = await waitForElement(ctx.page, selector, timeout);

  // 兜底：原选择器找不到时，用 smartFindElement 模糊匹配
  if (!el) {
    el = await smartFindElement(ctx.page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'fill');
    if (aiOk) return true;
    if (step.is_try) return true;
    throw new Error(`元素未找到: ${selector}`);
  }

  // 人性化输入（可选）
  if (step.humanize) {
    await humanType(ctx.page, el, value, { force: step.force, clear: true });
  } else if (step.clear_first) {
    // v1.9.38：clear_first 选项——先聚焦 + Ctrl+A + Delete 清空，再 fill
    // 适用于 contenteditable 元素 fill('') 无法清空的场景
    await el.click({ force: step.force }).catch(() => {});
    await ctx.page.keyboard.press('Control+a').catch(() => {});
    await ctx.page.waitForTimeout(100);
    await ctx.page.keyboard.press('Delete').catch(() => {});
    await ctx.page.waitForTimeout(200);
    await el.fill(value, { force: step.force, timeout }).catch(async () => {
      // fill 失败时降级为 keyboard.type
      await ctx.page.keyboard.type(value, { delay: 30 }).catch(() => {});
    });
  } else {
    // 先清空再填写（避免追加）
    await el.fill('', { force: step.force }).catch(() => {});
    await el.fill(value, { force: step.force, timeout });
  }
  return true;
}

async function execPress(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const key = resolveValue(step.value, ctx) || 'Enter';
  const timeout = step.timeout || 5000;
  // 兼容 auth helper step_list 协议：press + value="content" 表示"输入正文"
  // v1.9.42：用明确的按键名白名单判断，避免 "Escape"(7字符) 被误判为正文
  const KEY_NAMES = new Set([
    'Enter','Tab','Backspace','Escape','Esc','Space','ArrowUp','ArrowDown',
    'ArrowLeft','ArrowRight','Delete','Insert','Home','End','PageUp','PageDown',
    'Control','Alt','Shift','Meta','CapsLock','NumLock','ScrollLock',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  ]);
  const isKeyName = KEY_NAMES.has(key) || /^(Control|Alt|Shift|Meta)\+[a-zA-Z0-9]$/.test(key) || /^.$/.test(key);
  if (key && key.length > 5 && !isKeyName) {
    return await execContent(step, ctx);
  }
  if (step.selector) {
    let el = await waitForElement(ctx.page, step.selector, timeout);
    if (!el) {
      el = await smartFindElement(ctx.page, step.selector, { timeout: Math.min(timeout, 3000) });
    }
    if (!el) {
      // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底（press 用 click 聚焦再 press）
      const aiOk = await tryAiFallback(step, ctx, 'click');
      if (aiOk) {
        // AI 已点击聚焦，直接按键
        await ctx.page.keyboard.press(key);
        return true;
      }
      if (step.is_try) return true;
      throw new Error(`元素未找到: ${step.selector}`);
    }
    await el.press(key, { timeout });
  } else {
    await ctx.page.keyboard.press(key);
  }
  return true;
}

/**
 * content 类型：富文本正文填充（spec 6.3 三种实现）
 *
 * 策略（按优先级）：
 *  1. 剪贴板粘贴：click 聚焦 → 写 HTML 到剪贴板 → Ctrl+V（兼容性最好，触发 input 事件）
 *  2. insertHTML：document.execCommand('insertHTML', false, html)（旧版可靠）
 *  3. innerHTML + dispatchEvent：直接赋值并派发 input 事件（兜底）
 */
async function execContent(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const { page, article } = ctx;
  const selector = step.selector!;
  const html = resolveValue(step.value, ctx) || article.content_html;
  const timeout = step.timeout || 10000;

  let el = await waitForElement(page, selector, timeout);
  if (!el) {
    el = await smartFindElement(page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'fill');
    if (aiOk) return true;
    if (step.is_try) return true;
    throw new Error(`编辑区元素未找到: ${selector}`);
  }

  // 聚焦编辑区
  await el.click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);

  // v1.9.38：clear_first 选项——粘贴前先 Ctrl+A + Delete 清空已有内容
  // 适用于企鹅号等编辑页会自动加载草稿的平台
  if (step.clear_first) {
    await page.keyboard.press('Control+a').catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press('Delete').catch(() => {});
    await page.waitForTimeout(300);
    ctx.onLog?.(`[step] content clear_first 已清空已有内容`, 'info');
  }

  // v2.5.33：统计原始 HTML 中的关键标签数量，用于后续校验编辑器是否过滤了内容
  //   百家号 ueditor 等编辑器会过滤 <table>/<img> 等标签，导致发布后表格变问号、图片丢失
  const rawTableCount = (html.match(/<table\b/gi) || []).length;
  const rawImgCount = (html.match(/<img\b/gi) || []).length;

  // 策略1：剪贴板粘贴（推荐，最接近真实用户操作）
  const clipboardOk = await tryClipboardPaste(page, html);
  if (clipboardOk) {
    // v2.5.33：校验剪贴板粘贴后内容是否被编辑器过滤
    const verified = await verifyContentIntegrity(page, selector, rawTableCount, rawImgCount);
    if (verified) {
      ctx.onLog?.(`[step] content 已通过剪贴板粘贴`, 'info');
      return true;
    }
    ctx.onLog?.(`[step] content 剪贴板粘贴后被编辑器过滤（table/img 丢失），降级到 insertHTML`, 'warn');
  }

  // 策略2：insertHTML
  const insertOk = await tryInsertHTML(page, selector, html);
  if (insertOk) {
    // v2.5.33：校验 insertHTML 后内容是否被编辑器过滤
    const verified = await verifyContentIntegrity(page, selector, rawTableCount, rawImgCount);
    if (verified) {
      ctx.onLog?.(`[step] content 已通过 insertHTML 注入`, 'info');
      return true;
    }
    ctx.onLog?.(`[step] content insertHTML 注入后被编辑器过滤（table/img 丢失），降级到 innerHTML`, 'warn');
  }

  // 策略3：innerHTML + dispatchEvent 兜底（绕过编辑器命令，直接写 DOM）
  const fallbackOk = await tryInnerHTML(page, selector, html);
  if (fallbackOk) {
    ctx.onLog?.(`[step] content 已通过 innerHTML 兜底注入`, 'info');
    return true;
  }

  throw new Error('所有正文填充策略均失败');
}

/**
 * 策略1：通过 Clipboard API 写入 HTML，然后 Ctrl+V 粘贴
 */

/**
 * v2.5.33：校验编辑器内容完整性
 *
 * 某些编辑器（如百家号 ueditor）会过滤 <table>/<img> 等标签，导致发布后表格变问号、图片丢失。
 * 本函数在内容注入后检查编辑器 DOM 中这些关键标签的数量是否与原始 HTML 一致。
 *
 * @param page Playwright Page 或 Frame（iframe 场景下是 frame）
 * @param selector 编辑器选择器
 * @param rawTableCount 原始 HTML 中的 <table> 数量
 * @param rawImgCount 原始 HTML 中的 <img> 数量
 * @returns true=内容完整未被过滤，false=关键标签被过滤
 */
async function verifyContentIntegrity(
  page: Page,
  selector: string,
  rawTableCount: number,
  rawImgCount: number
): Promise<boolean> {
  // 没有关键标签时无需校验，直接通过
  if (rawTableCount === 0 && rawImgCount === 0) {
    return true;
  }
  try {
    const counts = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) return null;
      return {
        tableCount: el.querySelectorAll('table').length,
        imgCount: el.querySelectorAll('img').length,
      };
    }, parseSelectors(selector)[0]);
    if (!counts) return false;
    // 表格必须完整保留（表格被过滤是严重问题）
    if (counts.tableCount < rawTableCount) {
      return false;
    }
    // 图片允许部分丢失（某些外链图片可能加载失败被编辑器移除），但至少要保留一半
    if (rawImgCount > 0 && counts.imgCount < Math.ceil(rawImgCount / 2)) {
      return false;
    }
    return true;
  } catch {
    // 校验失败时保守返回 true，避免误降级
    return true;
  }
}

async function tryClipboardPaste(page: Page, html: string): Promise<boolean> {
  try {
    // 授予剪贴板权限
    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']).catch(() => {});

    // 写 HTML 到剪贴板（使用 ClipboardItem，支持富文本）
    const written = await page.evaluate(async (htmlContent) => {
      try {
        // 优先用 ClipboardItem 写 HTML+纯文本
        if (navigator.clipboard && (window as any).ClipboardItem) {
          const blob = new Blob([htmlContent], { type: 'text/html' });
          const textBlob = new Blob([htmlContent.replace(/<[^>]+>/g, '')], { type: 'text/plain' });
          const item = new (window as any).ClipboardItem({
            'text/html': blob,
            'text/plain': textBlob,
          });
          await navigator.clipboard.write([item]);
          return true;
        }
        // 降级：用 execCommand
        const listener = (e: ClipboardEvent) => {
          e.clipboardData?.setData('text/html', htmlContent);
          e.clipboardData?.setData('text/plain', htmlContent.replace(/<[^>]+>/g, ''));
          e.preventDefault();
        };
        document.addEventListener('copy', listener);
        document.execCommand('copy');
        document.removeEventListener('copy', listener);
        return true;
      } catch (e) {
        return false;
      }
    }, html);

    if (!written) return false;

    // Ctrl+V 粘贴
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(500);
    return true;
  } catch (e: any) {
    return false;
  }
}

/**
 * 策略2：document.execCommand('insertHTML')
 */
async function tryInsertHTML(page: Page, selector: string, html: string): Promise<boolean> {
  try {
    return await page.evaluate(({ selector, html }) => {
      try {
        // 聚焦目标元素
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) return false;
        el.focus();
        // execCommand 已废弃但仍广泛支持
        return document.execCommand('insertHTML', false, html);
      } catch {
        return false;
      }
    }, { selector: parseSelectors(selector)[0], html });
  } catch {
    return false;
  }
}

/**
 * 策略3：直接 innerHTML 赋值 + 派发 input 事件（兜底，部分编辑器不响应）
 */
async function tryInnerHTML(page: Page, selector: string, html: string): Promise<boolean> {
  try {
    return await page.evaluate(({ selector, html }) => {
      try {
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) return false;
        el.innerHTML = html;
        // 派发 input 事件通知框架（ProseMirror/TipTap/Slate 等）
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    }, { selector: parseSelectors(selector)[0], html });
  } catch {
    return false;
  }
}

async function execInputFiles(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const files = (step.files || []).map(f => resolveValue(f, ctx)!).filter(Boolean);
  const timeout = step.timeout || 10000;
  if (files.length === 0) {
    if (step.is_try) return true;
    throw new Error('input_files 未提供文件路径');
  }

  let el = await waitForElement(ctx.page, selector, timeout);
  // 兜底1：smartFindElement 模糊匹配
  if (!el) {
    el = await smartFindElement(ctx.page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    // 注意：AI 兜底对文件上传不适用（无法用坐标上传文件），所以这里仅记录警告并容错
    if (step.is_try) return true;
    throw new Error(`文件输入元素未找到: ${selector}`);
  }

  // v1.7.6 调试：打印命中的 input 元素信息，便于排查"上传到错误的 input"
  try {
    const inputInfo = await ctx.page.evaluate((sel) => {
      const els = document.querySelectorAll('input[type="file"]');
      return Array.from(els).map((e) => {
        const r = (e as HTMLInputElement).getBoundingClientRect();
        return {
          accept: (e as HTMLInputElement).accept || '',
          className: (e as HTMLInputElement).className || '',
          visible: r.width > 0 && r.height > 0,
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          parentClass: (e.parentElement?.className || '').slice(0, 80),
        };
      });
    }, selector);
    ctx.onLog?.(`[step] 页面所有 file input: ${JSON.stringify(inputInfo)}`, 'info');
  } catch {}

  // 处理文件路径：URL 先下载到临时目录，本地路径直接使用
  const localFiles: string[] = [];
  const tempFiles: string[] = [];
  try {
    for (const f of files) {
      if (/^https?:\/\//i.test(f)) {
        // URL：下载到临时文件
        const ext = path.extname(new URL(f).pathname) || '.jpg';
        const tmpPath = path.join(os.tmpdir(), `publish-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        ctx.onLog?.(`[step] 下载图片: ${f.slice(0, 120)} → ${tmpPath}`, 'info');
        await downloadFile(f, tmpPath, 30000);
        // v1.7.10 验证下载文件：大小 + 图片格式
        const stats = fs.statSync(tmpPath);
        const buf = fs.readFileSync(tmpPath);
        const imgFmt = detectImageFormat(buf);
        ctx.onLog?.(`[step] 下载完成: ${tmpPath} (${(stats.size / 1024).toFixed(1)} KB, 格式=${imgFmt || '未知'})`, 'info');
        if (stats.size === 0) {
          throw new Error(`下载的图片文件大小为 0: ${f}`);
        }
        if (!imgFmt) {
          const preview = buf.slice(0, 200).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
          throw new Error(`下载的文件不是有效图片（可能是 OSS 错误页）: size=${stats.size}, 预览=${preview.slice(0, 150)}`);
        }
        localFiles.push(tmpPath);
        tempFiles.push(tmpPath);
      } else {
        // 本地路径直接使用
        localFiles.push(f);
      }
    }

    ctx.onLog?.(`[step] setInputFiles: ${localFiles.length} 个文件 → input`, 'info');
    await (el as ElementHandle<HTMLInputElement>).setInputFiles(localFiles);
    ctx.onLog?.(`[step] setInputFiles 调用完成`, 'info');

    // v1.7.10 关键修复：setInputFiles 后等待上传真正完成
    // 之前问题：setInputFiles 触发抖音跳转后立刻执行下一步，但 OSS 上传是异步的，
    // 跳转太快会导致上传请求被中断，页面永远卡在"上传中"
    // 修复：等待页面上的"上传中"进度条消失，或等待真实缩略图出现
    // v1.7.11：支持 step.upload_complete_selector 自定义完成信号（百家号封面弹窗等）
    if (step.upload_complete_selector) {
      await waitForUploadCompleteBySelector(ctx, step.upload_complete_selector, step.upload_complete_timeout || 15000);
    } else {
      await waitForUploadComplete(ctx, 30000);
    }
    return true;
  } finally {
    // 清理临时文件（无论成功失败）
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

/**
 * v1.7.16 input_files_chooser 类型：用 page.on('filechooser') 事件拦截文件选择对话框
 *
 * 适用场景：微信公众号封面图上传等"file input 难以定位"的场景
 *
 * 工作原理：
 *   1. 注册 page.on('filechooser') 监听器
 *   2. 下载图片到本地（如果是 URL）
 *   3. 执行 trigger_click 脚本（点击封面选择器/菜单项/弹窗按钮）
 *   4. 浏览器原生文件选择对话框触发 → filechooser 事件
 *   5. 用 fileChooser.setFiles(localFiles) 直接设置文件（不依赖 DOM 定位）
 *   6. 等待上传完成
 *
 * 配置字段：
 *   - trigger_click: 触发文件选择的 JS 表达式（必填）
 *   - files: 文件路径或 URL 数组（必填）
 *   - timeout: 总超时（默认 30000ms）
 */
async function execInputFilesChooser(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const triggerExpr = step.trigger_click;
  const files = (step.files || []).map(f => resolveValue(f, ctx)!).filter(Boolean);
  const timeout = step.timeout || 30000;
  if (!triggerExpr) {
    if (step.is_try) return true;
    throw new Error('input_files_chooser 未提供 trigger_click');
  }
  if (files.length === 0) {
    if (step.is_try) return true;
    throw new Error('input_files_chooser 未提供文件路径');
  }

  // 处理文件路径：URL 先下载到临时目录
  const localFiles: string[] = [];
  const tempFiles: string[] = [];
  try {
    for (const f of files) {
      if (/^https?:\/\//i.test(f)) {
        const ext = path.extname(new URL(f).pathname) || '.jpg';
        const tmpPath = path.join(os.tmpdir(), `publish-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        ctx.onLog?.(`[step] 下载图片: ${f.slice(0, 120)} → ${tmpPath}`, 'info');
        await downloadFile(f, tmpPath, 30000);
        const stats = fs.statSync(tmpPath);
        const buf = fs.readFileSync(tmpPath);
        const imgFmt = detectImageFormat(buf);
        ctx.onLog?.(`[step] 下载完成: ${tmpPath} (${(stats.size / 1024).toFixed(1)} KB, 格式=${imgFmt || '未知'})`, 'info');
        if (stats.size === 0) {
          throw new Error(`下载的图片文件大小为 0: ${f}`);
        }
        if (!imgFmt) {
          const preview = buf.slice(0, 200).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
          throw new Error(`下载的文件不是有效图片: size=${stats.size}, 预览=${preview.slice(0, 150)}`);
        }
        localFiles.push(tmpPath);
        tempFiles.push(tmpPath);
      } else {
        localFiles.push(f);
      }
    }

    // 策略：注册 filechooser 监听 → 执行 trigger_click → 等待 filechooser 事件
    ctx.onLog?.(`[step] 注册 filechooser 监听，准备执行 trigger_click`, 'info');
    let fileChooserResolve: (fc: any) => void;
    let fileChooserReject: (err: Error) => void;
    const fileChooserPromise = new Promise((resolve, reject) => {
      fileChooserResolve = resolve as any;
      fileChooserReject = reject;
    });
    const chooserTimeout = setTimeout(() => {
      fileChooserReject(new Error(`等待 filechooser 事件超时（${timeout}ms）`));
    }, timeout);
    const handler = (fc: any) => {
      clearTimeout(chooserTimeout);
      fileChooserResolve(fc);
    };
    ctx.page.on('filechooser', handler);

    try {
      // 执行 trigger_click JS 表达式（点击触发文件选择）
      ctx.onLog?.(`[step] 执行 trigger_click: ${triggerExpr.slice(0, 100)}...`, 'info');
      await ctx.page.evaluate(async ({ expr }) => {
        try {
          const fn = eval(`(async () => { ${expr} })`);
          await fn();
        } catch (e: any) {
          // 不抛错，让 filechooser 超时来处理
          console.log('trigger_click error:', e.message);
        }
      }, { expr: triggerExpr });

      // 等待 filechooser 事件
      const fileChooser: any = await fileChooserPromise;
      ctx.onLog?.(`[step] filechooser 事件触发，设置 ${localFiles.length} 个文件`, 'info');
      await fileChooser.setFiles(localFiles);
      ctx.onLog?.(`[step] setFiles 调用完成`, 'info');

      // 等待上传完成
      await waitForUploadComplete(ctx, 30000);
      return true;
    } finally {
      ctx.page.off('filechooser', handler);
    }
  } finally {
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

/**
 * v1.7.11：按自定义选择器等待上传完成（百家号封面弹窗等）
 *
 * 百家号封面弹窗上传完成后，弹窗内会出现已上传图片的 <img> 缩略图
 * 或上传按钮区域消失，不再适用通用的进度条/表单加载信号
 */
async function waitForUploadCompleteBySelector(ctx: StepExecutionContext, selector: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  ctx.onLog?.(`[step] 等待上传完成（按自定义选择器: ${selector}，最长 ${timeoutMs / 1000}s）...`, 'info');
  try {
    await ctx.page.waitForFunction((sel) => {
      // 支持多种选择器（| 分隔），任一匹配即完成
      const parts = sel.split('|').map(s => s.trim());
      for (const s of parts) {
        try {
          if (s.startsWith('//')) {
            const el = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (el) return true;
          } else {
            if (document.querySelector(s)) return true;
          }
        } catch {}
      }
      return false;
    }, selector, { timeout: timeoutMs });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    ctx.onLog?.(`[step] 上传完成（耗时 ${elapsed}s，自定义选择器已匹配）`, 'info');
  } catch {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    ctx.onLog?.(`[step] 自定义上传完成等待超时（${elapsed}s），继续执行`, 'warn');
  }
}

/**
 * 检测页面上的"上传中"进度条是否消失，或真实缩略图是否出现
 */
async function waitForUploadComplete(ctx: StepExecutionContext, timeoutMs: number): Promise<void> {
  const start = Date.now();
  ctx.onLog?.(`[step] 等待上传完成（最长 ${timeoutMs / 1000}s）...`, 'info');

  // 阶段1：等待"上传中"进度条出现（最多 3s），确认上传请求已发出
  try {
    await ctx.page.waitForFunction(() => {
      const prog = document.querySelectorAll('[class*="progress"], [class*="uploading"], [class*="upload-progress"]');
      return prog.length > 0;
    }, { timeout: 3000 });
    ctx.onLog?.(`[step] 检测到上传进度条，等待上传完成...`, 'info');
  } catch {
    // 没检测到进度条，可能上传太快或已跳转，继续检查
  }

  // 阶段2：等待进度条消失 + 上传完成信号（最多 timeoutMs）
  // 完成信号（满足任一即可）：
  //   a. URL 跳转到 content/post/image 且无进度条（抖音）
  //   b. 无进度条 + 标题输入框出现（小红书等不跳转 URL 的平台）
  //   c. 无进度条 + 正文编辑器出现（小红书等）
  try {
    await ctx.page.waitForFunction(() => {
      const url = window.location.href;
      const prog = document.querySelectorAll('[class*="progress"], [class*="uploading"], [class*="upload-progress"]');
      // 注意：不把 [class*="loading"] 纳入进度条判断，因为某些平台页面常驻 loading 元素
      const noProgress = prog.length === 0;
      // 信号 a：抖音跳转到 content/post/image
      const jumpedToPostImage = url.includes('content/post/image');
      // 信号 b：标题输入框出现（小红书上传完成后表单出现）
      const hasTitleInput = !!document.querySelector("input[placeholder='填写标题会有更多赞哦']") ||
                            !!document.querySelector('input[placeholder*="标题"]');
      // 信号 c：正文编辑器出现
      const hasContentEditor = !!document.querySelector('div[contenteditable="true"]');
      return (jumpedToPostImage && noProgress) || (noProgress && (hasTitleInput || hasContentEditor));
    }, { timeout: timeoutMs });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    ctx.onLog?.(`[step] 上传完成（耗时 ${elapsed}s，进度条消失且表单已加载）`, 'info');
  } catch {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // 超时后检查当前状态，给出明确诊断
    const state = await ctx.page.evaluate(() => {
      const url = window.location.href;
      const prog = document.querySelectorAll('[class*="progress"], [class*="uploading"], [class*="upload-progress"]');
      const realThumbs = Array.from(document.querySelectorAll('img')).filter(img => {
        const src = img.src || '';
        const r = img.getBoundingClientRect();
        return src.includes('creator-media-private') && r.width >= 80;
      });
      const hasTitleInput = !!document.querySelector("input[placeholder='填写标题会有更多赞哦']") ||
                            !!document.querySelector('input[placeholder*="标题"]');
      const hasContentEditor = !!document.querySelector('div[contenteditable="true"]');
      return { url, progressCount: prog.length, realThumbCount: realThumbs.length, hasTitleInput, hasContentEditor };
    }).catch(() => ({ url: 'unknown', progressCount: -1, realThumbCount: -1, hasTitleInput: false, hasContentEditor: false }));
    ctx.onLog?.(`[step] 上传等待超时（${elapsed}s）: state=${JSON.stringify(state)}`, 'warn');
    // 不抛错，让后续步骤继续（wait_for_url 会兜底）
  }
}

/**
 * v1.7.10：检测图片格式（通过文件头魔数）
 */
function detectImageFormat(buf: Buffer): string {
  if (buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'JPEG';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'PNG';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'WebP';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'BMP';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && (buf[3] === 0x37 || buf[3] === 0x38)) return 'GIF';
  return '';
}

/**
 * 下载文件到本地（支持 http/https，自动处理重定向）
 */
/**
 * 下载文件到本地（v1.7.10：改用 axios + 图片格式校验）
 *
 * v1.7.10 修复：之前用原生 http.get 下载 OSS 图片，可能因缺少 User-Agent
 * 被阿里云 OSS 拒绝或返回 HTML 错误页（size>0 但不是图片），
 * 导致抖音前端拿到"假图片"后卡在上传中状态。
 *
 * 现在用 axios 自动处理重定向 + 设置合理 headers，
 * 下载后校验文件头是否为有效图片格式（JPEG/PNG/WebP/BMP/GIF）。
 */
async function downloadFile(url: string, dest: string, timeoutMs: number = 30000): Promise<void> {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });

  if (resp.status !== 200) {
    throw new Error(`下载失败: HTTP ${resp.status}`);
  }

  const buf = Buffer.from(resp.data);

  // 校验：是否真的是图片（避免 OSS 返回 HTML 错误页但 size>0）
  if (!isImageBuffer(buf)) {
    // 打印前 200 字节用于诊断（可能是 HTML 错误页、JSON 错误信息等）
    const preview = buf.slice(0, 200).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
    throw new Error(`下载的文件不是有效图片（可能是 HTML 错误页或 JSON 错误）: size=${buf.length}, 预览=${preview.slice(0, 150)}`);
  }

  fs.writeFileSync(dest, buf);
}

/**
 * 校验 Buffer 是否为有效图片格式
 * 通过文件头魔数判断（JPEG/PNG/WebP/BMP/GIF）
 */
function isImageBuffer(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // WebP: "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
  // GIF: "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && (buf[3] === 0x37 || buf[3] === 0x38)) return true;
  return false;
}

async function execHover(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const timeout = step.timeout || 5000;
  const el = await waitForElement(ctx.page, selector, timeout);
  if (!el) {
    if (step.is_try) return true;
    throw new Error(`元素未找到: ${selector}`);
  }
  await el.hover({ timeout });
  return true;
}

async function execWaitForSelector(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const timeout = step.timeout || 10000;
  const selectors = parseSelectors(selector);

  // is_exist=true：仅检测存在性，不存在不报错
  if (step.is_exist) {
    for (const sel of selectors) {
      try {
        const handle = sel.startsWith('//')
          ? await ctx.page.$(`xpath=${sel}`)
          : await ctx.page.$(sel);
        if (handle) return true;
      } catch {
        // 继续尝试下一个
      }
    }
    return true; // is_exist 模式下不存在也返回 true
  }

  // 正常等待：任一选择器匹配即可
  try {
    await Promise.race(selectors.map(sel =>
      sel.startsWith('//')
        ? ctx.page.waitForSelector(`xpath=${sel}`, { timeout })
        : ctx.page.waitForSelector(sel, { timeout })
    ));
    return true;
  } catch {
    if (step.is_try) return true;
    throw new Error(`等待元素超时: ${selector}`);
  }
}

async function execWaitForUrl(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const urlPattern = resolveValue(step.value, ctx)!;
  const timeout = step.timeout || 30000;
  try {
    // 支持字符串子串匹配或正则
    const regex = tryParseRegex(urlPattern);
    if (regex) {
      await ctx.page.waitForURL(regex, { timeout });
    } else {
      await ctx.page.waitForURL((url: any) => String(url).includes(urlPattern), { timeout });
    }
    return true;
  } catch (err: any) {
    if (step.is_try) return true;
    throw new Error(`等待 URL 超时（期望包含: ${urlPattern}）: ${err.message}`);
  }
}

async function execIframeSelector(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const iframeSelector = step.iframe || step.selector!;
  const timeout = step.timeout || 10000;
  // 等待 iframe 元素
  const iframeEl = await waitForElement(ctx.page, iframeSelector, timeout);
  if (!iframeEl) {
    if (step.is_try) return true;
    throw new Error(`iframe 元素未找到: ${iframeSelector}`);
  }
  const frame = await iframeEl.contentFrame();
  if (!frame) {
    if (step.is_try) return true;
    throw new Error('无法获取 iframe contentFrame');
  }
  // 在 iframe 内执行子步骤（is_list）
  if (step.is_list && step.is_list.length > 0) {
    const iframeCtx: StepExecutionContext = { ...ctx, page: frame as any };
    await executeSteps(step.is_list, iframeCtx);
  }
  return true;
}

/**
 * tags 类型：逐个填入标签（每个回车确认）
 *
 * v1.9.36：支持 contenteditable 元素（抖音/小红书等平台的话题框是 contenteditable div）
 *   - input/textarea：用 el.fill() 填入
 *   - contenteditable div：用 click + keyboard.type() 逐字符输入
 *   - 两种方式填入后都按 Enter 确认
 */
async function execTags(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const tagsValue = resolveValue(step.value, ctx) || (ctx.article.tags || []).join(',');
  let tags = tagsValue.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  const timeout = step.timeout || 8000;

  // v1.9.37：add_hash=true 时为每个标签自动补 # 前缀（已有 # 的不重复加）
  //   抖音等平台要求话题以 # 开头才识别为话题，但 article.tags 数据源有时带 # 有时不带
  //   统一补 # 保证行为一致
  if (step.add_hash) {
    tags = tags.map(t => t.startsWith('#') ? t : `#${t}`);
  }

  let el = await waitForElement(ctx.page, selector, timeout);
  if (!el) {
    el = await smartFindElement(ctx.page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'fill');
    if (aiOk) return true;
    if (step.is_try) return true;
    throw new Error(`标签输入框未找到: ${selector}`);
  }

  // v1.9.36：判断元素类型，contenteditable 用键盘输入，input/textarea 用 fill
  let isContentEditable = false;
  try {
    const editable = await el.evaluate((node) => {
      const el = node as HTMLElement;
      return el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
    });
    isContentEditable = !!editable;
  } catch {}

  ctx.onLog?.(`[step] 标签输入框类型: ${isContentEditable ? 'contenteditable' : 'input/textarea'}, 标签数=${tags.length}`, 'info');

  await el.click({ force: true }).catch(() => {});
  await ctx.page.waitForTimeout(200);

  for (const tag of tags) {
    try {
      if (isContentEditable) {
        // contenteditable 元素：用键盘逐字符输入（fill 不生效）
        // 先清空可能存在的内容
        await ctx.page.keyboard.press('Control+A').catch(() => {});
        await ctx.page.keyboard.press('Delete').catch(() => {});
        await ctx.page.keyboard.type(tag, { delay: 30 });
      } else {
        // input/textarea：用 fill 填入
        await el.fill(tag, { force: true }).catch(async () => {
          // fill 失败时兜底用键盘输入
          await ctx.page.keyboard.type(tag, { delay: 30 });
        });
      }
      // 回车确认话题
      await ctx.page.keyboard.press('Enter');
      await ctx.page.waitForTimeout(300);
    } catch (e) {
      ctx.onLog?.(`[step] 标签 "${tag}" 填入失败: ${(e as Error).message}`, 'warn');
    }
  }
  return true;
}

async function execTiming(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const ms = step.ms || step.is_wait || 1000;
  await ctx.page.waitForTimeout(ms);
  return true;
}

/**
 * branch 类型：条件分支
 * - condition 在页面上下文中求值，返回 truthy 则执行 branch_steps，否则执行 else_list
 */
async function execBranch(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  if (!step.condition) {
    // 无条件，默认走 branch_steps
    if (step.branch_steps) await executeSteps(step.branch_steps, ctx);
    return true;
  }
  let conditionMet = false;

  // v1.9.39：data_item.xxx 前缀的条件从 ctx.article 取值，不用 page.evaluate
  //   解决 branch 条件判断发布记录数据（如 cover_image_url）时永远返回 false 的问题
  if (step.condition.startsWith('data_item.')) {
    const fieldName = step.condition.replace('data_item.', '').trim();
    const value = (ctx.article as any)[fieldName];
    conditionMet = !!value;
    ctx.onLog?.(`[step] branch 条件 "${step.condition}" => ${conditionMet}（值: ${value ? '有' : '无'}）`, 'info');
  } else {
    try {
      conditionMet = await ctx.page.evaluate((cond) => {
        try {
          // eslint-disable-next-line no-eval
          return !!eval(cond);
        } catch {
          return false;
        }
      }, step.condition);
    } catch {
      conditionMet = false;
    }
    ctx.onLog?.(`[step] branch 条件 "${step.condition}" => ${conditionMet}`, 'info');
  }

  if (conditionMet && step.branch_steps) {
    await executeSteps(step.branch_steps, ctx);
  } else if (!conditionMet && step.else_list) {
    await executeSteps(step.else_list, ctx);
  }
  return true;
}

/**
 * evaluate_edit 类型：在页面上下文执行 JS，返回结果（如获取发布后文章 URL）
 */
async function execEvaluateEdit(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  let expression = resolveValue(step.value, ctx)!;
  const timeout = step.timeout || 5000;
  // v1.7.5：支持 args 字段，将占位符替换后的值作为参数传入 page.evaluate
  // 在 JS 中通过 ARG 变量访问，避免值中含引号/换行符导致 JS 语法错误
  // 注意：Electron 25 的 Playwright 版本只支持 1 个参数，所以用对象包裹
  const args = step.args ? resolveValue(step.args, ctx) : undefined;
  // v1.9.28：自动删除单行注释 //
  //   原因：step_list 的 value 被 JSON 压缩成单行，// 会注释掉后面所有代码
  //   导致 "Unexpected token ')'" 等语法错误
  //   逐字符扫描，跳过字符串内的 //
  if (expression && expression.includes('//')) {
    expression = convertSingleLineCommentsToBlock(expression);
  }
  // v1.9.23：诊断日志——输出 expression 的长度和首尾内容，排查 "Unexpected end of input"
  ctx.onLog?.(`[step] evaluate_edit 诊断: exprLen=${expression?.length || 0}, argsLen=${args?.length || 0}, exprHead=${JSON.stringify(expression?.slice(0, 120))}, exprTail=${JSON.stringify(expression?.slice(-80))}`, 'info');
  try {
    const result = await ctx.page.evaluate(async ({ expr, arg }) => {
      try {
        // 把 arg 赋值给全局变量 ARG，供 expr 内的代码使用
        (window as any).__jlyl_arg__ = arg;
        const ARG = arg;
        // v1.9.23：用 AsyncFunction 替代 eval，避免模板字符串注入问题
        //   - eval(`(async (ARG) => { ${expr} })`) 中如果 expr 含反引号/${} 会破坏外层模板
        //   - new AsyncFunction 直接把 expr 作为函数体，不经过模板字符串
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction('ARG', expr);
        return await fn(ARG);
      } catch (e: any) {
        return { __error: e.message, __stack: e.stack?.slice(0, 300) };
      }
    }, { expr: expression, arg: args });
    ctx.lastEvalResult = result;
    // v1.7.4：防御 undefined 结果（JSON.stringify(undefined) 返回 undefined，调用 .slice 会抛错）
    const resultStr = JSON.stringify(result);
    ctx.onLog?.(`[step] evaluate_edit 结果: ${resultStr ? resultStr.slice(0, 200) : String(result)}`, 'info');
    if (result && typeof result === 'object' && result.__error) {
      if (step.is_try) return true;
      throw new Error(`evaluate_edit 执行错误: ${result.__error}`);
    }
    return true;
  } catch (err: any) {
    if (step.is_try) return true;
    throw new Error(`evaluate_edit 失败: ${err.message}`);
  }
}

/**
 * v1.9.29：把单行注释双斜杠转成块注释，保留注释后的代码
 *
 * 原因：step_list 的 value 被 JSON 压缩成单行，双斜杠会注释掉后面所有代码
 * 导致 "Unexpected token ')'" 等语法错误
 *
 * 策略：遇到双斜杠时（不在字符串内、不在 URL 冒号斜杠斜杠内）：
 *   - 把双斜杠替换为块注释开始标记
 *   - 在下一个代码起始符号 [ { ( return if for 等之前插入块注释结束标记
 *   - 这样注释文本被包裹在块注释中，后面的代码得以保留
 */
function convertSingleLineCommentsToBlock(code: string): string {
  let result = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (inString) {
      if (ch === '\\') {
        result += ch + (next || '');
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      result += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ch;
      i++;
      continue;
    }
    // 检测 // 单行注释（排除 URL 中的 ://）
    if (ch === '/' && next === '/' && code[i - 1] !== ':') {
      // 找注释后的代码起始位置：[ { ( 或 JS 关键字
      const codePatterns = ['[', '{', '(', 'return ', 'if ', 'for ', 'while ', 'const ', 'let ', 'var ', 'function ', '};', '}}'];
      let codeStart = -1;
      for (let j = i + 2; j < code.length; j++) {
        for (const pat of codePatterns) {
          if (code.substr(j, pat.length) === pat) {
            codeStart = j;
            break;
          }
        }
        if (codeStart >= 0) break;
      }
      if (codeStart > i + 2) {
        // 有代码在注释后面，用 /* */ 包裹注释文本
        const commentText = code.slice(i + 2, codeStart).trim();
        result += '/* ' + commentText + ' */ ';
        i = codeStart;
      } else {
        // 注释后面没有代码，删除整个注释
        i = code.length;
      }
      continue;
    }
    // 保留 /* */ 块注释
    if (ch === '/' && next === '*') {
      let endIdx = code.indexOf('*/', i + 2);
      if (endIdx === -1) endIdx = code.length;
      else endIdx += 2;
      result += code.slice(i, endIdx);
      i = endIdx;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

async function execGetByXY(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  // 模式 1：直接坐标
  if (step.x !== undefined && step.y !== undefined) {
    await ctx.page.mouse.move(step.x, step.y);
    await ctx.page.mouse.click(step.x, step.y);
    return true;
  }

  // 模式 2：基于元素选择器取中心点坐标
  if (step.selector) {
    let cx: number | undefined;
    let cy: number | undefined;

    // 模式 2a：优先使用上一步 evaluate_edit 存储在 window 中的真实坐标
    if (step.use_window_coords) {
      const coords = await ctx.page.evaluate(() => {
        return {
          x: (window as any).__jlyl_cover_img_x,
          y: (window as any).__jlyl_cover_img_y,
        };
      });
      if (typeof coords.x === 'number' && typeof coords.y === 'number' && coords.x > 0 && coords.y > 0) {
        cx = coords.x;
        cy = coords.y;
        ctx.onLog?.(`[step] get_by_xy 使用 window 坐标 (${cx}, ${cy})`, 'info');
      }
    }

    // 模式 2b：未拿到 window 坐标时回退到 selector boundingBox 中心点
    if (cx === undefined || cy === undefined) {
      const el = await findElement(ctx.page, step.selector, step.nth);
      if (!el) {
        // v1.7.0 三层降级：原选择器 → AI 视觉兜底
        const aiOk = await tryAiFallback(step, ctx, 'click');
        if (aiOk) return true;
        if (step.is_try) return true;
        throw new Error(`get_by_xy 元素未找到: ${step.selector}`);
      }
      const box = await el.boundingBox();
      if (!box) {
        const aiOk = await tryAiFallback(step, ctx, 'click');
        if (aiOk) return true;
        if (step.is_try) return true;
        throw new Error(`get_by_xy 无法获取 boundingBox: ${step.selector}`);
      }
      cx = box.x + box.width / 2;
      cy = box.y + box.height / 2;
    }

    // v1.7.12：CDP 穿透 closed Shadow DOM 点击策略
    //   xhs-publish-btn 是空壳宿主元素，所有按钮在 closed Shadow DOM 内部。
    //   JS 层的 btn.shadowRoot 返回 null（closed），page.mouse.click 点击宿主元素
    //   中心点可能落在内部两个按钮之间，无法触发发布。
    //
    //   方案：用 CDP DOM.getDocument(depth:-1, pierce:true) 穿透 closed Shadow DOM，
    //   找到内部"发布"按钮的 nodeId，用 DOM.getBoxModel 获取精确坐标，
    //   再用 Input.dispatchMouseEvent 点击按钮中心点。
    //
    //   实测：小红书 xhs-publish-btn 内部有两个按钮：
    //     - <button class="ce-btn white">暂存离开</button>（左侧）
    //     - <button class="ce-btn bg-red">发布</button>（右侧，aria-disabled="false"）
    //   "发布"按钮中心点约 (934, 1035)，宿主元素中心点 (870, 1035) 落在两按钮之间。

    // 步骤1：获取宿主元素的 boundingBox（用于回退和诊断）
    const hostBox = await ctx.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, step.selector);

    // 步骤2：用 CDP 穿透 closed Shadow DOM 查找内部按钮
    let cdpClicked = false;
    try {
      const client = await ctx.page.context().newCDPSession(ctx.page);
      // 获取完整 DOM 树（pierce:true 穿透 Shadow DOM）
      const docResult = await client.send('DOM.getDocument', { depth: -1, pierce: true });

      // 递归查找宿主元素节点
      const findHostNode = (node: any, tagName: string): any => {
        if ((node.nodeName || '').toUpperCase() === tagName.toUpperCase()) return node;
        for (const child of node.children || []) {
          const found = findHostNode(child, tagName);
          if (found) return found;
        }
        for (const shadow of node.shadowRoots || []) {
          const found = findHostNode(shadow, tagName);
          if (found) return found;
        }
        return null;
      };

      const hostNode = findHostNode(docResult.root, step.selector);

      if (hostNode && hostNode.shadowRoots && hostNode.shadowRoots.length > 0) {
        // 在 Shadow DOM 内部查找"发布"按钮
        // 优先级：class 含 "bg-red" 或 "primary" > class 含 "submit" > 文本含"发布"
        const findPublishButton = (node: any): any => {
          if ((node.nodeName || '').toUpperCase() === 'BUTTON') {
            const attrs = node.attributes || [];
            // 将 attributes 数组 [key, value, key, value, ...] 转为对象
            const attrObj: Record<string, string> = {};
            for (let i = 0; i < attrs.length; i += 2) {
              attrObj[attrs[i]] = attrs[i + 1] || '';
            }
            const cls = attrObj['class'] || '';
            // 检查子节点文本是否含"发布"
            let hasPublishText = false;
            for (const child of node.children || []) {
              if (child.nodeType === 3 && (child.nodeValue || '').indexOf('发布') >= 0) {
                hasPublishText = true;
                break;
              }
            }
            // 优先匹配 class 含 "bg-red" 或 "primary" 且文本含"发布"
            if ((cls.indexOf('bg-red') >= 0 || cls.indexOf('primary') >= 0) && hasPublishText) {
              return node;
            }
            // 其次匹配 aria-disabled="false" 且文本含"发布"
            if (attrObj['aria-disabled'] === 'false' && hasPublishText) {
              return node;
            }
            // 最后兜底：文本恰好是"发布"
            for (const child of node.children || []) {
              if (child.nodeType === 3 && (child.nodeValue || '').trim() === '发布') {
                return node;
              }
            }
          }
          // 递归搜索
          for (const child of node.children || []) {
            const found = findPublishButton(child);
            if (found) return found;
          }
          for (const shadow of node.shadowRoots || []) {
            const found = findPublishButton(shadow);
            if (found) return found;
          }
          return null;
        };

        for (const shadowRoot of hostNode.shadowRoots) {
          const publishBtn = findPublishButton(shadowRoot);
          if (publishBtn) {
            // 获取按钮的 box model
            try {
              const boxResult = await client.send('DOM.getBoxModel', { nodeId: publishBtn.nodeId });
              const border = boxResult.model?.border;
              if (border && border.length >= 4) {
                // border 是 [x1,y1, x2,y2, x3,y3, x4,y4]
                const xs = border.filter((_: number, i: number) => i % 2 === 0);
                const ys = border.filter((_: number, i: number) => i % 2 === 1);
                const centerX = xs.reduce((a: number, b: number) => a + b, 0) / xs.length;
                const centerY = ys.reduce((a: number, b: number) => a + b, 0) / ys.length;

                ctx.onLog?.(`[step] get_by_xy CDP 穿透 Shadow DOM 找到'发布'按钮，中心点 (${centerX.toFixed(0)}, ${centerY.toFixed(0)})`, 'info');

                // 用 CDP Input.dispatchMouseEvent 点击按钮中心
                const urlBefore = ctx.page.url();
                await client.send('Input.dispatchMouseEvent', {
                  type: 'mouseMoved', x: centerX, y: centerY,
                });
                await client.send('Input.dispatchMouseEvent', {
                  type: 'mousePressed', x: centerX, y: centerY, button: 'left', clickCount: 1,
                });
                await client.send('Input.dispatchMouseEvent', {
                  type: 'mouseReleased', x: centerX, y: centerY, button: 'left', clickCount: 1,
                });

                // 等待 500ms 检查 URL 是否变化
                await ctx.page.waitForTimeout(500);
                const urlAfter = ctx.page.url();

                if (urlAfter !== urlBefore) {
                  ctx.onLog?.(`[step] get_by_xy CDP 点击成功，URL 已跳转`, 'info');
                  cdpClicked = true;
                } else {
                  // 检查是否有成功提示
                  const hasSuccess = await ctx.page.evaluate(() => {
                    const bt = document.body.innerText;
                    return bt.indexOf('发布成功') >= 0 || bt.indexOf('笔记已发布') >= 0;
                  });
                  if (hasSuccess) {
                    ctx.onLog?.(`[step] get_by_xy CDP 点击成功，检测到成功提示`, 'info');
                    cdpClicked = true;
                  } else {
                    ctx.onLog?.(`[step] get_by_xy CDP 点击后 URL 未跳转，尝试 window 坐标回退`, 'warn');
                  }
                }
              }
            } catch (e: any) {
              ctx.onLog?.(`[step] get_by_xy CDP getBoxModel 失败: ${e.message}`, 'warn');
            }
            break;
          }
        }
      }

      await client.detach();
    } catch (e: any) {
      ctx.onLog?.(`[step] get_by_xy CDP 穿透失败: ${e.message}`, 'warn');
    }

    if (cdpClicked) return true;

    // 步骤3：CDP 失败时回退到 window 坐标点击
    if (cx !== undefined && cy !== undefined) {
      ctx.onLog?.(`[step] get_by_xy 回退到 window 坐标 (${cx}, ${cy})`, 'warn');
      try {
        await ctx.page.mouse.move(cx, cy);
        await ctx.page.waitForTimeout(50);
        await ctx.page.mouse.click(cx, cy);
        return true;
      } catch (e: any) {
        ctx.onLog?.(`[step] get_by_xy window 坐标点击失败: ${e.message}`, 'warn');
      }
    }

    // 步骤4：locator.click 兜底
    const selectorForLocator = step.selector.startsWith('//') ? `xpath=${step.selector}` : step.selector;
    try {
      await ctx.page.locator(selectorForLocator).first().click({ force: true, timeout: 3000 });
      ctx.onLog?.(`[step] get_by_xy 策略2 locator.click 成功`, 'info');
      return true;
    } catch (e: any) {
      ctx.onLog?.(`[step] get_by_xy 策略2 locator.click 失败: ${e.message}`, 'warn');
    }

    // 策略 3：ElementHandle.click({ force: true })
    const el3 = await findElement(ctx.page, step.selector, step.nth);
    if (el3) {
      try {
        await el3.click({ force: true, timeout: 3000 });
        ctx.onLog?.(`[step] get_by_xy 策略3 ElementHandle.click 成功`, 'info');
        return true;
      } catch (e: any) {
        ctx.onLog?.(`[step] get_by_xy 策略3 ElementHandle.click 失败: ${e.message}`, 'warn');
      }
    }

    // 所有策略都失败，如果 is_try 则容错跳过
    if (step.is_try) return true;

    // v1.7.0 AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'click');
    if (aiOk) return true;

    throw new Error(`get_by_xy 所有点击策略均失败: ${step.selector} at (${cx}, ${cy})`);
  }

  throw new Error('get_by_xy 需要提供 x/y 或 selector 字段');
}

// ============ 辅助函数 ============

/**
 * 等待元素出现并返回句柄
 */
async function waitForElement(page: Page, selector: string, timeout: number): Promise<ElementHandle | null> {
  const selectors = parseSelectors(selector);
  // 并发等待，任一出现即返回
  const tasks = selectors.map(sel => {
    try {
      return sel.startsWith('//')
        ? page.waitForSelector(`xpath=${sel}`, { timeout, state: 'attached' })
        : page.waitForSelector(sel, { timeout, state: 'attached' });
    } catch {
      return Promise.resolve(null);
    }
  });
  try {
    const results = await Promise.race([
      Promise.all(tasks),
      // 至少一个出现的快速路径
      new Promise<ElementHandle | null>((resolve) => {
        selectors.forEach(async sel => {
          try {
            const el = sel.startsWith('//')
              ? await page.$(`xpath=${sel}`)
              : await page.$(sel);
            if (el) resolve(el);
          } catch {}
        });
      }),
    ]);
    if (Array.isArray(results)) {
      return results.find(r => r !== null) || null;
    }
    return results;
  } catch {
    // 超时后再做一次同步查找
    for (const sel of selectors) {
      try {
        const el = sel.startsWith('//')
          ? await page.$(`xpath=${sel}`)
          : await page.$(sel);
        if (el) return el;
      } catch {}
    }
    return null;
  }
}

function tryParseRegex(pattern: string): RegExp | null {
  try {
    // 支持 /pattern/flags 格式
    const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      return new RegExp(match[1], match[2]);
    }
    return null;
  } catch {
    return null;
  }
}

// ============ 索引化交互步骤（借鉴 BrowserAct state/click/input 命令） ============

/**
 * state 类型：扫描页面可交互元素，返回索引列表
 *
 * 用途：调试时查看页面有哪些可交互元素；或配合 click_index/input_index 使用
 *
 * 配置：
 *   - filter: { tag?: string, text?: string } 可选过滤
 *   - capture_state: true 时将结果存入 ctx.lastEvalResult（供后续步骤参考）
 */
async function execState(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const elements = await getState(ctx.page, step.filter);
  ctx.onLog?.(`[step] state 扫描到 ${elements.length} 个可交互元素`, 'info');

  // 打印前 10 个元素（调试用）
  if (elements.length > 0) {
    const preview = elements.slice(0, 10).map((e) =>
      `[${e.index}] ${e.tag}(${e.type}) "${e.text.slice(0, 30)}" → ${e.selector}`
    ).join('\n');
    ctx.onLog?.(`[step] state 前 10 个元素:\n${preview}`, 'info');
  }

  if (step.capture_state) {
    ctx.lastEvalResult = elements;
  }
  return true;
}

/**
 * click_index 类型：按索引点击元素
 *
 * 配置：
 *   - selector: 索引号（字符串形式，如 "3"）
 *   - humanize: true 时启用人性化点击
 */
async function execClickIndex(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const index = parseInt(step.selector || '0', 10);
  if (isNaN(index)) {
    throw new Error(`click_index 的 selector 必须是数字索引，收到: ${step.selector}`);
  }

  ctx.onLog?.(`[step] click_index ${index}`, 'info');

  if (step.humanize) {
    // 人性化模式：先获取元素坐标，用贝塞尔曲线移动后点击
    const elements = await getState(ctx.page);
    const target = elements.find((e) => e.index === index);
    if (!target) {
      if (step.is_try) return true;
      throw new Error(`索引 ${index} 不存在（共 ${elements.length} 个元素）`);
    }
    if (target.bbox) {
      const cx = target.bbox.x + target.bbox.width / 2;
      const cy = target.bbox.y + target.bbox.height / 2;
      // 导入 humanMouseMove
      const { humanMouseMove } = await import('./behaviorHumanizer');
      await humanMouseMove(ctx.page, cx, cy);
      await humanDelay('short');
      await ctx.page.mouse.click(cx, cy);
      await humanDelay('short');
    } else {
      await clickByIndex(ctx.page, index, { timeout: step.timeout || 5000, force: step.force });
    }
  } else {
    await clickByIndex(ctx.page, index, { timeout: step.timeout || 5000, force: step.force });
  }
  return true;
}

/**
 * input_index 类型：按索引填写输入框
 *
 * 配置：
 *   - selector: 索引号（字符串形式，如 "2"）
 *   - value: 要输入的文本（支持 {title} 等占位符）
 *   - humanize: true 时启用逐字符输入
 */
async function execInputIndex(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const index = parseInt(step.selector || '0', 10);
  if (isNaN(index)) {
    throw new Error(`input_index 的 selector 必须是数字索引，收到: ${step.selector}`);
  }
  const text = resolveValue(step.value, ctx) || '';

  ctx.onLog?.(`[step] input_index ${index} ← "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"`, 'info');

  if (step.humanize) {
    // 人性化模式：点击聚焦 + 逐字符输入
    const elements = await getState(ctx.page);
    const target = elements.find((e) => e.index === index);
    if (!target) {
      if (step.is_try) return true;
      throw new Error(`索引 ${index} 不存在`);
    }
    // 用 humanType
    const el = await ctx.page.$(target.selector);
    if (el) {
      await humanType(ctx.page, el, text, { force: step.force, clear: true });
    } else if (target.bbox) {
      // 兜底：坐标点击 + 键盘输入
      const cx = target.bbox.x + target.bbox.width / 2;
      const cy = target.bbox.y + target.bbox.height / 2;
      await ctx.page.mouse.click(cx, cy);
      await humanDelay('short');
      await ctx.page.keyboard.press('Control+A');
      await ctx.page.keyboard.press('Delete');
      for (const char of text) {
        await ctx.page.keyboard.type(char, { delay: 80 + Math.random() * 120 });
      }
    }
  } else {
    await inputByIndex(ctx.page, index, text, {
      timeout: step.timeout || 5000,
      force: step.force,
      clear: true,
    });
  }
  return true;
}

// ============ keyboard_type 步骤（v1.7.0 受控组件逐字符输入） ============

/**
 * keyboard_type：逐字符输入（用于 React/Vue 受控组件，fill 不触发 input 事件的场景）
 *
 * 与 fill 的区别：
 *  - fill：清空 + 整体赋值（适合普通 input）
 *  - keyboard_type：click 聚焦 + page.keyboard.type 逐字符输入（触发完整 onChange 序列）
 */
async function execKeyboardType(step: Step, ctx: StepExecutionContext): Promise<boolean> {
  const selector = step.selector!;
  const value = resolveValue(step.value, ctx)!;
  const timeout = step.timeout || 8000;

  let el = await waitForElement(ctx.page, selector, timeout);
  if (!el) {
    el = await smartFindElement(ctx.page, selector, { timeout: Math.min(timeout, 3000) });
  }
  if (!el) {
    // v1.7.0 三层降级：原选择器 → smartFindElement → AI 视觉兜底
    const aiOk = await tryAiFallback(step, ctx, 'fill');
    if (aiOk) return true;
    if (step.is_try) return true;
    throw new Error(`keyboard_type 元素未找到: ${selector}`);
  }

  // 先滚动到视口内（确保 click 能真正聚焦元素，避免 keyboard.type 打到错误元素）
  try {
    await el.evaluate((node) => {
      (node as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await ctx.page.waitForTimeout(200);
  } catch {}
  // 先清空（用 Ctrl+A + Delete 兜底清空）
  await el.click({ force: true }).catch(() => {});
  try {
    await ctx.page.keyboard.press('Control+A');
    await ctx.page.keyboard.press('Delete');
  } catch {}

  // 逐字符输入
  if (step.humanize) {
    // 人性化模式：每个字符 80-200ms 随机延迟
    for (const ch of value) {
      await ctx.page.keyboard.type(ch, { delay: 80 + Math.random() * 120 });
    }
  } else {
    await ctx.page.keyboard.type(value, { delay: 50 });
  }
  return true;
}

// ============ AI 视觉兜底（v1.7.0 三层降级） ============

/**
 * v1.7.0 AI 视觉兜底：确定性步骤失败时调用 LLM 识别元素坐标
 *
 * v2.0.0 P6：云端发布 Worker 不支持 AI 视觉兜底，直接返回 false
 *
 * @returns false（云端不支持 AI 兜底）
 */
async function tryAiFallback(
  step: Step,
  ctx: StepExecutionContext,
  action: 'fill' | 'click' | 'verify'
): Promise<boolean> {
  if (!step.ai_fallback) return false;
  ctx.onLog?.(`[AI Action] ⚠ 云端发布 Worker 不支持 AI 视觉兜底，跳过`, 'warn');
  return false;
}
