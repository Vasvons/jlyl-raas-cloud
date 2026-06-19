const { chromium, devices } = require('playwright');

const baseUser = {
  id: 1,
  username: '绵阳明欣医疗美容门诊部有限公司',
  phone: '151****252',
  email: '',
  url: '',
  address: '',
  level: '1',
  cid: '',
  dateTime: '2026-06-18 06:06:10',
};

const subUser = {
  id: 2,
  username: '绵阳明欣医疗美容门诊部有限公司',
  phone: '151****252',
  email: '',
  url: '',
  address: '',
  level: '2',
  cid: '',
  dateTime: '2026-06-18 06:06:10',
};

const platformData = [
  { platform: '豆包', count: 28393 },
  { platform: '文心一言', count: 12722 },
  { platform: 'DeepSeek', count: 9821 },
  { platform: 'Kimi', count: 7543 },
  { platform: '腾讯元宝', count: 6210 },
  { platform: '通义千问', count: 4300 },
  { platform: '百度AI', count: 2100 },
  { platform: '纳米', count: 1500 },
];

const keywordCountData = [
  { distillateKeyword: '绵阳整形医院', count: 245 },
  { distillateKeyword: '绵阳医美机构', count: 198 },
  { distillateKeyword: '绵阳半岛超声炮', count: 176 },
  { distillateKeyword: '绵阳靠谱的超', count: 134 },
  { distillateKeyword: '绵阳医美机构2', count: 120 },
  { distillateKeyword: '绵阳做一次超', count: 98 },
  { distillateKeyword: '绵阳做一次超2', count: 87 },
  { distillateKeyword: '绵阳正规的超', count: 65 },
];

const searchRankData = [
  { id: 1, expandedKeyword: '绵阳整形医院', distillateKeyword: '绵阳整形医院机构推荐', platform: '豆包', queryTime: '2026-06-18 06:06:10', url: '', zlgjcUrl: 'https://example.com/1' },
  { id: 2, expandedKeyword: '绵阳整形医院', distillateKeyword: '绵阳整形医院机构排行', platform: '豆包', queryTime: '2026-06-18 06:06:10', url: '', zlgjcUrl: 'https://example.com/2' },
  { id: 3, expandedKeyword: '绵阳整形医院', distillateKeyword: '绵阳整形医院医院推荐', platform: '豆包', queryTime: '2026-06-18 06:06:10', url: '', zlgjcUrl: 'https://example.com/3' },
  { id: 4, expandedKeyword: '绵阳医美机构', distillateKeyword: '绵阳医美机构医院排名', platform: '豆包', queryTime: '2026-06-18 06:06:10', url: '', zlgjcUrl: 'https://example.com/4' },
  { id: 5, expandedKeyword: '绵阳整形医院', distillateKeyword: '绵阳整形医院机构排名', platform: '豆包', queryTime: '2026-06-18 06:06:10', url: '', zlgjcUrl: 'https://example.com/5' },
];

function reply(data) {
  return JSON.stringify({ code: 200, message: 'ok', data });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  await context.clearCookies();
  const page = await context.newPage();

  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    const searchParams = url.searchParams;
    if (path === '/api/users/getLoginUser') {
      const userId = searchParams.get('userId');
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply(userId ? subUser : baseUser) });
    }
    if (path === '/api/users/queryUserList') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply({ list: [subUser] }) });
    }
    if (path === '/api/users/shareTokens') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply([]) });
    }
    if (path === '/api/keywordsearchrank/platformRatio') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply(platformData) });
    }
    if (path === '/api/keywordsearchrank/keywordcound') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply(keywordCountData) });
    }
    if (path === '/api/keywordsearchrank/keypage') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply({ list: searchRankData, total: searchRankData.length }) });
    }
    if (path === '/api/dstillateKeyword/countDstillateKeyword') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: reply({ total: 228741, count: 22, zlgjc: 225782, ppgjc: 2777 }) });
    }
    return route.continue();
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('CONSOLE ERROR:', msg.text());
    }
  });
  page.on('pageerror', (err) => {
    console.log('PAGE ERROR:', err.message);
  });
  page.on('requestfailed', (req) => {
    console.log('REQUEST FAILED:', req.url(), req.failure()?.errorText);
  });

  await page.goto('http://localhost:3001/dashboard', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'E:\\Golutra1\\verify_mobile_top.png', fullPage: false });
  await page.screenshot({ path: 'E:\\Golutra1\\verify_mobile_full.png', fullPage: true });

  console.log('screenshots saved');
  await browser.close();
})();
