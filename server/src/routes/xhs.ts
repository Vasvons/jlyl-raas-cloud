/**
 * 小红书运营大师板块路由（XHS_MASTER_PLAN）
 *
 * 职责：
 *  - 笔记（xhs_note_meta + article）读写
 *  - 创建小红书发布任务（内部复用 createPublishTask，不复制发布链路）
 *  - 封面模板 CRUD（内置模板只读）
 *  - 生图（调 services/xhs/xhsImageGenerator，写 xhs_image）
 *  - 发布台账 + 数据看板聚合（仅平台内自有数据，无小红书后台抓取）
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth';
import {
  getXhsNotes, getXhsNoteDetail, getXhsNoteMeta, upsertXhsNoteMeta, updateArticleCoverImage,
  getXhsCoverTemplates, getXhsCoverTemplateById, createXhsCoverTemplate,
  updateXhsCoverTemplate, deleteXhsCoverTemplate,
  getXhsPublishTasks,
  getXhsDashboardOverview, getXhsDashboardByAccount, getXhsDashboardByTime,
  createPublishTask,
  getXhsWritingInstructions, getXhsWritingInstructionById,
  createXhsWritingInstruction, updateXhsWritingInstruction, deleteXhsWritingInstruction,
  createWritingTask,
  getXhsCustomers, getXhsCustomerById, createXhsCustomer, updateXhsCustomer, deleteXhsCustomer, countXhsCustomerRefs,
  getXhsKnowledges, getXhsKnowledgeById, createXhsKnowledge, updateXhsKnowledge, deleteXhsKnowledge, countXhsKnowledgeRefs,
  getXhsImages, getXhsImageById, createXhsImage, updateXhsImage, deleteXhsImage,
} from '../repository';

const router = Router();
router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

// ==================== 小红书客户 ====================

/** 是否管理员（可显式查看指定运营者的客户） */
function isAdminUser(req: any): boolean {
  const u = req.user || {};
  return u.level === '1' || u.role === 'admin' || u.role === 'super_admin';
}

/** 解析目标 owner（默认自己；管理员可传 ?owner_user_id=） */
function resolveOwnerId(req: any): number {
  const self = getUserId(req);
  if (isAdminUser(req) && req.query.owner_user_id) {
    const n = Number(req.query.owner_user_id);
    if (n > 0) return n;
  }
  return self;
}

/** GET /xhs/customers —— 我的客户列表（带知识库数 / 笔记数） */
router.get('/customers', async (req: Request, res: Response) => {
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const rows = await getXhsCustomers(resolveOwnerId(req), includeInactive);
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Xhs] 客户列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/customers —— 新建客户 */
router.post('/customers', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ code: 400, message: '缺少客户名称' });
    }
    // v2.12.0 P4：客户不再有「主推账号类型」——蓝V官号/种草达人由账号池区分（见 platform_auth.xhs_account_type）
    const id = await createXhsCustomer({
      owner_user_id: uid,
      name: String(b.name).trim(),
      contact_name: b.contact_name,
      contact_phone: b.contact_phone,
      contact_wechat: b.contact_wechat,
      city: b.city,
      industry: b.industry,
      remark: b.remark,
    });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[Xhs] 新建客户失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /xhs/customers/:id —— 更新客户 */
