import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../auth';
import { query } from '../db';
import {
  getAiModelConfigs,
  getAiModelConfigById,
  createAiModelConfig,
  updateAiModelConfig,
  deleteAiModelConfig,
  getWritingInstructions,
  getWritingInstructionById,
  createWritingInstruction,
  updateWritingInstruction,
  deleteWritingInstruction,
  getEnterpriseKnowledges,
  getEnterpriseKnowledgeById,
  createEnterpriseKnowledge,
  updateEnterpriseKnowledge,
  deleteEnterpriseKnowledge,
  createWritingTask,
  getWritingTasks,
  getWritingTaskById,
  deleteWritingTask,
  getArticles,
  getArticleById,
  updateArticle,
  deleteArticle,
  getArticleCoverageStats,
} from '../repository';
import { encrypt, decrypt, maskApiKey } from '../utils/crypto';
import { testModelConnection } from '../services/content/aiClient';
import { executeWritingTask, regenerateArticle } from '../services/content/articleGenerator';

const router = Router();

// 所有内容中枢接口都需要登录鉴权
router.use(authMiddleware);

// 获取登录用户ID的辅助函数
function getUserId(req: Request): number {
  return Number((req as any).user?.userId || (req as any).user?.id || 0);
}

// ============ AI模型配置 ============

