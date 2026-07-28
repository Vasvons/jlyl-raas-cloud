/**
 * v3.8 发布守护进程（Publish Guardian）
 *
 * 设计目标：
 * - 监听 publish_failed 事件，自动分析失败原因
 * - 修改 step-list JSON 配置（带版本控制 + 备份 + 回滚）
 * - 触发重试 → 验证结果 → 成功汇报/失败回滚
 * - 账号问题（被封/掉线）直接汇报用户，不修改配置
 * - 单条记录最多自动重试 max_retry_per_record 次（默认 2）
 *
 * 调用入口：
 *   handlePublishFailedEvent(event) —— 由 /content/flywheel/event-logs 路由调用
 *
 * 工具调用循环：
 *   AI 通过 function calling 调用以下工具完成分析+修复：
 *   - read_publish_log：读取失败日志详情
 *   - read_step_list：读取当前平台 JSON 配置
 *   - update_step_list：修改 JSON 配置（自动备份旧版本）
 *   - retry_publish：触发重试
 *   - get_account_status：查询账号健康状态
 *   - report_to_user：发送汇报消息
 */
import axios from 'axios';
import { callModelStream } from './pet/petChatService';
import {
  getGuardianConfig, createGuardianLog, updateGuardianLog,
  getRecentGuardianLogsByRecord, getStepListByPlatform,
  upsertStepListWithGuardian, deactivateStepListVersion,
  getPetModelConfigWithKey,
} from '../repository';
import { wsBroadcast } from '../wsServer';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_SECRET = process.env.WORKER_SECRET || 'dev-secret';

