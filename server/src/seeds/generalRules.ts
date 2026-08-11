/** 通用行业合规规则 seed 数据（v3.15 起按行业维度，1 条通用规则，对全平台生效） */
import { query } from '../db';
import { createManualRule } from '../repository';

/**
 * 通用行业合规规则（不特指某个行业，覆盖各类行业的通用广告法/平台合规要求）
 * 写作时按行业整组选用：未选择具体行业时，任务走通用行业，统一使用这条规则。
 */
export const GENERAL_COMPLIANCE_RULE = {
  platform: 'all',
  rule_title: '通用行业合规规则',
  rule_content:
    '【禁止发布的内容类目】\n' +
    '1. 虚假宣传：编造不存在的资质、虚构案例、伪造数据、夸大服务或产品效果。\n' +
    '2. 绝对化/夸大宣传：使用"最""第一""唯一""国家级""顶级""全网最低"等极限词。\n' +
    '3. 承诺效果：保证疗效、包治、100%成功、无副作用、保证有效、无效退款等确定性承诺。\n' +
    '4. 硬广/变相广告：以新闻、科普、测评、体验、故事、笔记等形式变相发布商业广告。\n' +
    '5. 商业引流：在评论区或内容中引导私信、点击主页、扫码加群、免费咨询等营销引流行为。\n' +
    '6. 侵权行为：盗用他人图片/文案、虚构用户评价、贬低或诋毁同行竞品。\n' +
    '\n' +
    '【敏感词类别（必须回避）】\n' +
    '1. 绝对化用语：最、第一、唯一、国家级、顶级、最佳、全网最低。\n' +
    '2. 承诺效果类：包治、100%成功、保证有效、无副作用、永不反弹、无效退款、立竿见影。\n' +
    '3. 夸大/杜撰术语：逆龄、冻龄、纳米、基因修复、黑科技、秒杀一切。\n' +
    '4. 诱导性词汇：限时优惠、名额有限、立即咨询、免费问诊、私信领取、点击主页。\n' +
    '\n' +
    '【行业特殊限制】\n' +
    '1. 涉及疗效、收益、通过率等可量化承诺的内容，一律以客观事实与数据为准，不得夸大。\n' +
    '2. 对比竞品时只做客观中立描述，不贬低、不诋毁、不暗示他人劣质。\n' +
    '3. 客户品牌可以提及，但只做客观描述，不夸大宣传、不虚构头衔荣誉。\n' +
    '\n' +
    '【必须标注的提示信息】\n' +
    '1. 风险提示/免责声明：效果因人而异，具体方案请咨询专业机构/人士；内容仅供参考，不构成决策建议。\n' +
    '2. 资质与信息来源标注：涉及专业领域须标注作者资质、参考文献或权威来源。',
};

/**
 * 种子导入：通用行业合规规则（幂等）
 * 若已存在 industry='general' 且 platform='all' 的 manual 通用规则，则用最新内容覆盖它；
 * 不存在则插入。
 */
export async function seedGeneralComplianceRules(): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  try {
    const existing = await query(
      `SELECT id FROM platform_compliance_rule
       WHERE platform = 'all' AND source = 'manual' AND industry = 'general'
       LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      await query(
        `UPDATE platform_compliance_rule
         SET rule_title = $1, rule_content = $2, updated_at = NOW()
         WHERE id = $3`,
        [GENERAL_COMPLIANCE_RULE.rule_title, GENERAL_COMPLIANCE_RULE.rule_content, existing.rows[0].id],
      );
      imported++;
    } else {
      await createManualRule({
        rule_title: GENERAL_COMPLIANCE_RULE.rule_title,
        rule_content: GENERAL_COMPLIANCE_RULE.rule_content,
        industry: 'general',
      });
      imported++;
    }
  } catch (e: any) {
    console.error(`[seedGeneralComplianceRules] 通用合规规则导入失败:`, e.message);
    skipped++;
  }

  console.log(`[seedGeneralComplianceRules] 通用合规规则种子导入完成: 新增 ${imported} 条, 跳过 ${skipped} 条`);
  return { imported, skipped };
}