import { BasePlatformAdapter } from './baseAdapter';

/** 纳米搜索适配器
 *
 * 纳米搜索（n.cn）是 360 出品的 AI 搜索引擎，返回搜索结果 + AI 总结
 * v1.4.2：精确化 responseSelector，避免匹配到侧边栏简短摘要（之前 139 字符问题）
 */
export class NanoAdapter extends BasePlatformAdapter {
  platformName = '纳米';
  loginUrl = 'https://www.n.cn/';
  chatUrl = 'https://www.n.cn/chat';
  supportsShare = false;
  protected inputSelector = 'textarea, input[type="text"]';
  // v1.4.2：精确匹配 AI 总结内容容器，去掉模糊的 [class*="answer"]
  // 优先匹配 .answer-content / .ai-summary / .result-content 等明确的总结容器
  protected responseSelector = '.answer-content, .ai-summary, .result-content, .summary-content, .ai-answer, .bot-answer, .reply-content, [class*="ai-summary"], [class*="answer-content"], [class*="summary-content"], [class*="ai-answer"], [class*="bot-answer"]';
  protected stopButtonSelector = '[class*="stop"], .stop-btn';
  protected loginUrlPattern = 'login';
}
