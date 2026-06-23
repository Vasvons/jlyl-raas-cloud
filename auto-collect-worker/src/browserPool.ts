import { chromium, Browser } from 'playwright';

export class BrowserPool {
  private pool: Browser[] = [];
  private idle: Browser[] = [];
  private maxBrowsers: number;
  private waiting: ((browser: Browser) => void)[] = [];

  constructor(maxBrowsers: number = 4) {
    this.maxBrowsers = maxBrowsers;
  }

  async acquire(): Promise<Browser> {
    if (this.idle.length > 0) {
      const browser = this.idle.pop()!;
      return browser;
    }
    if (this.pool.length < this.maxBrowsers) {
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      this.pool.push(browser);
      return browser;
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async release(browser: Browser): Promise<void> {
    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter(browser);
      return;
    }
    this.idle.push(browser);
  }

  async closeAll(): Promise<void> {
    for (const browser of this.pool) {
      try {
        await browser.close();
      } catch (e) {}
    }
    this.pool = [];
    this.idle = [];
    this.waiting = [];
  }
}
