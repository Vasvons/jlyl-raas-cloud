/**
 * 小红书运营大师板块路由（XHS_MASTER_PLAN）
 *
 * 职责：
 *  - 笔记（xhs_note_meta + article）读写
 *  - 创建小红书发布任务（内部复用 createPublishTask，不复制发布链路）
 *  - 封面模板 CRUD（内置模板只读）
 *  - 生图（调 services/content/imageGenerator）
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
  createPublishTask, createImage,
  getXhsWritingInstructions, getXhsWritingInstructionById,
  createXhsWritingInstruction, updateXhsWritingInstruction, deleteXhsWritingInstruction,
  createWritingTask,
} from '../repository';
import { generateImageToLibrary } from '../services/content/imageGenerator';

const router = Router();
router.use(authMiddleware);

function getUserId(req: any): number {
  return Number(req.user?.id ?? req.user?.userId ?? 0);
}

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

/** GET /xhs/notes —— 笔记列表（仅返回已建立 xhs_note_meta 的文章） */
router.get('/notes', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const data = await getXhsNotes(uid, page, pageSize);
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
 *   并把该图登记进 image_library（source='compose'，image_type='cover'），返回的 id 写入 cover_image_id
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

    // 封面合成产物：登记图库 + 回写 article.cover_image_url
    if (typeof body.cover_image_url === 'string' && body.cover_image_url.trim()) {
      const coverImageUrl = body.cover_image_url.trim();
      const detail = await getXhsNoteDetail(articleId);
      const knowledgeId = detail?.knowledge_id ?? null;
      coverImageId = await createImage({
        user_id: uid,
        knowledge_id: knowledgeId,
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
    const knowledgeId = Number(b.knowledge_id);
    if (!knowledgeId) return res.status(400).json({ code: 400, message: '缺少 knowledge_id' });
    const rawKeywords: string[] = Array.isArray(b.keywords)
      ? b.keywords.map((s: any) => String(s || '').trim()).filter(Boolean)
      : [];
    if (rawKeywords.length === 0) return res.status(400).json({ code: 400, message: '请至少填写 1 个关键词' });
    const articleCount = Math.min(100, Math.max(1, Number(b.article_count) || 1));

    // 关键词文本 → keyword_ids（复用既有查/建逻辑）
    const { getKeywordIdsByValues } = await import('../repository');
    const keywordIds = await getKeywordIdsByValues(uid, rawKeywords);

    const taskId = await createWritingTask({
      user_id: uid,
      task_name: b.task_name || `小红书笔记-${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
      keyword_ids: keywordIds,
      instruction_id: null,            // 小红书不使用 GEO 指令
      xhs_instruction_id: instructionId,
      writing_system: 'xhs',
      knowledge_id: knowledgeId,
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
 * POST /xhs/images/generate —— 文生图并落库
 * Body: { prompt, image_type: 'cover'|'illustration', knowledge_id?, size? }
 * 业务失败（未配置/额度用尽）返回 400 + code 4001/4002，桌面端据此降级为图库选图
 */
router.post('/images/generate', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const { prompt, image_type, knowledge_id, size } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ code: 400, message: '缺少 prompt' });
    }
    const result = await generateImageToLibrary({
      userId: uid,
      knowledgeId: knowledge_id != null ? Number(knowledge_id) : null,
      imageType: image_type === 'cover' ? 'cover' : 'illustration',
      prompt: String(prompt).trim(),
      size: size ? String(size) : undefined,
    });
    res.json({ code: 200, data: result });
  } catch (e: any) {
    console.error('[Xhs] 生图失败:', e.message);
    res.status(400).json({ code: e?.code || 400, message: e?.message || '生图失败' });
  }
});

// ==================== 发布台账与看板 ====================

/** GET /xhs/publish-tasks —— 小红书发布任务台账 */
router.get('/publish-tasks', async (req: Request, res: Response) => {
  try {
    const uid = getUserId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const data = await getXhsPublishTasks(uid, page, pageSize);
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