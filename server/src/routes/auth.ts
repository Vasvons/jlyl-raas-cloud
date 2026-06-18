import { Router } from 'express';
import { findUserByUsername, findUserById, getAllUsers, getUsersByPage, createUser, updateUser, deleteUser, getUserLatestDataTime } from '../repository';
import { generateToken, hashPassword, comparePassword, authMiddleware, adminMiddleware } from '../auth';

const router = Router();

// 临时：重置管理员密码（无认证，部署后访问一次即可）
// 访问 GET /users/resetAdmin 即可重置管理员密码为 admin123
// 安全起见，重置后请删除此路由
router.get('/resetAdmin', async (req, res) => {
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPassword = await hashPassword(password);

    // 检查管理员是否存在
    const existing = await findUserByUsername(username);
    if (existing) {
      // 更新密码
      await (await import('../repository')).updateUser(existing.id, { password: hashedPassword });
      return res.json({
        code: 200,
        message: `管理员密码已重置成功`,
        data: { username, password, note: '请使用此密码登录，登录后请立即修改密码' }
      });
    } else {
      // 创建管理员
      const id = await (await import('../repository')).createUser({
        username,
        password: hashedPassword,
        level: '1',
      });
      return res.json({
        code: 200,
        message: `管理员账号已创建`,
        data: { id, username, password }
      });
    }
  } catch (e) {
    console.error('[Auth] 重置管理员密码失败:', e);
    return res.json({ code: 500, message: '重置失败: ' + (e as Error).message });
  }
});

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.json({ code: 400, message: '用户名和密码不能为空' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const isMatch = await comparePassword(password, user.password);
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
router.get('/getLoginUser', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      return res.json({ code: 400, message: '缺少userId' });
    }

    const user = await findUserById(parseInt(userId));
    if (!user) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const latestDataTime = await getUserLatestDataTime(userId);

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

export default router;
