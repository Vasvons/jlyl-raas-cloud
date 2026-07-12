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
 * 纳米不支持分享，shareUrl 返回 null，由云端生成静态页
 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  supportsShare = false;
  protected inputSelector = 'textarea, input[type="text"]';
  // 保留选择器用于 waitForSelector，实际提取在 extractContent 中重写
  protected responseSelector = '.answer-content, .ai-summary, .result-content, .summary-content, .ai-answer, .bot-answer, .reply-content, [class*="ai-summary"], [class*="answer-content"], [class*="summary-content"], [class*="ai-answer"], [class*="bot-answer"], [class*="answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';

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
