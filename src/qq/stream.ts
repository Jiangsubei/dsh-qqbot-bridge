/**
 * dsh-qqbot-bridge: QQ 流式打字机状态机与管理器（StreamManager / StreamHandle 实现）
 *
 * 负责与 QQ 开放平台 `POST /v2/users/{openid}/stream_messages` 接口对齐：
 * 1. 节流聚合：首片即时发送，后续增量按时间窗口缓冲定时 flush；
 * 2. 跨 Step 序号自维护：维护单调递增的全局 `index`，不受底层 attempt 边界归零影响；
 * 3. 槽位管理：整段流式保持恒定一个 `msg_seq`，支持流式失败时优雅降级为普通 Markdown 消息；
 * 4. 状态机完备性：覆盖 `input_state`（1 生成中 → 10 结束）与 `stream_msg_id` 首片回填。
 */

import {
  QQ_MESSAGE_MAX_BYTES,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_STREAM_REQUEST_MAX_BYTES,
  QQ_STREAM_THROTTLE_MS,
} from '../constants/index.js';
import type {
  MarkdownAdapter,
  OutboundTarget,
  QqApiResult,
  QqClientLike,
  QqSendMessagePayload,
  QqStreamMessagePayload,
  QqStreamMessageResponse,
  SerialSender,
  SlotAllocator,
  StreamHandle,
  StreamManager,
} from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/** `input_state`：1 = 生成中（首片即时可见，E2-1） */
export const QQ_STREAM_INPUT_STATE_GENERATING = 1;
/** `input_state`：10 = 生成结束 */
export const QQ_STREAM_INPUT_STATE_FINISHED = 10;

const EMPTY_USED: ReadonlySet<number> = new Set<number>();

/**
 * per-`msg_id` 的 `msg_seq` 槽位分配器（风险 **R9**，设计文档 §7.5）。
 * 【实测 E2-2】`(msg_id, msg_seq)` 唯一：流式占一格后，同 `msg_id` 的普通消息必须取新格，
 * 否则 `40054005 消息被去重`。`{ msgId → Set<usedSeq> }`，取最小空闲格。
 */
export class MsgSeqSlotAllocator implements SlotAllocator {
  private readonly usedSeqs = new Map<string, Set<number>>();

  alloc(msgId: string): number {
    const used = this.usedSeqs.get(msgId) ?? new Set<number>();
    let seq = 1;
    while (used.has(seq)) seq += 1;
    used.add(seq);
    this.usedSeqs.set(msgId, used);
    return seq;
  }

  occupy(msgId: string, seq: number): void {
    const used = this.usedSeqs.get(msgId) ?? new Set<number>();
    used.add(seq);
    this.usedSeqs.set(msgId, used);
  }

  used(msgId: string): ReadonlySet<number> {
    return this.usedSeqs.get(msgId) ?? EMPTY_USED;
  }

  release(msgId: string): void {
    this.usedSeqs.delete(msgId);
  }
}

export interface QqStreamSessionOptions {
  client: QqClientLike;
  markdown: MarkdownAdapter;
  /** 回退普通消息时取新槽位所用（R9） */
  slots: SlotAllocator;
  openid: string;
  msgId?: string;
  /** 整段流式恒定的 `msg_seq`（`open` 时占好格） */
  msgSeq?: number;
  throttleMs?: number;
  inputMode?: 'append' | 'replace';
  logger?: Logger;
}

/**
 * 单段出站流（`StreamHandle` 实现）。
 * 一段流 = 一条 QQ 流式消息 = 一个 `(msg_id, msg_seq)` 槽位；分片靠 `index` 递增。
 */
export class QqStreamSession implements StreamHandle {
  private readonly client: QqClientLike;
  private readonly markdown: MarkdownAdapter;
  private readonly slots: SlotAllocator;
  private readonly openid: string;
  private readonly throttleMs: number;
  private readonly inputMode: 'append' | 'replace';
  private readonly logger: Logger;

  readonly msgId?: string;
  readonly msgSeq?: number;

