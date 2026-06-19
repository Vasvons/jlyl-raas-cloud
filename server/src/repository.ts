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
  const result = await query(
    'SELECT to_char(MAX(create_time), \'YYYY-MM-DD HH24:MI:SS\') as latest FROM keyword_search_rank WHERE user_id = $1',
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

  let where = ['k.user_id = $1'];
  let args: any[] = [params.userId];
  let argIdx = 2;

  if (params.platform && params.platform !== '全部') {
    where.push(`k.platform = $${argIdx++}`);
    args.push(params.platform);
  }

  if (params.keyword) {
    where.push(`(k.expanded_keyword ILIKE $${argIdx} OR k.distillate_keyword ILIKE $${argIdx})`);
    args.push(`%${params.keyword}%`);
    argIdx++;
  }

  // 类型过滤
  if (params.type === 'brand') {
    // 品牌搜索：关键词在品牌关键词表中
    where.push(`EXISTS (SELECT 1 FROM pp p WHERE p.pp = k.expanded_keyword AND p.user_id = k.user_id)`);
  } else if (params.type === 'scene') {
    // 联系方式：has_lxfs = 1
    where.push(`EXISTS (SELECT 1 FROM zlgjc z2 INNER JOIN zlgjcurl u2 ON z2.id = u2.zlgjcid WHERE z2.value = k.distillate_keyword AND z2.userid = k.user_id AND u2.has_lxfs = 1 AND u2.pt = k.platform)`);
  }

  const whereClause = where.join(' AND ');

  // 查询总数
  const countResult = await query(
    `SELECT COUNT(*) as total FROM keyword_search_rank k WHERE ${whereClause}`,
    args
  );
  const total = parseInt(countResult.rows[0].total);

  // 查询列表
  const listResult = await query(
    `SELECT k.id, k.expanded_keyword, k.distillate_keyword, k.platform, k.user_id,
            k.query_time, k.url, k.create_time,
            u.url as zlgjc_url, u.has_lxfs
     FROM keyword_search_rank k
     LEFT JOIN zlgjc z ON z.value = k.distillate_keyword AND z.userid = k.user_id
     LEFT JOIN zlgjcurl u ON u.zlgjcid = z.id AND u.pt = k.platform
     WHERE ${whereClause}
     ORDER BY k.create_time DESC
     LIMIT $${argIdx++} OFFSET $${argIdx++}`,
    [...args, pageSize, offset]
  );

  return { list: listResult.rows, total, page, pageSize };
}

