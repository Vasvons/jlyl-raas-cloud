import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  getPPByUserId, insertPP, deletePP,
  getDistillateKeywordsByPage, insertDistillateKeyword, deleteDistillateKeyword,
  getZlgjcByPage, deleteZlgjc, generateZlgjcKeywords,
  getKeywordMaintenanceList, insertZlgjcUrl, updateZlgjcUrl,
  clearKeywordData, getAllPlatforms,
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

export default router;
