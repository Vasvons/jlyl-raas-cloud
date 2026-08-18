/**
 * v3.9.1 发布守护进程（Publish Guardian）
 *
 * 设计目标（v3.9.1 起改为「只分析失败原因并提醒」，不再修改发布配置、不再自动重试）：
 * - 监听 publish_failed 事件，分析失败原因并提醒用户
 * - 账号问题（登录态失效 / 被封禁 / 日额度耗尽）通过规则直接识别并提醒，不依赖 AI
 * - 其他失败原因由 AI 分析（可选），或直接汇报原始失败摘要
 * - 守护未启用时静默落库跳过（不推送任何提醒），且落库日志防止兜底扫描器反复挑中旧失败记录
 *
 * 调用入口：
 *   handlePublishFailedEvent(event) —— 由 /content/flywheel/event-logs 与 /publish/records/:id/result 路由调用
 *
 * 工具调用循环（只读 + 汇报）：
 *   AI 通过 function calling 调用以下工具完成分析：
 *   - read_step_list：读取当前平台 JSON 配置（辅助判断流程类问题）
 *   - get_account_status：查询账号健康状态
 *   - report_to_user：发送提醒消息
 */
import { callModelStream } from './pet/petChatService';
import {
  getGuardianConfig, createGuardianLog, updateGuardianLog,
  getRecentGuardianLogsByRecord, getStepListByPlatform,
  upsertStepListWithGuardian, deactivateStepListVersion,
  getPetModelConfigWithKey,
} from '../repository';
import { wsBroadcast } from '../wsServer';
import { query } from '../db';

/** 处理中的 record_id 集合，防止并发重复处理 */
const processingRecords = new Set<number>();

/**
 * v3.8.7：查询管理员（level='1'）的守护配置
 *
 * 场景：管理员帮客户创建发布任务时，publish_task.user_id 是客户的 id
 *       失败事件携带客户的 userId，但守护配置保存在管理员 userId 下
 *       此函数用于回退查找管理员的守护配置
 *
 * 如果有多个管理员，返回第一个 enabled=true 的；都没有则返回第一个管理员的配置
 */
async function getAdminGuardianConfig(): Promise<any> {
  try {
    // 优先查找 enabled=true 的管理员配置
    let result = await query(
      `SELECT pgc.*
       FROM publish_guardian_config pgc
       JOIN users u ON u.id = pgc.user_id
       WHERE u.level = '1' AND pgc.enabled = true
       ORDER BY pgc.user_id ASC
       LIMIT 1`
    );
    if (result.rows[0]) return result.rows[0];

    // 没有启用的，返回 null（让调用方走"未启用"逻辑）
    return null;
  } catch (e: any) {
    console.error('[Guardian] 查询管理员守护配置失败:', e.message);
    return null;
  }
}

/** 工具定义（OpenAI function calling 格式） */
const GUARDIAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_step_list',
      description: '读取指定平台的当前发布步骤配置（JSON）。返回完整 step_list，包含 steps 数组、login_check_url 等。',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: '平台代码，如 tt/qeh/bjh/wxgzh/zh/xhs 等' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_status',
      description: '查询指定平台账号的健康状态（normal/banned/offline/limited）和配额使用情况。',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: '平台代码' },
          user_id: { type: 'number', description: '用户 ID（可选，不传则查所有）' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_to_user',
      description: '向用户发送汇报消息，说明本次发布失败的原因与处理建议。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '汇报内容（支持 Markdown）' },
          severity: { type: 'string', enum: ['success', 'warning', 'error'], description: '严重程度：成功/警告/错误' },
        },
        required: ['message', 'severity'],
      },
    },
  },
];

