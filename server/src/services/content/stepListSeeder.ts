import fs from 'fs';
import path from 'path';
import { getStepListByPlatform, upsertStepList } from '../../repository';

const SUPPORTED_PLATFORMS = [
  'bjh', 'csdn', 'xhs', 'zh', 'wxgzh', 'tt',
  'sohu', 'qeh', 'wy', 'bili', 'js', 'dy',
];

/**
 * 启动时检查 publish_step_list 表，为缺失的平台导入种子 step_list。
 *
 * 种子文件位于 server/data/step-lists/<platform>.json，包含完整 step 数组。
 * 平台 UI 改版后，可通过 PUT /content/publish/step-lists/:platform 热更新，无需重启服务。
 *
 * 设计要点：
 * 1. 幂等 — 仅当某平台在表中不存在任何记录时才导入种子
 * 2. 版本号 — 种子统一使用 1.0.0，便于后续通过版本号升级
 * 3. 占位 — 9 个未实现平台也导入占位 step_list（含 is_placeholder:true 标识），
 *           桌面端 Worker 检测到占位 step_list 时会跳过并提示用户
 * 4. 真实步骤刷新（v1.7.0 真实步骤）— 9 个 placeholder 平台 step_list 已升级为基于
 *    auth helper 反编译的真实确定性步骤，ai_action 仅作为 ai_fallback 兜底；若现有
 *    记录仍为 placeholder（is_placeholder=true），用最新种子文件覆盖刷新，便于持续
 *    优化真实步骤选择器；用户手动调试好的真实配置（is_placeholder=false/null）始终
 *    保留不被覆盖。
 */
export async function seedStepLists(): Promise<void> {
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let refreshed = 0;

  for (const platform of SUPPORTED_PLATFORMS) {
    try {
      // 种子 JSON 文件路径：编译后 dist/services/content/stepListSeeder.js → ../../data/step-lists
      const filePath = path.join(__dirname, '../../../data/step-lists', `${platform}.json`);
      if (!fs.existsSync(filePath)) {
        console.warn(`[StepListSeeder] ${platform} 种子文件不存在: ${filePath}`);
        failed++;
        continue;
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const seedData = JSON.parse(fileContent);
      const seedVersion = seedData?.version || '1.0.0';

      const existing = await getStepListByPlatform(platform);
      let isRefresh = false;
      if (existing) {
        // v1.7.0：若现有记录仍为 placeholder，用最新种子文件刷新（持续优化真实步骤）
        const isExistingPlaceholder = existing.step_list?.is_placeholder === true;
        // v1.7.1：若版本号不一致（种子有更新），用最新种子文件刷新
        const dbVersion = existing.version || '';
        const versionMismatch = !isExistingPlaceholder && dbVersion !== seedVersion;
        if (!isExistingPlaceholder && !versionMismatch) {
          skipped++;
          continue;
        }
        // placeholder 或 版本不一致，走刷新逻辑（下方代码会重新 upsert）
        isRefresh = true;
      }

      // 整个 seedData（含 steps 数组、login_check_url 等元数据）作为 step_list 字段存储
      // 桌面端发布 Worker 通过 step_list.steps 遍历执行
      const id = await upsertStepList(
        platform,
        seedVersion,
        seedData,
        seedData.description || `${platform} 种子数据`
      );
      if (isRefresh) {
        console.log(`[StepListSeeder] 已刷新 ${platform} 模板 v${seedVersion} (id=${id}${seedData.is_placeholder ? ', placeholder' : ''})`);
        refreshed++;
      } else {
        console.log(`[StepListSeeder] 已导入 ${platform} 种子数据 v${seedVersion} (id=${id}${seedData.is_placeholder ? ', placeholder' : ''})`);
        imported++;
      }
    } catch (err: any) {
      console.error(`[StepListSeeder] 导入 ${platform} 失败:`, err.message);
      failed++;
    }
  }

  // v1.7.0 升级：9 平台 placeholder 改为真实确定性步骤，ai_action 降级为 ai_fallback 兜底
  console.log(`[StepListSeeder] 完成：导入 ${imported}，刷新 ${refreshed}，跳过 ${skipped}，失败 ${failed}`);
}
