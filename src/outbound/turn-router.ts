/**
 * dsh-qqbot-bridge: DSH 事件 → QQ 出站的 turn 路由器
 *
 * 职责：把 DSH 的流式事件源桥接为 QQ 的出站打字机流。
 *
 * 核心处理机制：
 * 1. 事件源为 `agent/assistant-stream`（DSH 运行时流式增量源）；
 * 2. 严格内容过滤：只放行 `chunk.type === 'text-delta'`，过滤 tool-call、reasoning 等中间态帧；
 * 3. Step 级分段输出：每个 attempt 的 end（committed assistant/message）作为逻辑段边界，每个 step 发送为独立的 QQ 消息；
 * 4. 会话结束兜底：监听 `session/event` 的 `turn/end`，确保未在 attempt-end 结算的尾部内容得到闭环推送。
 */

import type { OutboundTarget, StreamHandle, StreamManager } from '../types/index.js';
import type { Logger } from '../utils/logger.js';

/** `agent/assistant-stream` 帧的最小结构（仅取本模块所需字段） */
export interface AssistantStreamFrame {
  type: 'start' | 'chunk' | 'end';
  revision?: number;
  index?: number;
  turn?: number;
  step?: number;
  chunk?: { type?: string; text?: string };
  outcome?: { kind?: string; eventType?: string; seq?: number };
}

export interface AssistantStreamPayload {
  agent?: { id?: string };
  frame?: AssistantStreamFrame;
}

/** `session/event` 里本模块关心的形状 */
export interface SessionEventLike {
  type?: string;
  data?: {
    turn?: number;
    reason?: { kind?: string; error?: { message?: unknown; code?: unknown } };
  };
}

export interface TurnRouterDeps {
  streams: StreamManager;
  /** 从 DSH sessionId 反解 openid（由 index.ts 注入，避免依赖控制层的具体实现） */
  openidOf(sessionId: string): string | undefined;
  /**
   * D49：该会话**当前回合**是否由本桥接（QQ）投喂。返回 `false` ⇒ 出站一律丢弃
   * （WebUI 自己发起的回合不应镜像到 QQ）。
   *
   * **可选**：未接线时退化为「只要会话在受控映射里就出站」的旧行为（供既有单测/旧装配）。
   * 生产由 `src/index.ts` 显式接线（桥接自记 `Message.id` → `user/message` 事件对拍）。
   */
  ownTurn?(sessionId: string): boolean;
  /**
   * 解析某 openid 当前应回复到的出站锚点。
   * 在 turn 的首个 text-delta 时**快照一次**并锁定到 turn 结束，避免中途串到别的消息。
   */
  resolveTarget(openid: string): OutboundTarget | undefined;
  /** 是否启用流式分片（对应 stream_enabled 配置，为 false 时全程降级整发） */
  isStreamEnabled?(): boolean;
  logger: Logger;
}

interface TurnState {
  sessionId: string;
  target: OutboundTarget;
  /** 整回合累积正文（供流式 replace / 降级整发使用） */
  buffer: string;
  handle: StreamHandle | null;
  /** 每 openid 一条链：DSH 的 emit 不 await 监听者，必须自行串行化 */
  chain: Promise<void>;
  chunks: number;
}

