import { Router } from 'express';
import { findUserByUsername, findUserById, getAllUsers, getUsersByPage, createUser, updateUser, deleteUser, getUserLatestDataTime } from '../repository';
import { generateToken, hashPassword, comparePassword, authMiddleware, adminMiddleware, verifyToken } from '../auth';
import { query } from '../db';
import crypto from 'crypto';

const router = Router();

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('[Login] 登录请求:', { username, passwordLength: password?.length });

    if (!username || !password) {
      return res.json({ code: 400, message: '用户名和密码不能为空' });
    }

    const user = await findUserByUsername(username);
    console.log('[Login] 查询用户:', user ? { id: user.id, username: user.username, level: user.level, pwdLen: user.password?.length } : 'not found');

    if (!user) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const isMatch = await comparePassword(password, user.password);
    console.log('[Login] 密码比对结果:', isMatch);

    if (!isMatch) {
      return res.json({ code: 400, message: '密码错误' });
    }

    const token = generateToken({ id: user.id, username: user.username, level: user.level });

    // 获取最新数据时间
    const latestDataTime = await getUserLatestDataTime(user.id.toString());

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        token,
        userInfo: {
          id: user.id,
          username: user.username,
          phone: user.phone,
          email: user.email,
          url: user.url,
          address: user.address,
          level: user.level,
          cid: user.cid,
          dateTime: latestDataTime || user.date_time,
        }
      }
    });
  } catch (e) {
    console.error('[Auth] 登录失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前登录用户信息
// 支持两种方式：
// 1. 不带 userId：通过 token 获取当前登录用户
// 2. 带 userId：获取指定用户信息（管理员切换查看）
router.get('/getLoginUser', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    let targetUserId: number;

    if (userId) {
      // 指定了 userId，使用该值
      targetUserId = parseInt(userId);
    } else {
      // 未指定 userId，通过 token 获取当前登录用户
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ code: 401, message: '未登录' });
      }
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      if (!decoded) {
        return res.json({ code: 401, message: '登录已过期' });
      }
      targetUserId = decoded.id;
    }

    const user = await findUserById(targetUserId);
    if (!user) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const latestDataTime = await getUserLatestDataTime(String(targetUserId));

    res.json({
      code: 200,
      data: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        email: user.email,
        url: user.url,
        address: user.address,
        level: user.level,
        cid: user.cid,
        dateTime: latestDataTime || user.date_time,
      }
    });
  } catch (e) {
    console.error('[Auth] 获取用户信息失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取所有用户（管理员）
router.get('/list', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ code: 200, data: users });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 分页查询用户（管理员）
router.get('/queryUserList', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const pageNum = parseInt(req.query.pageNum as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 30;
    const result = await getUsersByPage(pageNum, pageSize);
    res.json({ code: 200, data: { list: result.list, total: result.total, pageNum, pageSize } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建用户（管理员）
router.post('/create', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, ...rest } = req.body;
    if (!username || !password) {
      return res.json({ code: 400, message: '用户名和密码不能为空' });
    }

    const existing = await findUserByUsername(username);
    if (existing) {
      return res.json({ code: 400, message: '用户名已存在' });
    }

    const hashedPassword = await hashPassword(password);
    const id = await createUser({ username, password: hashedPassword, ...rest });
    res.json({ code: 200, data: { id }, message: '创建成功' });
  } catch (e) {
    console.error('[Auth] 创建用户失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新用户（管理员）
router.post('/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id, password, ...rest } = req.body;
    if (!id) {
      return res.json({ code: 400, message: '缺少用户ID' });
    }

    // 检查用户是否存在
    const existingUser = await findUserById(parseInt(id));
    if (!existingUser) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 如果修改了用户名，检查新用户名是否与其他用户冲突
    if (rest.username && rest.username !== existingUser.username) {
      const conflict = await findUserByUsername(rest.username);
      if (conflict && conflict.id !== parseInt(id)) {
        return res.json({ code: 400, message: '用户名已存在' });
      }
    }

    if (password) {
      rest.password = await hashPassword(password);
    }

    await updateUser(parseInt(id), rest);
    res.json({ code: 200, message: '更新成功' });
  } catch (e) {
    console.error('[Auth] 更新用户失败:', e);
    const errMsg = (e as Error).message || '';
    // 处理唯一约束冲突
    if (errMsg.includes('duplicate key') || errMsg.includes('unique')) {
      return res.json({ code: 400, message: '用户名已存在' });
    }
    res.json({ code: 500, message: '服务器错误: ' + errMsg });
  }
});

// 删除用户（管理员）
router.post('/delete', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    await deleteUser(parseInt(id));
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 分享token（GEO报告页面分享功能） ============

// 生成分享token（需登录，为当前登录用户或指定用户生成）
// 管理员可通过 userId 参数为任意用户生成；普通用户只能为自己生成
router.post('/generateShareToken', authMiddleware, async (req, res) => {
  try {
    const loginUser = (req as any).user;
    let targetUserId: number;
    let targetUsername: string;

    if (req.body.userId) {
      // 指定了 userId：仅管理员可为他人生成
      if (loginUser.level !== '1') {
        return res.json({ code: 403, message: '仅管理员可为其他用户生成分享链接' });
      }
      targetUserId = parseInt(req.body.userId);
      const targetUser = await findUserById(targetUserId);
      if (!targetUser) {
        return res.json({ code: 404, message: '目标用户不存在' });
      }
      targetUsername = targetUser.username;
    } else {
      // 未指定 userId：为当前登录用户生成
      targetUserId = loginUser.id;
      targetUsername = loginUser.username;
    }

    // 生成随机token（64位十六进制字符串）
    const shareToken = crypto.randomBytes(32).toString('hex');

    // 过期时间：365天后（长期有效，持久化登录）
    const expireTime = new Date();
    expireTime.setDate(expireTime.getDate() + 365);

    // 存入数据库（每个用户只保留最新的5个分享token，避免过多）
    await query(
      `INSERT INTO share_tokens (token, user_id, username, expire_time) VALUES ($1, $2, $3, $4)`,
      [shareToken, targetUserId, targetUsername, expireTime]
    );

    // 清理该用户的旧token（只保留最新5个）
    await query(
      `DELETE FROM share_tokens WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM share_tokens WHERE user_id = $1 ORDER BY create_time DESC LIMIT 5
       )`,
      [targetUserId]
    );

    console.log(`[Share] 用户 ${targetUsername}(ID:${targetUserId}) 生成分享token成功`);

    res.json({
      code: 200,
      message: '分享链接生成成功',
      data: {
        shareToken,
        userId: targetUserId,
        username: targetUsername,
        expireTime: expireTime.toISOString(),
      }
    });
  } catch (e) {
    console.error('[Auth] 生成分享token失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 验证分享token（无需登录，返回登录token实现自动登录）
router.get('/verifyShareToken', async (req, res) => {
  try {
    const shareToken = req.query.token as string;
    if (!shareToken) {
      return res.json({ code: 400, message: '缺少分享token' });
    }

    // 查询分享token
    const tokenResult = await query(
      `SELECT id, user_id, username, create_time, expire_time FROM share_tokens WHERE token = $1`,
      [shareToken]
    );

    if (tokenResult.rows.length === 0) {
      return res.json({ code: 404, message: '分享链接无效或已失效' });
    }

    const tokenData = tokenResult.rows[0];

    // 检查是否过期
    if (tokenData.expire_time && new Date(tokenData.expire_time) < new Date()) {
      // 删除过期token
      await query('DELETE FROM share_tokens WHERE id = $1', [tokenData.id]);
      return res.json({ code: 401, message: '分享链接已过期' });
    }

    // 查找用户
    const user = await findUserById(tokenData.user_id);
    if (!user) {
      // 用户已删除，清理token
      await query('DELETE FROM share_tokens WHERE id = $1', [tokenData.id]);
      return res.json({ code: 404, message: '分享链接对应的用户不存在' });
    }

    // 生成登录token
    const loginToken = generateToken({ id: user.id, username: user.username, level: user.level });

    // 更新最后使用时间
    await query('UPDATE share_tokens SET last_use_time = CURRENT_TIMESTAMP WHERE id = $1', [tokenData.id]);

    // 获取最新数据时间
    const latestDataTime = await getUserLatestDataTime(user.id.toString());

    console.log(`[Share] 用户 ${user.username}(ID:${user.id}) 通过分享token登录成功`);

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        token: loginToken,
        userInfo: {
          id: user.id,
          username: user.username,
          phone: user.phone,
          email: user.email,
          url: user.url,
          address: user.address,
          level: user.level,
          cid: user.cid,
          dateTime: latestDataTime || user.date_time,
        }
      }
    });
  } catch (e) {
    console.error('[Auth] 验证分享token失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户的所有分享链接（需登录）
router.get('/shareTokens', authMiddleware, async (req, res) => {
  try {
    const loginUser = (req as any).user;
    let targetUserId = loginUser.id;

    // 管理员可查看指定用户的分享链接
    if (req.query.userId && loginUser.level === '1') {
      targetUserId = parseInt(req.query.userId as string);
    }

    const result = await query(
      `SELECT token, user_id, username, create_time, expire_time, last_use_time
       FROM share_tokens WHERE user_id = $1 ORDER BY create_time DESC LIMIT 20`,
      [targetUserId]
    );

    res.json({
      code: 200,
      data: result.rows.map((row: any) => ({
        token: row.token,
        userId: row.user_id,
        username: row.username,
        createTime: row.create_time,
        expireTime: row.expire_time,
        lastUseTime: row.last_use_time,
      }))
    });
  } catch (e) {
    console.error('[Auth] 获取分享链接列表失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除分享链接（需登录）
router.post('/deleteShareToken', authMiddleware, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.json({ code: 400, message: '缺少token' });
    }

    const loginUser = (req as any).user;

    // 查询token
    const tokenResult = await query('SELECT user_id FROM share_tokens WHERE token = $1', [token]);
    if (tokenResult.rows.length === 0) {
      return res.json({ code: 404, message: '分享链接不存在' });
    }

    // 只有本人或管理员可以删除
    const tokenUserId = tokenResult.rows[0].user_id;
    if (tokenUserId !== loginUser.id && loginUser.level !== '1') {
      return res.json({ code: 403, message: '无权删除他人的分享链接' });
    }

    await query('DELETE FROM share_tokens WHERE token = $1', [token]);
    res.json({ code: 200, message: '删除成功' });
  } catch (e) {
    console.error('[Auth] 删除分享链接失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
