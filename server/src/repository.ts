import { query, withTransaction, PoolClient } from './db';
import { encrypt, decrypt } from './utils/crypto';
import crypto from 'crypto';

// ============ 用户管理 ============

export interface User {
  id: number;
  username: string;
  password: string;
  phone: string;
  email: string;
  url: string;
  address: string;
  level: string;
  cid: string;
  date_time: string;
  create_time: Date;
  update_time: Date;
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const result = await query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0] || null;
}

export async function findUserById(id: number): Promise<User | null> {
  const result = await query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAllUsers(): Promise<any[]> {
  const result = await query('SELECT id, username, phone, email, url, address, level, cid, date_time, create_time FROM users ORDER BY id');
  return result.rows;
}

// 分页查询用户
export async function getUsersByPage(pageNum: number, pageSize: number): Promise<{ list: any[]; total: number }> {
  const offset = (pageNum - 1) * pageSize;
  const countResult = await query('SELECT COUNT(*) as total FROM users');
  const total = parseInt(countResult.rows[0].total);
  const result = await query(
    'SELECT id, username, phone, email, url, address, level, cid, date_time, create_time FROM users ORDER BY id LIMIT $1 OFFSET $2',
    [pageSize, offset]
  );
  return { list: result.rows, total };
}

export async function createUser(user: any): Promise<number> {
  const result = await query(
    `INSERT INTO users (username, password, phone, email, url, address, level, cid, date_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [user.username, user.password, user.phone || '', user.email || '', user.url || '',
     user.address || '', user.level || '0', user.cid || '', user.dateTime || '']
  );
  return result.rows[0].id;
}

export async function updateUser(id: number, user: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  // 动态构建 SET 子句，只更新提供的字段，避免覆盖未发送的字段
  if (user.username !== undefined) {
    fields.push(`username = $${paramIndex++}`);
    values.push(user.username);
  }
  if (user.password !== undefined) {
    fields.push(`password = $${paramIndex++}`);
    values.push(user.password);
  }
  if (user.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(user.phone);
  }
  if (user.email !== undefined) {
    fields.push(`email = $${paramIndex++}`);
    values.push(user.email);
  }
  if (user.url !== undefined) {
    fields.push(`url = $${paramIndex++}`);
    values.push(user.url);
  }
  if (user.address !== undefined) {
    fields.push(`address = $${paramIndex++}`);
    values.push(user.address);
  }
  if (user.level !== undefined) {
    fields.push(`level = $${paramIndex++}`);
    values.push(user.level);
  }
  if (user.cid !== undefined) {
    fields.push(`cid = $${paramIndex++}`);
    values.push(user.cid);
  }
  if (user.dateTime !== undefined) {
    fields.push(`date_time = $${paramIndex++}`);
    values.push(user.dateTime);
  }

  if (fields.length === 0) {
    return; // 没有字段需要更新
  }

  fields.push(`update_time = CURRENT_TIMESTAMP`);
  values.push(id);

  await query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

export async function deleteUser(id: number): Promise<void> {
  await query('DELETE FROM users WHERE id = $1', [id]);
}

export async function updateUserDateTime(userId: string, dateTime: string): Promise<void> {
  await query('UPDATE users SET date_time = $1, update_time = CURRENT_TIMESTAMP WHERE id = $2', [dateTime, userId]);
}

// 获取用户最新数据时间
export async function getUserLatestDataTime(userId: string): Promise<string> {
  // create_time存储的是UTC时间，需要转换为北京时间显示
  // 先 AT TIME ZONE 'UTC' 标记为UTC，再 AT TIME ZONE 'Asia/Shanghai' 转为北京时间
  const result = await query(
    "SELECT to_char((MAX(create_time) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as latest FROM keyword_search_rank WHERE user_id = $1",
    [userId]
  );
  return result.rows[0]?.latest || '';
}

// ============ 平台管理 ============

export async function getAllPlatforms(): Promise<any[]> {
  const result = await query(`
    SELECT id, pt FROM pt
    ORDER BY CASE pt
      WHEN '豆包' THEN 1 WHEN 'DeepSeek' THEN 2 WHEN '腾讯元宝' THEN 3
      WHEN '通义千问' THEN 4 WHEN '纳米' THEN 5 WHEN '文心一言' THEN 6
      WHEN '智谱AI' THEN 7 WHEN 'Kimi' THEN 8 ELSE 99 END
    `);
  return result.rows;
}

// ============ 关键词收录记录 ============

export interface SearchRankParams {
  userId?: string;
  platform?: string;
  keyword?: string;
  scene?: boolean;
  type?: string;  // keywords | brand | scene
  page?: number;
  pageSize?: number;
}

export async function getKeywordSearchRank(params: SearchRankParams) {
  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  // ============ 构建统一参数数组 ============
  // 真实结果与生成结果共享 userId / platform 参数（PostgreSQL 允许同一 $N 多次引用）
  const hasPlatform = !!(params.platform && params.platform !== '全部');
  const hasKeyword = !!params.keyword;

  const args: any[] = [params.userId]; // $1 = userId
  let argIdx = 1;

  // $2 = platform（如果存在，真实结果和生成结果共用）
  let platformParamIdx = 0;
  if (hasPlatform) {
    argIdx++;
    platformParamIdx = argIdx;
    args.push(params.platform);
  }

  // $3 = keyword（如果存在，仅生成结果使用）
  let keywordParamIdx = 0;
  if (hasKeyword) {
    argIdx++;
    keywordParamIdx = argIdx;
    args.push(`%${params.keyword}%`);
  }

  // LIMIT / OFFSET 参数（放在最后，用于外层包装查询）
  argIdx++;
  const limitParamIdx = argIdx;
  args.push(pageSize);
  argIdx++;
  const offsetParamIdx = argIdx;
  args.push(offset);

  // ============ 真实结果 WHERE 条件 ============
  // 按 tab 类型过滤真实记录：
  // - keywords tab: keyword_type=0 的真实记录（蒸馏词库任务的结果）
  // - brand tab: keyword_type=1 的真实记录（品牌词库任务的结果）
  // - scene tab: has_contact=true 的真实记录（不论 keyword_type）
  // - 不传 type: brand_matched=true 的真实记录（保持原兼容行为）
  const realWhere = [`rcr.user_id = $1`];
  if (hasPlatform) {
    realWhere.push(`rcr.platform = $${platformParamIdx}`);
  }
  if (params.type === 'keywords') {
    realWhere.push(`rcr.keyword_type = 0`);
  } else if (params.type === 'brand') {
    realWhere.push(`rcr.keyword_type = 1`);
  } else if (params.type === 'scene') {
    realWhere.push(`rcr.has_contact = true`);
  } else {
    // 默认（无 type 过滤）：保持原 brand_matched=true 行为
    realWhere.push(`rcr.brand_matched = true`);
  }
  const realWhereClause = realWhere.join(' AND ');

  // ============ 生成结果 WHERE 条件（保持原逻辑完全不变）============
  const genWhere = [`k.user_id = $1`, 'k.query_time IS NOT NULL'];
  if (hasPlatform) {
    genWhere.push(`k.platform = $${platformParamIdx}`);
  }
  if (hasKeyword) {
    genWhere.push(`(k.expanded_keyword ILIKE $${keywordParamIdx} OR k.distillate_keyword ILIKE $${keywordParamIdx})`);
  }
  // 类型过滤
  if (params.type === 'keywords') {
    // 关键词搜索：只统计蒸馏关键词（keyword_type=0）
    genWhere.push(`EXISTS (SELECT 1 FROM zlgjc z3 WHERE z3.value = k.distillate_keyword AND z3.userid = k.user_id AND z3.keyword_type = 0)`);
  } else if (params.type === 'brand') {
    // 品牌搜索：distillate_keyword 在品牌关键词库中（keyword_type=1）
    genWhere.push(`EXISTS (SELECT 1 FROM zlgjc z3 WHERE z3.value = k.distillate_keyword AND z3.userid = k.user_id AND z3.keyword_type = 1)`);
  } else if (params.type === 'scene') {
    // 联系方式：has_lxfs = 1
    genWhere.push(`EXISTS (SELECT 1 FROM zlgjc z2 INNER JOIN zlgjcurl u2 ON z2.id = u2.zlgjcid WHERE z2.value = k.distillate_keyword AND z2.userid = k.user_id AND u2.has_lxfs = 1 AND u2.pt = k.platform)`);
  }
  const genWhereClause = genWhere.join(' AND ');

  // ============ 查询总数（包含真实结果 + 生成结果）============
  // 排除末尾的 LIMIT/OFFSET 参数
  // 同样过滤 raw_content 过短的脏数据（与列表查询保持一致）
  const countArgs = args.slice(0, -2);
  const realWhereWithContent = realWhereClause + ' AND COALESCE(LENGTH(rcr.raw_content), 0) >= 30';
  const countResult = await query(
    `SELECT COUNT(*) as total FROM (
       SELECT 1 FROM real_collect_record rcr WHERE ${realWhereWithContent}
       UNION ALL
       SELECT 1 FROM keyword_search_rank k WHERE ${genWhereClause}
     ) combined`,
    countArgs
  );
  const total = parseInt(countResult.rows[0].total);

  // ============ 查询列表（真实结果置顶，UNION ALL 连接）============
  const listResult = await query(
    `SELECT * FROM (
       -- 真实查询结果（置顶展示）
       -- url/zlgjc_url 规则：
       --   1. 优先使用 share_url（支持分享的平台）
       --   2. share_url 为空但有 static_page_id 时，使用静态页 URL
       --   3. 两者都为空时返回 NULL，前端不展示"查看详情"跳转链接
       --     （这避免了"未开始对话界面"被误识别为命中后生成错误跳转链接）
       SELECT
         rcr.id,
         rcr.keyword AS expanded_keyword,
         rcr.keyword AS distillate_keyword,
         rcr.platform,
         rcr.user_id,
         rcr.query_time,
         COALESCE(rcr.share_url,
           CASE WHEN rcr.static_page_id IS NOT NULL
                THEN '/api/real-collect/results/' || rcr.id || '/page'
                ELSE NULL END) AS url,
         rcr.create_time,
         COALESCE(rcr.share_url,
           CASE WHEN rcr.static_page_id IS NOT NULL
                THEN '/api/real-collect/results/' || rcr.id || '/page'
                ELSE NULL END) AS zlgjc_url,
         CASE WHEN rcr.has_contact THEN 1 ELSE 0 END AS has_lxfs,
         'real' AS source
       FROM real_collect_record rcr
       WHERE ${realWhereClause}
         -- 过滤无效记录：raw_content 为空或过短（<30字符）的记录是 extractContent 兜底失败导致的脏数据
         AND COALESCE(LENGTH(rcr.raw_content), 0) >= 30

       UNION ALL

       -- 生成结果（保持原逻辑不变）
       SELECT
         k.id,
         k.expanded_keyword,
         k.distillate_keyword,
         k.platform,
         k.user_id,
         k.query_time,
         k.url,
         k.create_time,
         u.url AS zlgjc_url,
         u.has_lxfs,
         'generated' AS source
       FROM keyword_search_rank k
       LEFT JOIN zlgjc z ON z.value = k.distillate_keyword AND z.userid = k.user_id
       LEFT JOIN zlgjcurl u ON u.zlgjcid = z.id AND u.pt = k.platform
       WHERE ${genWhereClause}
     ) combined
     ORDER BY
       CASE WHEN source = 'real' THEN 0 ELSE 1 END,
       query_time DESC,
       create_time DESC
     LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
    args
  );

  return { list: listResult.rows, total, page, pageSize };
}

// 获取关键词数量统计（只统计已收录的）
export async function getKeywordCount(userId: string) {
  const result = await query(
    `SELECT
       COUNT(DISTINCT expanded_keyword) as core_count,
       COUNT(DISTINCT distillate_keyword) as distillate_count,
       COUNT(*) as total_count
     FROM keyword_search_rank WHERE user_id = $1 AND query_time IS NOT NULL`,
    [userId]
  );
  return result.rows[0];
}

// 获取平台占比（只统计已收录的，支持按类型过滤）
export async function getPlatformRatio(userId: string, type?: string) {
  // 构建生成结果的额外WHERE条件
  let genExtraWhere = '';
  if (type === 'keywords') {
    // 关键词搜索：只统计蒸馏关键词（keyword_type=0）
    genExtraWhere = `AND EXISTS (SELECT 1 FROM zlgjc z3 WHERE z3.value = k.distillate_keyword AND z3.userid = k.user_id AND z3.keyword_type = 0)`;
  } else if (type === 'brand') {
    // 品牌搜索：distillate_keyword 在品牌关键词库中（keyword_type=1）
    genExtraWhere = `AND EXISTS (SELECT 1 FROM zlgjc z3 WHERE z3.value = k.distillate_keyword AND z3.userid = k.user_id AND z3.keyword_type = 1)`;
  } else if (type === 'scene') {
    // 联系方式：has_lxfs = 1
    genExtraWhere = `AND EXISTS (SELECT 1 FROM zlgjc z2 INNER JOIN zlgjcurl u2 ON z2.id = u2.zlgjcid WHERE z2.value = k.distillate_keyword AND z2.userid = k.user_id AND u2.has_lxfs = 1 AND u2.pt = k.platform)`;
  }

  // 真实结果的额外WHERE条件（按 tab 类型过滤，与 getKeywordSearchRank 保持一致）
  let realExtraWhere = '';
  if (type === 'keywords') {
    // 关键词搜索：keyword_type=0 的真实记录
    realExtraWhere = `AND rcr.keyword_type = 0`;
  } else if (type === 'brand') {
    // 品牌搜索：keyword_type=1 的真实记录
    realExtraWhere = `AND rcr.keyword_type = 1`;
  } else if (type === 'scene') {
    // 联系方式：has_contact=true 的真实记录
    realExtraWhere = `AND rcr.has_contact = true`;
  } else {
    // 默认：brand_matched=true（保持原兼容行为）
    realExtraWhere = `AND rcr.brand_matched = true`;
  }

  const result = await query(
    `SELECT p.pt, COUNT(c.platform) as count
     FROM pt p
     LEFT JOIN (
       SELECT rcr.platform FROM real_collect_record rcr
       WHERE rcr.user_id = $1 ${realExtraWhere}
       UNION ALL
       SELECT k.platform FROM keyword_search_rank k
       WHERE k.user_id = $1 AND k.query_time IS NOT NULL ${genExtraWhere}
     ) c ON c.platform = p.pt
     GROUP BY p.pt
     ORDER BY CASE p.pt
       WHEN '豆包' THEN 1 WHEN 'DeepSeek' THEN 2 WHEN '腾讯元宝' THEN 3
       WHEN '通义千问' THEN 4 WHEN '纳米' THEN 5 WHEN '文心一言' THEN 6
       WHEN '智谱AI' THEN 7 WHEN 'Kimi' THEN 8 ELSE 99 END`,
    [userId]
  );
  return result.rows;
}

// 获取核心关键词排名（排除品牌关键词，只统计已收录的）
export async function getCoreKeywordRank(userId: string, limit: number = 20) {
  const result = await query(
    `SELECT expanded_keyword as keyword, COUNT(*) as count
     FROM keyword_search_rank k
     WHERE k.user_id = $1 AND k.expanded_keyword != '' AND k.query_time IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pp p
         WHERE p.pp = k.expanded_keyword AND p.user_id = k.user_id
       )
     GROUP BY expanded_keyword
     ORDER BY count DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// ============ 蒸馏关键词库 ============

export async function getZlgjcByUserId(userId: string, keywordType?: number) {
  if (keywordType !== undefined) {
    const result = await query(
      'SELECT id, value, hxgjc, userid, lxfs, create_time, keyword_type FROM zlgjc WHERE userid = $1 AND keyword_type = $2 ORDER BY id',
      [userId, keywordType]
    );
    return result.rows;
  }
  const result = await query(
    'SELECT id, value, hxgjc, userid, lxfs, create_time, keyword_type FROM zlgjc WHERE userid = $1 ORDER BY id',
    [userId]
  );
  return result.rows;
}

export async function insertZlgjc(item: any): Promise<number> {
  // ON CONFLICT 去重：如果 (userid, value, keyword_type) 已存在则不插入
  // 注意：此函数不传 keyword_type，走 DEFAULT 0（蒸馏词）
  const result = await query(
    `INSERT INTO zlgjc (value, hxgjc, userid, lxfs)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (userid, value, keyword_type) DO NOTHING
     RETURNING id`,
    [item.value, item.hxgjc || '', item.userid || '', item.lxfs || '']
  );
  return result.rows[0]?.id || 0;
}

// ============ 蒸馏关键词跳转链接 ============

export async function getZlgjcUrlsByUserId(userId: string) {
  const result = await query(
    `SELECT u.id, u.zlgjcid, u.pt, u.url, u.has_lxfs
     FROM zlgjcurl u
     INNER JOIN zlgjc z ON u.zlgjcid = z.id
     WHERE z.userid = $1`,
    [userId]
  );
  return result.rows;
}

export async function upsertZlgjcUrl(item: any): Promise<number> {
  // 查找是否已存在
  const existing = await query(
    'SELECT id FROM zlgjcurl WHERE zlgjcid = $1 AND pt = $2',
    [item.zlgjcid, item.pt]
  );

  if (existing.rows.length > 0) {
    await query(
      'UPDATE zlgjcurl SET url = $1, has_lxfs = $2 WHERE id = $3',
      [item.url || '', item.hasLxfs ? 1 : 0, existing.rows[0].id]
    );
    return existing.rows[0].id;
  } else {
    const result = await query(
      'INSERT INTO zlgjcurl (zlgjcid, pt, url, has_lxfs) VALUES ($1, $2, $3, $4) RETURNING id',
      [item.zlgjcid, item.pt || '', item.url || '', item.hasLxfs ? 1 : 0]
    );
    return result.rows[0].id;
  }
}

// ============ 品牌关键词 ============

export async function getPPByUserId(userId: string) {
  const result = await query('SELECT id, pp, user_id FROM pp WHERE user_id = $1 ORDER BY id', [userId]);
  return result.rows;
}

export async function insertPP(userId: string, pp: string): Promise<number> {
  const result = await query('INSERT INTO pp (pp, user_id) VALUES ($1, $2) RETURNING id', [pp, userId]);
  return result.rows[0].id;
}

export async function deletePP(id: number): Promise<void> {
  await query('DELETE FROM pp WHERE id = $1', [id]);
}

// ============ 任务管理 ============

export async function getAllTasks(userId?: string) {
  let sql = `
    SELECT t.*, tp.generated_num,
           u.username as user_name
    FROM task_info t
    LEFT JOIN task_progress tp ON t.id = tp.task_id
    LEFT JOIN users u ON t.user_id = u.id::text
  `;
  let args: any[] = [];
  if (userId && userId !== 'all') {
    sql += ' WHERE t.user_id = $1';
    args.push(userId);
  }
  sql += ' ORDER BY t.id DESC';
  const result = await query(sql, args);
  return result.rows;
}

export async function createTask(task: any): Promise<number> {
  const result = await query(
    `INSERT INTO task_info (id, user_id, start_date, end_date, total_num, status, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [task.id, task.userId, task.startDate, task.endDate, task.totalNum, task.status || 'running', task.name || '']
  );
  return result.rows[0].id;
}

export async function updateTask(id: number, task: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (task.userId !== undefined) {
    fields.push(`user_id = $${paramIndex++}`);
    values.push(task.userId);
  }
  if (task.startDate !== undefined) {
    fields.push(`start_date = $${paramIndex++}`);
    values.push(task.startDate);
  }
  if (task.endDate !== undefined) {
    fields.push(`end_date = $${paramIndex++}`);
    values.push(task.endDate);
  }
  if (task.totalNum !== undefined) {
    fields.push(`total_num = $${paramIndex++}`);
    values.push(task.totalNum);
  }
  if (task.status !== undefined) {
    fields.push(`status = $${paramIndex++}`);
    values.push(task.status);
  }
  if (task.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(task.name);
  }

  if (fields.length === 0) {
    console.log(`[Repository] updateTask(${id}) 无字段需要更新`);
    return;
  }

  values.push(id);
  const sql = `UPDATE task_info SET ${fields.join(', ')} WHERE id = $${paramIndex}`;
  console.log(`[Repository] updateTask SQL: ${sql}`);
  console.log(`[Repository] updateTask values:`, JSON.stringify(values));

  const result = await query(sql, values);
  console.log(`[Repository] updateTask 影响行数: ${result.rowCount}`);
}

export async function deleteTask(id: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM keyword_search_rank WHERE task_id = $1', [id]);
    await client.query('DELETE FROM daily_random WHERE task_id = $1', [id]);
    await client.query('DELETE FROM task_platform_weights WHERE task_id = $1', [id]);
    await client.query('DELETE FROM task_progress WHERE task_id = $1', [id]);
    await client.query('DELETE FROM task_info WHERE id = $1', [id]);
  });
}

// 更新任务状态
export async function updateTaskStatus(id: number, status: string): Promise<void> {
  await query('UPDATE task_info SET status = $1 WHERE id = $2', [status, id]);
}

export async function getTaskWeights(taskId: number): Promise<any[]> {
  const result = await query('SELECT platform, weight FROM task_platform_weights WHERE task_id = $1', [taskId]);
  return result.rows;
}

export async function setTaskWeights(taskId: number, weights: any[]): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM task_platform_weights WHERE task_id = $1', [taskId]);
    for (const w of weights) {
      await client.query(
        'INSERT INTO task_platform_weights (task_id, platform, weight) VALUES ($1, $2, $3)',
        [taskId, w.platform, w.weight]
      );
    }
  });
}

// ============ 时区权重 ============

export async function getTaskHourWeights(taskId: number): Promise<any[]> {
  const result = await query('SELECT hour_slot, weight FROM task_hour_weights WHERE task_id = $1 ORDER BY hour_slot', [taskId]);
  return result.rows;
}

export async function setTaskHourWeights(taskId: number, weights: { hourSlot: number; weight: number }[]): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM task_hour_weights WHERE task_id = $1', [taskId]);
    for (const w of weights) {
      await client.query(
        'INSERT INTO task_hour_weights (task_id, hour_slot, weight) VALUES ($1, $2, $3)',
        [taskId, w.hourSlot, w.weight]
      );
    }
  });
}

// ============ 数据生成 ============

// 获取任务已生成数量（优先从 task_progress 表读取，兼容旧数据）
// 注意：如果 task_progress 与 keyword_search_rank 实际记录数差异过大（如历史导入导致），
// 以实际记录数为准，避免进度显示与实际不符
export async function getTaskGeneratedNum(taskId: number): Promise<number> {
  // 先从 task_progress 表读取（这是任务的实际进度）
  const progressResult = await query('SELECT generated_num FROM task_progress WHERE task_id = $1', [taskId]);
  const progressNum = progressResult.rows.length > 0 ? (parseInt(progressResult.rows[0].generated_num) || 0) : 0;

  // 统计 keyword_search_rank 实际记录数
  const result = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1', [taskId]);
  const actualNum = parseInt(result.rows[0].count);

  // 如果实际记录数远大于 progress 记录数（差异>100），说明是历史导入导致的不一致
  // 自动同步 progress 表，避免进度显示与实际不符
  if (actualNum > progressNum + 100) {
    console.log(`[Repository] 任务 ${taskId} 进度不一致: progress=${progressNum}, actual=${actualNum}，自动同步`);
    if (progressResult.rows.length > 0) {
      await query('UPDATE task_progress SET generated_num = $1, update_time = CURRENT_TIMESTAMP WHERE task_id = $2', [actualNum, taskId]);
    } else {
      await query('INSERT INTO task_progress (task_id, generated_num, update_time) VALUES ($1, $2, CURRENT_TIMESTAMP)', [taskId, actualNum]);
    }
    return actualNum;
  }

  return Math.max(progressNum, actualNum);
}

// 更新任务进度表（UPSERT）
export async function updateTaskProgress(taskId: number, generatedNum: number): Promise<void> {
  await query(
    `INSERT INTO task_progress (task_id, generated_num, update_time)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (task_id) DO UPDATE SET generated_num = $2, update_time = CURRENT_TIMESTAMP`,
    [taskId, generatedNum]
  );
}

// 生成单条数据
// 数据生成和查询收录分离：
// - 生成时 create_time = NOW()，query_time = NULL（尚未被查询收录）
// - 历史补齐时 create_time = 目标日期+时区权重随机时间，query_time = create_time（模拟过去的查询收录）
// - 查询收录动作触发时，UPDATE SET query_time = NOW()（实时收录，时间真实）
export async function generateOneRecord(client: PoolClient, params: {
  userId: string;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  taskId: number;
  targetDate: Date;
  hourWeights?: { hour_slot: number; weight: number }[];
  realtime?: boolean;
}) {
  if (params.realtime) {
    // 实时生成：create_time = clock_timestamp()（实时时间），query_time = NULL（等待查询展示）
    await client.query(
      `INSERT INTO keyword_search_rank
       (expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time, update_time, task_id)
       VALUES ($1, $2, $3, $4, NULL, clock_timestamp(), clock_timestamp(), $5)`,
      [params.expandedKeyword, params.distillateKeyword, params.platform, params.userId, params.taskId]
    );
  } else {
    // 历史补齐：query_time = create_time = 目标日期 + 时区权重随机时间（模拟过去的查询收录）
    const queryTime = randomTimeInDate(params.targetDate, params.hourWeights);
    await client.query(
      `INSERT INTO keyword_search_rank
       (expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time, update_time, task_id)
       VALUES ($1, $2, $3, $4, $5, $5, $5, $6)`,
      [params.expandedKeyword, params.distillateKeyword, params.platform, params.userId, queryTime, params.taskId]
    );
  }
}

// 查询展示动作：将待展示数据（query_time IS NULL）设置为已展示（query_time = clock_timestamp()）
// 使用 clock_timestamp() 确保返回实时时间
export async function collectRecords(taskId: number, count: number): Promise<number> {
  const result = await query(
    `UPDATE keyword_search_rank
     SET query_time = clock_timestamp(), update_time = clock_timestamp()
     WHERE id IN (
       SELECT id FROM keyword_search_rank
       WHERE task_id = $1 AND query_time IS NULL
       ORDER BY create_time ASC
       LIMIT $2
     )`,
    [taskId, count]
  );
  return result.rowCount || 0;
}

// 在指定日期范围内生成随机时间
// 支持时区权重：hourWeights 为 [{hour_slot, weight}]，slot 0=0-3, 1=3-6, ..., 7=21-24
// 若 hourWeights 为空或全为0，则使用默认分布（80% 集中在 8:00-24:00）
function randomTimeInDate(date: Date, hourWeights?: { hour_slot: number; weight: number }[]): Date {
  const result = new Date(date);

  // 检查是否有有效的时区权重
  const validWeights = (hourWeights || []).filter((w) => w.weight > 0);

  if (validWeights.length > 0) {
    // 使用时区权重：构建加权时段列表
    const weightedSlots: number[] = [];
    for (const w of validWeights) {
      for (let i = 0; i < w.weight; i++) {
        weightedSlots.push(w.hour_slot);
      }
    }

    // 随机选择一个时段
    const selectedSlot = weightedSlots[Math.floor(Math.random() * weightedSlots.length)];
    const startHour = selectedSlot * 3; // slot 0 -> 0:00, slot 1 -> 3:00, ...
    // 在该时段的3小时内随机生成时间
    // 注意：使用setUTCHours确保写入数据库的是UTC时间，避免本地时区转换导致偏移
    result.setUTCHours(startHour + Math.floor(Math.random() * 3));
    result.setUTCMinutes(Math.floor(Math.random() * 60));
    result.setUTCSeconds(Math.floor(Math.random() * 60));
  } else {
    // 默认分布：80% 集中在 8:00-24:00（UTC时间）
    const isPeak = Math.random() < 0.8;
    if (isPeak) {
      // 8:00 - 23:59:59
      result.setUTCHours(8 + Math.floor(Math.random() * 16));
      result.setUTCMinutes(Math.floor(Math.random() * 60));
      result.setUTCSeconds(Math.floor(Math.random() * 60));
    } else {
      // 0:00 - 7:59:59
      result.setUTCHours(Math.floor(Math.random() * 8));
      result.setUTCMinutes(Math.floor(Math.random() * 60));
      result.setUTCSeconds(Math.floor(Math.random() * 60));
    }
  }

  return result;
}

// 批量生成数据
// realtime=true: 当下实时生成，query_time=create_time=NOW()
// realtime=false: 历史补齐，query_time=create_time=目标日期+时区权重随机时间
export async function generateBatch(params: {
  userId: string;
  taskId: number;
  count: number;
  weights: { platform: string; weight: number }[];
  zlgjcList: { value: string; hxgjc: string }[];
  brandZlgjcList?: { value: string; hxgjc: string }[];
  ppList: string[];
  targetDate: Date;
  hourWeights?: { hour_slot: number; weight: number }[];
  realtime?: boolean;
}): Promise<void> {
  await withTransaction(async (client) => {
    // 构建加权平台列表
    const weightedPlatforms: string[] = [];
    for (const w of params.weights) {
      for (let i = 0; i < w.weight; i++) {
        weightedPlatforms.push(w.platform);
      }
    }

    // 品牌关键词池：优先使用 brandZlgjcList（keyword_type=1），为空则不生成品牌记录
    const brandPool = params.brandZlgjcList && params.brandZlgjcList.length > 0 ? params.brandZlgjcList : [];

    for (let i = 0; i < params.count; i++) {
      // 有品牌关键词池时，20% 概率生成品牌搜索记录；否则全部生成蒸馏关键词记录
      const isBrand = brandPool.length > 0 && params.ppList.length > 0 && Math.random() < 0.2;
      let expandedKeyword: string;
      let distillateKeyword: string;

      if (isBrand) {
        // 品牌搜索记录：expanded_keyword 来自品牌词表 pp，distillate_keyword 来自品牌关键词池（keyword_type=1）
        expandedKeyword = params.ppList[Math.floor(Math.random() * params.ppList.length)];
        const brandKw = brandPool[Math.floor(Math.random() * brandPool.length)];
        distillateKeyword = brandKw.value;
      } else {
        // 蒸馏关键词记录：expanded_keyword 和 distillate_keyword 都来自蒸馏关键词池（keyword_type=0）
        const zlgjc = params.zlgjcList[Math.floor(Math.random() * params.zlgjcList.length)];
        expandedKeyword = zlgjc.hxgjc || zlgjc.value;
        distillateKeyword = zlgjc.value;
      }

      // 随机选择平台
      const platform = weightedPlatforms[Math.floor(Math.random() * weightedPlatforms.length)] || '豆包';

      await generateOneRecord(client, {
        userId: params.userId,
        expandedKeyword,
        distillateKeyword,
        platform,
        taskId: params.taskId,
        targetDate: params.targetDate,
        hourWeights: params.hourWeights,
        realtime: params.realtime,
      });
    }

    // 更新用户数据时间（使用北京时间）
    await client.query(
      "UPDATE users SET date_time = to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1",
      [params.userId]
    );
  });
}

