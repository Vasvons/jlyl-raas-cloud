import { Router } from 'express';
import {
  getKeywordSearchRank,
  getKeywordCount,
  getPlatformRatio,
  getCoreKeywordRank,
  getAllPlatforms,
  getZlgjcUrlsByUserId,
  upsertZlgjcUrl,
  getZlgjcByUserId,
} from '../repository';
import { authMiddleware } from '../auth';

const router = Router();

// ⚠️ v2.2.12 已知安全债务（暂不修复，需前端配合改造）：
// 本文件大部分接口完全公开（用 ?userId=xxx 访问），是 GEO 报告 iframe 的历史遗留设计。
// 任意人传 ?userId=他人ID 即可拉到该客户的搜索排名、关键词、平台占比等数据。
// 完整修复方案：前端 GEO 报告页面改用 shareToken 替代 query.userId，
// 后端用 shareToken 解析出 userId 后再查询数据。
// 本次权限中间件统一重构暂不改动此文件，避免破坏现有分享链接功能。

// 获取平台列表
router.get('/platforms', async (req, res) => {
  try {
    const platforms = await getAllPlatforms();
    res.json({ code: 200, data: platforms });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取关键词数量统计
router.get('/keywordCount', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getKeywordCount(userId);
    res.json({
      code: 200,
      data: {
        coreCount: parseInt(data.core_count) || 0,
        distillateCount: parseInt(data.distillate_count) || 0,
        totalCount: parseInt(data.total_count) || 0,
      }
    });
  } catch (e) {
    console.error('[Dashboard] 获取关键词数量失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取平台占比
router.get('/platformRatio', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getPlatformRatio(userId);
    res.json({
      code: 200,
      data: data.map((item: any) => ({
        pt: item.pt,
        count: parseInt(item.count) || 0,
      }))
    });
  } catch (e) {
    console.error('[Dashboard] 获取平台占比失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取核心关键词排名
router.get('/coreKeywordRank', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const limit = parseInt(req.query.limit as string) || 20;
    const data = await getCoreKeywordRank(userId, limit);
    res.json({
      code: 200,
      data: data.map((item: any) => ({
        keyword: item.keyword,
        count: parseInt(item.count) || 0,
      }))
    });
  } catch (e) {
    console.error('[Dashboard] 获取核心关键词排名失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 搜索排名列表
router.get('/keypage', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getKeywordSearchRank({
      userId,
      platform: req.query.platform as string,
      keyword: req.query.keyword as string,
      type: req.query.type as string,
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 20,
    });

    res.json({
      code: 200,
      data: {
        list: data.list.map((item: any) => ({
          id: item.id,
          expandedKeyword: item.expanded_keyword,
          distillateKeyword: item.distillate_keyword,
          platform: item.platform,
          userId: item.user_id,
          queryTime: item.query_time,
          url: item.url,
          zlgjcUrl: item.source === 'real'
            ? (item.zlgjc_url || (item.id ? `/api/real-collect/results/${item.id}/page` : ''))
            : (item.zlgjc_url || ''),
          hasLxfs: item.has_lxfs === 1,
          createTime: item.create_time,
        })),
        total: data.total,
        page: data.page,
        pageSize: data.pageSize,
      }
    });
  } catch (e) {
    console.error('[Dashboard] 获取搜索排名失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取蒸馏关键词跳转链接
router.get('/zlgjcUrls', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getZlgjcUrlsByUserId(userId);
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新蒸馏关键词跳转链接
router.post('/upsertUrl', authMiddleware, async (req, res) => {
  try {
    const { zlgjcid, pt, url, hasLxfs } = req.body;
    if (!zlgjcid) return res.json({ code: 400, message: '缺少zlgjcid' });

    const id = await upsertZlgjcUrl({ zlgjcid, pt, url, hasLxfs });
    res.json({ code: 200, data: { id }, message: '保存成功' });
  } catch (e) {
    console.error('[Dashboard] 保存跳转链接失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取蒸馏关键词库
router.get('/zlgjcList', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getZlgjcByUserId(userId);
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