/** 系统提示词 */
const SYSTEM_PROMPT = `你是发布守护进程，负责自动分析自媒体平台发布失败的原因。你是分析/汇报系统，不是修复系统，不要修改任何配置或触发重试。

## 核心原则（最重要）
- **你是分析者，不是修复者**：收到失败事件后，分析失败原因，然后直接汇报用户
- **不要修改配置**：无论什么原因，都不要调用 read_step_list 以外的任何写操作
- **不要触发重试**：发布重试由用户手动操作
- **不要问用户问题**：分析完成后直接汇报结果，不要问"是否需要处理"或"怎么处理"

## 你的工作流程
1. 分析失败日志和页面诊断信息，判断失败原因类型：
   - **账号问题**（登录态失效 account_login_expired、被封禁 account_banned、配额耗尽 account_limited、日额度耗尽）：需用户处理，可直接从 error_type 判断
   - **内容问题**（content_error：标题超长、正文为空、图片缺失、违规内容）：需用户检查文章内容
   - **平台问题**（platform_error：平台服务器错误、服务繁忙）：可告知用户稍后重试
   - **流程问题**（unknown 或其他：选择器失配、按钮点击无效、弹窗遮挡等）：可告知用户需要人工修改发布配置
   - **页面改版**（页面结构变化导致选择器失效）：告知用户需要更新发布配置

2. 分析完成后，直接调用 report_to_user 汇报结果：
   - 如果是账号问题，明确说明是「登录态失效」「账号被封禁」「日额度已用完」等，建议用户去平台恢复或更换账号
   - 如果是内容问题，说明具体问题，建议用户检查文章内容后重试
   - 如果是平台问题，说明可能是平台服务异常，建议稍后重试
   - 如果是流程问题，说明需要人工更新发布配置

## 平台代码对照
tt=头条号, qeh=企鹅号, bjh=百家号, wxgzh=微信公众号, zh=知乎, xhs=小红书, sohu=搜狐号, wy=网易号, bili=哔哩哔哩, js=简书, dy=抖音, csdn=CSDN

## 常见失败原因
- **"等待 URL 超时"**：流程问题，页面跳转未发生
- **"按钮未找到"**：流程问题，选择器过时
- **"弹窗遮挡"**：流程问题，需要调整点击时机
- **"封面未设置"**：流程问题，封面设置步骤失败
- **"请选择 XX"**：流程问题，必填项未选择
- **"未实名认证"**：账号问题，需用户去平台实名认证
- **"账号已被封禁"**：账号问题，需用户处理
- **"登录态失效"**：账号问题，需用户重新登录
- **"发布成功检测超时"**：可能是流程问题或平台响应慢`;

/** 处理 publish_failed 事件入口 */
export async function handlePublishFailedEvent(event: {
  event_type: string;
  message: string;
  data?: any;
  user_id?: number | null;
}): Promise<void> {
  // 1. 只处理 publish_failed 事件
  if (event.event_type !== 'publish_failed') return;

  const data = event.data || {};
  const recordId: number | undefined = data.record_id;
  const platform: string | undefined = data.platform;
  const userId: number | null = event.user_id && event.user_id > 0 ? event.user_id : null;

  if (!recordId || !platform || !userId) {
    console.log('[Guardian] 跳过：缺少 record_id/platform/user_id', { recordId, platform, userId });
    return;
  }

  // 2. 检查用户是否启用守护
  // v3.9.1：用户显式停用（存在配置行且 enabled=false）时尊重用户选择——不回退管理员配置、不推送任何提醒（停用=静默）。
  //         仅当用户从未配置过（无配置行）时，才回退到管理员（level='1'）的守护配置（管理员代管场景）。
  //         停用/未启用时落库一条 skipped 日志，避免兜底扫描器（按 gl.id IS NULL 判定）反复挑中同一批旧失败记录
  //         ——这是"发布失败几小时后仍在弹窗提醒"的根因。
  const userConfig = await getGuardianConfig(userId);
  let config = userConfig || null;
  let configOwnerUserId = userId;
  if (!config?.enabled) {
    if (userConfig) {
      // 用户显式停用守护：静默落库跳过
      await createSkipGuardianLog(userId, recordId, platform, data, event.message, '用户显式停用守护');
      console.log(`[Guardian] user=${userId} 显式停用守护，record #${recordId} 落库跳过（不推送提醒）`);
      return;
    }
    // 无用户配置行 → 回退管理员配置（代管场景）
    const adminConfig = await getAdminGuardianConfig();
    if (adminConfig?.enabled) {
      console.log(`[Guardian] user=${userId} 未配置守护，回退使用管理员配置（admin userId=${adminConfig.user_id}）`);
      config = adminConfig;
      configOwnerUserId = Number(adminConfig.user_id);
    } else {
      // 用户与管理员均未启用守护：静默落库跳过
      await createSkipGuardianLog(userId, recordId, platform, data, event.message, '用户与管理员均未启用守护');
      console.log(`[Guardian] user=${userId} 及管理员均未启用守护，record #${recordId} 落库跳过（不推送提醒）`);
      return;
    }
  }

  // 3. 检查平台作用域
  const platforms: string[] = Array.isArray(config.platforms) ? config.platforms : [];
  if (platforms.length > 0 && !platforms.includes(platform)) {
    await createSkipGuardianLog(userId, recordId, platform, data, event.message, `平台 ${platform} 不在守护作用域内`);
    console.log(`[Guardian] 平台 ${platform} 不在守护作用域内，record #${recordId} 落库跳过`);
    return;
  }

  // 4. 防止并发重复处理
  if (processingRecords.has(recordId)) {
    console.log(`[Guardian] record #${recordId} 正在处理中，跳过`);
    return;
  }
  processingRecords.add(recordId);

  try {
    await processFailure({
      // v3.8.7：使用 configOwnerUserId（管理员）而非任务 userId（客户）
      // 这样守护日志记录到管理员名下，面板查询才能正确显示
      // 同时 wsBroadcast 推送也发给管理员（管理员能看到自己代管的所有失败处理）
      userId: configOwnerUserId,
      recordId,
      platform,
      failureMsg: event.message,
      errorMsg: data.error_msg || '',
      errorType: data.error_type || '',
    });
  } catch (err: any) {
    console.error(`[Guardian] 处理 record #${recordId} 异常:`, err.message);
  } finally {
    processingRecords.delete(recordId);
  }
}

