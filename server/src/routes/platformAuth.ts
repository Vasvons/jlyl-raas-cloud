import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  savePlatformAuth,
  getPlatformAuthList,
  deletePlatformAuth,
  getAvailableAuthCount,
  getPlatformAuthById,
  getAuthsForRenewal,
  updatePlatformAuthStorage,
  updatePlatformAuthStatus,
  updatePlatformAuthDailyLimit,
  acquirePlatformAccount,
  releasePlatformAccount,
  resetAccountHealth,
} from '../repository';

const router = Router();

// Worker 调用的内部接口（无鉴权，通过内网访问）
// 借用账号
router.post('/acquire', async (req, res) => {
  try {
    const { platform } = req.body;
    if (!platform) {
      return res.status(400).json({ code: 400, message: '缺少 platform 参数' });
    }
    const account = await acquirePlatformAccount(platform);
    if (!account) {
      return res.json({ code: 404, message: `平台 ${platform} 无可用账号` });
    }
    res.json({ code: 200, data: account });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 归还账号
router.post('/release', async (req, res) => {
  try {
    const { authId, result } = req.body;
    if (!authId || !Number.isFinite(Number(authId))) {
      return res.status(400).json({ code: 400, message: '缺少或无效的 authId' });
    }
    const validResults = ['success', 'failed', 'rate_limited'];
    if (!validResults.includes(result)) {
      return res.status(400).json({ code: 400, message: 'result 必须是 success/failed/rate_limited' });
    }
    await releasePlatformAccount(Number(authId), result);
    res.json({ code: 200, message: 'ok' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 获取需要续期的账号列表（worker 调用，无鉴权）
router.get('/renew/pending', async (req, res) => {
  try {
    const auths = await getAuthsForRenewal();
    // 不返回 storage_state 给避免泄露，只返回 id 和 platform
    res.json({ code: 200, data: auths.map((a: any) => ({ id: a.id, platform: a.platform })) });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 获取续期账号的 storageState（worker 调用）
router.post('/renew/fetch', async (req, res) => {
  try {
    const { id } = req.body;
    const auth = await getPlatformAuthById(Number(id));
    if (!auth) {
      return res.json({ code: 404, message: '账号不存在' });
    }
    res.json({ code: 200, data: { id: auth.id, platform: auth.platform, storageState: auth.storage_state } });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 提交续期结果（worker 调用）
router.post('/renew/complete', async (req, res) => {
  try {
    const { id, success, storageState, expiresAt } = req.body;
    if (!id || !Number.isFinite(Number(id))) {
      return res.json({ code: 400, message: '缺少或无效的 id' });
    }
    const authId = Number(id);
    if (success && storageState) {
      // 校验 storageState 是合法 JSON
      try {
        JSON.parse(storageState);
      } catch {
        return res.json({ code: 400, message: 'storageState 不是合法 JSON' });
      }
      await updatePlatformAuthStorage(authId, storageState, expiresAt);
      console.log(`[PlatformAuth] 账号 ${authId} 续期成功`);
    } else {
      await updatePlatformAuthStatus(authId, 'expired');
      console.log(`[PlatformAuth] 账号 ${authId} 续期失败，标记为过期`);
    }
    res.json({ code: 200, message: 'ok' });
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});

// 以下接口需要管理员鉴权
router.use(authMiddleware, adminMiddleware);

// 查询账号池列表
router.get('/list', async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    const list = await getPlatformAuthList(userId);
    res.json({ code: 200, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询单个账号详情
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const auth = await getPlatformAuthById(id);
    if (!auth) {
      return res.status(404).json({ code: 404, message: '账号不存在' });
    }
    // 不返回 storage_state（敏感数据）
    delete auth.storage_state;
    res.json({ code: 200, data: auth });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 保存/更新账号授权（桌面端登录成功后调用）
router.post('/save', async (req, res) => {
  try {
    const { userId, platform, accountName, storageState, expiresAt, avatarUrl } = req.body;
    if (!platform || !storageState) {
      return res.status(400).json({ code: 400, message: '缺少 platform 或 storageState 参数' });
    }
    // 校验 storageState 是合法 JSON
    try {
      JSON.parse(storageState);
    } catch {
      return res.json({ code: 400, message: 'storageState 不是合法 JSON' });
    }
    const id = await savePlatformAuth({
      userId,
      platform,
      accountName,
      storageState,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      avatarUrl,
    });
    res.json({ code: 200, message: '保存成功', data: { id } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 删除账号授权
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await deletePlatformAuth(id);
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 获取账号的 storageState（桌面端"登入"已登录账号时使用，需鉴权）
router.get('/:id/storage-state', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const auth = await getPlatformAuthById(id);
    if (!auth) {
      return res.status(404).json({ code: 404, message: '账号不存在' });
    }
    res.json({ code: 200, data: { storageState: auth.storage_state, platform: auth.platform } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 更新账号每日查询限额
router.patch('/:id/daily-limit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { dailyLimit } = req.body;
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) {
      return res.json({ code: 400, message: 'dailyLimit 必须是 1-10000 之间的整数' });
    }
    await updatePlatformAuthDailyLimit(id, dailyLimit);
    res.json({ code: 200, message: '更新成功', data: { dailyLimit } });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 查询可用账号数统计
router.get('/stats/available', async (req, res) => {
  try {
    const stats = await getAvailableAuthCount();
    res.json({ code: 200, data: stats });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 手动重置账号健康状态（将 warning/danger/banned 恢复为 healthy）
router.post('/:id/reset-health', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await resetAccountHealth(id);
    res.json({ code: 200, message: '账号健康状态已重置' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
