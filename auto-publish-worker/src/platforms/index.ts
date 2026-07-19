/**
 * 平台适配器注册表（v1.9.35）
 *
 * 通过 getPlatformAdapter(platform) 获取平台适配器实例。
 * 新增平台只需在此注册一个实例，无需修改 publishWorker.ts / PlaywrightLogin.ts。
 */
import { PlatformAdapter } from './types';
import { wxgzh } from './wxgzh';
import { dy } from './dy';
import { xhs } from './xhs';
import { tt } from './tt';
import { bjh } from './bjh';
import { zh } from './zh';
import { csdn } from './csdn';
import { js } from './js';
import { bili } from './bili';
import { qeh } from './qeh';
import { sohu } from './sohu';
import { wy } from './wy';

export * from './types';
export { BasePlatformAdapter } from './base';

/** 12 平台适配器实例注册表 */
const adapters: Record<string, PlatformAdapter> = {
  wxgzh,
  dy,
  xhs,
  tt,
  bjh,
  zh,
  csdn,
  js,
  bili,
  qeh,
  sohu,
  wy,
};

/**
 * 获取平台适配器
 * @param platform 平台标识（与 platform_auth.platform 字段一致）
 * @returns 平台适配器实例
 * @throws 未知平台时抛错
 */
export function getPlatformAdapter(platform: string): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) {
    throw new Error(`未知平台: ${platform}，未在 platforms/index.ts 注册`);
  }
  return adapter;
}

/** 判断平台是否已注册 */
export function isPlatformSupported(platform: string): boolean {
  return platform in adapters;
}