router.put('/customers/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const affected = await updateXhsCustomer(id, getUserId(req), req.body || {});
    if (affected === 0) return res.status(404).json({ code: 404, message: '客户不存在或无权修改' });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    console.error('[Xhs] 更新客户失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** DELETE /xhs/customers/:id —— 删除客户（有关联知识库/笔记时拒绝） */
router.delete('/customers/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const uid = getUserId(req);
    const customer = await getXhsCustomerById(id);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在或无权删除' });
    }
    const refs = await countXhsCustomerRefs(id);
    if (refs.knowledge > 0 || refs.notes > 0) {
      return res.status(400).json({
        code: 400,
        message: `该客户下还有 ${refs.knowledge} 个知识库、${refs.notes} 篇笔记，请先删除或转移后再删除客户`,
      });
    }
    const affected = await deleteXhsCustomer(id, uid);
    if (affected === 0) return res.status(404).json({ code: 404, message: '客户不存在或无权删除' });
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Xhs] 删除客户失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 小红书企业知识库 ====================

/** GET /xhs/knowledge?xhs_customer_id= —— 某客户的知识库列表 */
router.get('/knowledge', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const customerId = Number(req.query.xhs_customer_id);
    if (!customerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    const customer = await getXhsCustomerById(customerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }
    const rows = await getXhsKnowledges(customerId);
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Xhs] 知识库列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/knowledge —— 新建知识库 */
router.post('/knowledge', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    const customerId = Number(b.xhs_customer_id);
    if (!customerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    if (!b.company_full_name || !String(b.company_full_name).trim()) {
      return res.status(400).json({ code: 400, message: '缺少企业全称' });
    }
    const customer = await getXhsCustomerById(customerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }
    const id = await createXhsKnowledge({ ...b, xhs_customer_id: customerId, owner_user_id: uid });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[Xhs] 新建知识库失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /xhs/knowledge/:id —— 更新知识库 */
router.put('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const affected = await updateXhsKnowledge(Number(req.params.id), getUserId(req), req.body || {});
    if (affected === 0) return res.status(404).json({ code: 404, message: '知识库不存在或无权修改' });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    console.error('[Xhs] 更新知识库失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** DELETE /xhs/knowledge/:id —— 删除知识库（有图库/任务引用时拒绝） */
router.delete('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const uid = getUserId(req);
    const kb = await getXhsKnowledgeById(id);
    if (!kb || Number(kb.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '知识库不存在或无权删除' });
    }
    const refs = await countXhsKnowledgeRefs(id);
    if (refs.images > 0 || refs.tasks > 0) {
      return res.status(400).json({
        code: 400,
        message: `该知识库下还有 ${refs.images} 张图片、${refs.tasks} 个写作任务，请先清理后再删除`,
      });
    }
    const affected = await deleteXhsKnowledge(id, uid);
    if (affected === 0) return res.status(404).json({ code: 404, message: '知识库不存在或无权删除' });
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Xhs] 删除知识库失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 小红书图库 ====================

/** GET /xhs/images?xhs_customer_id=&xhs_knowledge_id=&image_type= */
router.get('/images', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const customerId = Number(req.query.xhs_customer_id);
    if (!customerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    const customer = await getXhsCustomerById(customerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }
    const knowledgeId = req.query.xhs_knowledge_id ? Number(req.query.xhs_knowledge_id) : undefined;
    const imageType = req.query.image_type ? String(req.query.image_type) : undefined;
    const rows = await getXhsImages(customerId, knowledgeId, imageType);
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Xhs] 图库列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/images —— 登记已上传到 OSS 的图片 */
router.post('/images', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    const customerId = Number(b.xhs_customer_id);
    if (!customerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    if (!b.url || !b.image_type) return res.status(400).json({ code: 400, message: 'url 和 image_type 必填' });
    if (!['cover', 'illustration'].includes(String(b.image_type))) {
      return res.status(400).json({ code: 400, message: 'image_type 必须是 cover 或 illustration' });
    }
    const customer = await getXhsCustomerById(customerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }
    const id = await createXhsImage({ ...b, xhs_customer_id: customerId, owner_user_id: uid });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[Xhs] 图片登记失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /xhs/images/:id */
router.put('/images/:id', async (req: Request, res: Response) => {
  try {
    const affected = await updateXhsImage(Number(req.params.id), getUserId(req), req.body || {});
    if (affected === 0) return res.status(404).json({ code: 404, message: '图片不存在或无权修改' });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    console.error('[Xhs] 更新图片失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** DELETE /xhs/images/:id（只删库记录，不删 OSS 对象） */
router.delete('/images/:id', async (req: Request, res: Response) => {
  try {
    const affected = await deleteXhsImage(Number(req.params.id), getUserId(req));
    if (affected === 0) return res.status(404).json({ code: 404, message: '图片不存在或无权删除' });
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Xhs] 删除图片失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 小红书写作指令 ====================

/** GET /xhs/instructions —— 平台预设（user_id IS NULL）+ 本人自建 */
router.get('/instructions', async (req: Request, res: Response) => {
  try {
    const onlyActive = String(req.query.onlyActive || '') === '1';
    const rows = await getXhsWritingInstructions(getUserId(req), onlyActive);
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Xhs] 指令列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/instructions —— 新建本人指令 */
router.post('/instructions', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ code: 400, message: '缺少 name' });
    if (!['brand', 'creator'].includes(String(b.account_type))) {
      return res.status(400).json({ code: 400, message: 'account_type 仅支持 brand / creator' });
    }
    if (!b.title_prompt) return res.status(400).json({ code: 400, message: '缺少 title_prompt' });
    if (!b.body_prompt) return res.status(400).json({ code: 400, message: '缺少 body_prompt' });
    const id = await createXhsWritingInstruction({
      user_id: uid,
      name: String(b.name),
      account_type: String(b.account_type),
      note_style: b.note_style,
      title_prompt: String(b.title_prompt),
      body_prompt: String(b.body_prompt),
      cover_text_prompt: b.cover_text_prompt,
      topic_prompt: b.topic_prompt,
      image_script_prompt: b.image_script_prompt,
      target_word_count: b.target_word_count != null ? Number(b.target_word_count) : undefined,
      emoji_level: b.emoji_level,
      require_drawback: b.require_drawback === undefined ? undefined : !!b.require_drawback,
      include_image_script: b.include_image_script === undefined ? undefined : !!b.include_image_script,
    });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[Xhs] 新建指令失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /xhs/instructions/:id —— 更新（预设指令 403） */
router.put('/instructions/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const exists = await getXhsWritingInstructionById(id);
    if (!exists) return res.status(404).json({ code: 404, message: '指令不存在' });
    if (exists.user_id === null) {
      return res.status(403).json({ code: 403, message: '平台预设指令不可修改，请复制为自定义指令' });
    }
    const affected = await updateXhsWritingInstruction(id, getUserId(req), req.body || {});
    if (affected === 0) return res.status(404).json({ code: 404, message: '指令不存在或无权修改' });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    console.error('[Xhs] 更新指令失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** DELETE /xhs/instructions/:id —— 删除（预设指令 403） */
router.delete('/instructions/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const exists = await getXhsWritingInstructionById(id);
    if (!exists) return res.status(404).json({ code: 404, message: '指令不存在' });
    if (exists.user_id === null) return res.status(403).json({ code: 403, message: '平台预设指令不可删除' });
    const affected = await deleteXhsWritingInstruction(id, getUserId(req));
    if (affected === 0) return res.status(404).json({ code: 404, message: '指令不存在或无权删除' });
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Xhs] 删除指令失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 笔记 ====================

/** GET /xhs/notes —— 笔记列表（按运营者 + 可选按小红书客户过滤） */
router.get('/notes', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const xhsCustomerId = req.query.xhs_customer_id ? Number(req.query.xhs_customer_id) : null;
    const data = await getXhsNotes(uid, page, pageSize, xhsCustomerId);
    res.json({ code: 200, data });
  } catch (e: any) {
    console.error('[Xhs] 笔记列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** GET /xhs/notes/:id —— 笔记详情 */
router.get('/notes/:id', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const note = await getXhsNoteDetail(Number(req.params.id));
    if (!note) return res.status(404).json({ code: 404, message: '笔记不存在' });
    if (Number(note.user_id) !== uid) return res.status(403).json({ code: 403, message: '无权访问该笔记' });
    res.json({ code: 200, data: note });
  } catch (e: any) {
    console.error('[Xhs] 笔记详情失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/**
 * PUT /xhs/notes/:id —— 更新笔记元数据
 * Body: { note_style?, cover_template_id?, cover_title?, cover_image_id?, image_ids?, topics?, cover_image_url? }
 * - cover_image_url 为封面合成产物：同时回写 article.cover_image_url（发布时用的就是它）
 *   并把该图登记进 xhs_image（source='compose'，image_type='cover'），返回的 id 写入 cover_image_id
 */
router.put('/notes/:id', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const articleId = Number(req.params.id);
    const meta = await getXhsNoteMeta(articleId);
    if (!meta) return res.status(404).json({ code: 404, message: '笔记不存在' });
    if (Number(meta.user_id) !== uid) return res.status(403).json({ code: 403, message: '无权修改该笔记' });

    const body = req.body || {};
    let coverImageId: number | undefined;

    // 封面合成产物：登记小红书图库 + 回写 article.cover_image_url
    // v3.z：登记目标由 image_library 改为 xhs_image（cover_image_id 语义随 P4 变更见 spec §3.4）
    if (typeof body.cover_image_url === 'string' && body.cover_image_url.trim()) {
      const coverImageUrl = body.cover_image_url.trim();
      const detail = await getXhsNoteDetail(articleId);
      const xhsCustomerId = detail?.xhs_customer_id != null
        ? Number(detail.xhs_customer_id)
        : (meta.xhs_customer_id != null ? Number(meta.xhs_customer_id) : null);
      const xhsKnowledgeId = detail?.xhs_knowledge_id != null ? Number(detail.xhs_knowledge_id) : null;
      // 历史笔记无客户归属（xhs_customer_id 为 NULL）时无法写入独立图库：仅回写封面 URL，不报错
      if (xhsCustomerId) {
        coverImageId = await createXhsImage({
          xhs_customer_id: xhsCustomerId,
          xhs_knowledge_id: xhsKnowledgeId,
          owner_user_id: uid,
          image_type: 'cover',
          url: coverImageUrl,
          file_path: null,
          original_name: `xhs-cover-${articleId}.png`,
          description: typeof body.cover_title === 'string' ? body.cover_title.slice(0, 200) : null,
          tags: [],
          sort_order: 0,
          source: 'compose',
          prompt: null,
        });
      }
      await updateArticleCoverImage(articleId, coverImageUrl);
    }

    await upsertXhsNoteMeta(articleId, uid, {
      note_style: body.note_style,
      cover_template_id: body.cover_template_id,
      cover_title: body.cover_title,
      cover_image_id: coverImageId ?? body.cover_image_id,
      image_ids: Array.isArray(body.image_ids) ? body.image_ids.map((x: any) => Number(x)) : undefined,
      topics: Array.isArray(body.topics) ? body.topics.map((x: any) => String(x)) : undefined,
    });

    const updated = await getXhsNoteDetail(articleId);
    res.json({ code: 200, data: updated });
  } catch (e: any) {
    console.error('[Xhs] 更新笔记失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/notes/:id/publish —— 创建小红书发布任务（内部复用 createPublishTask） */
router.post('/notes/:id/publish', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const articleId = Number(req.params.id);
    const meta = await getXhsNoteMeta(articleId);
    if (!meta) return res.status(404).json({ code: 404, message: '笔记不存在' });
    if (Number(meta.user_id) !== uid) return res.status(403).json({ code: 403, message: '无权发布该笔记' });

    const scheduledAtRaw = req.body?.scheduled_at;
    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : undefined;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ code: 400, message: 'scheduled_at 格式无效' });
    }

    const result = await createPublishTask({
      user_id: uid,
      article_id: articleId,
      target_platforms: ['xhs'],
      scheduled_at: scheduledAt,
    });
    res.json({ code: 200, data: result });
  } catch (e: any) {
    console.error('[Xhs] 创建发布任务失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/**
 * POST /xhs/notes/generate —— 创建小红书图文写作任务（独立内核，异步执行）
 * Body: { instruction_id, xhs_customer_id, xhs_knowledge_id, creation_mode?: 'smart'|'keyword',
 *         topics?: XhsPlannedTopic[], keywords?: string[], article_count?, task_name?,
 *         cover_image_mode?, cover_image_id?, illustration_count?, model_config_id? }
 * 与既有路由无冲突：现有 POST 路由是 /notes/:id/publish（3 段），本路由是 /notes/generate（2 段），
 * 且 Path 为字面量不参与 :id 匹配，因此注册位置不影响匹配。
 */
router.post('/notes/generate', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    const instructionId = Number(b.instruction_id);
    if (!instructionId) return res.status(400).json({ code: 400, message: '缺少 instruction_id' });
    const inst = await getXhsWritingInstructionById(instructionId);
    if (!inst) return res.status(404).json({ code: 404, message: '写作指令不存在' });
    if (inst.user_id !== null && Number(inst.user_id) !== uid) {
      return res.status(403).json({ code: 403, message: '无权使用该写作指令' });
    }
    const xhsCustomerId = Number(b.xhs_customer_id);
    if (!xhsCustomerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    const customer = await getXhsCustomerById(xhsCustomerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }

    const xhsKnowledgeId = Number(b.xhs_knowledge_id);
    if (!xhsKnowledgeId) return res.status(400).json({ code: 400, message: '缺少 xhs_knowledge_id' });
    const knowledge = await getXhsKnowledgeById(xhsKnowledgeId);
    if (!knowledge || Number(knowledge.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '知识库不存在' });
    }

    // 选题：smart 模式来自 /xhs/topics/plan 的用户确认结果；keyword 模式走关键词
    const rawTopics: any[] = Array.isArray(b.topics) ? b.topics : [];
    const creationMode = String(b.creation_mode || (rawTopics.length > 0 ? 'smart' : 'keyword'));
    const rawKeywords: string[] = Array.isArray(b.keywords)
      ? b.keywords.map((s: any) => String(s || '').trim()).filter(Boolean)
      : [];
    if (creationMode === 'smart' && rawTopics.length === 0) {
      return res.status(400).json({ code: 400, message: '智能选题模式请先确认选题' });
    }
    if (creationMode !== 'smart' && rawKeywords.length === 0) {
      return res.status(400).json({ code: 400, message: '请至少填写 1 个关键词' });
    }
    const articleCount = Math.min(
      100,
      Math.max(1, Number(b.article_count) || (rawTopics.length || rawKeywords.length || 1)),
    );

    // 关键词文本 → keyword_ids（复用既有查/建逻辑）
    const { getKeywordIdsByValues } = await import('../repository');
    const keywordIds = rawKeywords.length > 0 ? await getKeywordIdsByValues(uid, rawKeywords) : [];

    const taskId = await createWritingTask({
      user_id: uid,
      task_name: b.task_name || `小红书笔记-${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
      keyword_ids: keywordIds,
      instruction_id: null,            // 小红书不使用 GEO 指令
      xhs_instruction_id: instructionId,
      writing_system: 'xhs',
      knowledge_id: null,              // GEO 知识库列保持 NULL
      xhs_customer_id: xhsCustomerId,
      xhs_knowledge_id: xhsKnowledgeId,
      xhs_topics: creationMode === 'smart' ? rawTopics.slice(0, articleCount) : [],
      model_config_id: b.model_config_id || null,
      total_count: articleCount,
      cover_image_mode: b.cover_image_mode || 'random',
      cover_image_id: b.cover_image_id || null,
      illustration_count: Number(b.illustration_count) || 0,
      target_platforms: ['xhs'],
    });

    // 异步执行（不阻塞响应）
    const { executeWritingTask } = await import('../services/content/articleGenerator');
    executeWritingTask(taskId, uid).catch((e: any) => {
      console.error(`[Xhs] 任务 ${taskId} 异步执行异常:`, e?.message || e);
    });

    res.json({ code: 200, data: { taskId, totalCount: articleCount } });
  } catch (e: any) {
    console.error('[Xhs] 创建写作任务失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 封面模板 ====================

/** GET /xhs/cover-templates —— 内置模板 + 本人模板 */
router.get('/cover-templates', async (req: Request, res: Response) => {
  try {
    const rows = await getXhsCoverTemplates(getUserId(req));
    res.json({ code: 200, data: rows });
  } catch (e: any) {
    console.error('[Xhs] 封面模板列表失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** POST /xhs/cover-templates —— 新建本人模板 */
router.post('/cover-templates', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const { name, layout, fontConfig, previewUrl } = req.body || {};
    if (!name) return res.status(400).json({ code: 400, message: '缺少 name' });
    if (!['solid_text', 'image_top_text', 'text_left_image'].includes(String(layout))) {
      return res.status(400).json({ code: 400, message: 'layout 仅支持 solid_text / image_top_text / text_left_image' });
    }
    const id = await createXhsCoverTemplate({
      user_id: uid,
      name: String(name),
      layout: String(layout),
      font_config: fontConfig || {},
      preview_url: previewUrl,
    });
    res.json({ code: 200, data: { id } });
  } catch (e: any) {
    console.error('[Xhs] 新建封面模板失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** PUT /xhs/cover-templates/:id —— 更新（内置模板返回 403） */
router.put('/cover-templates/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const exists = await getXhsCoverTemplateById(id);
    if (!exists) return res.status(404).json({ code: 404, message: '模板不存在' });
    if (exists.builtin) return res.status(403).json({ code: 403, message: '内置模板不可修改，请先另存为自定义模板' });
    const affected = await updateXhsCoverTemplate(id, getUserId(req), req.body || {});
    if (affected === 0) return res.status(404).json({ code: 404, message: '模板不存在或无权修改' });
    res.json({ code: 200, message: '更新成功' });
  } catch (e: any) {
    console.error('[Xhs] 更新封面模板失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** DELETE /xhs/cover-templates/:id —— 删除（内置模板返回 403） */
router.delete('/cover-templates/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const exists = await getXhsCoverTemplateById(id);
    if (!exists) return res.status(404).json({ code: 404, message: '模板不存在' });
    if (exists.builtin) return res.status(403).json({ code: 403, message: '内置模板不可删除' });
    const affected = await deleteXhsCoverTemplate(id, getUserId(req));
    if (affected === 0) return res.status(404).json({ code: 404, message: '模板不存在或无权删除' });
    res.json({ code: 200, message: '删除成功' });
  } catch (e: any) {
    console.error('[Xhs] 删除封面模板失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ==================== 生图 ====================

/**
 * POST /xhs/images/generate —— 单张文生图，写入小红书图库
 * Body: { xhs_customer_id, xhs_knowledge_id?, image_type: 'cover'|'illustration', prompt, size? }
 * 业务失败（未配置/额度用尽）返回 400 + code 4001/4002，桌面端据此降级为图库选图
 */
router.post('/images/generate', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const b = req.body || {};
    const customerId = Number(b.xhs_customer_id);
    if (!customerId) return res.status(400).json({ code: 400, message: '缺少 xhs_customer_id' });
    const customer = await getXhsCustomerById(customerId);
    if (!customer || Number(customer.owner_user_id) !== uid) {
      return res.status(404).json({ code: 404, message: '客户不存在' });
    }
    if (!b.prompt || !String(b.prompt).trim()) {
      return res.status(400).json({ code: 400, message: '缺少 prompt' });
    }
    if (!['cover', 'illustration'].includes(String(b.image_type))) {
      return res.status(400).json({ code: 400, message: 'image_type 必须是 cover 或 illustration' });
    }
    const { generateXhsImageToLibrary } = await import('../services/xhs/xhsImageGenerator');
    const result = await generateXhsImageToLibrary({
      userId: uid,
      xhsCustomerId: customerId,
      xhsKnowledgeId: b.xhs_knowledge_id ? Number(b.xhs_knowledge_id) : null,
      imageType: String(b.image_type) as 'cover' | 'illustration',
      prompt: String(b.prompt).trim(),
      size: b.size ? String(b.size) : undefined,
    });
    res.json({ code: 200, data: result });
  } catch (e: any) {
    const msg = e?.message || '生图失败';
    console.error('[Xhs] 生图失败:', msg);
    // 业务错误透传 code（4001 未配置 / 4002 额度用尽），其余 500
    const code = Number(e?.code);
    if (code === 4001 || code === 4002) return res.status(400).json({ code, message: msg });
    res.status(500).json({ code: 500, message: msg });
  }
});

// ==================== 发布台账与看板 ====================

/** GET /xhs/publish-tasks —— 小红书发布台账（可选按客户过滤） */
router.get('/publish-tasks', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const xhsCustomerId = req.query.xhs_customer_id ? Number(req.query.xhs_customer_id) : null;
    const data = await getXhsPublishTasks(uid, page, pageSize, xhsCustomerId);
    res.json({ code: 200, data });
  } catch (e: any) {
    console.error('[Xhs] 发布台账失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** GET /xhs/dashboard/overview —— 汇总指标（支持 ?days=30） */
router.get('/dashboard/overview', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 30;
    res.json({ code: 200, data: await getXhsDashboardOverview(getUserId(req), days) });
  } catch (e: any) {
    console.error('[Xhs] 看板汇总失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** GET /xhs/dashboard/by-account —— 按账号维度 */
router.get('/dashboard/by-account', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 30;
    res.json({ code: 200, data: await getXhsDashboardByAccount(getUserId(req), days) });
  } catch (e: any) {
    console.error('[Xhs] 看板按账号失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

/** GET /xhs/dashboard/by-time —— 按时间维度 */
router.get('/dashboard/by-time', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 30;
    res.json({ code: 200, data: await getXhsDashboardByTime(getUserId(req), days) });
  } catch (e: any) {
    console.error('[Xhs] 看板按时间失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

export default router;