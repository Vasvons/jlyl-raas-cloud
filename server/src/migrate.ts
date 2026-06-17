import { pool } from './db';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

// 数据库迁移：创建所有表和索引
export async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[Migrate] 开始数据库迁移...');

    // 用户表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        phone VARCHAR(50) DEFAULT '',
        email VARCHAR(100) DEFAULT '',
        url VARCHAR(500) DEFAULT '',
        address VARCHAR(500) DEFAULT '',
        level VARCHAR(10) DEFAULT '0',
        cid VARCHAR(100) DEFAULT '',
        date_time VARCHAR(50) DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 平台表
    await client.query(`
      CREATE TABLE IF NOT EXISTS pt (
        id SERIAL PRIMARY KEY,
        pt VARCHAR(50) UNIQUE NOT NULL
      )
    `);

    // 蒸馏关键词库
    await client.query(`
      CREATE TABLE IF NOT EXISTS zlgjc (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL,
        hxgjc TEXT DEFAULT '',
        userid TEXT DEFAULT '',
        lxfs TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 品牌关键词
    await client.query(`
      CREATE TABLE IF NOT EXISTS pp (
        id SERIAL PRIMARY KEY,
        pp TEXT NOT NULL,
        user_id TEXT DEFAULT ''
      )
    `);

    // 关键词收录记录（核心表，预计数据量最大）
    await client.query(`
      CREATE TABLE IF NOT EXISTS keyword_search_rank (
        id BIGSERIAL PRIMARY KEY,
        expanded_keyword TEXT DEFAULT '',
        distillate_keyword TEXT DEFAULT '',
        platform TEXT DEFAULT '',
        user_id TEXT DEFAULT '',
        query_time TIMESTAMP,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        distillate_keyword_id BIGINT,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        w_id INTEGER DEFAULT 1,
        url TEXT DEFAULT '',
        is_url INTEGER DEFAULT 1,
        ly TEXT DEFAULT '',
        task_id BIGINT
      )
    `);

    // 蒸馏关键词跳转链接
    await client.query(`
      CREATE TABLE IF NOT EXISTS zlgjcurl (
        id SERIAL PRIMARY KEY,
        zlgjcid INTEGER NOT NULL,
        pt VARCHAR(50) DEFAULT '',
        url TEXT DEFAULT '',
        has_lxfs INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 任务表
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_info (
        id BIGINT PRIMARY KEY,
        user_id TEXT DEFAULT '',
        start_date DATE,
        end_date DATE,
        total_num INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'running',
        name VARCHAR(200) DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 任务平台权重
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_platform_weights (
        task_id BIGINT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        weight INTEGER DEFAULT 1,
        PRIMARY KEY (task_id, platform)
      )
    `);

    // 任务进度
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_progress (
        task_id BIGINT PRIMARY KEY,
        generated_num INTEGER DEFAULT 0,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 每日随机数
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_random (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        random_date DATE NOT NULL,
        random_num INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 统计缓存表（优化大数据量查询）
    await client.query(`
      CREATE TABLE IF NOT EXISTS stats_cache (
        id SERIAL PRIMARY KEY,
        cache_key VARCHAR(200) NOT NULL,
        cache_value JSONB,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(cache_key)
      )
    `);

    // 同步进度表（桌面端推送配置时记录）
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_progress (
        id SERIAL PRIMARY KEY,
        sync_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        last_sync_time TIMESTAMP,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 核心关键词表
    await client.query(`
      CREATE TABLE IF NOT EXISTS distillate_keyword (
        id SERIAL PRIMARY KEY,
        distillate_keyword TEXT NOT NULL,
        user_id TEXT DEFAULT '',
        zt INTEGER DEFAULT 1,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建索引
    console.log('[Migrate] 创建索引...');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_user ON keyword_search_rank(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_platform ON keyword_search_rank(platform)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_keyword ON keyword_search_rank(expanded_keyword)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_distillate ON keyword_search_rank(distillate_keyword)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_user_platform ON keyword_search_rank(user_id, platform)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_user_distillate ON keyword_search_rank(user_id, distillate_keyword)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_task ON keyword_search_rank(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_query_time ON keyword_search_rank(query_time DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_value ON zlgjc(value)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_userid ON zlgjc(userid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_userid_value ON zlgjc(userid, value)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjcurl_zlgjcid_pt ON zlgjcurl(zlgjcid, pt)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjcurl_has_lxfs ON zlgjcurl(has_lxfs)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_user ON pp(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dr_task_date ON daily_random(task_id, random_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dk_user ON distillate_keyword(user_id)`);

    // 初始化平台数据
    const ptCount = await client.query('SELECT COUNT(*) as count FROM pt');
    if (parseInt(ptCount.rows[0].count) === 0) {
      const platforms = ['豆包', 'DeepSeek', 'Kimi', '腾讯元宝', '通义千问', '纳米', '文心一言', '智谱AI'];
      for (const pt of platforms) {
        await client.query('INSERT INTO pt (pt) VALUES ($1) ON CONFLICT DO NOTHING', [pt]);
      }
      console.log('[Migrate] 已初始化平台数据');
    }

    // 初始化管理员账号
    const adminCount = await client.query("SELECT COUNT(*) as count FROM users WHERE username = $1", [process.env.ADMIN_USERNAME || 'admin']);
    if (parseInt(adminCount.rows[0].count) === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await client.query(
        'INSERT INTO users (username, password, level) VALUES ($1, $2, $3)',
        [process.env.ADMIN_USERNAME || 'admin', hashedPassword, '1']
      );
      console.log('[Migrate] 已创建管理员账号:', process.env.ADMIN_USERNAME || 'admin');
    }

    console.log('[Migrate] 数据库迁移完成');
  } finally {
    client.release();
  }
}

// 直接运行迁移
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[Migrate] 迁移失败:', e);
      process.exit(1);
    });
}
