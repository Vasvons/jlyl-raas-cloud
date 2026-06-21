/**
 * 品牌词+联系方式识别器
 * 关键：联系方式只在品牌词附近识别，避免误识别别人的联系方式
 */

export interface ContactInfo {
  phones: string[];
  emails: string[];
  urls: string[];
  ims: string[];
}

export interface RecognizeResult {
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  contacts: ContactInfo;
}

const PHONE_REGEX = /1[3-9]\d{9}/g;
const LANDLINE_REGEX = /(0\d{2,3}-\d{7,8}|400-\d{3}-\d{4}|400\d{7})/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_REGEX = /(https?:\/\/[^\s<>"']+|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s<>"']*)/g;
const WECHAT_REGEX = /(?:微信|wechat|wx|v信)[：:\s]*([a-zA-Z][a-zA-Z0-9_-]{5,19})/gi;
const QQ_REGEX = /(?:QQ|qq|q号)[：:\s]*(\d{5,12})/g;

export function recognizeContent(
  content: string,
  brandKeywords: string[]
): RecognizeResult {
  const matchedBrands = brandKeywords.filter(brand =>
    content.toLowerCase().includes(brand.toLowerCase())
  );

  if (matchedBrands.length === 0) {
    return {
      brandMatched: false,
      matchedBrands: [],
      hasContact: false,
      contacts: { phones: [], emails: [], urls: [], ims: [] }
    };
  }

  const contextWindows: string[] = [];
  for (const brand of matchedBrands) {
    let idx = 0;
    const lowerContent = content.toLowerCase();
    const lowerBrand = brand.toLowerCase();
    while ((idx = lowerContent.indexOf(lowerBrand, idx)) !== -1) {
      const start = Math.max(0, idx - 300);
      const end = Math.min(content.length, idx + brand.length + 300);
      contextWindows.push(content.substring(start, end));
      idx += brand.length;
    }
  }

  const contacts: ContactInfo = { phones: [], emails: [], urls: [], ims: [] };

  for (const window of contextWindows) {
    const phones = window.match(PHONE_REGEX) || [];
    contacts.phones.push(...phones);
    const landlines = window.match(LANDLINE_REGEX) || [];
    contacts.phones.push(...landlines);
    const emails = window.match(EMAIL_REGEX) || [];
    contacts.emails.push(...emails);
    const urls = window.match(URL_REGEX) || [];
    contacts.urls.push(...urls);
    let wechatMatch;
    const wechatRegex = new RegExp(WECHAT_REGEX.source, WECHAT_REGEX.flags);
    while ((wechatMatch = wechatRegex.exec(window)) !== null) {
      contacts.ims.push('微信:' + wechatMatch[1]);
    }
    let qqMatch;
    const qqRegex = new RegExp(QQ_REGEX.source, QQ_REGEX.flags);
    while ((qqMatch = qqRegex.exec(window)) !== null) {
      contacts.ims.push('QQ:' + qqMatch[1]);
    }
  }

  contacts.phones = [...new Set(contacts.phones)];
  contacts.emails = [...new Set(contacts.emails)];
  contacts.urls = [...new Set(contacts.urls)];
  contacts.ims = [...new Set(contacts.ims)];

  return {
    brandMatched: true,
    matchedBrands,
    hasContact: contacts.phones.length > 0 || contacts.emails.length > 0 ||
      contacts.urls.length > 0 || contacts.ims.length > 0,
    contacts
  };
}
