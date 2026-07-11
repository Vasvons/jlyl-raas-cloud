/**
 * 行为人性化器（借鉴 BrowserAct 的反检测行为模拟）
 *
 * 核心能力：
 * 1. 鼠标贝塞尔曲线移动（非瞬移，模拟真实用户轨迹）
 * 2. 随机延迟（点击前后 300-1500ms 随机停顿）
 * 3. 输入逐字符 + 随机间隔（模拟真实打字节奏）
 * 4. 滚动节奏化（非一次性滚到底）
 *
 * 反检测原理：
 *  - 自动化工具的鼠标瞬移、固定延迟、瞬时输入是重要检测信号
 *  - 真实用户有鼠标轨迹、思考停顿、打字节奏不均匀
 *  - 本模块在 Playwright 的 click/fill/type 之前注入人性化行为
 */

import { Page, ElementHandle } from 'playwright';

/**
 * 随机延迟区间（毫秒）
 */
const HUMAN_DELAY = {
  short: [200, 600], // 短停顿（元素间切换）
  medium: [500, 1500], // 中停顿（点击前思考）
  long: [1000, 3000], // 长停顿（页面加载后阅读）
  typing: [80, 200], // 打字间隔
};

/**
 * 随机整数 [min, max]
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 随机延迟
 */
export async function humanDelay(level: 'short' | 'medium' | 'long' = 'medium'): Promise<void> {
  const [min, max] = HUMAN_DELAY[level];
  await new Promise((resolve) => setTimeout(resolve, randomInt(min, max)));
}

/**
 * 贝塞尔曲线鼠标移动（3 阶贝塞尔）
 *
 * 算法：
 *  - 生成 2 个随机控制点（在起点终点之间偏移）
 *  - 沿曲线移动 15-25 步，每步间隔 10-25ms
 *  - 到达终点前有微小过冲和回退（模拟人类精度）
 *
 * @param page Playwright Page
 * @param targetX 目标 x 坐标
 * @param targetY 目标 y 坐标
 */
export async function humanMouseMove(
  page: Page,
  targetX: number,
  targetY: number
): Promise<void> {
  // 获取当前鼠标位置（默认从随机位置开始）
  const startX = randomInt(100, 800);
  const startY = randomInt(100, 600);

  // 生成 2 个控制点（在起点终点之间，加随机偏移）
  const cp1x = startX + (targetX - startX) * 0.3 + randomInt(-100, 100);
  const cp1y = startY + (targetY - startY) * 0.3 + randomInt(-100, 100);
  const cp2x = startX + (targetX - startX) * 0.7 + randomInt(-80, 80);
  const cp2y = startY + (targetY - startY) * 0.7 + randomInt(-80, 80);

  const steps = randomInt(15, 25);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 3 阶贝塞尔曲线公式
    const x = Math.pow(1 - t, 3) * startX +
              3 * Math.pow(1 - t, 2) * t * cp1x +
              3 * (1 - t) * Math.pow(t, 2) * cp2x +
              Math.pow(t, 3) * targetX;
    const y = Math.pow(1 - t, 3) * startY +
              3 * Math.pow(1 - t, 2) * t * cp1y +
              3 * (1 - t) * Math.pow(t, 2) * cp2y +
              Math.pow(t, 3) * targetY;

    await page.mouse.move(x, y);
    await new Promise((resolve) => setTimeout(resolve, randomInt(10, 25)));
  }

  // 微小过冲和回退（模拟人类精度）
  if (Math.random() > 0.5) {
    const overshoot = randomInt(2, 8);
    await page.mouse.move(targetX + overshoot, targetY + overshoot);
    await new Promise((resolve) => setTimeout(resolve, randomInt(30, 80)));
    await page.mouse.move(targetX, targetY);
  }
}

/**
 * 人性化点击：鼠标曲线移动 → 随机停顿 → 点击
 */
export async function humanClick(
  page: Page,
  element: ElementHandle,
  options?: { force?: boolean; timeout?: number }
): Promise<void> {
  if (!options?.force) {
    // 等待元素可见
    await element.waitForElementState('visible', { timeout: options?.timeout || 5000 }).catch(() => {});

    // 获取元素中心坐标
    const bbox = await element.boundingBox();
    if (bbox) {
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;

      // 鼠标曲线移动到元素
      await humanMouseMove(page, cx, cy);

      // 点击前随机停顿
      await humanDelay('short');
    }
  }

  // 执行点击
  await element.click({ force: options?.force, timeout: options?.timeout || 5000 });

  // 点击后随机停顿
  await humanDelay('short');
}

/**
 * 人性化输入：点击聚焦 → 逐字符输入 + 随机间隔
 */
export async function humanType(
  page: Page,
  element: ElementHandle,
  text: string,
  options?: { force?: boolean; clear?: boolean }
): Promise<void> {
  // 聚焦元素
  await element.click({ force: options?.force }).catch(() => {});
  await humanDelay('short');

  // 清空（可选）
  if (options?.clear !== false) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await humanDelay('short');
  }

  // 逐字符输入
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomInt(HUMAN_DELAY.typing[0], HUMAN_DELAY.typing[1]) });

    // 随机在某个字符后加长停顿（模拟思考）
    if (Math.random() > 0.85) {
      await humanDelay('short');
    }
  }
}

/**
 * 人性化滚动：分多次滚动，每次随机高度
 */
export async function humanScroll(
  page: Page,
  targetY?: number
): Promise<void> {
  const viewportHeight = await page.viewportSize()?.height || 1080;
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);

  if (targetY === undefined) {
    targetY = totalHeight - viewportHeight;
  }

  let currentY = await page.evaluate(() => window.scrollY);
  while (currentY < targetY) {
    const stepHeight = randomInt(200, 500);
    currentY = Math.min(currentY + stepHeight, targetY);
    await page.evaluate((y) => window.scrollTo(0, y), currentY);
    await humanDelay('short');
  }
}

/**
 * 随机化等待时间（替代固定的 page.waitForTimeout）
 *
 * @param baseMs 基准毫秒数
 * @param jitterMs 抖动范围（默认 ±30%）
 */
export async function randomizedWait(baseMs: number, jitterMs?: number): Promise<void> {
  const jitter = jitterMs || Math.floor(baseMs * 0.3);
  const wait = baseMs + randomInt(-jitter, jitter);
  await new Promise((resolve) => setTimeout(resolve, Math.max(50, wait)));
}
