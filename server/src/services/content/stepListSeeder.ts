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
 */
export async function seedStepLists(): Promise<void> {
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const platform of SUPPORTED_PLATFORMS) {
    try {
      const existing = await getStepListByPlatform(platform);
      if (existing) {
        skipped++;
        continue;
      }

      // 种子 JSON 文件路径：编译后 dist/services/content/stepListSeeder.js → ../../data/step-lists
      const filePath = path.join(__dirname, '../../../data/step-lists', `${platform}.json`);
      if (!fs.existsSync(filePath)) {
        console.warn(`[StepListSeeder] ${platform} 种子文件不存在: ${filePath}`);
        failed++;
        continue;
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const seedData = JSON.parse(fileContent);

      // 整个 seedData（含 steps 数组、login_check_url 等元数据）作为 step_list 字段存储
      // 桌面端发布 Worker 通过 step_list.steps 遍历执行
      const id = await upsertStepList(
        platform,
        seedData.version || '1.0.0',
        seedData,
        seedData.description || `${platform} 种子数据`
      );
      console.log(`[StepListSeeder] 已导入 ${platform} 种子数据 (id=${id}${seedData.is_placeholder ? ', placeholder' : ''})`);
      imported++;
    } catch (err: any) {
      console.error(`[StepListSeeder] 导入 ${platform} 失败:`, err.message);
      failed++;
    }
  }

  console.log(`[StepListSeeder] 完成：导入 ${imported}，跳过 ${skipped}，失败 ${failed}`);
}