/** v3.9.1：守护未启用/跳过时落库一条 skipped 日志，防止兜底扫描器反复挑中同一失败记录 */
async function createSkipGuardianLog(
  userId: number,
  recordId: number,
  platform: string,
  data: any,
  message: string,
  reason: string
): Promise<void> {
  try {
    const logId = await createGuardianLog({
      user_id: userId,
      record_id: recordId,
      platform,
      article_title: message.match(/"([^"]+)"/)?.[1] ?? undefined,
      failure_msg: data.error_msg || message,
      page_diagnostic: extractPageDiagnostic(data.error_msg) ?? undefined,
      error_type: data.error_type || '',
    });
    await updateGuardianLog(logId, {
      ai_action: 'skipped',
      ai_analysis: `未处理：${reason}`,
      report_status: 'skipped',
    });
  } catch (e: any) {
    console.error(`[Guardian] 落库 skipped 日志失败:`, e.message);
  }
}

/** 核心处理逻辑（只分析失败原因并提醒，不修改配置、不自动重试） */
async function processFailure(params: {
  userId: number;
  recordId: number;
  platform: string;
  failureMsg: string;
  errorMsg: string;
  errorType: string;
}): Promise<void> {
  const { userId, recordId, platform, failureMsg, errorMsg, errorType } = params;

  // 1. 创建守护日志
  const logId = await createGuardianLog({
    user_id: userId,
    record_id: recordId,
    platform,
    article_title: failureMsg.match(/"([^"]+)"/)?.[1] ?? undefined,
    failure_msg: errorMsg || failureMsg,
    page_diagnostic: extractPageDiagnostic(errorMsg) ?? undefined,
    error_type: errorType,
  });

  console.log(`[Guardian] 开始分析 record #${recordId} platform=${platform} logId=${logId}`);

  // 2. 推送"开始分析"事件
  wsBroadcast('guardian_update', {
    log_id: logId,
    record_id: recordId,
    platform,
    action: 'analyzing',
    message: `正在分析 ${platform} 平台发布失败原因...`,
  }, userId);

  // 3. 规则分类：账号问题（登录态失效/封禁/日额度耗尽）直接提醒，不依赖 AI，保证必达
  const cls = classifyPublishFailure(errorType, errorMsg, failureMsg);
  if (cls.category !== 'other') {
    const accountMsg = buildAccountFailureMessage(platform, recordId, cls.category, cls.title);
    console.log(`[Guardian] record #${recordId} 判定为账号类失败（${cls.category}），直接提醒`);
    await updateGuardianLog(logId, {
      ai_action: 'reported',
      ai_analysis: `规则识别：${cls.title}`,
      report_status: 'reported',
      report_msg: accountMsg,
    });
    wsBroadcast('guardian_report', {
      log_id: logId, record_id: recordId, platform,
      severity: cls.severity,
      message: accountMsg,
    }, userId);
    return;
  }

  // 4. 获取精灵模型配置（AI 分析其他类失败原因）
  const modelConfig = await getPetModelConfigWithKey(userId);
  if (!modelConfig || !modelConfig.api_key) {
    console.log('[Guardian] 精灵模型未配置，直接汇报原始失败原因');
    const fallbackMsg = buildFailureMessage(platform, recordId, errorType, errorMsg, failureMsg);
    await updateGuardianLog(logId, {
      ai_action: 'reported',
      ai_analysis: '精灵模型未配置，未做 AI 分析',
      report_status: 'reported',
      report_msg: fallbackMsg,
    });
    wsBroadcast('guardian_report', {
      log_id: logId, record_id: recordId, platform,
      severity: 'warning',
      message: fallbackMsg,
    }, userId);
    return;
  }

  // 5. 构造上下文消息
  const userMessage = `## 发布失败事件
- 平台：${platform}
- 记录 ID：${recordId}
- 失败消息：${failureMsg}
- 错误详情：${errorMsg}
- 错误类型：${errorType}

请分析失败原因并汇报。`;

  // 6. 工具调用循环（只读工具 + report_to_user，v3.9.1 起不再提供修改配置/触发重试工具）
  const toolContext: ToolContext = {
    userId, recordId, platform, logId, reportSent: false,
  };

  const messages: any[] = [{ role: 'user', content: userMessage }];
  let iterations = 0;
  const maxIterations = 6; // 最多 6 轮工具调用

  while (iterations < maxIterations) {
    iterations++;
    try {
      const result = await callModelStream({
        modelConfig: {
          platform: modelConfig.platform,
          model_name: modelConfig.model_name,
          api_key: modelConfig.api_key,
          base_url: modelConfig.base_url,
          max_tokens: modelConfig.max_tokens,
          temperature: modelConfig.temperature,
        },
        messages,
        systemPrompt: SYSTEM_PROMPT,
        tools: GUARDIAN_TOOLS,
        onDelta: () => {}, // 守护进程不需要流式输出
      });

      // 如果模型返回了工具调用
      if (result.toolCalls && result.toolCalls.length > 0) {
        // 把 assistant 的 tool_calls 消息加入历史
        messages.push({
          role: 'assistant',
          content: result.fullText || '',
          tool_calls: result.toolCalls,
        });

        // 执行每个工具调用
        for (const toolCall of result.toolCalls) {
          const toolResult = await executeToolCall(toolCall, toolContext);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
        continue;
      }

      // 模型返回了纯文本（分析完成，没有更多工具调用）
      await updateGuardianLog(logId, {
        ai_analysis: result.fullText,
        ai_action: toolContext.reportSent ? 'reported' : 'analyzed',
      });
      break;
    } catch (err: any) {
      console.error(`[Guardian] AI 分析第 ${iterations} 轮失败:`, err.message);
      await updateGuardianLog(logId, {
        ai_analysis: `AI 分析失败: ${err.message}`,
        ai_action: 'error',
      });
      // v3.8.7：改推 guardian_report 让用户可见
      // v3.9.0：冷却控制，同一用户+平台 30 分钟内不重复推送"分析异常"
      if (shouldReport(userId, platform, 'analysis_error')) {
        wsBroadcast('guardian_report', {
          log_id: logId,
          record_id: recordId,
          platform,
          severity: 'error',
          message: `❌ ${platform} 平台发布失败，AI 分析过程出错：${err.message}。请检查模型配置或网络后稍后重试。`,
        }, userId);
      }
      return;
    }
  }

  // 7. 如果 AI 没有发送汇报，发送默认汇报
  if (!toolContext.reportSent) {
    const reportMsg = buildFailureMessage(platform, recordId, errorType, errorMsg, failureMsg);
    await updateGuardianLog(logId, {
      report_status: 'reported',
      report_msg: reportMsg,
    });
    wsBroadcast('guardian_report', {
      log_id: logId, record_id: recordId, platform,
      severity: 'warning',
      message: reportMsg,
    }, userId);
  }

  console.log(`[Guardian] record #${recordId} 分析完成 (iterations=${iterations})`);
}

