import { query, withTransaction, PoolClient } from './db';

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
      if (Array.isArray(config.A)) {
        A = config.A.filter((w: any) => typeof w === 'string' && w.trim());
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
      if (Array.isArray(config.A)) A = config.A;
      if (Array.isArray(config.B)) B = config.B;
      if (Array.isArray(config.D)) D = config.D;
      if (Array.isArray(config.E)) E = config.E;
      if (Array.isArray(config.F)) F = config.F;
      if (Array.isArray(config.combos)) G = config.combos;
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
      if (Array.isArray(config.C)) C = config.C;
      if (Array.isArray(config.D)) D = config.D;
      if (Array.isArray(config.combos)) G = config.combos;
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
         WHERE q.status = 'pending'
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
  return {
    queueId: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    keywordType: row.keyword_type,
    platforms: row.platforms,
    keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords,
    lastKeywordIndex: row.last_keyword_index ?? -1,
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
         (tr.round_no = 0 AND q.round_no = 0 AND q.create_time >= COALESCE(tr.round_start_time, q.create_time))
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
         (tr.round_no = 0 AND q.round_no = 0 AND q.create_time >= COALESCE(tr.round_start_time, q.create_time))
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
}): Promise<number> {
  const result = await query(
    `INSERT INTO aeo_full_report
     (task_id, user_id, round_no, total_keywords, total_records, brand_matched_count,
      visibility_score, mention_count, positive_ratio, neutral_ratio, negative_ratio,
      competitor_analysis, suggestions, raw_analysis, record_ids, round_start_time, round_end_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      round_end_time = EXCLUDED.round_end_time
     RETURNING id`,
    [
      params.taskId, params.userId, params.roundNo, params.totalKeywords,
      params.totalRecords, params.brandMatchedCount, params.visibilityScore,
      params.mentionCount, params.positiveRatio, params.neutralRatio,
      params.negativeRatio, params.competitorAnalysis, params.suggestions,
      params.rawAnalysis, params.recordIds, params.roundStartTime, params.roundEndTime
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
}): Promise<number> {
  // cronExpr 可选：循环模式下不传，默认 '0 0 * * *' 保持兼容
  const cronExpr = params.cronExpr || '0 0 * * *';
  // excludePrefixes 存储为 JSON 字符串（仅蒸馏词库有效）
  const excludePrefixesJson = (params.keywordType === 0 && params.excludePrefixes && params.excludePrefixes.length > 0)
    ? JSON.stringify(params.excludePrefixes.filter(p => p && p.trim()))
    : null;
  const result = await query(
    `INSERT INTO real_collect_task (user_id, task_name, keyword_type, platforms, cron_expr, status, shard_size, exclude_prefixes)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING id`,
    [params.userId, params.taskName, params.keywordType, params.platforms, cronExpr, params.shardSize || 50, excludePrefixesJson]
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
}): Promise<number> {
  const result = await query(
    `INSERT INTO real_collect_record 
     (task_id, user_id, keyword, keyword_type, platform, brand_matched, matched_brands, 
      has_contact, contacts, share_url, static_page_id, raw_content, query_time, worker_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [params.taskId, params.userId, params.keyword, params.keywordType, params.platform,
     params.brandMatched, params.matchedBrands, params.hasContact, JSON.stringify(params.contacts),
     params.shareUrl, params.staticPageId, params.rawContent, params.queryTime, params.workerId]
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
export async function acquirePlatformAccount(platform: string): Promise<{ id: number; storageState: string } | null> {
  // 只借用 normal 状态、status=active、未过期、未超日限额的账号（最久未使用优先）
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
     RETURNING id, storage_state`,
    [platform]
  );
  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, storageState: result.rows[0].storage_state };
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
  const result = await query(
    `UPDATE platform_auth
     SET updated_at = NOW()
     WHERE id IN (
       SELECT id FROM platform_auth
       WHERE status = 'active'
         AND health_status = 'normal'
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
    `SELECT t.id, t.user_id, t.task_name, t.keyword_type
     FROM real_collect_task t
     WHERE t.status = 'active'
     ORDER BY t.id`
  );
  return result.rows;
}

/** 检查今日是否已生成 AEO 报告 */
export async function checkAeoReportExists(taskId: number, reportDate: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM aeo_report WHERE task_id = $1 AND report_date = $2`,
    [taskId, reportDate]
  );
  return result.rows.length > 0;
}
