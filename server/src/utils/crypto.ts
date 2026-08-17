import crypto from 'crypto';

/**
 * AES-256-GCM 加密工具（v3.16.x 多密钥回退版）
 *
 * 背景：API-KEY / 代理密码 / 微信支付私钥等敏感配置以 encrypt() 加密入库，
 *       密钥由环境变量派生。若 JWT_SECRET（或 CONTENT_ENCRYPT_KEY）在某次
 *       部署/改配置后发生变化，历史加密数据将无法用新密钥解密（写作任务
 *       报「API-KEY解密失败」、登录 token 失效等）。
 *
 * 修复：decrypt() 依次尝试所有候选密钥，只要历史数据用的是其中之一即能解开；
 *       encrypt() 始终使用「当前密钥」（候选列表第一项），新数据保持可解。
 *
 * 候选密钥（按优先级）：
 *   1. CONTENT_ENCRYPT_KEY（专用加密密钥）
 *   2. JWT_SECRET（历史版本用它派生）
 *   3. 默认值 'jlyl-raas-cloud-secret-key-2024'（从未配置时）
 *   4. JWT_SECRET_HISTORY（逗号分隔，可追加多个历史密钥，用于密钥漂移后恢复旧数据）
 */

function getCandidateKeys(): string[] {
  const candidates: string[] = [];
  if (process.env.CONTENT_ENCRYPT_KEY) candidates.push(process.env.CONTENT_ENCRYPT_KEY);
  if (process.env.JWT_SECRET) candidates.push(process.env.JWT_SECRET);
  candidates.push('jlyl-raas-cloud-secret-key-2024');
  if (process.env.JWT_SECRET_HISTORY) {
    for (const k of process.env.JWT_SECRET_HISTORY.split(',')) {
      const t = (k || '').trim();
      if (t) candidates.push(t);
    }
  }
  return [...new Set(candidates)];
}

function deriveKey(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * 加密明文，返回 base64 编码的 "iv:authTag:ciphertext" 字符串
 * 始终使用当前密钥（候选列表第一项）
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey(getCandidateKeys()[0]);
  const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * 解密 encrypt() 返回的字符串
 * 依次尝试所有候选密钥，任一成功即返回；全部失败才抛错
 */
export function decrypt(encrypted: string): string {
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error('Invalid encrypted format');
  }
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];
  let lastErr: Error | null = null;
  for (const raw of getCandidateKeys()) {
    try {
      const key = deriveKey(raw);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Decryption failed');
}

/**
 * 脱敏显示：只保留前4位和后4位，中间用 **** 代替
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}
