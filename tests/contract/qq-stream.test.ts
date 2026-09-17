/**
 * `qq/stream.ts` 契约测试（T1）
 *
 * 依据（AGENTS.md §2.2 证据分级）：
 *   - 【实测】E11-6：DSH `chunk.index` 是 **per-attempt**（每个 step 归零）→ **R8**：QQ 侧分片
 *     `index` 必须自维护跨 attempt 全局计数器，不得透传；
 *   - 【实测】E2-2：一段流式占用 `(msg_id, msg_seq)` 一个槽位，且**整段恒定一个 `msg_seq`**
 *     （nyagent 的逐片自增是错的）→ **R9**；
 *   - 【实测】E2-1/E2-3：`append` 只发增量（天然无 40007）；`replace` 必须以上次已下发内容为前缀；
 *     首片即时可见（`input_state=1`），末片 `input_state=10`；
 *   - 【实测】E4：`msg_type=2` 必须带非空 `markdown` 字段，且**只发 markdown，不同时下发 `content`**。
 *
 * 注：`SerialSender` 用测试内 fake 注入——真实实现属 T2（`src/outbound/queue.ts`）写范围，
 * 本任务不得跨范围耦合。fake 仅隔离注入依赖，不断言其内部实现（AGENTS.md §3.1）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QQ_MSG_TYPE_MARKDOWN, QQ_MESSAGE_MAX_BYTES, QQ_STREAM_REQUEST_MAX_BYTES, QQ_STREAM_THROTTLE_MS } from '../../src/constants/index.js';
import { QqMarkdownAdapter } from '../../src/qq/markdown.js';
import { MsgSeqSlotAllocator, QqStreamManager } from '../../src/qq/stream.js';
import { TurnRouter } from '../../src/outbound/turn-router.js';
import type {
  OutboundTarget,
  QqApiResult,
  QqClientLike,
  QqMessageHandler,
  QqReadyHandler,
  QqSendMessagePayload,
  QqStreamMessagePayload,
  SerialSender,
} from '../../src/types/index.js';

// ───────────────────────── 测试替身（仅隔离外部依赖） ─────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeClient implements QqClientLike {
  readonly streamCalls: Array<{ openid: string; payload: QqStreamMessagePayload }> = [];
  readonly sendCalls: Array<{ openid: string; payload: QqSendMessagePayload }> = [];
  /** 出站调用顺序（探测"先收流再发普通消息"的时序） */
  readonly events: string[] = [];
  activeStreamCalls = 0;
  maxConcurrentStreamCalls = 0;
  streamHandler: (
    payload: QqStreamMessagePayload,
    callIndex: number
  ) => QqApiResult | Promise<QqApiResult> = () => ({
    ok: true,
    status: 200,
    body: { id: 'stream-1', timestamp: 't' },
  });
  sendHandler: (payload: QqSendMessagePayload) => QqApiResult | Promise<QqApiResult> = () => ({
    ok: true,
    status: 200,
    body: { id: 'msg-out-1' },
  });

  async sendStreamMessage(openid: string, payload: QqStreamMessagePayload): Promise<QqApiResult> {
    const callIndex = this.streamCalls.length;
    this.streamCalls.push({ openid, payload });
    this.events.push('stream');
    this.activeStreamCalls += 1;
    this.maxConcurrentStreamCalls = Math.max(this.maxConcurrentStreamCalls, this.activeStreamCalls);
    try {
      return await this.streamHandler(payload, callIndex);
    } finally {
      this.activeStreamCalls -= 1;
    }
  }

  async sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult> {
    this.sendCalls.push({ openid, payload });
    this.events.push('message');
    return await this.sendHandler(payload);
  }

  // 以下接口本契约测试不使用，最小实现即可
  async start(): Promise<void> {}
  stop(): void {}
  async getAccessToken(): Promise<string> {
    return 'token';
  }
  async authHeader(): Promise<Record<string, string>> {
    return { Authorization: 'QQBot token' };
  }
  onC2CMessage(_handler: QqMessageHandler): void {}
  onReady(_handler: QqReadyHandler): void {}
  async apiPost(_pathname: string, _payload: unknown): Promise<QqApiResult> {
    return { ok: true, status: 200, body: {} };
  }
  async putPresigned(_url: string, _body: Uint8Array): Promise<{ ok: boolean; status: number }> {
    return { ok: true, status: 200 };
  }
  async fetchAttachment(
    _url: string
  ): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }> {
    return { ok: true, status: 200, bytes: new Uint8Array(), contentType: null };
  }
}

