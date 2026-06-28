/**
 * 云端巡检 Worker 行为人性化器（复用桌面端 behaviorHumanizer.ts 实现）
 *
 * 核心能力：
 * 1. 鼠标贝塞尔曲线移动（非瞬移，模拟真实用户轨迹）
 * 2. 随机延迟（点击前后 200-3000ms 随机停顿）
 * 3. 输入逐字符 + 随机间隔（模拟真实打字节奏）
 * 4. 滚动节奏化（非一次性滚到底）
 *
 * 反检测原理：
 *  - 自动化工具的鼠标瞬移、固定延迟、瞬时输入是重要检测信号
 *  - 真实用户有鼠标轨迹、思考停顿、打字节奏不均匀
 */

import { Page, ElementHandle } from 'playwright';

const HUMAN_DELAY = {
  short: [200, 600],
  medium: [500, 1500],
  long: [1000, 3000],
  typing: [80, 200],
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function humanDelay(level: 'short' | 'medium' | 'long' = 'medium'): Promise<void> {
  const [min, max] = HUMAN_DELAY[level];
  await new Promise((resolve) => setTimeout(resolve, randomInt(min, max)));
}

/**
 * 贝塞尔曲线鼠标移动（3 阶贝塞尔）
 */
export async function humanMouseMove(
  page: Page,
  targetX: number,
  targetY: number
): Promise<void> {
  const startX = randomInt(100, 800);
  const startY = randomInt(100, 600);

  const cp1x = startX + (targetX - startX) * 0.3 + randomInt(-100, 100);
  const cp1y = startY + (targetY - startY) * 0.3 + randomInt(-100, 100);
  const cp2x = startX + (targetX - startX) * 0.7 + randomInt(-80, 80);
  const cp2y = startY + (targetY - startY) * 0.7 + randomInt(-80, 80);

  const steps = randomInt(15, 25);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
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
    await element.waitForElementState('visible', { timeout: options?.timeout || 5000 }).catch(() => {});

    const bbox = await element.boundingBox();
    if (bbox) {
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      await humanMouseMove(page, cx, cy);
      await humanDelay('short');
    }
  }

  await element.click({ force: options?.force, timeout: options?.timeout || 5000 });
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
  await element.click({ force: options?.force }).catch(() => {});
  await humanDelay('short');

  if (options?.clear !== false) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await humanDelay('short');
  }

  for (const char of text) {
    await page.keyboard.type(char, { delay: randomInt(HUMAN_DELAY.typing[0], HUMAN_DELAY.typing[1]) });
    if (Math.random() > 0.85) {
      await humanDelay('short');
    }
  }
}

/**
 * 随机化等待时间（替代固定的 page.waitForTimeout）
 */
export async function randomizedWait(baseMs: number, jitterMs?: number): Promise<void> {
  const jitter = jitterMs || Math.floor(baseMs * 0.3);
  const wait = baseMs + randomInt(-jitter, jitter);
  await new Promise((resolve) => setTimeout(resolve, Math.max(50, wait)));
}
