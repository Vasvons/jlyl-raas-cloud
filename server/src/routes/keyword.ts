import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import { query } from '../db';
import {
  getPPByUserId, insertPP, deletePP,
  getDistillateKeywordsByPage, insertDistillateKeyword, deleteDistillateKeyword,
  getZlgjcByPage, deleteZlgjc, generateZlgjcKeywords,
  getKeywordMaintenanceList, insertZlgjcUrl, updateZlgjcUrl,
  clearKeywordData, getAllPlatforms,
  // 兼容 GEO 报告页面旧路径的函数
  getKeywordSearchRank, getKeywordCount, getPlatformRatio, getCoreKeywordRank,
} from '../repository';

const router = Router();

// ============ 品牌关键词 ============
router.get('/pp/list', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const data = await getPPByUserId(userId);
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/pp/add', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, pp } = req.body;
    const id = await insertPP(String(userId), pp);
    res.json({ code: 200, data: { id } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/pp/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await deletePP(parseInt(req.params.id));
    res.json({ code: 200 });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 核心关键词（distillate_keyword）============
router.get('/dstillateKeyword/getAllDstillateKeyword', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const pageNum = parseInt(req.query.pageNum as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 9999999;
    const result = await getDistillateKeywordsByPage(userId, pageNum, pageSize);
    res.json({ code: 200, data: result });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/dstillateKeyword/insertDstillateKeyword', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, distillateKeyword } = req.body;
    const id = await insertDistillateKeyword(String(userId), distillateKeyword);
    res.json({ code: 200, data: { id } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/dstillateKeyword/deleteDstillateKeyword', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await deleteDistillateKeyword(parseInt(req.query.id as string));
    res.json({ code: 200 });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 蒸馏关键词生成 ============
router.post('/keywordsearchrank/generate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { A, B, C, D, E, F, G, userId } = req.body;
    const result = await generateZlgjcKeywords(String(userId), { A, B, C, D, E, F, G });
    res.json({ code: 200, data: result });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 蒸馏关键词库（zlgjc）============
router.get('/zlgjc/select', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const pageNum = parseInt(req.query.pageNum as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 10;
    const result = await getZlgjcByPage(userId, pageNum, pageSize);
    res.json({ code: 200, data: result });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/zlgjc/delete/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await deleteZlgjc(parseInt(req.params.id));
    res.json({ code: 200 });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/zlgjc/platforms', async (req, res) => {
  try {
    const data = await getAllPlatforms();
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 关键词维护 ============
router.get('/zlgjc/maintenanceList', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getKeywordMaintenanceList({
      userId: req.query.userId as string,
      platform: req.query.pt as string,
      pageNum: parseInt(req.query.pageNum as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 20,
      keyword: req.query.keyword as string,
    });
    res.json({ code: 200, data: result });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/zlgjc/updateUrl', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id, url, hasLxfs } = req.body;
    await updateZlgjcUrl(parseInt(id), url, hasLxfs);
    res.json({ code: 200 });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/zlgjc/insertUrl', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { zlgjcid, pt, url, hasLxfs } = req.body;
    const id = await insertZlgjcUrl({ zlgjcid: parseInt(zlgjcid), pt, url, hasLxfs });
    res.json({ code: 200, data: { id } });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 数据清零 ============
router.post('/data/clear', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type, userId } = req.body;
    if (type === 'keyword') {
      const cleared = await clearKeywordData(userId);
      res.json({ code: 200, data: { cleared } });
    } else {
      res.json({ code: 400, message: '不支持的清零类型' });
    }
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 平台列表 ============
router.get('/pt/list', async (req, res) => {
  try {
    const data = await getAllPlatforms();
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ============ 兼容 GEO 报告页面旧路径 ============
// 前端 dashboard 页面使用旧路径，这里提供兼容路由

// 搜索排名列表（兼容 /keywordsearchrank/keypage）
router.get('/keywordsearchrank/keypage', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getKeywordSearchRank({
      userId,
      platform: req.query.pt as string,
      keyword: req.query.keyword as string,
      type: req.query.type as string,
      page: parseInt(req.query.pageNum as string) || 1,
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
          zlgjcUrl: item.zlgjc_url || '',
          hasLxfs: item.has_lxfs === 1,
          createTime: item.create_time,
        })),
        total: data.total,
        page: data.page,
        pageSize: data.pageSize,
      }
    });
  } catch (e) {
    console.error('[Keyword] 获取搜索排名失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 平台占比（兼容 /keywordsearchrank/platformRatio）
router.get('/keywordsearchrank/platformRatio', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getPlatformRatio(userId);
    res.json({
      code: 200,
      data: data.map((item: any) => ({
        platform: item.pt,
        count: parseInt(item.count) || 0,
      }))
    });
  } catch (e) {
    console.error('[Keyword] 获取平台占比失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 核心关键词排名（兼容 /keywordsearchrank/keywordcound）
router.get('/keywordsearchrank/keywordcound', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    const data = await getCoreKeywordRank(userId, 20);
    res.json({
      code: 200,
      data: data.map((item: any) => ({
        distillateKeyword: item.keyword,
        count: parseInt(item.count) || 0,
      }))
    });
  } catch (e) {
    console.error('[Keyword] 获取核心关键词排名失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 关键词数量统计（兼容 /dstillateKeyword/countDstillateKeyword）
router.get('/dstillateKeyword/countDstillateKeyword', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.json({ code: 400, message: '缺少userId' });

    // 核心关键词数（distillate_keyword 表）
    const coreResult = await query(
      'SELECT COUNT(*) as count FROM distillate_keyword WHERE user_id = $1', [userId]
    );
    const coreCount = parseInt(coreResult.rows[0].count) || 0;

    // 蒸馏关键词数（zlgjc 表）
    const zlgjcResult = await query(
      'SELECT COUNT(*) as count FROM zlgjc WHERE userid = $1', [userId]
    );
    const zlgjcCount = parseInt(zlgjcResult.rows[0].count) || 0;

    // 品牌关键词数（pp 表）
    const ppResult = await query(
      'SELECT COUNT(*) as count FROM pp WHERE user_id = $1', [userId]
    );
    const ppCount = parseInt(ppResult.rows[0].count) || 0;

    // 总收录条数（keyword_search_rank 表）
    const totalResult = await query(
      'SELECT COUNT(*) as count FROM keyword_search_rank WHERE user_id = $1', [userId]
    );
    const totalCount = parseInt(totalResult.rows[0].count) || 0;

    res.json({
      code: 200,
      data: {
        count: coreCount,
        zlgjc: zlgjcCount,
        ppgjc: ppCount,
        total: totalCount,
      }
    });
  } catch (e) {
    console.error('[Keyword] 获取关键词数量失败:', e);
    res.json({ code: 500, message: '服务器错误' });
  }
});

export default router;
