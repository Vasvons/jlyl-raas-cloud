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

// 手动触发清理无效记录
// mode: 'conservative' - raw_content < 200 或包含营销关键词（默认）
// mode: 'aggressive' - 额外清理 content > 5000 字符（疑似整页文本）或 brand_matched=false 且有 static_page_id
// mode: 'invalid_share' - 清理 share_url 是私有对话URL（非真正分享链接）的记录
// mode: 'non_match' - 清理既未命中品牌也无联系方式的记录（brand_matched=false AND has_contact=false）
// mode: 'all' - 删除全部 real_collect_record（用户确认实际命中很少时可全清重跑）
router.post('/cleanup-invalid', async (req, res) => {
  try {
    const mode = req.body.mode || 'conservative';
    const confirm = req.body.confirm === true;

    let whereClause = '';
    let description = '';

    if (mode === 'all') {
      whereClause = '1=1';
      description = '删除全部记录';
    } else if (mode === 'non_match') {
      // 清理既未命中品牌也无联系方式的记录
      // 这些记录对用户无用，且 share_url 可能是空对话或静态页内容不完整
      whereClause = `brand_matched = false AND has_contact = false`;
      description = '清理非品牌命中且无联系方式的记录';
    } else if (mode === 'invalid_share') {
      // 清理 share_url 是私有对话URL的记录
      // 真正的分享链接格式：
      //   DeepSeek:  https://chat.deepseek.com/a/chat/s/{uuid}（含 /s/）
      //   智谱:      https://chatglm.cn/share/{短码}（含 /share/）
      //   Kimi:      https://www.kimi.com/share/{shareId}（含 /share/）
      //   通义千问:  https://tongyi.aliyun.com/qianwen/share?shareId={UUID}（含 shareId=）
      // 私有对话URL（需登录才能访问，非分享链接）：
      //   DeepSeek:  https://chat.deepseek.com/c/{id} 或 /a/chat/{id}（不含 /s/）
      //   豆包:      https://www.doubao.com/chat/{数字ID}（对话URL，非分享URL）
      //   元宝:      https://yuanbao.tencent.com/chat/{id}（对话URL，非分享URL）
      //   智谱:      https://chatglm.cn/chat/{id}（对话URL，非分享URL）
      //   文心:      https://wenxin.baidu.com/chat/{id}（对话URL，非分享URL）
      //   Kimi:      https://www.kimi.com/chat/{id}（对话URL，非分享URL）
      whereClause = `share_url IS NOT NULL
        AND share_url NOT LIKE '%/share/%'
        AND share_url NOT LIKE '%/s/%'
        AND share_url NOT LIKE '%shareId=%'
        AND share_url NOT LIKE '%/artifactShare/%'`;
      description = '清理私有对话URL（非真正分享链接）的记录';
    } else if (mode === 'aggressive') {
      // 激进模式：额外清理
      // 1. content > 5000 字符（真实 AI 回答一般不超过 5000，超过说明是整页文本）
      // 2. brand_matched=false 且 has_contact=false 且 static_page_id IS NOT NULL
      //    （非命中记录但有静态页，说明是营销页内容生成的静态页）
      // 3. content > 2000 且 share_url IS NOT NULL 且 brand_matched=false
      //    （有分享链接但未命中品牌，且内容过长，可能是空对话+整页文本）
      whereClause = `COALESCE(LENGTH(raw_content), 0) < 200
         OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
         OR raw_content LIKE '%开始对话%'
         OR raw_content LIKE '%开始使用%'
         OR raw_content LIKE '%免费体验%'
         OR raw_content LIKE '%立即开通%'
         OR raw_content LIKE '%全部对话%'
         OR raw_content LIKE '%历史记录%'
         OR raw_content LIKE '%清空对话%'
         OR COALESCE(LENGTH(raw_content), 0) > 5000
         OR (brand_matched = false AND has_contact = false AND static_page_id IS NOT NULL)
         OR (COALESCE(LENGTH(raw_content), 0) > 2000 AND share_url IS NOT NULL AND brand_matched = false)`;
      description = '激进清理（短内容/营销关键词/超长内容/非命中静态页/非命中分享链接）';
    } else {
      // 保守模式
      whereClause = `COALESCE(LENGTH(raw_content), 0) < 200
         OR (raw_content LIKE '%登录%' AND raw_content LIKE '%注册%')
         OR raw_content LIKE '%开始对话%'
         OR raw_content LIKE '%开始使用%'
         OR raw_content LIKE '%免费体验%'
         OR raw_content LIKE '%立即开通%'
         OR raw_content LIKE '%全部对话%'
         OR raw_content LIKE '%历史记录%'
         OR raw_content LIKE '%清空对话%'`;
      description = '保守清理（短内容/营销关键词）';
    }

    const totalBeforeResult = await query(`SELECT COUNT(*) as total FROM real_collect_record`);
    const totalBefore = parseInt(totalBeforeResult.rows[0].total);

    const statsResult = await query(`
      SELECT
        COUNT(*) as total_to_delete,
        COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) < 200) as short_content,
        COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) > 5000) as long_content,
        COUNT(*) FILTER (WHERE brand_matched = false AND has_contact = false AND static_page_id IS NOT NULL) as non_match_static,
        COUNT(*) FILTER (WHERE COALESCE(LENGTH(raw_content), 0) > 2000 AND share_url IS NOT NULL AND brand_matched = false) as non_match_share
      FROM real_collect_record
      WHERE ${whereClause}
    `);
    const stats = statsResult.rows[0];

    if (!confirm) {
      return res.json({
        code: 200,
        data: {
          mode: mode,
          description: description,
          totalBefore: totalBefore,
          totalToDelete: parseInt(stats.total_to_delete),
          breakdown: {
            shortContent: parseInt(stats.short_content),
            longContent: parseInt(stats.long_content),
            nonMatchStatic: parseInt(stats.non_match_static),
            nonMatchShare: parseInt(stats.non_match_share),
          },
          totalAfter: totalBefore - parseInt(stats.total_to_delete),
          message: '预览模式，未执行删除。传入 confirm=true 执行删除。'
        }
      });
    }

    const deleteResult = await query(`DELETE FROM real_collect_record WHERE ${whereClause}`);
    const deleted = deleteResult.rowCount || 0;

    const totalAfterResult = await query(`SELECT COUNT(*) as total FROM real_collect_record`);
    const totalAfter = parseInt(totalAfterResult.rows[0].total);

    console.log(`[Cleanup] ${description}: 删除 ${deleted} 条, 剩余 ${totalAfter} 条`);
    res.json({
      code: 200,
      data: {
        mode: mode,
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
    const { userId, platform, keywordType, brandMatched, startTime, endTime, pageNum, pageSize } = req.query;
    const result = await getRealCollectRecords({
      userId: userId as string | undefined,
      platform: platform as string | undefined,
      keywordType: keywordType ? parseInt(keywordType as string) : undefined,
      // v2.1.5：支持 brand_matched 过滤
      brandMatched: brandMatched !== undefined ? brandMatched === 'true' : undefined,
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
