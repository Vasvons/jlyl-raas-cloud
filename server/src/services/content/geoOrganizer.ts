import { chatCompletion } from './aiClient';
import { getDefaultModelConfig } from '../../repository';
import { decrypt } from '../../utils/crypto';

/**
 * 从用户粘贴的文本中整理出「本地同行 / 本地区域机构」清单
 *
 * 用户会从外部 AI 平台（如 DeepSeek / 豆包 / 扣子）提问「本地有哪些同行机构」，
 * 把返回结果整段复制粘贴进来。这里调用本系统的 AI 模型，把非结构化文本整理成
 * 一份可安全提及的、结构化的本地同行清单，供 GEO 本地对比使用。
 *
 * 实现要点：
 *  - 只提取「机构名称 + 一句话可客观陈述的差异/定位」，不编造、不臆测
 *  - 过滤掉立场性、主观评价、猜测性内容，避免商业诋毁风险
 *  - 输出为纯文本，每行一条：机构名称：定位/可提及点
 *  - 不自动写入数据库，由前端回填到输入框，用户确认后再保存
 *
 * @param rawText 用户从外部 AI 平台粘贴的原始回答
 * @param userId 用户 ID（用于取该用户的默认 AI 模型配置）
 * @param city 城市（可选，用于上下文提示）
 * @param industry 行业（可选，用于上下文提示）
 */
export async function organizeLocalCompetitors(
  rawText: string,
  userId: number,
  city?: string,
  industry?: string,
): Promise<string> {
  if (!rawText || !rawText.trim()) {
    throw new Error('请先粘贴需要整理的文本');
  }

  // 1. 取用户默认 AI 模型配置
  const modelConfig = await getDefaultModelConfig(userId);
  if (!modelConfig) {
    throw new Error('未配置AI模型，请到「后台配置 > 生文模型配置」中添加并启用');
  }

  let apiKey = '';
  if (modelConfig.api_key_encrypted) {
    try {
      apiKey = decrypt(modelConfig.api_key_encrypted);
    } catch {
      throw new Error('API-KEY 解密失败，请重新配置模型');
    }
  }
  if (!apiKey) {
    throw new Error('模型未配置 API-KEY');
  }

  // 2. 构造 prompt
  const ctx = [
    city && city.trim() ? `客户所在城市：${city.trim()}` : '',
    industry && industry.trim() ? `行业：${industry.trim()}` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = `你是一个本地企业情报整理助手。用户会粘贴一段从其他 AI 平台复制来的、关于某城市同行业机构的回答文本，你需要把它整理成一份「分层级、带差异化对比点」的本地同行清单，供后续写作做 GEO 本地对比使用。

分层归类（按客户所在城市为基准）：
- 【本地对标】与客户同在城市、直接构成同城竞争的机构 —— 做差异化对比
- 【区域连锁 / 川内多地】在客户城市设有网点或覆盖周边多地的连锁/企服机构 —— 做「连锁标准化 vs 本地深耕」对比
- 【区域头部 / 规模参照】规模更大、服务层级更高的头部集团/高阶事务所 —— 做「规模与服务层级」衬托对比

要求：
1. 全部保留文本中明确出现的机构，并按上述标准归入对应分层，不要遗漏，不要只保留客户所在城市的那类
2. 每个机构保留：机构名称 + 关键客观信息（成立年份、业务侧重、服务人群、网点分布等）+ 一个差异化对比点（站在客户角度，说明写作时如何用它做对比）
3. 过滤主观评价、优劣评判、情绪化内容（如"最好""很差""专业""靠谱"），只保留中性客观描述
4. 过滤机构信息之外的废话、重复、问候语、免责声明等干扰内容
5. 输出为纯文本，以分层标题开头，每分层下列出该层机构，每个机构一行，格式：机构名称：关键信息 + 对比点
6. 若某分层没有机构，则省略该分层；若文本中完全没有可用机构，只输出「无」`

  const userPrompt = `${ctx ? `${ctx}\n\n` : ''}待整理的文本：
${rawText.trim()}

请整理成分层级本地同行清单，只输出清单内容：`;

  // 3. 调用 AI（整理任务用低温度，关闭联网搜索）
  const result = await chatCompletion({
    baseUrl: modelConfig.base_url,
    apiKey,
    model: modelConfig.model_name,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    timeout: 60000,
  });

  return (result.content || '').trim();
}