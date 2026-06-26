import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import { query } from '../db';
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

// 手动触发清理无效记录（preview=true 只统计不删除，confirm=true 执行删除）
// 清理标准：raw_content < 200 字符，或包含营销页/导航特征文案
router.post('/cleanup-invalid', async (req, res) => {
  try {
    const confirm = req.body.confirm === true;

    const statsResult = await query(`
      SELECT
        COUNT(*) as total_to_delete,
        COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) < 200) as short_content,
        COUNT(*) FILTER (WHERE raw_content LIKE '%登录%' AND raw_content LIKE '%注册%') as marketing_nav,
        COUNT(*) FILTER (WHERE raw_content LIKE '%开始对话%' OR raw_content LIKE '%开始使用%' OR raw_content LIKE '%免费体验%' OR raw_content LIKE '%立即开通%') as marketing_cta,
        COUNT(*) FILTER (WHERE raw_content LIKE '%全部对话%' OR raw_content LIKE '%历史记录%' OR raw_content LIKE '%清空对话%') as sidebar_nav,
        COUNT(*) as total_remaining
      FROM real_collect_record
      WHERE COALESCE(LENGTH(raw_content), 0) < 200
         OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
         OR raw_content LIKE '%开始对话%'
         OR raw_content LIKE '%开始使用%'
         OR raw_content LIKE '%免费体验%'
         OR raw_content LIKE '%立即开通%'
         OR raw_content LIKE '%全部对话%'
         OR raw_content LIKE '%历史记录%'
         OR raw_content LIKE '%清空对话%'
    `);
    const stats = statsResult.rows[0];

    const totalRemainingResult = await query(`SELECT COUNT(*) as total FROM real_collect_record`);
    const totalBefore = parseInt(totalRemainingResult.rows[0].total);

    if (!confirm) {
      return res.json({
        code: 200,
        data: {
          totalBefore: totalBefore,
          totalToDelete: parseInt(stats.total_to_delete),
          breakdown: {
            shortContent: parseInt(stats.short_content),
            marketingNav: parseInt(stats.marketing_nav),
            marketingCta: parseInt(stats.marketing_cta),
            sidebarNav: parseInt(stats.sidebar_nav),
          },
          totalAfter: totalBefore - parseInt(stats.total_to_delete),
          message: '预览模式，未执行删除。传入 confirm=true 执行删除。'
        }
      });
    }

    const deleteResult = await query(`
      DELETE FROM real_collect_record
      WHERE COALESCE(LENGTH(raw_content), 0) < 200
         OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
         OR raw_content LIKE '%开始对话%'
         OR raw_content LIKE '%开始使用%'
         OR raw_content LIKE '%免费体验%'
         OR raw_content LIKE '%立即开通%'
         OR raw_content LIKE '%全部对话%'
         OR raw_content LIKE '%历史记录%'
         OR raw_content LIKE '%清空对话%'
    `);
    const deleted = deleteResult.rowCount || 0;

    const totalAfterResult = await query(`SELECT COUNT(*) as total FROM real_collect_record`);
    const totalAfter = parseInt(totalAfterResult.rows[0].total);

    console.log(`[Cleanup] 手动清理完成: 删除 ${deleted} 条, 剩余 ${totalAfter} 条`);
    res.json({
      code: 200,
      data: {
        deleted: deleted,
        totalBefore: totalBefore,
        totalAfter: totalAfter,
      }
    });
  } catch (e: any) {
    console.error('[Cleanup] 清理失败:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});

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