export class TurnRouter {
  private readonly deps: TurnRouterDeps;
  private readonly states = new Map<string, TurnState>();
  /** 所有在途任务（含已结束回合但尚未排空链），供 drain 使用 */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: TurnRouterDeps) {
    this.deps = deps;
  }

  /**
   * 挂载监听。返回 disposer。
   * `ctx` 只用到 `on`，用最小结构类型以便契约测试传入任何 Cordis Context。
   */
  attach(ctx: { on(event: string, handler: (...args: unknown[]) => void): unknown }): () => void {
    const offFrame = ctx.on('agent/assistant-stream', (...args: unknown[]) => {
      const payload = args[0] as AssistantStreamPayload;
      this.enqueue(payload?.agent?.id, () => this.onFrame(payload));
    });
    const offSession = ctx.on('session/event', (...args: unknown[]) => {
      const session = args[0] as { id?: string } | undefined;
      const event = args[1] as SessionEventLike | undefined;
      this.enqueue(session?.id, () => this.onSessionEvent(session?.id, event));
    });

    return () => {
      for (const off of [offFrame, offSession]) {
        if (typeof off === 'function') (off as () => void)();
      }
    };
  }

  /**
   * D49：出站路由的唯一入口判定 —— **只服务本桥接投喂的回合**。
   *
   * `ownTurn` 未接线（既有单测/旧装配）时退化为 `true`，保持旧行为；生产已显式接线。
   * 这一步必须在**三个入口**（帧、会话事件、串行化入队）统一生效，避免只在某一路径漏判。
   */
  private openidFor(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    if (this.deps.ownTurn !== undefined && !this.deps.ownTurn(sessionId)) return undefined;
    return this.deps.openidOf(sessionId);
  }

  /** 把事件处理串行化到 per-session 链上（emit 不 await，顺序必须自保） */
  private enqueue(sessionId: string | undefined, task: () => Promise<void>): void {
    if (!sessionId) return;
    const openid = this.openidFor(sessionId);
    if (!openid) return;
    const existing = this.states.get(openid);
    const prev = existing?.chain ?? Promise.resolve();
    let next: Promise<void>;
    next = prev
      .then(task)
      .catch((err: unknown) => {
        this.deps.logger.error('turn-router: 事件处理失败', err);
      })
      .finally(() => {
        this.pending.delete(next);
      });
    this.pending.add(next);
    if (existing) existing.chain = next;
    else this.states.set(openid, this.blankState(sessionId, openid, next));
  }

  /** 等待所有在途事件处理完成（事件是 emit 模式、不 await 监听者；测试与优雅关闭用） */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * 等待**某个 openid** 当前在途的流式事件处理完成（不阻塞其它 openid）。
   *
   * 供 `QqStreamManager.settleStream` 在发普通消息（审批/提问卡片、命令回执）前调用：
   * 事件是 emit 模式、处理链含网络发送，**天然滞后于事件发射**；不等它跑完就收流，会把
   * 正在进行的正文截断（真机缺陷：正文只剩一个「沙」字，2026-09-15）。
   *
   * ⚠️ **不得从本 router 自己的处理链内部调用**（会自等待死锁）；router 内部的降级发送
   * 路径因此显式传 `awaitStreamSettle: false`。
   */
  async drainPeer(openid: string): Promise<void> {
    for (;;) {
      const state = this.states.get(openid);
      if (!state) return;
      const chain = state.chain;
      // 链上任务串行执行；await 当前链即等到此刻已入队的全部任务跑完
      await chain;
      const after = this.states.get(openid);
      // 等待期间若有新任务入队，链会被替换 ⇒ 继续等，直到稳定
      if (!after || after.chain === chain) return;
    }
  }

  private blankState(sessionId: string, openid: string, chain: Promise<void>): TurnState {
    return {
      sessionId,
      target: this.deps.resolveTarget(openid) ?? { openid },
      buffer: '',
      handle: null,
      chain,
      chunks: 0,
    };
  }

  private async onFrame(payload: AssistantStreamPayload): Promise<void> {
    const sessionId = payload?.agent?.id;
    const frame = payload?.frame;
    if (!sessionId || !frame) return;
    const openid = this.openidFor(sessionId);
    if (!openid) return;

    // ── 段边界：attempt 的 end ──
    // `outcome.kind==='committed' && eventType==='assistant/message'` 表示本次 attempt
    // 产出了**可见消息** → 收掉当前段（该 step 的正文单独成一条 QQ 消息）。
    // 其余情况（abandoned / 只提交 assistant/attempt）没有可见正文 → 丢弃缓冲，不发空消息。
    if (frame.type === 'end') {
      const state = this.states.get(openid);
      if (!state) return;
      const outcome = frame.outcome;
      if (outcome?.kind === 'committed' && outcome?.eventType === 'assistant/message') {
        await this.flushSegment(openid, state);
      } else {
        await this.discardSegment(state);
      }
      return;
    }

    // ⚠️ 只放行 text-delta；其余 chunk 类型（reasoning / tool-call / block 标记 / usage / finish）一律丢弃。
    if (frame.type !== 'chunk') return;
    if (frame.chunk?.type !== 'text-delta') return;
    const text = frame.chunk.text;
    if (typeof text !== 'string' || text.length === 0) return;

    let state = this.states.get(openid);
    if (!state) {
      state = this.blankState(sessionId, openid, Promise.resolve());
      this.states.set(openid, state);
    }
    // 首个正文增量时快照回复锚点，并锁定到 turn 结束
    state.target = this.deps.resolveTarget(openid) ?? state.target;
    state.buffer += text;
    state.chunks += 1;

    const streamEnabled = this.deps.isStreamEnabled ? this.deps.isStreamEnabled() : true;
    if (streamEnabled && !state.handle) {
      state.handle = this.deps.streams.open(state.target);
      if (!state.handle) {
        this.deps.logger.debug(`turn-router: 流式不可用，累积全文待 turn 结束一次性发送（openid=${openid.slice(0, 8)}…）`);
      }
    }
    if (state.handle) await state.handle.push(text);
  }

  private async onSessionEvent(sessionId: string | undefined, event: SessionEventLike | undefined): Promise<void> {
    if (!sessionId || !event?.type) return;
    const openid = this.openidFor(sessionId);
    if (!openid) return;
    const state = this.states.get(openid);
    if (!state) return;

    if (event.type !== 'turn/end') return;

    // 上游错误显式记录日志
    const reason = event.data?.reason;
    if (reason?.kind === 'error') {
      const err = reason.error;
      const text =
        err && typeof err === 'object'
          ? `${String(err.message ?? '')} (code: ${String(err.code ?? 'unknown')})`
          : String(reason.error ?? '');
      this.deps.logger.error(`turn-router: agent turn ${event.data?.turn ?? '?'} 失败：${text}`);
    }

    try {
      // 兜底：正常路径下最后一段已在 attempt-end 收尾；若缓冲仍有内容（无 attempt-end 帧）则在此发出。
      await this.flushSegment(openid, state);
    } finally {
      this.states.delete(openid);
    }
  }

  /**
   * 收掉**当前段**（= 一个 step 的正文），随后重置该 openid 的段状态以便下一段重新开流。
   * 有流则收流；无流（流式不可用）则整发一条普通消息（降级）。空段不发消息。
   */
  private async flushSegment(openid: string, state: TurnState): Promise<void> {
    const full = state.buffer;
    if (full.trim().length === 0) {
      this.deps.logger.debug(`turn-router: 本段无正文，不发送（openid=${openid.slice(0, 8)}…）`);
      this.resetSegment(state);
      return;
    }

    if (state.handle) {
      await state.handle.finish(full);
      this.deps.logger.info(
        `turn-router: 段收尾（流式）openid=${openid.slice(0, 8)}… chunks=${state.chunks} chars=${full.length}`
      );
    } else {
      const res = await this.deps.streams.sendSerialized(
        state.target,
        {
          msg_type: 2,
          markdown: { content: full },
        },
        // 本调用发生在 router **自己的处理链内部**，再等自己会死锁 ⇒ 显式跳过 settle
        { awaitStreamSettle: false },
      );
      if (!res.ok) {
        this.deps.logger.error(
          `turn-router: 降级整发失败 code=${String(res.code ?? '')} ${res.message ?? ''}（openid=${openid.slice(0, 8)}…）`
        );
      }
    }
    this.resetSegment(state);
  }

  /** 丢弃本段缓冲（attempt 未产出可见消息，如 `abandoned`） */
  private async discardSegment(state: TurnState): Promise<void> {
    if (state.handle) {
      // 已开流但最终未提交：收流时只发已累积的内容（若空则 StreamManager 内部不产出消息）
      await state.handle.finish(state.buffer);
    }
    this.resetSegment(state);
  }

  /** 重置段状态但保留 turn 级的目标锚点（下一段继续回复同一条入站消息） */
  private resetSegment(state: TurnState): void {
    state.buffer = '';
    state.handle = null;
    state.chunks = 0;
  }

  /** 供测试与诊断：当前是否存在活跃回合状态 */
  activeCount(): number {
    return this.states.size;
  }
}