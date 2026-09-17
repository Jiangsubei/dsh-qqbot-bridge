/**
 * 契约测试：入站状态机（`src/inbound/pipeline.ts`）
 *
 * 覆盖决策（`docs/设计方案-命令系统与远程控制状态机.md` §4，优先级自上而下）：
 *   审批 → 提问 → 分页 → 命令 → 未选中检查 → agent
 *
 * 关键断言：
 *   1. 审批/提问 pending 优先于一切（含斜杠命令），被消费即 return；
 *   2. 非斜杠消息先退出分页；**未选中态自动新建会话（D36：作用域优先，否则默认工作区）**后转发，
 *      开关 `allow_create_session=false` 时退回 D19/D27 的「只提示不转发」；
 *   3. 分页活跃 + 无关命令 → **先退出分页再正常处理该命令（不吞掉）**（D22）；
 *   4. 未知命令 → 回执未知命令提示且**不转发给 agent**（C-R5）；
 *   5. 命令回执走 `reply`（纯文本通道），不经过流式/markdown（D34）；
 *   6. 出错绝不吞：logger.error + 明确错误回执（Y7）。
 *
 * 说明：`InboundDeps` 全部用手写 fake 实现（允许的单元隔离）；装配闭环由 Lead 用
 * `bootDshQqbotBridge` 验证，本文件不做（AGENTS.md §3.1）。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createInboundPipeline } from '../../src/inbound/pipeline.js';
import { createPagingStore } from '../../src/commands/paging.js';
import type {
  CommandDispatcher,
  CommandResult,
  ControlService,
  CreateSessionResult,
  InboundDeps,
  InboundPipeline,
  OutboundTarget,
  PagingState,
  QqC2CMessageEvent,
  WorkspaceRef,
} from '../../src/types/index.js';
import type { Logger } from '../../src/utils/logger.js';

const OPENID = 'user-1';
const TARGET: OutboundTarget = { openid: OPENID, msgId: 'msg-1' };
const KNOWN = ['会话', '切换', '新建', '停止', '状态', '压缩', '模型', '思考', '权限', '帮助', '下一页', '上一页'];

function makeEvent(overrides: Partial<QqC2CMessageEvent> = {}): QqC2CMessageEvent {
  return {
    id: 'msg-1',
    author: { user_openid: OPENID },
    content: '你好',
    ...overrides,
  };
}

interface Harness {
  deps: InboundDeps;
  pipeline: InboundPipeline;
  paging: ReturnType<typeof createPagingStore>;
  approvalHasPending: Mock;
  approvalHandle: Mock;
  questionHasPending: Mock;
  questionHandle: Mock;
  isKnown: Mock;
  commandHandle: Mock;
  getTarget: Mock;
  validateTarget: Mock;
  /** D36：未选中态自动新建会话 */
  createSession: Mock;
  getWorkspace: Mock;
  onSessionSelected: Mock;
  send: Mock;
  fetchAll: Mock;
  describeMedia: Mock;
  streamOpen: Mock;
  toQqMarkdown: Mock;
  reply: Mock;
  loggerError: Mock;
  loggerWarn: Mock;
  /** handle 被调用瞬间的分页快照（用于断言「先退出分页再处理命令」） */
  pagingAtHandle: () => PagingState | undefined;
}

