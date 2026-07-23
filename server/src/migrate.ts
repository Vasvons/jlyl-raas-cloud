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

    // v2.5.35：users 表新增 role/parent_admin_id/status/expire_at/license_key 字段（代理客户端账号系统）
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'customer'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_admin_id BIGINT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS expire_at TIMESTAMP`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS license_key VARCHAR(64)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_license_key ON users(license_key) WHERE license_key IS NOT NULL`);
    // 回填历史 admin 账号的 role='super_admin'
    await client.query(`UPDATE users SET role = 'super_admin' WHERE level = '1' AND role = 'customer'`);
    // v2.5.36：回填历史代理账号（level='2' 但 role 仍为默认 'customer'）为 'agent'
    // 这类账号是在 role 列添加之前创建的，migrate 给了默认值 'customer'，导致 verify-license 校验失败
    const backfillResult = await client.query(`UPDATE users SET role = 'agent' WHERE level = '2' AND role = 'customer' RETURNING id, username`);
    if (backfillResult.rows.length > 0) {
      console.log(`[Migrate] 已回填 ${backfillResult.rows.length} 个历史代理账号 role='agent':`, backfillResult.rows.map((r: any) => r.username));
    }

    // v2.5.35：管理员-代理分配表
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_agent_assign (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL,
        agent_user_id BIGINT NOT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (admin_user_id, agent_user_id)
      )
    `);

    // v2.5.35：代理板块授权表
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_module_grant (
        id BIGSERIAL PRIMARY KEY,
        agent_user_id BIGINT NOT NULL,
        module_code VARCHAR(50) NOT NULL,
        granted_by BIGINT NOT NULL,
        granted_at TIMESTAMP DEFAULT NOW(),
        expire_at TIMESTAMP,
        config JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'active',
        UNIQUE (agent_user_id, module_code)
      )
    `);
    // v2.5.36：回填存量授权记录的 module_code（旧版管理后台用了错误代码）
    // agent_company → harness, lingxi_site → sites, geo_hub → geo
    // 这样回填后与 AgentLayout 的 MODULE_GROUPS.moduleCode 一致，hasModuleGrant 可正确匹配
    const grantBackfill = await client.query(`
      UPDATE agent_module_grant
      SET module_code = CASE module_code
        WHEN 'agent_company' THEN 'harness'
        WHEN 'lingxi_site' THEN 'sites'
        WHEN 'geo_hub' THEN 'geo'
        ELSE module_code
      END
      WHERE module_code IN ('agent_company', 'lingxi_site', 'geo_hub')
      RETURNING id
    `);
    if (grantBackfill.rows.length > 0) {
      console.log(`[Migrate] 已回填 ${grantBackfill.rows.length} 条旧版 module_code 授权记录`);
    }

    // v2.5.35：代理心跳日志表
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_heartbeat (
        id BIGSERIAL PRIMARY KEY,
        agent_user_id BIGINT NOT NULL,
        heartbeat_at TIMESTAMP DEFAULT NOW(),
        client_version VARCHAR(20),
        ip INET,
        machine_id VARCHAR(64)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_heartbeat_user_time ON agent_heartbeat(agent_user_id, heartbeat_at DESC)`);

    // v2.5.35：代理设备绑定表（每个 license_key 默认 2 台设备）
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_device_binding (
        id BIGSERIAL PRIMARY KEY,
        agent_user_id BIGINT NOT NULL,
        machine_id VARCHAR(64) NOT NULL,
        machine_info JSONB,
        first_bind_at TIMESTAMP DEFAULT NOW(),
        last_heartbeat_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (agent_user_id, machine_id)
      )
    `);

    // v2.5.35：桌面端更新发布历史表
    await client.query(`
      CREATE TABLE IF NOT EXISTS desktop_update_release (
        id BIGSERIAL PRIMARY KEY,
        version VARCHAR(20) NOT NULL UNIQUE,
        changelog TEXT,
        release_type VARCHAR(20) DEFAULT 'optional',
        rollout_strategy VARCHAR(20) DEFAULT 'full',
        gray_agent_ids BIGINT[],
        oss_exe_url TEXT NOT NULL,
        oss_blockmap_url TEXT,
        latest_yml TEXT NOT NULL,
        published_by BIGINT NOT NULL,
        published_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'published',
        downloaded_count INT DEFAULT 0,
        installed_count INT DEFAULT 0
      )
    `);

    // v2.5.35 阶段三：代理客户端下载/安装记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS desktop_update_download (
        id BIGSERIAL PRIMARY KEY,
        release_id BIGINT NOT NULL REFERENCES desktop_update_release(id) ON DELETE CASCADE,
        agent_user_id BIGINT NOT NULL,
        machine_id VARCHAR(64),
        status VARCHAR(20) DEFAULT 'pending',
        downloaded_at TIMESTAMP,
        installed_at TIMESTAMP,
        client_version_before VARCHAR(20),
        client_version_after VARCHAR(20),
        error_msg TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (release_id, agent_user_id, machine_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_du_download_agent ON desktop_update_download(agent_user_id, created_at DESC)`);

    // v2.5.35 阶段五：SaaS 订阅相关表
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_subscription_plan (
        id BIGSERIAL PRIMARY KEY,
        plan_code VARCHAR(50) NOT NULL UNIQUE,
        module_code VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price_fen INT NOT NULL,
        period VARCHAR(20) DEFAULT 'monthly',
        features JSONB,
        status VARCHAR(20) DEFAULT 'active',
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_order (
        id BIGSERIAL PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL UNIQUE,
        agent_user_id BIGINT NOT NULL,
        plan_id BIGINT NOT NULL REFERENCES agent_subscription_plan(id),
        module_code VARCHAR(50) NOT NULL,
        amount_fen INT NOT NULL,
        period VARCHAR(20) DEFAULT 'monthly',
        status VARCHAR(20) DEFAULT 'pending',
        wechat_prepay_id VARCHAR(128),
        wechat_transaction_id VARCHAR(128),
        pay_qrcode_url TEXT,
        paid_at TIMESTAMP,
        expire_at TIMESTAMP,
        grant_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_order_agent ON agent_order(agent_user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_order_status ON agent_order(status, created_at DESC)`);

    // v2.5.35 阶段五：初始化默认订阅套餐
    const planCount = await client.query("SELECT COUNT(*) as count FROM agent_subscription_plan");
    if (parseInt(planCount.rows[0].count) === 0) {
      const defaultPlans = [
        { code: 'harness_monthly', module: 'harness', name: '智能体公司·月度', price: 9900, period: 'monthly', sort: 1 },
        { code: 'harness_yearly', module: 'harness', name: '智能体公司·年度', price: 99000, period: 'yearly', sort: 2 },
        { code: 'sites_monthly', module: 'sites', name: '灵犀站点引擎·月度', price: 14900, period: 'monthly', sort: 3 },
        { code: 'sites_yearly', module: 'sites', name: '灵犀站点引擎·年度', price: 149000, period: 'yearly', sort: 4 },
        { code: 'geo_monthly', module: 'geo', name: '聚量GEO中枢·月度', price: 19900, period: 'monthly', sort: 5 },
        { code: 'geo_yearly', module: 'geo', name: '聚量GEO中枢·年度', price: 199000, period: 'yearly', sort: 6 },
        { code: 'all_monthly', module: 'all', name: '全功能·月度', price: 39900, period: 'monthly', sort: 7 },
        { code: 'all_yearly', module: 'all', name: '全功能·年度', price: 399000, period: 'yearly', sort: 8 },
      ];
      for (const p of defaultPlans) {
        await client.query(
          `INSERT INTO agent_subscription_plan (plan_code, module_code, name, price_fen, period, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (plan_code) DO NOTHING`,
          [p.code, p.module, p.name, p.price, p.period, p.sort]
        );
      }
      console.log('[Migrate] 已初始化默认订阅套餐:', defaultPlans.length, '项');
    }

    // v2.5.35 阶段五：订阅解锁配置表（单行配置，管理员可改）
    // 试用天数 / 免费板块白名单 / 宽限期天数 / 到期立即锁定
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_subscription_config (
        id INT PRIMARY KEY DEFAULT 1,
        trial_days INT DEFAULT 0,
        free_modules TEXT[] DEFAULT '{}',
        grace_days INT DEFAULT 3,
        lock_on_expire BOOLEAN DEFAULT true,
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    // 确保单行存在
    const configCount = await client.query("SELECT COUNT(*) as count FROM agent_subscription_config");
    if (parseInt(configCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO agent_subscription_config (id, trial_days, free_modules, grace_days, lock_on_expire)
        VALUES (1, 0, '{}', 3, true)
      `);
      console.log('[Migrate] 已初始化订阅解锁配置');
    }

    // v2.5.35 阶段五：微信支付配置表（单行，加密存储私钥）
    // 不再使用环境变量，改为数据库存储，管理员可在桌面端配置
    await client.query(`
      CREATE TABLE IF NOT EXISTS wechat_pay_config (
        id INT PRIMARY KEY DEFAULT 1,
        appid VARCHAR(64),
        mchid VARCHAR(64),
        api_v3_key VARCHAR(128),
        serial_no VARCHAR(128),
        private_key TEXT,
        notify_url TEXT,
        enabled BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    const wechatCount = await client.query("SELECT COUNT(*) as count FROM wechat_pay_config");
    if (parseInt(wechatCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO wechat_pay_config (id, enabled) VALUES (1, false)
      `);
      console.log('[Migrate] 已初始化微信支付配置');
    }

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

    // 增量迁移：为 zlgjc 表添加 UNIQUE 约束 (userid, value, keyword_type)
    // 防止关键词重复入库导致分片数翻倍
    // 必须先删除重复记录（每组 userid+value+keyword_type 只保留 id 最小的一条），否则 ALTER 会失败
    try {
      await client.query(`
        DELETE FROM zlgjc
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY userid, value, keyword_type ORDER BY id ASC) as rn
            FROM zlgjc
          ) t WHERE rn > 1
        )
      `);
      console.log('[Migrate] zlgjc 表重复记录已清理');
    } catch (e: any) {
      console.log('[Migrate] zlgjc 去重跳过:', e.message);
    }
    try {
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_zlgjc_unique ON zlgjc(userid, value, keyword_type)`);
      console.log('[Migrate] zlgjc UNIQUE 约束已创建');
    } catch (e: any) {
      console.log('[Migrate] zlgjc UNIQUE 约束创建跳过:', e.message);
    }

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
    const adminCount = await client.query("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' OR level = '1'");
    if (parseInt(adminCount.rows[0].count) === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await client.query(
        "INSERT INTO users (username, password, level, role) VALUES ($1, $2, $3, 'super_admin')",
        [process.env.ADMIN_USERNAME || 'admin', hashedPassword, '1']
      );
      console.log('[Migrate] 已创建超级管理员账号:', process.env.ADMIN_USERNAME || 'admin');
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

    // v2.1.6：添加 queue_id 字段，精确关联记录与分片（解决时间窗口查询重叠问题）
    // 新记录会带上 queue_id，旧记录 queue_id 为 null（fallback 到时间窗口查询）
    await client.query(`ALTER TABLE real_collect_record ADD COLUMN IF NOT EXISTS queue_id BIGINT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rcr_queue_id ON real_collect_record(queue_id) WHERE queue_id IS NOT NULL`);

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

    // ============ 代理池表（Phase 2：借鉴 BrowserAct 代理系统设计） ============
    // 用于账号 IP 隔离：每个 platform_auth 账号可绑定一个 proxy_pool 记录
    // 支持动态/静态/自定义三种代理类型，对接快代理/芝麻代理等服务商
    await client.query(`
      CREATE TABLE IF NOT EXISTS proxy_pool (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        name VARCHAR(100) NOT NULL,
        provider VARCHAR(32) DEFAULT 'custom',
        proxy_type VARCHAR(16) DEFAULT 'static',
        region VARCHAR(32) DEFAULT '',
        endpoint VARCHAR(255) NOT NULL,
        username VARCHAR(128) DEFAULT '',
        password TEXT DEFAULT '',
        is_active BOOLEAN DEFAULT TRUE,
        last_check_at TIMESTAMP,
        last_check_ok BOOLEAN,
        last_check_latency INTEGER,
        total_used_count INTEGER DEFAULT 0,
        remark TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_user ON proxy_pool(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_active ON proxy_pool(is_active)`);

    // platform_auth 表新增 proxy_id 字段（关联 proxy_pool）
    // NULL = 不使用代理 / 数字 = 指定代理
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS proxy_id INTEGER REFERENCES proxy_pool(id)`);

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
    // 添加 last_keyword_index 字段（记录分片已处理到的关键词索引，重启后从断点续查，避免从头重复消费）
    await client.query(`ALTER TABLE real_collect_queue ADD COLUMN IF NOT EXISTS last_keyword_index INTEGER DEFAULT -1`);

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

    // ============ platform_auth 续期失败计数字段 ============
    // 续期失败不立即标记 expired，连续失败 N 次才标记，避免临时网络问题导致账号不可用
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS renewal_fail_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS last_renewal_attempt TIMESTAMP`);

    // ============ platform_auth 登录态失败计数字段 ============
    // 登录态失效不立即标记 offline，连续失败 N 次才标记，避免页面加载慢、SPA 路由未稳定、
    // 选择器不匹配等误判导致账号被错误标记为 offline（需人工恢复，影响可用性）
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS offline_fail_count INTEGER DEFAULT 0`);

    // 修复历史数据：将被误标记为 offline 但 storageState 仍可能有效的账号恢复为 active+normal
    // （之前的单次判定逻辑可能误判，这里恢复让账号重新尝试）
    const recoverOfflineResult = await client.query(
      `UPDATE platform_auth
       SET status = 'active', health_status = 'normal', offline_fail_count = 0,
           risk_detected_at = NULL, updated_at = NOW()
       WHERE status = 'expired' AND health_status = 'offline'
       RETURNING id, platform`
    );
    if (recoverOfflineResult.rows.length > 0) {
      console.log(`[Migrate] 恢复 ${recoverOfflineResult.rows.length} 个被误标记为 offline 的账号:`,
        recoverOfflineResult.rows.map((r: any) => `${r.platform}#${r.id}`).join(', '));
    }

    // 修复历史数据：将被续期器误标记为 expired 但 health_status 仍为 normal 的账号恢复为 active
    // （续期器单次失败就标记 expired 的旧逻辑已修复，这里恢复被误标的账号）
    const recoverResult = await client.query(
      `UPDATE platform_auth
       SET status = 'active', renewal_fail_count = 0
       WHERE status = 'expired' AND health_status = 'normal'
       RETURNING id, platform`
    );
    if (recoverResult.rows.length > 0) {
      console.log(`[Migrate] 恢复 ${recoverResult.rows.length} 个被续期器误标记为 expired 的账号:`,
        recoverResult.rows.map((r: any) => `${r.platform}#${r.id}`).join(', '));
    }

    // ============ real_collect_task 轮次号字段 ============
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS round_no INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS round_start_time TIMESTAMP`);
    // 前缀词屏蔽：存储 JSON 数组（如 ["公司","代办"]），查询时跳过以这些前缀开头的关键词
    // 仅对蒸馏词库（keyword_type=0）生效
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS exclude_prefixes TEXT DEFAULT NULL`);

    // 组合规则屏蔽（v2.0.7）：存储 JSON 数组（如 ["A+C+D","B+C+D+E"]），查询时跳过这些组合模式生成的关键词
    // 仅对蒸馏词库（keyword_type=0）生效
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS exclude_combos TEXT DEFAULT NULL`);

    // 查询模式：auto（默认，优先API降级爬虫）/ api（仅API）/ crawler（仅爬虫，可获取分享链接）
    // 用于按任务单独控制查询方式，在智能巡检页面的任务列表操作栏切换
    await client.query(`ALTER TABLE real_collect_task ADD COLUMN IF NOT EXISTS query_mode VARCHAR(20) DEFAULT 'auto'`);

    // ============ 一次性清理：删除 GEO 搜索详情中的脏数据 ============
    // 问题：baseAdapter 的 extractContent 兜底逻辑曾用 document.body.textContent 拿整页文本，
    // 导致营销页/导航内容被误识别为 brand_matched=true，生成错误的"查看详情"跳转链接。
    // 清理策略：
    //   1. raw_content 为空或过短（<30字符）的记录（明显无效）
    //   2. share_url 和 static_page_id 都为空的记录（无法跳转到有效详情页）
    // 用 migrations_cleanup_log 表记录已执行的清理，避免重复执行
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_cleanup_log (
        id SERIAL PRIMARY KEY,
        cleanup_name TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rows_affected INTEGER
      )
    `);

    // 检查是否已执行过该清理
    const cleanupCheck = await client.query(
      `SELECT 1 FROM migrations_cleanup_log WHERE cleanup_name = 'cleanup_invalid_real_collect_records_v1'`
    );
    if (cleanupCheck.rows.length === 0) {
      console.log('[Migrate] 执行一次性清理: 删除无效的 real_collect_record 记录...');

      // 先统计要删除的记录数
      const statsResult = await client.query(`
        SELECT
          COUNT(*) as total_to_delete,
          COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) < 30) as short_content,
          COUNT(*) FILTER (WHERE share_url IS NULL AND static_page_id IS NULL) as no_link
        FROM real_collect_record
        WHERE COALESCE(LENGTH(raw_content), 0) < 30
           OR (share_url IS NULL AND static_page_id IS NULL)
      `);
      const stats = statsResult.rows[0];
      console.log(`[Migrate] 清理统计: 总计删除 ${stats.total_to_delete} 条 (短内容: ${stats.short_content}, 无链接: ${stats.no_link})`);

      // 执行删除（CASCADE 会自动删除关联的 static_page）
      const deleteResult = await client.query(`
        DELETE FROM real_collect_record
        WHERE COALESCE(LENGTH(raw_content), 0) < 30
           OR (share_url IS NULL AND static_page_id IS NULL)
      `);
      const rowsAffected = deleteResult.rowCount || 0;
      console.log(`[Migrate] 清理完成: 实际删除 ${rowsAffected} 条记录`);

      // 记录清理已执行
      await client.query(
        `INSERT INTO migrations_cleanup_log (cleanup_name, rows_affected) VALUES ('cleanup_invalid_real_collect_records_v1', $1)`,
        [rowsAffected]
      );
    }

    // ============ 一次性清理 v2：更激进的脏数据清理 ============
    // v1 清理标准太窄，漏掉了 static_page_id 存在但内容是营销页的情况
    // v2 清理标准：
    //   1. raw_content < 200 字符（真实 AI 回答通常 200+ 字符）
    //   2. raw_content 同时包含"登录"和"注册"（营销/导航页面特征）
    //   3. raw_content 包含"开始对话"/"开始使用"/"免费体验"/"立即开通"（营销 CTA 按钮文案）
    //   4. raw_content 包含"全部对话"/"历史记录"/"清空对话"（侧边栏导航文案）
    const cleanupV2Check = await client.query(
      `SELECT 1 FROM migrations_cleanup_log WHERE cleanup_name = 'cleanup_invalid_real_collect_records_v2'`
    );
    if (cleanupV2Check.rows.length === 0) {
      console.log('[Migrate] 执行 v2 清理: 删除营销页/短内容的 real_collect_record 记录...');

      const statsV2 = await client.query(`
        SELECT
          COUNT(*) as total_to_delete,
          COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) < 200) as short_content,
          COUNT(*) FILTER (WHERE raw_content LIKE '%登录%' AND raw_content LIKE '%注册%') as marketing_nav,
          COUNT(*) FILTER (WHERE raw_content LIKE '%开始对话%' OR raw_content LIKE '%开始使用%' OR raw_content LIKE '%免费体验%' OR raw_content LIKE '%立即开通%') as marketing_cta,
          COUNT(*) FILTER (WHERE raw_content LIKE '%全部对话%' OR raw_content LIKE '%历史记录%' OR raw_content LIKE '%清空对话%') as sidebar_nav
        FROM real_collect_record
        WHERE COALESCE(LENGTH(raw_content), 0) < 200
           OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
           OR raw_content LIKE '%开始对话%'
           OR raw_content LIKE '%开始使用%'
           OR raw_content LIKE '%免费体验%'
           OR raw_content LIKE '%立即开通%'
           OR raw_content LIKE '%全部对话%'
           OR raw_content LIKE '%历史记录%'
           OR raw_content LIKE '%清空对话%'
      `);
      const stats = statsV2.rows[0];
      console.log(`[Migrate] v2 清理统计: 总计 ${stats.total_to_delete} 条 (短内容: ${stats.short_content}, 营销导航: ${stats.marketing_nav}, CTA: ${stats.marketing_cta}, 侧边栏: ${stats.sidebar_nav})`);

      const deleteV2 = await client.query(`
        DELETE FROM real_collect_record
        WHERE COALESCE(LENGTH(raw_content), 0) < 200
           OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
           OR raw_content LIKE '%开始对话%'
           OR raw_content LIKE '%开始使用%'
           OR raw_content LIKE '%免费体验%'
           OR raw_content LIKE '%立即开通%'
           OR raw_content LIKE '%全部对话%'
           OR raw_content LIKE '%历史记录%'
           OR raw_content LIKE '%清空对话%'
      `);
      const rowsV2 = deleteV2.rowCount || 0;
      console.log(`[Migrate] v2 清理完成: 实际删除 ${rowsV2} 条记录`);

      await client.query(
        `INSERT INTO migrations_cleanup_log (cleanup_name, rows_affected) VALUES ('cleanup_invalid_real_collect_records_v2', $1)`,
        [rowsV2]
      );
    }

    // ============ 内容中枢：7张新表 ============
    // 1. AI模型配置（user_id IS NULL 表示平台共享KEY）
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_model_config (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        platform VARCHAR(32) NOT NULL,
        model_name VARCHAR(64) NOT NULL,
        api_key_encrypted TEXT,
        base_url VARCHAR(255) NOT NULL,
        max_tokens INTEGER DEFAULT 4096,
        temperature NUMERIC(3,2) DEFAULT 0.7,
        is_active BOOLEAN DEFAULT true,
        daily_quota INTEGER,
        used_today INTEGER DEFAULT 0,
        quota_reset_at TIMESTAMP,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, platform)
      )
    `);

    // 2. 写作指令库
    await client.query(`
      CREATE TABLE IF NOT EXISTS writing_instruction (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(32),
        system_prompt TEXT NOT NULL,
        user_prompt_template TEXT NOT NULL,
        target_word_count INTEGER DEFAULT 1500,
        include_faq BOOLEAN DEFAULT true,
        include_comparison_table BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW()
      )
    `);

    // 3. 企业知识库
    await client.query(`
      CREATE TABLE IF NOT EXISTS enterprise_knowledge (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        company_full_name VARCHAR(128) NOT NULL,
        company_short_name VARCHAR(64),
        city VARCHAR(64),
        address VARCHAR(255),
        industry VARCHAR(64),
        founded_year INTEGER,
        business_scope TEXT,
        entity_triples JSONB,
        intro_text TEXT,
        cases_text TEXT,
        is_active BOOLEAN DEFAULT true,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW()
      )
    `);

    // 4. AI写作任务
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_writing_task (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        task_name VARCHAR(100),
        keyword_ids INTEGER[],
        instruction_id INTEGER REFERENCES writing_instruction(id),
        knowledge_id INTEGER REFERENCES enterprise_knowledge(id),
        model_config_id INTEGER REFERENCES ai_model_config(id),
        status VARCHAR(16) DEFAULT 'pending',
        total_count INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        error_msg TEXT,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        create_time TIMESTAMP DEFAULT NOW()
      )
    `);

    // 5. 文章
    await client.query(`
      CREATE TABLE IF NOT EXISTS article (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        task_id INTEGER REFERENCES ai_writing_task(id),
        keyword_id INTEGER,
        core_keyword VARCHAR(128) NOT NULL,
        keyword_type SMALLINT DEFAULT 0,
        title VARCHAR(255) NOT NULL,
        content_html TEXT NOT NULL,
        entity_triples JSONB,
        target_platform VARCHAR(32),
        word_count INTEGER,
        status VARCHAR(16) DEFAULT 'draft',
        cover_image_url TEXT,
        tags TEXT[],
        model_used VARCHAR(64),
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_article_user_keyword ON article(user_id, keyword_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_article_status ON article(status)`);

    // 6. 发布步骤列表（阶段2用，阶段1先建表）
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_step_list (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(32) NOT NULL,
        version VARCHAR(16) NOT NULL,
        step_list JSONB NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        create_time TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, version)
      )
    `);

    // 7. 发布任务+记录（阶段2用，阶段1先建表）
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_task (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        article_id INTEGER REFERENCES article(id) NOT NULL,
        target_platforms TEXT[] NOT NULL,
        scheduled_at TIMESTAMP,
        status VARCHAR(16) DEFAULT 'pending',
        total_count INTEGER DEFAULT 0,
        completed_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        finished_at TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_record (
        id SERIAL PRIMARY KEY,
        task_id INTEGER REFERENCES publish_task(id) NOT NULL,
        platform VARCHAR(32) NOT NULL,
        platform_auth_id INTEGER REFERENCES platform_auth(id),
        status VARCHAR(16) DEFAULT 'pending',
        article_id_on_platform VARCHAR(128),
        platform_url TEXT,
        error_msg TEXT,
        retry_count INTEGER DEFAULT 0,
        started_at TIMESTAMP,
        published_at TIMESTAMP,
        create_time TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_publish_record_task ON publish_record(task_id)`);

    // 8. platform_auth 新增 platform_type 字段
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS platform_type VARCHAR(16) DEFAULT 'query'`);

    // 8.1 企业知识库新增 5 个自由文本字段（产品服务/产品特点/用户痛点/信任背书/其他信息）
    await client.query(`ALTER TABLE enterprise_knowledge ADD COLUMN IF NOT EXISTS products_services TEXT`);
    await client.query(`ALTER TABLE enterprise_knowledge ADD COLUMN IF NOT EXISTS product_features TEXT`);
    await client.query(`ALTER TABLE enterprise_knowledge ADD COLUMN IF NOT EXISTS user_pain_points TEXT`);
    await client.query(`ALTER TABLE enterprise_knowledge ADD COLUMN IF NOT EXISTS trust_endorsement TEXT`);
    await client.query(`ALTER TABLE enterprise_knowledge ADD COLUMN IF NOT EXISTS other_info TEXT`);

    // 8.2 写作指令新增 创作方向(多选)/文案类型(多选)/随机模式 字段
    // category 字段语义升级：原为单选分层(认知层等)，现改为多选创作方向(品牌曝光/产品种草等)
    // content_types: JSON数组，存储文案类型（科普/测评/案例/问答/对比/资讯/教程）
    // random_mode: 是否随机组合方向×类型生成不同风格文章
    await client.query(`ALTER TABLE writing_instruction ADD COLUMN IF NOT EXISTS content_types JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE writing_instruction ADD COLUMN IF NOT EXISTS random_mode BOOLEAN DEFAULT FALSE`);

    // 8.2.1 写作指令字段重构：移除 system_prompt，新增 article_prompt + title_prompt
    // 设计变更：系统提示词不需要单独存储，专家系统/扣子工作流本身即为系统提示词
    // - article_prompt: 写文章的提示词（原 user_prompt_template）
    // - title_prompt: 写标题的提示词（新增）
    // 兼容策略：新增字段 + 数据迁移（user_prompt_template → article_prompt）+ 保留旧字段不删
    await client.query(`ALTER TABLE writing_instruction ADD COLUMN IF NOT EXISTS article_prompt TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE writing_instruction ADD COLUMN IF NOT EXISTS title_prompt TEXT DEFAULT ''`);
    // 数据迁移：将旧 user_prompt_template 的值复制到 article_prompt（仅 article_prompt 为空时）
    await client.query(`UPDATE writing_instruction SET article_prompt = user_prompt_template WHERE article_prompt = '' AND user_prompt_template IS NOT NULL AND user_prompt_template != ''`);
    // system_prompt/user_prompt_template 字段保留但不再使用（向后兼容，不删除）
    // 8.2.1 修复：repository INSERT 不再传 system_prompt/user_prompt_template，需去掉 NOT NULL 约束
    // 否则 CREATE TABLE 时的 NOT NULL 约束会导致 INSERT 失败
    await client.query(`ALTER TABLE writing_instruction ALTER COLUMN system_prompt DROP NOT NULL`);
    await client.query(`ALTER TABLE writing_instruction ALTER COLUMN user_prompt_template DROP NOT NULL`);

    // 8.2.2 写作任务表新增 generation_mode 字段（专家系统/扣子工作流双模式）
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS generation_mode VARCHAR(16) DEFAULT 'expert'`);

    // 8.3 云接口配置表（参考 jlyl.net.cn/agent/api_set）
    // 单行配置模式：每个 user_id 一行，存储固定字段（敏感字段加密）
    await client.query(`
      CREATE TABLE IF NOT EXISTS cloud_api_config (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE,
        aliyun_access_key TEXT DEFAULT '',
        aliyun_access_secret TEXT DEFAULT '',
        aliyun_oss_bucket TEXT DEFAULT '',
        aliyun_oss_cdn TEXT DEFAULT '',
        doubao_app_id TEXT DEFAULT '',
        coze_key TEXT DEFAULT '',
        coze_baowen_workflow_id TEXT DEFAULT '',
        coze_parse_workflow_id TEXT DEFAULT '',
        keyword_index_key TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // v1.5: 新增 OSS endpoint 字段（区域端点，如 oss-cn-hangzhou.aliyuncs.com）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS aliyun_oss_endpoint TEXT DEFAULT ''`);

    // v2.0.0: AEO闭环配额字段（客户投放量控制 + 竞品开关）
    // weekly_article_quota: 每周自动创建写作任务数（0=不自动创建，仅生成周报建议）[已废弃，保留兼容]
    // monthly_article_quota: 每月自动创建写作任务数（0=不自动创建）[已废弃，保留兼容]
    // v2.0.2: 合并为 article_quota + quota_cycle，避免双配额冲突
    // article_quota: 自动创建写作任务数（0=不自动创建）
    // quota_cycle: 配额周期 'weekly' | 'monthly'，决定何时触发自动写作
    // auto_publish_enabled: 写作完成后是否自动创建发布任务
    // aeo_report_start_date: AEO报告周期起始日（默认为客户创建日，按此日计算周/月周期）
    // enable_competitor_geo: 竞品反向GEO开关（仅高价值客户开启）
    // competitor_brands: 关注的竞品品牌列表（JSON数组）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS weekly_article_quota INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS monthly_article_quota INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_publish_enabled BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS aeo_report_start_date DATE`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS enable_competitor_geo BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS competitor_brands JSONB`);
    // v2.0.2: 统一配额字段（替代 weekly/monthly 双配额）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS article_quota INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS quota_cycle VARCHAR(10) DEFAULT 'weekly'`);
    // v2.1.3: 重点优化关键词（用户手动设置，驱动自动写作任务的主题方向）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS focus_keywords JSONB`);
    // v2.2.17: 自动写作任务详细配置（让自动写作和手动写作的8步配置对齐）
    // 留空(null)/默认值(-1)时自动取客户第一个 active 值（向后兼容）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_instruction_id INTEGER`);         // 指定自动写作使用的指令ID（null=取客户第一个active指令）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_knowledge_id INTEGER`);           // 指定自动写作使用的知识库ID（null=取客户第一个active知识库）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_agent_profile_id INTEGER`);       // 指定自动写作使用的专家角色ID（null=取客户第一个active专家）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_cover_image_mode VARCHAR(20) DEFAULT 'auto'`); // 封面图模式：auto/none/random（auto=按客户图库自动决定，v2.2.18 移除 fixed）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_illustration_count INTEGER DEFAULT -1`); // 插画数量：-1=按客户图库自动决定，>=0=固定数量
    // v2.2.18: 补齐生成方式/目标平台 2 个配置项（让自动写作与手动写作步骤对齐）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_generation_mode VARCHAR(20) DEFAULT 'expert'`); // 生成方式：expert/coze（默认 expert，coze 暂未实现）
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS auto_target_platforms JSONB`);          // 指定自动写作的目标平台白名单（null=由AEO信源权重自动分配，[]=空数组等价于null）

    // v2.3.0：写作建议池来源周期类型（daily/weekly/monthly）
    // 用于飞轮总览页面"写作建议池来源"链接开关，决定从哪个周期报告池消费建议
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS suggestion_source_period_type VARCHAR(20) DEFAULT 'daily'`);

    // v2.3.5：补齐 daily_article_quota 字段（v2.3.0 引入但 migrate 漏加，导致 PUT /content/aeo-quota 500 错误）
    //   原 bug：repository.ts AEO_QUOTA_FIELDS 数组里包含 'daily_article_quota'，
    //     upsertAeoQuotaConfig 也会写入该字段，但 migrate.ts 没有对应的 ALTER TABLE 语句，
    //     数据库表中不存在该字段，UPDATE 时 PostgreSQL 报 column does not exist 错误，
    //     路由 catch 后返回 500，前端"自动化写作配置"保存失败
    await client.query(`ALTER TABLE cloud_api_config ADD COLUMN IF NOT EXISTS daily_article_quota INTEGER DEFAULT 0`);

    // v2.2.18：修复 publish_task / publish_record 外键缺失 ON DELETE CASCADE 导致的 500 错误
    // 原 bug：publish_task.article_id REFERENCES article(id) 和 publish_record.task_id REFERENCES publish_task(id)
    //   都没有 CASCADE，删除 article 时若存在关联 publish_task 会触发外键约束错误
    // 修复：DROP 旧约束 + ADD 带 ON DELETE CASCADE 的新约束
    // v2.2.18 hotfix：改用 JavaScript try-catch 包裹（原 DO $$ 块在某些环境失败导致 migrate 卡住，server 502）
    try {
      // 检查 publish_task.article_id 外键是否缺少 CASCADE
      const ptFk = await client.query(
        `SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
         WHERE conname = 'publish_task_article_id_fkey' AND contype = 'f'`
      );
      if (ptFk.rows.length > 0 && !String(ptFk.rows[0].def).toLowerCase().includes('on delete cascade')) {
        await client.query('ALTER TABLE publish_task DROP CONSTRAINT publish_task_article_id_fkey');
        await client.query('ALTER TABLE publish_task ADD CONSTRAINT publish_task_article_id_fkey FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE');
        console.log('[Migrate] publish_task.article_id 外键已改为 ON DELETE CASCADE');
      }
      // 检查 publish_record.task_id 外键是否缺少 CASCADE
      const prFk = await client.query(
        `SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
         WHERE conname = 'publish_record_task_id_fkey' AND contype = 'f'`
      );
      if (prFk.rows.length > 0 && !String(prFk.rows[0].def).toLowerCase().includes('on delete cascade')) {
        await client.query('ALTER TABLE publish_record DROP CONSTRAINT publish_record_task_id_fkey');
        await client.query('ALTER TABLE publish_record ADD CONSTRAINT publish_record_task_id_fkey FOREIGN KEY (task_id) REFERENCES publish_task(id) ON DELETE CASCADE');
        console.log('[Migrate] publish_record.task_id 外键已改为 ON DELETE CASCADE');
      }
    } catch (e: any) {
      console.warn('[Migrate] 修复 publish 外键 CASCADE 失败（不阻断 migrate）:', e.message);
    }

    // v2.0.0: ai_writing_task 表新增 AEO 驱动字段
    // aeo_context: AEO综合建议池（周/月报汇总后注入，直接驱动写作方向）
    // auto_publish: 写作完成后自动创建发布任务（覆盖客户级 auto_publish_enabled）
    // auto_generated: 标记由 AEO 闭环自动生成的写作任务（区别于手动创建）
    // trigger_period_report_id: 关联的周/月报ID（追溯触发来源）
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS aeo_context JSONB`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS auto_publish BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS trigger_period_report_id BIGINT`);

    // v2.0.0: aeo_full_report 表增强字段
    // competitor_analysis: 竞品收录情况分析（JSON）
    // inclusion_rate_summary: 整体收录率汇总（JSON）
    // strategy_suggestions: 下一轮策略建议（JSON）
    await client.query(`ALTER TABLE aeo_full_report ADD COLUMN IF NOT EXISTS competitor_analysis JSONB`);
    await client.query(`ALTER TABLE aeo_full_report ADD COLUMN IF NOT EXISTS inclusion_rate_summary JSONB`);
    await client.query(`ALTER TABLE aeo_full_report ADD COLUMN IF NOT EXISTS strategy_suggestions JSONB`);

    console.log('[Migrate] v2.0.0 AEO闭环配额字段创建完成（cloud_api_config + ai_writing_task + aeo_full_report）');

    // 8.4 智能体角色同步表（agent_profile）
    // 用于内容中枢写作任务复用 AGENT 人事部中配置的专家智能体
    // 桌面端在保存角色时同步 systemPrompt + 启用的技能内容到云端
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_profile (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        role_id VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        department_id VARCHAR(64) DEFAULT '',
        department_name VARCHAR(100) DEFAULT '',
        system_prompt TEXT DEFAULT '',
        skills_content TEXT DEFAULT '',
        skills_count INTEGER DEFAULT 0,
        provider VARCHAR(32) DEFAULT '',
        model_name VARCHAR(100) DEFAULT '',
        is_active BOOLEAN DEFAULT TRUE,
        last_sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, role_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_profile_user ON agent_profile(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_profile_role ON agent_profile(role_id)`);

    // 8.5 写作任务表新增 agent_profile_id 字段（关联专家智能体）
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS agent_profile_id INTEGER REFERENCES agent_profile(id)`);

    // 8.6 ai_model_config 新增 use_for_collect 字段（v1.4：巡检 Worker 用 API 替代爬虫）
    // true = 该平台模型同时用于智能巡检（worker 优先调用 API，失败降级爬虫）
    await client.query(`ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS use_for_collect BOOLEAN DEFAULT FALSE`);

    // 8.6.1 ai_model_config 新增 web_search 字段（v1.4：联网搜索开关）
    // true = 调用大模型时启用联网搜索（智谱 tools.web_search / 通义 enable_search / Kimi builtin_function）
    await client.query(`ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS web_search BOOLEAN DEFAULT FALSE`);

    // 8.6.2 ai_model_config 新增 use_for_writing 字段（v1.8.2：写作专用开关）
    // 之前前端"用于写作"开关错误映射到 is_active，导致 getDefaultModelConfig 无法区分用途
    // 现在拆分：is_active 仅表示配置启用，use_for_writing 才表示用于写作任务
    // DEFAULT true 向后兼容：现有 is_active=true 的记录默认可用于写作（避免迁移后写作任务无模型可用）
    await client.query(`ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS use_for_writing BOOLEAN DEFAULT TRUE`);

    // 8.6.3 ai_model_config 新增 use_for_publish 字段（v1.8.2：发布专用开关）
    // 用户需求：某些模型（如 glm-4v-flash 视觉模型）仅用于发布流程兜底，不参与写作
    // 发布流程（桌面端 publishWorker 的 aiActionExecutor 截图识别）按此字段取模型
    await client.query(`ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS use_for_publish BOOLEAN DEFAULT FALSE`);

    // 8.6.4 ai_model_config 新增 use_for_aeo 字段（v2.0.5：AEO 分析专用开关）
    // 用户需求：AEO 分析不再读环境变量 LLM_API_KEY，改为读 ai_model_config 表
    // 用户在 AI 模型配置页开启"用于 AEO 分析"开关的平台会被用于 AEO 日报/轮次报告/分片报告/周期报告
    // 多个平台开启时取第一个（按 id 排序）
    await client.query(`ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS use_for_aeo BOOLEAN DEFAULT FALSE`);

    // 8.7 real_collect_record 新增 source 字段（标记查询来源：api / crawler）
    await client.query(`ALTER TABLE real_collect_record ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'crawler'`);

    // 9. 插入7个平台的默认共享模型配置（user_id IS NULL）
    const defaultModels = [
      { platform: 'deepseek', model_name: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1/chat/completions' },
      { platform: 'doubao', model_name: 'doubao-pro-32k', base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
      { platform: 'hunyuan', model_name: 'hunyuan-pro', base_url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions' },
      { platform: 'qianwen', model_name: 'qwen-max', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
      { platform: 'wenxin', model_name: 'ernie-bot-pro', base_url: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions' },
      { platform: 'kimi', model_name: 'moonshot-v1-32k', base_url: 'https://api.moonshot.cn/v1/chat/completions' },
      { platform: 'zhipu', model_name: 'glm-4', base_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
    ];
    for (const m of defaultModels) {
      await client.query(`
        INSERT INTO ai_model_config (user_id, platform, model_name, base_url, daily_quota, used_today)
        VALUES (NULL, $1, $2, $3, 50, 0)
        ON CONFLICT (user_id, platform) DO NOTHING
      `, [m.platform, m.model_name, m.base_url]);
    }

    console.log('[Migrate] 内容中枢相关表创建/验证完成');

    // ============ v1.4: pgvector 向量检索 + 飞轮反馈闭环 ============

    // 启用 pgvector 扩展（需要 pgvector/pgvector:pg15 镜像）
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // ai_model_config 新增 use_for_embedding 字段（标记模型是否用于生成 embedding）
    await client.query('ALTER TABLE ai_model_config ADD COLUMN IF NOT EXISTS use_for_embedding BOOLEAN DEFAULT false');

    // 文章 embedding 表（存储文章标题+摘要的向量表示，用于 RAG 检索）
    await client.query(`
      CREATE TABLE IF NOT EXISTS article_embedding (
        id SERIAL PRIMARY KEY,
        article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
        knowledge_id INTEGER,
        content_text TEXT NOT NULL,
        embedding vector(1024),
        model_name VARCHAR(64),
        create_time TIMESTAMP DEFAULT NOW(),
        UNIQUE(article_id)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_article_embedding_knowledge ON article_embedding(knowledge_id)');
    // ivfflat 索引加速向量检索（余弦距离）
    // lists=10：初期数据量小，10 足够（pgvector 推荐 lists = rows/1000，最少 10）
    // 大 lists 会触发 IvfflatCheckMemoryUsage 错误（maintenance_work_mem 不足）
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_article_embedding_vector
      ON article_embedding USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 10)
    `);

    // 文章效果追踪表（L3 效果记忆层，关联 AEO 分析和关键词排名）
    await client.query(`
      CREATE TABLE IF NOT EXISTS article_performance (
        id SERIAL PRIMARY KEY,
        article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
        knowledge_id INTEGER,
        keyword_rank_id BIGINT,
        aeo_report_id BIGINT,
        aeo_score NUMERIC(5,2),
        brand_mentioned BOOLEAN DEFAULT false,
        share_url TEXT,
        performance_label VARCHAR(16) DEFAULT 'neutral',
        direction VARCHAR(32),
        content_type VARCHAR(32),
        analyzed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(article_id, keyword_rank_id)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_article_perf_knowledge ON article_performance(knowledge_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_article_perf_label ON article_performance(knowledge_id, performance_label)');

    // 创作策略表（L3 策略记忆层，飞轮每轮结束后自动生成）
    await client.query(`
      CREATE TABLE IF NOT EXISTS writing_strategy (
        id SERIAL PRIMARY KEY,
        knowledge_id INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        evidence TEXT,
        round_no INTEGER,
        good_count INTEGER DEFAULT 0,
        poor_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        create_time TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_writing_strategy_knowledge ON writing_strategy(knowledge_id, is_active, create_time DESC)');

    console.log('[Migrate] v1.4 pgvector + 飞轮反馈表创建/验证完成');

    // ============ v1.5: 企业图库（封面图 + 插画） ============

    // 企业图库表：与 enterprise_knowledge 一对多关联，支持客户专属图库
    // image_type: 'cover' 封面图 / 'illustration' 插画
    await client.query(`
      CREATE TABLE IF NOT EXISTS image_library (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        knowledge_id INTEGER REFERENCES enterprise_knowledge(id) ON DELETE CASCADE,
        image_type VARCHAR(16) NOT NULL,
        url TEXT NOT NULL,
        file_path TEXT,
        original_name VARCHAR(255),
        file_size INTEGER,
        mime_type VARCHAR(64),
        width INTEGER,
        height INTEGER,
        description TEXT,
        tags TEXT[],
        sort_order INTEGER DEFAULT 0,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_image_library_user ON image_library(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_image_library_knowledge ON image_library(knowledge_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_image_library_type ON image_library(knowledge_id, image_type)');

    // ai_writing_task 新增图库配置字段
    // cover_image_mode: 'random' 随机选 / 'fixed' 指定一张 / 'none' 不用图库
    // cover_image_id: 指定封面图 ID（cover_image_mode=fixed 时使用）
    // illustration_count: 插图数量（0=不插图，从插画图库随机取 N 张）
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS cover_image_mode VARCHAR(16) DEFAULT 'none'`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS cover_image_id INTEGER REFERENCES image_library(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS illustration_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS agent_profile_id INTEGER`);

    console.log('[Migrate] v1.5 企业图库表创建/验证完成');

    // ============ v1.8.0: 平台专属写作引擎 ============

    // platform_content_rule: 平台内容约束规则表
    // 存储每个平台（dy/xhs/zh/...）的字数限制 + 风格提示词，供写作任务构造 AI prompt 用
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_content_rule (
        platform VARCHAR(32) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        title_min_length INT DEFAULT 1,
        title_max_length INT DEFAULT 100,
        content_min_length INT DEFAULT 100,
        content_max_length INT DEFAULT 50000,
        style_prompt TEXT,
        require_tags BOOLEAN DEFAULT FALSE,
        tags_min_count INT DEFAULT 0,
        tags_max_count INT DEFAULT 5,
        cover_image_required BOOLEAN DEFAULT FALSE,
        cover_image_mode VARCHAR(20) DEFAULT 'none',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW()
      )
    `);

    // 12 平台种子数据（仅首次插入，不覆盖用户自定义配置）
    // 字数限制参考各平台官方文档；style_prompt 注入 AI prompt 控制风格
    // 注意：用 ON CONFLICT DO NOTHING，避免每次部署覆盖用户修改的规则
    const platformRules = [
      { platform: 'dy', name: '抖音', title_min: 1, title_max: 20, content_min: 100, content_max: 1000, style: '口语化、接地气、强情绪表达、适合短视频文案风格、多用短句、节奏感强', require_tags: true, tags_min: 1, tags_max: 5, cover: 'single', sort: 1 },
      { platform: 'xhs', name: '小红书', title_min: 1, title_max: 20, content_min: 100, content_max: 1000, style: 'emoji表情丰富、口语化种草风、多用感叹号、适合图文笔记、标题要吸睛、分段清晰', require_tags: true, tags_min: 1, tags_max: 10, cover: 'single', sort: 2 },
      { platform: 'zh', name: '知乎', title_min: 1, title_max: 100, content_min: 300, content_max: 50000, style: '专业深度、逻辑严谨、引用规范、适合长文论述、可使用小标题分层、避免口水话', require_tags: false, tags_min: 0, tags_max: 5, cover: 'none', sort: 3 },
      { platform: 'bjh', name: '百家号', title_min: 1, title_max: 30, content_min: 300, content_max: 20000, style: '信息流风格、标题党但不过度、干货为主、适合移动端阅读、段落简短', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 4 },
      { platform: 'qeh', name: '企鹅号', title_min: 5, title_max: 64, content_min: 300, content_max: 20000, style: '媒体风格、客观报道、适合新闻资讯、标题规范、正文结构清晰', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 5 },
      { platform: 'tt', name: '今日头条', title_min: 2, title_max: 30, content_min: 300, content_max: 20000, style: '资讯风格、简洁明了、适合移动端、标题吸引点击、正文分段清晰', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 6 },
      { platform: 'wy', name: '网易号', title_min: 1, title_max: 30, content_min: 300, content_max: 20000, style: '媒体风格、深度报道、适合新闻评论、标题客观', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 7 },
      { platform: 'sohu', name: '搜狐号', title_min: 1, title_max: 30, content_min: 300, content_max: 20000, style: '媒体风格、广度覆盖、适合资讯聚合、标题规范', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 8 },
      { platform: 'wxgzh', name: '微信公众号', title_min: 1, title_max: 64, content_min: 300, content_max: 20000, style: '深度文章、品牌调性、适合长文阅读、可使用排版样式、标题有内涵', require_tags: false, tags_min: 0, tags_max: 0, cover: 'none', sort: 9 },
      { platform: 'bili', name: 'B站', title_min: 1, title_max: 80, content_min: 200, content_max: 20000, style: 'ACG风格、年轻化表达、适合社区互动、标题可玩梗', require_tags: false, tags_min: 0, tags_max: 5, cover: 'none', sort: 10 },
      { platform: 'csdn', name: 'CSDN', title_min: 1, title_max: 100, content_min: 500, content_max: 50000, style: '技术文章、代码示例、专业严谨、适合程序员读者、可使用markdown代码块', require_tags: true, tags_min: 1, tags_max: 5, cover: 'none', sort: 11 },
      { platform: 'js', name: '简书', title_min: 1, title_max: 50, content_min: 200, content_max: 50000, style: '随笔风格、个人化表达、适合文学创作、标题文艺', require_tags: false, tags_min: 0, tags_max: 5, cover: 'none', sort: 12 },
    ];
    for (const r of platformRules) {
      await client.query(
        `INSERT INTO platform_content_rule
          (platform, name, title_min_length, title_max_length, content_min_length, content_max_length,
           style_prompt, require_tags, tags_min_count, tags_max_count, cover_image_required, cover_image_mode, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, $13)
         ON CONFLICT (platform) DO NOTHING`,
        [
          r.platform, r.name, r.title_min, r.title_max, r.content_min, r.content_max,
          r.style, r.require_tags, r.tags_min, r.tags_max,
          r.cover !== 'none', r.cover, r.sort,
        ]
      );
    }

    // ai_writing_task 新增 target_platforms 字段：存储目标平台数组，如 ["dy","xhs","zh"]
    // 旧任务该字段为 NULL，向后兼容（按通用流程生成单篇通用文章）
    await client.query(`ALTER TABLE ai_writing_task ADD COLUMN IF NOT EXISTS target_platforms JSONB`);

    // article 表新增 target_platform 字段：v1.4 预留未启用，v1.8.0 正式启用
    // 必须先 ADD COLUMN 再创建索引，否则索引创建会因列不存在而失败
    await client.query(`ALTER TABLE article ADD COLUMN IF NOT EXISTS target_platform VARCHAR(32)`);

    // article 表新增索引：按 (task_id, target_platform) 查询文章（按任务+平台筛选）
    await client.query(`CREATE INDEX IF NOT EXISTS idx_article_task_platform ON article(task_id, target_platform)`);

    console.log('[Migrate] v1.8.0 平台专属写作引擎表/字段/索引创建完成（platform_content_rule + ai_writing_task.target_platforms + idx_article_task_platform）');

    // v1.8.4：publish_task 表新增 batch_id 字段（UUID，标识一次「新建发布任务」动作）
    // 同一 batch_id 下的所有 publish_task 是一个"任务记录"（一次创建动作）
    // 用于一级聚合视图，避免按 writing_task_id 聚合时多次创建被合并
    await client.query(`ALTER TABLE publish_task ADD COLUMN IF NOT EXISTS batch_id UUID`);

    // v2.0.9：publish_task 表新增 auto_generated 字段，区分飞轮自动触发 vs 用户手动创建
    await client.query(`ALTER TABLE publish_task ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT false`);

    // v2.0.9：新增 flywheel_event_log 表，持久化飞轮守护进程事件日志
    // 解决桌面端主进程重启后内存日志丢失的问题，支持云端查询历史
    await client.query(`
      CREATE TABLE IF NOT EXISTS flywheel_event_log (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT,
        event_type VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flywheel_event_log_user_id ON flywheel_event_log(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flywheel_event_log_created_at ON flywheel_event_log(created_at DESC)`);

    // v1.8.4 修复：重置并按 (user_id, article.task_id, 创建时间分钟) 聚合回填
    // 同一写作任务、同一分钟内创建的 publish_task 视为同一次批量创建动作
    // 注意：这里强制重置所有 batch_id（包括之前回填的独立 UUID），统一按规则聚合
    // 新任务由 batch-publish 路由写入真实 batch_id，但因为同一次创建的 create_time 几乎相同，
    // 按分钟聚合后仍然会归到同一 batch_id，所以重置不会破坏新任务的聚合关系
    await client.query(`
      WITH grouped AS (
        SELECT
          pt.id,
          pt.user_id,
          a.task_id,
          date_trunc('minute', pt.create_time) as create_minute
        FROM publish_task pt
        JOIN article a ON a.id = pt.article_id
      ),
      batch_assign AS (
        SELECT
          id,
          md5(
            COALESCE(user_id::text, '') || '|' ||
            COALESCE(task_id::text, 'null') || '|' ||
            COALESCE(to_char(create_minute, 'YYYY-MM-DD HH24:MI:SS'), '')
          ) as batch_hash
        FROM grouped
      )
      UPDATE publish_task pt
      SET batch_id = (
        SELECT (substring(b.batch_hash from 1 for 8) ||
                '-' || substring(b.batch_hash from 9 for 4) ||
                '-' || substring(b.batch_hash from 13 for 4) ||
                '-' || substring(b.batch_hash from 17 for 4) ||
                '-' || substring(b.batch_hash from 21 for 12))::uuid
        FROM batch_assign b
        WHERE b.id = pt.id
      )
    `);

    // 仍为 NULL 的（无 article 关联等异常情况）回填独立 UUID
    await client.query(`UPDATE publish_task SET batch_id = gen_random_uuid() WHERE batch_id IS NULL`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_publish_task_batch ON publish_task(batch_id)`);

    console.log('[Migrate] v1.8.4 publish_task.batch_id 字段添加完成（按写作任务+分钟聚合回填）');

    // v1.9.0：发布账号池智能调度系统
    // 1. platform_auth 新增发布专用日限额/已用/模式/失败统计字段
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_daily_limit INTEGER DEFAULT 50`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_used_today INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_last_used_date DATE`);
    // publish=不通知粉丝, mass=群发
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_mode VARCHAR(16) DEFAULT 'publish'`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_fail_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE platform_auth ADD COLUMN IF NOT EXISTS publish_last_fail_at TIMESTAMP`);

    // 2. publish_record 增加账号分配来源标记（用于失败换号重试审计）
    // auto/manual/retry
    await client.query(`ALTER TABLE publish_record ADD COLUMN IF NOT EXISTS assigned_from VARCHAR(16) DEFAULT 'auto'`);

    // 3. 发布账号每日统计表
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_account_stats (
        id SERIAL PRIMARY KEY,
        platform_auth_id INTEGER REFERENCES platform_auth(id) NOT NULL,
        platform VARCHAR(32) NOT NULL,
        publish_date DATE NOT NULL,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        draft_count INTEGER DEFAULT 0,
        UNIQUE(platform_auth_id, publish_date)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_publish_account_stats_auth_date ON publish_account_stats(platform_auth_id, publish_date)`);

    console.log('[Migrate] v1.9.0 发布账号池智能调度字段/表创建完成');

    // ============ v2.0.0: AI平台流量权重层（AEO闭环基础） ============

    // ai_platform_weight: AI平台流量权重表（查询平台，如 kimi/wenxin/zhipu 等）
    // 用于指导内容投放的平台侧重：高用户量AI平台的信源平台应多投放
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_platform_weight (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(50) NOT NULL UNIQUE,
        display_name VARCHAR(100),
        user_volume_level INTEGER DEFAULT 3,
        traffic_weight DECIMAL(3,2) DEFAULT 1.0,
        is_enabled BOOLEAN DEFAULT true,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ai_platform_source_mapping: AI平台 → 信源自媒体平台映射
    // 描述每个AI平台主要从哪些自媒体平台获取内容，用于计算各自媒体平台的综合投放权重
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_platform_source_mapping (
        id SERIAL PRIMARY KEY,
        ai_platform VARCHAR(50) NOT NULL,
        source_platform VARCHAR(50) NOT NULL,
        source_weight DECIMAL(3,2) DEFAULT 1.0,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ai_platform, source_platform)
      )
    `);

    // AI平台流量权重默认数据（用户可在后台调整）
    const aiPlatformWeights = [
      { platform: 'kimi',     display_name: 'Kimi',      user_volume_level: 5, traffic_weight: 2.0 },
      { platform: 'wenxin',   display_name: '文心一言',   user_volume_level: 5, traffic_weight: 2.0 },
      { platform: 'doubao',   display_name: '豆包',      user_volume_level: 5, traffic_weight: 2.0 },
      { platform: 'zhipu',    display_name: '智谱清言',   user_volume_level: 4, traffic_weight: 1.5 },
      { platform: 'qwen',     display_name: '通义千问',   user_volume_level: 4, traffic_weight: 1.5 },
      { platform: 'deepseek', display_name: 'DeepSeek',  user_volume_level: 4, traffic_weight: 1.5 },
      { platform: 'hunyuan',  display_name: '腾讯混元',   user_volume_level: 3, traffic_weight: 1.0 },
      { platform: 'spark',    display_name: '讯飞星火',   user_volume_level: 3, traffic_weight: 1.0 },
    ];
    for (const p of aiPlatformWeights) {
      await client.query(
        `INSERT INTO ai_platform_weight (platform, display_name, user_volume_level, traffic_weight, is_enabled)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (platform) DO NOTHING`,
        [p.platform, p.display_name, p.user_volume_level, p.traffic_weight]
      );
    }

    // AI平台 → 信源自媒体平台映射默认数据（用户可在后台调整）
    // 基于一般经验：文心一言→百度系权重高，Kimi→微信公众号/知乎权重高，豆包→头条/抖音系权重高
    const sourceMappings: Array<{ ai: string; source: string; weight: number }> = [
      // 文心一言：百度系权重高
      { ai: 'wenxin', source: 'bjh',   weight: 2.0 },
      { ai: 'wenxin', source: 'zh',    weight: 1.5 },
      { ai: 'wenxin', source: 'xhs',   weight: 1.0 },
      { ai: 'wenxin', source: 'wxgzh', weight: 1.5 },
      { ai: 'wenxin', source: 'tt',    weight: 1.0 },
      { ai: 'wenxin', source: 'sohu',  weight: 0.8 },
      { ai: 'wenxin', source: 'qeh',   weight: 0.8 },
      { ai: 'wenxin', source: 'wy',    weight: 0.8 },
      { ai: 'wenxin', source: 'csdn',  weight: 1.0 },
      { ai: 'wenxin', source: 'js',    weight: 0.5 },
      { ai: 'wenxin', source: 'bili',  weight: 1.0 },
      { ai: 'wenxin', source: 'dy',    weight: 1.0 },
      // Kimi：微信公众号、知乎权重高
      { ai: 'kimi', source: 'wxgzh', weight: 2.0 },
      { ai: 'kimi', source: 'zh',    weight: 1.8 },
      { ai: 'kimi', source: 'xhs',   weight: 1.5 },
      { ai: 'kimi', source: 'bjh',   weight: 1.5 },
      { ai: 'kimi', source: 'csdn',  weight: 1.2 },
      { ai: 'kimi', source: 'tt',    weight: 1.0 },
      { ai: 'kimi', source: 'sohu',  weight: 0.8 },
      { ai: 'kimi', source: 'qeh',   weight: 0.8 },
      { ai: 'kimi', source: 'wy',    weight: 0.8 },
      { ai: 'kimi', source: 'js',    weight: 0.5 },
      { ai: 'kimi', source: 'bili',  weight: 1.0 },
      { ai: 'kimi', source: 'dy',    weight: 1.0 },
      // 豆包：今日头条、抖音系权重高
      { ai: 'doubao', source: 'tt',    weight: 2.0 },
      { ai: 'doubao', source: 'dy',    weight: 1.8 },
      { ai: 'doubao', source: 'xhs',   weight: 1.5 },
      { ai: 'doubao', source: 'wxgzh', weight: 1.5 },
      { ai: 'doubao', source: 'zh',    weight: 1.3 },
      { ai: 'doubao', source: 'bjh',   weight: 1.2 },
      { ai: 'doubao', source: 'csdn',  weight: 1.0 },
      { ai: 'doubao', source: 'sohu',  weight: 0.8 },
      { ai: 'doubao', source: 'qeh',   weight: 0.8 },
      { ai: 'doubao', source: 'wy',    weight: 0.8 },
      { ai: 'doubao', source: 'js',    weight: 0.5 },
      { ai: 'doubao', source: 'bili',  weight: 1.0 },
      // 智谱清言：较均衡，知乎/微信公众号稍高
      { ai: 'zhipu', source: 'zh',    weight: 1.5 },
      { ai: 'zhipu', source: 'wxgzh', weight: 1.5 },
      { ai: 'zhipu', source: 'bjh',   weight: 1.2 },
      { ai: 'zhipu', source: 'xhs',   weight: 1.2 },
      { ai: 'zhipu', source: 'tt',    weight: 1.0 },
      { ai: 'zhipu', source: 'csdn',  weight: 1.0 },
      { ai: 'zhipu', source: 'sohu',  weight: 0.8 },
      { ai: 'zhipu', source: 'qeh',   weight: 0.8 },
      { ai: 'zhipu', source: 'wy',    weight: 0.8 },
      { ai: 'zhipu', source: 'js',    weight: 0.5 },
      { ai: 'zhipu', source: 'bili',  weight: 1.0 },
      { ai: 'zhipu', source: 'dy',    weight: 1.0 },
      // 通义千问：较均衡
      { ai: 'qwen', source: 'zh',    weight: 1.3 },
      { ai: 'qwen', source: 'wxgzh', weight: 1.3 },
      { ai: 'qwen', source: 'bjh',   weight: 1.2 },
      { ai: 'qwen', source: 'xhs',   weight: 1.2 },
      { ai: 'qwen', source: 'tt',    weight: 1.2 },
      { ai: 'qwen', source: 'csdn',  weight: 1.0 },
      { ai: 'qwen', source: 'sohu',  weight: 0.8 },
      { ai: 'qwen', source: 'qeh',   weight: 0.8 },
      { ai: 'qwen', source: 'wy',    weight: 0.8 },
      { ai: 'qwen', source: 'js',    weight: 0.5 },
      { ai: 'qwen', source: 'bili',  weight: 1.0 },
      { ai: 'qwen', source: 'dy',    weight: 1.0 },
      // DeepSeek：较均衡
      { ai: 'deepseek', source: 'zh',    weight: 1.3 },
      { ai: 'deepseek', source: 'wxgzh', weight: 1.3 },
      { ai: 'deepseek', source: 'bjh',   weight: 1.2 },
      { ai: 'deepseek', source: 'xhs',   weight: 1.2 },
      { ai: 'deepseek', source: 'tt',    weight: 1.0 },
      { ai: 'deepseek', source: 'csdn',  weight: 1.2 },
      { ai: 'deepseek', source: 'sohu',  weight: 0.8 },
      { ai: 'deepseek', source: 'qeh',   weight: 0.8 },
      { ai: 'deepseek', source: 'wy',    weight: 0.8 },
      { ai: 'deepseek', source: 'js',    weight: 0.5 },
      { ai: 'deepseek', source: 'bili',  weight: 1.0 },
      { ai: 'deepseek', source: 'dy',    weight: 1.0 },
      // 腾讯混元：企鹅号权重稍高（腾讯系）
      { ai: 'hunyuan', source: 'qeh',   weight: 1.5 },
      { ai: 'hunyuan', source: 'wxgzh', weight: 1.3 },
      { ai: 'hunyuan', source: 'zh',    weight: 1.2 },
      { ai: 'hunyuan', source: 'bjh',   weight: 1.0 },
      { ai: 'hunyuan', source: 'xhs',   weight: 1.0 },
      { ai: 'hunyuan', source: 'tt',    weight: 1.0 },
      { ai: 'hunyuan', source: 'csdn',  weight: 1.0 },
      { ai: 'hunyuan', source: 'sohu',  weight: 0.8 },
      { ai: 'hunyuan', source: 'wy',    weight: 0.8 },
      { ai: 'hunyuan', source: 'js',    weight: 0.5 },
      { ai: 'hunyuan', source: 'bili',  weight: 1.0 },
      { ai: 'hunyuan', source: 'dy',    weight: 1.0 },
      // 讯飞星火：较均衡
      { ai: 'spark', source: 'zh',    weight: 1.2 },
      { ai: 'spark', source: 'wxgzh', weight: 1.2 },
      { ai: 'spark', source: 'bjh',   weight: 1.2 },
      { ai: 'spark', source: 'xhs',   weight: 1.0 },
      { ai: 'spark', source: 'tt',    weight: 1.0 },
      { ai: 'spark', source: 'csdn',  weight: 1.0 },
      { ai: 'spark', source: 'sohu',  weight: 0.8 },
      { ai: 'spark', source: 'qeh',   weight: 0.8 },
      { ai: 'spark', source: 'wy',    weight: 0.8 },
      { ai: 'spark', source: 'js',    weight: 0.5 },
      { ai: 'spark', source: 'bili',  weight: 1.0 },
      { ai: 'spark', source: 'dy',    weight: 1.0 },
    ];
    for (const m of sourceMappings) {
      await client.query(
        `INSERT INTO ai_platform_source_mapping (ai_platform, source_platform, source_weight)
         VALUES ($1, $2, $3)
         ON CONFLICT (ai_platform, source_platform) DO NOTHING`,
        [m.ai, m.source, m.weight]
      );
    }

    console.log('[Migrate] v2.0.0 AI平台流量权重层创建完成（ai_platform_weight + ai_platform_source_mapping）');

    // ============ v2.5.37: 平台约束规则 + AI平台权重 按代理隔离（加 user_id 字段） ============
    // user_id 为空字符串 '' 表示全局规则（管理员配置，所有代理可见）
    // user_id = 代理id 表示代理私有规则（仅该代理可见，影响自己账号内的文章生成）
    // 代理视角：WHERE user_id = '' OR user_id = $agentUserId（看到全局 + 自己的）
    // 管理员视角：看所有

    // platform_content_rule: 加 user_id，主键改为 (platform, user_id)
    await client.query(`ALTER TABLE platform_content_rule ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT ''`);
    await client.query(`UPDATE platform_content_rule SET user_id = '' WHERE user_id IS NULL`);
    await client.query(`ALTER TABLE platform_content_rule DROP CONSTRAINT IF EXISTS platform_content_rule_pkey`);
    await client.query(`ALTER TABLE platform_content_rule ADD PRIMARY KEY (platform, user_id)`);

    // ai_platform_weight: 加 user_id，唯一约束改为 (platform, user_id)
    await client.query(`ALTER TABLE ai_platform_weight ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT ''`);
    await client.query(`UPDATE ai_platform_weight SET user_id = '' WHERE user_id IS NULL`);
    await client.query(`ALTER TABLE ai_platform_weight DROP CONSTRAINT IF EXISTS ai_platform_weight_platform_key`);
    await client.query(`ALTER TABLE ai_platform_weight ADD UNIQUE (platform, user_id)`);

    // ai_platform_source_mapping: 加 user_id，唯一约束改为 (ai_platform, source_platform, user_id)
    await client.query(`ALTER TABLE ai_platform_source_mapping ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT ''`);
    await client.query(`UPDATE ai_platform_source_mapping SET user_id = '' WHERE user_id IS NULL`);
    await client.query(`ALTER TABLE ai_platform_source_mapping DROP CONSTRAINT IF EXISTS ai_platform_source_mapping_ai_platform_source_platform_key`);
    await client.query(`ALTER TABLE ai_platform_source_mapping ADD UNIQUE (ai_platform, source_platform, user_id)`);

    console.log('[Migrate] v2.5.37 平台规则 + AI权重按代理隔离字段添加完成（user_id）');

    // ============ v2.0.0: 分片级 AEO 报告（只存储，不触发写作） ============

    // aeo_shard_report: 分片级 AEO 报告
    // 每个分片查询完成后自动分析该分片的 AI 情感倾向、品牌提及情况
    // 分析结果只入库，不触发写作任务。等待周/月报汇总后统一驱动写作。
    await client.query(`
      CREATE TABLE IF NOT EXISTS aeo_shard_report (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL,
        queue_id BIGINT NOT NULL,
        user_id TEXT,
        round_no INTEGER,
        shard_keywords JSONB,
        sentiment_summary JSONB,
        brand_mentions JSONB,
        negative_findings JSONB,
        content_suggestions TEXT,
        record_count INTEGER DEFAULT 0,
        brand_matched_count INTEGER DEFAULT 0,
        visibility_score DECIMAL(5,2) DEFAULT 0,
        positive_ratio DECIMAL(5,2) DEFAULT 0,
        negative_ratio DECIMAL(5,2) DEFAULT 0,
        neutral_ratio DECIMAL(5,2) DEFAULT 0,
        raw_analysis JSONB,
        shard_start_time TIMESTAMP,
        shard_end_time TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_shard_report_task ON aeo_shard_report(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_shard_report_queue ON aeo_shard_report(queue_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_shard_report_task_round ON aeo_shard_report(task_id, round_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_shard_report_user_time ON aeo_shard_report(user_id, created_at DESC)`);

    console.log('[Migrate] v2.0.0 分片级AEO报告表创建完成（aeo_shard_report）');

    // ============ v2.1.6: 分片报告多维度扩展 ============
    // 分片报告作为所有数据（日报/周报/月报/大屏）的基础数据源，需包含完整维度：
    // - platform_breakdown: 各AI平台的查询数/品牌命中数
    // - keyword_coverage: 关键词覆盖详情（关键词列表+命中情况）
    // - competitor_mentions: 竞品在AI回答中的出现情况
    // - source_platforms: 本分片查询的AI平台列表（含信源权重）
    // - keyword_type: 关键词类型（0=蒸馏词, 1=品牌词）
    // - hit_rate: 命中率（brand_matched_count / record_count * 100）
    // - share_urls: 分享链接列表（用于详情查看）
    // - raw_contents_sample: AI回答内容样本（前N条，供日报/周报LLM分析用）
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS platform_breakdown JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS keyword_coverage JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS competitor_mentions JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS source_platforms JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS keyword_type INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS hit_rate DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS share_urls JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS raw_contents_sample JSONB`);
    console.log('[Migrate] v2.1.6 分片报告多维度扩展完成（8个新字段）');

    // ============ v2.1.9: 分片报告按关键词来源分离分析管道 ============
    // 品牌词任务（keyword_type=1）：深度情感分析，输出多维度情感评分
    //   - sentiment_dimensions: { trust, professionalism, recommendation_intent, value_perception, ... }
    // 蒸馏词任务（keyword_type=0）：提及率/覆盖率分析，输出各平台提及率和盲区
    //   - mention_analysis: { platform_mention_rates, uncovered_keywords, coverage_gaps, ... }
    // 两种任务用不同的分析管道（analyzeBrandShard / analyzeDistillateShard），评分标准不同：
    //   - 品牌词：visibilityScore 基于情感健康度（正面占比 - 负面占比）
    //   - 蒸馏词：visibilityScore 基于提及率 × 平台覆盖均衡度
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS sentiment_dimensions JSONB`);
    await client.query(`ALTER TABLE aeo_shard_report ADD COLUMN IF NOT EXISTS mention_analysis JSONB`);
    console.log('[Migrate] v2.1.9 分片报告分离分析管道扩展完成（sentiment_dimensions + mention_analysis）');

    // ============ v2.0.0: 时间维度报告（周/月报，写作驱动核心） ============

    // aeo_period_report: 时间维度报告
    // 按客户创建日计算周期（非固定周一/1日），汇总该周期内分片报告建议 + 收录/排名数据
    // 生成综合写作建议池，按客户配额自动创建写作任务
    await client.query(`
      CREATE TABLE IF NOT EXISTS aeo_period_report (
        id BIGSERIAL PRIMARY KEY,
        task_id BIGINT,
        user_id TEXT,
        period_type VARCHAR(20) NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        inclusion_summary JSONB,
        rank_summary JSONB,
        platform_comparison JSONB,
        shard_suggestions_summary TEXT,
        writing_suggestions JSONB,
        suggested_article_count INTEGER DEFAULT 0,
        actual_article_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'generated',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_period_report_user ON aeo_period_report(user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_period_report_type ON aeo_period_report(period_type, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_period_report_user_type_time ON aeo_period_report(user_id, period_type, period_start DESC)`);

    console.log('[Migrate] v2.0.0 时间维度报告表创建完成（aeo_period_report）');

    // ============ AEO 写作建议池（v2.3.0）============
    await client.query(`
      CREATE TABLE IF NOT EXISTS aeo_writing_suggestion (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        period_report_id BIGINT REFERENCES aeo_period_report(id) ON DELETE CASCADE,
        source_type VARCHAR(20) NOT NULL,
        report_date DATE NOT NULL,
        topic TEXT NOT NULL,
        reason TEXT,
        direction VARCHAR(100),
        platforms TEXT[],
        keywords TEXT[],
        priority VARCHAR(20) DEFAULT 'medium',
        consumed BOOLEAN DEFAULT FALSE,
        consumed_at TIMESTAMP,
        writing_task_id INTEGER REFERENCES ai_writing_task(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_writing_suggestion_user_consumed ON aeo_writing_suggestion(user_id, consumed)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_writing_suggestion_period_report ON aeo_writing_suggestion(period_report_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_aeo_writing_suggestion_report_date ON aeo_writing_suggestion(user_id, source_type, report_date DESC)`);

    // ============ v2.4.4：修复 aeo_report 外键约束导致日报生成失败 ============
    //   原 bug：aeo_report.task_id 有外键 fk_aeo_task 引用 real_collect_task(id)，
    //     但日报是跨任务汇总（按 user_id 维度生成），taskId 只是占位。
    //     当占位 taskId 不存在于 real_collect_task 时（如任务被删除或 id 不匹配），
    //     INSERT 违反外键约束报错："violates foreign key constraint fk_aeo_task"
    //     导致 18/19 号日报连续两天没生成。
    //   修复：
    //   1. 移除 fk_aeo_task 外键约束（日报不强制绑定具体 task）
    //   2. task_id 改为可空（BIGINT NOT NULL → BIGINT，允许 NULL）
    //   3. 删除原唯一索引 idx_aeo_task_date_unique(task_id, report_date)（task_id 为 NULL 时无效）
    //   4. 新建唯一索引 idx_aeo_user_date_unique(user_id, report_date) 防止同客户同日重复
    {
      // 检查 fk_aeo_task 是否存在，存在则移除
      const fkCheck = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE conname = 'fk_aeo_task' AND contype = 'f'
      `);
      if (fkCheck.rowCount && fkCheck.rowCount > 0) {
        await client.query('ALTER TABLE aeo_report DROP CONSTRAINT fk_aeo_task');
        console.log('[Migrate] v2.4.4 已移除 aeo_report.fk_aeo_task 外键约束');
      }

      // task_id 改为可空
      await client.query('ALTER TABLE aeo_report ALTER COLUMN task_id DROP NOT NULL');
      console.log('[Migrate] v2.4.4 aeo_report.task_id 已改为可空');

      // 删除原唯一索引（基于 task_id 的，task_id 可空后无效）
      await client.query('DROP INDEX IF EXISTS idx_aeo_task_date_unique');

      // v2.4.5：清理 aeo_report 重复数据（保留每组 user_id+report_date 最新的一条）
      //   原 bug：原唯一索引是 (task_id, report_date)，不同 task_id 可以有相同 (user_id, report_date)
      //   切换为 (user_id, report_date) 唯一索引时，已有的重复数据会导致创建失败：
      //   ERROR: could not create unique index "idx_aeo_user_date_unique"
      //   detail: Key (user_id, report_date)=(4, 2026-07-13) is duplicated.
      const dupCount = await client.query(`
        SELECT COUNT(*) as cnt FROM (
          SELECT user_id, report_date, COUNT(*) as c
          FROM aeo_report
          GROUP BY user_id, report_date
          HAVING COUNT(*) > 1
        ) t
      `);
      const dupTotal = Number(dupCount.rows[0]?.cnt || 0);
      if (dupTotal > 0) {
        console.log(`[Migrate] v2.4.5 检测到 ${dupTotal} 组重复 (user_id, report_date)，清理中...`);
        // 保留每组 id 最大的，删除其余
        const deletedRes = await client.query(`
          DELETE FROM aeo_report
          WHERE id NOT IN (
            SELECT MAX(id) FROM aeo_report
            GROUP BY user_id, report_date
          )
          RETURNING id
        `);
        console.log(`[Migrate] v2.4.5 已清理 ${deletedRes.rowCount || 0} 条重复记录`);
      }

      // 新建基于 (user_id, report_date) 的唯一索引（防止同客户同日重复生成）
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_aeo_user_date_unique ON aeo_report(user_id, report_date)`);
      console.log('[Migrate] v2.4.4 aeo_report 唯一索引已切换为 (user_id, report_date)');
    }

    // ============ v2.5.29：回填 aeo_writing_suggestion 独立建议池表 ============
    //   原 bug：v2.3.0 之前生成的周期报告（aeo_period_report）只把 writing_suggestions
    //   存到 JSON 字段中，未写入独立的 aeo_writing_suggestion 表。导致前端"写作建议池"
    //   组件按 source_type 查询独立表时返回空——用户看到周报里有建议但建议池里没有。
    //   修复：扫描所有 aeo_period_report，如果对应 report_id 在独立表中无记录，
    //        则从 JSON 字段解析回填到独立表。
    try {
      const backfillRes = await client.query(`
        SELECT id, user_id, period_type, period_start, writing_suggestions
        FROM aeo_period_report
        WHERE writing_suggestions IS NOT NULL
          AND jsonb_array_length(writing_suggestions) > 0
          AND NOT EXISTS (
            SELECT 1 FROM aeo_writing_suggestion WHERE period_report_id = aeo_period_report.id
          )
      `);
      let backfillCount = 0;
      for (const row of backfillRes.rows) {
        const userIdNum = Number(row.user_id);
        if (!Number.isFinite(userIdNum)) continue; // user_id 非数字跳过
        const suggestions = row.writing_suggestions;
        if (!Array.isArray(suggestions)) continue;
        const reportDateStr = row.period_start instanceof Date
          ? row.period_start.toISOString().slice(0, 10)
          : String(row.period_start).slice(0, 10);
        for (const s of suggestions) {
          try {
            await client.query(
              `INSERT INTO aeo_writing_suggestion
               (user_id, period_report_id, source_type, report_date, topic, reason, direction, platforms, keywords, priority)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                userIdNum,
                row.id,
                row.period_type,
                reportDateStr,
                String(s.topic || ''),
                s.reason ? String(s.reason) : null,
                s.direction ? String(s.direction) : null,
                Array.isArray(s.platforms) ? s.platforms.filter((p: any) => typeof p === 'string') : [],
                Array.isArray(s.keywords) ? s.keywords.filter((k: any) => typeof k === 'string') : [],
                ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
              ]
            );
            backfillCount++;
          } catch (e: any) {
            // 单条失败不影响其他
          }
        }
      }
      if (backfillCount > 0) {
        console.log(`[Migrate] v2.5.29 已回填 ${backfillCount} 条写作建议到独立建议池表`);
      }
    } catch (e: any) {
      console.warn('[Migrate] v2.5.29 回填写作建议池失败（不阻断）:', e.message);
    }

    // v2.5.33：修复历史 publish_* 飞轮事件 user_id=0 的问题
    // 根因：worker 鉴权后 req.user.id=0，旧版 reportFlywheelEvent 不传 user_id，
    //       导致事件写入 user_id=0，前端按客户 ID 过滤查不到日志。
    // 修复：根据 data.record_id 关联 publish_record → publish_task.user_id 回填。
    try {
      const fixResult = await client.query(
        `UPDATE flywheel_event_log fel
         SET user_id = pt.user_id
         FROM publish_record pr
         JOIN publish_task pt ON pt.id = pr.task_id
         WHERE fel.user_id = 0
           AND fel.event_type LIKE 'publish_%'
           AND fel.data ? 'record_id'
           AND (fel.data->>'record_id')::int = pr.id
           AND pt.user_id > 0`
      );
      if (fixResult.rowCount && fixResult.rowCount > 0) {
        console.log(`[Migrate] v2.5.33 已回填 ${fixResult.rowCount} 条 publish_* 事件的 user_id`);
      }
    } catch (e: any) {
      console.warn('[Migrate] v2.5.33 回填 publish_* 事件 user_id 失败（不阻断）:', e.message);
    }

    // v2.5.34：修复历史 publish_task 状态不一致（进度条跑完但 status 仍为 pending/processing）
    // 根因：旧版 updatePublishTaskStatus 直接 SET status=$2，依赖二次查询设置终态，
    //       并发回写时竞态条件导致终态设置被跳过。
    // 修复：根据 completed_count/failed_count/total_count 重新计算正确状态。
    try {
      const fixTaskResult = await client.query(
        `UPDATE publish_task
         SET status = CASE
           WHEN completed_count + failed_count >= total_count THEN
             CASE WHEN failed_count = 0 THEN 'completed'
                  WHEN completed_count = 0 THEN 'failed'
                  ELSE 'partial' END
           WHEN completed_count + failed_count > 0 THEN 'processing'
           ELSE 'pending'
         END,
         finished_at = CASE
           WHEN completed_count + failed_count >= total_count THEN COALESCE(finished_at, NOW())
           ELSE finished_at END
         WHERE status IN ('pending', 'processing')
           AND completed_count + failed_count >= total_count`
      );
      if (fixTaskResult.rowCount && fixTaskResult.rowCount > 0) {
        console.log(`[Migrate] v2.5.34 已修正 ${fixTaskResult.rowCount} 个 publish_task 的终态状态`);
      }
    } catch (e: any) {
      console.warn('[Migrate] v2.5.34 修正 publish_task 终态失败（不阻断）:', e.message);
    }

    // ============ v2.5.36 阶段六：混合模式 Worker 分布式架构 ============
    // 1. 云端 worker 配额表（记录每个代理购买的并发配额，云端增强包 + 私有部署共用）
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_worker_quota (
        id BIGSERIAL PRIMARY KEY,
        agent_user_id BIGINT NOT NULL,
        quota_type VARCHAR(20) NOT NULL,
        max_concurrency INT NOT NULL DEFAULT 2,
        source VARCHAR(20) DEFAULT 'cloud',
        order_id BIGINT,
        expire_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        private_server_id VARCHAR(128),
        private_server_name VARCHAR(100),
        private_last_heartbeat TIMESTAMP,
        private_config JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_quota_agent ON agent_worker_quota(agent_user_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_quota_expire ON agent_worker_quota(expire_at) WHERE status = 'active'`);

    // 2. 云端 worker 容器实例表（共享池中的运行实例，docker 容器跟踪）
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_instance (
        id BIGSERIAL PRIMARY KEY,
        instance_id VARCHAR(64) NOT NULL UNIQUE,
        worker_type VARCHAR(20) NOT NULL,
        agent_user_id BIGINT,
        server_node VARCHAR(50) NOT NULL DEFAULT 'default',
        status VARCHAR(20) DEFAULT 'starting',
        current_task_id BIGINT,
        max_concurrency INT DEFAULT 2,
        started_at TIMESTAMP DEFAULT NOW(),
        last_heartbeat TIMESTAMP,
        cpu_percent FLOAT DEFAULT 0,
        memory_mb INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_worker_instance_status ON worker_instance(status, agent_user_id)`);

    // 3. 私有部署授权码表
    await client.query(`
      CREATE TABLE IF NOT EXISTS private_deploy_license (
        id BIGSERIAL PRIMARY KEY,
        license_key VARCHAR(128) NOT NULL UNIQUE,
        agent_user_id BIGINT NOT NULL,
        order_id BIGINT,
        server_fingerprint VARCHAR(128),
        server_name VARCHAR(100),
        max_concurrency INT DEFAULT 8,
        status VARCHAR(20) DEFAULT 'pending',
        activated_at TIMESTAMP,
        expire_at TIMESTAMP,
        last_heartbeat TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_private_license_agent ON private_deploy_license(agent_user_id, status)`);

    // 4. worker 节点配置表（管理员配置云端 worker 服务器池）
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_node_config (
        id BIGSERIAL PRIMARY KEY,
        node_name VARCHAR(50) NOT NULL UNIQUE,
        docker_host VARCHAR(200) NOT NULL,
        docker_tls_cert_path VARCHAR(500),
        api_version VARCHAR(20) DEFAULT 'v1.41',
        max_replicas INT DEFAULT 4,
        current_replicas INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'offline',
        last_check_at TIMESTAMP,
        config JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 5. agent_subscription_plan 新增 plan_type 字段（区分板块/云worker/私有部署）
    await client.query(`ALTER TABLE agent_subscription_plan ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'module'`);

    // 6. 插入 worker 增强包 + 私有部署套餐（如果不存在）
    const workerPlanCount = await client.query(
      "SELECT COUNT(*) as count FROM agent_subscription_plan WHERE plan_type = 'cloud_worker' OR plan_type = 'private_deploy'"
    );
    if (parseInt(workerPlanCount.rows[0].count) === 0) {
      const workerPlans = [
        { code: 'cloud_worker_5_monthly',  module: 'cloud_worker',   name: '云端增强包·5并发·月度',   price: 9900,   period: 'monthly', ptype: 'cloud_worker',   sort: 101 },
        { code: 'cloud_worker_5_yearly',   module: 'cloud_worker',   name: '云端增强包·5并发·年度',   price: 99900,  period: 'yearly',  ptype: 'cloud_worker',   sort: 102 },
        { code: 'cloud_worker_10_monthly', module: 'cloud_worker',   name: '云端增强包·10并发·月度',  price: 17900,  period: 'monthly', ptype: 'cloud_worker',   sort: 103 },
        { code: 'cloud_worker_10_yearly',  module: 'cloud_worker',   name: '云端增强包·10并发·年度',  price: 179900, period: 'yearly',  ptype: 'cloud_worker',   sort: 104 },
        { code: 'cloud_worker_20_monthly', module: 'cloud_worker',   name: '云端增强包·20并发·月度',  price: 32900,  period: 'monthly', ptype: 'cloud_worker',   sort: 105 },
        { code: 'cloud_worker_20_yearly',  module: 'cloud_worker',   name: '云端增强包·20并发·年度',  price: 329900, period: 'yearly',  ptype: 'cloud_worker',   sort: 106 },
        { code: 'cloud_worker_50_monthly', module: 'cloud_worker',   name: '云端增强包·50并发·月度',  price: 79900,  period: 'monthly', ptype: 'cloud_worker',   sort: 107 },
        { code: 'cloud_worker_50_yearly',  module: 'cloud_worker',   name: '云端增强包·50并发·年度',  price: 799900, period: 'yearly',  ptype: 'cloud_worker',   sort: 108 },
        { code: 'private_deploy_monthly',  module: 'private_deploy', name: '私有部署授权·月度',       price: 29900,  period: 'monthly', ptype: 'private_deploy', sort: 201 },
        { code: 'private_deploy_yearly',   module: 'private_deploy', name: '私有部署授权·年度',       price: 299900, period: 'yearly',  ptype: 'private_deploy', sort: 202 },
      ];
      for (const p of workerPlans) {
        await client.query(
          `INSERT INTO agent_subscription_plan (plan_code, module_code, name, price_fen, period, plan_type, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (plan_code) DO NOTHING`,
          [p.code, p.module, p.name, p.price, p.period, p.ptype, p.sort]
        );
      }
      console.log('[Migrate] v2.5.36 已初始化 worker 套餐:', workerPlans.length, '项');
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
