import crypto from 'crypto';

// AES-256-GCM 加密
// 密钥来源：环境变量 CONTENT_ENCRYPT_KEY（32字节hex），回退到 JWT_SECRET 派生
function getKey(): Buffer {
  const raw = process.env.CONTENT_ENCRYPT_KEY || process.env.JWT_SECRET || 'jlyl-raas-cloud-secret-key-2024';
  // 派生为32字节密钥
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * 加密明文，返回 base64 编码的 "iv:authTag:ciphertext" 字符串
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * 解密 encrypt() 返回的字符串
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * 脱敏显示：只保留前4位和后4位，中间用 **** 代替
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}
