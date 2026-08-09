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
  const ctx = [city && city.trim() ? `所在城市：${city.trim()}` : '', industry && industry.trim() ? `行业：${industry.trim()}` : '']
    .filter(Boolean)
    .join('\n');

  const systemPrompt = `你是一个本地企业情报整理助手。用户会粘贴一段从其他 AI 平台复制来的、关于某城市同行业机构的回答文本，你需要把它整理成一份「本地同行 / 本地区域机构」清单，供后续写作做 GEO 本地对比使用。

要求：
1. 只提取文本中明确出现的机构名称，不要编造、不要补充文本里没有的机构
2. 每个机构配一句客观、可安全提及的定位或差异点（如业务侧重、成立年限、服务人群等），只陈述文本中已有的客观信息；若文本没有足够信息，只保留机构名称即可
3. 过滤掉主观评价、优劣评判、猜测性、情绪化内容（例如"最好""很差""专业""靠谱"这类主观词），只保留中性客观描述
4. 过滤掉机构名称之外的废话、重复、问候语、免责声明等干扰内容
5. 输出为纯文本，每行一条，格式：机构名称：定位/可提及点（没有定位信息时只写机构名称）
6. 若文本中没有可用的机构信息，只输出「无」`

  const userPrompt = `${ctx ? `${ctx}\n\n` : ''}待整理的文本：
${rawText.trim()}

请整理成本地同行清单，只输出清单内容：`;

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