// 返回支持的7个平台及其默认配置
router.get('/models/platforms', (req: Request, res: Response) => {
  const platforms = [
    { platform: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1/chat/completions' },
    { platform: 'doubao', name: '豆包', defaultModel: 'doubao-pro-32k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
    { platform: 'hunyuan', name: '腾讯混元', defaultModel: 'hunyuan-pro', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions' },
    { platform: 'qianwen', name: '通义千问', defaultModel: 'qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
    { platform: 'wenxin', name: '文心一言', defaultModel: 'ernie-bot-pro', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions' },
    { platform: 'kimi', name: 'Kimi', defaultModel: 'moonshot-v1-32k', baseUrl: 'https://api.moonshot.cn/v1/chat/completions' },
    { platform: 'zhipu', name: '智谱AI', defaultModel: 'glm-4', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  ];
  res.json({ code: 200, data: platforms });
});

router.get('/models', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const configs = await getAiModelConfigs(userId);
    // 脱敏：不返回 api_key_encrypted，返回 is_shared 标识
    const result = configs.map(c => ({
      ...c,
      api_key_masked: c.user_id === null ? null : '已配置', // 用户自有配置显示"已配置"
      is_shared: c.user_id === null,
      api_key_encrypted: undefined,
    }));
    res.json({ code: 200, data: result });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/models', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { platform, model_name, api_key, base_url, max_tokens, temperature, is_active, daily_quota } = req.body;
    if (!platform || !model_name || !base_url) {
      return res.status(400).json({ code: 400, message: 'platform/model_name/base_url 必填' });
    }
    const id = await createAiModelConfig({
      user_id: userId,
      platform,
      model_name,
      api_key_encrypted: api_key ? encrypt(api_key) : null,
      base_url,
      max_tokens,
      temperature,
      is_active,
      daily_quota,
    });
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/models/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = { ...req.body };
    if (data.api_key) {
      data.api_key_encrypted = encrypt(data.api_key);
      delete data.api_key;
    }
    await updateAiModelConfig(id, data);
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/models/:id', async (req: Request, res: Response) => {
  try {
    await deleteAiModelConfig(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/models/:id/test', async (req: Request, res: Response) => {
  try {
    const config = await getAiModelConfigById(Number(req.params.id));
    if (!config) return res.status(404).json({ code: 404, message: '配置不存在' });
    let apiKey = '';
    if (config.api_key_encrypted) {
      try { apiKey = decrypt(config.api_key_encrypted); } catch { return res.json({ code: 200, data: { success: false, message: 'API-KEY解密失败' } }); }
    }
    if (!apiKey) return res.json({ code: 200, data: { success: false, message: '未配置API-KEY' } });
    const result = await testModelConnection({
      baseUrl: config.base_url,
      apiKey,
      model: config.model_name,
      messages: [],
    });
    res.json({ code: 200, data: result });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 写作指令 ============

router.get('/instructions/categories', (req: Request, res: Response) => {
  const categories = [
    { key: '认知层', name: '认知层', description: '用户刚意识到问题存在，搜索泛词了解基础概念' },
    { key: '了解层', name: '了解层', description: '用户开始主动了解解决方案，搜索对比类词' },
    { key: '评估层', name: '评估层', description: '用户评估不同方案，搜索评测/口碑类词' },
    { key: '决策层', name: '决策层', description: '用户即将决策，搜索"哪家好/推荐"类词' },
    { key: '信任层', name: '信任层', description: '用户已转化，搜索品牌词/案例验证信任' },
  ];
  res.json({ code: 200, data: categories });
});

router.get('/instructions', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const category = req.query.category as string | undefined;
    const list = await getWritingInstructions(userId, category);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/instructions', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, category, system_prompt, user_prompt_template, target_word_count, include_faq, include_comparison_table } = req.body;
    if (!name || !system_prompt || !user_prompt_template) {
      return res.status(400).json({ code: 400, message: 'name/system_prompt/user_prompt_template 必填' });
    }
    const id = await createWritingInstruction({
      user_id: userId, name, category, system_prompt, user_prompt_template,
      target_word_count, include_faq, include_comparison_table,
    });
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/instructions/:id', async (req: Request, res: Response) => {
  try {
    await updateWritingInstruction(Number(req.params.id), req.body);
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/instructions/:id', async (req: Request, res: Response) => {
  try {
    await deleteWritingInstruction(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 企业知识库 ============

router.get('/knowledge', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const list = await getEnterpriseKnowledges(userId);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/knowledge', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = await createEnterpriseKnowledge({ ...req.body, user_id: userId });
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    await updateEnterpriseKnowledge(Number(req.params.id), req.body);
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    await deleteEnterpriseKnowledge(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ AI写作任务 ============

router.get('/writing-tasks', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const result = await getWritingTasks(userId, page, pageSize);
    res.json({ code: 200, data: result });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/writing-tasks/:id', async (req: Request, res: Response) => {
  try {
    const task = await getWritingTaskById(Number(req.params.id));
    if (!task) return res.status(404).json({ code: 404, message: '任务不存在' });
    res.json({ code: 200, data: task });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/writing-tasks', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { task_name, keyword_ids, instruction_id, knowledge_id, model_config_id } = req.body;
    if (!keyword_ids || !Array.isArray(keyword_ids) || keyword_ids.length === 0) {
      return res.status(400).json({ code: 400, message: 'keyword_ids 必填且非空' });
    }
    if (!instruction_id || !knowledge_id || !model_config_id) {
      return res.status(400).json({ code: 400, message: 'instruction_id/knowledge_id/model_config_id 必填' });
    }
    const taskId = await createWritingTask({
      user_id: userId, task_name, keyword_ids, instruction_id, knowledge_id, model_config_id,
      total_count: keyword_ids.length,
    });
    // 异步执行任务（不阻塞响应）
    executeWritingTask(taskId, userId).catch(err => {
      console.error(`Writing task ${taskId} failed:`, err);
    });
    res.json({ code: 200, data: { id: taskId } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/writing-tasks/:id', async (req: Request, res: Response) => {
  try {
    await deleteWritingTask(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/writing-tasks/:id/articles', async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const result = await query(
      `SELECT id, title, core_keyword, keyword_type, word_count, status, model_used, create_time
       FROM article WHERE task_id = $1 ORDER BY create_time DESC`,
      [taskId]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 文章管理 ============

router.get('/articles', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const result = await getArticles(userId, {
      keyword: req.query.keyword as string,
      status: req.query.status as string,
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 20,
    });
    res.json({ code: 200, data: result });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/articles/:id', async (req: Request, res: Response) => {
  try {
    const article = await getArticleById(Number(req.params.id));
    if (!article) return res.status(404).json({ code: 404, message: '文章不存在' });
    res.json({ code: 200, data: article });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/articles/:id', async (req: Request, res: Response) => {
  try {
    await updateArticle(Number(req.params.id), req.body);
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/articles/:id', async (req: Request, res: Response) => {
  try {
    await deleteArticle(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/articles/:id/regenerate', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const articleId = Number(req.params.id);
    // 异步执行重新生成
    regenerateArticle(articleId, userId).catch(err => {
      console.error(`Regenerate article ${articleId} failed:`, err);
    });
    res.json({ code: 200, message: '重新生成已开始' });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/articles/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!['draft', 'generated', 'editing', 'ready', 'published', 'archived'].includes(status)) {
      return res.status(400).json({ code: 400, message: '无效的状态' });
    }
    await updateArticle(Number(req.params.id), { status });
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 仪表盘统计 ============

router.get('/dashboard/stats', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const stats = await getArticleCoverageStats(String(userId));
    res.json({
      code: 200,
      data: {
        coverage: stats,
      },
    });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

export default router;
