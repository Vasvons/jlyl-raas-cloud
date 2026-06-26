import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import {
  getRealCollectRecords,
  getRealCollectRecordById,
  deleteRealCollectRecord,
  getStaticPageByRecordId
} from '../repository';
import { processWorkerResult } from '../services/realCollect/resultProcessor';

const router = Router();

// 公开接口：静态页HTML(不需要鉴权)
router.get('/:id/page', async (req, res) => {
  try {
    const record = await getRealCollectRecordById(parseInt(req.params.id));
    if (!record) {
      return res.status(404).send('记录不存在');
    }
    const html = await getStaticPageByRecordId(record.id);
    if (!html) {
      return res.status(404).send('静态页不存在');
    }
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

// 公开接口：Worker回写结果(不需要鉴权，由内部调用)
router.post('/worker/report', async (req, res) => {
  try {
    const processResult = await processWorkerResult(req.body);
    // 内容无效时 processResult 为 null（如内容过短、AI 未回答等）
    if (!processResult) {
      res.json({
        code: 200,
        message: 'ok',
        data: {
          brandMatched: false,
          matchedBrands: [],
          hasContact: false,
          recordId: 0,
          skipped: true,
        }
      });
      return;
    }
    // 返回品牌识别结果，让 Worker 端日志能区分是否识别到品牌
    res.json({
      code: 200,
      message: 'ok',
      data: {
        brandMatched: processResult.brandMatched,
        matchedBrands: processResult.matchedBrands,
        hasContact: processResult.hasContact,
        recordId: processResult.recordId
      }
    });
  } catch (e: any) {
    console.error('[RealCollect] Worker结果回写失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 以下接口需要管理员权限
router.use(authMiddleware, adminMiddleware);

router.get('/', async (req, res) => {
  try {
    const { userId, platform, keywordType, startTime, endTime, pageNum, pageSize } = req.query;
    const result = await getRealCollectRecords({
      userId: userId as string | undefined,
      platform: platform as string | undefined,
      keywordType: keywordType ? parseInt(keywordType as string) : undefined,
      startTime: startTime ? new Date(startTime as string) : undefined,
      endTime: endTime ? new Date(endTime as string) : undefined,
      pageNum: pageNum ? parseInt(pageNum as string) : 1,
      pageSize: pageSize ? parseInt(pageSize as string) : 20
    });
    res.json({ code: 200, data: result });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const record = await getRealCollectRecordById(parseInt(req.params.id));
    if (!record) {
      return res.status(404).json({ code: 404, message: '记录不存在' });
    }
    res.json({ code: 200, data: record });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteRealCollectRecord(parseInt(req.params.id));
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

export default router;