/**
 * v3.9.1：规则分类发布失败原因，优先识别账号类问题（登录态失效/被封禁/日额度耗尽）。
 * 优先使用桌面端回传的 error_type（account_login_expired / account_banned / account_limited），
 * 其次用关键词兜底（覆盖兜底扫描器等 error_type 不明确的路径）。
 */
function classifyPublishFailure(
  errorType: string,
  errorMsg: string,
  failureMsg: string
): { category: 'login_expired' | 'banned' | 'quota' | 'other'; title: string; severity: string } {
  const et = (errorType || '').toLowerCase();
  const combined = `${errorMsg || ''} ${failureMsg || ''}`;
  const lower = combined.toLowerCase();

  // 账号登录态失效（掉线/cookie过期/token失效/需重新扫码）
  if (
    et.includes('login_expired') ||
    /登录|未登录|登录态失效|登录已失效|登录过期|请重新登录|重新扫码|请扫码|login|sign ?in|session expired|token 过期|凭证过期/i.test(combined)
  ) {
    return { category: 'login_expired', title: '账号登录态失效', severity: 'error' };
  }

  // 账号被封禁/限制
  if (
    et.includes('banned') ||
    /封禁|封号|被封|账号异常|账号已被限制|限制登录|已冻结|冻结|banned|blocked|违规处罚/i.test(combined)
  ) {
    return { category: 'banned', title: '账号被封禁', severity: 'error' };
  }

  // 日额度/配额耗尽 / 限流
  if (
    et.includes('limited') || et.includes('quota') ||
    /上限|限额|额度|配额|限流|太频繁|过于频繁|次数已用完|今日已用完|rate limit|too many|quota|limited/i.test(combined)
  ) {
    return { category: 'quota', title: '当日发布额度已用完', severity: 'warning' };
  }

  return { category: 'other', title: '', severity: 'warning' };
}

