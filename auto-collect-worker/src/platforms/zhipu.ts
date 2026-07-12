import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/**
 * 智谱AI适配器（v2 — 回退到 24-25 号可工作的简单实现）
 *
 * 历史教训：
 * - 24-25 号用最简单的实现（chatUrl=/chat/、textarea、.markdown-body）正确执行了搜索
 * - 后续按 auth helper 脚本"严格对齐"反而打乱了状态：
 *   1) chatUrl 从 /chat/ 改成 /，导致进入首页而非聊天页
 *   2) 强制点击"联网"按钮，但用户反馈"联网默认就开着"，点击反而会关闭已激活状态
 *   3) 复杂的 responseSelector 和 waitForResponse 反而匹配不到
 *
 * 关键认知（用户实测）：
 * - 联网按钮在"聊天框左下角的选择模式弹窗里"，默认已激活，无需代码点击
 * - 分享链接按钮在"右上角"，文案是"复制对话链接"，点击后链接复制到剪贴板
 *
 * 因此本版本：
 * - chatUrl 回到 /chat/
 * - 删除 afterNavigate 覆盖（不点击联网按钮）
 * - 删除 extractContent 覆盖（用基类的 smartFindLongestContent 兜底）
 * - 删除 waitForResponse 覆盖（用基类的停止按钮等待）
 * - 专门重写 extractShareLink：点击"复制对话链接"按钮 + 拦截 clipboard.writeText
 */
export class ZhipuAdapter extends BasePlatformAdapter {
  platformName = '智谱AI';
  loginUrl = 'https://chatglm.cn/';
  // 关键：用 /chat/ 而非 /，直接进入聊天页（24-25 号可工作的配置）
  chatUrl = 'https://chatglm.cn/chat/';
  supportsShare = true;
  // 简单选择器（24-25 号可工作的配置）
  protected inputSelector = 'textarea';
  protected responseSelector = '.markdown-body, [class*="message"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

  /**
   * 智谱分享链接提取（v2）
   *
   * 用户实测：右上角有"复制对话链接"按钮，点击后链接复制到剪贴板。
   * 策略：
   * 1. 注入 clipboard.writeText 拦截脚本，捕获复制到剪贴板的 URL
   * 2. 找到"复制对话链接"按钮并点击
   * 3. 从拦截到的 URL 返回
   * 4. 兜底：从对话框文本中匹配 URL
   * 5. 兜底：从当前页面 URL 提取 /share/{短码}
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 clipboard.writeText 拦截脚本
    await this.injectClipboardInterceptor(page, ['/share/', 'chatglm.cn', 'http']);

    // 步骤2: 健壮地查找并点击"复制对话链接"按钮
    const clickedBtn = await this.findAndClickShareButton(page, [
      'button:has-text("复制对话链接")',
      'button:has-text("复制链接")',
      '[class*="share"]:has-text("复制")',
      '[aria-label*="复制"]',
      '[aria-label*="分享"]',
      '[aria-label*="链接"]',
      '[class*="share"]:not([class*="shared"])',
      '[class*="copy-link"]',
      '[class*="copyLink"]',
      '[data-testid*="share"]',
      '[data-testid*="copy"]',
    ], ['复制对话链接', '复制链接', '分享', 'share', 'copy']);

    // 步骤3: 如果按钮点击成功，检查拦截到的 URL
    if (clickedBtn) {
      const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
      if (capturedUrl) {
        console.log(`[智谱AI] 从 clipboard 拦截到分享链接: ${capturedUrl}`);
        return capturedUrl;
      }
      // 检查是否弹出了对话框
      const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
      if (dialogUrl) return dialogUrl;
    }

    // 步骤4: 兜底从当前页面 URL 提取 /share/{短码}
    const currentUrl = await this.getCurrentPageShareUrl(page);
    if (currentUrl) {
      console.log(`[智谱AI] 从当前 URL 提取到分享链接: ${currentUrl}`);
      return currentUrl;
    }

    console.log('[智谱AI] 未能提取到分享链接');
    return null;
  }
}
