/**
 * 契约测试：turn-router（DSH 流式事件 → QQ 出站）
 *
 * 依据 `docs/调研纪要-第一期探针结论.md`：
 *   - E11-1：root 上下文能收到 `agent/assistant-stream`
 *   - E11-4：同一条流混有 reasoning / tool-call / block 标记 → **必须只放行 text-delta**（D9）
 *   - E11-2：`start`/`end` 是 per-attempt（每 step 一组）→ **不得在 attempt 的 end 结束流**，
 *            只在 `session/event` 的 `turn/end` 结束（D9：整回合一条流）
 *   - E11-5：全部 text-delta 按序拼接 == 最终正文
 *
 * 本测试用手写 fake 实现 `StreamManager`（跨模块隔离），不替代 Lead 的装配闭环验证。
 */

import { describe, it, expect, vi } from 'vitest';

import { TurnRouter } from '../../src/outbound/turn-router.js';
import type { Logger } from '../../src/utils/logger.js';
import type { OutboundTarget, QqApiResult, StreamHandle, StreamManager } from '../../src/types/index.js';

// ─────────────────── 测试替身 ───────────────────

interface Recording {
  target: OutboundTarget;
  pushed: string[];
  finished: string[];
  finishCount: number;
}

function makeStreamManager(options: { streamAvailable?: boolean } = {}): {
  manager: StreamManager;
  records: Recording[];
  serialized: Array<{ target: OutboundTarget; content: string }>;
} {
  const records: Recording[] = [];
  const serialized: Array<{ target: OutboundTarget; content: string }> = [];
  const streamAvailable = options.streamAvailable !== false;

  const manager: StreamManager = {
    open(target: OutboundTarget): StreamHandle | null {
      if (!streamAvailable) return null;
      const rec: Recording = { target, pushed: [], finished: [], finishCount: 0 };
      records.push(rec);
      return {
        get sentText() {
          return rec.pushed.join('');
        },
        async push(delta: string) {
          rec.pushed.push(delta);
        },
        async finish(finalText?: string) {
          rec.finishCount += 1;
          rec.finished.push(finalText ?? rec.pushed.join(''));
        },
      };
    },
    isStreaming: () => false,
    async sendSerialized(target: OutboundTarget, payload): Promise<QqApiResult> {
      serialized.push({ target, content: payload.markdown?.content ?? payload.content ?? '' });
      return { ok: true, status: 200, body: {} };
    },
    activeSeq: () => undefined,
  };
  return { manager, records, serialized };
}

function makeLogger(): Logger & { errors: unknown[] } {
  const errors: unknown[] = [];
  return {
    errors,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((...a: unknown[]) => void errors.push(a)),
    debug: vi.fn(),
  };
}

