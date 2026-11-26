/**
 * dsh-qqbot-bridge: 远端交互（审批 + 提问）
 *
 * 补上设计文档 §4 入站状态机的前两层（审批 → 提问），使"远程控制"闭环：
 * 没有它，Agent 一旦请求审批/提问就会**失败关闭且手机上毫无提示**。
 *
 * 接入点均为 **DSH 公开的 Cordis waterfall 事件**（无私有 API、无 monkey patch）：
 *   - `ctx.on('approval/request', ...)`（`@deepseek-ai/dsh-user-approval`；
 *     outcome ∈ allowed-once/rejected/cancelled/unavailable）
 *   - `ctx.on('user-questions/request', ...)`（`@deepseek-ai/dsh-user-questions`；
 *     返回答案即认领，`next()` 为委派）
 * 类型直接取自两个官方包（不再自造镜像类型，契约漂移可被编译器发现）。
 *
 * ️ **必须 `{ prepend: true }`**（2026-09-15 真机缺陷的根因）：
 * waterfall 的语义是「**先注册者不 `next()` 即 veto 整条链**」（`cordis/lib/index.js:307-325`），
 * 而 `ctx.on` 默认是 `push` 追加（`:336` 只有 `prepend: true` 才 `unshift` 到最前）。
 * WebUI 的宿主 answerer `@deepseek-ai/dsh-api-remotes` 由 `dsh-web-app` bundle 插入、
 * **排在用户插件之前**（`dsh-web-app/cordis.patch.yml:195-196`；profile 的
 * `dsh.profile.bundles` 里本插件在最后），它把请求转发给浏览器且浏览器不作答就不 `next()`
 * ⇒ 不 prepend 的话 QQ 侧监听器**根本不会被执行**，卡片只会出现在 WebUI。
 * 加 prepend 后：受控会话由本插件先 claim；**非受控会话仍 `next()` 委派**，WebUI 完全不受影响。
 *
 * 判定语义（架构规约）：远程控制语境下**没有「QQ 会话」概念**，只有
 * 「**当前正被远程受控的会话**」概念——故依据是「该 session 此刻是否为某 openid 的控制目标」
 * （`control.findControlOwner`），**不是**「曾经由 QQ 驱动过」的历史映射。
 * 受控会话的审批/提问卡片**不出现在 WebUI 是预期行为**（waterfall 只能由一个 answerer claim）。
 *
 * 行为设计（审批与提问走**普通消息**，D9/D34）：
 *   - 非受控会话（反解不出 openid）一律 `next()` 委派，绝不劫持 WebUI 的交互；
 *   - 同一 openid 同时只保留一个待决交互，新请求**顶掉**旧的（旧的 fail-closed）；
 *   - 超时 fail-closed（审批 → `rejected`；提问 → 抛错），默认 300s（对齐旧项目一致做法）；
 *   - 待决期间**任何**入站消息都被本层消费（不转发给 agent——agent 正阻塞等这个答案）。
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions';

import type { OutboundTarget, PendingInteraction, QqInlineKeyboard, QqInteractionEvent } from '../types/index.js';
import type { Logger } from '../utils/logger.js';
import { t } from '../i18n/index.js';
import {
  buildApprovalCard,
  buildQuestionCard,
  decodeButtonData,
  formatCommandFromArguments,
  type InteractionCardPayload,
} from './card-renderer.js';

export type { ApprovalOutcome };

export interface InteractionSendCardResult {
  ok: boolean;
  code?: string | number;
  message?: string;
}

export interface InteractionDeps {
  /** 发一条纯文本消息（经 per-peer 串行队列；D34） */
  sendText(openid: string, text: string): Promise<void>;
  /** 可选：发送 Markdown 卡片与内联按钮；缺省时自动降级到 `sendText` */
  sendCard?(
    openid: string,
    card: { markdown: string; keyboard?: QqInlineKeyboard },
    targetOverride?: OutboundTarget,
  ): Promise<InteractionSendCardResult>;
  /**
   * 反查：该 session **当前**是否正被某个 openid 远程受控；返回 `undefined` = 非受控
   * （⇒ 一律 `next()` 委派给 WebUI）。
   */
  controlledBy(sessionId: string): string | undefined;
  /**
   * 该会话当前回合是否由本桥接发起。返回 `false` ⇒ 不抢交互卡片，`next()` 委派给 WebUI。
   * 可选：未接线时保持默认行为。
   */
  ownTurn?(sessionId: string): boolean;
  logger: Logger;
  /** 待决超时（默认 300000ms） */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TOOL_CALL_CACHE = 200;

const APPROVE_WORDS = new Set(['y', 'yes', '是', '允许', '同意', '批准', '1', '好', '可以']);
const REJECT_WORDS = new Set(['n', 'no', '否', '拒绝', '不同意', '2', '不']);
const CANCEL_WORDS = new Set(['/取消', '/cancel', '取消']);