class FakeSerialSender implements SerialSender {
  readonly peers: string[] = [];
  private chains = new Map<string, Promise<unknown>>();

  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T> {
    this.peers.push(peer);
    const prev = this.chains.get(peer) ?? Promise.resolve();
    const run = prev.then(() => task());
    this.chains.set(
      peer,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  clear(): void {
    this.chains.clear();
  }
}

interface Harness {
  client: FakeClient;
  slots: MsgSeqSlotAllocator;
  sender: FakeSerialSender;
  manager: QqStreamManager;
  target: OutboundTarget;
}

function makeHarness(options: {
  throttleMs?: number;
  inputMode?: 'append' | 'replace';
  settleStream?: (openid: string) => Promise<void>;
} = {}): Harness {
  const client = new FakeClient();
  const slots = new MsgSeqSlotAllocator();
  const sender = new FakeSerialSender();
  const manager = new QqStreamManager({
    client,
    markdown: new QqMarkdownAdapter(),
    slots,
    sender,
    throttleMs: options.throttleMs ?? QQ_STREAM_THROTTLE_MS,
    inputMode: options.inputMode,
    ...(options.settleStream ? { settleStream: options.settleStream } : {}),
    logger: silentLogger,
  });
  return {
    client,
    slots,
    sender,
    manager,
    target: { openid: 'openid-a', msgId: 'msg-1' },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── R8：QQ 分片序号自维护 ─────────────────────────

describe('qq/stream · R8 分片 index 自维护全局计数', () => {
  it('跨 step（DSH 每 attempt 归零）index 严格单调递增，不回退', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;

    // 事件层只转发 text-delta 的 text；DSH per-attempt 的 chunk.index 不进入本模块。
    const step1 = [
      { index: 0, text: '第一步甲' },
      { index: 1, text: '第一步乙' },
    ];
    // 第二个 step：DSH 的 chunk.index 又从 0 开始（E11-6）
    const step2 = [
      { index: 0, text: '第二步丙' },
      { index: 1, text: '第二步丁' },
    ];
    for (const chunk of step1) await handle.push(chunk.text);
    for (const chunk of step2) await handle.push(chunk.text);
    await handle.finish();

    const indexes = h.client.streamCalls.map((c) => c.payload.index);
    expect(indexes).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
    expect(new Set(indexes).size).toBe(indexes.length);
    // 整数序列里不存在"step 边界回退"（0 之后再出现 0）
    expect(indexes.slice(1).filter((i) => i === 0)).toEqual([]);
  });
});

// ───────────────────────── R9：单段流式只用一个 msg_seq ─────────────────────────

describe('qq/stream · R9 单段流式恒定一个 msg_seq（E2-2）', () => {
  it('多片流式全程复用同一个 msg_seq，不逐片自增', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    for (const text of ['一', '二', '三', '四', '五']) await handle.push(text);
    await handle.finish();

    expect(h.client.streamCalls.length).toBeGreaterThanOrEqual(6);
    const seqs = h.client.streamCalls.map((c) => c.payload.msg_seq);
    expect(new Set(seqs).size).toBe(1);
    expect(seqs[0]).toBe(1);
  });

  it('流式只占用一个槽位（同一 msg_id 下 used 仅 1 格）', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    await handle.push('一片');
    await handle.push('两片');
    await handle.finish();
    expect([...h.slots.used('msg-1')]).toEqual([1]);
  });
});

describe('MsgSeqSlotAllocator（R9 槽位唯一性）', () => {
  it('alloc 从 1 起取最小空闲格、occupy 登记、release 回收、按 msg_id 隔离', () => {
    const slots = new MsgSeqSlotAllocator();
    expect(slots.alloc('m')).toBe(1);
    expect(slots.alloc('m')).toBe(2);
    slots.occupy('m', 5);
    expect(slots.alloc('m')).toBe(3);
    slots.occupy('m', 3); // 幂等
    expect([...slots.used('m')].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    expect(slots.alloc('other')).toBe(1);
    slots.release('m');
    expect(slots.alloc('m')).toBe(1);
  });
});

// ──────────────────────── E2：首片即显、模式与状态流转 ─────────────────────────

describe('qq/stream · E2 首片与 input_state 流转', () => {
  it('首片即时下发：input_state=1、append、index=0、只带待下发文本', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const h = makeHarness();
    const handle = h.manager.open(h.target)!;

    await handle.push('#标题');
    expect(h.client.streamCalls).toHaveLength(1);
    const first = h.client.streamCalls[0].payload;
    expect(first.index).toBe(0);
    expect(first.input_state).toBe(1);
    expect(first.input_mode).toBe('append');
    expect(first.content_type).toBe('markdown');
    expect(first.content_raw).toBe('# 标题');
    expect(first.msg_id).toBe('msg-1');
    expect(first.msg_seq).toBe(1);
    // 首片由服务端返回 stream_msg_id，不应在首片请求里携带
    expect(first.stream_msg_id).toBeUndefined();
  });

  it('续片携带首片返回的 stream_msg_id；末片 input_state=10', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    await handle.push('甲');
    await handle.push('乙');
    expect(h.client.streamCalls[1].payload.stream_msg_id).toBe('stream-1');
    await handle.finish();
    const last = h.client.streamCalls.at(-1)!;
    expect(last.payload.input_state).toBe(10);
    expect(last.payload.stream_msg_id).toBe('stream-1');
  });

  it('append 模式只发增量，不重复已下发前缀（天然规避 40007）', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    await handle.push('第一段');
    await handle.push('第二段');
    await handle.finish();

    const contents = h.client.streamCalls.map((c) => c.payload.content_raw);
    expect(contents[0]).toBe('第一段');
    expect(contents[1]).toBe('第二段');
    expect(h.client.streamCalls[1].payload.content_raw).not.toContain('第一段');
    // 服务端累积已下发内容应精确等于正文（不重复、不丢失）
    expect(contents.join('')).toBe('第一段第二段');
  });

