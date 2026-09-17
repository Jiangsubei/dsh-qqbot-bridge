/**
 * 契约测试：远端交互层（`src/inbound/interactions.ts`）—— 审批 + 提问
 *
 * 覆盖用户 2026-09-15 拍板的决策：
 *   1. **waterfall 抢占优先级**：WebUI 宿主 answerer（`dsh-api-remotes`，由 `dsh-web-app`
 *      bundle 先于本插件插入）在 `approval/request` 与 `user-questions/request` 上先注册、
 *      转给浏览器且不作答就不 `next()` ⇒ 必须 `{ prepend: true }` 才能抢到最前
 *      （`cordis/lib/index.js:307-325` 的 veto 语义、`:336` 的 unshift）。
 *   2. **判定语义**：「远程控制」语境下没有「QQ 会话」概念，只有「**当前正被远程受控的会话**」
 *      ⇒ 非受控会话一律 `next()` 委派，绝不劫持 WebUI 的交互。
 *   3. 审批/提问走**普通消息**、超时 fail-closed、同 openid 同时只保留一个待决交互。
 *
 * 说明：本文件用最小 `ctx` 桩与 fake `sendText`/`controlledBy` 隔离外部依赖；
 * 真实装配（`bootDshQqbotBridge`）由 `assembly.test.ts` 与真机验证覆盖（AGENTS §3.1）。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';

import { QqInteractions } from '../../src/inbound/interactions.js';
import type { Logger } from '../../src/utils/logger.js';

const OPENID = 'user-1';
const CONTROLLED_SESSION = 'session-controlled';
const OTHER_SESSION = 'session-other';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Handler = (...args: unknown[]) => unknown;

interface Harness {
  interactions: QqInteractions;
  sendText: Mock;
  controlledBy: Mock;
  handlers: Map<string, Handler>;
  on: Mock;
}

function makeHarness(options: { timeoutMs?: number; ownTurn?: boolean } = {}): Harness {
  const sendText = vi.fn(async (_openid: string, _text: string): Promise<void> => {});
  // 受控会话反查：只有 CONTROLLED_SESSION 当前被 OPENID 控制
  const controlledBy = vi.fn((sessionId: string): string | undefined =>
    sessionId === CONTROLLED_SESSION ? OPENID : undefined,
  );
  const handlers = new Map<string, Handler>();
  const on = vi.fn((event: string, handler: Handler): (() => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  });
  const interactions = new QqInteractions({
    sendText,
    controlledBy,
    // D49：缺省不接线（旧行为）；显式传入时按回合归属判定
    ...(options.ownTurn === undefined ? {} : { ownTurn: () => options.ownTurn as boolean }),
    logger,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  interactions.attach({ on });
  return { interactions, sendText, controlledBy, handlers, on };
}

function handlerOf(h: Harness, event: string): Handler {
  const handler = h.handlers.get(event);
  if (!handler) throw new Error(`测试夹具错误：未挂载 ${event}`);
  return handler;
}

/** 无定时器的微任务轮询（等待交互层登记 pending） */
async function waitFor(cond: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor 超时：条件始终未满足');
}

function approvalReq(sessionId: string): Record<string, unknown> {
  return { agent: { session: { id: sessionId } }, toolName: 'Bash', reason: '写文件' };
}

function questionReq(sessionId: string): Record<string, unknown> {
  return {
    agent: { session: { id: sessionId } },
    questions: [
      {
        id: 'q1',
        question: '选哪个？',
        header: '方案',
        options: [
          { label: 'A', description: '第一个' },
          { label: 'B' },
        ],
      },
    ],
  };
}

// ══════════════════════════ 装配契约（本次缺陷的根因回归） ═══════════════════════════

describe('契约: 交互层挂载必须抢在 WebUI 宿主 answerer 之前（prepend）', () => {
  it('两个 waterfall 都以 { prepend: true } 注册', () => {
    const h = makeHarness();
    expect(h.on).toHaveBeenCalledWith('approval/request', expect.any(Function), { prepend: true });
    expect(h.on).toHaveBeenCalledWith('user-questions/request', expect.any(Function), { prepend: true });
  });

  it('两种事件都被挂载（不是只挂一个）', () => {
    const h = makeHarness();
    expect(h.handlers.has('approval/request')).toBe(true);
    expect(h.handlers.has('user-questions/request')).toBe(true);
  });
});

// ═══════════════════════════ 判定语义：只有「当前受控会话」才接管 ═══════════════════════════

