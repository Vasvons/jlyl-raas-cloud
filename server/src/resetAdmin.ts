/**
 * 管理员密码重置脚本
 *
 * 在服务器上执行：
 *   docker exec jlyl-cloud-server node /app/server/dist/resetAdmin.js
 *
 * 或本地执行（需配置 DATABASE_URL）：
 *   npx ts-node server/src/resetAdmin.ts
 */

import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { pool } from './db';

dotenv.config();

async function resetAdmin() {
  const client = await pool.connect();
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPassword = await bcrypt.hash(password, 10);

    // 更新管理员密码
    const result = await client.query(
      `UPDATE users SET password = $1 WHERE username = $2 AND level = '1' RETURNING id, username`,
      [hashedPassword, username]
    );

    if (result.rows.length === 0) {
      // 管理员不存在，创建
      await client.query(
        'INSERT INTO users (username, password, level) VALUES ($1, $2, $3)',
        [username, hashedPassword, '1']
      );
      console.log(`[ResetAdmin] 管理员账号已创建: ${username}`);
    } else {
      console.log(`[ResetAdmin] 管理员密码已重置: ${username} (ID: ${result.rows[0].id})`);
    }

    console.log(`[ResetAdmin] 用户名: ${username}`);
    console.log(`[ResetAdmin] 密码: ${password}`);
    console.log('[ResetAdmin] 重置完成');
  } finally {
    client.release();
    await pool.end();
  }
}

resetAdmin().catch(err => {
  console.error('[ResetAdmin] 重置失败:', err);
  process.exit(1);
});