  it('replace 模式每片以上次已下发内容为前缀（E2-3 防线）', async () => {
    const h = makeHarness({ throttleMs: 0, inputMode: 'replace' });
    const handle = h.manager.open(h.target)!;
    for (const text of ['甲', '乙', '丙']) await handle.push(text);
    const contents = h.client.streamCalls.map((c) => c.payload.content_raw);
    expect(contents).toEqual(['甲', '甲乙', '甲乙丙']);
    for (const call of h.client.streamCalls) expect(call.payload.input_mode).toBe('replace');
    for (let i = 1; i < contents.length; i += 1) {
      expect(contents[i].startsWith(contents[i - 1])).toBe(true);
    }
  });
});

// ───────────────────────── 节流与在途串行 ─────────────────────────

describe('qq/stream · 节流（QQ_STREAM_THROTTLE_MS）与在途 flush 串行', () => {
  it('节流窗口内不追加 flush，超时后补 flush 且只发增量', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const handle = h.manager.open(h.target)!;

    await handle.push('甲');
    expect(h.client.streamCalls).toHaveLength(1); // 首片即时

    await handle.push('乙');
    expect(h.client.streamCalls).toHaveLength(1); // 未到窗口
    await vi.advanceTimersByTimeAsync(QQ_STREAM_THROTTLE_MS - 1);
    expect(h.client.streamCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.streamCalls).toHaveLength(2);
    expect(h.client.streamCalls[1].payload.content_raw).toBe('乙');
  });

  it('在途 flush 串行：并发 push 不重入、不丢内容、index 严格递增', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const handle = h.manager.open(h.target)!;
    const gate = deferred<QqApiResult>();
    h.client.streamHandler = (_payload, callIndex) =>
      callIndex === 1 ? gate.promise : { ok: true, status: 200, body: { id: 'stream-1' } };

    await handle.push('A'); // 首片立即
    expect(h.client.streamCalls).toHaveLength(1);

    void handle.push('B'); // 排定节流窗口后的 flush
    await vi.advanceTimersByTimeAsync(QQ_STREAM_THROTTLE_MS); // 第 2 片在途（gate 未决）

    const cPromise = handle.push('C'); // 在途期间的追加
    const dPromise = handle.push('D');
    expect(h.client.streamCalls).toHaveLength(2);
    expect(h.client.activeStreamCalls).toBe(1);
    expect(h.client.maxConcurrentStreamCalls).toBe(1);

    gate.resolve({ ok: true, status: 200, body: { id: 'stream-1' } });
    await cPromise;
    await dPromise;

    expect(h.client.maxConcurrentStreamCalls).toBe(1); // 全程无并发重入
    expect(h.client.streamCalls.map((c) => c.payload.content_raw)).toEqual(['A', 'B', 'CD']);
    expect(h.client.streamCalls.map((c) => c.payload.content_raw).join('')).toBe('ABCD');
    expect(h.client.streamCalls.map((c) => c.payload.index)).toEqual([0, 1, 2]);
  });
});