describe('契约: 只有当前正被远程受控的会话才接管，其余一律委派 WebUI', () => {
  it('非受控会话的审批 → next() 委派，不发任何 QQ 消息', async () => {
    const h = makeHarness();
    const next = vi.fn(async () => 'unavailable' as const);
    const out = await handlerOf(h, 'approval/request')(approvalReq(OTHER_SESSION), next);
    expect(out).toBe('unavailable');
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('非受控会话的提问 → next() 委派，不发任何 QQ 消息', async () => {
    const h = makeHarness();
    const next = vi.fn(async () => ({ answers: [] }));
    const out = await handlerOf(h, 'user-questions/request')(questionReq(OTHER_SESSION), next);
    expect(out).toEqual({ answers: [] });
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('无 session id 的审批/提问 → 委派（不猜、不劫持）', async () => {
    const h = makeHarness();
    const nextA = vi.fn(async () => 'unavailable' as const);
    await handlerOf(h, 'approval/request')({ toolName: 'Bash' }, nextA);
    const nextQ = vi.fn(async () => ({ answers: [] }));
    await handlerOf(h, 'user-questions/request')({ questions: [] }, nextQ);
    expect(nextA).toHaveBeenCalledTimes(1);
    expect(nextQ).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════ 审批 ═══════════════════════════

describe('契约: 受控会话审批（y/n/cancel + 超时 fail-closed）', () => {
  it('y → allowed-once，且卡片走普通消息发给该 openid', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    const [openid, text] = h.sendText.mock.calls[0] as [string, string];
    expect(openid).toBe(OPENID);
    expect(text).toContain('Bash');
    expect(h.interactions.approval.handle(OPENID, 'y')).toBe(true);
    await expect(pending).resolves.toBe('allowed-once');
  });

  it('n → rejected（官方 outcome 词汇，不自定义）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    h.interactions.approval.handle(OPENID, '拒绝');
    await expect(pending).resolves.toBe('rejected');
  });

  it('/取消 → cancelled', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    h.interactions.approval.handle(OPENID, '/取消');
    await expect(pending).resolves.toBe('cancelled');
  });

  it('无法识别的回复 → 按拒绝处理（不转发给正在阻塞的 agent）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    h.interactions.approval.handle(OPENID, '随便说点什么');
    await expect(pending).resolves.toBe('rejected');
  });

  it('超时 → fail-closed 返回 rejected 并告知', async () => {
    const h = makeHarness({ timeoutMs: 20 });
    const out = await handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    expect(out).toBe('rejected');
    expect(h.interactions.approval.hasPending(OPENID)).toBe(false);
    const texts = h.sendText.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes('超时'))).toBe(true);
  });

  it('同一 openid 新请求顶掉旧请求：旧请求 fail-closed（rejected），新请求仍可作答', async () => {
    const h = makeHarness();
    const first = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    const second = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());
    await expect(first).resolves.toBe('rejected');
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    h.interactions.approval.handle(OPENID, 'y');
    await expect(second).resolves.toBe('allowed-once');
  });

  it('signal 已中止 → cancelled（不猜用户意图）', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const req = { ...approvalReq(CONTROLLED_SESSION), signal: controller.signal };
    const pending = handlerOf(h, 'approval/request')(req, vi.fn());
    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    h.interactions.approval.handle(OPENID, 'y');
    await expect(pending).resolves.toBe('cancelled');
  });
});

// ═══════════════════════════ 提问 ═══════════════════════════