/** 账号类失败的提醒消息模板 */
function buildAccountFailureMessage(
  platform: string,
  recordId: number,
  category: 'login_expired' | 'banned' | 'quota',
  title: string
): string {
  const map = {
    login_expired: {
      emoji: '🔑',
      detail: '该平台账号登录态已失效（掉线 / cookie 过期 / 需重新扫码），需要重新登录后才能继续发布。',
      suggest: '请到「自媒体账号管理」重新扫码登录该平台账号后重试。',
    },
    banned: {
      emoji: '🚫',
      detail: '该平台账号已被封禁 / 限制（违规、封号、账号异常），无法继续发布。',
      suggest: '请去平台后台申诉或更换可用账号后重试。',
    },
    quota: {
      emoji: '📉',
      detail: '该平台账号今日发布次数已达上限或被限流，暂时无法继续发布。',
      suggest: '请明天再试，或更换账号 / 调整配额后重试。',
    },
  };
  const m = map[category];
  return `${m.emoji} **${platform} 平台发布失败 · ${title}**

记录 ID: ${recordId}
原因：${m.detail}

${m.suggest}`;
}

/** 非账号类失败的兜底提醒消息模板 */
function buildFailureMessage(
  platform: string,
  recordId: number,
  errorType: string,
  errorMsg: string,
  failureMsg: string
): string {
  return `⚠️ **${platform} 平台发布失败**

记录 ID: ${recordId}
失败类型: ${errorType || '未知'}
错误摘要: ${(errorMsg || failureMsg).slice(0, 300)}

请根据失败原因处理（账号类问题请重新登录/更换账号，流程类问题请人工更新发布配置）后重试。`;
}

/** 工具调用上下文 */
interface ToolContext {
  userId: number;
  recordId: number;
  platform: string;
  logId: number;
  reportSent: boolean;
}

/** 执行工具调用 */
async function executeToolCall(toolCall: any, ctx: ToolContext): Promise<any> {
  const name = toolCall.function?.name;
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || '{}');
  } catch {
    return { error: '工具参数 JSON 解析失败' };
  }

  console.log(`[Guardian] 执行工具 ${name} args=${JSON.stringify(args).slice(0, 200)}`);

  switch (name) {
    case 'read_step_list':
      return await toolReadStepList(args.platform || ctx.platform);

    case 'get_account_status':
      return await toolGetAccountStatus(args.platform || ctx.platform, args.user_id || ctx.userId);

    case 'report_to_user':
      return await toolReportToUser(args.message, args.severity, ctx);

    default:
      return { error: `未知工具: ${name}` };
  }
}

/** 工具：读取 step_list */
async function toolReadStepList(platform: string): Promise<any> {
  const data = await getStepListByPlatform(platform);
  if (!data) return { error: `平台 ${platform} 暂无 step_list 配置` };
  return {
    platform,
    version: data.version,
    description: data.description,
    step_list: data.step_list,
  };
}

