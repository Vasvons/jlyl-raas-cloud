/** 医美行业合规规则 seed 数据（v3.12 起按行业维度，1 条通用规则，对全平台生效） */
import { query } from '../db';
import { createManualRule } from '../repository';

/**
 * 医疗美容行业通用合规规则（合并自原 12 平台规则，去除平台差异，保留共性要求）
 * 写作时按行业整组选用，所有平台的文章统一使用这条规则。
 */
export const MEDICAL_BEAUTY_MERGED_RULE = {
  platform: 'all',
  rule_title: '医疗美容行业通用合规规则',
  rule_content:
    '【资质要求】\n' +
    '1. 发布医美科普内容，账号主体须为依法设立的医疗机构，并持有《医疗机构执业许可证》；发布医疗广告前须取得《医疗广告审查证明》。\n' +
    '2. 内容创作者须具备相应医疗专业资质（如执业医师资格证），并在内容中标注作者资质与信息来源；无医疗资质账号不得发布专业医疗科普内容。\n' +
    '3. 医疗广告仅限八项法定信息：医疗机构第一名称、地址、所有制形式、类别、诊疗科目、床位数、接诊时间、联系电话。\n' +
    '\n' +
    '【禁止发布的内容类目】\n' +
    '1. 医美项目推广、营销广告、商业合作推广、医美价格促销。\n' +
    '2. 术前术后对比照；利用患者形象作证明、患者案例分享。\n' +
    '3. 医美技术介绍、疾病诊疗方法、疾病名称与诊疗方法。\n' +
    '4. 医美直播带货、直播间展示医美项目/价格/效果。\n' +
    '5. 以新闻、健康科普、故事、访谈、测评、体验、Vlog、笔记、技术分享、经验分享等形式变相发布医美广告。\n' +
    '6. 在评论区或内容中引导私信咨询医美项目、点击主页、免费问诊等商业引流行为。\n' +
    '\n' +
    '【敏感词类别（必须回避）】\n' +
    '1. 绝对化用语：最、第一、顶级、唯一、独家、国家级、最佳。\n' +
    '2. 承诺效果类：根治、包治百病、永不反弹、永久脱毛、彻底清除、100%成功、保证有效、无痛。\n' +
    '3. 夸大宣传/杜撰术语：逆龄术、冻龄术、焕颜术、纳米级、基因修复、轻松瘦身、丰胸增大。\n' +
    '4. 诱导性词汇：限时优惠、名额有限、立即咨询、免费问诊、私信交流、点击主页。\n' +
    '\n' +
    '【行业特殊限制】\n' +
    '1. 禁止术前术后对比照，禁止利用患者形象作证明。\n' +
    '2. 不得涉及具体医疗技术、诊疗方法、疾病名称。\n' +
    '3. 医疗广告仅限八项法定信息，不得超范围宣传。\n' +
    '4. 禁止以新闻、科普、测评、Vlog、笔记等形式变相发布医美广告。\n' +
    '5. 禁止医美直播带货；医疗健康认证创作者禁止以任何形式开展医美项目展示、价格促销、咨询转化。\n' +
    '6. 禁止推广丰胸增高用品、医美吸脂等非正规医疗机构推广项目。\n' +
    '\n' +
    '【必须标注的提示信息】\n' +
    '1. 风险提示：医疗美容存在风险，效果因人而异。\n' +
    '2. 资质标注：《医疗机构执业许可证》、《医疗广告审查证明》文号、作者执业资质。\n' +
    '3. 信息来源标注：参考文献、权威指南（科普内容须标注来源）。\n' +
    '4. 免责声明：本内容仅供科普参考，不构成诊疗建议；具体方案需到正规医疗机构面诊。',
};

/**
 * 种子导入：医疗美容行业通用合规规则（幂等）
 * 仅当尚不存在 industry='medical_beauty' 且 platform='all' 的 manual 通用规则时才插入，
 * 已存在的规则不会被覆盖（用户手动编辑过的内容受保护）。
 */
export async function seedMedicalBeautyRules(): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  try {
    const existing = await query(
      `SELECT id FROM platform_compliance_rule
       WHERE platform = 'all' AND source = 'manual' AND industry = 'medical_beauty'
       LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      skipped++;
    } else {
      await createManualRule({
        rule_title: MEDICAL_BEAUTY_MERGED_RULE.rule_title,
        rule_content: MEDICAL_BEAUTY_MERGED_RULE.rule_content,
        industry: 'medical_beauty',
      });
      imported++;
    }
  } catch (e: any) {
    console.error(`[seedMedicalBeautyRules] 医美通用规则导入失败:`, e.message);
    skipped++;
  }

  console.log(`[seedMedicalBeautyRules] 医美通用规则种子导入完成: 新增 ${imported} 条, 跳过 ${skipped} 条`);
  return { imported, skipped };
}