function makeHarness(options: {
  target?: { workspaceId: string | null; sessionId: string | null };
  validate?: { valid: boolean; notice?: string };
  commandResult?: CommandResult;
  sendImpl?: () => Promise<{ ok: boolean; mode: 'steer' | 'followup' | 'none'; reason?: string }>;
  /** D36：自动新建的结果（缺省为成功）；失败用例传入 ok:false */
  autoCreate?: CreateSessionResult;
  /** D36：用户可读的工作区名（缺省 'default'） */
  workspaceTitle?: string;
  /** `allow_create_session` 开关（缺省 true） */
  allowCreateSession?: boolean;
} = {}): Harness {
  const paging = createPagingStore();
  let snapshot: PagingState | undefined;

  // D36：控制目标在自动新建后必须变为「已选中」，故这里是有状态的 fake
  const targetState: { workspaceId: string | null; sessionId: string | null } = {
    ...(options.target ?? { workspaceId: 'ws-1', sessionId: 'session-01' }),
  };

  const approvalHasPending = vi.fn((_openid: string) => false);
  const approvalHandle = vi.fn((_openid: string, _text: string) => false);
  const questionHasPending = vi.fn((_openid: string) => false);
  const questionHandle = vi.fn((_openid: string, _text: string) => false);

  const isKnown = vi.fn((name: string) => KNOWN.includes(name));
  const commandHandle = vi.fn(async (_cmd: unknown): Promise<CommandResult> => {
    snapshot = paging.get(OPENID);
    return options.commandResult ?? { handled: true, reply: '命令回执' };
  });

  const getTarget = vi.fn(async (_openid: string) => ({ ...targetState }));
  const createSession = vi.fn(
    async (_openid: string, _pathArg?: string): Promise<CreateSessionResult> => {
      const result =
        options.autoCreate ??
        ({
          ok: true,
          sessionId: 'session-auto1',
          workspaceId: 'ws-default',
          createdWorkspace: true,
          createdDir: true,
        } as CreateSessionResult);
      if (result.ok) {
        targetState.workspaceId = result.workspaceId;
        targetState.sessionId = result.sessionId;
      }
      return result;
    },
  );
  const getWorkspace = vi.fn(
    async (workspaceId: string): Promise<WorkspaceRef> => ({
      id: workspaceId,
      title: options.workspaceTitle ?? 'default',
      path: `/home/u/.dsh/workspace/${options.workspaceTitle ?? 'default'}`,
      sessionIds: [],
    }),
  );
  const validateTarget = vi.fn(async (_openid: string) => options.validate ?? { valid: true });
  const onSessionSelected = vi.fn((_sessionId: string, _openid: string) => {});
  const send = vi.fn(options.sendImpl ?? (async () => ({ ok: true, mode: 'followup' as const })));

  const fetchAll = vi.fn(async () => []);
  const describeMedia = vi.fn(() => '');

  const reply = vi.fn(async (_target: OutboundTarget, _text: string) => {});
  const loggerError = vi.fn();
  const loggerWarn = vi.fn();

  const commands: CommandDispatcher = { names: () => KNOWN, isKnown, handle: commandHandle };
  const control = {
    getTarget,
    validateTarget,
    send,
    createSession,
    getWorkspace,
  } as unknown as ControlService;

  const deps: InboundDeps = {
    approval: { hasPending: approvalHasPending, handle: approvalHandle },
    question: { hasPending: questionHasPending, handle: questionHandle },
    paging,
    commands,
    control,
    allowCreateSession: options.allowCreateSession ?? true,
    onSessionSelected,
    streams: {
      open: vi.fn(() => null),
      isStreaming: vi.fn(() => false),
      sendSerialized: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      activeSeq: vi.fn(() => undefined),
    },
    media: { fetchAll, describe: describeMedia },
    markdown: {
      toQqMarkdown: vi.fn((text: string) => text),
      split: vi.fn((text: string) => [text]),
    },
    reply,
    logger: {
      info: vi.fn(),
      warn: loggerWarn,
      error: loggerError,
      debug: vi.fn(),
    } as Logger,
  };

  return {
    deps,
    pipeline: createInboundPipeline(deps),
    paging,
    approvalHasPending,
    approvalHandle,
    questionHasPending,
    questionHandle,
    isKnown,
    commandHandle,
    getTarget,
    validateTarget,
    createSession,
    getWorkspace,
    onSessionSelected,
    send,
    fetchAll,
    describeMedia,
    streamOpen: deps.streams.open as unknown as Mock,
    toQqMarkdown: deps.markdown.toQqMarkdown as unknown as Mock,
    reply,
    loggerError,
    loggerWarn,
    pagingAtHandle: () => snapshot,
  };
}