/** 工具：查询账号状态 */
async function toolGetAccountStatus(platform: string, userId: number): Promise<any> {
  try {
    const { query } = await import('../db');
    const result = await query(
      `SELECT id, platform, account_name, health_status, last_query_count, daily_limit,
              publish_fail_count, publish_daily_limit, last_publish_at, updated_at
       FROM platform_auth
       WHERE platform = $1 AND (user_id = $2 OR $2 = 0)
       ORDER BY updated_at DESC LIMIT 5`,
      [platform, userId]
    );
    if (result.rows.length === 0) {
      return { error: `未找到平台 ${platform} 的账号` };
    }
    return {
      platform,
      accounts: result.rows.map((r: any) => ({
        id: r.id,
        name: r.account_name,
        health_status: r.health_status,
        query_used: r.last_query_count,
        query_limit: r.daily_limit,
        publish_fail_count: r.publish_fail_count,
        publish_daily_limit: r.publish_daily_limit,
        last_publish_at: r.last_publish_at,
      })),
    };
  } catch (err: any) {
    return { error: `查询账号状态失败: ${err.message}` };
  }
}

/** 工具：汇报用户 */
async function toolReportToUser(message: string, severity: string, ctx: ToolContext): Promise<any> {
  ctx.reportSent = true;
  await updateGuardianLog(ctx.logId, {
    report_status: 'reported',
    report_msg: message,
  });
  wsBroadcast('guardian_report', {
    log_id: ctx.logId,
    record_id: ctx.recordId,
    platform: ctx.platform,
    severity,
    message,
  }, ctx.userId);
  return { success: true, message: '汇报已发送' };
}

/** 从错误消息中提取页面诊断信息 */
function extractPageDiagnostic(errorMsg: string): string | null {
  if (!errorMsg) return null;
  const markers = ['[页面诊断]', '[弹窗]', '[提示]', '[按钮]', '[页面文本]'];
  const lines = errorMsg.split('\n');
  const diagnosticLines = lines.filter(l => markers.some(m => l.includes(m)));
  return diagnosticLines.length > 0 ? diagnosticLines.join('\n') : null;
}

/**
 * 重试结果回调（当重试的 record 执行完成时调用）
 * 由 /content/publish/records/:id/result 路由在检测到守护重试时调用
 */
export async function handleRetryResult(params: {
  recordId: number;
  status: string; // success / failed
  errorMsg?: string;
}): Promise<void> {
  const { recordId, status, errorMsg } = params;
  const recentLogs = await getRecentGuardianLogsByRecord(recordId, 1);
  if (recentLogs.length === 0) return;

  const log = recentLogs[0];
  if (log.ai_action !== 'auto_retry' && log.ai_action !== 'auto_fixed') return;

  const userId = log.user_id;
  const platform = log.platform;

  if (status === 'success') {
    // 重试成功
    await updateGuardianLog(log.id, {
      retry_result: 'success',
      report_status: 'reported',
      report_msg: `✅ **${platform} 平台发布已自动修复成功**

记录 ID: ${recordId}
修复方案: ${log.ai_analysis || '自动修复'}
新版本: v${log.new_version}`,
    });
    wsBroadcast('guardian_report', {
      log_id: log.id,
      record_id: recordId,
      platform,
      severity: 'success',
      message: `✅ ${platform} 平台发布已自动修复成功（record #${recordId}）`,
    }, userId);
  } else {
    // 重试失败 → 自动回滚
    if (log.step_list_backup && log.old_version) {
      try {
        await deactivateStepListVersion(platform, log.new_version);
        await upsertStepListWithGuardian(
          platform,
          log.old_version,
          log.step_list_backup,
          `回滚到 v${log.old_version}（自动修复失败）`,
          'guardian',
          log.id,
          `自动回滚：重试失败 ${errorMsg?.slice(0, 100) || ''}`
        );
        console.log(`[Guardian] 已自动回滚 ${platform} v${log.new_version} → v${log.old_version}`);
      } catch (err: any) {
        console.error(`[Guardian] 回滚失败:`, err.message);
      }
    }

    await updateGuardianLog(log.id, {
      retry_result: 'failed',
      report_status: 'reported',
      report_msg: `❌ **${platform} 平台自动修复失败，已回滚配置**

记录 ID: ${recordId}
失败原因: ${(errorMsg || '').slice(0, 200)}
配置已回滚: v${log.new_version} → v${log.old_version}

需要人工协助排查。`,
    });
    wsBroadcast('guardian_report', {
      log_id: log.id,
      record_id: recordId,
      platform,
      severity: 'error',
      message: `❌ ${platform} 平台自动修复失败，已回滚配置，需要人工协助`,
    }, userId);
  }
}

