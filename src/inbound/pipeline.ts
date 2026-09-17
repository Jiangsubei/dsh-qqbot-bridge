/**
 * dsh-qqbot-bridge: 入站管线 / 状态机
 *
 * 负责接收 QQ 单聊消息并依次通过分阶段决策管线：
 * 1. 交互拦截：审批 (Approval) → 提问 (Question)；
 * 2. 命令调度：分页导航 → 斜杠命令执行；
 * 3. 会话检查：未选中态自动引导新建会话或状态提示；
 * 4. 附件处理：多媒体附件落盘并注入上下文；
 * 5. 最终转发：将 turn 投递给受控的 DSH Live Agent。
 *
 * 遵循严格分层架构，入站消息处理被拆解为独立的纯函数与拦截阶段。
 */

import type {
  CommandContext,
  InboundDeps,
  InboundPipeline,
  OutboundTarget,
  QqC2CMessageEvent,
} from '../types/index.js';
import { formatUnknownCommandReply, isPagingCommand, isSlashCommand, parseCommand } from '../commands/parse.js';
import { t } from '../i18n/index.js';

/** 用户可见错误提示的最大长度（避免刷屏） */
const ERROR_NOTICE_MAX_CHARS = 200;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 入站 openid：优先 `user_openid`，退化到 `id`（两者都缺则忽略该事件） */
function extractOpenid(event: QqC2CMessageEvent): string {
  return event.author?.user_openid ?? event.author?.id ?? '';
}

function buildOutboundTarget(event: QqC2CMessageEvent, openid: string): OutboundTarget {
  const target: OutboundTarget = { openid };
  if (event.id) target.msgId = event.id;
  return target;
}