describe('契约: 状态机优先级 —— 审批/提问（§4 第 1/2 层）', () => {
  it('审批 pending 且被消费 → 立即 return，提问/分页/命令/agent 全部不参与（即使消息是斜杠命令）', async () => {
    const h = makeHarness();
    h.approvalHasPending.mockReturnValue(true);
    h.approvalHandle.mockReturnValue(true);

    await h.pipeline.handle(makeEvent({ content: '/帮助' }));

    expect(h.approvalHandle).toHaveBeenCalledWith(OPENID, '/帮助');
    expect(h.questionHasPending).not.toHaveBeenCalled();
    expect(h.commandHandle).not.toHaveBeenCalled();
    expect(h.getTarget).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('审批 pending 但未消费 → 继续走提问层', async () => {
    const h = makeHarness();
    h.approvalHasPending.mockReturnValue(true);
    h.approvalHandle.mockReturnValue(false);
    h.questionHasPending.mockReturnValue(true);
    h.questionHandle.mockReturnValue(true);

    await h.pipeline.handle(makeEvent());

    expect(h.questionHasPending).toHaveBeenCalledWith(OPENID);
    expect(h.questionHandle).toHaveBeenCalledWith(OPENID, '你好');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('提问 pending 且被消费 → 不转发给 agent', async () => {
    const h = makeHarness();
    h.questionHasPending.mockReturnValue(true);
    h.questionHandle.mockReturnValue(true);

    await h.pipeline.handle(makeEvent());

    expect(h.commandHandle).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('契约: 非斜杠消息（§4 第 3 步 / D19/D27 → D36）', () => {
  it('开关关闭（allow_create_session=false）：未选中态 → 回执「请先 /会话 选会话」且不转发、不新建', async () => {
    const h = makeHarness({
      target: { workspaceId: 'ws-1', sessionId: null },
      allowCreateSession: false,
    });
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 2 });

    await h.pipeline.handle(makeEvent({ content: '继续刚才那个' }));

    expect(h.paging.get(OPENID)).toBeUndefined();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(text).toContain('请先 /会话 选会话');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.validateTarget).not.toHaveBeenCalled();
  });

  it('目标已失效（D29）→ 回执告知且不转发', async () => {
    const h = makeHarness({
      validate: { valid: false, notice: '原目标已被归档或不存在，请重新 /会话 选' },
    });

    await h.pipeline.handle(makeEvent());

    expect(h.validateTarget).toHaveBeenCalledWith(OPENID);
    const [, text] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(text).toContain('原目标已被归档或不存在');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('已选中目标 → 交 control.send（busy/idle 的 steer/followup 由 control 判定，D7）', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 1 });

    await h.pipeline.handle(makeEvent({ content: '帮我看看这个报错' }));

    expect(h.paging.get(OPENID)).toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toBe(OPENID);
    expect(h.send.mock.calls[0]?.[1]).toBe('帮我看看这个报错');
  });

  it('带附件 → 先落盘并注入附件说明，且不丢正文', async () => {
    const h = makeHarness();
    h.fetchAll.mockResolvedValue([
      { filePath: '/tmp/a.png', fileName: 'a.png', bytes: 3, mimeType: 'image/png' },
    ]);
    h.describeMedia.mockReturnValue('【附件】a.png');

    const event = makeEvent({ content: '看这张图', attachments: [{ url: 'https://x/a.png' }] });
    await h.pipeline.handle(event);

    expect(h.fetchAll).toHaveBeenCalledWith(event, 'session-01');
    const [, text] = h.send.mock.calls[0] as [string, string];
    expect(text).toContain('看这张图');
    expect(text).toContain('【附件】a.png');
  });
});

describe('契约: 未选中态自动新建会话（D36：首次直发引导）', () => {
  it('未选中 + 允许新建 → 调 createSession（无路径参数）→ 回执只报工作区名（不含 session id）→ 正文转发新会话', async () => {
    const h = makeHarness({ target: { workspaceId: null, sessionId: null } });

    await h.pipeline.handle(makeEvent({ content: '帮我写个脚本' }));

    // 落点由控制层决定：有作用域用作用域，没有则默认工作区
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.createSession.mock.calls[0]?.[0]).toBe(OPENID);
    expect(h.createSession.mock.calls[0]?.[1]).toBeUndefined();

    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, notice] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(notice).toContain('未选中会话');
    expect(notice).toContain('default');
    expect(notice).not.toContain('session-auto1');

    // 同一条消息继续作为新会话的首个 prompt
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toBe(OPENID);
    expect(h.send.mock.calls[0]?.[1]).toBe('帮我写个脚本');
    expect(h.validateTarget).toHaveBeenCalledWith(OPENID);

    // 真机接缝：必须先登记 sessionId → openid，否则本条消息的回答会被 turn-router 丢弃
    expect(h.onSessionSelected).toHaveBeenCalledWith('session-auto1', OPENID);
    expect(h.onSessionSelected.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]!);
  });

  it('未选中 + 带附件 → 附件落到**新建会话**的 sessionId 上（不是空的旧目标）', async () => {
    const h = makeHarness({ target: { workspaceId: null, sessionId: null } });
    h.fetchAll.mockResolvedValue([
      { filePath: '/tmp/a.png', fileName: 'a.png', bytes: 3, mimeType: 'image/png' },
    ]);
    h.describeMedia.mockReturnValue('【附件】a.png');

    const event = makeEvent({ content: '看这张图', attachments: [{ url: 'https://x/a.png' }] });
    await h.pipeline.handle(event);

    expect(h.fetchAll).toHaveBeenCalledWith(event, 'session-auto1');
    const [, text] = h.send.mock.calls[0] as [string, string];
    expect(text).toContain('看这张图');
    expect(text).toContain('【附件】a.png');
  });

  it('自动新建失败 → 如实回执失败原因，不转发、不假装成功', async () => {
    const h = makeHarness({
      target: { workspaceId: null, sessionId: null },
      autoCreate: {
        ok: false,
        code: 'mkdir-failed',
        reason: 'EACCES: permission denied',
      },
    });

    await h.pipeline.handle(makeEvent({ content: '你好' }));

    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(text).toContain('EACCES');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('斜杠命令在未选中态**不触发**自动新建（命令层优先）', async () => {
    const h = makeHarness({ target: { workspaceId: null, sessionId: null } });

    await h.pipeline.handle(makeEvent({ content: '/帮助' }));

    expect(h.commandHandle).toHaveBeenCalledTimes(1);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('已选中目标时不会触发自动新建（只在未选中态生效）', async () => {
    const h = makeHarness();

    await h.pipeline.handle(makeEvent({ content: '你好' }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.onSessionSelected).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('契约: 斜杠命令与分页优先级（§4 第 4 层 / D22）', () => {
  it('分页活跃 + /下一页 → 交给命令层翻页，且不退出分页', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 1 });

    await h.pipeline.handle(makeEvent({ content: '/下一页' }));

    expect(h.commandHandle).toHaveBeenCalledTimes(1);
    expect(h.pagingAtHandle()).toEqual({ listKind: 'sessions', workspaceId: 'ws-1', page: 1 });
    expect(h.paging.get(OPENID)).toBeDefined();
  });

  it('分页活跃 + 无关命令 → 先退出分页，再正常处理该命令（不得吞掉）', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 2 });

    await h.pipeline.handle(makeEvent({ content: '/状态' }));

    expect(h.commandHandle).toHaveBeenCalledTimes(1);
    // 关键时序断言：命令层被调用时，分页状态已经被清掉
    expect(h.pagingAtHandle()).toBeUndefined();
    expect(h.paging.get(OPENID)).toBeUndefined();
    expect(h.reply).toHaveBeenCalledWith(TARGET, '命令回执');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('命令层的 exitPaging 会被如实执行', async () => {
    const h = makeHarness({ commandResult: { handled: true, reply: 'ok', exitPaging: true } });
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 1 });

    await h.pipeline.handle(makeEvent({ content: '/下一页' }));

    expect(h.paging.get(OPENID)).toBeUndefined();
  });

  it('未知命令 → 回执未知命令提示且不转发给 agent（C-R5）', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 1 });

    await h.pipeline.handle(makeEvent({ content: '/工作区' }));

    expect(h.commandHandle).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.paging.get(OPENID)).toBeUndefined();
    const [, text] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(text).toContain('工作区');
    expect(text).toContain('未发送');
  });

  it('命令回执走纯文本通道（不经过流式 / markdown，D34）', async () => {
    const h = makeHarness();
    await h.pipeline.handle(makeEvent({ content: '/帮助' }));

    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.streamOpen).not.toHaveBeenCalled();
    expect(h.toQqMarkdown).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('命令层返回 handled=false → 按契约继续走后续状态机层（转发 agent）', async () => {
    const h = makeHarness({ commandResult: { handled: false } });
    await h.pipeline.handle(makeEvent({ content: '/帮助' }));
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('契约: 错误绝不吞（Y7 / AGENTS §3.3）', () => {
  it('control.send 抛错 → logger.error + 明确错误回执，不静默', async () => {
    const h = makeHarness({
      sendImpl: async () => {
        throw new Error('SessionAlreadyOwnedError: is already owned');
      },
    });

    await h.pipeline.handle(makeEvent());

    expect(h.loggerError).toHaveBeenCalled();
    expect(h.reply).toHaveBeenCalledTimes(1);
    const [, text] = h.reply.mock.calls[0] as [OutboundTarget, string];
    expect(text).toContain('SessionAlreadyOwnedError');
  });

  it('缺少 openid 的事件被忽略并记 warn', async () => {
    const h = makeHarness();
    await h.pipeline.handle(makeEvent({ author: {} }));
    expect(h.loggerWarn).toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('附件下载失败不丢正文（记录错误后继续转发文本）', async () => {
    const h = makeHarness();
    h.fetchAll.mockRejectedValue(new Error('download 403'));
    const event = makeEvent({ content: '带附件的消息', attachments: [{ url: 'https://x/a.png' }] });

    await h.pipeline.handle(event);

    expect(h.loggerError).toHaveBeenCalled();
    const [, text] = h.send.mock.calls[0] as [string, string];
    expect(text).toContain('带附件的消息');
  });
});

// ────────── 命令层的「追加回执」followUp（长耗时命令如 /压缩，D44） ───────────
//
// 用户拍板：/压缩 先回「正在压缩…」，完成后追加一条结果回执（同一 anchor 的两次被动回复）。
// 契约为通用能力：管线按序发送主回执、再发送 followUp；followUp 失败必须如实回执且记 error。

describe('契约: 命令追加回执 followUp（D44）', () => {
  it('先发主回执、再发追加回执（顺序保证）', async () => {
    const h = makeHarness({
      commandResult: {
        handled: true,
        reply: '正在压缩当前会话历史…',
        followUp: async () => '已压缩 3 条历史（约 1.5K tokens）。',
      },
    });

    await h.pipeline.handle(makeEvent({ content: '/压缩' }));

    const texts = h.reply.mock.calls.map((c) => String(c[1]));
    expect(texts).toEqual(['正在压缩当前会话历史…', '已压缩 3 条历史（约 1.5K tokens）。']);
  });

  it('followUp 抛错 → 如实回执且记 error，绝不静默（Y7）', async () => {
    const h = makeHarness({
      commandResult: {
        handled: true,
        reply: '正在压缩当前会话历史…',
        followUp: async () => {
          throw new Error('compact boom');
        },
      },
    });

    await h.pipeline.handle(makeEvent({ content: '/压缩' }));

    const texts = h.reply.mock.calls.map((c) => String(c[1]));
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('compact boom');
    expect(h.loggerError).toHaveBeenCalled();
  });

  it('followUp 返回 undefined → 不发第二条（空回执不打扰）', async () => {
    const h = makeHarness({
      commandResult: { handled: true, reply: '只有一条', followUp: async () => undefined },
    });

    await h.pipeline.handle(makeEvent({ content: '/压缩' }));

    expect(h.reply).toHaveBeenCalledTimes(1);
  });
});