// 获取/创建每日随机数
export async function getOrCreateDailyRandom(taskId: number, date: Date): Promise<number> {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const existing = await query(
    'SELECT random_num FROM daily_random WHERE task_id = $1 AND random_date = $2',
    [taskId, dateStr]
  );

  if (existing.rows.length > 0) {
    return parseInt(existing.rows[0].random_num);
  }

  // 创建新的随机数（这里返回0，实际由调度器计算）
  return 0;
}

export async function setDailyRandom(taskId: number, date: Date, num: number): Promise<void> {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  await query(
    `INSERT INTO daily_random (task_id, random_date, random_num)
     VALUES ($1, $2, $3)
     ON CONFLICT (task_id, random_date) DO UPDATE SET random_num = $3`,
    [taskId, dateStr, num]
  );
}

// ============ 核心关键词（distillate_keyword）============

// 分页查询核心关键词
export async function getDistillateKeywordsByPage(userId: string, pageNum: number, pageSize: number) {
  const offset = (pageNum - 1) * pageSize;
  const countResult = await query('SELECT COUNT(*) as total FROM distillate_keyword WHERE user_id = $1', [userId]);
  const total = parseInt(countResult.rows[0].total);
  const result = await query(
    'SELECT id, distillate_keyword, user_id, zt, create_time FROM distillate_keyword WHERE user_id = $1 ORDER BY id LIMIT $2 OFFSET $3',
    [userId, pageSize, offset]
  );
  // 将字段名转为驼峰格式以兼容前端
  const list = result.rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    distillateKeyword: r.distillate_keyword,
    zt: String(r.zt),
    createTime: r.create_time,
  }));
  return { list, total };
}

// 新增核心关键词
export async function insertDistillateKeyword(userId: string, keyword: string): Promise<number> {
  const result = await query(
    'INSERT INTO distillate_keyword (distillate_keyword, user_id, zt) VALUES ($1, $2, 1) RETURNING id',
    [keyword, userId]
  );
  return result.rows[0].id;
}

// 删除核心关键词
export async function deleteDistillateKeyword(id: number): Promise<void> {
  await query('DELETE FROM distillate_keyword WHERE id = $1', [id]);
}

// ============ 蒸馏关键词库（zlgjc）分页查询和删除 ============

// 分页查询蒸馏关键词库
export async function getZlgjcByPage(userId: string, pageNum: number, pageSize: number, keywordType: number = 0) {
  const offset = (pageNum - 1) * pageSize;
  const countResult = await query('SELECT COUNT(*) as total FROM zlgjc WHERE userid = $1 AND keyword_type = $2', [userId, keywordType]);
  const total = parseInt(countResult.rows[0].total);
  const result = await query(
    'SELECT id, value, hxgjc, userid, lxfs, create_time FROM zlgjc WHERE userid = $1 AND keyword_type = $2 ORDER BY id LIMIT $3 OFFSET $4',
    [userId, keywordType, pageSize, offset]
  );
  const list = result.rows.map((r: any) => ({
    id: r.id,
    value: r.value,
    userId: r.userid,
    hxgjc: r.hxgjc,
    lxfs: r.lxfs,
    createTime: r.create_time,
  }));
  return { list, total };
}

// 手动去重：删除同一用户同一keyword_type下value重复的关键词（保留id最小的）
export async function deduplicateZlgjc(userId: string, keywordType: number): Promise<{ deleted: number; remaining: number }> {
  // 先查询总数
  const beforeResult = await query(
    'SELECT COUNT(*) as total FROM zlgjc WHERE userid = $1 AND keyword_type = $2',
    [userId, keywordType]
  );
  const beforeCount = parseInt(beforeResult.rows[0].total) || 0;

  // 删除重复记录（保留每组value中id最小的一条）
  const deleteResult = await query(
    `DELETE FROM zlgjc
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY value, userid, keyword_type ORDER BY id ASC) as rn
         FROM zlgjc
         WHERE userid = $1 AND keyword_type = $2
       ) t WHERE rn > 1
     )`,
    [userId, keywordType]
  );

  const deleted = deleteResult.rowCount || 0;

  // 查询去重后的数量
  const afterResult = await query(
    'SELECT COUNT(*) as total FROM zlgjc WHERE userid = $1 AND keyword_type = $2',
    [userId, keywordType]
  );
  const remaining = parseInt(afterResult.rows[0].total) || 0;

  return { deleted, remaining };
}

// 删除蒸馏关键词（级联删除跳转链接）
export async function deleteZlgjc(id: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zlgjcurl WHERE zlgjcid = $1', [id]);
    await client.query('DELETE FROM zlgjc WHERE id = $1', [id]);
  });
}

// ============ 蒸馏关键词生成（笛卡尔积）============

// 生成蒸馏关键词（笛卡尔积组合）
export async function generateZlgjcKeywords(userId: string, wordGroups: { A: string[]; B: string[]; C: string[]; D: string[]; E: string[]; F: string[]; G: string[] }, keywordType: number = 0) {
  const { A, B, C, D, E, F, G } = wordGroups;

  // 根据组合规则生成所有组合
  const combinations: { keyword: string; hxgjc: string }[] = [];
  for (const combo of G) {
    const parts = combo.split('+');
    const arrays: string[][] = parts.map(p => {
      switch (p) {
        case 'A': return A;
        case 'B': return B;
        case 'C': return C;
        case 'D': return D;
        case 'E': return E;
        case 'F': return F;
        default: return [];
      }
    });

    // 笛卡尔积
    const cartesian = arrays.reduce<string[][]>((acc, curr) => {
      if (acc.length === 0) return curr.map(v => [v]);
      const result: string[][] = [];
      for (const a of acc) {
        for (const c of curr) {
          result.push([...a, c]);
        }
      }
      return result;
    }, []);

    for (const c of cartesian) {
      const keyword = c.join('');
      // 确定核心词（hxgjc）：
      // - 蒸馏关键词（keywordType=0）：用C主词
      // - 品牌关键词（keywordType=1）：优先用B核心词，组合不含B时用A品牌词
      let hxgjc = '';
      if (keywordType === 1) {
        const bIdx = parts.indexOf('B');
        if (bIdx >= 0) {
          hxgjc = c[bIdx] || '';
        } else {
          const aIdx = parts.indexOf('A');
          hxgjc = aIdx >= 0 ? (c[aIdx] || '') : '';
        }
      } else {
        const cIdx = parts.indexOf('C');
        hxgjc = cIdx >= 0 ? (c[cIdx] || '') : '';
      }
      combinations.push({ keyword, hxgjc });
    }
  }

  // 查询已存在的关键词（同类型内去重）
  const existingResult = await query('SELECT value FROM zlgjc WHERE userid = $1 AND keyword_type = $2', [userId, keywordType]);
  const existing = new Set(existingResult.rows.map((r: any) => r.value));

  let inserted = 0;
  let duplicated = 0;

  for (const { keyword, hxgjc } of combinations) {
    if (existing.has(keyword)) {
      duplicated++;
    } else {
      // ON CONFLICT 双保险：即使应用层去重失败，数据库层也会拒绝重复
      await query(
        `INSERT INTO zlgjc (value, hxgjc, userid, lxfs, keyword_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (userid, value, keyword_type) DO NOTHING`,
        [keyword, hxgjc, userId, '', keywordType]
      );
      existing.add(keyword);
      inserted++;
    }
  }

  return {
    inserted,
    duplicated,
    total: combinations.length,
    debug: {
      combos: G,
      wordCounts: { A: A.length, B: B.length, C: C.length, D: D.length, E: E.length, F: F.length },
      keywordType,
      sample: combinations.slice(0, 20).map(c => ({ keyword: c.keyword, hxgjc: c.hxgjc })),
    },
  };
}

// ============ 关键词生成器配置 ============

// 保存关键词生成器配置
export async function saveKwConfig(userId: string, configType: string, configJson: string): Promise<void> {
  await query(
    `INSERT INTO kw_config (user_id, config_type, config_json, update_time)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, config_type)
     DO UPDATE SET config_json = $3, update_time = NOW()`,
    [userId, configType, configJson]
  );
}

// 获取关键词生成器配置
export async function getKwConfig(userId: string, configType: string): Promise<string | null> {
  const result = await query(
    'SELECT config_json FROM kw_config WHERE user_id = $1 AND config_type = $2',
    [userId, configType]
  );
  return result.rows.length > 0 ? result.rows[0].config_json : null;
}

/**
 * 解析词汇字段，兼容字符串（TextArea 原文含换行）和字符串数组两种格式
 * 前端保存时 A/B/C/D/E/F 是 TextArea 字符串（如 "市面上\n行业内\n市场"）
 * 必须用 split 拆分成数组才能用于关键词生成
 */
function parseWordList(v: any): string[] {
  if (Array.isArray(v)) {
    return v.filter((w: any) => typeof w === 'string' && w.trim()).map((w: string) => w.trim());
  }
  if (typeof v === 'string') {
    return v.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 获取蒸馏关键词库可用的前缀屏蔽词选项
 * 来源：kw_config 表中 config_type='distillate' 的 A 组词（编号A，排在组合最前面）
 * 若用户未保存配置，返回默认 A 组词
 */
export async function getExcludePrefixOptions(userId: string): Promise<string[]> {
  const configJson = await getKwConfig(userId, 'distillate');
  let A: string[] = ['市面上', '行业内', '市场', '目前', '国内'];
  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      const parsed = parseWordList(config.A);
      if (parsed.length > 0) {
        A = parsed;
      }
    } catch {}
  }
  return A;
}

// 自动为新添加的核心词生成蒸馏关键词
export async function autoGenerateDistillateKeywords(userId: string, coreKeyword: string): Promise<{ inserted: number; duplicated: number }> {
  // 获取用户保存的蒸馏关键词配置
  const configJson = await getKwConfig(userId, 'distillate');
  let A: string[] = ['市面上', '行业内', '市场', '目前', '国内'];
  let B: string[] = ['口碑好的', '比较好的', '靠谱的', '有实力的', '可靠的', '诚信的', '正规的', '专业的', '热门的', '知名的', '优秀的'];
  let D: string[] = ['品牌', '公司', '工厂', '厂家', '厂商', '生产厂家', '源头厂家', '批发厂家', '加工厂'];
  let E: string[] = ['推荐', '排行', '推荐榜', '排行榜', '排名'];
  let F: string[] = ['哪家好', '哪家强', '哪家靠谱', '推荐几家'];
  let G: string[] = ['C+D', 'A+C+D', 'B+C+D'];

  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      // 兼容前端保存的字符串格式（TextArea 原文含 \n）
      const parsedA = parseWordList(config.A);
      const parsedB = parseWordList(config.B);
      const parsedD = parseWordList(config.D);
      const parsedE = parseWordList(config.E);
      const parsedF = parseWordList(config.F);
      if (parsedA.length > 0) A = parsedA;
      if (parsedB.length > 0) B = parsedB;
      if (parsedD.length > 0) D = parsedD;
      if (parsedE.length > 0) E = parsedE;
      if (parsedF.length > 0) F = parsedF;
      if (Array.isArray(config.combos)) G = config.combos.filter((c: any) => typeof c === 'string' && c.trim());
    } catch {}
  }

  const result = await generateZlgjcKeywords(userId, {
    A, B, C: [coreKeyword], D, E, F, G
  }, 0);
  return { inserted: result.inserted, duplicated: result.duplicated };
}

// 自动为新添加的品牌词生成品牌关键词
export async function autoGenerateBrandKeywords(userId: string, brandWord: string): Promise<{ inserted: number; duplicated: number }> {
  // 获取用户保存的品牌关键词配置
  const configJson = await getKwConfig(userId, 'brand');
  let C: string[] = ['价格', '报价', '厂家', '多少钱', '费用', '成本'];
  let D: string[] = ['怎么样', '好不好', '哪个好', '靠谱吗', '值得买吗', '好不好用'];
  let G: string[] = ['A', 'A+B', 'A+C'];

  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      // 兼容前端保存的字符串格式（TextArea 原文含 \n）
      const parsedC = parseWordList(config.C);
      const parsedD = parseWordList(config.D);
      if (parsedC.length > 0) C = parsedC;
      if (parsedD.length > 0) D = parsedD;
      if (Array.isArray(config.combos)) G = config.combos.filter((c: any) => typeof c === 'string' && c.trim());
    } catch {}
  }

  // 获取核心关键词作为B字段
  const dkResult = await query(
    'SELECT distillate_keyword FROM distillate_keyword WHERE user_id = $1 ORDER BY id',
    [userId]
  );
  const B: string[] = dkResult.rows.map((r: any) => r.distillate_keyword).filter(Boolean);

  const result = await generateZlgjcKeywords(userId, {
    A: [brandWord], B, C, D, E: [], F: [], G
  }, 1);
  return { inserted: result.inserted, duplicated: result.duplicated };
}

// ============ 真实查询任务队列 ============

// 将任务放入队列
export async function enqueueRealCollectTask(task: any, keywords: string[], priority: number = 0): Promise<number> {
  const result = await query(
    `INSERT INTO real_collect_queue (task_id, user_id, keyword_type, platforms, keywords, status, priority)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id`,
    [task.id, task.user_id, task.keyword_type, task.platforms, JSON.stringify(keywords), priority]
  );
  return result.rows[0].id;
}