// ───────────────────────── 失败回退 ─────────────────────────

describe('qq/stream · 失败回退（绝不静默丢内容）', () => {
  it('中间片失败（40007）→ 终止流式，用新 msg_seq 发一条纯 markdown 普通消息', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    h.client.streamHandler = (_payload, callIndex) =>
      callIndex === 1
        ? { ok: false, status: 200, code: '40007', message: '已经提交的消息内容不可修改', body: { code: 40007 } }
        : { ok: true, status: 200, body: { id: 'stream-1' } };

    await handle.push('甲');
    await handle.push('乙'); // 第 2 片失败
    await handle.push('丙'); // 失败后仍必须累积（不丢内容）
    await handle.finish();

    expect(h.client.streamCalls).toHaveLength(2); // 终止流式，不再发片
    expect(h.client.sendCalls).toHaveLength(1);
    const fallback = h.client.sendCalls[0].payload;
    expect(fallback.msg_type).toBe(QQ_MSG_TYPE_MARKDOWN);
    expect(fallback.markdown?.content).toContain('甲乙丙');
    expect(fallback.content).toBeUndefined(); // 剔除 nyagent 的 content+markdown 双下发
    expect(fallback.msg_id).toBe('msg-1');

    const streamSeq = h.client.streamCalls[0].payload.msg_seq;
    expect(fallback.msg_seq).toBeDefined();
    expect(fallback.msg_seq).not.toBe(streamSeq); // 回退取新槽位
    expect(h.slots.used('msg-1').has(fallback.msg_seq!)).toBe(true);
    expect(h.manager.isStreaming('openid-a')).toBe(false);
    // sentText 语义 = 已成功下发的内容（此处仅首片）
    expect(handle.sentText).toBe('甲');
  });

  it('首片即失败 → 依然完整回退为普通 markdown', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    h.client.streamHandler = () => ({ ok: false, status: 200, code: '50002', message: '限频', body: { code: 50002 } });

    await handle.push('完整正文');
    await handle.finish();

    expect(h.client.streamCalls).toHaveLength(1);
    expect(h.client.sendCalls).toHaveLength(1);
    expect(h.client.sendCalls[0].payload.markdown?.content).toBe('完整正文');
  });

  it('sendStreamMessage 抛出异常同样触发回退（不把异常抛给调用方）', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    h.client.streamHandler = () => {
      throw new Error('ECONNRESET');
    };

    await expect(handle.push('正文')).resolves.toBeUndefined();
    await handle.finish();
    expect(h.client.sendCalls).toHaveLength(1);
    expect(h.client.sendCalls[0].payload.markdown?.content).toBe('正文');
  });
});

// ───────────────────────── StreamManager 装配行为 ─────────────────────────