interface PendingResolution {
  raw: string;
  /** 按钮点击触发时带回的互动事件锚点（`INTERACTION_CREATE:<id>`） */
  eventId?: string;
}

interface Pending {
  openid: string;
  nonce: string;
  optionCount?: number;
  resolve: (res: PendingResolution) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}

/** 单个 openid 的待决槽（审批与提问各自独立持有） */
class PendingSlot implements PendingInteraction {
  private readonly current = new Map<string, Pending>();
  private readonly kind: 'approval' | 'question';

  constructor(kind: 'approval' | 'question') {
    this.kind = kind;
  }

  private settle(pending: Pending, resolution: PendingResolution): void {
    clearTimeout(pending.timer);
    pending.cleanup?.();
    pending.resolve(resolution);
  }

  hasPending(openid: string): boolean {
    return this.current.has(openid);
  }

  /** 入站文本消息被本层消费（返回 true 即 pipeline 不再往下走） */
  handle(openid: string, text: string): boolean {
    const pending = this.current.get(openid);
    if (!pending) return false;
    this.current.delete(openid);
    this.settle(pending, { raw: text });
    return true;
  }

  /** 按钮回调消费待决交互；nonce 不匹配或选项越界一律忽略 */
  handleButton(openid: string, nonce: string, value: string, optionIndex?: number, eventId?: string): boolean {
    const pending = this.current.get(openid);
    if (!pending || pending.nonce !== nonce) return false;
    if (
      optionIndex !== undefined &&
      pending.optionCount !== undefined &&
      (optionIndex < 0 || optionIndex >= pending.optionCount)
    ) {
      return false;
    }
    this.current.delete(openid);
    this.settle(pending, { raw: value, ...(eventId ? { eventId } : {}) });
    return true;
  }

