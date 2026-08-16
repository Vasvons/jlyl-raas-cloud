import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 纳米搜索适配器
 *
 * 纳米搜索（n.cn）是 360 出品的 AI 搜索引擎，返回搜索结果 + AI 总结
 *
 * v1.4.4 修复"内容只有 139 字符"问题：
 *   之前 bug：responseSelector 用模糊的 [class*="answer"] 匹配到侧边栏简短摘要
 *   修复策略：重写 extractContent，用多策略精确提取 AI 总结正文
 *   1. 优先匹配 .answer-content / .ai-summary 等明确容器
 *   2. 兜底用 smartFindLongestContent 找最长文本块
 *   3. 限制最少 200 字符，过短则继续等待或走兜底
 *
 * v1.9: 支持分享链接提取（supportsShare=true），提取失败时由云端生成静态页
 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  // v1.9: n.cn 支持分享（分享链接格式 https://www.n.cn/share/{type}?id={shareId}）
  // 之前 supportsShare=false 导致从未尝试提取分享链接，一直走静态页
  supportsShare = true;
  protected inputSelector = 'div[contenteditable="true"], textarea, input[type="text"]';
  // v1.9.2 实地诊断（2026-08-16）：n.cn 消息列表为 li.js-message-item（data-testid="msg-xxx"）
  // 旧选择器（.answer-content/.ai-summary）全部失效，导致抓智能体广场/框架文本入库
  protected responseSelector = 'li.js-message-item, [data-testid^="msg-"], .answer-content, .ai-summary, [class*="ai-summary"], [class*="answer-content"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
  // v1.9.4: 纳米侧边栏/广场污染标记——实地诊断（2026-08-17）登录后停留智能体广场，
  // 抓到"像素化你的人生...1474人聊过..."等广场文本入库（609字符，能绕过长度检查）
  // 命中 2 个以上广场/框架标记即判定污染，抛错不入库
  protected sidebarMarkers = ['人聊过', '首页', '大模型', '智能体', '知识库', 'AI写作', 'AI修图', '新对话'];

  /**
   * v1.9: 纳米分享链接提取
   *
   * 流程：hover AI 总结区域 → 操作栏/顶部出现"分享"按钮 → 点击 → 复制链接到剪贴板 或 弹窗显示链接
   * 拦截 pattern 只匹配 /share/（n.cn 分享路径）
   */
  async extractShareLink(page: Page): Promise<string | null> {
    // 步骤1: 注入 clipboard + execCommand 拦截
    await this.injectClipboardInterceptor(page, ['/share/']);

    // 步骤2: hover AI 总结区域，触发操作栏显示
    const answerSelectors = [
      '.answer-content',
      '.ai-summary',
      '[class*="ai-summary"]',
      '[class*="answer-content"]',
      '[class*="answer"]',
      // 兜底
      'main', '[class*="chat"]',
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
            await page.waitForTimeout(1200);
            hoveredAny = true;
            break;
          }
        }
      } catch { /* 继续 */ }
    }

    // 步骤3: 查找并点击分享按钮
    const shareBtnClicked = await this.findAndClickShareButton(page, [
      'button:has-text("分享")',
      '[aria-label*="分享"]',
      '[title*="分享"]',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
    ], ['分享', 'Share', 'share']);

    // 即使按钮没找到，也检查是否有剪贴板捕获（部分页面点其他元素也会触发分享）
    if (!shareBtnClicked) {
      const preCaptured = await this.getCapturedShareUrl(page, '/share/');
      if (preCaptured) return preCaptured;
      console.log('[纳米] 未找到分享按钮');
      return null;
    }

    // 步骤4: 分享面板出现后，点击"复制链接"按钮（如果有）
    await page.waitForTimeout(1000);
    const copyBtnSelectors = [
      'button:has-text("复制链接")',
      'button:has-text("复制")',
      '[class*="copy-link"]',
    ];
    for (const sel of copyBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
          console.log(`[纳米] 点击复制链接按钮成功: ${sel}`);
          break;
        }
      } catch { /* 继续 */ }
    }

    // 步骤5: 从拦截到的剪贴板内容提取 URL
    const capturedUrl = await this.getCapturedShareUrl(page, '/share/');
    if (capturedUrl) {
      console.log(`[纳米] 从剪贴板拦截到分享链接: ${capturedUrl}`);
      return capturedUrl;
    }

    // 步骤6: 兜底 — 从弹窗中提取
    const dialogUrl = await this.extractShareUrlFromDialog(page, '/share/');
    if (dialogUrl) return dialogUrl;

    await page.keyboard.press('Escape').catch(() => {});
    console.log('[纳米] 未能提取到分享链接');
    return null;
  }

  /**
   * 重写 extractContent：精确提取纳米 AI 总结正文
   *
   * 纳米页面结构：
   *   - 顶部：搜索结果列表（简短摘要，每个 ~100-200 字符）
   *   - 中部：AI 总结（完整回答，通常 500+ 字符）
   *   - 侧边栏：相关问题、推荐等
   *
   * 之前 bug：[class*="answer"] 匹配到顶部简短摘要，导致只提取 139 字符
   */
  async extractContent(page: Page): Promise<{ text: string; html: string }> {
    // 滚动到底部触发懒加载
    await this.scrollToBottom(page);

    // 纳米页面结构（2026-07-12 实地观察）：
    // - 顶部：搜索框
    // - 左侧栏：推荐智能体列表（"首页大模型智能体知识库AI写作AI修图..."）
    // - 中部：AI 回答（含 markdown 格式，有 <p> 标签）
    // - 底部：相关搜索推荐
    // 之前 bug：smartFindLongestContent 抓到左侧栏（3.4K 字符）而非 AI 回答（1-2K 字符）
    // 修复：跳过自有 extractContent，直接用 baseAdapter 的评分版 extractContent
    // （baseAdapter 现在会优先选择含 <p> 标签的散文内容）
    return await super.extractContent(page);
  }
}