describe('契约: 受控会话提问（序号 / 多选 / 自定义 / 跳过 / 取消）', () => {
  it('回复序号 → selected 取选项 label（不是序号）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    const [, card] = h.sendText.mock.calls[0] as [string, string];
    expect(card).toContain('选哪个？');
    expect(card).toContain('1. A —— 第一个');
    expect(h.interactions.question.handle(OPENID, '2')).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] });
  });

  it('非序号文本 → custom 自定义答案（selected 为空，不编造选项）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    h.interactions.question.handle(OPENID, '我自己想的方案');
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '我自己想的方案' }],
    });
  });

  it('multiSelect：逗号多选 → 多个 label', async () => {
    const h = makeHarness();
    const req = questionReq(CONTROLLED_SESSION);
    (req.questions as Array<Record<string, unknown>>)[0]!.multiSelect = true;
    const pending = handlerOf(h, 'user-questions/request')(req, vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    h.interactions.question.handle(OPENID, '1,2');
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A', 'B'] }] });
  });

  it('单选下多给序号 → 只取第一个（跟随 multiSelect=false 契约）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    h.interactions.question.handle(OPENID, '1,2');
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] });
  });

  it('/跳过 → 该题 selected 为空且继续（不抛错）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    h.interactions.question.handle(OPENID, '/跳过');
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] });
  });

  it('/取消 → 如实抛错（fail-closed，不编造答案）', async () => {
    const h = makeHarness();
    const pending = handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    h.interactions.question.handle(OPENID, '/取消');
    await expect(pending).rejects.toThrow();
  });

  it('多题串行：逐题下发，最后一题答完才一次性返回全部答案', async () => {
    const h = makeHarness();
    const req = {
      agent: { session: { id: CONTROLLED_SESSION } },
      questions: [
        { id: 'q1', question: '第一问', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '第二问', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    };
    const pending = handlerOf(h, 'user-questions/request')(req, vi.fn());
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(String(h.sendText.mock.calls[0]![1])).toContain('第一问');
    h.interactions.question.handle(OPENID, '1');
    await waitFor(() => h.interactions.question.hasPending(OPENID));
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(String(h.sendText.mock.calls[1]![1])).toContain('第二问');
    h.interactions.question.handle(OPENID, '2');
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: ['D'] },
      ],
    });
  });

  it('无 questions 的请求 → 委派（不空转）', async () => {
    const h = makeHarness();
    const next = vi.fn(async () => ({ answers: [] }));
    await handlerOf(h, 'user-questions/request')(
      { agent: { session: { id: CONTROLLED_SESSION } }, questions: [] },
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════ 卸载 ═══════════════════════════

describe('契约: 卸载时 fail-closed 清空待决', () => {
  it('disposer 让待决审批立即以 rejected 收尾，并卸载监听', async () => {
    const sendText = vi.fn(async (_openid: string, _text: string): Promise<void> => {});
    const controlledBy = vi.fn((sessionId: string): string | undefined =>
      sessionId === CONTROLLED_SESSION ? OPENID : undefined,
    );
    const handlers = new Map<string, Handler>();
    const on = vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    });
    const interactions = new QqInteractions({ sendText, controlledBy, logger });
    const dispose = interactions.attach({ on });
    const pending = handlers.get('approval/request')!(approvalReq(CONTROLLED_SESSION), vi.fn());
    await waitFor(() => interactions.approval.hasPending(OPENID));
    dispose();
    await expect(pending).resolves.toBe('rejected');
    expect(handlers.has('approval/request')).toBe(false);
  });
});

// ════════════════════ D49：回合归属（WebUI 发起的回合卡片委派回 WebUI） ════════════════════
//
// 用户报告（2026-09-16）：在 WebUI 里对话，QQ 侧也收到回复；审批/提问也可能被 QQ 抢走。
// 官方载荷**没有**回合/来源字段（`ApprovalRequestEvent`/`AskUserQuestionRequestEvent`），
// 只能由桥接侧以自记 `Message.id` 判定回合归属。用户拍板：WebUI 发起的回合委派回 WebUI。

describe('契约: 回合归属（D49）', () => {
  it('受控会话但 ownTurn=false（WebUI 发起的回合）→ 审批委派，不抢卡片', async () => {
    const h = makeHarness({ ownTurn: false });
    const next = vi.fn(async () => 'unavailable' as const);

    const out = await handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), next);

    expect(out).toBe('unavailable');
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.interactions.approval.hasPending(OPENID)).toBe(false);
  });

  it('受控会话但 ownTurn=false → 提问同样委派', async () => {
    const h = makeHarness({ ownTurn: false });
    const next = vi.fn(async () => ({ answers: [] }));

    const out = await handlerOf(h, 'user-questions/request')(questionReq(CONTROLLED_SESSION), next);

    expect(out).toEqual({ answers: [] });
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('受控会话且 ownTurn=true（QQ 投喂的回合）→ 仍抢卡片（与 D40 一致）', async () => {
    const h = makeHarness({ ownTurn: true });
    const pending = handlerOf(h, 'approval/request')(approvalReq(CONTROLLED_SESSION), vi.fn());

    await waitFor(() => h.interactions.approval.hasPending(OPENID));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    h.interactions.approval.handle(OPENID, 'y');
    await expect(pending).resolves.toBe('allowed-once');
  });
});