/** 最小可用的 Cordis `on` 替身（收集 handler 并可手动触发） */
function makeCtx() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const cur = handlers.get(event) ?? [];
        const i = cur.indexOf(handler);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of [...(handlers.get(event) ?? [])]) h(...args);
    },
    count(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

const SESSION_ID = 'session-t1';
const OPENID = 'openid-abc';
const TARGET: OutboundTarget = { openid: OPENID, msgId: 'msg-1' };

function makeRouter(overrides: {
  streamAvailable?: boolean;
  resolveTarget?: () => OutboundTarget | undefined;
  /** D49：回合归属判定（缺省不接线 = 旧行为「只要受控就出站」） */
  ownTurn?: (sessionId: string) => boolean;
} = {}) {
  const { manager, records, serialized } = makeStreamManager({ streamAvailable: overrides.streamAvailable });
  const logger = makeLogger();
  const router = new TurnRouter({
    streams: manager,
    openidOf: (sid) => (sid === SESSION_ID ? OPENID : undefined),
    resolveTarget: overrides.resolveTarget ?? (() => TARGET),
    ...(overrides.ownTurn === undefined ? {} : { ownTurn: overrides.ownTurn }),
    logger,
  });
  return { router, records, serialized, logger };
}

const frame = (f: Record<string, unknown>) => ({ agent: { id: SESSION_ID }, frame: f });
const chunk = (type: string, text?: string) => frame({ type: 'chunk', chunk: text === undefined ? { type } : { type, text } });

// ─────────────────── 用例 ──────────────────

describe('契约：turn-router', () => {
  it('只放行 text-delta；reasoning / tool-call / block 标记 / usage / finish 一律不进 QQ（E11-4 + D9）', async () => {
    const { router, records } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('block-start'));
    ctx.emit('agent/assistant-stream', chunk('reasoning-delta', '思考内容不应外发'));
    ctx.emit('agent/assistant-stream', chunk('text-delta', '正文A'));
    ctx.emit('agent/assistant-stream', chunk('tool-call-delta', '{"cmd":"ls"}'));
    ctx.emit('agent/assistant-stream', chunk('block-end'));
    ctx.emit('agent/assistant-stream', chunk('usage'));
    ctx.emit('agent/assistant-stream', chunk('finish'));
    await router.drain();

    expect(records).toHaveLength(1);
    expect(records[0]!.pushed).toEqual(['正文A']);
    // 关键反证：被过滤的内容绝不能出现在任何出站载荷里
    const outbound = JSON.stringify(records);
    expect(outbound).not.toContain('思考内容不应外发');
    expect(outbound).not.toContain('{"cmd":"ls"}');
  });

  it('每个 assistant/message（step）= 一条独立消息：attempt 的 end 即段边界（真机更正的语义）', async () => {
    const { router, records } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    // attempt 1（step 1）
    ctx.emit('agent/assistant-stream', frame({ type: 'start', turn: 1, step: 1, revision: 1 }));
    ctx.emit('agent/assistant-stream', chunk('text-delta', '第一段'));
    ctx.emit(
      'agent/assistant-stream',
      frame({ type: 'end', revision: 5, outcome: { kind: 'committed', eventType: 'assistant/message' } })
    );
    await router.drain();

    // 真机更正：段边界在 attempt-end，故此处**必须已经**收掉第一段
    expect(records).toHaveLength(1);
    expect(records[0]!.finishCount).toBe(1);
    expect(records[0]!.finished[0]).toBe('第一段');

    // attempt 2（step 2）
    ctx.emit('agent/assistant-stream', frame({ type: 'start', turn: 1, step: 2, revision: 6 }));
    ctx.emit('agent/assistant-stream', chunk('text-delta', '第二段'));
    ctx.emit(
      'agent/assistant-stream',
      frame({ type: 'end', revision: 20, outcome: { kind: 'committed', eventType: 'assistant/message' } })
    );
    await router.drain();

    // 两条 step 正文 → **两条独立的 QQ 消息**（各自一条流，各占一个 msg_seq 槽位）
    expect(records).toHaveLength(2);
    expect(records[1]!.finished[0]).toBe('第二段');
    // 关键反证：绝不能把两段拼在一起（真机缺陷即为此）
    expect(records.flatMap((r) => r.finished)).not.toContain('第一段第二段');

    // turn 结束：兜底 flush 不应再产出第三条消息
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();
    expect(records).toHaveLength(2);
    expect(records.flatMap((r) => r.finishCount)).toEqual([1, 1]);
  });

  it('abandoned 的 attempt 单独收尾，且绝不与下一段拼接', async () => {
    const { router, records, serialized } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', frame({ type: 'start', turn: 1, step: 1, revision: 1 }));
    ctx.emit('agent/assistant-stream', chunk('text-delta', '这段未提交'));
    ctx.emit('agent/assistant-stream', frame({ type: 'end', revision: 9, outcome: { kind: 'abandoned' } }));
    await router.drain();

    // 该段文本已通过流式增量实时显示在手机上了 → 正确做法是**收掉这一段**，
    // 而不是把它丢掉（否则 QQ 侧那条流永远不闭合）。但绝不能与下一段拼接。
    expect(serialized).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.finished[0]).toBe('这段未提交');

    ctx.emit('agent/assistant-stream', chunk('text-delta', '下一段正文'));
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();

    expect(records).toHaveLength(2);
    expect(records[1]!.finished[0]).toBe('下一段正文');
    // 关键反证：两段绝不能被拼成一条
    expect(records.flatMap((r) => r.finished)).not.toContain('这段未提交下一段正文');
  });

  it('turn/end 兜底：若最后一段没有 attempt-end 帧，仍在回合结束时发出', async () => {
    const { router, records } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('text-delta', '只有增量没有 end 帧'));
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();

    expect(records).toHaveLength(1);
    expect(records[0]!.finished[0]).toBe('只有增量没有 end 帧');
  });

  it('流式不可用时降级：turn/end 整发一条普通消息，内容为整回合正文', async () => {
    const { router, serialized } = makeRouter({ streamAvailable: false });
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('text-delta', '甲'));
    ctx.emit('agent/assistant-stream', chunk('text-delta', '乙'));
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();

    expect(serialized).toHaveLength(1);
    expect(serialized[0]!.content).toBe('甲乙');
    expect(serialized[0]!.target.openid).toBe(OPENID);
  });

  it('回合无正文时不发送任何消息（避免空消息）', async () => {
    const { router, records, serialized } = makeRouter({ streamAvailable: false });
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('reasoning-delta', '只有思考'));
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();

    expect(serialized).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('turn/end 的错误原因被记进日志（不静默吞掉上游错误）', async () => {
    const { router, logger } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit(
      'session/event',
      { id: SESSION_ID },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '上游炸了', code: 'UNKNOWN' } } } }
    );
    await router.drain();

    expect((logger as { errors: unknown[] }).errors.length).toBe(1);
    expect(JSON.stringify((logger as { errors: unknown[] }).errors)).toContain('上游炸了');
  });

  it('非本插件的会话（openidOf 返回 undefined）完全不产生出站', async () => {
    const { router, records, serialized } = makeRouter();
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', { agent: { id: 'session-not-ours' }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '不该出现' } } });
    ctx.emit('session/event', { id: 'session-not-ours' }, { type: 'turn/end', data: { turn: 1 } });
    await router.drain();

    expect(records).toHaveLength(0);
    expect(serialized).toHaveLength(0);
  });

  it('disposer 注销全部监听', () => {
    const { router } = makeRouter();
    const ctx = makeCtx();
    const dispose = router.attach(ctx);
    expect(ctx.count('agent/assistant-stream')).toBe(1);
    expect(ctx.count('session/event')).toBe(1);
    dispose();
    expect(ctx.count('agent/assistant-stream')).toBe(0);
    expect(ctx.count('session/event')).toBe(0);
  });
});