  /** 累积的原始增量文本（`text-delta` 拼接；E11-5：拼接结果 == 最终正文） */
  private buffer = '';
  /** 已成功下发给 QQ 的（经过适配层）全文 */
  private sentFormatted = '';
  /** QQ 侧分片序号：自维护全局计数，**不**透传 DSH 的 `chunk.index`（R8） */
  private index = 0;
  private streamMsgId?: string;
  private lastFlushTime: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private failed = false;
  private finished = false;

  constructor(options: QqStreamSessionOptions) {
    this.client = options.client;
    this.markdown = options.markdown;
    this.slots = options.slots;
    this.openid = options.openid;
    this.msgId = options.msgId;
    this.msgSeq = options.msgSeq;
    this.throttleMs = options.throttleMs ?? QQ_STREAM_THROTTLE_MS;
    this.inputMode = options.inputMode ?? 'append';
    this.logger = options.logger ?? createLogger('qq-stream');
  }

  /** 当前已成功下发的全文（回退/前缀比对依据） */
  get sentText(): string {
    return this.sentFormatted;
  }

  /** 本段流是否已结束（`finish` 调用后） */
  get ended(): boolean {
    return this.finished;
  }

  /** 追加正文增量（来自 DSH `text-delta` 的 `text`） */
  async push(delta: string): Promise<void> {
    if (this.finished || !delta) return;
    // 失败后仍必须累积：finish 时用完整正文回退，绝不静默丢内容
    this.buffer += delta;
    if (this.failed) return;

    const now = Date.now();
    const elapsed = this.lastFlushTime === null ? Number.POSITIVE_INFINITY : now - this.lastFlushTime;
    if (elapsed >= this.throttleMs) {
      await this.requestFlush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.requestFlush();
      }, this.throttleMs - elapsed);
    }
  }

  /**
   * 结束本段流：清定时器 → 等在途 flush → 发末片（`input_state=10`）。
   * 若期间任一中间片失败，则回退为一条普通 markdown 消息（新 `msg_seq` 槽位）。
   */
  async finish(finalText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.inFlight) {
      // 等在途 flush 落定，保证分片顺序；它本身不会 reject
      await this.inFlight;
    }

    if (finalText !== undefined) this.buffer = finalText;
    const formatted = this.safeFormat(this.buffer);
    if (formatted.trim().length === 0) {
      if (this.failed) this.logger.error('[qq-stream] 流式失败且无可回退正文（正文为空）');
      return;
    }

    if (this.failed) {
      await this.sendFallback(formatted);
      return;
    }

    const payloads = this.pendingPayloads(formatted);
    let delivered = this.sentFormatted;
    if (payloads.length === 0) {
      // 正文已全部下发：仍补一个**空的结束片**（`input_state=10`）承担"生成结束"信号。
      // 【实测 E3-D】平台接受空 `content_raw` 片（HTTP 200）⇒ 保留该信号不丢语义。
      // 恒用 `append` 发空片：replace 模式下空 `content_raw` 不满足"必须是累积全文"的语义（有 40007 风险）。
      const ok = await this.sendChunk('', QQ_STREAM_INPUT_STATE_FINISHED, 'append');
      if (ok) this.sentFormatted = formatted;
      return;
    }
    for (const [i, p] of payloads.entries()) {
      const state =
        i === payloads.length - 1 ? QQ_STREAM_INPUT_STATE_FINISHED : QQ_STREAM_INPUT_STATE_GENERATING;
      const ok = await this.sendChunk(p.content, state, p.mode);
      if (!ok) {
        // 末尾片失败：只回退**尚未送达**的余量（避免整段重复）——D50：绝不静默丢内容
        await this.sendFallback(formatted.slice(delivered.length));
        return;
      }
      delivered = p.mode === 'append' ? delivered + p.content : p.content;
    }
    this.sentFormatted = formatted;
  }

  /** 串行化在途 flush：同一时刻最多一个 flush 在飞；期间的新文本合并到下一轮 */
  private requestFlush(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = (async () => {
      do {
        this.rerun = false;
        try {
          await this.sendPending();
        } catch (err) {
          this.markFailed(err);
        }
      } while (this.rerun && !this.finished && !this.failed);
    })();
    this.inFlight = run;
    const clear = () => {
      if (this.inFlight === run) this.inFlight = null;
    };
    void run.then(clear, clear);
    return run;
  }

  /**
   * 下发"尚未下发"的部分，并**按单次请求字节上限切分**（D50）。
   * append：只发增量；replace：发累积全文（须以上游已下发内容为前缀）。
   */
  private async sendPending(): Promise<void> {
    if (this.finished || this.failed) return;
    const formatted = this.safeFormat(this.buffer);
    if (formatted === this.sentFormatted) return;
    const payloads = this.pendingPayloads(formatted);
    for (const p of payloads) {
      const ok = await this.sendChunk(p.content, QQ_STREAM_INPUT_STATE_GENERATING, p.mode);
      if (!ok) return; // markFailed 已置位；sentFormatted 不推进，finish 时按失败回退
    }
    this.sentFormatted = formatted;
    this.lastFlushTime = Date.now();
  }

  /**
   * 把"尚未下发"的正文切成**每片都不超过单次请求字节上限**的请求序列（D50）。
   *
   * - `append`：【实测 E3-B】每次请求只发增量、累积总量无约束 ⇒ 只需把增量切成 ≤上限 的片；
   * - `replace`：每片 `content_raw` 必须是**累积全文**且以上次下发为前缀（否则 `40007`）。
   *   递进前缀在"累积全文"超过单次上限后无法再表达 ⇒ 超限余量改用 `append` 续发
   *   （`input_mode` 是 per-request 字段；**此混用为【推断】，未真机实测**——但 replace 非生产路径，
   *   生产恒为 append；即便混用被拒也只走失败回退，**内容仍不丢**）。
   */
  private pendingPayloads(formatted: string): { content: string; mode: 'append' | 'replace' }[] {
    const cap = QQ_STREAM_REQUEST_MAX_BYTES;
    if (this.inputMode !== 'replace') {
      const pending = formatted.slice(this.sentFormatted.length);
      return this.markdown.splitByBytes(pending, cap).map((content) => ({ content, mode: 'append' as const }));
    }
    const out: { content: string; mode: 'append' | 'replace' }[] = [];
    let acc = this.sentFormatted;
    let overflowed = false;
    for (const part of this.markdown.splitByBytes(formatted.slice(this.sentFormatted.length), cap)) {
      const candidate = acc + part;
      if (!overflowed && Buffer.byteLength(candidate, 'utf8') <= cap) {
        out.push({ content: candidate, mode: 'replace' });
        acc = candidate;
      } else {
        overflowed = true;
        out.push({ content: part, mode: 'append' });
        acc = candidate;
      }
    }
    return out;
  }

  private async sendChunk(
    content: string,
    inputState: number,
    mode: 'append' | 'replace' = this.inputMode
  ): Promise<boolean> {
    const payload: QqStreamMessagePayload = {
      input_mode: mode,
      input_state: inputState,
      index: this.index,
      content_type: 'markdown',
      content_raw: content,
      ...(this.msgId ? { msg_id: this.msgId } : {}),
      ...(this.msgSeq !== undefined ? { msg_seq: this.msgSeq } : {}),
      ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
    };
    this.index += 1;

    let res: QqApiResult;
    try {
      res = await this.client.sendStreamMessage(this.openid, payload);
    } catch (err) {
      this.markFailed(err);
      return false;
    }
    if (!res.ok) {
      this.markFailed(
        `code=${String(res.code)} status=${res.status}${res.message ? ` message=${res.message}` : ''}`
      );
      return false;
    }
    if (!this.streamMsgId) {
      const body = res.body as QqStreamMessageResponse | null;
      if (body && typeof body.id === 'string' && body.id) this.streamMsgId = body.id;
    }
    return true;
  }

  /**
   * 失败回退：把正文切成多条普通 markdown 消息（每条的 `msg_seq` 取**新槽位**，E2-2）。
   * **按非流式单条字节上限切条**（D50）——回退路径同样绝不丢内容、绝不截断。
   */
  private async sendFallback(formatted: string): Promise<void> {
    if (!formatted) return;
    for (const part of this.markdown.splitByBytes(formatted, QQ_MESSAGE_MAX_BYTES)) {
      const seq = this.msgId ? this.allocSlot(this.msgId) : undefined;
      const payload: QqSendMessagePayload = {
        msg_type: QQ_MSG_TYPE_MARKDOWN,
        markdown: { content: part },
        ...(this.msgId ? { msg_id: this.msgId } : {}),
        ...(seq !== undefined ? { msg_seq: seq } : {}),
      };
      try {
        const res = await this.client.sendMessage(this.openid, payload);
        if (!res.ok) {
          this.logger.error(
            `[qq-stream] 回退普通消息仍失败: code=${String(res.code)} status=${res.status}`
          );
        }
      } catch (err) {
        this.logger.error(
          `[qq-stream] 回退普通消息异常: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private allocSlot(msgId: string): number {
    const seq = this.slots.alloc(msgId);
    this.slots.occupy(msgId, seq);
    return seq;
  }

  private safeFormat(text: string): string {
    try {
      return this.markdown.toQqMarkdown(text);
    } catch (err) {
      this.markFailed(err);
      return '';
    }
  }

  private markFailed(reason: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.logger.warn(
      `[qq-stream] 流式下发失败，终止流式并回退普通 markdown: ${
        reason instanceof Error ? reason.message : String(reason)
      }`
    );
  }
}

export interface QqStreamManagerOptions {
  client: QqClientLike;
  markdown: MarkdownAdapter;
  /** per-peer 串行发送器（N7，真实实现位于 `src/outbound/queue.ts`） */
  sender: SerialSender;
  /** 可与其它出站方共享的槽位分配器；缺省时本模块自建一份 */
  slots?: SlotAllocator;
  throttleMs?: number;
  inputMode?: 'append' | 'replace';
  /**
   * 收流**之前**先等待该 peer 的在途正文流处理完（接线层接 `turn-router.drainPeer`）。
   *
   * 为什么必须：正文增量由 turn-router 的 per-openid 异步链处理，链上每个 delta 都要
   * `await push`（可能含 QQ 网络发送），因此**滞后于事件发射**。若普通消息（审批/提问卡片、
   * 命令回执）直接收流，会把正在进行的正文截断——真机表现为正文只剩第一个字（2026-09-15）。
   */
  settleStream?: (openid: string) => Promise<void>;
  logger?: Logger;
}

/**
 * 流管理器（`StreamManager` 实现）。
 * 每个 openid 同时最多一段活跃流；`sendSerialized` 会**先等在途正文推完（settleStream）
 * 再结束活跃流**，最后经 per-peer 队列发普通消息（防正文截断，见 `QqStreamManagerOptions`）。
 */
export class QqStreamManager implements StreamManager {
  private readonly client: QqClientLike;
  private readonly markdown: MarkdownAdapter;
  private readonly sender: SerialSender;
  private readonly slots: SlotAllocator;
  private readonly throttleMs: number;
  private readonly inputMode: 'append' | 'replace';
  private readonly settleStream?: (openid: string) => Promise<void>;
  private readonly logger: Logger;
  private readonly streams = new Map<string, QqStreamSession>();

  constructor(options: QqStreamManagerOptions) {
    this.client = options.client;
    this.markdown = options.markdown;
    this.sender = options.sender;
    this.slots = options.slots ?? new MsgSeqSlotAllocator();
    this.throttleMs = options.throttleMs ?? QQ_STREAM_THROTTLE_MS;
    this.inputMode = options.inputMode ?? 'append';
    this.settleStream = options.settleStream;
    this.logger = options.logger ?? createLogger('qq-stream');
  }

  /** 为一条出站目标开路；该 openid 已有活跃流时返回 null（调用方应走普通消息） */
  open(target: OutboundTarget): StreamHandle | null {
    const existing = this.streams.get(target.openid);
    if (existing && !existing.ended) return null;

    const msgId = target.msgId;
    const msgSeq = msgId ? this.allocSlot(msgId) : undefined;
    const session = new QqStreamSession({
      client: this.client,
      markdown: this.markdown,
      slots: this.slots,
      openid: target.openid,
      msgId,
      msgSeq,
      throttleMs: this.throttleMs,
      inputMode: this.inputMode,
      logger: this.logger,
    });
    this.streams.set(target.openid, session);
    return session;
  }

  isStreaming(openid: string): boolean {
    const session = this.streams.get(openid);
    return session !== undefined && !session.ended;
  }

  activeSeq(openid: string): number | undefined {
    const session = this.streams.get(openid);
    return session !== undefined && !session.ended ? session.msgSeq : undefined;
  }

  /**
   * 把一条普通消息排进 per-peer 串行队列。
   *
   * 顺序：**① 等在途正文推完（settleStream）→ ② 结束活跃流 → ③ 发普通消息**。
   * ①是截断防护的关键（真机缺陷回归）：正文增量在 turn-router 的异步链上，天然滞后，
   * 抢跑收流会把正文截断。
   */
  sendSerialized(
    target: OutboundTarget,
    payload: QqSendMessagePayload,
    options: { awaitStreamSettle?: boolean } = {},
  ): Promise<QqApiResult> {
    return this.sender.enqueue(target.openid, async () => {
      if (options.awaitStreamSettle !== false && this.settleStream) {
        try {
          await this.settleStream(target.openid);
        } catch (err) {
          // 尽力而为：等待失败不得让消息发不出去（如实记 warn，不静默吞）
          this.logger.warn(
            `[qq-stream] settleStream 失败，仍继续发送普通消息: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      await this.endActive(target.openid);
      const msgId = payload.msg_id ?? target.msgId;
      const base = this.normalizePayload(payload, msgId, payload.msg_seq);
      const isMarkdown = base.msg_type === QQ_MSG_TYPE_MARKDOWN;
      const body = ((isMarkdown ? base.markdown?.content : base.content) ?? '') as string;
      // D50：非流式单条也按字节上限切条——【实测 E3】单条 markdown ≥32000 字符（96 KB）未触限，
      // 此处取保守 16 KiB；切出的每条各占一个 `msg_seq` 槽位（复用会被判 40054005 去重）。
      const parts = body ? this.markdown.splitByBytes(body, QQ_MESSAGE_MAX_BYTES) : [body];
      let result: QqApiResult = { ok: true, status: 200, body: null };
      for (const [i, part] of parts.entries()) {
        const seq =
          i === 0 && payload.msg_seq !== undefined
            ? payload.msg_seq
            : msgId
              ? this.allocSlot(msgId)
              : undefined;
        const outgoing: QqSendMessagePayload = {
          ...base,
          ...(isMarkdown ? { markdown: { content: part } } : { content: part }),
          ...(seq !== undefined ? { msg_seq: seq } : {}),
        };
        result = await this.client.sendMessage(target.openid, outgoing);
        if (!result.ok) return result; // 任一条失败即停，如实返回失败码（绝不静默吞掉）
      }
      return result;
    });
  }

  private async endActive(openid: string): Promise<void> {
    const session = this.streams.get(openid);
    if (!session || session.ended) return;
    await session.finish();
    if (this.streams.get(openid) === session) this.streams.delete(openid);
  }

  /** 出站报文规整：补 `msg_id`/`msg_seq`；`msg_type=2` 时只发 `markdown`（E4） */
  private normalizePayload(
    payload: QqSendMessagePayload,
    msgId: string | undefined,
    seq: number | undefined
  ): QqSendMessagePayload {
    const outgoing: QqSendMessagePayload = { ...payload };
    if (msgId !== undefined) outgoing.msg_id = msgId;
    if (seq !== undefined) outgoing.msg_seq = seq;

    if (outgoing.msg_type === QQ_MSG_TYPE_MARKDOWN) {
      const raw = outgoing.markdown?.content ?? outgoing.content ?? '';
      outgoing.markdown = { content: this.markdown.toQqMarkdown(raw) };
      // 规范要求：只发 markdown 避免冗余字段
      delete outgoing.content;
    }
    return outgoing;
  }

  private allocSlot(msgId: string): number {
    const seq = this.slots.alloc(msgId);
    this.slots.occupy(msgId, seq);
    return seq;
  }
}