  /** 登记一次待决；新请求顶掉旧请求（旧的 fail-closed），并在 signal 中止时立刻释放 */
  async wait(
    openid: string,
    timeoutMs: number,
    logger: Logger,
    nonce: string,
    optionCount?: number,
    signal?: AbortSignal,
  ): Promise<PendingResolution> {
    const previous = this.current.get(openid);
    if (previous) {
      this.current.delete(openid);
      logger.warn(`[${this.kind}] openid=${openid.slice(0, 8)}… 已有待决交互，旧请求被新请求顶掉`);
      this.settle(previous, { raw: this.kind === 'approval' ? '__superseded__' : '__cancel__' });
    }
    return new Promise<PendingResolution>((resolve) => {
      let entry: Pending;
      const timer = setTimeout(() => {
        this.current.delete(openid);
        logger.warn(`[${this.kind}] openid=${openid.slice(0, 8)}… 等待超时（${timeoutMs}ms），fail-closed`);
        this.settle(entry, { raw: '__timeout__' });
      }, timeoutMs);
      const onAbort = (): void => {
        if (this.current.get(openid) !== entry) return;
        this.current.delete(openid);
        logger.info(`[${this.kind}] openid=${openid.slice(0, 8)}… 收到中止信号，已清理待决槽位`);
        this.settle(entry, { raw: '__abort__' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry = {
        openid,
        nonce,
        ...(optionCount === undefined ? {} : { optionCount }),
        resolve,
        timer,
        ...(signal ? { cleanup: () => signal.removeEventListener('abort', onAbort) } : {}),
      };
      this.current.set(openid, entry);
    });
  }

  /** 清空（dispose 时 fail-closed） */
  clear(): void {
    const entries = [...this.current.values()];
    this.current.clear();
    for (const p of entries) {
      this.settle(p, { raw: '__cancel__' });
    }
  }
}

export class QqInteractions {
  private readonly deps: InteractionDeps;
  private readonly timeoutMs: number;
  private readonly approvalSlot = new PendingSlot('approval');
  private readonly questionSlot = new PendingSlot('question');
  private readonly toolCallArgs = new Map<string, string>();

  /** 供 `InboundDeps` 注入的两层 */
  readonly approval: PendingInteraction = {
    hasPending: (openid) => this.approvalSlot.hasPending(openid),
    handle: (openid, text) => this.approvalSlot.handle(openid, text),
  };
  readonly question: PendingInteraction = {
    hasPending: (openid) => this.questionSlot.hasPending(openid),
    handle: (openid, text) => this.questionSlot.handle(openid, text),
  };

  constructor(deps: InteractionDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 记录最近 `tool/call` 的原始参数，供审批卡片回显命令原文 */
  recordToolCall(callId: string, argumentsRaw: string): void {
    if (!callId || !argumentsRaw) return;
    if (this.toolCallArgs.has(callId)) this.toolCallArgs.delete(callId);
    this.toolCallArgs.set(callId, argumentsRaw);
    while (this.toolCallArgs.size > MAX_TOOL_CALL_CACHE) {
      const oldest = this.toolCallArgs.keys().next().value;
      if (oldest === undefined) break;
      this.toolCallArgs.delete(oldest);
    }
  }

  /** 处理 QQ `INTERACTION_CREATE` 按钮回调；返回 true 表示命中并消费 */
  handleInteraction(event: QqInteractionEvent): boolean {
    const openid = event.user_openid ?? '';
    const rawData = event.data?.resolved?.button_data;
    if (!openid || !rawData) return false;
    const button = decodeButtonData(rawData);
    if (!button) return false;

    if (button.t === 'approval') {
      return this.approvalSlot.handleButton(openid, button.n, button.d === 'allow' ? 'y' : 'n');
    }
    if (button.i < 0) return false;
    const eventId = event.id ? `INTERACTION_CREATE:${event.id}` : undefined;
    return this.questionSlot.handleButton(openid, button.q, String(button.i + 1), button.i, eventId);
  }

  /**
   * 挂载两个 waterfall 监听；返回 disposer。
   *
   * **两个都必须 `{ prepend: true }`**——否则 WebUI 宿主 answerer 先注册先 claim，
   * QQ 侧永远收不到（见文件头注释）。
   */
  attach(ctx: {
    on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): unknown;
  }): () => void {
    const offApproval = ctx.on(
      'approval/request',
      (...args: unknown[]) =>
        this.onApproval(args[0] as ApprovalRequest, args[1] as () => Promise<ApprovalOutcome>),
      { prepend: true },
    );
    const offQuestion = ctx.on(
      'user-questions/request',
      (...args: unknown[]) =>
        this.onQuestion(
          args[0] as AskUserQuestionRequest,
          args[1] as () => Promise<AskUserQuestionAnswer>,
        ),
      { prepend: true },
    );
    return () => {
      this.approvalSlot.clear();
      this.questionSlot.clear();
      for (const off of [offApproval, offQuestion]) {
        if (typeof off === 'function') (off as () => void)();
      }
    };
  }

  /** 从官方 `Agent` 载体取 sessionId（兼容 `agent.session.id` / `agent.id` 两种形态） */
  private sessionIdOf(holder: { id?: string; session?: { id?: string } } | undefined): string | undefined {
    const id = holder?.session?.id ?? holder?.id;
    return id === undefined ? undefined : String(id);
  }

  /** 统一投递卡片：优先 sendCard（带按钮失败则降级无按钮 Markdown），未注入 sendCard 时走 sendText */
  private async deliverCard(
    openid: string,
    card: InteractionCardPayload,
    targetOverride?: OutboundTarget,
  ): Promise<void> {
    if (!this.deps.sendCard) {
      await this.deps.sendText(openid, card.fallbackMarkdown ?? card.markdown);
      return;
    }
    const res = await this.deps.sendCard(
      openid,
      { markdown: card.markdown, ...(card.keyboard ? { keyboard: card.keyboard } : {}) },
      targetOverride,
    );
    if (!res.ok && card.keyboard) {
      this.deps.logger.warn(
        `[interactions] 带按钮卡片发送失败（code=${String(res.code ?? '')} ${res.message ?? ''}），降级无按钮 Markdown`,
      );
      await this.deps.sendCard(
        openid,
        { markdown: card.fallbackMarkdown ?? card.markdown },
        targetOverride,
      );
    }
  }

  private resolveApprovalCommand(req: ApprovalRequest): string | undefined {
    const callId = req.callId === undefined ? undefined : String(req.callId);
    if (callId) {
      const cached = this.toolCallArgs.get(callId);
      if (cached !== undefined) return formatCommandFromArguments(cached);
    }
    // 兼容仅挂载 session.snapshotEvents 的历史测试桩
    const snap = (req.agent as { session?: { snapshotEvents?: () => ReadonlyArray<{ type?: string; data?: { callId?: unknown; arguments?: unknown } }> } } | undefined)?.session?.snapshotEvents?.();
    if (!Array.isArray(snap) || !callId) return undefined;
    for (let i = snap.length - 1; i >= 0; i -= 1) {
      const ev = snap[i];
      if (ev?.type === 'tool/call' && String(ev.data?.callId) === callId && typeof ev.data?.arguments === 'string') {
        return formatCommandFromArguments(ev.data.arguments);
      }
    }
    return undefined;
  }

  // ─────────────────────────── 审批 ───────────────────────────

  private async onApproval(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = this.sessionIdOf(req?.agent);
    const openid = sessionId ? this.deps.controlledBy(sessionId) : undefined;
    if (!sessionId || !openid) return next(); // 非受控/无会话 → 委派给 WebUI 等其它 answerer
    // 只有本桥接发起的 turn 才把卡片推到 QQ；WebUI 发起的 turn 委派回 WebUI
    if (this.deps.ownTurn !== undefined && !this.deps.ownTurn(sessionId)) return next();

    const tool = req?.toolName ?? t('interactions.approval.toolUnknown');
    const reasonText = req?.reason?.trim() || undefined;
    const command = this.resolveApprovalCommand(req);
    const nonce = randomUUID().replace(/-/g, '').slice(0, 8);
    const card = buildApprovalCard({
      tool,
      ...(reasonText ? { reason: reasonText } : {}),
      ...(command ? { command } : {}),
      nonce,
    });
    await this.deliverCard(openid, card);

    let resolution: PendingResolution;
    try {
      resolution = await this.approvalSlot.wait(
        openid,
        this.timeoutMs,
        this.deps.logger,
        nonce,
        undefined,
        req?.signal,
      );
    } catch (err: unknown) {
      this.deps.logger.error('审批等待异常', err);
      return 'unavailable';
    }
    if (resolution.raw === '__abort__' || req?.signal?.aborted) return 'cancelled';

    const raw = resolution.raw;
    const verdict = raw.trim().toLowerCase();
    if (verdict === '__timeout__' || verdict === '__superseded__') {
      await this.deps.sendText(openid, t('interactions.approval.timeout'));
      return 'rejected';
    }
    if (CANCEL_WORDS.has(verdict)) {
      await this.deps.sendText(openid, t('interactions.approval.cancelled'));
      return 'cancelled';
    }
    if (APPROVE_WORDS.has(verdict)) {
      await this.deps.sendText(openid, t('interactions.approval.allowed'));
      return 'allowed-once';
    }
    if (REJECT_WORDS.has(verdict)) {
      await this.deps.sendText(openid, t('interactions.approval.rejected'));
      return 'rejected';
    }
    // 非 y/n：不转发给 agent（agent 正阻塞等审批），按拒绝处理并提示
    await this.deps.sendText(
      openid,
      t('interactions.approval.unrecognized', { text: raw.slice(0, 20) }),
    );
    return 'rejected';
  }

  // ─────────────────────────── 提问 ───────────────────────────

  private async onQuestion(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>
  ): Promise<AskUserQuestionAnswer> {
    const sessionId = this.sessionIdOf(request?.agent);
    const openid = sessionId ? this.deps.controlledBy(sessionId) : undefined;
    const questions: readonly AskUserQuestionItem[] = Array.isArray(request?.questions) ? request.questions : [];
    if (!sessionId || !openid || questions.length === 0) return next();
    // D49：同审批——WebUI 发起的回合，提问卡片也委派回 WebUI
    if (this.deps.ownTurn !== undefined && !this.deps.ownTurn(sessionId)) return next();

    const answers: AskUserQuestionAnswer['answers'] = [];
    let nextTargetOverride: OutboundTarget | undefined;
    // 多问题逐条串行提问（聊天场景下比一次性列全部更可读）
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const options = Array.isArray(q.options) ? q.options : [];
      const nonce = randomUUID().replace(/-/g, '').slice(0, 8);
      const card = buildQuestionCard({
        question: q,
        index: i,
        total: questions.length,
        nonce,
      });
      await this.deliverCard(openid, card, nextTargetOverride);

      const resolution = await this.questionSlot.wait(
        openid,
        this.timeoutMs,
        this.deps.logger,
        nonce,
        options.length > 0 ? options.length : undefined,
        request?.signal,
      );
      nextTargetOverride = resolution.eventId ? { openid, eventId: resolution.eventId } : undefined;
      const text = resolution.raw.trim();

      if (text === '__abort__' || request?.signal?.aborted) {
        throw new Error(t('interactions.question.unanswered'));
      }

      if (text === '__timeout__' || text === '__cancel__' || CANCEL_WORDS.has(text.toLowerCase())) {
        await this.deps.sendText(openid, t('interactions.question.cancelled'));
        // 已作答的部分一并返回，未作答的不编造
        throw new Error(t('interactions.question.unanswered'));
      }
      if (text === '/跳过' || text.toLowerCase() === '/skip') {
        answers.push({ id: q.id, selected: [] });
        continue;
      }

      const picked: string[] = [];
      if (options.length > 0) {
        for (const part of text.split(/[,，\s]+/).filter(Boolean)) {
          const idx = Number(part);
          if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) picked.push(options[idx - 1]!.label);
        }
      }
      if (picked.length > 0) {
        answers.push({ id: q.id, selected: q.multiSelect ? picked : [picked[0]!] });
      } else {
        // 不是序号 → 视为自定义文本
        answers.push({ id: q.id, selected: [], custom: text });
      }
    }
    return { answers };
  }
}