// 获取关键词数量统计
export async function getKeywordCount(userId: string) {
  const result = await query(
    `SELECT
       COUNT(DISTINCT expanded_keyword) as core_count,
       COUNT(DISTINCT distillate_keyword) as distillate_count,
       COUNT(*) as total_count
     FROM keyword_search_rank WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

// 获取平台占比
export async function getPlatformRatio(userId: string) {
  const result = await query(
    `SELECT p.pt, COUNT(k.id) as count
     FROM pt p
     LEFT JOIN keyword_search_rank k ON k.platform = p.pt AND k.user_id = $1
     GROUP BY p.pt
     ORDER BY CASE p.pt
       WHEN '豆包' THEN 1 WHEN 'DeepSeek' THEN 2 WHEN '腾讯元宝' THEN 3
       WHEN '通义千问' THEN 4 WHEN '纳米' THEN 5 WHEN '文心一言' THEN 6
       WHEN '智谱AI' THEN 7 WHEN 'Kimi' THEN 8 ELSE 99 END`,
    [userId]
  );
  return result.rows;
}

// 获取核心关键词排名（排除品牌关键词）
export async function getCoreKeywordRank(userId: string, limit: number = 20) {
  const result = await query(
    `SELECT expanded_keyword as keyword, COUNT(*) as count
     FROM keyword_search_rank k
     WHERE k.user_id = $1 AND k.expanded_keyword != ''
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

export async function getZlgjcByUserId(userId: string) {
  const result = await query(
    'SELECT id, value, hxgjc, userid, lxfs, create_time FROM zlgjc WHERE userid = $1 ORDER BY id',
    [userId]
  );
  return result.rows;
}

export async function insertZlgjc(item: any): Promise<number> {
  const result = await query(
    'INSERT INTO zlgjc (value, hxgjc, userid, lxfs) VALUES ($1, $2, $3, $4) RETURNING id',
    [item.value, item.hxgjc || '', item.userid || '', item.lxfs || '']
  );
  return result.rows[0].id;
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
  await query(
    `UPDATE task_info SET user_id = $1, start_date = $2, end_date = $3, total_num = $4,
     status = $5, name = $6 WHERE id = $7`,
    [task.userId, task.startDate, task.endDate, task.totalNum, task.status, task.name || '', id]
  );
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
export async function getTaskGeneratedNum(taskId: number): Promise<number> {
  // 先从 task_progress 表读取（这是任务的实际进度）
  const progressResult = await query('SELECT generated_num FROM task_progress WHERE task_id = $1', [taskId]);
  if (progressResult.rows.length > 0) {
    return parseInt(progressResult.rows[0].generated_num) || 0;
  }
  // 如果 task_progress 没有记录，回退到统计 keyword_search_rank
  const result = await query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE task_id = $1', [taskId]);
  return parseInt(result.rows[0].count);
}

// 生成单条数据
export async function generateOneRecord(client: PoolClient, params: {
  userId: string;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  taskId: number;
  targetDate: Date;
  hourWeights?: { hour_slot: number; weight: number }[];
}) {
  const queryTime = randomTimeInDate(params.targetDate, params.hourWeights);
  await client.query(
    `INSERT INTO keyword_search_rank
     (expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time, update_time, task_id)
     VALUES ($1, $2, $3, $4, $5, $5, $5, $6)`,
    [params.expandedKeyword, params.distillateKeyword, params.platform, params.userId, queryTime, params.taskId]
  );
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
    result.setHours(startHour + Math.floor(Math.random() * 3));
    result.setMinutes(Math.floor(Math.random() * 60));
    result.setSeconds(Math.floor(Math.random() * 60));
  } else {
    // 默认分布：80% 集中在 8:00-24:00
    const isPeak = Math.random() < 0.8;
    if (isPeak) {
      // 8:00 - 23:59:59
      result.setHours(8 + Math.floor(Math.random() * 16));
      result.setMinutes(Math.floor(Math.random() * 60));
      result.setSeconds(Math.floor(Math.random() * 60));
    } else {
      // 0:00 - 7:59:59
      result.setHours(Math.floor(Math.random() * 8));
      result.setMinutes(Math.floor(Math.random() * 60));
      result.setSeconds(Math.floor(Math.random() * 60));
    }
  }

  return result;
}

// 批量生成数据
export async function generateBatch(params: {
  userId: string;
  taskId: number;
  count: number;
  weights: { platform: string; weight: number }[];
  zlgjcList: { value: string; hxgjc: string }[];
  ppList: string[];
  targetDate: Date;
  hourWeights?: { hour_slot: number; weight: number }[];
}): Promise<void> {
  await withTransaction(async (client) => {
    // 构建加权平台列表
    const weightedPlatforms: string[] = [];
    for (const w of params.weights) {
      for (let i = 0; i < w.weight; i++) {
        weightedPlatforms.push(w.platform);
      }
    }

    for (let i = 0; i < params.count; i++) {
      // 随机选择关键词（80% 蒸馏关键词，20% 品牌关键词）
      const isBrand = Math.random() < 0.2 && params.ppList.length > 0;
      let expandedKeyword: string;
      let distillateKeyword: string;

      if (isBrand) {
        expandedKeyword = params.ppList[Math.floor(Math.random() * params.ppList.length)];
        const zlgjc = params.zlgjcList[Math.floor(Math.random() * params.zlgjcList.length)];
        distillateKeyword = zlgjc.value;
      } else {
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
      });
    }

    // 更新用户数据时间
    await client.query(
      'UPDATE users SET date_time = to_char(CURRENT_TIMESTAMP, \'YYYY-MM-DD HH24:MI:SS\') WHERE id = $1',
      [params.userId]
    );
  });
}

// 获取/创建每日随机数
export async function getOrCreateDailyRandom(taskId: number, date: Date): Promise<number> {
  const dateStr = date.toISOString().split('T')[0];
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
  const dateStr = date.toISOString().split('T')[0];
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
export async function getZlgjcByPage(userId: string, pageNum: number, pageSize: number) {
  const offset = (pageNum - 1) * pageSize;
  const countResult = await query('SELECT COUNT(*) as total FROM zlgjc WHERE userid = $1', [userId]);
  const total = parseInt(countResult.rows[0].total);
  const result = await query(
    'SELECT id, value, hxgjc, userid, lxfs, create_time FROM zlgjc WHERE userid = $1 ORDER BY id LIMIT $2 OFFSET $3',
    [userId, pageSize, offset]
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

// 删除蒸馏关键词（级联删除跳转链接）
export async function deleteZlgjc(id: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM zlgjcurl WHERE zlgjcid = $1', [id]);
    await client.query('DELETE FROM zlgjc WHERE id = $1', [id]);
  });
}

// ============ 蒸馏关键词生成（笛卡尔积）============

// 生成蒸馏关键词（笛卡尔积组合）
export async function generateZlgjcKeywords(userId: string, wordGroups: { A: string[]; B: string[]; C: string[]; D: string[]; E: string[]; F: string[]; G: string[] }) {
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
      combinations.push({ keyword, hxgjc: C[0] || '' });
    }
  }

  // 查询已存在的关键词
  const existingResult = await query('SELECT value FROM zlgjc WHERE userid = $1', [userId]);
  const existing = new Set(existingResult.rows.map((r: any) => r.value));

  let inserted = 0;
  let duplicated = 0;

  for (const { keyword, hxgjc } of combinations) {
    if (existing.has(keyword)) {
      duplicated++;
    } else {
      await query(
        'INSERT INTO zlgjc (value, hxgjc, userid, lxfs) VALUES ($1, $2, $3, $4)',
        [keyword, hxgjc, userId, '']
      );
      existing.add(keyword);
      inserted++;
    }
  }

  return { inserted, duplicated, total: combinations.length };
}

