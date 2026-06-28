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
  // 发布相关
  getStepListByPlatform,
  getAllStepLists,
  upsertStepList,
  createPublishTask,
  getPublishTasks,
  getPublishTaskById,
  updatePublishTaskStatus,
  cancelPublishTask,
  getPendingPublishRecords,
  updatePublishRecordResult,
  markPublishRecordStarted,
  getPublishRecordsByTask,
  getPublishAccounts,
  createPublishAccount,
  updatePublishAccountStorageState,
  updatePublishAccountStatus,
  deletePublishAccount,
  getPublishAccountById,
  // 云接口配置
  getCloudApiConfig,
  upsertCloudApiConfig,
  // 智能体角色同步
  upsertAgentProfile,
  getAgentProfiles,
  getAgentProfileById,
  deleteAgentProfile,
  // 代理池管理
  createProxy,
  updateProxy,
  getProxies,
  getProxyById,
  deleteProxy,
  updateProxyHealthCheck,
  incrementProxyUsedCount,
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

/**
 * 解析 customer_id 查询参数：
 * - 传入 ?customer_id=N 时使用该值（管理员模式，查看指定客户的数据）
 * - 未传时回退到当前登录用户 ID（客户自身模式）
 */
function getCustomerId(req: Request): number {
  const raw = req.query.customer_id as string | undefined;
  if (raw && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return getUserId(req);
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
    // 诊断日志：排查"配置丢失"和"apikey 不显示"问题
    console.log(`[GET /models] userId=${userId}, 返回配置数=${configs.length}, platforms=[${configs.map(c => `${c.platform}(uid=${c.user_id},id=${c.id},hasKey=${!!c.api_key_encrypted})`).join(', ')}]`);

    // v1.4.3：无条件解密所有 api_key_encrypted（用户要求明文显示，且为私有部署）
    // 之前 bug：c.user_id !== null 判断可能因 userId=0 等情况误判，导致不解密
    const result = configs.map(c => {
      let apiKeyPlaintext = '';
      if (c.api_key_encrypted) {
        try {
          apiKeyPlaintext = decrypt(c.api_key_encrypted);
          console.log(`[GET /models] 解密成功: platform=${c.platform} id=${c.id} keyLength=${apiKeyPlaintext.length}`);
        } catch (e: any) {
          console.error(`[GET /models] api_key 解密失败: platform=${c.platform} id=${c.id} error=${e.message} encryptedLen=${c.api_key_encrypted?.length}`);
          apiKeyPlaintext = '';
        }
      } else {
        console.warn(`[GET /models] 无 api_key_encrypted: platform=${c.platform} id=${c.id}`);
      }
      return {
        ...c,
        api_key: apiKeyPlaintext, // 明文 API-KEY
        api_key_masked: c.api_key_encrypted ? '已配置' : null,
        is_shared: c.user_id === null,
        api_key_encrypted: undefined, // 不返回加密密文
      };
    });
    res.json({ code: 200, data: result });
  } catch (err: any) {
    console.error(`[GET /models] 查询失败: userId=${getUserId(req)} error=${err.message}`);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/models', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { platform, model_name, api_key, base_url, max_tokens, temperature, is_active, daily_quota, use_for_collect, web_search } = req.body;
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
      use_for_collect,
      web_search,
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

    // 优先使用请求体中传入的 api_key（支持"先填后测"工作流，不依赖保存是否成功）
    // 其次使用数据库中已加密的 api_key
    let apiKey = '';
    const bodyApiKey = req.body?.api_key;
    if (bodyApiKey && typeof bodyApiKey === 'string' && bodyApiKey.trim()) {
      apiKey = bodyApiKey.trim();
    } else if (config.api_key_encrypted) {
      try {
        apiKey = decrypt(config.api_key_encrypted);
      } catch {
        return res.json({ code: 200, data: { success: false, message: 'API-KEY 解密失败（数据库中的密文已损坏），请重新输入并保存' } });
      }
    }

    if (!apiKey) {
      return res.json({ code: 200, data: { success: false, message: '未配置 API-KEY，请先在表单中填写' } });
    }

    // model_name 和 base_url 也支持请求体覆盖（测试当前表单值，不依赖已保存的配置）
    const modelName = req.body?.model_name?.trim() || config.model_name;
    const baseUrl = req.body?.base_url?.trim() || config.base_url;

    const result = await testModelConnection({
      baseUrl,
      apiKey,
      model: modelName,
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
    const customerId = getCustomerId(req);
    const category = req.query.category as string | undefined;
    const list = await getWritingInstructions(customerId, category);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/instructions', async (req: Request, res: Response) => {
  try {
    // 支持显式指定 customer_id（管理员模式），否则用当前登录用户
    const customerId = req.body.customer_id
      ? Number(req.body.customer_id)
      : getUserId(req);
    const { name, category, system_prompt, user_prompt_template, target_word_count, include_faq, include_comparison_table, content_types, random_mode } = req.body;
    if (!name || !system_prompt || !user_prompt_template) {
      return res.status(400).json({ code: 400, message: 'name/system_prompt/user_prompt_template 必填' });
    }
    const id = await createWritingInstruction({
      user_id: customerId, name, category, system_prompt, user_prompt_template,
      target_word_count, include_faq, include_comparison_table,
      content_types: Array.isArray(content_types) ? content_types : [],
      random_mode: !!random_mode,
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
    const customerId = getCustomerId(req);
    const list = await getEnterpriseKnowledges(customerId);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/knowledge', async (req: Request, res: Response) => {
  try {
    const customerId = req.body.customer_id
      ? Number(req.body.customer_id)
      : getUserId(req);
    const id = await createEnterpriseKnowledge({ ...req.body, user_id: customerId });
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

// ============ 智能体角色同步（agent_profile） ============
// 桌面端 AGENT 人事部保存角色时同步到云端，供内容中枢写作任务复用

/**
 * 同步单个智能体角色到云端（upsert）
 * 桌面端保存角色后调用此接口，把 systemPrompt + 启用的技能内容同步过来
 */
router.post('/agent-profiles/sync', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { role_id, name, description, department_id, department_name, system_prompt, skills_content, skills_count, provider, model_name, is_active } = req.body;
    if (!role_id || !name) {
      return res.status(400).json({ code: 400, message: 'role_id/name 必填' });
    }
    const id = await upsertAgentProfile({
      user_id: userId, role_id, name, description, department_id, department_name,
      system_prompt, skills_content, skills_count, provider, model_name, is_active,
    });
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 获取当前用户的智能体角色列表（列表展示，不含 skills_content 大字段） */
router.get('/agent-profiles', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const list = await getAgentProfiles(userId);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 获取单个智能体角色详情（含完整 system_prompt + skills_content） */
router.get('/agent-profiles/:id', async (req: Request, res: Response) => {
  try {
    const profile = await getAgentProfileById(Number(req.params.id));
    if (!profile) return res.status(404).json({ code: 404, message: '角色不存在' });
    res.json({ code: 200, data: profile });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 删除智能体角色同步记录 */
router.delete('/agent-profiles/:id', async (req: Request, res: Response) => {
  try {
    await deleteAgentProfile(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 代理池管理（Phase 2：借鉴 BrowserAct 代理系统设计） ============

/** 创建代理 */
router.post('/proxies', async (req: Request, res: Response) => {
  try {
    const userId = String(getUserId(req));
    const { name, provider, proxy_type, region, endpoint, username, password, is_active, remark } = req.body;
    if (!name || !endpoint) {
      res.status(400).json({ code: 400, message: 'name 和 endpoint 必填' });
      return;
    }
    // 密码加密存储（复用 ai_model_config 的加密逻辑）
    const encryptedPassword = password ? encrypt(password) : '';
    const id = await createProxy({
      user_id: userId, name, provider, proxy_type, region, endpoint,
      username, password: encryptedPassword, is_active, remark,
    });
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 获取代理列表 */
router.get('/proxies', async (req: Request, res: Response) => {
  try {
    const userId = String(getUserId(req));
    const list = await getProxies(userId);
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 获取单个代理详情 */
router.get('/proxies/:id', async (req: Request, res: Response) => {
  try {
    const proxy = await getProxyById(Number(req.params.id));
    if (!proxy) {
      res.status(404).json({ code: 404, message: '代理不存在' });
      return;
    }
    // 解密密码返回给调用方（Worker 调用时需要明文）
    if (proxy.password) {
      try { proxy.password = decrypt(proxy.password); } catch {}
    }
    res.json({ code: 200, data: proxy });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 更新代理 */
router.put('/proxies/:id', async (req: Request, res: Response) => {
  try {
    const { name, provider, proxy_type, region, endpoint, username, password, is_active, remark } = req.body;
    const updateData: any = { name, provider, proxy_type, region, endpoint, username, is_active, remark };
    // 密码非空时才更新（避免空值覆盖）
    if (password) {
      updateData.password = encrypt(password);
    }
    await updateProxy(Number(req.params.id), updateData);
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 删除代理 */
router.delete('/proxies/:id', async (req: Request, res: Response) => {
  try {
    await deleteProxy(Number(req.params.id));
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/** 代理健康检查（简单 TCP 连通性测试） */
router.post('/proxies/:id/check', async (req: Request, res: Response) => {
  try {
    const proxy = await getProxyById(Number(req.params.id));
    if (!proxy) {
      res.status(404).json({ code: 404, message: '代理不存在' });
      return;
    }
    // 解密密码
    let password = proxy.password;
    try { if (password) password = decrypt(password); } catch {}

    const startTime = Date.now();
    const ok = await testProxyConnectivity(proxy.endpoint, proxy.username, password);
    const latency = Date.now() - startTime;

    await updateProxyHealthCheck(proxy.id, ok, latency);
    res.json({ code: 200, data: { ok, latency_ms: latency } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

/**
 * 简单代理连通性测试：通过代理访问 httpbin.org/ip
 */
async function testProxyConnectivity(endpoint: string, username: string, password: string): Promise<boolean> {
  try {
    const net = await import('net');
    const url = new URL(`http://${endpoint}`);
    const host = url.hostname;
    const port = parseInt(url.port || '80', 10);

    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(5000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  } catch {
    return false;
  }
}

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
    const { task_name, keyword_ids, keywords, instruction_id, knowledge_id, model_config_id, generation_mode, agent_profile_id } = req.body;

    // 关键词来源优先级：
    //   1. keyword_ids（显式传入，向后兼容）
    //   2. keywords（字符串数组，前端手动输入，需转换为 keyword_ids）
    //   3. 都没有 → 报错
    let finalKeywordIds: number[] = [];
    if (Array.isArray(keyword_ids) && keyword_ids.length > 0) {
      finalKeywordIds = keyword_ids;
    } else if (Array.isArray(keywords) && keywords.length > 0) {
      // 按关键词文本查 ID（兼容前端无 ID 场景）
      const { getKeywordIdsByValues } = await import('../repository');
      finalKeywordIds = await getKeywordIdsByValues(userId, keywords);
    }

    if (finalKeywordIds.length === 0) {
      return res.status(400).json({ code: 400, message: '关键词必填且非空' });
    }
    if (!instruction_id || !knowledge_id) {
      return res.status(400).json({ code: 400, message: 'instruction_id/knowledge_id 必填' });
    }
    // model_config_id 可选：未传时由 articleGenerator 自动取默认模型
    // agent_profile_id 可选：指定专家智能体角色（systemPrompt+skills 注入 system message）
    const taskId = await createWritingTask({
      user_id: userId, task_name, keyword_ids: finalKeywordIds, instruction_id, knowledge_id,
      model_config_id: model_config_id || null,
      generation_mode: generation_mode || 'expert',
      agent_profile_id: agent_profile_id || null,
      total_count: finalKeywordIds.length,
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
    const taskId = req.query.task_id ? Number(req.query.task_id) : undefined;
    const result = await getArticles(userId, {
      keyword: req.query.keyword as string,
      status: req.query.status as string,
      task_id: taskId,
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

// 批量发布：为多篇文章创建发布任务（每篇一个 publish_task）
// Body: { article_ids: number[], target_platforms: string[], scheduled_at?: string }
router.post('/articles/batch-publish', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { article_ids, target_platforms, scheduled_at } = req.body;
    if (!Array.isArray(article_ids) || article_ids.length === 0) {
      return res.status(400).json({ code: 400, message: 'article_ids 必填且非空' });
    }
    if (!Array.isArray(target_platforms) || target_platforms.length === 0) {
      return res.status(400).json({ code: 400, message: 'target_platforms 必填且非空' });
    }
    const scheduledDate = scheduled_at ? new Date(scheduled_at) : undefined;
    const taskIds: number[] = [];
    for (const articleId of article_ids) {
      const taskId = await createPublishTask({
        user_id: userId,
        article_id: Number(articleId),
        target_platforms,
        scheduled_at: scheduledDate,
      });
      taskIds.push(taskId);
    }
    res.json({ code: 200, data: { task_ids: taskIds } });
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

// ============ 发布：12 个自媒体平台清单 ============

const PUBLISH_PLATFORMS = [
  { platform: 'bjh', name: '百家号', loginUrl: 'https://passport.baidu.com/v2/?login' },
  { platform: 'csdn', name: 'CSDN', loginUrl: 'https://passport.csdn.net/login' },
  { platform: 'js', name: '简书', loginUrl: 'https://www.jianshu.com/sign_in' },
  { platform: 'zh', name: '知乎', loginUrl: 'https://www.zhihu.com/signin' },
  { platform: 'xhs', name: '小红书', loginUrl: 'https://www.xiaohongshu.com' },
  { platform: 'qeh', name: '企鹅号', loginUrl: 'https://om.qq.com/userAuth/index' },
  { platform: 'sohu', name: '搜狐号', loginUrl: 'https://mp.sohu.com/mp/login' },
  { platform: 'tt', name: '今日头条', loginUrl: 'https://sso.toutiao.com/login' },
  { platform: 'wxgzh', name: '微信公众号', loginUrl: 'https://mp.weixin.qq.com/' },
  { platform: 'wy', name: '网易号', loginUrl: 'https://mp.163.com/login' },
  { platform: 'bili', name: 'B站', loginUrl: 'https://passport.bilibili.com/login' },
  { platform: 'dy', name: '抖音', loginUrl: 'https://www.douyin.com/login' },
];

router.get('/publish/platforms', (req: Request, res: Response) => {
  res.json({ code: 200, data: PUBLISH_PLATFORMS });
});

// ============ 发布：step_list 管理 ============

router.get('/publish/step-lists', async (req: Request, res: Response) => {
  try {
    const list = await getAllStepLists();
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/publish/step-lists/:platform', async (req: Request, res: Response) => {
  try {
    const data = await getStepListByPlatform(req.params.platform);
    if (!data) {
      return res.status(404).json({ code: 404, message: `平台 ${req.params.platform} 暂无 step_list 配置` });
    }
    res.json({ code: 200, data });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/publish/step-lists/:platform', async (req: Request, res: Response) => {
  try {
    const { version, step_list, description } = req.body;
    if (!version || !step_list) {
      return res.status(400).json({ code: 400, message: 'version 和 step_list 必填' });
    }
    const id = await upsertStepList(req.params.platform, version, step_list, description);
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 发布：任务管理 ============

router.get('/publish/tasks', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const data = await getPublishTasks(userId, page, pageSize);
    res.json({ code: 200, data });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/publish/tasks/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const task = await getPublishTaskById(id);
    if (!task) {
      return res.status(404).json({ code: 404, message: '任务不存在' });
    }
    const records = await getPublishRecordsByTask(id);
    res.json({ code: 200, data: { ...task, records } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/publish/tasks/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await cancelPublishTask(id);
    res.json({ code: 200, data: { ok: true } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 桌面端 Worker 拉取待发布记录（dequeue：拉取 + 标记 started + 附带 step_list）
router.get('/publish/records/dequeue', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 2, 8);
    const records = await getPendingPublishRecords(limit);
    // 为每条记录附加 step_list + account_proxy，并标记为 started（processing）
    const enriched = await Promise.all(records.map(async (r: any) => {
      try {
        const stepList = await getStepListByPlatform(r.platform);
        await markPublishRecordStarted(r.id);

        // 查询账号绑定的代理信息（Phase 2：代理池）
        let accountProxy: any = null;
        if (r.platform_auth_id) {
          const proxyResult = await query(
            `SELECT pp.id, pp.name, pp.endpoint, pp.username, pp.password, pp.region, pp.proxy_type
             FROM platform_auth pa
             LEFT JOIN proxy_pool pp ON pa.proxy_id = pp.id
             WHERE pa.id = $1 AND pa.proxy_id IS NOT NULL`,
            [r.platform_auth_id]
          );
          if (proxyResult.rows.length > 0 && proxyResult.rows[0].id) {
            const proxyRow = proxyResult.rows[0];
            // 解密密码
            let password = proxyRow.password;
            try { if (password) password = decrypt(password); } catch {}
            accountProxy = {
              id: proxyRow.id,
              name: proxyRow.name,
              endpoint: proxyRow.endpoint,
              username: proxyRow.username,
              password,
              region: proxyRow.region,
              proxy_type: proxyRow.proxy_type,
            };
            // 递增代理使用计数（异步执行，不阻塞 dequeue）
            incrementProxyUsedCount(proxyRow.id).catch((e) => {
              console.error('[Publish] incrementProxyUsedCount 失败:', e?.message);
            });
          }
        }

        return {
          record_id: r.id,
          task_id: r.task_id,
          platform: r.platform,
          platform_auth_id: r.platform_auth_id,
          account_name: r.account_name,
          account_storage_state: r.account_storage_state,
          account_proxy: accountProxy,
          article: {
            id: r.article_id,
            title: r.article_title,
            content_html: r.article_content,
            tags: r.article_tags ? (typeof r.article_tags === 'string' ? JSON.parse(r.article_tags) : r.article_tags) : [],
            cover_image_url: r.article_cover,
          },
          scheduled_at: r.scheduled_at,
          step_list: stepList ? {
            platform: stepList.platform,
            version: stepList.version,
            login_check_url: stepList.step_list?.login_check_url,
            login_check_selector: stepList.step_list?.login_check_selector,
            logout_keywords: stepList.step_list?.logout_keywords,
            steps: stepList.step_list?.steps || [],
            is_placeholder: stepList.step_list?.is_placeholder || false,
          } : null,
        };
      } catch (e: any) {
        console.error(`[Publish] record ${r.id} enrich 失败:`, e.message);
        return null;
      }
    }));
    const valid = enriched.filter(Boolean);
    res.json({ code: 200, data: valid });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 桌面端回写发布结果（单条 record）
router.post('/publish/records/:id/result', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { status, article_id_on_platform, platform_url, error_msg, account_health } = req.body;
    if (!['success', 'failed', 'login_expired', 'banned'].includes(status)) {
      return res.status(400).json({ code: 400, message: 'status 取值非法' });
    }

    // 1. 更新 record 结果
    await updatePublishRecordResult(id, { status, article_id_on_platform, platform_url, error_msg });

    // 2. 查询 record 所属 task，更新 task 进度
    const recordResult = await query('SELECT task_id, platform_auth_id FROM publish_record WHERE id = $1', [id]);
    if (recordResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'record 不存在' });
    }
    const { task_id, platform_auth_id } = recordResult.rows[0];
    const completedDelta = status === 'success' ? 1 : 0;
    const failedDelta = status === 'success' ? 0 : 1;
    await updatePublishTaskStatus(task_id, 'processing', completedDelta, failedDelta);

    // 3. 重新查询 task 总体状态，更新最终状态
    const taskResult = await query('SELECT total_count, completed_count, failed_count FROM publish_task WHERE id = $1', [task_id]);
    if (taskResult.rows.length > 0) {
      const t = taskResult.rows[0];
      const done = Number(t.completed_count) + Number(t.failed_count);
      if (done >= Number(t.total_count)) {
        const finalStatus = Number(t.failed_count) === 0 ? 'completed'
          : Number(t.completed_count) === 0 ? 'failed'
          : 'partial';
        await updatePublishTaskStatus(task_id, finalStatus, 0, 0);
      }
    }

    // 4. 账号健康度联动：login_expired → offline，banned → banned
    if (platform_auth_id && account_health) {
      if (account_health === 'offline') {
        await updatePublishAccountStatus(platform_auth_id, 'expired', 'offline');
      } else if (account_health === 'banned') {
        await updatePublishAccountStatus(platform_auth_id, 'expired', 'banned');
      }
    }

    res.json({ code: 200, data: { ok: true } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 自媒体账号管理 ============

router.get('/publish-accounts', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const poolType = (req.query.pool_type as string) || 'all';
    const customerId = req.query.customer_id ? Number(req.query.customer_id) : undefined;
    const list = await getPublishAccounts(
      userId,
      poolType as 'public' | 'private' | 'all',
      customerId,
    );
    res.json({ code: 200, data: list });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/publish-accounts', async (req: Request, res: Response) => {
  try {
    const { platform, account_name, storage_state, avatar_url, pool_type, customer_id, proxy_id } = req.body;
    if (!platform || !account_name || !storage_state) {
      return res.status(400).json({ code: 400, message: 'platform, account_name, storage_state 必填' });
    }
    // 公共池：user_id = null；私有池：user_id = customer_id
    const userId = pool_type === 'public' ? null : (customer_id ? Number(customer_id) : getUserId(req));
    const id = await createPublishAccount({
      user_id: userId,
      platform,
      account_name,
      storage_state,
      avatar_url,
    });
    // 绑定代理（可选）
    if (proxy_id) {
      await query('UPDATE platform_auth SET proxy_id = $1 WHERE id = $2', [proxy_id, id]);
    }
    res.json({ code: 200, data: { id } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/publish-accounts/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { storage_state, status, health_status, proxy_id } = req.body;
    if (storage_state) {
      await updatePublishAccountStorageState(id, storage_state);
    }
    if (status && health_status) {
      await updatePublishAccountStatus(id, status, health_status);
    }
    // 更新代理绑定（支持 null 解绑）
    if (proxy_id !== undefined) {
      await query('UPDATE platform_auth SET proxy_id = $1 WHERE id = $2', [proxy_id || null, id]);
    }
    res.json({ code: 200, data: { ok: true } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/publish-accounts/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await deletePublishAccount(id);
    res.json({ code: 200, data: { ok: true } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/publish-accounts/:id/health', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const account = await getPublishAccountById(id);
    if (!account) {
      return res.status(404).json({ code: 404, message: '账号不存在' });
    }
    // 最近 7 天发布成功率统计
    const statsResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE pr.status = 'success') as success_count,
         COUNT(*) FILTER (WHERE pr.status = 'failed') as failed_count,
         COUNT(*) FILTER (WHERE pr.status IN ('success', 'failed')) as total_count,
         MAX(pr.published_at) as last_publish_time
       FROM publish_record pr
       WHERE pr.platform_auth_id = $1
         AND pr.create_time >= NOW() - INTERVAL '7 days'`,
      [id]
    );
    const stats = statsResult.rows[0];
    const total = Number(stats.total_count);
    const successRate = total > 0 ? Number(stats.success_count) / total : null;
    res.json({
      code: 200,
      data: {
        account_id: id,
        status: account.status,
        health_status: account.health_status,
        success_rate_7d: successRate,
        total_count_7d: total,
        last_publish_time: stats.last_publish_time,
      },
    });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 桌面端检测登录态后回传结果（不直接检测，由桌面端用 Playwright 执行）
router.post('/publish-accounts/:id/check-login', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { is_logged_in, storage_state } = req.body;
    if (typeof is_logged_in !== 'boolean') {
      return res.status(400).json({ code: 400, message: 'is_logged_in 必填（boolean）' });
    }
    if (is_logged_in) {
      // 登录态有效，刷新 storage_state 并恢复
      if (storage_state) {
        await updatePublishAccountStorageState(id, storage_state);
      } else {
        await updatePublishAccountStatus(id, 'active', 'normal');
      }
    } else {
      // 登录态失效，标记 offline
      await updatePublishAccountStatus(id, 'expired', 'offline');
    }
    res.json({ code: 200, data: { ok: true } });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 客户列表（用于管理员选择客户） ============

router.get('/customers', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, username, phone, email, level, create_time
       FROM users
       ORDER BY id ASC`,
    );
    res.json({ code: 200, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 关键词库（按客户过滤） ============

// 蒸馏关键词库（zlgjc 表，userid 字段关联客户）
router.get('/keywords/distilled', async (req: Request, res: Response) => {
  try {
    const customerId = getCustomerId(req);
    const result = await query(
      `SELECT id, value, hxgjc, create_time
       FROM zlgjc
       WHERE userid = $1
       ORDER BY create_time DESC`,
      [String(customerId)]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 品牌关键词库（pp 表，user_id 字段关联客户）
router.get('/keywords/brand', async (req: Request, res: Response) => {
  try {
    const customerId = getCustomerId(req);
    const result = await query(
      `SELECT id, pp
       FROM pp
       WHERE user_id = $1
       ORDER BY id ASC`,
      [String(customerId)]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ============ 云接口配置（cloud_api_config） ============
// 单行配置：GET 获取当前用户配置；PUT 创建/更新配置

router.get('/cloud-api', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const config = await getCloudApiConfig(userId);
    res.json({ code: 200, data: config || {} });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/cloud-api', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await upsertCloudApiConfig(userId, req.body || {});
    res.json({ code: 200 });
  } catch (err: any) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

export default router;
