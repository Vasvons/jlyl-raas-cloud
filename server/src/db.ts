import { Pool, PoolClient, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// 自定义TIMESTAMP（不带时区）类型解析器
// 数据库时区是UTC，存储的是UTC时间，但pg驱动默认按本地时区解析
// Node.js容器设置了TZ=Asia/Shanghai，会导致解析偏移8小时
// 解决方案：将TIMESTAMP视为UTC时间
types.setTypeParser(1114, (val: string) => {
  // 1114是TIMESTAMP（不带时区）的OID
  return val ? new Date(val + 'Z') : null;
});

// PostgreSQL 连接池
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'jlyl_cloud',
  user: process.env.DB_USER || 'jlyl',
  password: process.env.DB_PASSWORD || 'jlyl_cloud_2024',
  max: 20,                    // 最大连接数
  idleTimeoutMillis: 30000,   // 空闲连接超时
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] 数据库连接池错误:', err);
});

// 执行查询
export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// 事务执行
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export { pool };
export type { PoolClient };
