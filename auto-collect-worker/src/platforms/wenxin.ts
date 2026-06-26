import { Page } from 'playwright';
import { BasePlatformAdapter } from './baseAdapter';

/** 文心一言适配器
 *
 * 2026年6月25日0时起，文心一言官网提问入口升级，迁移至百度文心网站。
 * 原地址 yiyan.baidu.com 首页变为服务升级公告页，不再提供聊天功能。
 *
 * 新地址：https://wenxin.baidu.com/
 * 新页面特征：
 * - 有"开启新对话"、"知识库"、"对话历史"等侧边栏
 * - 有"深度思考"、"DS-V4 Pro"等模式选项
 * - 未登录时显示"请登录"
 */
export class WenxinAdapter extends BasePlatformAdapter {
  platformName = '文心一言';
  loginUrl = 'https://wenxin.baidu.com/';
  // 新地址：2026年6月25日迁移到 wenxin.baidu.com
  chatUrl = 'https://wenxin.baidu.com/';
  supportsShare = true;
  // 输入框选择器：新页面结构未知，使用通用选择器兼容多种情况
  // 保留 Slate.js 编辑器选择器（旧版）+ 通用 textarea（新版）
  protected inputSelector = 'div[data-slate-node="element"], textarea, #chat-input, .chat-input textarea, [class*="chat-input"] textarea, div[contenteditable="true"], [class*="input-area"] textarea, [class*="prompt"] textarea, [class*="editor"] textarea, [class*="chat-input"] [contenteditable="true"], [class*="input-area"] [contenteditable="true"], [role="textbox"]';
  // 响应选择器：新页面结构未知，使用通用选择器
  protected responseSelector = '#answer_text_id, .answer, .markdown-body, [class*="answer"], [class*="chat-content"], [class*="response"], [class*="message-content"]';
  // 停止按钮
  protected stopButtonSelector = '.pause__ZJpNwrGC, [class*="pause"], [class*="stop"], .stop-btn, [class*="Stop"]';
  protected loginUrlPattern = 'login';

  async extractShareLink(page: Page): Promise<string | null> {
    // 文心一言分享链接必须通过点击分享按钮获取
    // 不 fallback 到 getCurrentPageShareUrl：对话 URL 是私有的
    const shareBtnSelectors = [
      'button:has-text("分享")',
      '[class*="share"]:not([class*="shared"])',
      '[data-testid*="share"]',
      '[aria-label*="分享"]',
    ];
    const dialogSelectors = [
      '[class*="share-dialog"]',
      '[class*="share-modal"]',
      '[role="dialog"]',
      '[class*="popup"]',
      '[class*="modal"]',
    ];
    for (const btnSel of shareBtnSelectors) {
      for (const dlgSel of dialogSelectors) {
        const url = await this.extractShareLinkFromDialog(page, btnSel, dlgSel);
        if (url) return url;
      }
    }
    return null;
  }

  /** 文心一言导航后处理：
   *  新版页面（wenxin.baidu.com）的导航后处理：
   *  1. 等待 SPA 渲染完成
   *  2. 快速检测"可见的"输入框是否存在
   *  3. 如果找不到可见输入框，尝试点击"开启新对话"按钮
   */
  protected async afterNavigate(page: Page): Promise<void> {
    // 等待 SPA 渲染完成
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      return; // 未登录，交给 checkLoginStatus 处理
    }

    // 快速检测"可见的"输入框是否存在
    const hasVisibleInput = await this.hasVisibleInput(page);

    if (hasVisibleInput) {
      // 找到可见输入框，无需额外操作
      return;
    }

    // 找不到可见输入框，尝试点击"开启新对话"按钮（新版页面的入口按钮）
    console.log(`[文心一言] 未找到可见输入框，尝试点击"开启新对话"按钮`);
    await this.tryClickEntryButton(page);
  }

  /** 检测页面是否存在可见的输入框（避免匹配到隐藏的textarea） */
  private async hasVisibleInput(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(this.inputSelector, { timeout: 2000, state: 'visible' });
      return true;
    } catch {
      return false;
    }
  }

  /** 尝试点击入口按钮（通过 JS evaluate 绕过 isVisible 检查） */
  private async tryClickEntryButton(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      // 新版页面的入口按钮文本
      const entryTexts = ['开启新对话', '开始对话', '立即体验', '开始使用', '新建对话', '开始聊天', '立即开始'];
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      // 优先精确匹配
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text === nt)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // 模糊匹配
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        if (entryTexts.some(nt => text.includes(nt) && text.length < 20)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(3000);
    }
  }
}