describe('qq/stream · StreamManager 行为', () => {
  it('open 分配槽位；已活跃时再 open 返回 null；finish 后复位', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target);
    expect(handle).not.toBeNull();
    expect(h.manager.isStreaming('openid-a')).toBe(true);
    expect(h.manager.activeSeq('openid-a')).toBe(1);
    expect(h.slots.used('msg-1').has(1)).toBe(true);

    expect(h.manager.open(h.target)).toBeNull(); // 活跃期间不得开第二路

    await handle!.push('正文');
    await handle!.finish();
    expect(h.manager.isStreaming('openid-a')).toBe(false);
    expect(h.manager.activeSeq('openid-a')).toBeUndefined();
    expect(h.manager.open(h.target)).not.toBeNull();
  });

  it('sendSerialized：先结束活跃流再发普通消息，且经 per-peer 串行队列', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    await handle.push('流式正文');

    const res = await h.manager.sendSerialized(h.target, {
      msg_type: QQ_MSG_TYPE_MARKDOWN,
      content: '命令回执',
      markdown: { content: '命令回执' },
      msg_id: 'msg-1',
    });

    expect(res.ok).toBe(true);
    expect(h.client.events).toEqual(['stream', 'stream', 'message']); // 正文片 + 结束片 + 普通消息
    expect(h.manager.isStreaming('openid-a')).toBe(false);
    expect(h.sender.peers).toEqual(['openid-a']);

    const sent = h.client.sendCalls[0].payload;
    expect(sent.markdown?.content).toBe('命令回执');
    expect(sent.content).toBeUndefined(); // 只发 markdown
    const streamSeq = h.client.streamCalls[0].payload.msg_seq;
    expect(sent.msg_seq).toBeDefined();
    expect(sent.msg_seq).not.toBe(streamSeq); // 流式槽位不可复用
    expect(h.slots.used('msg-1').has(sent.msg_seq!)).toBe(true);
  });

  it('sendSerialized 从 target 补全 msg_id，并取不到重复的 msg_seq', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.manager.sendSerialized(h.target, { msg_type: 0, content: '回执一' });
    await h.manager.sendSerialized(h.target, { msg_type: 0, content: '回执二' });

    const seqs = h.client.sendCalls.map((c) => c.payload.msg_seq);
    expect(new Set(seqs).size).toBe(2);
    for (const call of h.client.sendCalls) expect(call.payload.msg_id).toBe('msg-1');
    expect(h.client.sendCalls.map((c) => c.payload.content)).toEqual(['回执一', '回执二']);
  });

  it('msg_type=2 且只给 content 时补出 markdown 字段（E4-2：否则 40034011）', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.manager.sendSerialized(h.target, { msg_type: QQ_MSG_TYPE_MARKDOWN, content: '#标题' });
    const sent = h.client.sendCalls[0].payload;
    expect(sent.markdown?.content).toBe('# 标题');
    expect(sent.content).toBeUndefined();
  });

  it('msg_type=0 纯文本回执不被改写', async () => {
    const h = makeHarness({ throttleMs: 0 });
    await h.manager.sendSerialized(h.target, { msg_type: 0, content: '纯文本 # 保留' });
    const sent = h.client.sendCalls[0].payload;
    expect(sent.content).toBe('纯文本 # 保留');
    expect(sent.markdown).toBeUndefined();
  });
});

// ─────────── 普通消息不得截断在途正文流（真机缺陷回归，2026-09-15） ────────────
//
// 真机现象：交互卡片（审批/提问）投递时，正文流只推出去一个「沙」字就被截断。
// 根因：卡片走 sendSerialized → **抢先** endActive/收流；而正文增量由 turn-router 的
// per-openid 异步链处理（每个 delta 都 await push，可能含网络），天然滞后于事件发射
// ⇒ 收流时 session.buffer 只有第一个增量，之后 push 全部因 finished 被丢弃。
//
// 契约：sendSerialized 发普通消息前**必须**先 await settleStream（由接线层接
// turn-router.drainPeer），确保已发射的增量全部处理完再收流。