/** 处理中的 record_id 集合，防止并发重复处理 */
const processingRecords = new Set<number>();

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
      name: 'update_step_list',
      description: '修改指定平台的发布步骤配置。系统会自动备份旧版本，若后续重试失败可自动回滚。修改后版本号自动递增（如 1.7.7 → 1.7.8）。',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: '平台代码' },
          step_list: { type: 'object', description: '完整的 step_list JSON 对象（必须包含 steps 数组）' },
          description: { type: 'string', description: '修改说明，简述改了什么' },
        },
        required: ['platform', 'step_list', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_publish',
      description: '触发指定发布记录重试。系统会把 record 状态重置为 pending，Worker 下次轮询会拉取执行。',
      parameters: {
        type: 'object',
        properties: {
          record_id: { type: 'number', description: '发布记录 ID' },
        },
        required: ['record_id'],
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
      description: '向用户发送汇报消息。用于：1) 成功修复后通知用户；2) 账号问题需用户处理；3) 连续失败需用户协助。',
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
const SYSTEM_PROMPT = `你是发布守护进程，负责分析自媒体平台发布失败的原因并自动修复。

## 你的工作流程
1. 分析失败日志和页面诊断信息，判断失败原因类型：
   - **流程问题**（选择器失配、按钮点击无效、URL 超时、弹窗遮挡）：可自动修复
   - **账号问题**（被封禁、掉线、配额已满）：需用户处理，不能自动修复
   - **内容问题**（标题超长、正文为空、图片缺失）：需用户检查内容
   - **平台变更**（页面改版、API 变化）：尝试修复选择器，失败则汇报用户

2. 如果是流程问题：
   - 调用 read_step_list 读取当前配置
   - 分析失败日志中的选择器、URL、按钮文本，找出失配点
   - 调用 update_step_list 修改 JSON 配置（只改失败的部分，不要重写整个文件）
   - 调用 retry_publish 触发重试
   - 等待重试结果（系统会自动推送）
   - 如果重试成功，调用 report_to_user 汇报"已修复"
   - 如果重试失败，回滚配置（系统自动处理），调用 report_to_user 汇报"需协助"

3. 如果是账号问题：直接调用 report_to_user，说明需要用户处理（如"账号被封禁，请恢复后重试"）

4. 如果是内容问题：调用 report_to_user，说明需要用户检查文章内容

## 重要规则
- **修改要最小化**：只改失败相关的 step，不要重写整个 JSON
- **版本号自动递增**：系统会自动处理版本号，你不需要手动指定
- **备份与回滚**：系统会自动备份旧版本，重试失败会自动回滚
- **单条记录最多重试 2 次**：超过则汇报"连续修复失败，需人工协助"
- **不要猜测**：如果无法确定原因，调用 report_to_user 汇报"需要人工协助"，附上失败日志摘要

## 平台代码对照
tt=头条号, qeh=企鹅号, bjh=百家号, wxgzh=微信公众号, zh=知乎, xhs=小红书, sohu=搜狐号, wy=网易号, bili=哔哩哔哩, js=简书, dy=抖音, csdn=CSDN

## 常见失败模式与修复策略
- **"等待 URL 超时"**：wait_for_url 的 wait_until 改为 domcontentloaded；或 timeout 增加；或 value 匹配模式调整
- **"按钮未找到"**：选择器过时，需要根据页面诊断中的按钮文本更新选择器
- **"弹窗遮挡"**：在点击前增加关闭弹窗的步骤
- **"封面未设置"**：封面设置步骤失败，可能是选择器失配或弹窗阻塞
- **"请选择 XX"**：必填项未选择，需要增加选择步骤
- **"未实名认证"**：账号问题，需用户去平台实名认证，不能自动修复
- **"账号已被封禁"**：账号问题，需用户处理`;

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
  const config = await getGuardianConfig(userId);
  if (!config?.enabled) return;

  // 3. 检查平台作用域
  const platforms: string[] = Array.isArray(config.platforms) ? config.platforms : [];
  if (platforms.length > 0 && !platforms.includes(platform)) {
    console.log(`[Guardian] 平台 ${platform} 不在守护作用域内，跳过`);
    return;
  }

  // 4. 检查重试次数（单条记录最多 max_retry_per_record 次）
  const recentLogs = await getRecentGuardianLogsByRecord(recordId, 10);
  const autoRetryCount = recentLogs.filter(l => l.ai_action === 'auto_fixed' || l.ai_action === 'auto_retry').length;
  if (autoRetryCount >= (config.max_retry_per_record || 2)) {
    console.log(`[Guardian] record #${recordId} 已达最大重试次数 ${config.max_retry_per_record}，跳过`);
    return;
  }

  // 5. 防止并发重复处理
  if (processingRecords.has(recordId)) {
    console.log(`[Guardian] record #${recordId} 正在处理中，跳过`);
    return;
  }
  processingRecords.add(recordId);

  try {
    await processFailure({
      userId,
      recordId,
      platform,
      failureMsg: event.message,
      errorMsg: data.error_msg || '',
      errorType: data.error_type || '',
      maxRetry: config.max_retry_per_record || 2,
      autoFix: config.auto_fix !== false,
      autoRetry: config.auto_retry !== false,
    });
  } catch (err: any) {
    console.error(`[Guardian] 处理 record #${recordId} 异常:`, err.message);
  } finally {
    processingRecords.delete(recordId);
  }
}

/** 核心处理逻辑 */
async function processFailure(params: {
  userId: number;
  recordId: number;
  platform: string;
  failureMsg: string;
  errorMsg: string;
  errorType: string;
  maxRetry: number;
  autoFix: boolean;
  autoRetry: boolean;
}): Promise<void> {
  const { userId, recordId, platform, failureMsg, errorMsg, errorType, autoFix, autoRetry } = params;

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

  console.log(`[Guardian] 开始处理 record #${recordId} platform=${platform} logId=${logId}`);

  // 2. 推送"开始分析"事件
  wsBroadcast('guardian_update', {
    log_id: logId,
    record_id: recordId,
    platform,
    action: 'analyzing',
    message: `正在分析 ${platform} 平台发布失败原因...`,
  }, userId);

  // 3. 获取精灵模型配置
  const modelConfig = await getPetModelConfigWithKey(userId);
  if (!modelConfig || !modelConfig.api_key) {
    console.error('[Guardian] 精灵模型未配置，无法进行 AI 分析');
    await updateGuardianLog(logId, {
      ai_action: 'skipped',
      ai_analysis: '精灵模型未配置，无法进行 AI 分析',
      report_status: 'reported',
      report_msg: '精灵模型未配置，发布守护无法工作。请在管理端配置精灵底座模型。',
    });
    wsBroadcast('guardian_update', {
      log_id: logId, record_id: recordId, platform,
      action: 'error',
      message: '精灵模型未配置，无法进行 AI 分析',
    }, userId);
    return;
  }

  // 4. 构造上下文消息
  const userMessage = `## 发布失败事件
- 平台：${platform}
- 记录 ID：${recordId}
- 失败消息：${failureMsg}
- 错误详情：${errorMsg}
- 错误类型：${errorType}

请分析失败原因并采取行动。`;

  // 5. 工具调用循环
  const toolContext: ToolContext = {
    userId, recordId, platform, logId, autoFix, autoRetry,
    stepListBackup: null,
    oldVersion: null,
    newVersion: null,
    retryTriggered: false,
    reportSent: false,
  };

  const messages: any[] = [{ role: 'user', content: userMessage }];
  let iterations = 0;
  const maxIterations = 8; // 最多 8 轮工具调用

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
        ai_action: toolContext.reportSent ? 'reported' : (toolContext.retryTriggered ? 'auto_retry' : 'analyzed'),
      });
      break;
    } catch (err: any) {
      console.error(`[Guardian] AI 分析第 ${iterations} 轮失败:`, err.message);
      await updateGuardianLog(logId, {
        ai_analysis: `AI 分析失败: ${err.message}`,
        ai_action: 'error',
      });
      wsBroadcast('guardian_update', {
        log_id: logId, record_id: recordId, platform,
        action: 'error',
        message: `AI 分析失败: ${err.message}`,
      }, userId);
      return;
    }
  }

  // 6. 如果 AI 没有发送汇报，发送默认汇报
  if (!toolContext.reportSent) {
    const reportMsg = `⚠️ **${platform} 平台发布失败**

记录 ID: ${recordId}
失败原因: ${errorType || '未知'}
错误摘要: ${(errorMsg || failureMsg).slice(0, 200)}

AI 已分析完成，但未能自动修复。请人工检查。`;

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

  console.log(`[Guardian] record #${recordId} 处理完成 (iterations=${iterations})`);
}