// ─────────────────── drainPeer：普通消息发送前先等在途流式事件处理完 ───────────────────
//
// 供 `QqStreamManager.settleStream` 使用：交互卡片等普通消息在收流前必须等该 peer 的
// 流式事件链把**已发射**的增量处理完，否则会截断正在进行的正文（真机缺陷，2026-09-15）。

describe('契约：TurnRouter.drainPeer', () => {
  const SESSION_B = 'session-b';
  const OPENID_B = 'openid-b';

  function makeRouterWithPush(pushImpl: (delta: string, openid: string) => Promise<void>): {
    router: TurnRouter;
    pushed: string[];
    emit: (event: string, ...args: unknown[]) => void;
  } {
    const pushed: string[] = [];
    const manager: StreamManager = {
      open(target: OutboundTarget): StreamHandle {
        return {
          get sentText() {
            return pushed.join('');
          },
          async push(delta: string) {
            await pushImpl(delta, target.openid);
            pushed.push(delta);
          },
          async finish() {
            /* noop：drainPeer 契约不涉及收流 */
          },
        };
      },
      isStreaming: () => false,
      async sendSerialized(): Promise<QqApiResult> {
        return { ok: true, status: 200, body: {} };
      },
      activeSeq: () => undefined,
    };
    const router = new TurnRouter({
      streams: manager,
      openidOf: (sid) =>
        sid === SESSION_ID ? OPENID : sid === SESSION_B ? OPENID_B : undefined,
      resolveTarget: (openid) => ({ openid, msgId: `msg-${openid}` }),
      logger: makeLogger(),
    });
    const ctx = makeCtx();
    router.attach(ctx);
    return { router, pushed, emit: ctx.emit };
  }

  it('push 仍挂着时不提前返回（等到在途 frame 处理完）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const h = makeRouterWithPush(() => gate);
    h.emit('agent/assistant-stream', chunk('text-delta', '甲'));

    let done = false;
    const waited = h.router.drainPeer(OPENID).then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false); // 不得抢跑

    release();
    await waited;
    expect(done).toBe(true);
    expect(h.pushed).toEqual(['甲']);
  });

  it('等到队列里所有已发射的增量都处理完（不止第一个）', async () => {
    const h = makeRouterWithPush(async () => undefined);
    h.emit('agent/assistant-stream', chunk('text-delta', '甲'));
    h.emit('agent/assistant-stream', chunk('text-delta', '乙'));
    h.emit('agent/assistant-stream', chunk('text-delta', '丙'));

    await h.router.drainPeer(OPENID);
    expect(h.pushed).toEqual(['甲', '乙', '丙']);
  });

  it('未知 openid 立即返回（不挂起）', async () => {
    const { router } = makeRouter();
    await expect(router.drainPeer('openid-nobody')).resolves.toBeUndefined();
  });

  it('只等目标 openid：不被另一个 openid 的在途任务阻塞', async () => {
    let releaseB!: () => void;
    const gateB = new Promise<void>((res) => {
      releaseB = res;
    });
    const h = makeRouterWithPush((_delta, openid) => (openid === OPENID_B ? gateB : Promise.resolve()));

    h.emit(
      'agent/assistant-stream',
      { agent: { id: SESSION_B }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'B 的正文' } } }
    );
    h.emit('agent/assistant-stream', chunk('text-delta', 'A 的正文'));

    let doneA = false;
    const waitedA = h.router.drainPeer(OPENID).then(() => {
      doneA = true;
    });
    await waitedA;
    expect(doneA).toBe(true); // A 不被 B 的在途任务拖住
    expect(h.pushed).toEqual(['A 的正文']);

    releaseB();
    await h.router.drainPeer(OPENID_B);
    expect(h.pushed).toEqual(['A 的正文', 'B 的正文']);
  });

  // ─────────── D49：回合归属——WebUI 发起的回合不得出站 ───────────
  //
  // 用户报告（2026-09-16）："我刚才是在 webui 和你对话的，但是 qq 那边因为控制的是这个会话，
  // 所以 qq 那边也能收到回复。"根因：出站只按会话级 `openidOf` 过滤，**没有「这个 turn 由谁发起」
  // 判定**（本文件此前也没有任何相关用例）。用户拍板：WebUI 发起的回合 QQ 侧不镜像。

  it('D49：ownTurn=false（WebUI 发起的回合）→ 不建流、不发正文、不 flush', async () => {
    const { router, records, serialized } = makeRouter({ ownTurn: () => false });
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('text-delta', 'WebUI 回合的正文不该进 QQ'));
    ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/end' });
    await router.drain();

    expect(records).toHaveLength(0);
    expect(serialized).toHaveLength(0);
  });

  it('D49：ownTurn=true（QQ 投喂的回合）→ 与旧行为一致地出站', async () => {
    const { router, records } = makeRouter({ ownTurn: () => true });
    const ctx = makeCtx();
    router.attach(ctx);

    ctx.emit('agent/assistant-stream', chunk('text-delta', 'QQ 回合的正文'));
    await router.drain();

    expect(records).toHaveLength(1);
    expect(records[0]!.pushed).toEqual(['QQ 回合的正文']);
  });
});