describe('qq/stream · 普通消息不得截断在途正文流（真机缺陷回归）', () => {
  it('sendSerialized 先 await settleStream，末片含「钩子期间补推」的正文（不再只剩一个「沙」）', async () => {
    const gate = deferred<void>();
    const settle = vi.fn(() => gate.promise);
    const h = makeHarness({ throttleMs: 60_000, settleStream: settle });
    const handle = h.manager.open(h.target)!;
    await handle.push('沙'); // 首片即时：模拟刚推出去的那个增量

    const card = h.manager.sendSerialized(h.target, { msg_type: 0, content: '审批卡片' });
    await Promise.resolve();

    // settle 未决前：既不得收流（结束片），也不得抢先发普通消息
    expect(h.client.streamCalls).toHaveLength(1);
    expect(h.client.sendCalls).toHaveLength(0);

    // 模拟 turn-router 链中剩余的增量在此窗口内被推完
    await handle.push(
      '箱按预期拒绝并给出升级凭据。现在执行升级重试——审批卡片应出现在 QQ，请回复 y 或 n。'
    );
    gate.resolve();
    await card;

    // 关键反证：整段正文必须完整下发（拼接所有流片 == 全文）
    const streamed = h.client.streamCalls.map((c) => c.payload.content_raw).join('');
    expect(streamed).toBe(
      '沙箱按预期拒绝并给出升级凭据。现在执行升级重试——审批卡片应出现在 QQ，请回复 y 或 n。'
    );
    expect(settle).toHaveBeenCalledWith('openid-a');
    expect(h.client.events.at(-1)).toBe('message');
  });

  it('settleStream 抛错时普通消息仍必须送达（尽力而为，不因等待而丢消息）', async () => {
    const settle = vi.fn(async () => {
      throw new Error('drain boom');
    });
    const h = makeHarness({ throttleMs: 0, settleStream: settle });
    const res = await h.manager.sendSerialized(h.target, { msg_type: 0, content: '回执' });
    expect(res.ok).toBe(true);
    expect(h.client.sendCalls).toHaveLength(1);
    expect(h.client.sendCalls[0]!.payload.content).toBe('回执');
  });

  it('组合（复刻 src/index.ts 接线）：正文尚未推完时发审批卡片 → 全文不丢、卡片在其后', async () => {
    const client = new FakeClient();
    const slots = new MsgSeqSlotAllocator();
    const sender = new FakeSerialSender();
    const routerRef: { current?: TurnRouter } = {};
    const manager = new QqStreamManager({
      client,
      markdown: new QqMarkdownAdapter(),
      slots,
      sender,
      throttleMs: 0,
      logger: silentLogger,
      // 与 index.ts 同形：settleStream 接到 turn-router.drainPeer
      settleStream: (openid) => routerRef.current?.drainPeer(openid) ?? Promise.resolve(),
    });
    const router = new TurnRouter({
      streams: manager,
      openidOf: (sid) => (sid === 'session-x' ? 'openid-a' : undefined),
      resolveTarget: () => ({ openid: 'openid-a', msgId: 'msg-1' }),
      logger: silentLogger,
    });
    routerRef.current = router;

    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    router.attach({
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => undefined;
      },
    });
    const emit = (event: string, ...args: unknown[]): void => {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
    };
    const delta = (text: string): unknown => ({
      agent: { id: 'session-x' },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
    });

    // 首片网络调用挂起：模拟「事件已发射、但 turn-router 链还没处理完」
    const firstFlush = deferred<QqApiResult>();
    client.streamHandler = (_payload, callIndex) =>
      callIndex === 0 ? firstFlush.promise : { ok: true, status: 200, body: { id: 'stream-1' } };

    emit('agent/assistant-stream', delta('沙'));
    emit('agent/assistant-stream', delta('箱按预期拒绝'));
    emit('agent/assistant-stream', delta('请回复 y 或 n。'));

    // 正文还没推完时审批卡片发出 —— 修复前正是在这里抢跑收流
    const card = manager.sendSerialized(
      { openid: 'openid-a', msgId: 'msg-1' },
      { msg_type: 0, content: '需要你批准一次操作' }
    );
    await Promise.resolve();
    expect(client.sendCalls).toHaveLength(0); // 未 drain 完不得先发卡片

    firstFlush.resolve({ ok: true, status: 200, body: { id: 'stream-1' } });
    await card;

    const streamed = client.streamCalls.map((c) => c.payload.content_raw).join('');
    expect(streamed).toBe('沙箱按预期拒绝请回复 y 或 n。');
    expect(client.sendCalls.map((c) => c.payload.content)).toEqual(['需要你批准一次操作']);
    expect(client.events.at(-1)).toBe('message');
  });
});

// ─────────── 长正文不得被静默截断（真机缺陷回归，2026-09-16 · E3 实测） ──────────
//
// 真机现象：一条 **6118 码点**的回复在 QQ 只收到**前 4000 码点**，且无报错、无回退。
// 根因（D50）：`toQqMarkdown()` 按**整段累积正文**截断到 4000，而 append 模式只发增量
//            ⇒ `formatted` 冻结后增量恒为空，后半段永久发不出去，`finish()` 只补一个空片。
// 【实测 E3】平台真实约束是**单次请求 ≈20 KiB 字节**（`40054018`），与**累积总量无关**
//            （20000 字符累积全部 200）⇒ 正确做法是"按请求切分"，**绝不截断整段**。