// ==================== v3.8.7 兜底扫描定时任务 ====================

let sweeperTimer: NodeJS.Timeout | null = null;
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟扫描一次
const SWEEPER_BATCH_LIMIT = 20; // 每次最多处理 20 条，避免突发流量
// v3.9.0：心跳汇报间隔从 1 小时延长到 24 小时（用户反馈汇报太频繁）
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastHeartbeatTs = 0;

// v3.9.0：汇报频率冷却控制 —— 同一用户+平台+汇报类型在冷却期内不重复推送
//   适用于过程性汇报（未启用提醒、模型未配置、分析异常），处理结果汇报（成功/失败/需协助）不受限
const REPORT_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟冷却期
const reportCooldownMap = new Map<string, number>(); // key: `${userId}:${platform}:${reportType}` → lastTs

/**
 * v3.9.0 检查汇报是否在冷却期内
 * @returns true=允许推送，false=冷却期内跳过
 */
function shouldReport(userId: number | null, platform: string, reportType: string): boolean {
  if (!userId) return true;
  const key = `${userId}:${platform}:${reportType}`;
  const now = Date.now();
  const lastTs = reportCooldownMap.get(key) || 0;
  if (now - lastTs < REPORT_COOLDOWN_MS) {
    console.log(`[Guardian] 汇报冷却中，跳过: ${key}（距上次 ${Math.round((now - lastTs) / 1000)}s）`);
    return false;
  }
  reportCooldownMap.set(key, now);
  return true;
}

/**
 * v3.8.7 守护进程兜底扫描器
 *
 * 背景：v3.8.7 修复前，桌面端 publishWorker 失败时不上报 publish_failed 事件，
 * 导致已存在的失败记录没被守护进程处理。此扫描器作为兜底：
 *   - 每 5 分钟扫描最近 1 小时内失败但未被守护处理的 publish_record
 *   - 主动调用 handlePublishFailedEvent 触发分析
 *
 * 与触发链路的关系：
 *   - 主链路：Worker 上报 publish_failed 事件 → handlePublishFailedEvent（实时）
 *   - 主链路：/publish/records/:id/result 收到 failed 状态 → handlePublishFailedEvent（v3.8.7 新增，近实时）
 *   - 兜底链路：本扫描器 → handlePublishFailedEvent（5 分钟内补漏）
 *
 * 幂等保证：handlePublishFailedEvent 内部已有 processingRecords 并发锁 + 重试次数检查
 */
