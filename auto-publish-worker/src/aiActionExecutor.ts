/**
 * 云端 AI 视觉动作执行器（v2.5.0）
 *
 * 与桌面端差异：
 *  - 桌面端：通过 jlylServer 代理调 HTTP /content/ai/vision
 *  - 云端：直接调云端 server 的 /content/ai/vision（X-Worker-Secret 认证）
 *
 * 复用 server 端的 getPublishModelConfig 模型配置
 */
import { Page } from 'playwright';
import axios from 'axios';
import { humanMouseMove } from './behaviorHumanizer';
import * as logger from './logger';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_SECRET = process.env.WORKER_SECRET || '';

export interface AiActionResult {
  success: boolean;
  x?: number;
  y?: number;
  confidence?: number;
  reasoning?: string;
  attempts: number;
  error?: string;
}

/**
 * 执行 AI 视觉动作
 * @param page Playwright Page
 * @param intent 操作意图（如"找到标题输入框"）
 * @param action 动作类型 fill/click/verify
 * @param value fill 时的值
 * @param maxRetries 最大重试次数
 */
export async function executeAiAction(
  page: Page,
  intent: string,
  action: 'fill' | 'click' | 'verify' = 'click',
  value?: string,
  maxRetries: number = 2
): Promise<AiActionResult> {
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. 截图当前页面
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      const screenshotBase64 = screenshotBuffer.toString('base64');

      // 2. 调用云端 /content/ai/vision（worker 用 X-Worker-Secret 认证）
      const resp = await axios.post(
        `${SERVER_URL}/content/ai/vision`,
        {
          screenshot: `data:image/png;base64,${screenshotBase64}`,
          intent,
          action,
          value,
        },
        {
          headers: { 'X-Worker-Secret': WORKER_SECRET },
          timeout: 60000,
        }
      );

      const data = resp.data?.data;
      if (!data?.success || data.x == null || data.y == null) {
        lastError = data?.error || `LLM 未返回有效坐标`;
        logger.warn(`AI 视觉识别失败（第 ${attempt} 次）: ${lastError}`);
        continue;
      }

      // 3. 归一化坐标转像素坐标
      const viewport = page.viewportSize();
      if (!viewport) {
        lastError = `无法获取 viewport`;
        continue;
      }
      const x = Math.round(data.x * viewport.width);
      const y = Math.round(data.y * viewport.height);
      logger.info(`AI 识别成功（第 ${attempt} 次）: 坐标=(${x}, ${y}) confidence=${data.confidence} reasoning=${data.reasoning}`);

      // 4. 人性化鼠标移动到目标位置
      await humanMouseMove(page, x, y);

      // 5. 执行动作
      if (action === 'click') {
        await page.mouse.click(x, y);
      } else if (action === 'fill' && value) {
        await page.mouse.click(x, y);
        await page.waitForTimeout(200);
        await page.keyboard.type(value);
      } else if (action === 'verify') {
        // 仅验证，不执行动作
      }

      return {
        success: true,
        x,
        y,
        confidence: data.confidence,
        reasoning: data.reasoning,
        attempts: attempt,
      };
    } catch (e: any) {
      lastError = e.message;
      logger.warn(`AI 视觉动作异常（第 ${attempt} 次）: ${e.message}`);
    }
  }

  return {
    success: false,
    attempts: maxRetries,
    error: lastError,
  };
}