// ============ 关键词维护列表 ============

// 关键词维护列表（从 keyword_search_rank 去重查询）
export async function getKeywordMaintenanceList(params: { userId: string; platform?: string; pageNum: number; pageSize: number; keyword?: string }) {
  const offset = (params.pageNum - 1) * params.pageSize;
  let where = ['k.user_id = $1'];
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
    query('SELECT COUNT(*) as total FROM keyword_search_rank'),
    query('SELECT (SELECT COUNT(*) FROM distillate_keyword) + (SELECT COUNT(*) FROM zlgjc) as total'),
    query("SELECT COUNT(*) as total FROM keyword_search_rank WHERE query_time::date = CURRENT_DATE"),
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

// 最近生成记录
export async function getRecentRecords(limit: number = 20) {
  const result = await query(
    `SELECT id, expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time
     FROM keyword_search_rank
     WHERE create_time IS NOT NULL
     ORDER BY create_time DESC NULLS LAST
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
      query('SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1', [userId]),
      query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1', [userId]),
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

  // 3. 各平台数据分布
  const platformRes = await query(
    `SELECT platform, COUNT(*) as count
     FROM keyword_search_rank
     WHERE user_id = $1 AND platform != ''
     GROUP BY platform
     ORDER BY count DESC`,
    [userId]
  );

  // 4. 关键词统计
  const [dkCountRes, zlgjcCountRes, ppCountRes, recordCountRes, todayCountRes] = await Promise.all([
    query('SELECT COUNT(*) as count FROM distillate_keyword WHERE user_id = $1', [userId]),
    query('SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1', [userId]),
    query('SELECT COUNT(*) as count FROM pp WHERE user_id = $1', [userId]),
    query('SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1', [userId]),
    query("SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1 AND query_time::date = CURRENT_DATE", [userId]),
  ]);

  // 5. 最近7天每日生成趋势
  const trendRes = await query(
    `SELECT query_time::date as date, COUNT(*) as count
     FROM keyword_search_rank
     WHERE user_id = $1 AND query_time >= CURRENT_DATE - INTERVAL '6 days'
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
        const insertResult = await client.query(
          `INSERT INTO zlgjc (value, userid, lxfs, hxgjc)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [z.value || '', newUserId, z.lxfs || '', z.hxgjc || '']
        );
        const newId = insertResult.rows[0].id;
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