async function sweepFailedRecords(): Promise<void> {
  try {
    // v3.8.7：修复扫描条件过严导致"有失败记录但守护不处理"的问题
    // 原问题 1：只扫最近 1 小时，超过 1 小时的失败记录全部漏掉 → 改为 24 小时
    // 原问题 2：只匹配 status='failed'，漏掉 'login_expired' 和 'banned' → 三种失败状态都匹配
    // 原问题 3：publish_task.user_id 可能为 null（旧数据），导致守护无法确定汇报给谁
    //          → 保留 user_id > 0 过滤，但放宽 user_id IS NOT NULL（null 会被 > 0 过滤）
    const res = await query(
      `SELECT pr.id, pr.platform, pr.task_id, pt.user_id, pr.error_msg, pr.status
       FROM publish_record pr
       JOIN publish_task pt ON pt.id = pr.task_id
       LEFT JOIN publish_guardian_log gl ON gl.record_id = pr.id
       WHERE pr.status IN ('failed', 'login_expired', 'banned')
         AND pt.user_id IS NOT NULL AND pt.user_id > 0
         AND pr.create_time > NOW() - INTERVAL '24 hours'
         AND gl.id IS NULL
       ORDER BY pr.create_time DESC
       LIMIT $1`,
      [SWEEPER_BATCH_LIMIT]
    );

    if (res.rows.length > 0) {
      console.log(`[Guardian Sweeper] 发现 ${res.rows.length} 条未处理的失败记录，开始触发守护进程`);

      for (const row of res.rows) {
        const userId = Number(row.user_id);
        const recordId = Number(row.id);
        const platform = row.platform;
        const errorMsg = row.error_msg || '';

        if (!userId || !recordId || !platform) continue;

        // 串行触发，避免并发冲击（每条间隔 500ms）
        void handlePublishFailedEvent({
          event_type: 'publish_failed',
          message: `[${platform}] record #${recordId} 发布失败（兜底扫描触发）: ${errorMsg}`.slice(0, 500),
          data: {
            record_id: recordId,
            platform,
            error_msg: errorMsg,
            error_type: 'sweeper_retry',
          },
          user_id: userId,
        }).catch((e) => {
          console.error(`[Guardian Sweeper] 触发 record=${recordId} 失败:`, e.message);
        });

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // v3.8.7：心跳汇报 —— 每小时向所有已启用守护的用户推送"守护在线"状态
    // 解决用户"感知不到守护进程在运行"的问题：即使没有失败事件，也让用户知道守护在后台工作
    const now = Date.now();
    if (now - lastHeartbeatTs >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatTs = now;
      await sendGuardianHeartbeat(res.rows.length);
    }
  } catch (e: any) {
    console.error('[Guardian Sweeper] 扫描异常:', e.message);
  }
}

/**
 * v3.8.7 守护进程心跳汇报
 * 向所有已启用守护的用户推送"守护在线"状态，让用户感知守护进程在运行
 *
 * 心跳内容包括：
 * - 守护进程状态（在线）
 * - 本次扫描发现的失败记录数
 * - 最近 1 小时处理的守护日志数
 */
async function sendGuardianHeartbeat(sweptFailedCount: number): Promise<void> {
  try {
    // 查询所有已启用守护的用户
    const configRes = await query(
      `SELECT user_id, platforms FROM publish_guardian_config WHERE enabled = true`
    );
    if (configRes.rows.length === 0) {
      console.log('[Guardian Heartbeat] 无已启用守护的用户，跳过心跳');
      return;
    }

    // 统计最近 1 小时的守护日志数（全局，用于心跳汇报）
    const statsRes = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_day,
         COUNT(*) FILTER (WHERE ai_action = 'auto_fixed' AND created_at > NOW() - INTERVAL '24 hours') AS auto_fixed_24h
       FROM publish_guardian_log`
    );
    const stats = statsRes.rows[0] || {};
    const lastHour = Number(stats.last_hour || 0);
    const lastDay = Number(stats.last_day || 0);
    const autoFixed24h = Number(stats.auto_fixed_24h || 0);

    console.log(`[Guardian Heartbeat] 向 ${configRes.rows.length} 个用户推送心跳（最近1小时处理${lastHour}条，24小时${lastDay}条，自动修复${autoFixed24h}条）`);

    for (const row of configRes.rows) {
      const userId = Number(row.user_id);
      const platforms = row.platforms;
      const platformList = Array.isArray(platforms) && platforms.length > 0
        ? platforms.join('、')
        : '全部平台';

      wsBroadcast('guardian_report', {
        log_id: 0,
        record_id: null,
        platform: 'system',
        severity: 'info',
        message: `🛡️ 守护进程心跳 · 在线运行中\n\n守护状态：✅ 正常运行\n作用范围：${platformList}\n本次扫描：发现 ${sweptFailedCount} 条未处理失败记录\n最近 1 小时：处理 ${lastHour} 条守护日志\n最近 24 小时：处理 ${lastDay} 条（其中自动修复 ${autoFixed24h} 条）\n\n守护进程正在后台持续监控发布失败事件，请放心。`,
      }, userId);
    }
  } catch (e: any) {
    console.error('[Guardian Heartbeat] 心跳推送失败:', e.message);
  }
}

/**
 * 启动守护进程兜底扫描器
 * 在服务器启动时调用（index.ts start()）
 */
export function startGuardianSweeper(): void {
  if (sweeperTimer) {
    console.log('[Guardian Sweeper] 已在运行，跳过');
    return;
  }
  console.log(`[Guardian Sweeper] 启动兜底扫描器，间隔 ${SWEEPER_INTERVAL_MS / 1000}s`);
  // 首次延迟 60s 启动（避免与服务器启动 migrate 等任务冲突）
  setTimeout(() => {
    // v3.8.7：首次启动时立即推送一次心跳（lastHeartbeatTs=0，会触发心跳逻辑）
    // 让用户在服务重启后 60s 内就能看到"守护在线"消息，不用等 1 小时
    void sweepFailedRecords();
    sweeperTimer = setInterval(() => {
      void sweepFailedRecords();
    }, SWEEPER_INTERVAL_MS);
  }, 60 * 1000);
}