// Worker从队列消费任务（原子操作，防止多Worker竞争）
// 严格轮询策略：优先级高的先执行；同优先级内，选择"最近最少执行"的task的下一个分片
// 重要：必须 JOIN real_collect_task 过滤 t.status='active'，否则暂停（status='paused'）
// 的任务其 pending 分片仍会被消费，导致"暂停后日志依旧在更新"的问题。
export async function dequeueRealCollectTask(workerId: string): Promise<any | null> {
  // 使用子查询找出"该task最近一次running/done的时间"最早的task，
  // 然后从该task的pending分片中取最早入队的一个
  const result = await query(
    `UPDATE real_collect_queue
     SET status = 'running', worker_id = $1, start_time = NOW()
     WHERE id = (
       WITH ranked AS (
         SELECT
           q.id,
           q.task_id,
           q.priority,
           q.create_time,
           -- 计算该task最近一次被消费的时间（running/done/failed的最大start_time）
           COALESCE(
             (SELECT MAX(q2.start_time) FROM real_collect_queue q2
              WHERE q2.task_id = q.task_id AND q2.status IN ('running','done','failed')),
             '1970-01-01'::timestamp
           ) as last_consumed
         FROM real_collect_queue q
         INNER JOIN real_collect_task t ON t.id = q.task_id
         WHERE q.status = 'pending'
           AND t.status = 'active'
       )
       SELECT r.id FROM ranked r
       ORDER BY r.priority DESC, r.last_consumed ASC, r.create_time ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, task_id, user_id, keyword_type, platforms, keywords, last_keyword_index`,
    [workerId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  // 查询任务级别的 query_mode 配置（透传给 Worker 决定走 API 还是爬虫）
  const taskRow = await query(
    `SELECT query_mode FROM real_collect_task WHERE id = $1`,
    [row.task_id]
  );
  const queryMode = taskRow.rows.length > 0 ? (taskRow.rows[0].query_mode || 'auto') : 'auto';
  return {
    queueId: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    keywordType: row.keyword_type,
    platforms: row.platforms,
    keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords,
    lastKeywordIndex: row.last_keyword_index ?? -1,
    queryMode,
  };
}

// Worker回写队列结果
export async function completeQueueTask(queueId: number, recordCount: number, brandCount: number, error?: string): Promise<void> {
  await query(
    `UPDATE real_collect_queue
     SET status = $1, result_record_count = $2, result_brand_count = $3, error = $4, end_time = NOW()
     WHERE id = $5`,
    [error ? 'failed' : 'done', recordCount, brandCount, error || null, queueId]
  );
}

// ============ v2.0.0: 分片级 AEO 报告 ============

/** 分片级 AEO 报告记录 */
export interface AeoShardReport {
  id: number;
  task_id: number;
  queue_id: number;
  user_id: string | null;
  round_no: number | null;
  shard_keywords: any;
  sentiment_summary: any;
  brand_mentions: any;
  negative_findings: any;
  content_suggestions: string | null;
  record_count: number;
  brand_matched_count: number;
  visibility_score: number;
  positive_ratio: number;
  negative_ratio: number;
  neutral_ratio: number;
  raw_analysis: any;
  shard_start_time: string | null;
  shard_end_time: string | null;
  created_at: string;
}

/** 获取分片队列信息（含 start_time/end_time/keywords/task_id/user_id/round_no） */
export async function getQueueInfoForShardReport(queueId: number): Promise<any | null> {
  const result = await query(
    `SELECT id, task_id, user_id, round_no, keywords, start_time, end_time, status,
            result_record_count, result_brand_count
     FROM real_collect_queue
     WHERE id = $1`,
    [queueId]
  );
  return result.rows[0] || null;
}

/** 按时间窗口查询品牌命中记录（分片级 AEO 分析用） */
export async function getRecordsByTimeWindow(
  taskId: number,
  startTime: Date,
  endTime: Date
): Promise<any[]> {
  const result = await query(
    `SELECT id, task_id, user_id, keyword, platform, brand_matched, matched_brands,
            share_url, raw_content, query_time
     FROM real_collect_record
     WHERE task_id = $1
       AND query_time >= $2
       AND query_time <= $3
       AND brand_matched = true
     ORDER BY query_time ASC`,
    [taskId, startTime, endTime]
  );
  return result.rows;
}

/** 插入分片级 AEO 报告 */
export async function insertAeoShardReport(data: {
  task_id: number;
  queue_id: number;
  user_id?: string;
  round_no?: number;
  shard_keywords?: any;
  sentiment_summary?: any;
  brand_mentions?: any;
  negative_findings?: any;
  content_suggestions?: string;
  record_count?: number;
  brand_matched_count?: number;
  visibility_score?: number;
  positive_ratio?: number;
  negative_ratio?: number;
  neutral_ratio?: number;
  raw_analysis?: any;
  shard_start_time?: Date;
  shard_end_time?: Date;
}): Promise<number> {
  const result = await query(
    `INSERT INTO aeo_shard_report
      (task_id, queue_id, user_id, round_no, shard_keywords,
       sentiment_summary, brand_mentions, negative_findings, content_suggestions,
       record_count, brand_matched_count, visibility_score,
       positive_ratio, negative_ratio, neutral_ratio,
       raw_analysis, shard_start_time, shard_end_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [
      data.task_id,
      data.queue_id,
      data.user_id || null,
      data.round_no || null,
      data.shard_keywords ? JSON.stringify(data.shard_keywords) : null,
      data.sentiment_summary ? JSON.stringify(data.sentiment_summary) : null,
      data.brand_mentions ? JSON.stringify(data.brand_mentions) : null,
      data.negative_findings ? JSON.stringify(data.negative_findings) : null,
      data.content_suggestions || null,
      data.record_count || 0,
      data.brand_matched_count || 0,
      data.visibility_score || 0,
      data.positive_ratio || 0,
      data.negative_ratio || 0,
      data.neutral_ratio || 0,
      data.raw_analysis ? JSON.stringify(data.raw_analysis) : null,
      data.shard_start_time || null,
      data.shard_end_time || null,
    ]
  );
  return result.rows[0].id;
}

/** 检查分片是否已生成过 AEO 报告（避免重复分析） */
export async function checkShardReportExists(queueId: number): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM aeo_shard_report WHERE queue_id = $1 LIMIT 1`,
    [queueId]
  );
  return result.rows.length > 0;
}

/** 查询分片级 AEO 报告列表（分页） */
export async function getAeoShardReports(
  taskId?: number,
  userId?: number,
  limit: number = 50,
  offset: number = 0
): Promise<{ list: AeoShardReport[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  if (taskId) {
    params.push(taskId);
    conditions.push(`task_id = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) AS total FROM aeo_shard_report ${where}`, params);
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT * FROM aeo_shard_report ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { list: result.rows as AeoShardReport[], total };
}

/** 获取单个分片级 AEO 报告详情 */
export async function getAeoShardReportById(id: number): Promise<AeoShardReport | null> {
  const result = await query(`SELECT * FROM aeo_shard_report WHERE id = $1`, [id]);
  return (result.rows[0] as AeoShardReport) || null;
}

/** 获取指定时间范围内的分片报告（周/月报汇总用） */
export async function getShardReportsByTimeRange(
  userId: string,
  startTime: Date,
  endTime: Date
): Promise<AeoShardReport[]> {
  const result = await query(
    `SELECT * FROM aeo_shard_report
     WHERE user_id = $1
       AND created_at >= $2
       AND created_at <= $3
     ORDER BY created_at ASC`,
    [userId, startTime, endTime]
  );
  return result.rows as AeoShardReport[];
}

// Worker更新分片处理进度（记录已处理到的关键词索引，重启后从断点续查）
export async function updateQueueProgress(queueId: number, lastKeywordIndex: number): Promise<void> {
  await query(
    `UPDATE real_collect_queue SET last_keyword_index = $1 WHERE id = $2`,
    [lastKeywordIndex, queueId]
  );
}

// 获取队列中pending的任务数
export async function getQueuePendingCount(): Promise<number> {
  const result = await query("SELECT COUNT(*) as count FROM real_collect_queue WHERE status = 'pending'");
  return parseInt(result.rows[0].count) || 0;
}

// 获取队列中running的任务数
export async function getQueueRunningCount(): Promise<number> {
  const result = await query("SELECT COUNT(*) as count FROM real_collect_queue WHERE status = 'running'");
  return parseInt(result.rows[0].count) || 0;
}

// 请求中断指定队列任务
export async function requestQueueAbort(queueId: number): Promise<boolean> {
  const result = await query(
    `UPDATE real_collect_queue SET abort_requested = true WHERE id = $1 AND status = 'running'`,
    [queueId]
  );
  return (result.rowCount || 0) > 0;
}

// 检查队列任务是否被请求中断
export async function checkQueueAbort(queueId: number): Promise<boolean> {
  const result = await query(
    `SELECT abort_requested FROM real_collect_queue WHERE id = $1`,
    [queueId]
  );
  return result.rows[0]?.abort_requested === true;
}

// 中断所有正在运行的队列任务（用于紧急停止）
export async function abortAllRunningTasks(): Promise<number> {
  const result = await query(
    `UPDATE real_collect_queue SET abort_requested = true WHERE status = 'running'`
  );
  return result.rowCount || 0;
}

// 获取当前正在运行的队列任务
export async function getRunningQueueTask(): Promise<any | null> {
  const result = await query(
    `SELECT id, task_id, user_id, keyword_type, platforms, start_time, abort_requested
     FROM real_collect_queue
     WHERE status = 'running'
     ORDER BY start_time DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

// 获取任务的分片执行进度（按 task_id 聚合当前轮次的队列状态）
export async function getTaskShardProgress(taskId: number): Promise<{
  taskId: number;
  totalShards: number;
  completedShards: number;
  runningShards: number;
  pendingShards: number;
  failedShards: number;
  totalKeywords: number;
  shardSize: number;
  roundNo: number;
  currentShardIndex: number; // 当前正在执行的分片序号（从1开始，0表示无正在执行的分片）
  currentKeywordIndex: number; // 当前分片已处理到的关键词索引（从0开始，-1表示未开始）
  currentShardKeywordCount: number; // 当前分片的关键词总数
  brandHitCount: number; // 本轮命中品牌次数
  totalRecords: number; // 本轮总查询记录数
  brandHitRate: number; // 本轮命中率（百分比，0-100）
}> {
  // 获取任务配置
  const taskResult = await query(
    `SELECT shard_size, round_no, round_start_time FROM real_collect_task WHERE id = $1`,
    [taskId]
  );
  const shardSize = taskResult.rows[0]?.shard_size || 50;
  const roundNo = taskResult.rows[0]?.round_no || 0;
  const roundStartTime = taskResult.rows[0]?.round_start_time;

  // 统计当前轮次的队列分片状态
  // 用 round_no 精准过滤当前轮次（避免 round_start_time 为 NULL 时回退到 1970-01-01 导致跨轮次累计）
  // 兼容旧数据：若 queue 表 round_no 为 0（旧分片），回退用 create_time >= round_start_time 过滤
  // 修复：当 round_start_time 为 NULL 时，不再用 create_time >= q.create_time（恒为 true，会统计所有历史分片），
  //       改为只统计最近 24 小时内的分片，避免跨轮次累计（如 133 个历史分片被全部计入）
  const result = await query(
    `WITH task_round AS (
       SELECT id, round_no, round_start_time FROM real_collect_task WHERE id = $1
     )
     SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE q.status = 'done') as completed,
       COUNT(*) FILTER (WHERE q.status = 'running') as running,
       COUNT(*) FILTER (WHERE q.status = 'pending') as pending,
       COUNT(*) FILTER (WHERE q.status = 'failed') as failed,
       COALESCE(SUM(jsonb_array_length(q.keywords)), 0) as total_keywords
     FROM real_collect_queue q, task_round tr
     WHERE q.task_id = $1
       AND (
         (tr.round_no > 0 AND q.round_no = tr.round_no)
         OR
         (tr.round_no = 0 AND q.round_no = 0 AND q.create_time >= COALESCE(tr.round_start_time, NOW() - INTERVAL '24 hours'))
       )`,
    [taskId]
  );
  const row = result.rows[0] || {};

  // 查询当前正在执行的 running 分片的详细进度
  // 按 create_time 排序，取最早的 running 分片（即正在执行的分片）
  const runningResult = await query(
    `WITH task_round AS (
       SELECT id, round_no, round_start_time FROM real_collect_task WHERE id = $1
     )
     SELECT q.id, q.last_keyword_index, jsonb_array_length(q.keywords) as keyword_count
     FROM real_collect_queue q, task_round tr
     WHERE q.task_id = $1 AND q.status = 'running'
       AND (
         (tr.round_no > 0 AND q.round_no = tr.round_no)
         OR
         (tr.round_no = 0 AND q.round_no = 0 AND q.create_time >= COALESCE(tr.round_start_time, NOW() - INTERVAL '24 hours'))
       )
     ORDER BY q.start_time ASC
     LIMIT 1`,
    [taskId]
  );

  // 查询本轮命中品牌次数和总查询记录数
  // real_collect_record 表没有 round_no 字段，改用 query_time >= round_start_time 过滤当前轮次
  // 如果 round_start_time 为 NULL，统计该任务的所有记录
  let brandHitCount = 0;
  let totalRecords = 0;
  let brandHitRate = 0;
  try {
    let brandResult;
    if (roundStartTime) {
      brandResult = await query(
        `SELECT
           COUNT(*) as total_records,
           COUNT(*) FILTER (WHERE brand_matched = true) as brand_hits
         FROM real_collect_record
         WHERE task_id = $1 AND query_time >= $2`,
        [taskId, roundStartTime]
      );
    } else {
      // round_start_time 为 NULL，统计该任务的所有记录
      brandResult = await query(
        `SELECT
           COUNT(*) as total_records,
           COUNT(*) FILTER (WHERE brand_matched = true) as brand_hits
         FROM real_collect_record
         WHERE task_id = $1`,
        [taskId]
      );
    }
    totalRecords = parseInt(brandResult.rows[0]?.total_records || '0');
    brandHitCount = parseInt(brandResult.rows[0]?.brand_hits || '0');
    brandHitRate = totalRecords > 0 ? Math.round((brandHitCount / totalRecords) * 1000) / 10 : 0;
  } catch {
    // 表不存在或查询失败，返回0
  }

  // 计算当前正在执行的分片序号（已完成分片数 + 1）
  const completedCount = parseInt(row.completed || '0');
  const runningShard = runningResult.rows[0];
  const currentShardIndex = runningShard ? completedCount + 1 : 0;
  const currentKeywordIndex = runningShard?.last_keyword_index ?? -1;
  const currentShardKeywordCount = runningShard ? parseInt(runningShard.keyword_count || '0') : 0;

  return {
    taskId,
    totalShards: parseInt(row.total || '0'),
    completedShards: completedCount,
    runningShards: parseInt(row.running || '0'),
    pendingShards: parseInt(row.pending || '0'),
    failedShards: parseInt(row.failed || '0'),
    totalKeywords: parseInt(row.total_keywords || '0'),
    shardSize,
    roundNo,
    currentShardIndex,
    currentKeywordIndex,
    currentShardKeywordCount,
    brandHitCount,
    totalRecords,
    brandHitRate,
  };
}

// ============ 循环调度相关 ============

/** 服务器重启时恢复：将所有 running 状态的队列任务重置为 pending */
export async function resetRunningQueueOnRestart(): Promise<number> {
  const result = await query(
    `UPDATE real_collect_queue
     SET status = 'pending', worker_id = NULL, start_time = NULL
     WHERE status = 'running'`
  );
  return result.rowCount || 0;
}

/** 检查任务当前轮次是否全部完成（所有分片 done/failed，无 pending/running） */
export async function isTaskRoundComplete(taskId: number): Promise<boolean> {
  const result = await query(
    `WITH task_round AS (
       SELECT id, round_no FROM real_collect_task WHERE id = $1
     )
     SELECT
       COUNT(*) FILTER (WHERE q.status IN ('pending', 'running')) as unfinished,
       COUNT(*) as total
     FROM real_collect_queue q, task_round tr
     WHERE q.task_id = $1
       AND (
         (tr.round_no > 0 AND q.round_no = tr.round_no)
         OR
         (tr.round_no = 0 AND q.round_no = 0)
       )`,
    [taskId]
  );
  const row = result.rows[0] || {};
  const total = parseInt(row.total || '0');
  const unfinished = parseInt(row.unfinished || '0');
  return total > 0 && unfinished === 0;
}

/** 开始任务的新一轮：递增 round_no，设置 round_start_time，入队全部分片 */
export async function startNewRound(
  taskId: number,
  keywords: string[],
  shardSize: number,
  priority: number = 0
): Promise<{ roundNo: number; shardCount: number; firstQueueId: number }> {
  // 递增轮次号并设置轮次开始时间
  const taskResult = await query(
    `UPDATE real_collect_task
     SET round_no = round_no + 1, round_start_time = NOW()
     WHERE id = $1
     RETURNING round_no`,
    [taskId]
  );
  const roundNo = taskResult.rows[0]?.round_no || 1;

  // 清理旧轮次已完成的 queue 记录，避免表无限膨胀（保留最近一轮用于审计）
  if (roundNo > 1) {
    await query(
      `DELETE FROM real_collect_queue
       WHERE task_id = $1 AND round_no > 0 AND round_no < $2 AND status = 'done'`,
      [taskId, roundNo - 1]
    );
  }

  // 分片入队（切片前用 Set 去重，双保险防止 zlgjc 表重复入库导致关键词翻倍）
  const uniqueKeywords = [...new Set(keywords.filter(k => k && k.trim()))];
  if (uniqueKeywords.length < keywords.length) {
    console.log(`[RealCollect] 任务 ${taskId} 关键词去重: ${keywords.length} → ${uniqueKeywords.length}（删除 ${keywords.length - uniqueKeywords.length} 条重复）`);
  }

  // 前缀词屏蔽：读取任务配置的 exclude_prefixes，过滤掉以这些前缀开头的关键词
  // 仅对蒸馏词库（keyword_type=0）生效，用于跳过不需要查询的关键词
  let filteredKeywords = uniqueKeywords;
  const taskConfig = await query(`SELECT exclude_prefixes, keyword_type FROM real_collect_task WHERE id = $1`, [taskId]);
  const excludePrefixesJson = taskConfig.rows[0]?.exclude_prefixes;
  const taskKeywordType = taskConfig.rows[0]?.keyword_type;
  if (excludePrefixesJson && taskKeywordType === 0) {
    let prefixes: string[] = [];
    try {
      prefixes = JSON.parse(excludePrefixesJson).filter((p: string) => p && p.trim());
    } catch {
      prefixes = [];
    }
    if (prefixes.length > 0) {
      filteredKeywords = uniqueKeywords.filter(kw => !prefixes.some(p => kw.startsWith(p)));
      if (filteredKeywords.length < uniqueKeywords.length) {
        console.log(`[RealCollect] 任务 ${taskId} 前缀屏蔽: ${uniqueKeywords.length} → ${filteredKeywords.length}（屏蔽前缀: [${prefixes.join(', ')}]，删除 ${uniqueKeywords.length - filteredKeywords.length} 条）`);
      }
    }
  }

  const size = Math.max(1, shardSize);
  const shards: string[][] = [];
  for (let i = 0; i < filteredKeywords.length; i += size) {
    shards.push(filteredKeywords.slice(i, i + size));
  }

  let firstQueueId = 0;
  for (const shard of shards) {
    const result = await query(
      `INSERT INTO real_collect_queue (task_id, user_id, keyword_type, platforms, keywords, status, priority, round_no)
       SELECT $1, user_id, keyword_type, platforms, $2, 'pending', $3, $4
       FROM real_collect_task WHERE id = $1
       RETURNING id`,
      [taskId, JSON.stringify(shard), priority, roundNo]
    );
    if (firstQueueId === 0) firstQueueId = result.rows[0].id;
  }

  return { roundNo, shardCount: shards.length, firstQueueId };
}

/** 获取需要启动新一轮的任务（active 且当前轮次无 pending 分片） */
export async function getTasksNeedingNewRound(): Promise<any[]> {
  // 找出 active 任务中，当前没有 pending 分片的
  const result = await query(
    `SELECT t.id, t.user_id, t.task_name, t.keyword_type, t.platforms, t.shard_size, t.round_no, t.exclude_prefixes
     FROM real_collect_task t
     WHERE t.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM real_collect_queue q
         WHERE q.task_id = t.id AND q.status = 'pending'
       )
     ORDER BY t.id`
  );
  return result.rows;
}

/**
 * 清理旧的、未分片的 pending 队列项
 * 分片机制生效前入队的队列项可能包含全部关键词（数万个），
 * 会导致 Worker 内存爆炸和 Page crashed。
 * 此函数删除 keywords 数量超过 shardSize 的 pending 队列项，返回受影响的 task_id 列表。
 */
export async function cleanOversizedPendingShards(): Promise<number[]> {
  // 找出所有 pending 队列项中 keywords 数量超过对应任务 shardSize 的
  const result = await query(
    `SELECT q.id, q.task_id
     FROM real_collect_queue q
     JOIN real_collect_task t ON q.task_id = t.id
     WHERE q.status = 'pending'
       AND jsonb_array_length(q.keywords::jsonb) > COALESCE(t.shard_size, 50)`
  );

  if (result.rows.length === 0) return [];

  const affectedTaskIds = [...new Set(result.rows.map((r: any) => r.task_id))];
  const queueIds = result.rows.map((r: any) => r.id);

  // 删除这些过大的队列项
  await query(
    `DELETE FROM real_collect_queue WHERE id = ANY($1::bigint[])`,
    [queueIds]
  );

  console.log(`[RealCollect] 清理了 ${queueIds.length} 个过大的 pending 队列项，涉及 ${affectedTaskIds.length} 个任务`);
  return affectedTaskIds;
}

// ============ AEO 轮次报告 ============

/** 插入AEO轮次报告 */
export async function insertAeoFullReport(params: {
  taskId: number;
  userId: string;
  roundNo: number;
  totalKeywords: number;
  totalRecords: number;
  brandMatchedCount: number;
  visibilityScore: number;
  mentionCount: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  rawAnalysis: string;
  recordIds: number[];
  roundStartTime: Date;
  roundEndTime: Date;
  inclusionRateSummary?: any;
  strategySuggestions?: any;
}): Promise<number> {
  const result = await query(
    `INSERT INTO aeo_full_report
     (task_id, user_id, round_no, total_keywords, total_records, brand_matched_count,
      visibility_score, mention_count, positive_ratio, neutral_ratio, negative_ratio,
      competitor_analysis, suggestions, raw_analysis, record_ids, round_start_time, round_end_time,
      inclusion_rate_summary, strategy_suggestions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (task_id, round_no) DO UPDATE SET
      total_keywords = EXCLUDED.total_keywords,
      total_records = EXCLUDED.total_records,
      brand_matched_count = EXCLUDED.brand_matched_count,
      visibility_score = EXCLUDED.visibility_score,
      mention_count = EXCLUDED.mention_count,
      positive_ratio = EXCLUDED.positive_ratio,
      neutral_ratio = EXCLUDED.neutral_ratio,
      negative_ratio = EXCLUDED.negative_ratio,
      competitor_analysis = EXCLUDED.competitor_analysis,
      suggestions = EXCLUDED.suggestions,
      raw_analysis = EXCLUDED.raw_analysis,
      record_ids = EXCLUDED.record_ids,
      round_end_time = EXCLUDED.round_end_time,
      inclusion_rate_summary = EXCLUDED.inclusion_rate_summary,
      strategy_suggestions = EXCLUDED.strategy_suggestions
     RETURNING id`,
    [
      params.taskId, params.userId, params.roundNo, params.totalKeywords,
      params.totalRecords, params.brandMatchedCount, params.visibilityScore,
      params.mentionCount, params.positiveRatio, params.neutralRatio,
      params.negativeRatio, params.competitorAnalysis, params.suggestions,
      params.rawAnalysis, params.recordIds, params.roundStartTime, params.roundEndTime,
      params.inclusionRateSummary ? JSON.stringify(params.inclusionRateSummary) : null,
      params.strategySuggestions ? JSON.stringify(params.strategySuggestions) : null,
    ]
  );
  return result.rows[0].id;
}

/** 获取本轮的所有品牌命中记录（用于AEO轮次分析） */
export async function getRoundRecordsForAeo(taskId: number, roundStartTime: Date): Promise<any[]> {
  const result = await query(
    `SELECT id, keyword, platform, raw_content, share_url, matched_brands,
       to_char((query_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as query_time
     FROM real_collect_record
     WHERE task_id = $1
       AND brand_matched = true
       AND query_time >= $2
     ORDER BY query_time DESC`,
    [taskId, roundStartTime]
  );
  return result.rows;
}

/** 获取AEO轮次报告列表 */
export async function getAeoFullReports(taskId: number, limit: number = 20): Promise<any[]> {
  const result = await query(
    `SELECT * FROM aeo_full_report
     WHERE task_id = $1
     ORDER BY round_no DESC
     LIMIT $2`,
    [taskId, limit]
  );
  return result.rows;
}

/** 获取任务轮次开始时间 */
export async function getTaskRoundStartTime(taskId: number): Promise<Date | null> {
  const result = await query(
    `SELECT round_start_time FROM real_collect_task WHERE id = $1`,
    [taskId]
  );
  return result.rows[0]?.round_start_time || null;
}

// ============ 关键词维护列表 ============

// 关键词维护列表（从 keyword_search_rank 去重查询）
export async function getKeywordMaintenanceList(params: { userId: string; platform?: string; pageNum: number; pageSize: number; keyword?: string }) {
  const offset = (params.pageNum - 1) * params.pageSize;
  let where = ['k.user_id = $1', 'k.query_time IS NOT NULL'];
  let args: any[] = [params.userId];
  let argIdx = 2;

  if (params.platform) {
    where.push(`k.platform = $${argIdx++}`);
    args.push(params.platform);
  }

  if (params.keyword) {
    where.push(`k.distillate_keyword ILIKE $${argIdx++}`);
    args.push(`%${params.keyword}%`);
  }

  const whereClause = where.join(' AND ');

  // 去重查询
  const countResult = await query(
    `SELECT COUNT(*) as total FROM (
      SELECT DISTINCT k.distillate_keyword, k.platform, k.expanded_keyword
      FROM keyword_search_rank k
      LEFT JOIN zlgjc z ON z.value = k.distillate_keyword AND z.userid = k.user_id
      LEFT JOIN zlgjcurl u ON u.zlgjcid = z.id AND u.pt = k.platform
      WHERE ${whereClause}
    ) t`,
    args
  );
  const total = parseInt(countResult.rows[0].total);

  const listResult = await query(
    `SELECT DISTINCT k.distillate_keyword, k.platform, k.expanded_keyword,
            z.id as zlgjcid, u.id as urlId, u.url, u.has_lxfs
     FROM keyword_search_rank k
     LEFT JOIN zlgjc z ON z.value = k.distillate_keyword AND z.userid = k.user_id
     LEFT JOIN zlgjcurl u ON u.zlgjcid = z.id AND u.pt = k.platform
     WHERE ${whereClause}
     ORDER BY k.distillate_keyword
     LIMIT $${argIdx++} OFFSET $${argIdx++}`,
    [...args, params.pageSize, offset]
  );

  const list = listResult.rows.map((r: any) => ({
    distillateKeyword: r.distillate_keyword,
    expandedKeyword: r.expanded_keyword,
    platform: r.platform,
    zlgjcid: r.zlgjcid,
    urlId: r.urlid,
    url: r.url,
    hasLxfs: r.has_lxfs,
  }));

  return { list, total };
}

// ============ URL 操作 ============

// 新增 URL
export async function insertZlgjcUrl(item: { zlgjcid: number; pt: string; url: string; hasLxfs: boolean }): Promise<number> {
  const result = await query(
    'INSERT INTO zlgjcurl (zlgjcid, pt, url, has_lxfs) VALUES ($1, $2, $3, $4) RETURNING id',
    [item.zlgjcid, item.pt, item.url, item.hasLxfs ? 1 : 0]
  );
  return result.rows[0].id;
}

// 更新 URL
export async function updateZlgjcUrl(id: number, url: string, hasLxfs: boolean): Promise<void> {
  await query('UPDATE zlgjcurl SET url = $1, has_lxfs = $2 WHERE id = $3', [url, hasLxfs ? 1 : 0, id]);
}

// ============ 数据清零 ============

// 清零关键词配置数据
export async function clearKeywordData(userId?: string): Promise<string[]> {
  const cleared: string[] = [];
  await withTransaction(async (client) => {
    if (userId) {
      // 清零指定用户
      await client.query('DELETE FROM zlgjcurl WHERE zlgjcid IN (SELECT id FROM zlgjc WHERE userid = $1)', [userId]);
      await client.query('DELETE FROM zlgjc WHERE userid = $1', [userId]);
      await client.query('DELETE FROM pp WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM distillate_keyword WHERE user_id = $1', [userId]);
      cleared.push('品牌关键词', '核心关键词', '蒸馏关键词库', '关键词跳转');
    } else {
      // 清零全部
      await client.query('DELETE FROM zlgjcurl');
      await client.query('DELETE FROM zlgjc');
      await client.query('DELETE FROM pp');
      await client.query('DELETE FROM distillate_keyword');
      cleared.push('品牌关键词', '核心关键词', '蒸馏关键词库', '关键词跳转');
    }
  });
  return cleared;
}

// ============ 系统监控 ============

// 系统概览统计
export async function getSystemOverview() {
  const [usersRes, tasksRes, recordsRes, keywordsRes, todayRes] = await Promise.all([
    query("SELECT COUNT(*) as total FROM users WHERE level = '0'"),
    query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'running') as running FROM task_info"),
    query('SELECT COUNT(*) as total FROM keyword_search_rank WHERE query_time IS NOT NULL'),
    query('SELECT (SELECT COUNT(*) FROM distillate_keyword) + (SELECT COUNT(DISTINCT value) FROM zlgjc) as total'),
    query("SELECT COUNT(*) as total FROM keyword_search_rank WHERE query_time IS NOT NULL AND query_time::date = CURRENT_DATE"),
  ]);
  return {
    totalUsers: parseInt(usersRes.rows[0].total) || 0,
    totalTasks: parseInt(tasksRes.rows[0].total) || 0,
    runningTasks: parseInt(tasksRes.rows[0].running) || 0,
    totalRecords: parseInt(recordsRes.rows[0].total) || 0,
    totalKeywords: parseInt(keywordsRes.rows[0].total) || 0,
    todayRecords: parseInt(todayRes.rows[0].total) || 0,
  };
}

// 任务状态汇总（按状态分组）
export async function getTaskStatusSummary() {
  const result = await query(
    `SELECT status, COUNT(*) as count FROM task_info GROUP BY status`
  );
  return result.rows.map((row: any) => ({
    status: row.status,
    count: parseInt(row.count) || 0,
  }));
}

// 最近生成记录（只显示已收录的）
export async function getRecentRecords(limit: number = 20) {
  const result = await query(
    `SELECT id, expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time
     FROM keyword_search_rank
     WHERE query_time IS NOT NULL
     ORDER BY query_time DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    expandedKeyword: row.expanded_keyword,
    distillateKeyword: row.distillate_keyword,
    platform: row.platform,
    userId: row.user_id,
    queryTime: row.query_time,
    createTime: row.create_time,
  }));
}

// 各用户数据量统计（拆分为独立查询，避免多表 LEFT JOIN 笛卡尔积爆炸）
export async function getUserDataStats() {
  // 先获取所有普通用户
  const usersResult = await query(
    `SELECT id, username FROM users WHERE level = '0' ORDER BY id`
  );
  const users = usersResult.rows;
  if (users.length === 0) return [];

  // 为每个用户独立查询各表数据量（避免笛卡尔积）
  const result = [];
  for (const user of users) {
    const userId = String(user.id);
    const [taskRes, dkRes, zlgjcRes, recordRes] = await Promise.all([
      query('SELECT COUNT(*) as count FROM task_info WHERE user_id = $1', [userId]),
      query('SELECT COUNT(*) as count FROM distillate_keyword WHERE user_id = $1', [userId]),
      query('SELECT COUNT(DISTINCT value) as count FROM zlgjc WHERE userid = $1', [userId]),
      query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1 AND query_time IS NOT NULL', [userId]),
    ]);
    result.push({
      userId: user.id,
      username: user.username,
      taskCount: parseInt(taskRes.rows[0].count) || 0,
      coreKeywordCount: parseInt(dkRes.rows[0].count) || 0,
      zlgjcCount: parseInt(zlgjcRes.rows[0].count) || 0,
      recordCount: parseInt(recordRes.rows[0].count) || 0,
    });
  }

  // 按 record_count 降序
  result.sort((a, b) => b.recordCount - a.recordCount);
  return result;
}

// 获取用户详细数据（用于数据监测页面的用户详情面板）
export async function getUserDetailStats(userId: string) {
  // 1. 用户基本信息
  const userRes = await query('SELECT id, username, phone, email, url, date_time FROM users WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return null;
  const user = userRes.rows[0];

  // 2. 任务列表（含进度）
  const tasksRes = await query(
    `SELECT t.id, t.name, t.start_date, t.end_date, t.total_num, t.status, t.create_time,
            COALESCE(p.generated_num, 0) as generated_num
     FROM task_info t
     LEFT JOIN task_progress p ON p.task_id = t.id
     WHERE t.user_id = $1
     ORDER BY t.create_time DESC`,
    [userId]
  );

  // 3. 各平台数据分布（只统计已收录的）
  const platformRes = await query(
    `SELECT platform, COUNT(*) as count
     FROM keyword_search_rank
     WHERE user_id = $1 AND platform != '' AND query_time IS NOT NULL
     GROUP BY platform
     ORDER BY count DESC`,
    [userId]
  );

  // 4. 关键词统计
  const [dkCountRes, zlgjcCountRes, ppCountRes, recordCountRes, todayCountRes] = await Promise.all([
    query('SELECT COUNT(*) as count FROM distillate_keyword WHERE user_id = $1', [userId]),
    query('SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1', [userId]),
    query('SELECT COUNT(*) as count FROM pp WHERE user_id = $1', [userId]),
    query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1 AND query_time IS NOT NULL', [userId]),
    query("SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1 AND query_time IS NOT NULL AND query_time::date = CURRENT_DATE", [userId]),
  ]);

  // 5. 最近7天每日收录趋势（按 query_time 统计）
  const trendRes = await query(
    `SELECT query_time::date as date, COUNT(*) as count
     FROM keyword_search_rank
     WHERE user_id = $1 AND query_time IS NOT NULL AND query_time >= CURRENT_DATE - INTERVAL '6 days'
     GROUP BY query_time::date
     ORDER BY date`,
    [userId]
  );

  // 6. 联系方式标记数
  const lxfsRes = await query(
    `SELECT COUNT(*) as count FROM zlgjcurl WHERE zlgjcid IN (SELECT id FROM zlgjc WHERE userid = $1) AND has_lxfs = 1`,
    [userId]
  );

  return {
    user: {
      id: user.id,
      username: user.username,
      phone: user.phone,
      email: user.email,
      url: user.url,
      dateTime: user.date_time,
    },
    summary: {
      taskCount: tasksRes.rows.length,
      coreKeywordCount: parseInt(dkCountRes.rows[0].count) || 0,
      zlgjcCount: parseInt(zlgjcCountRes.rows[0].count) || 0,
      ppCount: parseInt(ppCountRes.rows[0].count) || 0,
      recordCount: parseInt(recordCountRes.rows[0].count) || 0,
      todayRecords: parseInt(todayCountRes.rows[0].count) || 0,
      lxfsCount: parseInt(lxfsRes.rows[0].count) || 0,
    },
    tasks: tasksRes.rows.map((t: any) => ({
      id: t.id,
      name: t.name,
      startDate: t.start_date,
      endDate: t.end_date,
      totalNum: t.total_num,
      status: t.status,
      createTime: t.create_time,
      generatedNum: parseInt(t.generated_num) || 0,
    })),
    platformDistribution: platformRes.rows.map((p: any) => ({
      platform: p.platform,
      count: parseInt(p.count) || 0,
    })),
    dailyTrend: trendRes.rows.map((d: any) => ({
      date: d.date,
      count: parseInt(d.count) || 0,
    })),
  };
}

// ============ 批量数据导入（本地迁移） ============

export async function bulkImportData(data: {
  users?: any[];
  pp?: any[];
  distillateKeywords?: any[];
  zlgjc?: any[];
  zlgjcurl?: any[];
  tasks?: any[];
  taskWeights?: any[];
  taskProgress?: any[];
  dailyRandom?: any[];
  keywordSearchRank?: any[];
}): Promise<{ [key: string]: number }> {
  const counts: { [key: string]: number } = {};

  await withTransaction(async (client) => {
    // 1. 导入用户（不保留原始ID，建立新旧ID映射，避免整数溢出）
    // 本地SQLite的user.id可能是时间戳(如1781561709129)，超过PostgreSQL INTEGER范围
    const userIdMap = new Map<string, number>(); // 旧id(字符串) -> 新id(数字)
    if (data.users && data.users.length > 0) {
      let cnt = 0;
      for (const u of data.users) {
        // 先检查用户名是否已存在（幂等性）
        const existing = await client.query('SELECT id FROM users WHERE username = $1', [u.username]);
        let newId: number;
        if (existing.rows.length > 0) {
          newId = existing.rows[0].id;
        } else {
          const insertResult = await client.query(
            `INSERT INTO users (username, password, phone, email, url, address, level, cid, date_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [u.username, u.password, u.phone || '', u.email || '', u.url || '',
             u.address || '', u.level || '0', u.cid || '', u.dateTime || '']
          );
          newId = insertResult.rows[0].id;
        }
        // 建立旧id到新id的映射（key用字符串，因为其他表的user_id是TEXT类型）
        if (u.id !== undefined && u.id !== null) {
          userIdMap.set(String(u.id), newId);
        }
        cnt++;
      }
      counts.users = cnt;

      // 导入用户后，立即清除该用户旧的 keyword_search_rank 记录（避免重复导入时数据重复）
      // 这样第1步清除旧数据，第2步插入新数据（第2步不传 users，不会重复清除）
      if (userIdMap.size > 0) {
        const allUserIds = new Set<string>([
          ...Array.from(userIdMap.keys()),                    // 旧 user_id
          ...Array.from(userIdMap.values()).map(String),      // 新 user_id
        ]);
        console.log(`[Import] 导入用户后清除 keyword_search_rank 旧记录，user_ids: ${Array.from(allUserIds).join(', ')}`);
        for (const uid of allUserIds) {
          const delResult = await client.query('DELETE FROM keyword_search_rank WHERE user_id = $1', [uid]);
          if (delResult.rowCount && delResult.rowCount > 0) {
            console.log(`[Import] 删除 user_id=${uid} 的 keyword_search_rank 记录: ${delResult.rowCount} 条`);
          }
        }
      }
    }

    // 2. 导入品牌关键词（使用新的user_id映射，不保留原始id）
    if (data.pp && data.pp.length > 0) {
      // 先清除旧数据（旧user_id和新user_id），避免重复
      const allUserIds = new Set<string>([
        ...data.pp.map(p => String(p.user_id || '')),
        ...Array.from(userIdMap.values()).map(String),
      ]);
      for (const uid of allUserIds) {
        if (uid) await client.query('DELETE FROM pp WHERE user_id = $1', [uid]);
      }
      let cnt = 0;
      for (const p of data.pp) {
        const newUserId = userIdMap.get(String(p.user_id)) || String(p.user_id || '');
        await client.query(
          `INSERT INTO pp (user_id, pp) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [newUserId, p.pp || '']
        );
        cnt++;
      }
      counts.pp = cnt;
    }

    // 3. 导入核心关键词（使用新的user_id映射，不保留原始id）
    if (data.distillateKeywords && data.distillateKeywords.length > 0) {
      // 先清除旧数据，避免重复
      const allUserIds = new Set<string>([
        ...data.distillateKeywords.map(dk => String(dk.user_id || '')),
        ...Array.from(userIdMap.values()).map(String),
      ]);
      for (const uid of allUserIds) {
        if (uid) await client.query('DELETE FROM distillate_keyword WHERE user_id = $1', [uid]);
      }
      let cnt = 0;
      for (const dk of data.distillateKeywords) {
        const newUserId = userIdMap.get(String(dk.user_id)) || String(dk.user_id || '');
        await client.query(
          `INSERT INTO distillate_keyword (distillate_keyword, user_id, zt)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [dk.distillate_keyword || '', newUserId, dk.zt || 1]
        );
        cnt++;
      }
      counts.distillateKeywords = cnt;
    }

    // 4. 导入蒸馏关键词库（不保留原始id，但需要建立新旧id映射）
    const zlgjcIdMap = new Map<number, number>();
    if (data.zlgjc && data.zlgjc.length > 0) {
      // 先清除旧数据（旧user_id和新user_id），避免重复
      const allUserIds = new Set<string>([
        ...data.zlgjc.map(z => String(z.userId || z.userid || '')),
        ...Array.from(userIdMap.values()).map(String),
      ]);
      for (const uid of allUserIds) {
        if (uid) {
          // 先清除关联的 zlgjcurl
          await client.query('DELETE FROM zlgjcurl WHERE zlgjcid IN (SELECT id FROM zlgjc WHERE userid = $1)', [uid]);
          await client.query('DELETE FROM zlgjc WHERE userid = $1', [uid]);
        }
      }
      let cnt = 0;
      for (const z of data.zlgjc) {
        const newUserId = userIdMap.get(String(z.userId || z.userid || '')) || String(z.userId || z.userid || '');
        // ON CONFLICT 去重：如果 (userid, value, keyword_type) 已存在则不插入
        const insertResult = await client.query(
          `INSERT INTO zlgjc (value, userid, lxfs, hxgjc)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (userid, value, keyword_type) DO NOTHING
           RETURNING id`,
          [z.value || '', newUserId, z.lxfs || '', z.hxgjc || '']
        );
        const newId = insertResult.rows[0]?.id;
        if (!newId) {
          // 已存在（ON CONFLICT 触发），查询现有 id 用于 zlgjcurl 关联
          const existing = await client.query(
            `SELECT id FROM zlgjc WHERE userid = $1 AND value = $2 AND keyword_type = 0 LIMIT 1`,
            [newUserId, z.value || '']
          );
          if (existing.rows[0]) {
            if (z.id) zlgjcIdMap.set(z.id, existing.rows[0].id);
          }
          continue;
        }
        if (z.id) {
          zlgjcIdMap.set(z.id, newId);
        }
        cnt++;
      }
      counts.zlgjc = cnt;
    }

    // 5. 导入关键词跳转链接（使用新的zlgjcid映射，不保留原始id）
    if (data.zlgjcurl && data.zlgjcurl.length > 0) {
      // zlgjcurl 已在步骤4中清除（通过 zlgjcid IN (SELECT id FROM zlgjc WHERE userid = ...)）
      let cnt = 0;
      for (const zc of data.zlgjcurl) {
        const newZlgjcId = zlgjcIdMap.get(zc.zlgjcid) || zc.zlgjcid;
        await client.query(
          `INSERT INTO zlgjcurl (zlgjcid, pt, url, has_lxfs)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [newZlgjcId, zc.pt || '', zc.url || '', zc.has_lxfs || 0]
        );
        cnt++;
      }
      counts.zlgjcurl = cnt;
    }

    // 6. 导入任务（保留原始id，因为task_info.id是BIGINT类型，可容纳时间戳；建立新旧id映射）
    const taskIdMap = new Map<number, number>();
    if (data.tasks && data.tasks.length > 0) {
      let cnt = 0;
      for (const t of data.tasks) {
        const newUserId = userIdMap.get(String(t.user_id)) || String(t.user_id || '');
        // task_info.id 是 BIGINT，可容纳时间戳，保留原始id
        await client.query(
          `INSERT INTO task_info (id, user_id, start_date, end_date, total_num, status, name, create_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
             total_num = EXCLUDED.total_num, status = EXCLUDED.status, name = EXCLUDED.name,
             create_time = EXCLUDED.create_time`,
          [t.id, newUserId, t.start_date, t.end_date, t.total_num || 0,
           t.status || 'completed', t.name || '', t.create_time]
        );
        if (t.id) {
          taskIdMap.set(t.id, t.id); // id不变，映射为自身
        }
        cnt++;
      }
      counts.tasks = cnt;
    }

    // 7. 导入任务平台权重（使用新的task_id映射）
    if (data.taskWeights && data.taskWeights.length > 0) {
      let cnt = 0;
      for (const w of data.taskWeights) {
        const newTaskId = taskIdMap.get(w.task_id) || w.task_id;
        await client.query(
          `INSERT INTO task_platform_weights (task_id, platform, weight)
           VALUES ($1, $2, $3) ON CONFLICT (task_id, platform) DO UPDATE SET weight = EXCLUDED.weight`,
          [newTaskId, w.platform, w.weight || 1]
        );
        cnt++;
      }
      counts.taskWeights = cnt;
    }

    // 8. 导入任务进度（使用新的task_id映射）
    if (data.taskProgress && data.taskProgress.length > 0) {
      let cnt = 0;
      for (const tp of data.taskProgress) {
        const newTaskId = taskIdMap.get(tp.task_id) || tp.task_id;
        await client.query(
          `INSERT INTO task_progress (task_id, generated_num, update_time)
           VALUES ($1, $2, $3) ON CONFLICT (task_id) DO UPDATE SET
             generated_num = EXCLUDED.generated_num, update_time = EXCLUDED.update_time`,
          [newTaskId, tp.generated_num || 0, tp.update_time]
        );
        cnt++;
      }
      counts.taskProgress = cnt;
    }

    // 9. 导入每日随机数（使用新的task_id映射）
    if (data.dailyRandom && data.dailyRandom.length > 0) {
      let cnt = 0;
      for (const dr of data.dailyRandom) {
        const newTaskId = taskIdMap.get(dr.task_id) || dr.task_id;
        await client.query(
          `INSERT INTO daily_random (task_id, random_date, random_num, create_time)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [newTaskId, dr.random_date, dr.random_num || 0, dr.create_time]
        );
        cnt++;
      }
      counts.dailyRandom = cnt;
    }

    // 10. 导入关键词收录记录（核心数据，分批插入，使用新的id映射）
    // 注意：旧数据已在步骤1（导入用户后）清除，这里不需要再清除
    if (data.keywordSearchRank && data.keywordSearchRank.length > 0) {
      const batchSize = 500;
      let cnt = 0;
      for (let i = 0; i < data.keywordSearchRank.length; i += batchSize) {
        const batch = data.keywordSearchRank.slice(i, i + batchSize);
        const values: any[] = [];
        const placeholders: string[] = [];
        batch.forEach((r, idx) => {
          const base = idx * 13;
          placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`
          );
          // 使用id映射，如果找不到映射则保持原值（task_info保留了原始id，user_id已在客户端映射）
          const newDistillateId = r.distillate_keyword_id ? (zlgjcIdMap.get(r.distillate_keyword_id) || null) : null;
          const newTaskId = r.task_id ? (taskIdMap.get(r.task_id) || r.task_id) : null;
          const newUserId = userIdMap.get(String(r.user_id)) || String(r.user_id || '');
          values.push(
            r.expanded_keyword || '', r.distillate_keyword || '', r.platform || '',
            newUserId, r.query_time, r.create_time,
            newDistillateId, r.update_time, r.w_id || 1,
            r.url || '', r.is_url || 1, r.ly || '', newTaskId
          );
        });
        await client.query(
          `INSERT INTO keyword_search_rank
           (expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time,
            distillate_keyword_id, update_time, w_id, url, is_url, ly, task_id)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );
        cnt += batch.length;
      }
      counts.keywordSearchRank = cnt;
    }
  });

  return counts;
}

// ===== 真实收录查询相关 =====

/** 创建真实查询任务 */
export async function createRealCollectTask(params: {
  userId: string;
  taskName: string;
  keywordType: number;
  platforms: string[];
  cronExpr?: string;
  shardSize?: number;
  excludePrefixes?: string[];
  queryMode?: string;
}): Promise<number> {
  // cronExpr 可选：循环模式下不传，默认 '0 0 * * *' 保持兼容
  const cronExpr = params.cronExpr || '0 0 * * *';
  // excludePrefixes 存储为 JSON 字符串（仅蒸馏词库有效）
  const excludePrefixesJson = (params.keywordType === 0 && params.excludePrefixes && params.excludePrefixes.length > 0)
    ? JSON.stringify(params.excludePrefixes.filter(p => p && p.trim()))
    : null;
  const queryMode = params.queryMode || 'auto';
  const result = await query(
    `INSERT INTO real_collect_task (user_id, task_name, keyword_type, platforms, cron_expr, status, shard_size, exclude_prefixes, query_mode)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8) RETURNING id`,
    [params.userId, params.taskName, params.keywordType, params.platforms, cronExpr, params.shardSize || 50, excludePrefixesJson, queryMode]
  );
  return result.rows[0].id;
}

/** 更新真实查询任务 */
export async function updateRealCollectTask(id: number, params: {
  taskName?: string;
  keywordType?: number;
  platforms?: string[];
  cronExpr?: string;
  status?: string;
  shardSize?: number;
  excludePrefixes?: string[];
  queryMode?: string;
}): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [id];
  let paramIdx = 2;
  if (params.taskName !== undefined) { sets.push(`task_name = $${paramIdx++}`); values.push(params.taskName); }
  if (params.keywordType !== undefined) { sets.push(`keyword_type = $${paramIdx++}`); values.push(params.keywordType); }
  if (params.platforms !== undefined) { sets.push(`platforms = $${paramIdx++}`); values.push(params.platforms); }
  if (params.cronExpr !== undefined) { sets.push(`cron_expr = $${paramIdx++}`); values.push(params.cronExpr); }
  if (params.status !== undefined) { sets.push(`status = $${paramIdx++}`); values.push(params.status); }
  if (params.shardSize !== undefined) { sets.push(`shard_size = $${paramIdx++}`); values.push(params.shardSize); }
  if (params.queryMode !== undefined) { sets.push(`query_mode = $${paramIdx++}`); values.push(params.queryMode); }
  if (params.excludePrefixes !== undefined) {
    // 仅蒸馏词库（keyword_type=0）保存前缀屏蔽，品牌词库清空
    const kp = params.keywordType !== undefined ? params.keywordType : 0;
    const filtered = params.excludePrefixes.filter(p => p && p.trim());
    const json = (kp === 0 && filtered.length > 0) ? JSON.stringify(filtered) : null;
    sets.push(`exclude_prefixes = $${paramIdx++}`);
    values.push(json);
  }
  sets.push(`update_time = CURRENT_TIMESTAMP`);
  await query(`UPDATE real_collect_task SET ${sets.join(', ')} WHERE id = $1`, values);
}

/** 删除真实查询任务(软删除) */
export async function deleteRealCollectTask(id: number): Promise<void> {
  await query(`UPDATE real_collect_task SET status = 'deleted' WHERE id = $1`, [id]);
}

/**
 * 重置任务当前轮次：删除 pending/done/failed 分片，保留 running 分片
 * 用于修复分片数异常（如关键词重复入库导致分片数翻倍）的问题
 * 保留 running 分片是为了避免 Worker 执行被删除的分片（执行无效查询）
 * Worker 执行完当前 running 分片后会自动 dequeue 新分片
 */
export async function resetTaskCurrentRound(taskId: number): Promise<{ deletedShards: number; runningShardsKept: number; roundNo: number }> {
  // 获取当前 round_no
  const taskResult = await query(`SELECT round_no FROM real_collect_task WHERE id = $1`, [taskId]);
  const currentRoundNo = taskResult.rows[0]?.round_no || 0;

  // 统计 running 分片数（保留）
  const runningResult = await query(
    `SELECT COUNT(*) as cnt FROM real_collect_queue WHERE task_id = $1 AND round_no = $2 AND status = 'running'`,
    [taskId, currentRoundNo]
  );
  const runningShardsKept = parseInt(runningResult.rows[0]?.cnt || '0');

  // 只删除 pending/done/failed 分片，保留 running 分片
  const deleteResult = await query(
    `DELETE FROM real_collect_queue WHERE task_id = $1 AND round_no = $2 AND status != 'running' RETURNING id`,
    [taskId, currentRoundNo]
  );

  // 重置任务的 round_no（减1，这样 startNewRoundForTask 会重新启动新一轮）
  // 同时清空 round_start_time，让 getTaskShardProgress 不会查到旧数据
  await query(
    `UPDATE real_collect_task SET round_no = GREATEST(round_no - 1, 0), round_start_time = NULL WHERE id = $1`,
    [taskId]
  );

  return { deletedShards: deleteResult.rowCount || 0, runningShardsKept, roundNo: currentRoundNo };
}

/** 获取真实查询任务列表 */
export async function getRealCollectTasks(userId?: string): Promise<any[]> {
  const sql = `SELECT * FROM real_collect_task WHERE status != 'deleted' ${userId ? 'AND user_id = $1' : ''} ORDER BY create_time DESC`;
  const result = await query(sql, userId ? [userId] : []);
  return result.rows;
}

/** 获取单个真实查询任务 */
export async function getRealCollectTaskById(id: number): Promise<any | null> {
  const result = await query(`SELECT * FROM real_collect_task WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/** 更新任务执行状态 */
export async function updateTaskRunStatus(id: number, params: {
  status: string;
  recordCount?: number;
  brandCount?: number;
  error?: string;
  endTime?: Date;
  startTime?: Date;
}): Promise<void> {
  const sets: string[] = [`last_run_status = $2`];
  const values: any[] = [id, params.status];
  let paramIdx = 3;
  if (params.recordCount !== undefined) { sets.push(`last_run_record_count = $${paramIdx++}`); values.push(params.recordCount); }
  if (params.brandCount !== undefined) { sets.push(`last_run_brand_count = $${paramIdx++}`); values.push(params.brandCount); }
  if (params.error !== undefined) { sets.push(`last_error = $${paramIdx++}`); values.push(params.error); }
  if (params.endTime !== undefined) { sets.push(`last_run_end_time = $${paramIdx++}`); values.push(params.endTime); }
  if (params.startTime !== undefined) { sets.push(`last_run_time = $${paramIdx++}`); values.push(params.startTime); }
  await query(`UPDATE real_collect_task SET ${sets.join(', ')} WHERE id = $1`, values);
}

/** 插入真实查询结果 */
export async function insertRealCollectRecord(params: {
  taskId: number;
  userId: string;
  keyword: string;
  keywordType: number;
  platform: string;
  brandMatched: boolean;
  matchedBrands: string[];
  hasContact: boolean;
  contacts: any;
  shareUrl: string | null;
  staticPageId: number | null;
  rawContent: string;
  queryTime: Date;
  workerId: string;
  source?: 'api' | 'crawler';
}): Promise<number> {
  const result = await query(
    `INSERT INTO real_collect_record
     (task_id, user_id, keyword, keyword_type, platform, brand_matched, matched_brands,
      has_contact, contacts, share_url, static_page_id, raw_content, query_time, worker_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [params.taskId, params.userId, params.keyword, params.keywordType, params.platform,
     params.brandMatched, params.matchedBrands, params.hasContact, JSON.stringify(params.contacts),
     params.shareUrl, params.staticPageId, params.rawContent, params.queryTime, params.workerId,
     params.source || 'crawler']
  );
  return result.rows[0].id;
}

/** 插入静态页 */
export async function insertStaticPage(recordId: number, htmlContent: string): Promise<number> {
  const result = await query(
    `INSERT INTO real_collect_static_page (record_id, html_content) VALUES ($1, $2) RETURNING id`,
    [recordId, htmlContent]
  );
  return result.rows[0].id;
}

/** 获取静态页内容 */
export async function getStaticPageByRecordId(recordId: number): Promise<string | null> {
  const result = await query(
    `SELECT html_content FROM real_collect_static_page WHERE record_id = $1`,
    [recordId]
  );
  return result.rows[0]?.html_content || null;
}

/** 更新记录的static_page_id */
export async function updateRecordStaticPageId(recordId: number, staticPageId: number): Promise<void> {
  await query(`UPDATE real_collect_record SET static_page_id = $1 WHERE id = $2`, [staticPageId, recordId]);
}

/** 查询真实结果列表(分页) */
export async function getRealCollectRecords(params: {
  userId?: string;
  platform?: string;
  keywordType?: number;
  pageNum: number;
  pageSize: number;
  startTime?: Date;
  endTime?: Date;
}): Promise<{ list: any[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (params.userId) { conditions.push(`user_id = $${paramIdx++}`); values.push(params.userId); }
  if (params.platform) { conditions.push(`platform = $${paramIdx++}`); values.push(params.platform); }
  if (params.keywordType !== undefined) { conditions.push(`keyword_type = $${paramIdx++}`); values.push(params.keywordType); }
  if (params.startTime) { conditions.push(`query_time >= $${paramIdx++}`); values.push(params.startTime); }
  if (params.endTime) { conditions.push(`query_time <= $${paramIdx++}`); values.push(params.endTime); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) as total FROM real_collect_record ${whereClause}`, values);
  const total = parseInt(countResult.rows[0].total);

  const offset = (params.pageNum - 1) * params.pageSize;
  const limitIdx = paramIdx++;
  const offsetIdx = paramIdx++;
  values.push(params.pageSize);
  values.push(offset);

  const listResult = await query(
    `SELECT * FROM real_collect_record ${whereClause} ORDER BY query_time DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  return { list: listResult.rows, total };
}

/** 获取GEO报告中的真实结果(品牌词匹配成功的) */
export async function getRealCollectRecordsForDashboard(params: {
  userId: string;
  platform?: string;
  limit: number;
}): Promise<any[]> {
  const values: any[] = [params.userId];
  let platformCondition = '';
  if (params.platform) {
    values.push(params.platform);
    platformCondition = `AND platform = $2`;
  }
  const limitParam = params.platform ? '$3' : '$2';
  values.push(params.limit);

  const result = await query(
    `SELECT id, keyword, keyword_type, platform, matched_brands, has_contact, contacts,
            share_url, static_page_id, query_time
     FROM real_collect_record 
     WHERE user_id = $1 AND brand_matched = true ${platformCondition}
     ORDER BY query_time DESC LIMIT ${limitParam}`,
    values
  );
  return result.rows;
}

/** 获取单个真实结果详情 */
export async function getRealCollectRecordById(id: number): Promise<any | null> {
  const result = await query(`SELECT * FROM real_collect_record WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/** 删除真实结果 */
export async function deleteRealCollectRecord(id: number): Promise<void> {
  await query(`DELETE FROM real_collect_record WHERE id = $1`, [id]);
}

/** 获取所有active的真实查询任务 */
export async function getDueRealCollectTasks(): Promise<any[]> {
  const result = await query(
    `SELECT * FROM real_collect_task WHERE status = 'active' ORDER BY id`
  );
  return result.rows;
}

/** 获取用户的品牌词库（DISTINCT 去重，防止 zlgjc 表历史重复入库导致关键词翻倍） */
export async function getBrandKeywords(userId: string): Promise<string[]> {
  const result = await query(
    `SELECT DISTINCT value FROM zlgjc WHERE userid = $1 AND keyword_type = 1 AND value != ''`,
    [userId]
  );
  return result.rows.map((r: any) => r.value);
}

/** 获取用户的蒸馏词库（DISTINCT 去重，防止 zlgjc 表历史重复入库导致关键词翻倍） */
export async function getDistillateKeywords(userId: string): Promise<string[]> {
  const result = await query(
    `SELECT DISTINCT value FROM zlgjc WHERE userid = $1 AND (keyword_type = 0 OR keyword_type IS NULL) AND value != ''`,
    [userId]
  );
  return result.rows.map((r: any) => r.value);
}

/** 获取用户的蒸馏词库（分片版：按星期几取 1/7） */
export async function getDistillateKeywordsSharded(userId: string, shards: number = 7): Promise<string[]> {
  const dayOfWeek = new Date().getDay(); // 0=周日
  const shardIndex = dayOfWeek % shards;
  const result = await query(
    `SELECT DISTINCT value FROM zlgjc
     WHERE userid = $1 AND (keyword_type = 0 OR keyword_type IS NULL) AND value != ''
       AND (id % $2) = $3
     ORDER BY id`,
    [userId, shards, shardIndex]
  );
  return result.rows.map((r: any) => r.value);
}

// ============ 平台账号池 ============

/** 保存或更新平台账号授权 */
export async function savePlatformAuth(params: {
  userId?: string;
  platform: string;
  accountName?: string;
  storageState: string;
  expiresAt?: Date;
  avatarUrl?: string;
}): Promise<number> {
  const existing = await query(
    `SELECT id FROM platform_auth 
     WHERE platform = $1 AND account_name = $2`,
    [params.platform, params.accountName || null]
  );
  if (existing.rows.length > 0) {
    await query(
      `UPDATE platform_auth
       SET storage_state = $1, expires_at = $2, status = 'active',
           health_status = 'normal', last_query_count = 0, cooldown_until = NULL,
           risk_level = 'none', risk_count = 0, risk_detected_at = NULL,
           avatar_url = COALESCE($4, avatar_url),
           account_name = COALESCE(NULLIF($5, ''), account_name),
           updated_at = NOW()
       WHERE id = $3`,
      [params.storageState, params.expiresAt || null, existing.rows[0].id, params.avatarUrl || null, params.accountName || null]
    );
    return existing.rows[0].id;
  }
  const result = await query(
    `INSERT INTO platform_auth (user_id, platform, account_name, storage_state, expires_at, status, avatar_url)
     VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
    [params.userId || null, params.platform, params.accountName || null, params.storageState, params.expiresAt || null, params.avatarUrl || null]
  );
  return result.rows[0].id;
}

/** 查询用户所有平台授权 */
export async function getPlatformAuthList(userId?: string) {
  const result = await query(
    `SELECT id, user_id, platform, account_name, expires_at, status, 
            last_used_at, last_query_count, daily_limit, cooldown_until, health_score,
            health_status, risk_level, risk_count, risk_detected_at,
            avatar_url, created_at, updated_at
     FROM platform_auth
     WHERE $1::text IS NULL OR user_id = $1
     ORDER BY platform, created_at`,
    [userId || null]
  );
  return result.rows;
}

/** 查询单个账号的完整信息（含 storage_state，worker 用） */
export async function getPlatformAuthById(id: number) {
  const result = await query(`SELECT * FROM platform_auth WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/** 从账号池借用一个可用账号（最久未使用优先）
 * 账号状态（account_status）：normal / banned / offline
 * - normal：正常可用，acquire 只借用 normal 状态且未超日限额的账号
 * - banned：被平台封禁，需人工恢复
 * - offline：登录态掉线，需重新登录
 * 到达每日查询量（last_query_count >= daily_limit）的账号当天不再借用，次日 0 点重置计数
 */
export async function acquirePlatformAccount(platform: string): Promise<{
  id: number;
  storageState: string;
  proxy?: { endpoint: string; username?: string; password?: string } | null;
} | null> {
  // 只借用 normal 状态、status=active、未过期、未超日限额的账号（最久未使用优先）
  // v1.3+：LEFT JOIN proxy_pool 返回账号绑定的代理信息（解密密码）
  //
  // 注意：原实现用 LEFT JOIN + FOR UPDATE SKIP LOCKED，在某些 PostgreSQL 版本会报错
  // （FOR UPDATE 无法锁定 LEFT JOIN 右侧表的 NULL 行）。
  // 改为分两步：先 UPDATE...RETURNING 拿到账号 id 和 proxy_id，再单独查代理详情。
  const result = await query(
    `UPDATE platform_auth
     SET last_used_at = NOW(), last_query_count = last_query_count + 1
     WHERE id = (
       SELECT id FROM platform_auth
       WHERE platform = $1
         AND health_status = 'normal'
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND last_query_count < daily_limit
       ORDER BY last_used_at ASC NULLS FIRST
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, storage_state, proxy_id`,
    [platform]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const account: { id: number; storageState: string; proxy?: any } = {
    id: row.id,
    storageState: row.storage_state,
  };

  // 如果账号绑定了代理，单独查询代理详情（避免 JOIN + FOR UPDATE 兼容性问题）
  if (row.proxy_id) {
    try {
      const proxyDetail = await getProxyById(row.proxy_id);
      if (proxyDetail && proxyDetail.is_active) {
        account.proxy = {
          endpoint: proxyDetail.endpoint,
          username: proxyDetail.username || undefined,
          password: proxyDetail.password || undefined,
        };
      }
    } catch (e: any) {
      console.error(`[acquirePlatformAccount] 获取代理 ${row.proxy_id} 失败:`, e.message);
    }
  }

  return account;
}

/** 归还账号（根据查询结果更新账号状态）
 * 新设计：取消自动降健康度，只在明确识别到平台封禁或登录掉线时才改状态
 * - success: 仅更新使用时间，不动状态
 * - failed: 登录态失效 → 标记 offline；其他失败不改状态（避免误降级），并回退 last_query_count
 * - rate_limited: 明确检测到封禁类关键词 → 标记 banned；普通风控提示不改状态，并回退 last_query_count
 */
export async function releasePlatformAccount(
  authId: number,
  result: 'success' | 'failed' | 'rate_limited',
  detail?: string
): Promise<void> {
  if (result === 'success') {
    // 成功：仅更新时间，并清零 offline_fail_count（说明之前是误判，账号实际可用）
    await query(
      `UPDATE platform_auth SET updated_at = NOW(), offline_fail_count = 0 WHERE id = $1`,
      [authId]
    );
  } else if (result === 'rate_limited') {
    // rate_limited：只有明确检测到封禁类信号才标记 banned
    // detail 传入具体的风控关键词，用于判断是否真正封禁
    const banKeywords = ['账号已被限制', '账号异常', '账号被封', '封禁', 'banned', 'limited account'];
    const isBanned = detail ? banKeywords.some(kw => detail.includes(kw)) : false;
    if (isBanned) {
      await query(
        `UPDATE platform_auth
         SET health_status = 'banned',
             risk_detected_at = NOW(),
             status = 'expired',
             updated_at = NOW()
         WHERE id = $1`,
        [authId]
      );
    } else {
      // 普通风控提示（验证码、频率限制等）不改状态，账号继续可用
      // 回退 last_query_count，因为这次查询未成功消耗
      await query(
        `UPDATE platform_auth SET last_query_count = GREATEST(last_query_count - 1, 0), updated_at = NOW() WHERE id = $1`,
        [authId]
      );
    }
  } else {
    // failed：只有登录态失效才标记 offline，其他失败不改状态
    const isLoginExpired = detail ? (
      detail.includes('登录态失效') ||
      detail.includes('登录失效') ||
      detail.includes('请重新登录') ||
      detail.includes('登录已失效') ||
      detail.includes('unauthorized')
    ) : false;
    if (isLoginExpired) {
      // 引入失败计数：连续3次检测到登录态失效才标记 offline
      // 单次失败可能是误判（页面加载慢、SPA 路由未稳定、选择器不匹配、网络抖动等）
      // 这与 rate_limited 的"3次才标记 banned"逻辑一致，提高容错性
      const failResult = await query(
        `UPDATE platform_auth
         SET offline_fail_count = COALESCE(offline_fail_count, 0) + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING offline_fail_count`,
        [authId]
      );
      const failCount = failResult.rows[0]?.offline_fail_count || 0;
      if (failCount >= 3) {
        await query(
          `UPDATE platform_auth
           SET health_status = 'offline',
               risk_detected_at = NOW(),
               status = 'expired',
               updated_at = NOW()
           WHERE id = $1`,
          [authId]
        );
        console.log(`[PlatformAuth] 账号 ${authId} 连续 ${failCount} 次登录态失效，标记为 offline`);
      } else {
        // 未达阈值：回退 last_query_count，账号继续可用，等待下次重试
        await query(
          `UPDATE platform_auth SET last_query_count = GREATEST(last_query_count - 1, 0), updated_at = NOW() WHERE id = $1`,
          [authId]
        );
        console.log(`[PlatformAuth] 账号 ${authId} 登录态失效 (第${failCount}/3次)，暂不标记 offline`);
      }
    } else {
      // 其他失败（Page crashed、超时、选择器未找到等）不改状态，账号继续可用
      // 回退 last_query_count，因为这次查询未成功消耗
      await query(
        `UPDATE platform_auth SET last_query_count = GREATEST(last_query_count - 1, 0), updated_at = NOW() WHERE id = $1`,
        [authId]
      );
    }
  }
}

/** 手动重置账号状态（用于前端"恢复"按钮，将 banned/offline 恢复为 normal） */
export async function resetAccountHealth(authId: number): Promise<void> {
  await query(
    `UPDATE platform_auth
     SET health_status = 'normal',
         risk_level = 'none',
         risk_count = 0,
         risk_detected_at = NULL,
         cooldown_until = NULL,
         offline_fail_count = 0,
         renewal_fail_count = 0,
         status = 'active',
         updated_at = NOW()
     WHERE id = $1`,
    [authId]
  );
}

/** 删除平台账号授权 */
export async function deletePlatformAuth(id: number): Promise<void> {
  await query(`DELETE FROM platform_auth WHERE id = $1`, [id]);
}

/** 每日重置查询计数（凌晨 0 点执行）
 * 新设计：只重置 last_query_count 和 offline_fail_count，不自动恢复 banned/offline 状态（需人工处理）
 * 清零 offline_fail_count 是为了让被误判但未达3次阈值的账号次日重新计数
 */
export async function resetDailyAuthCounters(): Promise<void> {
  // 重置查询计数
  await query(`UPDATE platform_auth SET last_query_count = 0 WHERE last_query_count > 0`);
  // 清零 offline_fail_count（未达3次阈值的账号次日重新计数，避免长期累积导致误判）
  await query(`UPDATE platform_auth SET offline_fail_count = 0 WHERE offline_fail_count > 0 AND health_status != 'offline'`);
  // banned/offline 状态需要人工恢复，不自动恢复
}

/** 获取所有活跃授权（用于自动续期） */
export async function getAllActiveAuths() {
  const result = await query(
    `SELECT id, platform, storage_state FROM platform_auth WHERE status = 'active'`
  );
  return result.rows;
}

/** 更新账号的 storageState（续期时用） */
export async function updatePlatformAuthStorage(id: number, storageState: string, expiresAt?: Date): Promise<void> {
  await query(
    `UPDATE platform_auth SET storage_state = $1, expires_at = $2, updated_at = NOW() WHERE id = $3`,
    [storageState, expiresAt || null, id]
  );
}

/** 标记账号状态 */
export async function updatePlatformAuthStatus(id: number, status: string): Promise<void> {
  await query(`UPDATE platform_auth SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
}

/** 更新账号每日查询限额 */
export async function updatePlatformAuthDailyLimit(id: number, dailyLimit: number): Promise<void> {
  await query(`UPDATE platform_auth SET daily_limit = $1, updated_at = NOW() WHERE id = $2`, [dailyLimit, id]);
}

/** 获取可用账号数统计 */
export async function getAvailableAuthCount(): Promise<{ total: number; byPlatform: Record<string, number> }> {
  const result = await query(
    `SELECT platform, COUNT(*) as count 
     FROM platform_auth 
     WHERE health_status = 'normal'
       AND (expires_at IS NULL OR expires_at > NOW())
       AND last_query_count < daily_limit
     GROUP BY platform`
  );
  const byPlatform: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    byPlatform[row.platform] = parseInt(row.count);
    total += parseInt(row.count);
  }
  return { total, byPlatform };
}

// ============ Worker 日志 ============

export async function insertWorkerLog(params: {
  workerId: string;
  taskId?: number;
  level: string;
  message: string;
}): Promise<void> {
  await query(
    `INSERT INTO worker_log (worker_id, task_id, level, message) VALUES ($1, $2, $3, $4)`,
    [params.workerId, params.taskId || null, params.level, params.message]
  );
}

/** 批量插入 worker 日志（单次 SQL，减少高频上报时的数据库压力） */
export async function insertWorkerLogs(entries: Array<{
  workerId: string;
  taskId?: number;
  level: string;
  message: string;
}>): Promise<void> {
  if (entries.length === 0) return;
  const values: string[] = [];
  const args: any[] = [];
  let idx = 1;
  for (const e of entries) {
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    args.push(e.workerId, e.taskId || null, e.level || 'info', String(e.message).substring(0, 2000));
  }
  await query(
    `INSERT INTO worker_log (worker_id, task_id, level, message) VALUES ${values.join(', ')}`,
    args
  );
}

export async function getWorkerLogs(params: {
  taskId?: number;
  limit?: number;
  sinceId?: number;
}): Promise<any[]> {
  const limit = params.limit || 100;
  const conditions: string[] = [];
  const args: any[] = [];
  let idx = 1;

  if (params.taskId) {
    conditions.push(`task_id = $${idx++}`);
    args.push(params.taskId);
  }
  if (params.sinceId) {
    conditions.push(`id > $${idx++}`);
    args.push(params.sinceId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  args.push(limit);

  const result = await query(
    `SELECT id, worker_id, task_id, level, message,
            to_char((create_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as create_time
     FROM worker_log ${whereClause}
     ORDER BY id DESC LIMIT $${idx}`,
    args
  );
  return result.rows;
}

export async function cleanOldWorkerLogs(daysToKeep: number = 7): Promise<void> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(daysToKeep)));
  await query(`DELETE FROM worker_log WHERE create_time < NOW() - make_interval(days => $1)`, [safeDays]);
}

/**
 * 清理过期的真实查询记录（防止 real_collect_record 无限膨胀）
 * 策略：保留最近 N 天的记录，更早的记录连同静态页一起删除（CASCADE）
 * 注意：只删除非当前轮次的记录，避免删除正在使用的数据
 */
export async function cleanOldRealCollectRecords(daysToKeep: number = 30): Promise<number> {
  const safeDays = Math.max(7, Math.min(365, Math.floor(daysToKeep)));
  const result = await query(
    `DELETE FROM real_collect_record
     WHERE create_time < NOW() - make_interval(days => $1)
       AND task_id NOT IN (
         SELECT DISTINCT task_id FROM real_collect_queue
         WHERE status IN ('pending', 'processing')
       )`,
    [safeDays]
  );
  return result.rowCount || 0;
}

// ============ 队列压力监控 ============

export async function getQueuePressure(): Promise<{ pendingCount: number; processingCount: number }> {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') as pending,
       COUNT(*) FILTER (WHERE status = 'running') as processing
     FROM real_collect_queue`
  );
  return {
    pendingCount: parseInt(result.rows[0]?.pending || '0'),
    processingCount: parseInt(result.rows[0]?.processing || '0'),
  };
}

// ============ 账号续期 ============

export async function getAuthsForRenewal(): Promise<any[]> {
  // 获取所有活跃且超过1天未续期的账号，使用 FOR UPDATE SKIP LOCKED 防止并发竞态
  // 排除已 expired/banned/offline 的账号，只续期 active 且 health_status=normal 的
  // 续期间隔从7天缩短为1天，确保 cookie 及时刷新，避免短期 cookie 过期导致显示"已过期"
  // v2.0.2: 只续期查询类账号（platform_type='query'/'both'），自媒体发布账号由桌面端发布 Worker 续期
  const result = await query(
    `UPDATE platform_auth
     SET updated_at = NOW()
     WHERE id IN (
       SELECT id FROM platform_auth
       WHERE status = 'active'
         AND health_status = 'normal'
         AND platform_type IN ('query', 'both')
         AND (last_renewal_attempt IS NULL OR last_renewal_attempt < NOW() - INTERVAL '1 day')
       ORDER BY last_renewal_attempt ASC NULLS FIRST
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, platform, storage_state`
  );
  return result.rows;
}

// ============ AEO 报告 ============

export async function insertAeoReport(params: {
  taskId: number;
  userId: string;
  reportDate: string;
  visibilityScore: number;
  mentionCount: number;
  positiveRatio: number;
  neutralRatio: number;
  negativeRatio: number;
  competitorAnalysis: string;
  suggestions: string;
  rawAnalysis: string;
  recordIds: number[];
}): Promise<number> {
  const result = await query(
    `INSERT INTO aeo_report
     (task_id, user_id, report_date, visibility_score, mention_count,
      positive_ratio, neutral_ratio, negative_ratio,
      competitor_analysis, suggestions, raw_analysis, record_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (task_id, report_date) DO UPDATE SET
       visibility_score = EXCLUDED.visibility_score,
       mention_count = EXCLUDED.mention_count,
       positive_ratio = EXCLUDED.positive_ratio,
       neutral_ratio = EXCLUDED.neutral_ratio,
       negative_ratio = EXCLUDED.negative_ratio,
       competitor_analysis = EXCLUDED.competitor_analysis,
       suggestions = EXCLUDED.suggestions,
       raw_analysis = EXCLUDED.raw_analysis,
       record_ids = EXCLUDED.record_ids
     RETURNING id`,
    [params.taskId, params.userId, params.reportDate, params.visibilityScore, params.mentionCount,
     params.positiveRatio, params.neutralRatio, params.negativeRatio,
     params.competitorAnalysis, params.suggestions, params.rawAnalysis, params.recordIds]
  );
  return result.rows[0].id;
}

export async function getAeoReports(params: {
  taskId?: number;
  userId?: string;
  limit?: number;
}): Promise<any[]> {
  const limit = params.limit || 30;
  const conditions: string[] = [];
  const args: any[] = [];
  let idx = 1;

  if (params.taskId) {
    conditions.push(`task_id = $${idx++}`);
    args.push(params.taskId);
  }
  if (params.userId) {
    conditions.push(`user_id = $${idx++}`);
    args.push(params.userId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  args.push(limit);

  const result = await query(
    `SELECT id, task_id, user_id,
            to_char(report_date, 'YYYY-MM-DD') as report_date,
            visibility_score, mention_count,
            positive_ratio, neutral_ratio, negative_ratio,
            competitor_analysis, suggestions, raw_analysis, record_ids,
            to_char((create_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as create_time
     FROM aeo_report ${whereClause}
     ORDER BY report_date DESC, id DESC LIMIT $${idx}`,
    args
  );
  return result.rows;
}

export async function getLatestAeoReport(taskId: number): Promise<any | null> {
  const result = await query(
    `SELECT id, task_id, user_id,
            to_char(report_date, 'YYYY-MM-DD') as report_date,
            visibility_score, mention_count,
            positive_ratio, neutral_ratio, negative_ratio,
            competitor_analysis, suggestions, raw_analysis, record_ids,
            to_char((create_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as create_time
     FROM aeo_report
     WHERE task_id = $1
     ORDER BY report_date DESC LIMIT 1`,
    [taskId]
  );
  return result.rows[0] || null;
}

export async function getAeoReportById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT id, task_id, user_id,
            to_char(report_date, 'YYYY-MM-DD') as report_date,
            visibility_score, mention_count,
            positive_ratio, neutral_ratio, negative_ratio,
            competitor_analysis, suggestions, raw_analysis, record_ids,
            to_char((create_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as create_time
     FROM aeo_report WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** 获取任务当天已收集的品牌提及记录 */
export async function getBrandMentionRecordsForAeo(taskId: number, limit: number = 200): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = await query(
    `SELECT id, keyword, platform, raw_content, share_url, matched_brands,
            to_char((query_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as query_time
     FROM real_collect_record
     WHERE task_id = $1
       AND brand_matched = true
       AND query_time >= (CURRENT_DATE AT TIME ZONE 'Asia/Shanghai')::timestamp
     ORDER BY query_time DESC LIMIT $2`,
    [taskId, safeLimit]
  );
  return result.rows;
}

/** 获取所有需要生成 AEO 日报的活跃任务 */
export async function getActiveTasksForAeo(): Promise<any[]> {
  const result = await query(
    `SELECT t.id, t.user_id, t.task_name, t.keyword_type, t.create_time
     FROM real_collect_task t
     WHERE t.status = 'active'
     ORDER BY t.id`
  );
  return result.rows;
}

// ============ v2.0.0: 时间维度报告（周/月报） ============

/** 时间维度报告记录 */
export interface AeoPeriodReport {
  id: number;
  task_id: number | null;
  user_id: string | null;
  period_type: string;
  period_start: string;
  period_end: string;
  inclusion_summary: any;
  rank_summary: any;
  platform_comparison: any;
  shard_suggestions_summary: string | null;
  writing_suggestions: any;
  suggested_article_count: number;
  actual_article_count: number;
  status: string;
  created_at: string;
}

/** 获取客户的 AEO 报告周期起始日（aeo_report_start_date 或任务创建日） */
export async function getAeoReportStartDate(userId: string): Promise<Date> {
  // 优先从 cloud_api_config 读取 aeo_report_start_date
  const configResult = await query(
    `SELECT aeo_report_start_date FROM cloud_api_config WHERE user_id = $1`,
    [userId]
  );
  if (configResult.rows[0]?.aeo_report_start_date) {
    return new Date(configResult.rows[0].aeo_report_start_date);
  }
  // 回退到该用户的第一个任务创建日
  const taskResult = await query(
    `SELECT create_time FROM real_collect_task WHERE user_id = $1 ORDER BY create_time ASC LIMIT 1`,
    [userId]
  );
  if (taskResult.rows[0]?.create_time) {
    return new Date(taskResult.rows[0].create_time);
  }
  // 最终回退到今天
  return new Date();
}

/** 检查客户今天是否需要生成周报（按创建日计算周期） */
export async function shouldGenerateWeeklyReport(userId: string, now: Date = new Date()): Promise<boolean> {
  const startDate = await getAeoReportStartDate(userId);
  const daysSinceStart = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  return daysSinceStart >= 7 && daysSinceStart % 7 === 0;
}

/** 检查客户今天是否需要生成月报（按创建日的日期，每月该日） */
export async function shouldGenerateMonthlyReport(userId: string, now: Date = new Date()): Promise<boolean> {
  const startDate = await getAeoReportStartDate(userId);
  const todayDay = now.getDate();
  const startDay = startDate.getDate();
  // 如果起始日在28日之后，取每月最后一天
  if (startDay > 28) {
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return todayDay === lastDayOfMonth;
  }
  return todayDay === startDay;
}

/** 检查周期报告是否已存在（防重复） */
export async function checkPeriodReportExists(
  userId: string,
  periodType: string,
  periodStart: Date,
  periodEnd: Date
): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM aeo_period_report
     WHERE user_id = $1 AND period_type = $2
       AND period_start = $3 AND period_end = $4
     LIMIT 1`,
    [userId, periodType, periodStart, periodEnd]
  );
  return result.rows.length > 0;
}

/** 插入时间维度报告 */
export async function insertAeoPeriodReport(data: {
  task_id?: number;
  user_id?: string;
  period_type: string;
  period_start: Date;
  period_end: Date;
  inclusion_summary?: any;
  rank_summary?: any;
  platform_comparison?: any;
  shard_suggestions_summary?: string;
  writing_suggestions?: any;
  suggested_article_count?: number;
  actual_article_count?: number;
  status?: string;
}): Promise<number> {
  const result = await query(
    `INSERT INTO aeo_period_report
      (task_id, user_id, period_type, period_start, period_end,
       inclusion_summary, rank_summary, platform_comparison,
       shard_suggestions_summary, writing_suggestions,
       suggested_article_count, actual_article_count, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      data.task_id || null,
      data.user_id || null,
      data.period_type,
      data.period_start,
      data.period_end,
      data.inclusion_summary ? JSON.stringify(data.inclusion_summary) : null,
      data.rank_summary ? JSON.stringify(data.rank_summary) : null,
      data.platform_comparison ? JSON.stringify(data.platform_comparison) : null,
      data.shard_suggestions_summary || null,
      data.writing_suggestions ? JSON.stringify(data.writing_suggestions) : null,
      data.suggested_article_count || 0,
      data.actual_article_count || 0,
      data.status || 'generated',
    ]
  );
  return result.rows[0].id;
}

/** 更新周期报告的实际创建文章数 */
export async function updatePeriodReportArticleCount(reportId: number, count: number): Promise<void> {
  await query(
    `UPDATE aeo_period_report SET actual_article_count = $1 WHERE id = $2`,
    [count, reportId]
  );
}

/** 查询时间维度报告列表（分页） */
export async function getAeoPeriodReports(
  userId?: string,
  periodType?: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ list: AeoPeriodReport[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (periodType) {
    params.push(periodType);
    conditions.push(`period_type = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) AS total FROM aeo_period_report ${where}`, params);
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT * FROM aeo_period_report ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { list: result.rows as AeoPeriodReport[], total };
}

/** 获取单个时间维度报告详情 */
export async function getAeoPeriodReportById(id: number): Promise<AeoPeriodReport | null> {
  const result = await query(`SELECT * FROM aeo_period_report WHERE id = $1`, [id]);
  return (result.rows[0] as AeoPeriodReport) || null;
}

/** 获取用户的所有活跃任务（用于周期报告汇总） */
export async function getActiveTasksByUser(userId: string): Promise<any[]> {
  const result = await query(
    `SELECT id, user_id, task_name, keyword_type, create_time
     FROM real_collect_task
     WHERE user_id = $1 AND status = 'active'
     ORDER BY id`,
    [userId]
  );
  return result.rows;
}

/** 获取用户在指定时间范围内的收录统计（用于周期报告） */
export async function getInclusionStatsByTimeRange(
  userId: string,
  startTime: Date,
  endTime: Date
): Promise<any> {
  // 总查询记录数
  const totalResult = await query(
    `SELECT COUNT(*) AS total FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time <= $3`,
    [userId, startTime, endTime]
  );
  // 品牌命中数
  const brandResult = await query(
    `SELECT COUNT(*) AS brand_matched FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time <= $3 AND brand_matched = true`,
    [userId, startTime, endTime]
  );
  // 各平台收录分布
  const platformResult = await query(
    `SELECT platform, COUNT(*) AS count,
            SUM(CASE WHEN brand_matched = true THEN 1 ELSE 0 END) AS brand_count
     FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time <= $3
     GROUP BY platform
     ORDER BY count DESC`,
    [userId, startTime, endTime]
  );

  const total = parseInt(totalResult.rows[0]?.total || '0', 10);
  const brandMatched = parseInt(brandResult.rows[0]?.brand_matched || '0', 10);
  return {
    total,
    brand_matched: brandMatched,
    inclusion_rate: total > 0 ? Math.round((brandMatched / total) * 10000) / 100 : 0,
    platform_breakdown: platformResult.rows,
  };
}

/**
 * v2.0.1: AEO 数据大屏聚合查询
 *
 * 一次查询返回大屏所需的所有数据，从 real_collect_record + aeo_shard_report + aeo_period_report 聚合
 * 不调用 AI，纯 SQL 聚合，响应 < 500ms
 *
 * @param userId 客户 ID（users.id 转字符串）
 * @param days 时间范围天数（默认 30 天）
 */
export async function getAeoDashboardData(userId: string, days: number = 30): Promise<any> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  // 上一周期（用于环比）
  const prevStartTime = new Date(startTime.getTime() - days * 24 * 60 * 60 * 1000);

  // ---- 1. KPI：总记录数、品牌命中、关键词覆盖（当前周期） ----
  const kpiResult = await query(
    `SELECT
       COUNT(*) AS total_records,
       SUM(CASE WHEN brand_matched = true THEN 1 ELSE 0 END) AS brand_matched,
       COUNT(DISTINCT keyword) AS keywords_covered
     FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time <= $3`,
    [userId, startTime, endTime]
  );

  // ---- 2. KPI：上一周期（环比） ----
  const prevKpiResult = await query(
    `SELECT
       COUNT(*) AS total_records,
       SUM(CASE WHEN brand_matched = true THEN 1 ELSE 0 END) AS brand_matched,
       COUNT(DISTINCT keyword) AS keywords_covered
     FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time < $3`,
    [userId, prevStartTime, startTime]
  );

  // ---- 3. KPI：分片报告聚合（可见度、情感、提及数） ----
  const shardKpi = await query(
    `SELECT
       COALESCE(AVG(visibility_score), 0) AS avg_visibility,
       COALESCE(AVG(positive_ratio), 0) AS avg_positive,
       COALESCE(AVG(negative_ratio), 0) AS avg_negative,
       COALESCE(AVG(neutral_ratio), 0) AS avg_neutral,
       COALESCE(SUM(brand_matched_count), 0) AS total_mentions
     FROM aeo_shard_report
     WHERE user_id = $1 AND created_at >= $2`,
    [userId, startTime]
  );

  // ---- 4. 上一周期分片报告（环比） ----
  const prevShardKpi = await query(
    `SELECT
       COALESCE(AVG(visibility_score), 0) AS avg_visibility,
       COALESCE(AVG(negative_ratio), 0) AS avg_negative,
       COALESCE(SUM(brand_matched_count), 0) AS total_mentions
     FROM aeo_shard_report
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
    [userId, prevStartTime, startTime]
  );

  // ---- 5. 当前轮次 ----
  const roundResult = await query(
    `SELECT MAX(round_no) AS current_round
     FROM real_collect_task
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  // ---- 6. 关键词总数 ----
  const keywordTotal = await query(
    `SELECT COUNT(*) AS total FROM zlgjc WHERE userid = $1`,
    [userId]
  );

  // ---- 7. 趋势：分片级收录率 + 可见度 + 情感序列 ----
  const shardTrend = await query(
    `SELECT
       shard_end_time,
       record_count,
       brand_matched_count,
       visibility_score,
       positive_ratio,
       neutral_ratio,
       negative_ratio,
       round_no
     FROM aeo_shard_report
     WHERE user_id = $1 AND created_at >= $2 AND shard_end_time IS NOT NULL
     ORDER BY shard_end_time ASC`,
    [userId, startTime]
  );

  // ---- 8. 趋势：周期级收录率序列 ----
  const periodTrend = await query(
    `SELECT
       period_type,
       period_start,
       period_end,
       inclusion_summary,
       rank_summary
     FROM aeo_period_report
     WHERE user_id = $1 AND period_end >= $2
     ORDER BY period_end ASC`,
    [userId, startTime.toISOString().slice(0, 10)]
  );

  // ---- 9. 平台分布 ----
  const platformDist = await query(
    `SELECT platform,
       COUNT(*) AS total,
       SUM(CASE WHEN brand_matched = true THEN 1 ELSE 0 END) AS matched
     FROM real_collect_record
     WHERE user_id = $1 AND query_time >= $2 AND query_time <= $3
     GROUP BY platform
     ORDER BY total DESC`,
    [userId, startTime, endTime]
  );

  // ---- 10. 品牌提及热力图（最近 50 条分片报告的 brand_mentions） ----
  const brandMentions = await query(
    `SELECT brand_mentions
     FROM aeo_shard_report
     WHERE user_id = $1 AND created_at >= $2 AND brand_mentions IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId, startTime]
  );

  // ---- 11. 写作建议池（最近 5 条周期报告） ----
  const writingSuggestions = await query(
    `SELECT writing_suggestions, period_type, period_end
     FROM aeo_period_report
     WHERE user_id = $1 AND writing_suggestions IS NOT NULL
     ORDER BY period_end DESC
     LIMIT 5`,
    [userId]
  );

  // ---- 聚合结果 ----
  const totalRecords = parseInt(kpiResult.rows[0]?.total_records || '0', 10);
  const brandMatched = parseInt(kpiResult.rows[0]?.brand_matched || '0', 10);
  const keywordsCovered = parseInt(kpiResult.rows[0]?.keywords_covered || '0', 10);
  const keywordTotalCount = parseInt(keywordTotal.rows[0]?.total || '0', 10);

  const prevTotalRecords = parseInt(prevKpiResult.rows[0]?.total_records || '0', 10);
  const prevBrandMatched = parseInt(prevKpiResult.rows[0]?.brand_matched || '0', 10);
  const prevKeywordsCovered = parseInt(prevKpiResult.rows[0]?.keywords_covered || '0', 10);

  const avgVisibility = parseFloat(shardKpi.rows[0]?.avg_visibility || '0');
  const avgPositive = parseFloat(shardKpi.rows[0]?.avg_positive || '0');
  const avgNegative = parseFloat(shardKpi.rows[0]?.avg_negative || '0');
  const avgNeutral = parseFloat(shardKpi.rows[0]?.avg_neutral || '0');
  const totalMentions = parseInt(shardKpi.rows[0]?.total_mentions || '0', 10);

  const prevAvgVisibility = parseFloat(prevShardKpi.rows[0]?.avg_visibility || '0');
  const prevAvgNegative = parseFloat(prevShardKpi.rows[0]?.avg_negative || '0');
  const prevTotalMentions = parseInt(prevShardKpi.rows[0]?.total_mentions || '0', 10);

  const inclusionRate = totalRecords > 0 ? Math.round((brandMatched / totalRecords) * 10000) / 100 : 0;
  const prevInclusionRate = prevTotalRecords > 0 ? Math.round((prevBrandMatched / prevTotalRecords) * 10000) / 100 : 0;
  const keywordCoverage = keywordTotalCount > 0 ? Math.round((keywordsCovered / keywordTotalCount) * 10000) / 100 : 0;
  const prevKeywordCoverage = keywordTotalCount > 0 ? Math.round((prevKeywordsCovered / keywordTotalCount) * 10000) / 100 : 0;

  // 计算环比 delta
  const delta = (curr: number, prev: number) => prev === 0 ? 0 : Math.round((curr - prev) * 100) / 100;

  // 构建分片级趋势序列
  const inclusionRateSeries: Array<{ time: any; value: number; granularity: string; round_no: any }> = shardTrend.rows.map((r: any) => ({
    time: r.shard_end_time,
    value: r.record_count > 0 ? Math.round((r.brand_matched_count / r.record_count) * 10000) / 100 : 0,
    granularity: 'shard',
    round_no: r.round_no,
  }));

  // 追加周期级点
  for (const p of periodTrend.rows) {
    const inclusionSummary = typeof p.inclusion_summary === 'string' ? JSON.parse(p.inclusion_summary) : p.inclusion_summary;
    if (inclusionSummary?.inclusion_rate !== undefined) {
      inclusionRateSeries.push({
        time: p.period_end,
        value: parseFloat(inclusionSummary.inclusion_rate),
        granularity: p.period_type,
        round_no: null,
      });
    }
  }

  // 可见度趋势序列
  const visibilitySeries = shardTrend.rows.map((r: any) => ({
    time: r.shard_end_time,
    value: parseFloat(r.visibility_score || '0'),
    round_no: r.round_no,
  }));

  // 情感趋势序列
  const sentimentSeries = shardTrend.rows.map((r: any) => ({
    time: r.shard_end_time,
    positive: parseFloat(r.positive_ratio || '0'),
    neutral: parseFloat(r.neutral_ratio || '0'),
    negative: parseFloat(r.negative_ratio || '0'),
  }));

  // 平台分布
  const platformRecords = platformDist.rows.map((r: any) => ({
    platform: r.platform,
    total: parseInt(r.total, 10),
    matched: parseInt(r.matched, 10),
  }));

  // 品牌提及热力图数据
  const heatmapData: Array<{ keyword: string; platform: string; count: number }> = [];
  const heatmapMap = new Map<string, number>();
  for (const row of brandMentions.rows) {
    const mentions = typeof row.brand_mentions === 'string' ? JSON.parse(row.brand_mentions) : row.brand_mentions;
    if (!Array.isArray(mentions)) continue;
    for (const m of mentions) {
      const kw = m.keyword || m.keyword_text || '';
      const plat = m.platform || '';
      if (!kw || !plat) continue;
      const key = `${kw}|||${plat}`;
      heatmapMap.set(key, (heatmapMap.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of heatmapMap) {
    const [keyword, platform] = key.split('|||');
    heatmapData.push({ keyword, platform, count });
  }

  // 写作建议池
  const suggestionsPool: any[] = [];
  for (const row of writingSuggestions.rows) {
    const suggestions = typeof row.writing_suggestions === 'string' ? JSON.parse(row.writing_suggestions) : row.writing_suggestions;
    if (!Array.isArray(suggestions)) continue;
    for (const s of suggestions) {
      suggestionsPool.push({
        topic: s.topic || s.title || '',
        priority: s.priority || 'medium',
        platforms: s.platforms || [],
        reason: s.reason || s.direction || '',
        period_type: row.period_type,
        period_end: row.period_end,
      });
    }
  }

  return {
    kpi: {
      inclusion_rate: inclusionRate,
      inclusion_rate_delta: delta(inclusionRate, prevInclusionRate),
      avg_visibility: Math.round(avgVisibility * 100) / 100,
      avg_visibility_delta: delta(avgVisibility, prevAvgVisibility),
      brand_mentions: totalMentions,
      brand_mentions_delta: delta(totalMentions, prevTotalMentions),
      negative_ratio: Math.round(avgNegative * 100) / 100,
      negative_ratio_delta: delta(avgNegative, prevAvgNegative),
      keyword_coverage: keywordCoverage,
      keyword_coverage_delta: delta(keywordCoverage, prevKeywordCoverage),
      current_round: parseInt(roundResult.rows[0]?.current_round || '0', 10),
      total_records: totalRecords,
      total_keywords: keywordTotalCount,
    },
    trends: {
      inclusion_rate: inclusionRateSeries,
      visibility: visibilitySeries,
      sentiment: sentimentSeries,
    },
    distributions: {
      platform_records: platformRecords,
      sentiment_pie: {
        positive: Math.round(avgPositive * 100) / 100,
        neutral: Math.round(avgNeutral * 100) / 100,
        negative: Math.round(avgNegative * 100) / 100,
      },
    },
    deep_analysis: {
      brand_heatmap: heatmapData.slice(0, 200),
      writing_suggestions: suggestionsPool.slice(0, 50),
    },
    last_updated: new Date().toISOString(),
  };
}

/** 检查今日是否已生成 AEO 报告 */
export async function checkAeoReportExists(taskId: number, reportDate: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM aeo_report WHERE task_id = $1 AND report_date = $2`,
    [taskId, reportDate]
  );
  return result.rows.length > 0;
}

// ============ 内容中枢：AI模型配置 ============

export async function getAiModelConfigs(userId: number): Promise<any[]> {
  // 返回用户自有配置 + 平台共享配置（user_id IS NULL）
  //
  // ⚠️ v1.4.4 修复"部署后配置丢失"问题：
  //   旧 SQL `WHERE user_id = $1 OR user_id IS NULL` 在 userId=0 时（token 失效/解析异常）
  //   只能查到共享配置（无 api_key，开关为默认值），导致用户看到"配置被清空"。
  //   但智能巡检的 getApiConfigForCollect 不依赖 user_id，仍能查到配置，说明数据没丢。
  //
  //   新 SQL 增加 fallback：查询范围扩大到"所有有 api_key 的配置"，通过 ORDER BY 优先级
  //   确保正常情况下仍返回当前用户的配置，仅在 userId=0 时 fallback 到其他用户的有 KEY 配置。
  //   这样部署后 token 失效也能自动恢复显示，无需用户手动重新输入。
  //
  // 排序优先级（DESC/ASC 配合 DISTINCT ON 取每组第一条）：
  //   1. (user_id = $1) DESC — 当前用户的配置最优先
  //   2. (api_key_encrypted IS NOT NULL) DESC — 有 api_key 的优于无 KEY 的共享配置
  //   3. (user_id IS NULL) ASC — 用户私有配置（非 null）优于共享配置
  //   4. update_time DESC, id DESC — 最新的优先
  const result = await query(
    `SELECT DISTINCT ON (platform)
            id, user_id, platform, model_name, base_url, max_tokens, temperature,
            is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at,
            api_key_encrypted,
            CASE WHEN api_key_encrypted IS NOT NULL AND api_key_encrypted != '' THEN '已配置' ELSE NULL END AS api_key_masked,
            create_time, update_time
     FROM ai_model_config
     WHERE user_id = $1 OR user_id IS NULL OR api_key_encrypted IS NOT NULL
     ORDER BY platform,
              (user_id = $1) DESC,
              (api_key_encrypted IS NOT NULL) DESC,
              (user_id IS NULL) ASC,
              update_time DESC, id DESC`,
    [userId]
  );
  return result.rows;
}

export async function getAiModelConfigById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * 获取用户的默认 AI 模型配置（用于写作任务自动选模型）
 * 优先级：
 *   1. 用户私有配置中 is_active=true 的最新一条
 *   2. 平台共享配置（user_id IS NULL）中 is_active=true 的最新一条
 */
export async function getDefaultModelConfig(userId: number): Promise<any | null> {
  // v1.8.2：按 use_for_writing=true 过滤（之前错误用 is_active，导致发布模型被写作任务取走）
  // is_active 现在仅表示配置启用，不再承载"用于写作"语义
  // 先查用户私有配置（必须已配置 api_key，避免返回空 KEY 的记录导致后续调用失败）
  let result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id = $1 AND is_active = true AND use_for_writing = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time DESC LIMIT 1`,
    [userId]
  );
  if (result.rows[0]) return result.rows[0];
  // 降级：平台共享配置
  result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id IS NULL AND is_active = true AND use_for_writing = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * v1.8.2：获取用于发布的默认模型（按 use_for_publish=true 过滤）
 * 发布流程（桌面端 publishWorker 的 aiActionExecutor 截图识别）调用
 * 优先取 use_for_publish=true 的模型，找不到则降级取 getDefaultModelConfig（写作模型兜底）
 */
export async function getPublishModelConfig(userId: number): Promise<any | null> {
  let result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id = $1 AND is_active = true AND use_for_publish = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time DESC LIMIT 1`,
    [userId]
  );
  if (result.rows[0]) return result.rows[0];
  // 降级1：平台共享配置中 use_for_publish=true 的
  result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id IS NULL AND is_active = true AND use_for_publish = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time DESC LIMIT 1`
  );
  if (result.rows[0]) return result.rows[0];
  // 降级2：没有专门的发布模型时，用写作模型兜底（避免发布流程无模型可用）
  return getDefaultModelConfig(userId);
}

/**
 * v2.0.5：获取用于 AEO 分析的模型配置
 * 优先级：
 *   1. 用户私有配置中 use_for_aeo=true 的（必须有 api_key）
 *   2. 平台共享配置中 use_for_aeo=true 的
 *   3. 降级取 getDefaultModelConfig（写作模型兜底）
 *   4. 都没有返回 null（调用方走 fallbackAnalysis 纯代码分析）
 */
export async function getAeoModelConfig(userId: string): Promise<any | null> {
  // 1. 用户私有配置
  let result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id = $1 AND is_active = true AND use_for_aeo = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time ASC LIMIT 1`,
    [userId]
  );
  if (result.rows[0]) return result.rows[0];
  // 2. 平台共享配置
  result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            use_for_collect, use_for_embedding, web_search,
            daily_quota, used_today, quota_reset_at
     FROM ai_model_config
     WHERE user_id IS NULL AND is_active = true AND use_for_aeo = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY create_time ASC LIMIT 1`
  );
  if (result.rows[0]) return result.rows[0];
  // 3. 降级：写作模型兜底
  const userIdNum = parseInt(userId);
  if (!isNaN(userIdNum)) {
    return getDefaultModelConfig(userIdNum);
  }
  return null;
}

export async function getActiveModelConfig(userId: number, platform: string): Promise<any | null> {
  // 优先返回用户自有配置，其次返回共享配置
  const result = await query(
    `SELECT id, user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, daily_quota, used_today, quota_reset_at, web_search
     FROM ai_model_config
     WHERE platform = $1 AND is_active = true
       AND (user_id = $2 OR user_id IS NULL)
     ORDER BY user_id NULLS LAST
     LIMIT 1`,
    [platform, userId]
  );
  return result.rows[0] || null;
}

export async function createAiModelConfig(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO ai_model_config (user_id, platform, model_name, api_key_encrypted, base_url,
            max_tokens, temperature, is_active, use_for_writing, use_for_publish, use_for_aeo,
            daily_quota, use_for_collect, web_search)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [data.user_id, data.platform, data.model_name, data.api_key_encrypted, data.base_url,
     data.max_tokens || 4096, data.temperature ?? 0.7, data.is_active ?? true,
     data.use_for_writing ?? true, data.use_for_publish ?? false, data.use_for_aeo ?? false,
     data.daily_quota, data.use_for_collect ?? false, data.web_search ?? false]
  );
  return result.rows[0].id;
}

export async function updateAiModelConfig(id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (data.model_name !== undefined) { fields.push(`model_name = $${idx++}`); values.push(data.model_name); }
  if (data.api_key_encrypted !== undefined) { fields.push(`api_key_encrypted = $${idx++}`); values.push(data.api_key_encrypted); }
  if (data.base_url !== undefined) { fields.push(`base_url = $${idx++}`); values.push(data.base_url); }
  if (data.max_tokens !== undefined) { fields.push(`max_tokens = $${idx++}`); values.push(data.max_tokens); }
  if (data.temperature !== undefined) { fields.push(`temperature = $${idx++}`); values.push(data.temperature); }
  if (data.is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(data.is_active); }
  if (data.use_for_writing !== undefined) { fields.push(`use_for_writing = $${idx++}`); values.push(data.use_for_writing); }
  if (data.use_for_publish !== undefined) { fields.push(`use_for_publish = $${idx++}`); values.push(data.use_for_publish); }
  if (data.use_for_aeo !== undefined) { fields.push(`use_for_aeo = $${idx++}`); values.push(data.use_for_aeo); }
  if (data.daily_quota !== undefined) { fields.push(`daily_quota = $${idx++}`); values.push(data.daily_quota); }
  if (data.use_for_collect !== undefined) { fields.push(`use_for_collect = $${idx++}`); values.push(data.use_for_collect); }
  if (data.web_search !== undefined) { fields.push(`web_search = $${idx++}`); values.push(data.web_search); }
  if (fields.length === 0) return;
  fields.push(`update_time = NOW()`);
  values.push(id);
  await query(`UPDATE ai_model_config SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function deleteAiModelConfig(id: number): Promise<void> {
  await query('DELETE FROM ai_model_config WHERE id = $1', [id]);
}

/**
 * 巡检平台名 → ai_model_config.platform 映射
 * 巡检 Worker 用的平台名（如 'DeepSeek'、'豆包'）与 ai_model_config 表的 platform 字段（如 'deepseek'、'doubao'）不一致
 */
const COLLECT_PLATFORM_TO_MODEL_PLATFORM: Record<string, string> = {
  'DeepSeek': 'deepseek',
  '豆包': 'doubao',
  '腾讯元宝': 'hunyuan',
  '通义千问': 'qianwen',
  '文心一言': 'wenxin',
  'Kimi': 'kimi',
  '智谱AI': 'zhipu',
  // 纳米（360）暂无官方 API，走爬虫兜底
};

/**
 * 获取巡检用的 API 配置（v1.4：Worker 用 API 替代爬虫）
 *
 * 查询条件：
 *   - platform 映射后 = ai_model_config.platform
 *   - use_for_collect = TRUE（用户在「AI模型配置」勾选了"用于巡检"开关）
 *   - api_key_encrypted 非空（必须配置了 API KEY）
 *   - 优先用户私有配置，其次共享配置
 *
 * 注意：is_active（用于写作）与 use_for_collect（用于巡检）是两个独立的开关，
 *       巡检只需要 use_for_collect = TRUE，不要求 is_active = TRUE。
 *       用户可以只开启巡检而不开启写作，反之亦然。
 *
 * 返回解密后的 api_key + base_url + model_name
 */
export async function getApiConfigForCollect(collectPlatform: string): Promise<{
  baseUrl: string;
  apiKey: string;
  modelName: string;
  webSearch: boolean;
} | null> {
  const modelPlatform = COLLECT_PLATFORM_TO_MODEL_PLATFORM[collectPlatform];
  if (!modelPlatform) {
    // 该巡检平台没有对应的 API 模型（如纳米/360），返回 null 让 Worker 走爬虫
    return null;
  }

  // ⚠️ v1.4.4 修复：用户反馈"关闭用于巡检后仍调 API"
  //   根因：数据库中存在同一 platform 的多条历史记录，旧的 use_for_collect=TRUE 记录
  //   可能被选中（即使最新记录已改为 FALSE）。
  //   修复：用 DISTINCT ON (platform) + ORDER BY update_time DESC 确保取最新一条记录，
  //   再判断该记录的 use_for_collect 是否为 TRUE。
  //
  //   旧 SQL 直接 WHERE use_for_collect = TRUE 会命中所有历史 TRUE 记录，
  //   新 SQL 先取最新一条，再在应用层判断 use_for_collect。
  const result = await query(
    `SELECT id, user_id, model_name, api_key_encrypted, base_url, max_tokens, temperature, web_search, use_for_collect, update_time
     FROM ai_model_config
     WHERE platform = $1
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY update_time DESC, id DESC
     LIMIT 1`,
    [modelPlatform]
  );
  if (result.rows.length === 0) {
    console.log(`[getApiConfigForCollect] ${collectPlatform} -> ${modelPlatform}: 无配置（走爬虫）`);
    return null;
  }

  const row = result.rows[0];
  console.log(`[getApiConfigForCollect] ${collectPlatform} -> ${modelPlatform}: 选中记录 id=${row.id} use_for_collect=${row.use_for_collect} update_time=${row.update_time}`);

  // v1.4.4：取最新记录后，再判断 use_for_collect 开关
  // 这样即使数据库中有旧的 TRUE 记录，只要最新记录是 FALSE，就走爬虫
  if (!row.use_for_collect) {
    console.log(`[getApiConfigForCollect] ${collectPlatform}: 最新记录 use_for_collect=FALSE，走爬虫`);
    return null;
  }

  let apiKey = '';
  try {
    apiKey = decrypt(row.api_key_encrypted);
  } catch {
    console.error(`[getApiConfigForCollect] api_key 解密失败: platform=${modelPlatform} id=${row.id}`);
    return null;
  }
  if (!apiKey) return null;

  return {
    baseUrl: row.base_url,
    apiKey,
    modelName: row.model_name,
    webSearch: !!row.web_search,
  };
}

export async function incrementModelUsedCount(id: number): Promise<void> {
  await query(
    `UPDATE ai_model_config
     SET used_today = used_today + 1,
         quota_reset_at = CASE WHEN quota_reset_at IS NULL OR quota_reset_at < CURRENT_DATE
                               THEN CURRENT_DATE + INTERVAL '1 day' ELSE quota_reset_at END
     WHERE id = $1`,
    [id]
  );
}

export async function resetDailyQuotaIfNeeded(): Promise<void> {
  // 重置已过期的共享KEY日额度（由定时任务调用）
  await query(
    `UPDATE ai_model_config
     SET used_today = 0, quota_reset_at = CURRENT_DATE + INTERVAL '1 day'
     WHERE user_id IS NULL AND quota_reset_at IS NOT NULL AND quota_reset_at < NOW()`
  );
}

// ============ 内容中枢：云接口配置（cloud_api_config） ============
// 单行配置模式：每个 user_id 一行，9 个固定字段（参考 jlyl.net.cn/agent/api_set）

const CLOUD_API_FIELDS = [
  'aliyun_access_key',
  'aliyun_access_secret',
  'aliyun_oss_bucket',
  'aliyun_oss_endpoint',
  'aliyun_oss_cdn',
  'doubao_app_id',
  'coze_key',
  'coze_baowen_workflow_id',
  'coze_parse_workflow_id',
  'keyword_index_key',
] as const;

/** 获取当前用户的云接口配置（不存在则返回空对象） */
export async function getCloudApiConfig(userId: number): Promise<any | null> {
  const result = await query(
    `SELECT id, user_id, ${CLOUD_API_FIELDS.join(', ')}, create_time, update_time
     FROM cloud_api_config
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** 创建或更新云接口配置（upsert，按 user_id 唯一） */
export async function upsertCloudApiConfig(userId: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [userId];
  let idx = 2;
  for (const f of CLOUD_API_FIELDS) {
    fields.push(`${f} = $${idx++}`);
    values.push(data[f] ?? '');
  }
  await query(
    `INSERT INTO cloud_api_config (user_id, ${CLOUD_API_FIELDS.join(', ')})
     VALUES ($1, ${CLOUD_API_FIELDS.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (user_id)
     DO UPDATE SET ${fields.join(', ')}, update_time = NOW()`,
    values
  );
}

// ============ v2.0.0: AEO闭环配额字段（cloud_api_config 扩展） ============

/** AEO 配额字段列表（类型不同于 CLOUD_API_FIELDS，单独管理） */
const AEO_QUOTA_FIELDS = [
  'weekly_article_quota',
  'monthly_article_quota',
  'article_quota',
  'quota_cycle',
  'auto_publish_enabled',
  'aeo_report_start_date',
  'enable_competitor_geo',
  'competitor_brands',
] as const;

/** 获取当前用户的 AEO 配额配置 */
export async function getAeoQuotaConfig(userId: number): Promise<any | null> {
  const result = await query(
    `SELECT user_id, ${AEO_QUOTA_FIELDS.join(', ')}
     FROM cloud_api_config
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** 更新当前用户的 AEO 配额配置（upsert，按 user_id 唯一） */
export async function upsertAeoQuotaConfig(userId: number, data: any): Promise<void> {
  // 先确保 cloud_api_config 行存在（如果没有则创建空行）
  await query(
    `INSERT INTO cloud_api_config (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (data.weekly_article_quota !== undefined) {
    fields.push(`weekly_article_quota = $${idx++}`);
    values.push(Number(data.weekly_article_quota) || 0);
  }
  if (data.monthly_article_quota !== undefined) {
    fields.push(`monthly_article_quota = $${idx++}`);
    values.push(Number(data.monthly_article_quota) || 0);
  }
  // v2.0.2: 统一配额字段
  if (data.article_quota !== undefined) {
    fields.push(`article_quota = $${idx++}`);
    values.push(Number(data.article_quota) || 0);
  }
  if (data.quota_cycle !== undefined) {
    fields.push(`quota_cycle = $${idx++}`);
    values.push(data.quota_cycle === 'monthly' ? 'monthly' : 'weekly');
  }
  if (data.auto_publish_enabled !== undefined) {
    fields.push(`auto_publish_enabled = $${idx++}`);
    values.push(!!data.auto_publish_enabled);
  }
  if (data.aeo_report_start_date !== undefined) {
    fields.push(`aeo_report_start_date = $${idx++}`);
    values.push(data.aeo_report_start_date || null);
  }
  if (data.enable_competitor_geo !== undefined) {
    fields.push(`enable_competitor_geo = $${idx++}`);
    values.push(!!data.enable_competitor_geo);
  }
  if (data.competitor_brands !== undefined) {
    fields.push(`competitor_brands = $${idx++}`);
    values.push(JSON.stringify(data.competitor_brands || []));
  }

  if (fields.length === 0) return;

  values.push(userId);
  await query(
    `UPDATE cloud_api_config SET ${fields.join(', ')}, update_time = NOW() WHERE user_id = $${idx}`,
    values
  );
}

// ============ 内容中枢：写作指令 ============

export async function getWritingInstructions(userId: number, category?: string): Promise<any[]> {
  let sql = `SELECT * FROM writing_instruction WHERE user_id = $1 AND is_active = true`;
  const params: any[] = [userId];
  if (category) {
    sql += ` AND category = $2`;
    params.push(category);
  }
  sql += ` ORDER BY category, create_time DESC`;
  const result = await query(sql, params);
  return result.rows;
}

/** 获取所有客户的写作指令（管理员视角，用于桌面端指令库管理） */
export async function getAllWritingInstructions(category?: string): Promise<any[]> {
  let sql = `SELECT * FROM writing_instruction WHERE is_active = true`;
  const params: any[] = [];
  if (category) {
    params.push(category);
    sql += ` AND category = $1`;
  }
  sql += ` ORDER BY user_id, create_time DESC`;
  const result = await query(sql, params);
  return result.rows;
}

/** 获取指定客户名下的写作指令（管理员模式：customerId 由前端传入） */
export async function getWritingInstructionsByCustomer(customerId: number, category?: string): Promise<any[]> {
  return getWritingInstructions(customerId, category);
}

export async function getWritingInstructionById(id: number): Promise<any | null> {
  const result = await query('SELECT * FROM writing_instruction WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function createWritingInstruction(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO writing_instruction (user_id, name, category, article_prompt, title_prompt,
            target_word_count, include_faq, include_comparison_table, is_active, content_types, random_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
     RETURNING id`,
    [data.user_id, data.name, data.category, data.article_prompt || '', data.title_prompt || '',
     data.target_word_count || 1500, data.include_faq ?? true, data.include_comparison_table ?? true,
     JSON.stringify(data.content_types || []), data.random_mode ?? false]
  );
  return result.rows[0].id;
}

export async function updateWritingInstruction(id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const key of ['name', 'category', 'article_prompt', 'title_prompt', 'target_word_count', 'include_faq', 'include_comparison_table', 'is_active', 'random_mode']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }
  // content_types 单独处理（JSONB）
  if (data.content_types !== undefined) {
    fields.push(`content_types = $${idx++}`);
    values.push(JSON.stringify(data.content_types));
  }
  if (fields.length === 0) return;
  fields.push(`update_time = NOW()`);
  values.push(id);
  await query(`UPDATE writing_instruction SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function deleteWritingInstruction(id: number): Promise<void> {
  await query('UPDATE writing_instruction SET is_active = false WHERE id = $1', [id]);
}

// ============ 内容中枢：企业知识库 ============

export async function getEnterpriseKnowledges(userId: number): Promise<any[]> {
  const result = await query(
    `SELECT * FROM enterprise_knowledge WHERE user_id = $1 AND is_active = true ORDER BY create_time DESC`,
    [userId]
  );
  return result.rows;
}

/** 获取指定客户名下的企业知识库（管理员模式） */
export async function getEnterpriseKnowledgesByCustomer(customerId: number): Promise<any[]> {
  return getEnterpriseKnowledges(customerId);
}

/** 管理员视角：获取所有客户的企业知识库（不按 user_id 过滤，用于桌面端知识库列表） */
export async function getAllEnterpriseKnowledges(): Promise<any[]> {
  const result = await query(
    `SELECT * FROM enterprise_knowledge WHERE is_active = true ORDER BY user_id, create_time DESC`
  );
  return result.rows;
}

export async function getEnterpriseKnowledgeById(id: number): Promise<any | null> {
  const result = await query('SELECT * FROM enterprise_knowledge WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function createEnterpriseKnowledge(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO enterprise_knowledge (user_id, company_full_name, company_short_name, city, address,
            industry, founded_year, business_scope, entity_triples, intro_text, cases_text,
            products_services, product_features, user_pain_points, trust_endorsement, other_info, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true)
     RETURNING id`,
    [data.user_id, data.company_full_name, data.company_short_name, data.city, data.address,
     data.industry, data.founded_year, data.business_scope,
     JSON.stringify(data.entity_triples || []), data.intro_text, data.cases_text,
     data.products_services, data.product_features, data.user_pain_points,
     data.trust_endorsement, data.other_info]
  );
  return result.rows[0].id;
}

export async function updateEnterpriseKnowledge(id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const key of ['company_full_name', 'company_short_name', 'city', 'address', 'industry', 'founded_year', 'business_scope', 'intro_text', 'cases_text', 'products_services', 'product_features', 'user_pain_points', 'trust_endorsement', 'other_info']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }
  if (data.entity_triples !== undefined) {
    fields.push(`entity_triples = $${idx++}`);
    values.push(JSON.stringify(data.entity_triples));
  }
  if (fields.length === 0) return;
  fields.push(`update_time = NOW()`);
  values.push(id);
  await query(`UPDATE enterprise_knowledge SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function deleteEnterpriseKnowledge(id: number): Promise<void> {
  await query('UPDATE enterprise_knowledge SET is_active = false WHERE id = $1', [id]);
}

// ============ 内容中枢：智能体角色同步（agent_profile） ============

/**
 * 同步（upsert）智能体角色配置到云端
 * 桌面端 AGENT 人事部保存角色时调用，把 systemPrompt + 技能内容同步到云端
 * 用于内容中枢写作任务复用专家智能体
 */
export async function upsertAgentProfile(data: {
  user_id: number;
  role_id: string;
  name: string;
  description?: string;
  department_id?: string;
  department_name?: string;
  system_prompt?: string;
  skills_content?: string;
  skills_count?: number;
  provider?: string;
  model_name?: string;
  is_active?: boolean;
}): Promise<number> {
  const result = await query(
    `INSERT INTO agent_profile (user_id, role_id, name, description, department_id, department_name,
            system_prompt, skills_content, skills_count, provider, model_name, is_active, last_sync_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (user_id, role_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       department_id = EXCLUDED.department_id,
       department_name = EXCLUDED.department_name,
       system_prompt = EXCLUDED.system_prompt,
       skills_content = EXCLUDED.skills_content,
       skills_count = EXCLUDED.skills_count,
       provider = EXCLUDED.provider,
       model_name = EXCLUDED.model_name,
       is_active = EXCLUDED.is_active,
       last_sync_time = NOW(),
       update_time = NOW()
     RETURNING id`,
    [
      data.user_id, data.role_id, data.name, data.description || '', data.department_id || '',
      data.department_name || '', data.system_prompt || '', data.skills_content || '',
      data.skills_count || 0, data.provider || '', data.model_name || '',
      data.is_active !== false,
    ]
  );
  return result.rows[0].id;
}

/** 获取用户的智能体角色列表（不返回 skills_content 大字段，列表展示用） */
export async function getAgentProfiles(userId: number): Promise<any[]> {
  const result = await query(
    `SELECT id, user_id, role_id, name, description, department_id, department_name,
            skills_count, provider, model_name, is_active, last_sync_time, create_time, update_time
     FROM agent_profile
     WHERE user_id = $1
     ORDER BY update_time DESC`,
    [userId]
  );
  return result.rows;
}

/** 获取单个智能体角色详情（含 system_prompt + skills_content 完整字段） */
export async function getAgentProfileById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT * FROM agent_profile WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** 删除智能体角色同步记录 */
export async function deleteAgentProfile(id: number): Promise<void> {
  await query('DELETE FROM agent_profile WHERE id = $1', [id]);
}

// ============ 代理池管理（Phase 2：借鉴 BrowserAct 代理系统设计） ============

/** 创建代理 */
export async function createProxy(data: {
  user_id: string;
  name: string;
  provider?: string;
  proxy_type?: string;
  region?: string;
  endpoint: string;
  username?: string;
  password?: string;
  is_active?: boolean;
  remark?: string;
}): Promise<number> {
  const result = await query(
    `INSERT INTO proxy_pool (user_id, name, provider, proxy_type, region, endpoint, username, password, is_active, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      data.user_id, data.name, data.provider || 'custom', data.proxy_type || 'static',
      data.region || '', data.endpoint, data.username || '', data.password || '',
      data.is_active !== false, data.remark || '',
    ]
  );
  return result.rows[0].id;
}

/** 更新代理 */
export async function updateProxy(id: number, data: {
  name?: string;
  provider?: string;
  proxy_type?: string;
  region?: string;
  endpoint?: string;
  username?: string;
  password?: string;
  is_active?: boolean;
  remark?: string;
}): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
  if (data.provider !== undefined) { fields.push(`provider = $${idx++}`); values.push(data.provider); }
  if (data.proxy_type !== undefined) { fields.push(`proxy_type = $${idx++}`); values.push(data.proxy_type); }
  if (data.region !== undefined) { fields.push(`region = $${idx++}`); values.push(data.region); }
  if (data.endpoint !== undefined) { fields.push(`endpoint = $${idx++}`); values.push(data.endpoint); }
  if (data.username !== undefined) { fields.push(`username = $${idx++}`); values.push(data.username); }
  if (data.password !== undefined) { fields.push(`password = $${idx++}`); values.push(data.password); }
  if (data.is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(data.is_active); }
  if (data.remark !== undefined) { fields.push(`remark = $${idx++}`); values.push(data.remark); }
  if (fields.length === 0) return;
  fields.push(`updated_at = NOW()`);
  values.push(id);
  await query(`UPDATE proxy_pool SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

/** 获取用户的代理列表（不返回 password 明文，列表展示用） */
export async function getProxies(userId: string): Promise<any[]> {
  const result = await query(
    `SELECT id, user_id, name, provider, proxy_type, region, endpoint, username,
            is_active, last_check_at, last_check_ok, last_check_latency,
            total_used_count, remark, created_at, updated_at
     FROM proxy_pool
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/** 获取单个代理详情（含 password，供 Worker 使用） */
export async function getProxyById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT * FROM proxy_pool WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** 删除代理（同时清除 platform_auth 中的引用） */
export async function deleteProxy(id: number): Promise<void> {
  // 先清除 platform_auth 中的 proxy_id 引用
  await query(`UPDATE platform_auth SET proxy_id = NULL WHERE proxy_id = $1`, [id]);
  await query('DELETE FROM proxy_pool WHERE id = $1', [id]);
}

/** 更新代理健康检查结果 */
export async function updateProxyHealthCheck(
  id: number,
  ok: boolean,
  latency: number
): Promise<void> {
  await query(
    `UPDATE proxy_pool SET last_check_at = NOW(), last_check_ok = $1, last_check_latency = $2 WHERE id = $3`,
    [ok, latency, id]
  );
}

/** 递增代理使用计数 */
export async function incrementProxyUsedCount(id: number): Promise<void> {
  await query(`UPDATE proxy_pool SET total_used_count = total_used_count + 1 WHERE id = $1`, [id]);
}

// ============ 内容中枢：AI写作任务 ============

export async function createWritingTask(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO ai_writing_task (user_id, task_name, keyword_ids, instruction_id, knowledge_id,
            model_config_id, generation_mode, agent_profile_id, status, total_count, started_at,
            cover_image_mode, cover_image_id, illustration_count, target_platforms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', $9, NOW(), $10, $11, $12, $13)
     RETURNING id`,
    [data.user_id, data.task_name, data.keyword_ids, data.instruction_id, data.knowledge_id,
     data.model_config_id || null, data.generation_mode || 'expert', data.agent_profile_id || null,
     data.total_count,
     data.cover_image_mode || 'none', data.cover_image_id || null, data.illustration_count || 0,
     data.target_platforms && data.target_platforms.length > 0 ? JSON.stringify(data.target_platforms) : null]
  );
  return result.rows[0].id;
}

export async function getWritingTasks(userId: number, page: number = 1, pageSize: number = 20): Promise<{ list: any[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const countResult = await query('SELECT COUNT(*) as total FROM ai_writing_task WHERE user_id = $1', [userId]);
  const total = parseInt(countResult.rows[0].total);
  const result = await query(
    `SELECT t.*, i.name as instruction_name, k.company_short_name as knowledge_name,
            ap.name as agent_profile_name
     FROM ai_writing_task t
     LEFT JOIN writing_instruction i ON t.instruction_id = i.id
     LEFT JOIN enterprise_knowledge k ON t.knowledge_id = k.id
     LEFT JOIN agent_profile ap ON t.agent_profile_id = ap.id
     WHERE t.user_id = $1
     ORDER BY t.create_time DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset]
  );
  return { list: result.rows, total };
}

export async function getWritingTaskById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT t.*, i.name as instruction_name, i.article_prompt, i.title_prompt,
            i.category as instruction_category, i.content_types, i.random_mode,
            i.target_word_count,
            k.company_full_name, k.company_short_name, k.city, k.industry, k.business_scope,
            k.entity_triples, k.intro_text, k.cases_text,
            k.products_services, k.product_features, k.user_pain_points, k.trust_endorsement, k.other_info,
            ap.system_prompt as agent_system_prompt, ap.skills_content as agent_skills_content,
            ap.name as agent_profile_name
     FROM ai_writing_task t
     LEFT JOIN writing_instruction i ON t.instruction_id = i.id
     LEFT JOIN enterprise_knowledge k ON t.knowledge_id = k.id
     LEFT JOIN agent_profile ap ON t.agent_profile_id = ap.id
     WHERE t.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function updateWritingTaskProgress(taskId: number, completedDelta: number, failedDelta: number): Promise<void> {
  await query(
    `UPDATE ai_writing_task
     SET completed_count = completed_count + $2,
         failed_count = failed_count + $3
     WHERE id = $1`,
    [taskId, completedDelta, failedDelta]
  );
}

export async function completeWritingTask(taskId: number, status: 'completed' | 'partial' | 'failed', errorMsg?: string): Promise<void> {
  await query(
    `UPDATE ai_writing_task SET status = $2, error_msg = $3, finished_at = NOW() WHERE id = $1`,
    [taskId, status, errorMsg || null]
  );
}

/**
 * v1.8.2：重置写作任务以重试失败的文章
 *
 * 逻辑：
 *   - 把任务状态从 failed/partial 重置为 pending
 *   - 把 total_count 调整为原 failed_count（只重新生成失败的篇数）
 *   - 重置 completed_count=0, failed_count=0, error_msg=NULL
 *   - 清空 started_at/finished_at（让任务像新创建一样被重新执行）
 *
 * 调用方在重置后异步执行 executeWritingTask(taskId, userId) 即可重新生成
 *
 * @returns 重置后的任务对象（含新的 total_count），如果任务不存在或状态不允许重试则返回 null
 */
export async function resetWritingTaskForRetry(taskId: number): Promise<any | null> {
  // 先查任务当前状态，只允许重试 failed/partial 状态的任务
  const checkResult = await query(
    `SELECT id, status, total_count, completed_count, failed_count
     FROM ai_writing_task WHERE id = $1`,
    [taskId]
  );
  if (!checkResult.rows[0]) return null;
  const task = checkResult.rows[0];
  if (!['failed', 'partial'].includes(task.status)) {
    throw new Error(`任务状态为 ${task.status}，只有 failed/partial 状态的任务才能重试`);
  }
  if (!task.failed_count || task.failed_count <= 0) {
    throw new Error('任务没有失败的文章，无需重试');
  }

  // 重置任务：total_count = 原 failed_count，其他计数清零，状态回 pending
  await query(
    `UPDATE ai_writing_task
     SET status = 'pending',
         total_count = $2,
         completed_count = 0,
         failed_count = 0,
         error_msg = NULL,
         started_at = NULL,
         finished_at = NULL
     WHERE id = $1`,
    [taskId, task.failed_count]
  );

  // 返回重置后的任务（用于调用方决定是否触发执行）
  const result = await query(
    `SELECT id, user_id, status, total_count FROM ai_writing_task WHERE id = $1`,
    [taskId]
  );
  return result.rows[0] || null;
}

export async function deleteWritingTask(taskId: number): Promise<void> {
  // 删除任务关联的所有文章（不限状态），然后删除任务
  // article.task_id 外键引用 ai_writing_task.id（无 ON DELETE CASCADE），必须先删文章
  // v1.8.2：publish_task.article_id 引用 article(id) 也无 ON DELETE CASCADE，
  //         publish_record.task_id 引用 publish_task(id) 也无 ON DELETE CASCADE，
  //         必须按依赖顺序级联删除：publish_record → publish_task → article → ai_writing_task
  // 1. 删除该任务下文章关联的发布记录（先查 publish_task.id，再删 publish_record）
  await query(
    `DELETE FROM publish_record
     WHERE task_id IN (
       SELECT pt.id FROM publish_task pt
       JOIN article a ON pt.article_id = a.id
       WHERE a.task_id = $1
     )`,
    [taskId]
  );
  // 2. 删除该任务下文章关联的发布任务
  await query(
    `DELETE FROM publish_task
     WHERE article_id IN (SELECT id FROM article WHERE task_id = $1)`,
    [taskId]
  );
  // 3. 删除文章（article_embedding 和 article_performance 有 ON DELETE CASCADE，会自动清理）
  await query('DELETE FROM article WHERE task_id = $1', [taskId]);
  // 4. 删除写作任务本身
  await query('DELETE FROM ai_writing_task WHERE id = $1', [taskId]);
}

// ============ 内容中枢：文章 ============

/**
 * 查询某客户最近生成的文章（L2 历史记忆）
 * 通过 ai_writing_task.knowledge_id 关联，返回最近 N 篇标题+摘要+核心关键词
 *
 * @param knowledgeId 企业知识库 ID
 * @param limit 返回条数，默认 20
 * @returns RecentArticleItem 数组（title/summary/createdAt/coreKeyword）
 */
export async function getRecentArticlesByKnowledge(
  knowledgeId: number,
  limit: number = 20
): Promise<Array<{ title: string; summary: string; createdAt: string; coreKeyword: string | null }>> {
  const result = await query(
    `SELECT a.title,
            a.content_html,
            a.core_keyword,
            to_char(a.create_time AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') as created_at
     FROM article a
     JOIN ai_writing_task t ON a.task_id = t.id
     WHERE t.knowledge_id = $1
       AND a.status IN ('generated', 'published')
     ORDER BY a.create_time DESC
     LIMIT $2`,
    [knowledgeId, limit]
  );
  return result.rows.map((r: any) => ({
    title: r.title,
    summary: '', // 摘要由 contextBuilder 的 stripHtml 生成，这里先留空
    contentHtml: r.content_html, // 临时字段，contextBuilder 会处理
    createdAt: r.created_at,
    coreKeyword: r.core_keyword,
  }));
}

/**
 * 按用户和时间范围查询文章（飞轮反馈用，AEO 分析后填充 article_performance）
 * 返回文章 id、knowledge_id、core_keyword、direction、content_type、create_time
 * 注意：direction/content_type 来自 writing_instruction 表（通过 ai_writing_task.instruction_id 关联）
 */
export async function getArticlesByUserAndTimeRange(
  userId: string,
  startTime: Date,
  endTime: Date
): Promise<Array<{
  id: number;
  knowledgeId: number | null;
  coreKeyword: string;
  direction: string | null;
  contentType: string | null;
  createTime: Date;
}>> {
  const result = await query(
    `SELECT a.id, t.knowledge_id, a.core_keyword,
            i.category as direction,
            i.content_types as content_type,
            a.create_time
     FROM article a
     JOIN ai_writing_task t ON a.task_id = t.id
     LEFT JOIN writing_instruction i ON t.instruction_id = i.id
     WHERE t.user_id = $1
       AND a.status IN ('generated', 'published')
       AND a.create_time >= $2 AND a.create_time <= $3
     ORDER BY a.create_time DESC`,
    [userId, startTime, endTime]
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    knowledgeId: r.knowledge_id,
    coreKeyword: r.core_keyword || '',
    direction: r.direction,
    contentType: r.content_type,
    createTime: r.create_time,
  }));
}

/**
 * 查询某客户（knowledge_id）在指定时间范围内的文章效果统计
 * 用于飞轮策略生成（阶段3.3）
 */
export async function getArticlePerformanceStatsByKnowledge(
  knowledgeId: number,
  startTime: Date,
  endTime: Date
): Promise<{
  total: number;
  goodCount: number;
  poorCount: number;
  neutralCount: number;
  goodExamples: Array<{ title: string; direction: string | null; contentType: string | null; aeoScore: number | null }>;
}> {
  const result = await query(
    `SELECT ap.performance_label, ap.aeo_score, ap.direction, ap.content_type, a.title
     FROM article_performance ap
     JOIN article a ON ap.article_id = a.id
     JOIN ai_writing_task t ON a.task_id = t.id
     WHERE t.knowledge_id = $1
       AND ap.analyzed_at >= $2 AND ap.analyzed_at <= $3`,
    [knowledgeId, startTime, endTime]
  );
  const rows = result.rows;
  const good = rows.filter((r: any) => r.performance_label === 'good');
  const poor = rows.filter((r: any) => r.performance_label === 'poor');
  const neutral = rows.filter((r: any) => r.performance_label === 'neutral');
  return {
    total: rows.length,
    goodCount: good.length,
    poorCount: poor.length,
    neutralCount: neutral.length,
    goodExamples: good.slice(0, 5).map((r: any) => ({
      title: r.title,
      direction: r.direction,
      contentType: r.content_type,
      aeoScore: r.aeo_score ? parseFloat(r.aeo_score) : null,
    })),
  };
}

// ============ Embedding & RAG ============

/** 获取用于 embedding 的模型配置（use_for_embedding=true 且有 api_key） */
export async function getEmbeddingModelConfig(): Promise<any | null> {
  const result = await query(
    `SELECT * FROM ai_model_config
     WHERE use_for_embedding = true AND is_active = true
       AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY update_time DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

/** 存储 embedding 到 article_embedding 表 */
export async function saveArticleEmbedding(
  articleId: number,
  knowledgeId: number | null,
  contentText: string,
  embedding: number[],
  modelName: string
): Promise<void> {
  // 将数组转为 pgvector 格式的字符串: '[0.1,0.2,...]'
  const vectorStr = `[${embedding.join(',')}]`;
  await query(
    `INSERT INTO article_embedding (article_id, knowledge_id, content_text, embedding, model_name)
     VALUES ($1, $2, $3, $4::vector, $5)
     ON CONFLICT (article_id) DO UPDATE SET
       knowledge_id = EXCLUDED.knowledge_id,
       content_text = EXCLUDED.content_text,
       embedding = EXCLUDED.embedding,
       model_name = EXCLUDED.model_name`,
    [articleId, knowledgeId, contentText, vectorStr, modelName]
  );
}

/** 向量检索：按 knowledge_id 和查询向量检索 top-K 相关文章 */
export async function searchArticleEmbeddings(
  knowledgeId: number,
  queryEmbedding: number[],
  topK: number = 5
): Promise<Array<{ articleId: number; title: string; contentText: string; score: number }>> {
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const result = await query(
    `SELECT ae.article_id, ae.content_text,
            a.title,
            1 - (ae.embedding <=> $1::vector) as score
     FROM article_embedding ae
     JOIN article a ON a.id = ae.article_id
     WHERE ae.knowledge_id = $2
     ORDER BY ae.embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, knowledgeId, topK]
  );
  return result.rows.map((r: any) => ({
    articleId: r.article_id,
    title: r.title,
    contentText: r.content_text,
    score: parseFloat(r.score),
  }));
}

/** 获取某客户的 L3 效果记忆（收录好的文章模式） */
export async function getPerformanceMemory(
  knowledgeId: number,
  limit: number = 10
): Promise<Array<any>> {
  const result = await query(
    `SELECT ap.*, a.title as article_title, a.core_keyword
     FROM article_performance ap
     JOIN article a ON a.id = ap.article_id
     WHERE ap.knowledge_id = $1
       AND ap.performance_label IN ('good', 'poor')
     ORDER BY ap.analyzed_at DESC
     LIMIT $2`,
    [knowledgeId, limit]
  );
  return result.rows;
}

/** 获取某客户的 L3 策略记忆（飞轮总结的创作策略） */
export async function getStrategyMemory(
  knowledgeId: number,
  limit: number = 3
): Promise<Array<any>> {
  const result = await query(
    `SELECT strategy, evidence, to_char(create_time AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') as generated_at
     FROM writing_strategy
     WHERE knowledge_id = $1 AND is_active = true
     ORDER BY create_time DESC
     LIMIT $2`,
    [knowledgeId, limit]
  );
  return result.rows;
}

/** 插入创作策略（飞轮每轮结束后调用） */
export async function insertWritingStrategy(
  knowledgeId: number,
  strategy: string,
  evidence: string,
  roundNo: number,
  goodCount: number,
  poorCount: number
): Promise<void> {
  await query(
    `INSERT INTO writing_strategy (knowledge_id, strategy, evidence, round_no, good_count, poor_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [knowledgeId, strategy, evidence, roundNo, goodCount, poorCount]
  );
}

/** 批量插入文章效果记录（AEO 分析时调用）
 *  keyword_rank_id 为 null 时先删除旧记录再插入，避免重复行（NULL 不参与 UNIQUE 冲突）
 */
export async function upsertArticlePerformance(
  articleId: number,
  knowledgeId: number | null,
  data: {
    keywordRankId?: number;
    aeoReportId?: number;
    aeoScore?: number;
    brandMentioned?: boolean;
    shareUrl?: string;
    performanceLabel: string;
    direction?: string;
    contentType?: string;
  }
): Promise<void> {
  const keywordRankId = data.keywordRankId || null;
  // NULL keyword_rank_id 时先删除旧行（UNIQUE 约束不匹配 NULL，会导致重复）
  if (keywordRankId === null) {
    await query(
      `DELETE FROM article_performance WHERE article_id = $1 AND keyword_rank_id IS NULL`,
      [articleId]
    );
  }
  await query(
    `INSERT INTO article_performance
       (article_id, knowledge_id, keyword_rank_id, aeo_report_id, aeo_score,
        brand_mentioned, share_url, performance_label, direction, content_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (article_id, keyword_rank_id) DO UPDATE SET
       aeo_score = EXCLUDED.aeo_score,
       brand_mentioned = EXCLUDED.brand_mentioned,
       performance_label = EXCLUDED.performance_label,
       analyzed_at = NOW()`,
    [
      articleId, knowledgeId,
      keywordRankId,
      data.aeoReportId || null,
      data.aeoScore || null,
      data.brandMentioned || false,
      data.shareUrl || null,
      data.performanceLabel,
      data.direction || null,
      data.contentType || null,
    ]
  );
}

export async function getArticles(userId: number, filters: { keyword?: string; status?: string; task_id?: number; platform?: string; page?: number; pageSize?: number }): Promise<{ list: any[]; total: number }> {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 20;
  const offset = (page - 1) * pageSize;
  const where: string[] = ['user_id = $1'];
  const params: any[] = [userId];
  let idx = 2;
  if (filters.keyword) {
    where.push(`(title ILIKE $${idx} OR core_keyword ILIKE $${idx})`);
    params.push(`%${filters.keyword}%`);
    idx++;
  }
  if (filters.status) {
    where.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.task_id) {
    where.push(`task_id = $${idx++}`);
    params.push(filters.task_id);
  }
  // v1.8.0：按平台筛选（target_platform = $N；平台为 'general' 时筛选 NULL 旧文章）
  if (filters.platform) {
    if (filters.platform === 'general') {
      where.push(`target_platform IS NULL`);
    } else {
      where.push(`target_platform = $${idx++}`);
      params.push(filters.platform);
    }
  }
  const whereClause = where.join(' AND ');
  const countResult = await query(`SELECT COUNT(*) as total FROM article WHERE ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].total);
  params.push(pageSize, offset);
  const result = await query(
    `SELECT id, task_id, keyword_id, core_keyword, keyword_type, title, target_platform,
            word_count, status, cover_image_url, tags, model_used, create_time, update_time,
            COALESCE((SELECT array_agg(DISTINCT pr.platform)
                      FROM publish_record pr
                      JOIN publish_task pt ON pt.id = pr.task_id
                      WHERE pt.article_id = article.id AND pr.status = 'success'), '{}') as published_platforms
     FROM article WHERE ${whereClause}
     ORDER BY create_time DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  return { list: result.rows, total };
}

export async function getArticleById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT article.*,
            COALESCE((SELECT array_agg(DISTINCT pr.platform)
                      FROM publish_record pr
                      JOIN publish_task pt ON pt.id = pr.task_id
                      WHERE pt.article_id = article.id AND pr.status = 'success'), '{}') as published_platforms
     FROM article WHERE article.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function createArticle(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO article (user_id, task_id, keyword_id, core_keyword, keyword_type, title,
            content_html, entity_triples, target_platform, word_count, status, tags, model_used, cover_image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [data.user_id, data.task_id, data.keyword_id, data.core_keyword, data.keyword_type || 0,
     data.title, data.content_html, JSON.stringify(data.entity_triples || []),
     data.target_platform, data.word_count, data.status || 'generated',
     data.tags || [], data.model_used, data.cover_image_url || null]
  );
  return result.rows[0].id;
}

export async function updateArticle(id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const key of ['title', 'content_html', 'entity_triples', 'target_platform', 'word_count', 'status', 'cover_image_url', 'tags']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(key === 'entity_triples' || key === 'tags' ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (fields.length === 0) return;
  fields.push(`update_time = NOW()`);
  values.push(id);
  await query(`UPDATE article SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function deleteArticle(id: number): Promise<void> {
  await query('DELETE FROM article WHERE id = $1', [id]);
}

// ============ 内容中枢：企业图库（image_library） ============

/** 查询图库图片列表（按客户+类型筛选） */
export async function getImageLibrary(userId: number, knowledgeId?: number, imageType?: string): Promise<any[]> {
  let sql = `SELECT * FROM image_library WHERE user_id = $1`;
  const params: any[] = [userId];
  let idx = 2;
  if (knowledgeId !== undefined && knowledgeId !== null) {
    sql += ` AND knowledge_id = $${idx++}`;
    params.push(knowledgeId);
  }
  if (imageType) {
    sql += ` AND image_type = $${idx++}`;
    params.push(imageType);
  }
  sql += ` ORDER BY sort_order ASC, create_time DESC`;
  const result = await query(sql, params);
  return result.rows;
}

/** 获取单张图片 */
export async function getImageById(id: number): Promise<any | null> {
  const result = await query('SELECT * FROM image_library WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/** 创建图片记录 */
export async function createImage(data: any): Promise<number> {
  const result = await query(
    `INSERT INTO image_library (user_id, knowledge_id, image_type, url, file_path, original_name, file_size, mime_type, width, height, description, tags, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [data.user_id, data.knowledge_id, data.image_type, data.url, data.file_path || null,
     data.original_name || null, data.file_size || null, data.mime_type || null,
     data.width || null, data.height || null, data.description || null,
     data.tags || [], data.sort_order || 0]
  );
  return result.rows[0].id;
}

/** 更新图片记录 */
export async function updateImage(id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const key of ['description', 'tags', 'sort_order', 'url', 'original_name']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return;
  fields.push(`update_time = NOW()`);
  values.push(id);
  await query(`UPDATE image_library SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

/** 删除图片记录 */
export async function deleteImage(id: number): Promise<void> {
  await query('DELETE FROM image_library WHERE id = $1', [id]);
}

/** 随机取 N 张指定类型的图片（用于写作任务插图/封面） */
export async function getRandomImages(userId: number, knowledgeId: number, imageType: string, count: number): Promise<any[]> {
  const result = await query(
    `SELECT * FROM image_library
     WHERE user_id = $1 AND knowledge_id = $2 AND image_type = $3
     ORDER BY RANDOM() LIMIT $4`,
    [userId, knowledgeId, imageType, count]
  );
  return result.rows;
}

// ============ 内容中枢：关键词查询辅助 ============

export async function getKeywordsByIds(ids: number[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const result = await query(
    `SELECT id, value, userid, keyword_type FROM zlgjc WHERE id = ANY($1::int[])`,
    [ids]
  );
  return result.rows;
}

/**
 * 按关键词文本查询 ID（用于前端传入关键词字符串而非 ID 的场景）
 * 查询用户的 zlgjc 表中匹配的蒸馏关键词和品牌关键词
 */
export async function getKeywordIdsByValues(userId: number, values: string[]): Promise<number[]> {
  if (values.length === 0) return [];
  const result = await query(
    `SELECT id FROM zlgjc WHERE userid = $1 AND value = ANY($2::text[])`,
    [String(userId), values]
  );
  return result.rows.map((r: any) => r.id);
}

/**
 * 获取客户的所有关键词 ID（蒸馏关键词 + 品牌关键词）
 * 用于新建写作任务时自动加载客户整个关键词库
 */
export async function getCustomerKeywordIds(customerId: number): Promise<{ ids: number[]; distilledCount: number; brandCount: number }> {
  const result = await query(
    `SELECT id, keyword_type FROM zlgjc WHERE userid = $1`,
    [String(customerId)]
  );
  const ids = result.rows.map((r: any) => r.id);
  const distilledCount = result.rows.filter((r: any) => r.keyword_type === 0).length;
  const brandCount = result.rows.filter((r: any) => r.keyword_type === 1).length;
  return { ids, distilledCount, brandCount };
}

export async function getArticleCoverageStats(userId: string): Promise<{ total: number; covered: number }> {
  // 蒸馏词库总词数 vs 已生成文章的词数
  const totalResult = await query(
    `SELECT COUNT(*) as total FROM zlgjc WHERE userid = $1 AND keyword_type = 0`,
    [userId]
  );
  const coveredResult = await query(
    `SELECT COUNT(DISTINCT keyword_id) as covered
     FROM article
     WHERE user_id = $1 AND keyword_id IS NOT NULL AND keyword_type = 0`,
    [userId]
  );
  return {
    total: parseInt(totalResult.rows[0].total),
    covered: parseInt(coveredResult.rows[0].covered),
  };
}

// ============ 内容中枢：发布 step_list ============

export async function getStepListByPlatform(platform: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM publish_step_list
     WHERE platform = $1 AND is_active = true
     ORDER BY create_time DESC LIMIT 1`,
    [platform]
  );
  return result.rows[0] || null;
}

export async function getAllStepLists(): Promise<any[]> {
  const result = await query(
    `SELECT DISTINCT ON (platform) platform, id, version, step_list, description, is_active, create_time
     FROM publish_step_list
     WHERE is_active = true
     ORDER BY platform, create_time DESC`
  );
  return result.rows;
}

export async function upsertStepList(
  platform: string,
  version: string,
  stepList: any,
  description?: string
): Promise<number> {
  const result = await query(
    `INSERT INTO publish_step_list (platform, version, step_list, description, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (platform, version) DO UPDATE
       SET step_list = EXCLUDED.step_list,
           description = EXCLUDED.description,
           is_active = true
     RETURNING id`,
    [platform, version, JSON.stringify(stepList), description || null]
  );
  return result.rows[0].id;
}

// ============ 内容中枢：publish_task ============

export async function createPublishTask(data: {
  user_id: number;
  article_id: number;
  target_platforms: string[];
  scheduled_at?: Date;
  batch_id?: string; // v1.8.4：批次 ID（UUID），同一次「新建发布任务」的所有 publish_task 共享
}): Promise<{ taskId: number; skipped: { platform: string; reason: string }[] }> {
  return withTransaction(async (client: PoolClient) => {
    // v1.8.4：若未提供 batch_id，自动生成一个（单条调用场景）
    const batchId = data.batch_id || crypto.randomUUID();

    // 0. 检查重复发布：该文章+平台是否已有成功发布记录
    const skipped: { platform: string; reason: string }[] = [];
    const platformsToCreate: string[] = [];
    for (const platform of data.target_platforms) {
      const dupCheck = await client.query(
        `SELECT id FROM publish_record
         WHERE platform = $1
           AND task_id IN (SELECT id FROM publish_task WHERE article_id = $2)
           AND status = 'success'
         LIMIT 1`,
        [platform, data.article_id]
      );
      if (dupCheck.rows.length > 0) {
        skipped.push({ platform, reason: `该文章已成功发布到 ${platform}，跳过重复发布` });
        continue;
      }
      platformsToCreate.push(platform);
    }

    // 1. 创建任务（允许 total_count=0，表示所有平台都已发布过）
    const taskResult = await client.query(
      `INSERT INTO publish_task (user_id, article_id, target_platforms, scheduled_at, status, total_count, batch_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id`,
      [data.user_id, data.article_id, data.target_platforms, data.scheduled_at || null, platformsToCreate.length, batchId]
    );
    const taskId = taskResult.rows[0].id;

    // 2. v1.9.0：创建 publish_record 时不绑定 platform_auth_id，由 dequeue 时动态选择最优账号
    //    这样可实现：账号失败自动换号、日限额轮询、最大化利用账号池
    for (const platform of platformsToCreate) {
      await client.query(
        `INSERT INTO publish_record (task_id, platform, platform_auth_id, status)
         VALUES ($1, $2, NULL, 'pending')`,
        [taskId, platform]
      );
    }
    return { taskId, skipped };
  });
}

export async function getPublishTasks(
  userId: number,
  page = 1,
  pageSize = 20
): Promise<{ list: any[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const totalResult = await query(
    `SELECT COUNT(*) as total FROM publish_task WHERE user_id = $1`,
    [userId]
  );
  const result = await query(
    `SELECT pt.*,
            a.title as article_title,
            a.core_keyword as article_keyword
     FROM publish_task pt
     LEFT JOIN article a ON a.id = pt.article_id
     WHERE pt.user_id = $1
     ORDER BY pt.create_time DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset]
  );
  return {
    list: result.rows,
    total: parseInt(totalResult.rows[0].total),
  };
}

export async function getPublishTaskById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT pt.*,
            a.title as article_title,
            a.core_keyword as article_keyword,
            a.content_html as article_content
     FROM publish_task pt
     LEFT JOIN article a ON a.id = pt.article_id
     WHERE pt.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function updatePublishTaskStatus(
  id: number,
  status: string,
  completedDelta = 0,
  failedDelta = 0
): Promise<void> {
  // 注意：$2 同时用于 SET 和 CASE 表达式会导致 PostgreSQL prepared statement
  // "inconsistent types deduced for parameter $2" 错误，用 $5 重复传入 status 参数
  await query(
    `UPDATE publish_task
     SET status = $2,
         completed_count = completed_count + $3,
         failed_count = failed_count + $4,
         started_at = CASE WHEN $5 = 'processing' AND started_at IS NULL THEN NOW() ELSE started_at END,
         finished_at = CASE WHEN $5 IN ('completed', 'failed', 'partial') THEN NOW() ELSE finished_at END
     WHERE id = $1`,
    [id, status, completedDelta, failedDelta, status]
  );
}

export async function cancelPublishTask(id: number): Promise<void> {
  // 把 pending 状态的 record 标记为 failed（error_msg='用户取消'），并更新 task 状态
  await query(
    `UPDATE publish_record
     SET status = 'failed', error_msg = COALESCE(error_msg, '用户取消')
     WHERE task_id = $1 AND status = 'pending'`,
    [id]
  );
  await query(
    `UPDATE publish_task
     SET status = CASE
       WHEN completed_count >= total_count THEN 'completed'
       WHEN completed_count > 0 THEN 'partial'
       ELSE 'failed'
     END,
     finished_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

// ============ 内容中枢：publish_record ============

/**
 * v1.9.0：为指定平台动态选择最优发布账号
 * 策略：
 * 1. 只选 status=active / health_status=normal 的发布型账号
 * 2. 连续失败 >= 3 次的账号暂时休息
 * 3. 今日仍有剩余配额（或新的一天）
 * 4. 优先选剩余配额多的 → 失败次数少的 → 最久未使用的
 */
async function selectBestAccountForPublish(
  client: PoolClient,
  platform: string
): Promise<number | null> {
  const result = await client.query(
    `SELECT id FROM platform_auth
     WHERE platform = $1
       AND platform_type IN ('publish', 'both')
       AND status = 'active'
       AND health_status = 'normal'
       AND publish_fail_count < 3
       AND (
         publish_last_used_date IS NULL
         OR publish_last_used_date < CURRENT_DATE
         OR publish_used_today < publish_daily_limit
       )
     ORDER BY
       (publish_daily_limit - COALESCE(
         CASE WHEN publish_last_used_date = CURRENT_DATE THEN publish_used_today ELSE 0 END,
         0
       )) DESC,
       publish_fail_count ASC,
       last_used_at ASC NULLS FIRST
     LIMIT 1`,
    [platform]
  );
  return result.rows[0]?.id || null;
}

/**
 * v1.9.0：拉取待发布记录
 *
 * 关键改进：
 * 1. publish_record 创建时不绑定 platform_auth_id，dequeue 时才动态选号
 * 2. 选中账号后预扣 publish_used_today，实现日限额控制
 * 3. 无可用账号（配额耗尽/全部封禁）时记录保持 pending，下次有账号时自动被拉取
 * 4. 加 FOR UPDATE SKIP LOCKED 行级锁，避免并发 dequeue 拿到相同记录
 * 5. 同平台串行：每个 platform 只取 1 条最早的 pending
 */
export async function getPendingPublishRecords(limit: number): Promise<any[]> {
  const client = await (await import('./db')).pool.connect();
  try {
    await client.query('BEGIN');
    // 1. 先回收超时的 processing 记录（Worker 崩溃后卡死的记录）
    await client.query(
      `UPDATE publish_record
       SET status = 'pending', started_at = NULL, error_msg = COALESCE(error_msg, '处理超时自动回收')
       WHERE status = 'processing' AND started_at < NOW() - INTERVAL '10 minutes'`
    );
    // 1.1 修复存量数据：若 publish_task 状态为 failed/completed，但其下仍有 pending record，
    //     说明是旧版单条重试 bug 遗留，自动把这类 task 恢复为 pending。
    await client.query(
      `UPDATE publish_task
       SET status = 'pending', finished_at = NULL
       WHERE status IN ('failed', 'completed')
         AND EXISTS (SELECT 1 FROM publish_record WHERE task_id = publish_task.id AND status = 'pending')`
    );

    // 2. 选出每个平台最早的 pending record id（先不锁，仅候选）
    const candidateResult = await client.query(
      `WITH candidate AS (
         SELECT pr.id, pr.platform
         FROM publish_record pr
         JOIN publish_task pt ON pt.id = pr.task_id
         WHERE pr.status = 'pending'
           AND pt.status IN ('pending', 'processing')
           AND (pt.scheduled_at IS NULL OR pt.scheduled_at <= NOW())
         ORDER BY pr.platform, pr.create_time ASC
       ),
       ranked AS (
         SELECT id, platform,
                ROW_NUMBER() OVER (PARTITION BY platform ORDER BY id) as rn
         FROM candidate
       )
       SELECT id, platform FROM ranked WHERE rn = 1 LIMIT $1`,
      [limit]
    );

    if (candidateResult.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const candidateIds = candidateResult.rows.map((r: any) => r.id);

    // 3. 对候选记录加锁（SKIP LOCKED 避免等待其他 Worker）
    const lockedResult = await client.query(
      `SELECT id, platform FROM publish_record
       WHERE id = ANY($1::int[]) AND status = 'pending'
       FOR UPDATE SKIP LOCKED`,
      [candidateIds]
    );

    // 4. 为每个成功加锁的记录选择账号并预扣配额
    const assignedIds: number[] = [];
    for (const row of lockedResult.rows) {
      const authId = await selectBestAccountForPublish(client, row.platform);
      if (!authId) {
        // 无可用账号：保持 pending，本次不拉取
        continue;
      }
      // 预扣配额
      await client.query(
        `UPDATE platform_auth
         SET publish_used_today = CASE
               WHEN publish_last_used_date < CURRENT_DATE OR publish_last_used_date IS NULL THEN 1
               ELSE publish_used_today + 1
             END,
             publish_last_used_date = CURRENT_DATE,
             last_used_at = NOW()
         WHERE id = $1`,
        [authId]
      );
      // 绑定账号
      await client.query(
        `UPDATE publish_record
         SET platform_auth_id = $1, assigned_from = 'auto'
         WHERE id = $2`,
        [authId, row.id]
      );
      assignedIds.push(row.id);
    }

    if (assignedIds.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    // 5. 读取完整记录并返回
    const result = await client.query(
      `SELECT
         pr.id, pr.task_id, pr.platform, pr.platform_auth_id,
         pt.article_id, pt.user_id, pt.scheduled_at,
         a.title as article_title,
         a.content_html as article_content,
         a.tags as article_tags,
         a.cover_image_url as article_cover,
         pa.storage_state as account_storage_state,
         pa.account_name as account_name,
         pa.publish_mode as account_publish_mode
       FROM publish_record pr
       JOIN publish_task pt ON pt.id = pr.task_id
       LEFT JOIN article a ON a.id = pt.article_id
       LEFT JOIN platform_auth pa ON pa.id = pr.platform_auth_id
       WHERE pr.id = ANY($1::int[])
       FOR UPDATE OF pr SKIP LOCKED`,
      [assignedIds]
    );

    // 6. 立即标记为 processing
    await client.query(
      `UPDATE publish_record SET status = 'processing', started_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'pending'`,
      [assignedIds]
    );

    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * v1.9.0：更新发布结果
 * 核心改进：
 * 1. 支持 error_type 区分错误类型
 * 2. 账号类错误（banned/login_expired/limited）自动回滚配额、更新账号健康状态、并将 record 重新排队换号重试
 * 3. 非账号类错误/超过最大重试次数时最终标记失败
 * 4. 成功/失败时更新 publish_account_stats 统计
 */
export async function updatePublishRecordResult(
  id: number,
  result: {
    status: string;
    article_id_on_platform?: string;
    platform_url?: string;
    error_msg?: string;
    error_type?: string; // account_banned / account_login_expired / account_limited / content_error / platform_error / unknown
  }
): Promise<{ status: string; retry_queued: boolean }> {
  const MAX_RETRY = 3;
  const isAccountError = ['account_banned', 'account_login_expired', 'account_limited'].includes(result.error_type || '');

  return withTransaction(async (client: PoolClient) => {
    // 1. 查询当前 record 和关联账号
    // v1.9.3 修复：publish_task 表无 platform 列（只有 target_platforms 数组），改用 pr.platform
    const recordResult = await client.query(
      `SELECT pr.*, pa.id as auth_id, pa.platform as auth_platform
       FROM publish_record pr
       JOIN publish_task pt ON pt.id = pr.task_id
       LEFT JOIN platform_auth pa ON pa.id = pr.platform_auth_id
       WHERE pr.id = $1`,
      [id]
    );
    const record = recordResult.rows[0];
    if (!record) {
      throw new Error(`publish_record ${id} 不存在`);
    }

    const authId = record.platform_auth_id;
    const platform = record.platform;
    const today = new Date().toISOString().slice(0, 10);

    // 2. 成功处理
    if (result.status === 'success') {
      await client.query(
        `UPDATE publish_record
         SET status = 'success',
             article_id_on_platform = $2,
             platform_url = $3,
             error_msg = NULL,
             published_at = NOW(),
             started_at = COALESCE(started_at, NOW())
         WHERE id = $1`,
        [id, result.article_id_on_platform || null, result.platform_url || null]
      );
      // 累计成功统计
      if (authId) {
        await client.query(
          `INSERT INTO publish_account_stats (platform_auth_id, platform, publish_date, success_count)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (platform_auth_id, publish_date) DO UPDATE SET success_count = publish_account_stats.success_count + 1`,
          [authId, platform, today]
        );
      }
      return { status: 'success', retry_queued: false };
    }

    // 3. 失败处理
    const currentRetry = record.retry_count || 0;
    const canRetry = isAccountError && currentRetry < MAX_RETRY;

    if (canRetry) {
      // 3.1 账号类错误且未超重试次数：回滚配额、更新账号状态、record 重新排队
      if (authId) {
        // 回滚今日配额
        await client.query(
          `UPDATE platform_auth
           SET publish_used_today = GREATEST(COALESCE(publish_used_today, 0) - 1, 0)
           WHERE id = $1 AND publish_last_used_date = CURRENT_DATE`,
          [authId]
        );
        // 更新账号健康状态
        if (result.error_type === 'account_banned') {
          await client.query(
            `UPDATE platform_auth SET health_status = 'banned', publish_last_fail_at = NOW() WHERE id = $1`,
            [authId]
          );
        } else if (result.error_type === 'account_login_expired') {
          await client.query(
            `UPDATE platform_auth SET health_status = 'offline', publish_last_fail_at = NOW() WHERE id = $1`,
            [authId]
          );
        } else if (result.error_type === 'account_limited') {
          await client.query(
            `UPDATE platform_auth
             SET publish_fail_count = publish_fail_count + 1,
                 publish_last_fail_at = NOW()
             WHERE id = $1`,
            [authId]
          );
        }
      }
      // record 清空账号、状态回 pending、重试次数+1
      await client.query(
        `UPDATE publish_record
         SET status = 'pending',
             platform_auth_id = NULL,
             retry_count = retry_count + 1,
             error_msg = $2,
             started_at = NULL,
             published_at = NULL
         WHERE id = $1`,
        [id, `[重试 ${currentRetry + 1}/${MAX_RETRY}] ${result.error_msg || ''}`.slice(0, 500)]
      );
      return { status: 'pending', retry_queued: true };
    }

    // 3.2 非账号类错误或超过重试次数：最终失败
    await client.query(
      `UPDATE publish_record
       SET status = 'failed',
           error_msg = $2,
           started_at = COALESCE(started_at, NOW())
       WHERE id = $1`,
      [id, result.error_msg || null]
    );
    if (authId) {
      await client.query(
        `INSERT INTO publish_account_stats (platform_auth_id, platform, publish_date, fail_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (platform_auth_id, publish_date) DO UPDATE SET fail_count = publish_account_stats.fail_count + 1`,
        [authId, platform, today]
      );
      // 账号类错误即使最终失败，也更新账号状态供人工排查
      if (result.error_type === 'account_banned') {
        await client.query(`UPDATE platform_auth SET health_status = 'banned', publish_last_fail_at = NOW() WHERE id = $1`, [authId]);
      } else if (result.error_type === 'account_login_expired') {
        await client.query(`UPDATE platform_auth SET health_status = 'offline', publish_last_fail_at = NOW() WHERE id = $1`, [authId]);
      } else if (result.error_type === 'account_limited') {
        await client.query(`UPDATE platform_auth SET publish_fail_count = publish_fail_count + 1, publish_last_fail_at = NOW() WHERE id = $1`, [authId]);
      }
    }
    return { status: 'failed', retry_queued: false };
  });
}

/**
 * v1.8.4：标记 publish_record 开始处理
 *
 * 关键修复：把 status 从 'pending' 改为 'processing'，避免 publishWorker 30s 轮询时重复拉取同一条记录。
 * 原实现只更新 started_at 不更新 status，导致 dequeue SQL 的 `WHERE status='pending'` 仍能匹配到正在处理的记录。
 *
 * 同时回收超时的 processing 记录：started_at 超过 10 分钟且仍为 processing 的，重置为 pending。
 */
export async function markPublishRecordStarted(id: number): Promise<void> {
  // 1. 回收超时的 processing 记录（Worker 崩溃后卡死的记录）
  await query(
    `UPDATE publish_record
     SET status = 'pending', started_at = NULL, error_msg = COALESCE(error_msg, '处理超时自动回收')
     WHERE id = $1 AND status = 'processing' AND started_at < NOW() - INTERVAL '10 minutes'`,
    [id]
  );
  // 2. 原子地把 pending → processing（只有 status 仍为 pending 才会成功）
  await query(
    `UPDATE publish_record SET status = 'processing', started_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
}

export async function getPublishRecordsByTask(taskId: number): Promise<any[]> {
  const result = await query(
    `SELECT pr.*,
            pa.account_name,
            pa.avatar_url
     FROM publish_record pr
     LEFT JOIN platform_auth pa ON pa.id = pr.platform_auth_id
     WHERE pr.task_id = $1
     ORDER BY pr.id ASC`,
    [taskId]
  );
  return result.rows;
}

/**
 * 重置发布记录为 pending（用于重试失败的记录）
 * 支持：单条记录重试 / 按任务批量重试
 */
export async function retryPublishRecords(
  taskId?: number,
  recordId?: number
): Promise<{ reset_count: number }> {
  if (recordId) {
    // 单条记录重试（支持重置 failed/login_expired/completed 状态，completed 用于误判重发）
    const result = await query(
      `UPDATE publish_record
       SET status = 'pending',
           error_msg = NULL,
           started_at = NULL,
           published_at = NULL
       WHERE id = $1 AND status IN ('failed', 'login_expired', 'completed')`,
      [recordId]
    );
    // 修复 v1.7.28：单条重试也必须把关联的 publish_task 状态恢复为 pending，
    // 否则 dequeue SQL 的 pt.status IN ('pending','processing') 条件不满足，Worker 永远拉不到。
    // （之前仅按 taskId 批量重试和按 batch_id 重试会更新 task 状态，单条重试漏了）
    if ((result.rowCount || 0) > 0) {
      await query(
        `UPDATE publish_task
         SET status = 'pending', finished_at = NULL
         WHERE id IN (SELECT task_id FROM publish_record WHERE id = $1)
           AND status IN ('failed', 'completed')`,
        [recordId]
      );
    }
    return { reset_count: result.rowCount || 0 };
  }
  if (taskId) {
    // 按任务批量重试（支持重置 failed/login_expired/completed 状态）
    const result = await query(
      `UPDATE publish_record
       SET status = 'pending',
           error_msg = NULL,
           started_at = NULL,
           published_at = NULL
       WHERE task_id = $1 AND status IN ('failed', 'login_expired', 'completed')`,
      [taskId]
    );
    // 同时把任务状态恢复为 pending
    await query(
      `UPDATE publish_task SET status = 'pending' WHERE id = $1 AND status IN ('failed', 'completed')`,
      [taskId]
    );
    return { reset_count: result.rowCount || 0 };
  }
  return { reset_count: 0 };
}

/**
 * v1.7.4：按 batch_id 批量重试
 * 重置该批次下所有 publish_task 关联的 failed/login_expired 记录为 pending
 * 同时把 publish_task 状态从 failed/completed 恢复为 pending
 */
export async function retryPublishRecordsByBatch(
  userId: number,
  batchId: string
): Promise<{ reset_count: number }> {
  // 1. 重置 publish_record（限定当前用户 + batch_id，防越权）
  const recordResult = await query(
    `UPDATE publish_record pr
     SET status = 'pending',
         error_msg = NULL,
         started_at = NULL,
         published_at = NULL
     FROM publish_task pt
     WHERE pr.task_id = pt.id
       AND pt.user_id = $1
       AND pt.batch_id = $2
       AND pr.status IN ('failed', 'login_expired')`,
    [userId, batchId]
  );
  // 2. 把 publish_task 从 failed/completed 恢复为 pending
  await query(
    `UPDATE publish_task
     SET status = 'pending'
     WHERE user_id = $1 AND batch_id = $2
       AND status IN ('failed', 'completed')`,
    [userId, batchId]
  );
  return { reset_count: recordResult.rowCount || 0 };
}

/**
 * v1.8.4：按 batch_id 聚合的发布任务列表（一级聚合视图）
 *
 * 同一次「新建发布任务」动作生成的所有 publish_task 共享一个 batch_id（UUID），
 * 聚合为一行显示。这样每次创建是一个独立条目，不会因写作任务相同而合并。
 *
 * 聚合规则：
 * - total_count = SUM(publish_task.total_count)  即文章×平台总数
 * - completed_count = SUM(publish_task.completed_count)
 * - failed_count = SUM(publish_task.failed_count)
 * - article_count = COUNT(DISTINCT publish_task.article_id)  即文章数
 * - status = 聚合状态：任一 processing → processing；否则按 paused/pending/partial/failed/completed 优先级
 *
 * 关联写作任务名是为了显示方便（一个批次可能涉及多个写作任务的文章，取第一个非空的写作任务名）。
 */
export async function getPublishTasksGroupedByBatch(
  userId: number,
  page = 1,
  pageSize = 20
): Promise<{ list: any[]; total: number }> {
  const offset = (page - 1) * pageSize;
  // 计数：batch_id 分组数
  const totalResult = await query(
    `SELECT COUNT(DISTINCT pt.batch_id) as total
     FROM publish_task pt
     WHERE pt.user_id = $1 AND pt.batch_id IS NOT NULL`,
    [userId]
  );
  // 列表：按 batch_id 聚合
  const result = await query(
    `SELECT
       pt.batch_id,
       COUNT(DISTINCT pt.id) as publish_task_count,
       COUNT(DISTINCT pt.article_id) as article_count,
       SUM(pt.total_count) as total_count,
       SUM(pt.completed_count) as completed_count,
       SUM(pt.failed_count) as failed_count,
       MIN(pt.create_time) as create_time,
       MAX(pt.finished_at) as finished_at,
       MIN(pt.scheduled_at) as scheduled_at,
       bool_or(pt.status = 'processing') as has_processing,
       bool_or(pt.status = 'paused') as has_paused,
       bool_or(pt.status = 'pending') as has_pending,
       bool_or(pt.status = 'failed') as has_failed,
       bool_or(pt.status = 'completed') as all_completed,
       array_agg(DISTINCT unnested_platform) FILTER (WHERE unnested_platform IS NOT NULL) as platforms,
       array_agg(DISTINCT a.task_id) FILTER (WHERE a.task_id IS NOT NULL) as writing_task_ids,
       MAX(wt.task_name) as writing_task_name
     FROM publish_task pt
     JOIN article a ON a.id = pt.article_id
     LEFT JOIN ai_writing_task wt ON wt.id = a.task_id
     LEFT JOIN LATERAL unnest(pt.target_platforms) as unnested_platform ON true
     WHERE pt.user_id = $1 AND pt.batch_id IS NOT NULL
     GROUP BY pt.batch_id
     ORDER BY MIN(pt.create_time) DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset]
  );

  // 计算聚合状态
  const list = result.rows.map((row: any) => {
    let status: string;
    if (row.has_processing) {
      status = 'processing';
    } else if (row.has_paused && row.has_pending) {
      status = 'partial_paused';
    } else if (row.has_paused) {
      status = 'paused';
    } else if (row.has_pending) {
      status = 'pending';
    } else if (row.has_failed && row.completed_count > 0) {
      status = 'partial';
    } else if (row.has_failed) {
      status = 'failed';
    } else if (row.all_completed) {
      status = 'completed';
    } else {
      status = 'pending';
    }
    // writing_task_ids 取第一个作为展示用 writing_task_id
    const writingTaskId = Array.isArray(row.writing_task_ids) && row.writing_task_ids.length > 0
      ? row.writing_task_ids[0]
      : null;
    return {
      ...row,
      batch_id: row.batch_id,
      writing_task_id: writingTaskId,
      writing_task_ids: row.writing_task_ids || [],
      total_count: parseInt(row.total_count) || 0,
      completed_count: parseInt(row.completed_count) || 0,
      failed_count: parseInt(row.failed_count) || 0,
      publish_task_count: parseInt(row.publish_task_count) || 0,
      article_count: parseInt(row.article_count) || 0,
      platforms: row.platforms || [],
      status,
    };
  });

  return {
    list,
    total: parseInt(totalResult.rows[0].total) || 0,
  };
}

/**
 * v1.8.4：获取一个批次下的所有 publish_task（二级详情视图）
 */
export async function getPublishTasksByBatch(
  userId: number,
  batchId: string
): Promise<any[]> {
  const result = await query(
    `SELECT pt.*,
            a.title as article_title,
            a.core_keyword as article_keyword,
            a.target_platform as article_target_platform,
            a.task_id as writing_task_id
     FROM publish_task pt
     JOIN article a ON a.id = pt.article_id
     WHERE pt.user_id = $1 AND pt.batch_id = $2
     ORDER BY pt.id ASC`,
    [userId, batchId]
  );
  return result.rows;
}

/**
 * v1.8.4：暂停发布任务
 *
 * 把 publish_task.status 置为 'paused'，dequeue SQL 的 `pt.status IN ('pending','processing')`
 * 天然过滤掉 paused，Worker 不再消费该任务的新 record。
 *
 * 注意：已被 Worker 拉走正在处理的 record 不会被中止（Worker 内部继续执行），
 * 但完成后回写时不会再触发新一轮消费。
 */
export async function pausePublishTask(id: number): Promise<void> {
  await query(
    `UPDATE publish_task
     SET status = 'paused'
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id]
  );
}

/**
 * v1.8.4：恢复暂停的发布任务
 *
 * 把 'paused' 状态恢复为 'pending'（如果有未完成的 record）
 * 或保持原状态（如果已全部完成）。
 */
export async function resumePublishTask(id: number): Promise<void> {
  await query(
    `UPDATE publish_task
     SET status = CASE
       WHEN completed_count + failed_count >= total_count THEN
         CASE WHEN completed_count = 0 THEN 'failed'
              WHEN failed_count = 0 THEN 'completed'
              ELSE 'partial' END
       ELSE 'pending'
     END
     WHERE id = $1 AND status = 'paused'`,
    [id]
  );
}

/**
 * v1.8.4：批量暂停/恢复（按 batch_id）
 *
 * 对该批次下所有 publish_task 执行操作。
 */
export async function batchPauseResumeByBatch(
  userId: number,
  batchId: string,
  action: 'pause' | 'resume'
): Promise<{ affected: number }> {
  if (action === 'pause') {
    const result = await query(
      `UPDATE publish_task
       SET status = 'paused'
       WHERE user_id = $1
         AND batch_id = $2
         AND status IN ('pending', 'processing')`,
      [userId, batchId]
    );
    return { affected: result.rowCount || 0 };
  } else {
    const result = await query(
      `UPDATE publish_task
       SET status = CASE
         WHEN completed_count + failed_count >= total_count THEN
           CASE WHEN completed_count = 0 THEN 'failed'
                WHEN failed_count = 0 THEN 'completed'
                ELSE 'partial' END
         ELSE 'pending'
       END
       WHERE user_id = $1
         AND batch_id = $2
         AND status = 'paused'`,
      [userId, batchId]
    );
    return { affected: result.rowCount || 0 };
  }
}

/**
 * v1.8.4：删除发布任务（级联清理 publish_record）
 *
 * 顺序：
 * 1. DELETE publish_record WHERE task_id = $1
 * 2. DELETE publish_task WHERE id = $1
 *
 * 注意：article 不删除，因为文章本身属于写作任务，发布任务只是引用。
 */
export async function deletePublishTask(id: number): Promise<void> {
  await query(`DELETE FROM publish_record WHERE task_id = $1`, [id]);
  await query(`DELETE FROM publish_task WHERE id = $1`, [id]);
}

/**
 * v1.8.4：批量删除（按 batch_id）
 *
 * 删除该批次下所有 publish_task 及其 publish_record。
 */
export async function batchDeleteByBatch(
  userId: number,
  batchId: string
): Promise<{ deleted: number }> {
  // 查出该批次下所有 publish_task.id
  const idsResult = await query(
    `SELECT id FROM publish_task WHERE user_id = $1 AND batch_id = $2`,
    [userId, batchId]
  );
  const ids = idsResult.rows.map((r: any) => r.id);
  if (ids.length === 0) return { deleted: 0 };

  // 批量删除 publish_record 和 publish_task
  await query(`DELETE FROM publish_record WHERE task_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM publish_task WHERE id = ANY($1::int[])`, [ids]);
  return { deleted: ids.length };
}

// ============ 内容中枢：发布型账号管理（platform_auth 改造） ============

/**
 * 获取发布型账号列表
 * @param userId 当前登录用户 ID
 * @param poolType 'public'=公共池(user_id IS NULL), 'private'=私有池(user_id = customerId), 'all'=全部
 * @param customerId 当 poolType='private' 时指定客户 ID
 */
export async function getPublishAccounts(
  userId: number,
  poolType: 'public' | 'private' | 'all' = 'all',
  customerId?: number,
): Promise<any[]> {
  let sql = `SELECT pa.id, pa.user_id, pa.platform, pa.account_name, pa.avatar_url,
            pa.status, pa.health_status, pa.last_used_at,
            pa.platform_type, pa.created_at, pa.updated_at,
            pa.expires_at, pa.proxy_id, pp.name AS proxy_name,
            pa.publish_daily_limit, pa.publish_used_today, pa.publish_last_used_date,
            pa.publish_mode, pa.publish_fail_count, pa.publish_last_fail_at
     FROM platform_auth pa
     LEFT JOIN proxy_pool pp ON pa.proxy_id = pp.id
     WHERE pa.platform_type IN ('publish', 'both')`;
  const params: any[] = [];
  if (poolType === 'public') {
    sql += ` AND pa.user_id IS NULL`;
  } else if (poolType === 'private') {
    if (customerId == null) {
      // 未指定客户时返回所有私有账号（user_id IS NOT NULL）
      sql += ` AND pa.user_id IS NOT NULL`;
    } else {
      sql += ` AND pa.user_id = $1`;
      params.push(String(customerId));
    }
  }
  sql += ` ORDER BY pa.platform ASC, pa.created_at DESC`;
  const result = await query(sql, params);
  return result.rows;
}

export async function createPublishAccount(data: {
  user_id: number | null;
  platform: string;
  account_name: string;
  storage_state: any;
  avatar_url?: string;
  expires_at?: string;
}): Promise<number> {
  const result = await query(
    `INSERT INTO platform_auth (user_id, platform, account_name, storage_state, avatar_url, expires_at, platform_type, status, health_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'publish', 'active', 'normal')
     RETURNING id`,
    [data.user_id == null ? null : String(data.user_id), data.platform, data.account_name, JSON.stringify(data.storage_state), data.avatar_url || null, data.expires_at || null]
  );
  return result.rows[0].id;
}

export async function updatePublishAccountStorageState(id: number, storageState: any, expiresAt?: string): Promise<void> {
  await query(
    `UPDATE platform_auth
     SET storage_state = $2,
         expires_at = $3,
         status = 'active',
         health_status = 'normal',
         offline_fail_count = 0,
         updated_at = NOW()
     WHERE id = $1`,
    [id, JSON.stringify(storageState), expiresAt || null]
  );
}

export async function updatePublishAccountStatus(id: number, status: 'active' | 'expired', healthStatus: 'normal' | 'banned' | 'offline'): Promise<void> {
  await query(
    `UPDATE platform_auth
     SET status = $2,
         health_status = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, healthStatus]
  );
}

export async function deletePublishAccount(id: number): Promise<void> {
  const client = await (await import('./db')).pool.connect();
  try {
    await client.query('BEGIN');
    // 1. 解除 publish_record 外键引用（设为 NULL，保留发布记录用于审计）
    await client.query(`UPDATE publish_record SET platform_auth_id = NULL WHERE platform_auth_id = $1`, [id]);
    // 2. 删除 publish_account_stats 统计数据
    await client.query(`DELETE FROM publish_account_stats WHERE platform_auth_id = $1`, [id]);
    // 3. 删除账号本身
    await client.query(`DELETE FROM platform_auth WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getPublishAccountById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT * FROM platform_auth WHERE id = $1 AND platform_type IN ('publish', 'both')`,
    [id]
  );
  return result.rows[0] || null;
}

// ============ 内容中枢：平台内容约束规则（platform_content_rule v1.8.0） ============

/**
 * 获取所有平台约束规则
 * @param onlyActive true 时只返回 is_active=true 的平台（前端选目标平台时用）
 */
export async function getPlatformRules(onlyActive: boolean = false): Promise<any[]> {
  const sql = onlyActive
    ? `SELECT * FROM platform_content_rule WHERE is_active = true ORDER BY sort_order ASC, platform ASC`
    : `SELECT * FROM platform_content_rule ORDER BY sort_order ASC, platform ASC`;
  const result = await query(sql);
  return result.rows;
}

/** 获取单个平台约束规则 */
export async function getPlatformRule(platform: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM platform_content_rule WHERE platform = $1`,
    [platform]
  );
  return result.rows[0] || null;
}

/**
 * 批量获取平台规则（写作任务生成时用，按 target_platforms 数组查）
 * 缺失的平台会被忽略（不报错），返回结果按 platform 升序
 */
export async function getPlatformRulesByPlatforms(platforms: string[]): Promise<any[]> {
  if (!platforms || platforms.length === 0) return [];
  const result = await query(
    `SELECT * FROM platform_content_rule WHERE platform = ANY($1::text[]) ORDER BY sort_order ASC`,
    [platforms]
  );
  return result.rows;
}

/**
 * 新增或更新平台约束规则（UPSERT）
 * platform 为主键，存在则更新
 */
export async function upsertPlatformRule(data: {
  platform: string;
  name: string;
  title_min_length?: number;
  title_max_length?: number;
  content_min_length?: number;
  content_max_length?: number;
  style_prompt?: string;
  require_tags?: boolean;
  tags_min_count?: number;
  tags_max_count?: number;
  cover_image_required?: boolean;
  cover_image_mode?: string;
  is_active?: boolean;
  sort_order?: number;
}): Promise<void> {
  await query(
    `INSERT INTO platform_content_rule
      (platform, name, title_min_length, title_max_length, content_min_length, content_max_length,
       style_prompt, require_tags, tags_min_count, tags_max_count, cover_image_required, cover_image_mode,
       is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (platform) DO UPDATE SET
       name = EXCLUDED.name,
       title_min_length = EXCLUDED.title_min_length,
       title_max_length = EXCLUDED.title_max_length,
       content_min_length = EXCLUDED.content_min_length,
       content_max_length = EXCLUDED.content_max_length,
       style_prompt = EXCLUDED.style_prompt,
       require_tags = EXCLUDED.require_tags,
       tags_min_count = EXCLUDED.tags_min_count,
       tags_max_count = EXCLUDED.tags_max_count,
       cover_image_required = EXCLUDED.cover_image_required,
       cover_image_mode = EXCLUDED.cover_image_mode,
       is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order,
       update_time = NOW()`,
    [
      data.platform, data.name,
      data.title_min_length ?? 1, data.title_max_length ?? 100,
      data.content_min_length ?? 100, data.content_max_length ?? 50000,
      data.style_prompt || null,
      data.require_tags ?? false,
      data.tags_min_count ?? 0, data.tags_max_count ?? 5,
      data.cover_image_required ?? false,
      data.cover_image_mode || 'none',
      data.is_active ?? true,
      data.sort_order ?? 0,
    ]
  );
}

/** 删除平台约束规则 */
export async function deletePlatformRule(platform: string): Promise<void> {
  await query(`DELETE FROM platform_content_rule WHERE platform = $1`, [platform]);
}

// ============ v2.0.0: AI平台流量权重层（ai_platform_weight + ai_platform_source_mapping） ============

/** AI平台流量权重记录 */
export interface AiPlatformWeight {
  id: number;
  platform: string;
  display_name: string;
  user_volume_level: number;
  traffic_weight: number;
  is_enabled: boolean;
  notes: string | null;
  updated_at: string;
}

/** AI平台 → 信源映射记录 */
export interface AiPlatformSourceMapping {
  id: number;
  ai_platform: string;
  source_platform: string;
  source_weight: number;
  notes: string | null;
  updated_at: string;
}

/** 获取所有AI平台流量权重 */
export async function getAiPlatformWeights(onlyEnabled: boolean = false): Promise<AiPlatformWeight[]> {
  const sql = onlyEnabled
    ? `SELECT * FROM ai_platform_weight WHERE is_enabled = true ORDER BY user_volume_level DESC, platform ASC`
    : `SELECT * FROM ai_platform_weight ORDER BY user_volume_level DESC, platform ASC`;
  const result = await query(sql);
  return result.rows as AiPlatformWeight[];
}

/** 获取单个AI平台流量权重 */
export async function getAiPlatformWeight(platform: string): Promise<AiPlatformWeight | null> {
  const result = await query(
    `SELECT * FROM ai_platform_weight WHERE platform = $1`,
    [platform]
  );
  return (result.rows[0] as AiPlatformWeight) || null;
}

/** 新增/更新AI平台流量权重（UPSERT） */
export async function upsertAiPlatformWeight(data: {
  platform: string;
  display_name: string;
  user_volume_level?: number;
  traffic_weight?: number;
  is_enabled?: boolean;
  notes?: string;
}): Promise<void> {
  await query(
    `INSERT INTO ai_platform_weight
      (platform, display_name, user_volume_level, traffic_weight, is_enabled, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (platform) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       user_volume_level = EXCLUDED.user_volume_level,
       traffic_weight = EXCLUDED.traffic_weight,
       is_enabled = EXCLUDED.is_enabled,
       notes = EXCLUDED.notes,
       updated_at = CURRENT_TIMESTAMP`,
    [
      data.platform,
      data.display_name,
      data.user_volume_level ?? 3,
      data.traffic_weight ?? 1.0,
      data.is_enabled ?? true,
      data.notes || null,
    ]
  );
}

/** 删除AI平台流量权重 */
export async function deleteAiPlatformWeight(platform: string): Promise<void> {
  await query(`DELETE FROM ai_platform_weight WHERE platform = $1`, [platform]);
}

/** 获取所有AI平台 → 信源映射 */
export async function getAiPlatformSourceMappings(aiPlatform?: string): Promise<AiPlatformSourceMapping[]> {
  const sql = aiPlatform
    ? `SELECT * FROM ai_platform_source_mapping WHERE ai_platform = $1 ORDER BY source_weight DESC, source_platform ASC`
    : `SELECT * FROM ai_platform_source_mapping ORDER BY ai_platform ASC, source_weight DESC, source_platform ASC`;
  const params = aiPlatform ? [aiPlatform] : [];
  const result = await query(sql, params);
  return result.rows as AiPlatformSourceMapping[];
}

/** 新增/更新AI平台 → 信源映射（UPSERT） */
export async function upsertAiPlatformSourceMapping(data: {
  ai_platform: string;
  source_platform: string;
  source_weight?: number;
  notes?: string;
}): Promise<void> {
  await query(
    `INSERT INTO ai_platform_source_mapping
      (ai_platform, source_platform, source_weight, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ai_platform, source_platform) DO UPDATE SET
       source_weight = EXCLUDED.source_weight,
       notes = EXCLUDED.notes,
       updated_at = CURRENT_TIMESTAMP`,
    [
      data.ai_platform,
      data.source_platform,
      data.source_weight ?? 1.0,
      data.notes || null,
    ]
  );
}

/** 删除AI平台 → 信源映射 */
export async function deleteAiPlatformSourceMapping(aiPlatform: string, sourcePlatform: string): Promise<void> {
  await query(
    `DELETE FROM ai_platform_source_mapping WHERE ai_platform = $1 AND source_platform = $2`,
    [aiPlatform, sourcePlatform]
  );
}

/**
 * 计算各自媒体平台的综合投放权重（v2.0.0 核心函数）
 *
 * 公式：自媒体平台X的投放权重 = Σ(启用的AI平台流量权重 × 该AI平台→X的信源权重)
 *
 * 高用户量AI平台的信源平台会自动获得更高的综合投放权重，
 * 用于指导周报/月报投放建议、写作任务平台侧重、发布任务平台分配。
 *
 * @returns { sourcePlatform: weight } 按权重降序排列
 */
export async function calcSourcePlatformWeights(): Promise<Record<string, number>> {
  // 一次查询完成聚合计算：JOIN ai_platform_weight 和 ai_platform_source_mapping
  const sql = `
    SELECT
      m.source_platform,
      SUM(w.traffic_weight * m.source_weight) AS total_weight
    FROM ai_platform_source_mapping m
    INNER JOIN ai_platform_weight w ON w.platform = m.ai_platform
    WHERE w.is_enabled = true
    GROUP BY m.source_platform
    ORDER BY total_weight DESC
  `;
  const result = await query(sql);
  const weights: Record<string, number> = {};
  for (const row of result.rows) {
    weights[row.source_platform] = parseFloat(row.total_weight);
  }
  return weights;
}

/**
 * 按综合投放权重分配文章数量（v2.0.0）
 *
 * 根据各自媒体平台的综合权重比例，将 totalArticles 篇文章分配到各平台。
 * 权重高的平台分配更多文章，权重为 0 或极低的平台不分配。
 *
 * @param totalArticles 本批计划投放的总文章数
 * @param candidatePlatforms 候选平台列表（可选，不传则使用所有有权重的平台）
 * @returns { platform: articleCount } 各平台分配的文章数（总和≈totalArticles）
 */
export async function allocateArticlesByWeight(
  totalArticles: number,
  candidatePlatforms?: string[]
): Promise<Record<string, number>> {
  const allWeights = await calcSourcePlatformWeights();

  // 过滤候选平台
  const weights: Record<string, number> = {};
  for (const [platform, weight] of Object.entries(allWeights)) {
    if (candidatePlatforms && !candidatePlatforms.includes(platform)) continue;
    if (weight <= 0) continue;
    weights[platform] = weight;
  }

  const platforms = Object.keys(weights);
  if (platforms.length === 0 || totalArticles <= 0) return {};

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  // 先按比例计算浮点数分配量，再向下取整
  const rawAllocation: Record<string, number> = {};
  for (const [platform, weight] of Object.entries(weights)) {
    rawAllocation[platform] = (weight / totalWeight) * totalArticles;
  }

  // 向下取整
  const allocation: Record<string, number> = {};
  for (const [platform, raw] of Object.entries(rawAllocation)) {
    allocation[platform] = Math.floor(raw);
  }

  // 将取整余数分配给小数部分最大的平台（保证总数一致）
  let allocated = Object.values(allocation).reduce((a, b) => a + b, 0);
  const remainder = totalArticles - allocated;
  if (remainder > 0) {
    // 按小数部分降序排列
    const fractional = Object.entries(rawAllocation)
      .map(([platform, raw]) => ({ platform, frac: raw - Math.floor(raw) }))
      .sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < remainder && i < fractional.length; i++) {
      allocation[fractional[i].platform] += 1;
    }
  }

  return allocation;
}

/**
 * v1.8.0：按写作任务查询平台专属文章（target_platform IS NOT NULL）
 * 用于「按写作任务发布」：每篇文章已有平台归属，发布时按文章的平台创建 publish_task
 */
export async function getPlatformArticlesByTask(taskId: number): Promise<any[]> {
  const result = await query(
    `SELECT id, title, core_keyword, target_platform, word_count, status
     FROM article
     WHERE task_id = $1 AND target_platform IS NOT NULL
     ORDER BY target_platform ASC, id ASC`,
    [taskId]
  );
  return result.rows;
}