/** 工具调用上下文 */
interface ToolContext {
  userId: number;
  recordId: number;
  platform: string;
  logId: number;
  autoFix: boolean;
  autoRetry: boolean;
  stepListBackup: any | null;
  oldVersion: string | null;
  newVersion: string | null;
  retryTriggered: boolean;
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

    case 'update_step_list':
      if (!ctx.autoFix) {
        return { error: '用户未启用自动修复（auto_fix=false），不能修改 step_list' };
      }
      return await toolUpdateStepList(args.platform || ctx.platform, args.step_list, args.description, ctx);

    case 'retry_publish':
      if (!ctx.autoRetry) {
        return { error: '用户未启用自动重试（auto_retry=false），不能触发重试' };
      }
      return await toolRetryPublish(args.record_id || ctx.recordId, ctx);

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

/** 工具：更新 step_list（带备份） */
async function toolUpdateStepList(
  platform: string,
  newStepList: any,
  description: string,
  ctx: ToolContext
): Promise<any> {
  // 1. 读取当前配置作为备份
  const current = await getStepListByPlatform(platform);
  if (!current) {
    return { error: `平台 ${platform} 暂无 step_list 配置，无法更新` };
  }

  // 2. 校验新配置
  if (!newStepList || !Array.isArray(newStepList.steps)) {
    return { error: 'step_list 必须包含 steps 数组' };
  }

  // 3. 记录备份
  ctx.stepListBackup = current.step_list;
  ctx.oldVersion = current.version;

  // 4. 计算新版本号（自动递增 patch 版本）
  const newVersion = incrementVersion(current.version || '1.0.0');
  ctx.newVersion = newVersion;

  // 5. 保留新配置的元信息
  const finalStepList = {
    ...newStepList,
    platform,
    version: newVersion,
  };

  // 6. 软删除旧版本
  await deactivateStepListVersion(platform, current.version);

  // 7. 写入新版本
  const id = await upsertStepListWithGuardian(
    platform,
    newVersion,
    finalStepList,
    description,
    'guardian',
    ctx.logId,
    description
  );

  // 8. 更新守护日志
  await updateGuardianLog(ctx.logId, {
    old_version: current.version,
    new_version: newVersion,
    step_list_backup: current.step_list,
    step_list_new: finalStepList,
    ai_action: 'auto_fixed',
  });

  // 9. 推送 WS 事件
  wsBroadcast('guardian_update', {
    log_id: ctx.logId,
    record_id: ctx.recordId,
    platform,
    action: 'fixed',
    message: `已修改 ${platform} 配置 v${current.version} → v${newVersion}：${description}`,
  }, ctx.userId);

  return {
    success: true,
    old_version: current.version,
    new_version: newVersion,
    id,
    message: `配置已更新（v${current.version} → v${newVersion}），旧版本已备份可回滚`,
  };
}

/** 工具：触发重试 */
async function toolRetryPublish(recordId: number, ctx: ToolContext): Promise<any> {
  try {
    // 调用云端 API 重置 record 为 pending
    const resp = await axios.post(
      `${SERVER_URL}/content/publish/records/${recordId}/retry`,
      {},
      { headers: { 'X-Worker-Secret': WORKER_SECRET }, timeout: 10000 }
    );
    ctx.retryTriggered = true;
    await updateGuardianLog(ctx.logId, {
      ai_action: 'auto_retry',
      retry_count: 1,
    });
    wsBroadcast('guardian_update', {
      log_id: ctx.logId,
      record_id: recordId,
      platform: ctx.platform,
      action: 'retrying',
      message: `已触发 record #${recordId} 重试，等待 Worker 拉取执行...`,
    }, ctx.userId);
    return { success: true, message: `已触发重试，Worker 将在 30 秒内拉取执行` };
  } catch (err: any) {
    return { error: `触发重试失败: ${err.message}` };
  }
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

/** 版本号递增（patch +1） */
function incrementVersion(version: string): string {
  const parts = version.split('.').map(p => parseInt(p, 10) || 0);
  if (parts.length < 3) {
    while (parts.length < 3) parts.push(0);
  }
  parts[2] += 1;
  return parts.join('.');
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