export function createInboundPipeline(deps: InboundDeps): InboundPipeline {
  const { approval, question, paging, commands, control, media, reply, logger } = deps;
  /** D36：`allow_create_session` 开关（缺省开启） */
  const allowCreateSession = deps.allowCreateSession !== false;

  /** 回执发送失败只记日志（不得让二次失败冒泡成未处理异常） */
  async function safeReply(target: OutboundTarget, text: string): Promise<void> {
    try {
      await reply(target, text);
    } catch (err) {
      logger.error('[inbound] 回执发送失败：', err);
    }
  }

  /**
   * D36：会话的落点解析（未选中态的**首次直发引导**）。
   *
   * 处理顺序：
   *   1. 已有控制目标 → 直接用；
   *   2. 开关关闭（`allow_create_session=false`）→ 退回 D19/D27：只回执、不转发；
   *   3. 未选中 → 调 `control.createSession(openid)`：**有工作区作用域就落在该作用域**，
   *      没有则落在默认工作区 `$DSH_HOME/workspace/default`（惰性 `mkdir -p` + 注册）；
   *   4. 新建成功后回一条**只报工作区名**的短提示（设计规约：不带 session id），
   *      并把业务交给调用方把这条消息作为该会话的首个 prompt 转发。
   *
   * 返回 `null` 表示**消息到此为止**（已回执或已失败），调用方不得再转发。
   */
  async function resolveSessionId(openid: string, target: OutboundTarget): Promise<string | null> {
    const current = await control.getTarget(openid);
    if (current.sessionId) return current.sessionId;

    if (!allowCreateSession) {
      await safeReply(target, t('common.noTarget'));
      return null;
    }

    const created = await control.createSession(openid);
    if (!created.ok) {
      logger.warn(`[inbound] 未选中态自动新建会话失败（${created.code}）：${created.reason}`);
      await safeReply(
        target,
        `${t('inbound.autoCreateFailed')}${t('inbound.autoCreateReason', {
          reason: truncate(created.reason, ERROR_NOTICE_MAX_CHARS),
        })}`,
      );
      return null;
    }

    const workspace = await control.getWorkspace(created.workspaceId);
    const label = workspace?.title || workspace?.path || created.workspaceId;
    // **必须先登记 sessionId → openid 映射**，否则本条消息的回答会被 turn-router 丢弃
    //（`turn-router` 只认 `openidOf(sessionId)`；见 `InboundDeps.onSessionSelected` 的说明）。
    try {
      deps.onSessionSelected?.(created.sessionId, openid);
    } catch (err) {
      logger.error('[inbound] onSessionSelected 钩子失败：', err);
    }
    await safeReply(target, t('inbound.autoCreateDone', { workspace: label }));
    logger.info(`[inbound] 未选中态自动新建会话 sessionId=${created.sessionId} workspace=${created.workspaceId}`);
    return created.sessionId;
  }

  /**
   * §4 第 5/6 层：未选中检查 → agent。
   * 目标失效**只回执、不转发**（D29）；未选中态按 D36 自动新建后转发。
   */
  async function forwardToAgent(event: QqC2CMessageEvent, openid: string, target: OutboundTarget): Promise<void> {
    const sessionId = await resolveSessionId(openid, target);
    if (sessionId === null) return;

    const validity = await control.validateTarget(openid);
    if (!validity.valid) {
      await safeReply(target, validity.notice ?? t('common.targetInvalid'));
      return;
    }

    const body = (event.content ?? '').trim();
    let text = body;

    const attachments = event.attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      try {
        const stored = await media.fetchAll(event, sessionId);
        const description = media.describe(stored);
        if (description) text = text ? `${text}\n\n${description}` : description;
      } catch (err) {
        // 附件失败不丢正文：记录错误后照常转发文本（AGENTS §3.3 不静默）
        logger.error('[inbound] 入站附件处理失败：', err);
      }
    }

    // busy → steer / 空闲 → followup 的判定在 ControlService 内部（D7）
    const result = await control.send(openid, text);
    if (!result.ok) {
      await safeReply(target, t('inbound.sendFailed', { reason: result.reason ?? t('inbound.unknownReason') }));
    }
  }

  /** §4 第 4 层：斜杠命令（分页子命令由命令层识别，未知命令不转发） */
  async function handleSlashCommand(
    event: QqC2CMessageEvent,
    openid: string,
    target: OutboundTarget,
    raw: string,
  ): Promise<void> {
    const parsed = parseCommand(raw);
    const name = parsed?.name ?? '';
    const args = parsed?.args ?? '';

    // 分页活跃且命令不是翻页子命令 → 先退出分页，再正常处理（D22，不得吞掉）
    const pagingActive = paging.get(openid) !== undefined;
    if (pagingActive && !isPagingCommand(name)) paging.clear(openid);

    if (!commands.isKnown(name)) {
      await safeReply(target, formatUnknownCommandReply(name));
      return;
    }

    const cmd: CommandContext = { openid, raw, name, args, target };
    const result = await commands.handle(cmd);

    if (result.exitPaging) paging.clear(openid);
    if (result.reply) await safeReply(target, result.reply);

    // 追加回执（D44：/压缩 先回「正在压缩…」，完成后回结果）。
    // 这里 **await** 是安全的：客户端以 `void handler(...)` 触发、不串行（`qq/client.ts:278`），
    // 不会阻塞后续消息；await 反而保证「先主回执、后追加回执」的顺序，并让失败走统一错误回执。
    if (result.followUp) {
      try {
        const followUpText = await result.followUp();
        if (followUpText) await safeReply(target, followUpText);
      } catch (err) {
        // 错误绝不吞（Y7）：日志带原始错误，用户收到明确回执
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[inbound] 命令追加回执失败（openid=${openid}）：`, err);
        await safeReply(target, t('inbound.followUpFailed', { message: truncate(message, ERROR_NOTICE_MAX_CHARS) }));
      }
    }

    // 契约：`handled=false` 表示未处理 → 继续走后续状态机层（未选中检查 → agent）
    if (!result.handled) await forwardToAgent(event, openid, target);
  }

  return {
    async handle(event: QqC2CMessageEvent): Promise<void> {
      const openid = extractOpenid(event);
      if (!openid) {
        logger.warn('[inbound] 忽略缺少 openid 的 C2C 事件：', event.id);
        return;
      }
      const raw = (event.content ?? '').trim();
      const target = buildOutboundTarget(event, openid);
      logger.debug(`[inbound] 收到消息 openid=${openid} content=${raw.slice(0, 50)}`);

      try {
        // 1. 审批 pending（最高优先，即使消息是斜杠命令）
        if (approval.hasPending(openid) && approval.handle(openid, raw)) return;

        // 2. 提问 pending
        if (question.hasPending(openid) && question.handle(openid, raw)) return;

        if (!isSlashCommand(raw)) {
          // 3. 非斜杠消息：先取消分页（D22），再走未选中检查 / agent
          paging.clear(openid);
          await forwardToAgent(event, openid, target);
          return;
        }

        // 4. 斜杠命令
        await handleSlashCommand(event, openid, target, raw);
      } catch (err) {
        // **错误绝不吞**（Y7）：日志带原始错误，用户收到明确回执而不是静默失败
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[inbound] 处理消息失败（openid=${openid}）：`, err);
        await safeReply(target, t('inbound.handlingFailed', { message: truncate(message, ERROR_NOTICE_MAX_CHARS) }));
      }
    },
  };
}