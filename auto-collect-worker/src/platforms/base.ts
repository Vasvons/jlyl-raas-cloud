import { Page } from 'playwright';

export interface PlatformCredentials {
  username: string;
  password: string;
  cookies?: any[];
}

export interface QueryResult {
  content: string;
  shareUrl: string | null;
  htmlContent?: string;
  supportsShare: boolean;
}

/**
 * 平台适配器基类
 * 
 * 登录态通过 storageState 注入（由账号池管理），适配器只需关注查询逻辑。
 * login 方法仅在需要时用于自动登录（通常不需要，storageState 已含登录态）。
 */
export abstract class PlatformAdapter {
  abstract platformName: string;
  abstract loginUrl: string;
  abstract chatUrl: string;
  abstract supportsShare: boolean;

  /** 登录方法（通常不需要实现，storageState 已含登录态） */
  abstract login(page: Page, credentials: PlatformCredentials): Promise<boolean>;
  
  /** 检查当前页面是否已登录（访问 chatUrl 后判断 URL 或 DOM 元素） */
  abstract checkLoginStatus(page: Page): Promise<boolean>;
  
  /** 执行查询：输入关键词、等待响应、提取内容 */
  abstract query(page: Page, keyword: string): Promise<QueryResult>;
  
  /** 提取分享链接（如平台支持） */
  abstract extractShareLink(page: Page): Promise<string | null>;
  
  /** 提取 AI 回答内容 */
  abstract extractContent(page: Page): Promise<{ text: string; html: string }>;
  
  /** 等待 AI 回答完成 */
  abstract waitForResponse(page: Page): Promise<void>;
}

/**
 * 通用工具函数
 */

/** 随机 User-Agent */
export function getRandomUA(): string {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

/** 随机延迟（毫秒） */
export function randomDelay(min: number = 1000, max: number = 3000): Promise<void> {
  const delay = min + Math.random() * (max - min);
  return new Promise(resolve => setTimeout(resolve, delay));
}