describe('qq/stream · 长正文不得被静默截断（真机缺陷回归，2026-09-16）', () => {
  it('单步 6118 码点正文全部送达（修复前止步于 4000 码点）', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    const full = '填'.repeat(6118);

    await handle.push(full);
    await handle.finish(full);

    const delivered = h.client.streamCalls
      .filter((c) => c.payload.input_state === 1)
      .map((c) => String(c.payload.content_raw))
      .join('');
    expect(Array.from(delivered).length).toBe(6118);
    expect(delivered).toBe(full);
  });

  it('append 模式每一片的 UTF-8 字节数都不超过单次请求上限', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    const full = '填'.repeat(6118);
    await handle.push(full);
    await handle.finish(full);

    expect(h.client.streamCalls.length).toBeGreaterThan(1);
    for (const call of h.client.streamCalls) {
      expect(Buffer.byteLength(String(call.payload.content_raw ?? ''), 'utf8')).toBeLessThanOrEqual(
        QQ_STREAM_REQUEST_MAX_BYTES
      );
    }
  });

  it('末片仍带 input_state=10（结束信号不丢），且跨片拼接等于全文', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const handle = h.manager.open(h.target)!;
    const full = '填'.repeat(6118);
    await handle.push(full);
    await handle.finish(full);

    expect(h.client.streamCalls.at(-1)!.payload.input_state).toBe(10);
    const generating = h.client.streamCalls.filter((c) => c.payload.input_state === 1);
    expect(generating.map((c) => String(c.payload.content_raw)).join('')).toBe(full);
  });

  it('replace 模式：前缀片不超字节上限；累积全文超限后余量改用 append 续发（最终送达 == 全文）', async () => {
    const h = makeHarness({ throttleMs: 0, inputMode: 'replace' });
    const handle = h.manager.open(h.target)!;
    const full = '填'.repeat(4000); // 12 000 字节 ⇒ 至少 2 片
    await handle.push(full);
    await handle.finish(full);

    const calls = h.client.streamCalls;
    expect(calls.filter((c) => c.payload.input_state === 1).length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(Buffer.byteLength(String(call.payload.content_raw ?? ''), 'utf8')).toBeLessThanOrEqual(
        QQ_STREAM_REQUEST_MAX_BYTES
      );
    }
    // replace 片必须以上一片 replace 片为前缀（官方要求，否则 40007）
    const replaces = calls
      .filter((c) => c.payload.input_mode === 'replace' && c.payload.input_state === 1)
      .map((c) => String(c.payload.content_raw));
    expect(replaces.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < replaces.length; i += 1) {
      expect(replaces[i]!.startsWith(replaces[i - 1]!)).toBe(true);
    }
    // 最终送达 = 最后一个 replace 片 + 其后 append 片拼接（超限余量以 append 续发）
    const lastReplaceIdx = calls.findLastIndex((c) => c.payload.input_mode === 'replace');
    const delivered =
      String(calls[lastReplaceIdx]!.payload.content_raw) +
      calls
        .slice(lastReplaceIdx + 1)
        .filter((c) => c.payload.input_state === 1)
        .map((c) => String(c.payload.content_raw))
        .join('');
    expect(delivered).toBe(full);
    expect(calls.at(-1)!.payload.input_state).toBe(10);
  });

  it('降级整发路径（sendSerialized）超长正文切成多条普通消息：内容不丢 + 各自独立 msg_seq', async () => {
    const h = makeHarness({ throttleMs: 0 });
    const full = '填'.repeat(20000); // 60 000 字节 ⇒ 至少 4 条
    const res = await h.manager.sendSerialized(h.target, {
      msg_type: QQ_MSG_TYPE_MARKDOWN,
      markdown: { content: full },
    });

    expect(res.ok).toBe(true);
    const sent = h.client.sendCalls.map((c) => String(c.payload.markdown?.content ?? ''));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('')).toBe(full);
    for (const call of h.client.sendCalls) {
      expect(Buffer.byteLength(String(call.payload.markdown?.content ?? ''), 'utf8')).toBeLessThanOrEqual(
        QQ_MESSAGE_MAX_BYTES
      );
    }
    // (msg_id, msg_seq) 唯一：复用会被平台判 40054005 去重
    const seqs = h.client.sendCalls.map((c) => c.payload.msg_seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});