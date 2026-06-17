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
  await query(
    `UPDATE users SET username = $1, phone = $2, email = $3, url = $4, address = $5,
     level = $6, cid = $7, date_time = $8, update_time = CURRENT_TIMESTAMP WHERE id = $9`,
    [user.username, user.phone || '', user.email || '', user.url || '',
     user.address || '', user.level || '0', user.cid || '', user.dateTime || '', id]
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

// 获取核心关键词排名
export async function getCoreKeywordRank(userId: string, limit: number = 20) {
  const result = await query(
    `SELECT expanded_keyword as keyword, COUNT(*) as count
     FROM keyword_search_rank
     WHERE user_id = $1 AND expanded_keyword != ''
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

// ============ 数据生成 ============

// 获取任务已生成数量
export async function getTaskGeneratedNum(taskId: number): Promise<number> {
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
}) {
  const queryTime = randomTimeInDate(params.targetDate);
  await client.query(
    `INSERT INTO keyword_search_rank
     (expanded_keyword, distillate_keyword, platform, user_id, query_time, create_time, update_time, task_id)
     VALUES ($1, $2, $3, $4, $5, $5, $5, $6)`,
    [params.expandedKeyword, params.distillateKeyword, params.platform, params.userId, queryTime, params.taskId]
  );
}

// 在指定日期范围内生成随机时间（80% 集中在 8:00-24:00）
function randomTimeInDate(date: Date): Date {
  const result = new Date(date);
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
