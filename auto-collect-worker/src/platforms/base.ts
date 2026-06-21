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

export abstract class PlatformAdapter {
  abstract platformName: string;
  abstract loginUrl: string;
  abstract chatUrl: string;
  abstract supportsShare: boolean;

  abstract login(page: Page, credentials: PlatformCredentials): Promise<boolean>;
  abstract checkLoginStatus(page: Page): Promise<boolean>;
  abstract query(page: Page, keyword: string): Promise<QueryResult>;
  abstract extractShareLink(page: Page): Promise<string | null>;
  abstract extractContent(page: Page): Promise<{ text: string; html: string }>;
  abstract waitForResponse(page: Page): Promise<void>;
}
