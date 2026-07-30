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
import { query } from '../db';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const WORKER_SECRET = process.env.WORKER_SECRET || 'dev-secret';

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
const SYSTEM_PROMPT = `你是发布守护进程，负责自动分析自媒体平台发布失败的原因并自动修复。你是自动化系统，不是客服，不要问用户问题，直接采取行动。

## 核心原则（最重要）
- **你是执行者，不是咨询者**：分析失败原因后，直接调用工具修复，不要问用户"是否需要修复"或"应该怎么处理"
- **默认能修就修**：流程问题必须尝试自动修复（read_step_list → update_step_list → retry_publish），只有账号问题和内容问题才汇报用户
- **不要让用户代劳**：你是守护进程，用户期望你自动解决问题，而不是把问题抛回给用户
- **只有以下情况才汇报"需协助"**：① 连续修复 2 次仍失败 ② 账号被封禁/掉线 ③ 内容违规/为空 ④ 确实无法判断原因
- **禁止提问**：不要在汇报中问"您希望怎么处理"之类的问题，要么报告"已修复"，要么报告"需协助（附原因）"

## 你的工作流程
1. 分析失败日志和页面诊断信息，判断失败原因类型：
   - **流程问题**（选择器失配、按钮点击无效、URL 超时、弹窗遮挡）：必须自动修复
   - **账号问题**（被封禁、掉线、配额已满）：需用户处理，不能自动修复
   - **内容问题**（标题超长、正文为空、图片缺失）：需用户检查内容
   - **平台变更**（页面改版、API 变化）：尝试修复选择器，失败则汇报用户

2. 如果是流程问题（必须自动修复，不要问用户）：
   - 调用 read_step_list 读取当前配置
   - 分析失败日志中的选择器、URL、按钮文本，找出失配点
   - 调用 update_step_list 修改 JSON 配置（只改失败的部分，不要重写整个文件）
   - 调用 retry_publish 触发重试
   - 等待重试结果（系统会自动推送）
   - 如果重试成功，调用 report_to_user 汇报"已修复"
   - 如果重试失败，回滚配置（系统自动处理），调用 report_to_user 汇报"需协助"

3. 如果是账号问题：直接调用 report_to_user，说明需要用户处理（如"账号被封禁，请恢复后重试"），不要问用户要不要处理

4. 如果是内容问题：调用 report_to_user，说明需要用户检查文章内容，不要问用户要不要检查

## 重要规则
- **修改要最小化**：只改失败相关的 step，不要重写整个 JSON
- **版本号自动递增**：系统会自动处理版本号，你不需要手动指定
- **备份与回滚**：系统会自动备份旧版本，重试失败会自动回滚
- **单条记录最多重试 2 次**：超过则汇报"连续修复失败，需人工协助"
- **不要猜测**：如果无法确定原因，调用 report_to_user 汇报"需要人工协助"，附上失败日志摘要
- **工具调用失败时**：如果某个工具返回 error，不要直接汇报用户"无法连接"，应分析错误原因并尝试其他方案。例如 retry_publish 失败可重试一次，update_step_list 失败可检查参数格式

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
  // v3.8.7：修复"管理员开启了守护但系统提示未启用"的问题
  // 根因：管理员帮客户创建发布任务时，publish_task.user_id 是客户的 id
  //       失败事件携带的是客户的 userId，查守护配置查的是客户的（enabled=false）
  //       但管理员开启守护保存到的是管理员自己的 userId
  // 修复：如果当前 userId 没开启守护，回退查找管理员（level='1'）的守护配置
  //       管理员的守护配置对所有用户的发布任务生效（符合 RaaS 平台管理员代管场景）
  let config = await getGuardianConfig(userId);
  let configOwnerUserId = userId;
  if (!config?.enabled) {
    // 查找管理员（level='1'）的守护配置
    const adminConfig = await getAdminGuardianConfig();
    if (adminConfig?.enabled) {
      console.log(`[Guardian] user=${userId} 未启用守护，回退使用管理员配置（admin userId=${adminConfig.user_id}）`);
      config = adminConfig;
      configOwnerUserId = Number(adminConfig.user_id);
    }
  }
  if (!config?.enabled) {
    // v3.8.7：守护未启用时不再静默 return，而是推一条 guardian_report 提醒用户
    // 避免用户困惑"守护运行中但什么也不汇报"——实际是开关没开
    console.log(`[Guardian] user=${userId} 及管理员均未启用守护，跳过 record #${recordId}（推送提醒）`);
    wsBroadcast('guardian_report', {
      log_id: 0,
      record_id: recordId,
      platform,
      severity: 'info',
      message: `⚠️ 发布守护进程未启用：${platform} 平台 record #${recordId} 发布失败，但守护开关未开启，未自动处理。请到「精灵设置 → 自动化守护」开启守护开关。`,
    }, userId);
    return;
  }

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
      // v3.8.7：使用 configOwnerUserId（管理员）而非任务 userId（客户）
      // 这样守护日志记录到管理员名下，面板查询才能正确显示
      // 同时 wsBroadcast 推送也发给管理员（管理员能看到自己代管的所有失败处理）
      userId: configOwnerUserId,
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
    // v3.8.7：改推 guardian_report（而非 guardian_update），让桌面端能收到可见提示
    wsBroadcast('guardian_report', {
      log_id: logId,
      record_id: recordId,
      platform,
      severity: 'error',
      message: `❌ ${platform} 平台发布失败，但精灵模型未配置，守护进程无法自动分析。请在「设置 → 精灵设置 → 精灵底座」配置 AI 模型后，守护才能自动修复。`,
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
      // v3.8.7：改推 guardian_report 让用户可见
      wsBroadcast('guardian_report', {
        log_id: logId,
        record_id: recordId,
        platform,
        severity: 'error',
        message: `❌ ${platform} 平台发布失败，AI 分析过程出错：${err.message}。请检查模型配置或网络后稍后重试。`,
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
    // v3.8.7：修复 retry_publish 调用失败的问题
    // 原实现走 HTTP 回调 ${SERVER_URL}/content/publish/records/${recordId}/retry
    // 但该接口需要 JWT 鉴权（authMiddleware），守护进程只有 X-Worker-Secret
    // 当服务器未设置 WORKER_SECRET 环境变量时，auth.ts 中 WORKER_SECRET=''，
    // worker secret 认证被跳过，导致 401 拒绝
    // 修复：守护进程是云端内部服务，直接调用 retryPublishRecords 函数，不走 HTTP
    const { retryPublishRecords } = await import('../repository');
    const result = await retryPublishRecords(undefined, recordId);
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
    return { success: true, message: `已触发重试（重置 ${result.reset_count} 条记录），Worker 将在 30 秒内拉取执行` };
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

// ==================== v3.8.7 兜底扫描定时任务 ====================

let sweeperTimer: NodeJS.Timeout | null = null;
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟扫描一次
const SWEEPER_BATCH_LIMIT = 20; // 每次最多处理 20 条，避免突发流量
// v3.8.7：心跳汇报间隔（每小时一次），让用户感知守护进程在线
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
let lastHeartbeatTs = 0;

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
