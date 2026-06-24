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

    // 任务时区权重（每3小时一个时区，共8个时区：0-3, 3-6, 6-9, ... 21-24）
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_hour_weights (
        task_id BIGINT NOT NULL,
        hour_slot INTEGER NOT NULL,
        weight INTEGER DEFAULT 1,
        PRIMARY KEY (task_id, hour_slot)
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

    // 分享token表（用于GEO报告页面分享功能）
    await client.query(`
      CREATE TABLE IF NOT EXISTS share_tokens (
        id SERIAL PRIMARY KEY,
        token VARCHAR(100) UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        username VARCHAR(100) DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expire_time TIMESTAMP,
        last_use_time TIMESTAMP
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ksr_pending ON keyword_search_rank(task_id) WHERE query_time IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_value ON zlgjc(value)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_userid ON zlgjc(userid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_userid_value ON zlgjc(userid, value)`);

    // 增量迁移：为 zlgjc 表添加 keyword_type 列（0=蒸馏关键词, 1=品牌关键词）
    // 必须在创建依赖该列的索引之前执行
    try {
      await client.query(`ALTER TABLE zlgjc ADD COLUMN IF NOT EXISTS keyword_type SMALLINT DEFAULT 0`);
    } catch (e) {
      // 列已存在则忽略
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjc_userid_type ON zlgjc(userid, keyword_type)`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjcurl_zlgjcid_pt ON zlgjcurl(zlgjcid, pt)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zlgjcurl_has_lxfs ON zlgjcurl(has_lxfs)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_user ON pp(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dr_task_date ON daily_random(task_id, random_date)`);
    // daily_random 需要 UNIQUE 约束才能使用 ON CONFLICT (task_id, random_date)
    // 先删除重复记录（每个 task_id+random_date 只保留 id 最大的一条）
    await client.query(`
      DELETE FROM daily_random
      WHERE id NOT IN (
        SELECT MAX(id) FROM daily_random GROUP BY task_id, random_date
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dr_task_date_unique ON daily_random(task_id, random_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dk_user ON distillate_keyword(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_share_token ON share_tokens(token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_share_user ON share_tokens(user_id)`);

    // 增量迁移：为 share_tokens 表添加 custom_title 列（自定义分享链接标题）
    try {
      await client.query(`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS custom_title VARCHAR(200) DEFAULT ''`);
    } catch (e) {
      // 列已存在则忽略
    }

    // 修正已有数据的时间逻辑
    // 新设计：生成（=收录）create_time=NOW(), query_time=NULL；查询展示 query_time=NOW()
    // 历史数据（create_time 在今天之前）：query_time 应已设置（历史已展示），无需修正
    // 今日数据：query_time IS NULL 表示尚未被查询展示，由查询展示cron处理（每10分钟）
    // 不再自动设置query_time，保持生成与展示分离

    // 修正未来时间数据：历史补齐时 randomTimeInDate 使用了本地时区 setHours，
    // 导致北京时间被当作UTC存储，产生未来时间。修正方法：将未来时间减去8小时。
    const futureFixResult = await client.query(
      `UPDATE keyword_search_rank
       SET query_time = query_time - INTERVAL '8 hours',
           create_time = create_time - INTERVAL '8 hours',
           update_time = update_time - INTERVAL '8 hours'
       WHERE query_time > clock_timestamp()
          OR create_time > clock_timestamp()`
    );
    if (futureFixResult.rowCount && futureFixResult.rowCount > 0) {
      console.log(`[Migrate] 修正 ${futureFixResult.rowCount} 条未来时间数据（减8小时）`);
    }

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

    // ===== 真实收录查询功能相关表 =====

    // 真实查询任务表
    await client.query(`
      CREATE TABLE IF NOT EXISTS real_collect_task (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_name VARCHAR(100) NOT NULL,
        keyword_type SMALLINT NOT NULL,
        platforms TEXT[] NOT NULL,
        cron_expr VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        last_run_time TIMESTAMP,
        last_run_end_time TIMESTAMP,
        last_run_status VARCHAR(20),
        last_run_record_count INTEGER DEFAULT 0,
        last_run_brand_count INTEGER DEFAULT 0,
        last_error TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rct_user ON real_collect_task(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rct_status ON real_collect_task(status)`);
    // 添加 shard_size 字段（每片关键词数量，默认50）
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS shard_size INTEGER DEFAULT 50`);

    // 真实查询结果表
    await client.query(`
      CREATE TABLE IF NOT EXISTS real_collect_record (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        user_id TEXT NOT NULL,
        keyword TEXT NOT NULL,
        keyword_type SMALLINT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        brand_matched BOOLEAN DEFAULT FALSE,
        matched_brands TEXT[],
        has_contact BOOLEAN DEFAULT FALSE,
        contacts JSONB,
        share_url TEXT,
        static_page_id BIGINT,
        raw_content TEXT,
        query_time TIMESTAMP NOT NULL,
        worker_id VARCHAR(50),
        retry_count INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_rct_task FOREIGN KEY (task_id) REFERENCES real_collect_task(id) ON DELETE CASCADE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_user_platform ON real_collect_record(user_id, platform)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_query_time ON real_collect_record(query_time DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_brand_matched ON real_collect_record(brand_matched) WHERE brand_matched = true`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_task ON real_collect_record(task_id)`);
    // 复合索引：优化 getKeywordSearchRank 中的 UNION ALL 查询（user_id + brand_matched + query_time 排序）
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_user_brand_time ON real_collect_record(user_id, brand_matched, query_time DESC)`);
    // 联系方式过滤索引：优化 getPlatformRatio 中 has_contact 过滤
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_user_contact ON real_collect_record(user_id, has_contact) WHERE has_contact = true`);
    // create_time 索引：优化 cleanOldRealCollectRecords 按时间清理
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_create_time ON real_collect_record(create_time DESC)`);

    // 静态页存储表
    await client.query(`
      CREATE TABLE IF NOT EXISTS real_collect_static_page (
        id BIGSERIAL PRIMARY KEY,
        record_id BIGINT NOT NULL,
        html_content TEXT NOT NULL,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_rsp_record FOREIGN KEY (record_id) REFERENCES real_collect_record(id) ON DELETE CASCADE
      )
    `);
    // record_id 索引：优化 CASCADE 删除时的查找
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rsp_record_id ON real_collect_static_page(record_id)`);

    // 平台凭据表
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_credentials (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(50) NOT NULL UNIQUE,
        username VARCHAR(100),
        password VARCHAR(200),
        cookies JSONB,
        cookie_expire_time TIMESTAMP,
        login_status VARCHAR(20) DEFAULT 'unknown',
        last_login_time TIMESTAMP,
        last_error TEXT,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 平台账号池表（支持一个平台多个账号，用于账号池并发）
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_auth (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT,
        platform VARCHAR(32) NOT NULL,
        account_name VARCHAR(128),
        storage_state TEXT NOT NULL,
        expires_at TIMESTAMP,
        status VARCHAR(16) DEFAULT 'active',
        last_used_at TIMESTAMP,
        last_query_count INTEGER DEFAULT 0,
        daily_limit INTEGER DEFAULT 200,
        cooldown_until TIMESTAMP,
        health_score INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pa_platform_status ON platform_auth(platform, status, last_used_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pa_user ON platform_auth(user_id)`);

    // 增量迁移：将旧默认值 50 的账号更新为新的默认值 200
    const dailyLimitUpdate = await client.query(
      `UPDATE platform_auth SET daily_limit = 200 WHERE daily_limit = 50 OR daily_limit IS NULL`
    );
    if (dailyLimitUpdate.rowCount && dailyLimitUpdate.rowCount > 0) {
      console.log(`[Migrate] 已将 ${dailyLimitUpdate.rowCount} 个账号的每日限额从 50 更新为 200`);
    }

    // 增量迁移：添加 avatar_url 字段（用于账号列表显示头像）
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS avatar_url TEXT`);

    console.log('[Migrate] 真实收录查询相关表创建/验证完成');

    // 关键词生成器配置表（持久化词汇配置，替代localStorage）
    await client.query(`
      CREATE TABLE IF NOT EXISTS kw_config (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        config_type VARCHAR(20) NOT NULL,
        config_json TEXT NOT NULL,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, config_type)
      )
    `);

    // 真实查询任务队列表
    await client.query(`
      CREATE TABLE IF NOT EXISTS real_collect_queue (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        user_id TEXT NOT NULL,
        keyword_type SMALLINT NOT NULL,
        platforms TEXT[] NOT NULL,
        keywords JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        worker_id VARCHAR(50),
        result_record_count INTEGER DEFAULT 0,
        result_brand_count INTEGER DEFAULT 0,
        error TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        CONSTRAINT fk_rcq_task FOREIGN KEY (task_id) REFERENCES real_collect_task(id) ON DELETE CASCADE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcq_status ON real_collect_queue(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcq_task ON real_collect_queue(task_id)`);
    // 添加priority字段（0=普通定时入队，1=手动立即执行），兼容已存在表
    await client.query(`ALTER TABLE real_collect_queue ADD COLUMN IF NOT EXISTS priority SMALLINT DEFAULT 0`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcq_priority ON real_collect_queue(priority)`);
    // 添加abort_requested字段（用于中断正在执行的任务）
    await client.query(`ALTER TABLE real_collect_queue ADD COLUMN IF NOT EXISTS abort_requested BOOLEAN DEFAULT false`);
    // 添加round_no字段（标记分片所属轮次，用于精准统计当前轮次进度，避免跨轮次累计）
    await client.query(`ALTER TABLE real_collect_queue ADD COLUMN IF NOT EXISTS round_no INTEGER DEFAULT 0`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcq_task_round ON real_collect_queue(task_id, round_no)`);

    // Worker 运行日志表
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_log (
        id BIGSERIAL PRIMARY KEY,
        worker_id VARCHAR(64) NOT NULL,
        task_id BIGINT,
        level VARCHAR(16) DEFAULT 'info',
        message TEXT NOT NULL,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wl_task ON worker_log(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wl_create_time ON worker_log(create_time DESC)`);

    // AEO 分析报告表
    await client.query(`
      CREATE TABLE IF NOT EXISTS aeo_report (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        user_id TEXT NOT NULL,
        report_date DATE NOT NULL,
        visibility_score INTEGER DEFAULT 0,
        mention_count INTEGER DEFAULT 0,
        positive_ratio NUMERIC(5,2) DEFAULT 0,
        neutral_ratio NUMERIC(5,2) DEFAULT 0,
        negative_ratio NUMERIC(5,2) DEFAULT 0,
        competitor_analysis TEXT,
        suggestions TEXT,
        raw_analysis TEXT,
        record_ids BIGINT[],
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_aeo_task FOREIGN KEY (task_id) REFERENCES real_collect_task(id) ON DELETE CASCADE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_task ON aeo_report(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_user_date ON aeo_report(user_id, report_date DESC)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_aeo_task_date_unique ON aeo_report(task_id, report_date)`);

    // ============ AEO 轮次报告表（基于完整关键词库的分析，每轮100%完成后生成）============
    await client.query(`
      CREATE TABLE IF NOT EXISTS aeo_full_report (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        user_id TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        total_keywords INTEGER DEFAULT 0,
        total_records INTEGER DEFAULT 0,
        brand_matched_count INTEGER DEFAULT 0,
        visibility_score INTEGER DEFAULT 0,
        mention_count INTEGER DEFAULT 0,
        positive_ratio NUMERIC(5,2) DEFAULT 0,
        neutral_ratio NUMERIC(5,2) DEFAULT 0,
        negative_ratio NUMERIC(5,2) DEFAULT 0,
        competitor_analysis TEXT,
        suggestions TEXT,
        raw_analysis TEXT,
        record_ids BIGINT[],
        round_start_time TIMESTAMP,
        round_end_time TIMESTAMP,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_aeo_full_task FOREIGN KEY (task_id) REFERENCES real_collect_task(id) ON DELETE CASCADE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_full_task ON aeo_full_report(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_full_task_round ON aeo_full_report(task_id, round_no DESC)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_aeo_full_task_round_unique ON aeo_full_report(task_id, round_no)`);

    // ============ platform_auth 账号状态字段 ============
    // 账号状态（health_status）：normal（正常）/ banned（被封禁）/ offline（掉线）
    // 取消旧的 healthy/warning/danger 四态健康度设计，改为三态账号状态
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS health_status VARCHAR(16) DEFAULT 'normal'`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS risk_level VARCHAR(16) DEFAULT 'none'`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS risk_detected_at TIMESTAMP`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS risk_count INTEGER DEFAULT 0`);
    // 迁移历史数据：healthy → normal，warning/danger → normal（取消自动降级，恢复可用）
    await client.query(`UPDATE platform_auth SET health_status = 'normal' WHERE health_status IN ('healthy', 'warning', 'danger')`);
    // 健康状态索引
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pa_health ON platform_auth(platform, health_status, last_used_at)`);

    // ============ real_collect_task 轮次号字段 ============
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS round_no INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS round_start_time TIMESTAMP`);

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
