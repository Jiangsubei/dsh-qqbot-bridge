/**
 * 契约测试：命令系统（`src/commands/parse.ts` + `src/commands/dispatch.ts`）
 *
 * 覆盖决策（`docs/设计方案-命令系统与远程控制状态机.md`）：
 *   - §3 命令总表（自研解析、不接 `ctx.commands`、**不设 `/工作区`**）；
 *   - §5 分页（10 条/页、跨页连续编号、listKind）；
 *   - §6 寻址（序号 → 标题模糊 → 标题全文；**多命中必须列候选，严禁静默取第一个**）；
 *   - §7.1 `/新建` 六种场景；
 *   - D27 未选中态只提示不报错；D32 `/状态` 全字段；D33 列表项；D34 纯文本 + 截断。
 *
 * 说明：`ControlService` 与官方服务门面用手写 fake 隔离（允许的单元隔离）；
 * 装配闭环由 Lead 用 `bootDshQqbotBridge` 验证，本文件不做。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  parseCommand,
  isSlashCommand,
  isPagingCommand,
  formatUnknownCommandReply,
} from '../../src/commands/parse.js';
import {
  createCommandDispatcher,
  type OfficialModelService,
  type OfficialPermissionService,
} from '../../src/commands/dispatch.js';
import { createPagingStore } from '../../src/commands/paging.js';
import type {
  CommandContext,
  CommandDispatcher,
  CompactOutcome,
  ControlService,
  ControlTarget,
  CreateSessionResult,
  OutboundTarget,
  SessionRef,
  SessionStatus,
  TakeoverResult,
  WorkspaceRef,
} from '../../src/types/index.js';
import type { Logger } from '../../src/utils/logger.js';

const OUTBOUND: OutboundTarget = { openid: 'user-1', msgId: 'msg-1' };
const OPENID = 'user-1';

// ─────────────────────────── 夹具 ───────────────────────────

function makeSessions(count: number, workspaceId = 'ws-1'): SessionRef[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      sessionId: `session-${n}${'0'.repeat(2)}`,
      title: `项目${n}`,
      workspaceId,
      workspaceTitle: '主工作区',
      // D46：`lastActive` 语义 = 官方 `SessionSummary.updatedAt`
      //（`Math.max(header.createdAt, sessionListMetadata.lastPromptAt ?? 0)`，`dsh-api-session-controller/lib/index.js:1969-1971`）。
      // 夹具用「越靠前越新」的降序**相对**时间：① 不依赖挂钟日期、不会随时间腐烂；
      // ② 使「最新在前」的排序结果与注册表归属顺序一致，既有跨页/寻址用例可原样复用；
      // ③ 排序本身由乱序用例（describe: D46）单独证明。
      lastActive: Date.now() - i * 60_000,
      blank: false,
      archived: false,
    };
  });
}

function makeWorkspaces(count: number): WorkspaceRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ws-${i + 1}`,
    title: i === 0 ? '主工作区' : `工作区${String(i + 1).padStart(2, '0')}`,
    path: `/workspace/proj-${String(i + 1).padStart(2, '0')}`,
    sessionIds: [`session-0001`, `session-0002`],
  }));
}

interface ControlHarness {
  control: ControlService;
  listSessions: Mock;
  listWorkspaces: Mock;
  resolveWorkspace: Mock;
  getWorkspace: Mock;
  getTarget: Mock;
  findControlOwner: Mock;
  compact: Mock;
  listArchivedSessionIds: Mock;
  setWorkspace: Mock;
  setTarget: Mock;
  clearTarget: Mock;
  createSession: Mock;
  send: Mock;
  cancel: Mock;
  status: Mock;
  validateTarget: Mock;
}

function makeControl(overrides: Partial<ControlService> = {}): ControlHarness {
  const sessions = makeSessions(15);
  const workspaces = makeWorkspaces(12);

  const listSessions = vi.fn(async (_workspaceId: string): Promise<SessionRef[]> => sessions);
  const listWorkspaces = vi.fn(async (): Promise<WorkspaceRef[]> => workspaces);
  const resolveWorkspace = vi.fn(async (_arg: string): Promise<WorkspaceRef | undefined> => undefined);
  const getWorkspace = vi.fn(async (_id: string): Promise<WorkspaceRef | undefined> => undefined);
  const getTarget = vi.fn(
    async (_openid: string): Promise<ControlTarget> => ({ workspaceId: 'ws-1', sessionId: 'session-01' }),
  );
  /** 受控会话反查（交互层判定用）；缺省无受控关系 */
  const findControlOwner = vi.fn((_sessionId: string): string | undefined => undefined);
  /** `/压缩`（D44）；缺省成功压缩 3 条 / 约 1500 tokens */
  const compact = vi.fn(
    async (_openid: string): Promise<CompactOutcome> => ({
      ok: true,
      compacted: true,
      shadowedItems: 3,
      shadowedTokens: 1500,
    }),
  );
  /** 注册表全局归档集合（D45）；缺省无归档 */
  const listArchivedSessionIds = vi.fn(async (): Promise<string[]> => []);
  const setWorkspace = vi.fn(async (_openid: string, _workspaceId: string): Promise<void> => {});
  const setTarget = vi.fn(
    async (_openid: string, sessionId: string): Promise<TakeoverResult> => ({ ok: true, sessionId }),
  );
  const clearTarget = vi.fn(async (_openid: string, _reason: string): Promise<void> => {});
  const createSession = vi.fn(
    async (_openid: string, _pathArg?: string): Promise<CreateSessionResult> => ({
      ok: true,
      sessionId: 'session-new0001',
      workspaceId: 'ws-1',
      createdWorkspace: false,
      createdDir: false,
    }),
  );
  const send = vi.fn(async (_openid: string, _text: string) => ({ ok: true, mode: 'followup' as const }));
  const cancel = vi.fn(async (_openid: string) => ({ ok: true }));
  const status = vi.fn(async (_openid: string): Promise<SessionStatus | undefined> => ({
    sessionId: 'session-abcdef123456',
    title: '修 bug',
    workspaceTitle: '主工作区',
    workspacePath: '/workspace/proj-a',
    model: 'deepseek-official / deepseek-v4-flash',
    reasoningEffort: 'high',
    permissionPreset: 'workspace-write',
    busy: true,
    contextTokens: 12345,
    contextWindow: 131072,
  }));
  const validateTarget = vi.fn(async (_openid: string) => ({ valid: true }));

  const control: ControlService = {
    listWorkspaces,
    listSessions,
    getWorkspace,
    resolveWorkspace,
    getTarget,
    findControlOwner,
    compact,
    listArchivedSessionIds,
    setWorkspace,
    setTarget,
    clearTarget,
    createSession,
    send,
    cancel,
    status,
    validateTarget,
    ...overrides,
  };

  return {
    control,
    listSessions,
    listWorkspaces,
    resolveWorkspace,
    getWorkspace,
    getTarget,
    findControlOwner,
    compact,
    listArchivedSessionIds,
    setWorkspace,
    setTarget,
    clearTarget,
    createSession,
    send,
    cancel,
    status,
    validateTarget,
  };
}

interface ModelHarness {
  models: OfficialModelService;
  list: Mock;
  select: Mock;
  reasoning: Mock;
  permissions: OfficialPermissionService;
  permList: Mock;
  permSet: Mock;
}

function makeOfficial(): ModelHarness {
  const list = vi.fn(async () => [
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'V4 Flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'V4 Pro' },
    { provider: 'opencode-go', model: 'deepseek-flash' },
  ]);
  const select = vi.fn(async () => {});
  const reasoning = vi.fn(async () => ({
    supported: true,
    efforts: [
      { id: 'off', name: '关闭' },
      { id: 'low', name: '低' },
      { id: 'high', name: '高' },
      { id: 'max', name: '最大' },
    ],
    defaultEffort: 'high',
  }));
  const permList = vi.fn(async () => ['readonly', 'workspace-write', 'danger-full-access']);
  const permSet = vi.fn(async () => {});
  return {
    models: { list, select, reasoning },
    list,
    select,
    reasoning,
    permissions: { list: permList, set: permSet },
    permList,
    permSet,
  };
}

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

interface Harness {
  dispatcher: CommandDispatcher;
  paging: ReturnType<typeof createPagingStore>;
  ctl: ControlHarness;
  official: ModelHarness;
}

function makeHarness(options: {
  control?: Partial<ControlService>;
  replyMaxChars?: number;
  statusShowUsage?: boolean;
  withOfficial?: boolean;
  /** D36：`allow_create_session` 开关（缺省 true） */
  allowCreateSession?: boolean;
} = {}): Harness {
  const ctl = makeControl(options.control ?? {});
  const official = makeOfficial();
  const paging = createPagingStore();
  const dispatcher = createCommandDispatcher({
    control: ctl.control,
    paging,
    logger,
    ...(options.withOfficial === false ? {} : { models: official.models, permissions: official.permissions }),
    ...(options.replyMaxChars === undefined ? {} : { replyMaxChars: options.replyMaxChars }),
    ...(options.statusShowUsage === undefined ? {} : { statusShowUsage: options.statusShowUsage }),
    ...(options.allowCreateSession === undefined ? {} : { allowCreateSession: options.allowCreateSession }),
  });
  return { dispatcher, paging, ctl, official };
}

function cmd(raw: string, overrides: Partial<CommandContext> = {}): CommandContext {
  const parsed = parseCommand(raw);
  if (!parsed) throw new Error(`测试夹具错误：不是斜杠命令 -> ${raw}`);
  return { openid: OPENID, raw, name: parsed.name, args: parsed.args, target: OUTBOUND, ...overrides };
}

// ─────────────────────────── 解析（§3 / D11） ───────────────────────────

describe('契约: 自研命令解析（不接 ctx.commands）', () => {
  it('两字中文命令 + 参数解析', () => {
    expect(parseCommand('/会话 13')).toEqual({ name: '会话', args: '13' });
    expect(parseCommand('/模型 deepseek v4')).toEqual({ name: '模型', args: 'deepseek v4' });
    expect(parseCommand('/帮助')).toEqual({ name: '帮助', args: '' });
  });

  it('兼容全角斜杠 ／（复用 napcat 解析风格）', () => {
    expect(isSlashCommand('／帮助')).toBe(true);
    expect(parseCommand('／帮助')?.name).toBe('帮助');
  });

  it('非斜杠消息不解析为命令', () => {
    expect(isSlashCommand('你好')).toBe(false);
    expect(parseCommand('你好')).toBeUndefined();
  });

  it('分页命令是列表专属子命令（isPagingCommand）', () => {
    expect(isPagingCommand('下一页')).toBe(true);
    expect(isPagingCommand('上一页')).toBe(true);
    expect(isPagingCommand('会话')).toBe(false);
  });

  it('未知命令回执必须明确「未发送给会话」（C-R5）', () => {
    const text = formatUnknownCommandReply('工作区');
    expect(text).toContain('工作区');
    expect(text).toContain('未发送');
  });
});

// ────────────────────────── 命令集（§3） ───────────────────────────

describe('契约: 命令清单与帮助（§3 / D18）', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('names() 覆盖 10 个主命令 + 2 个分页子命令', () => {
    const names = h.dispatcher.names();
    for (const n of ['会话', '切换', '新建', '停止', '状态', '压缩', '模型', '思考', '权限', '帮助', '下一页', '上一页']) {
      expect(names).toContain(n);
    }
  });

  it('不设 /工作区；未知命令不被认作已知（D18）', () => {
    expect(h.dispatcher.isKnown('工作区')).toBe(false);
    expect(h.dispatcher.isKnown('yolo')).toBe(false);
    expect(h.dispatcher.isKnown('会话')).toBe(true);
    expect(h.dispatcher.isKnown('下一页')).toBe(true);
  });

  it('/帮助 渲染命令清单与用法，且为纯文本（D34）', async () => {
    const r = await h.dispatcher.handle(cmd('/帮助'));
    expect(r.handled).toBe(true);
    expect(r.reply).toBeTruthy();
    const reply = r.reply ?? '';
    for (const n of ['会话', '切换', '新建', '停止', '状态', '压缩', '模型', '思考', '权限']) {
      expect(reply).toContain(`/${n}`);
    }
    expect(reply).not.toContain('**');
    expect(reply).not.toContain('```');
  });

  // 用户决策（本次修复）：/下一页 /上一页 是列表命令的专属子命令，帮助页不列翻页命令；
  // 翻页提示只在列表实际超过 1 页时随列表 footer 出现。
  it('/帮助 不出现翻页子命令与翻页提示', async () => {
    const r = await h.dispatcher.handle(cmd('/帮助'));
    const reply = r.reply ?? '';
    expect(reply).not.toContain('下一页');
    expect(reply).not.toContain('上一页');
    expect(reply).not.toContain('翻页');
  });

  it('回执按 reply_max_chars 截断（D34）', async () => {
    const h2 = makeHarness({ replyMaxChars: 60 });
    const r = await h2.dispatcher.handle(cmd('/帮助'));
    expect(r.reply?.length).toBeLessThanOrEqual(60);
  });
});

// ─────────────────────────── 未选中态（D27） ──────────────────────────

describe('契约: 未选中态只提示不报错（D27）', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ control: { getTarget: vi.fn(async () => ({ workspaceId: 'ws-1', sessionId: null })) } });
  });

  it('四个目标相关命令都只提示「请先 /会话 选会话」，不调用任何动作', async () => {
    for (const name of ['模型', '思考', '权限', '停止']) {
      const r = await h.dispatcher.handle(cmd(`/${name}`));
      expect(r.handled).toBe(true);
      expect(r.reply).toContain('请先 /会话 选会话');
    }
    expect(h.official.select).not.toHaveBeenCalled();
    expect(h.official.permSet).not.toHaveBeenCalled();
    expect(h.ctl.cancel).not.toHaveBeenCalled();
  });

  it('未选中态下 /会话 /切换 /新建 /状态 /帮助 仍可用', async () => {
    for (const raw of ['/会话', '/切换', '/新建', '/状态', '/帮助']) {
      const r = await h.dispatcher.handle(cmd(raw));
      expect(r.handled).toBe(true);
      expect(r.reply).toBeTruthy();
    }
  });

  it('未选中态 /状态 回显未选中，而不是报错（D27/D32）', async () => {
    h.ctl.status.mockResolvedValueOnce(undefined);
    const r = await h.dispatcher.handle(cmd('/状态'));
    expect(r.reply).toContain('未选中');
  });

  // 用户决策（本次修复）：/状态 未选中分支的「工作区作用域」同样不得只印裸 id
  it('未选中态 /状态 的工作区作用域显示「标题 (路径)」而非裸 id', async () => {
    const h2 = makeHarness({
      control: {
        getTarget: vi.fn(async (): Promise<ControlTarget> => ({ workspaceId: 'ws-1', sessionId: null })),
        status: vi.fn(async (): Promise<SessionStatus | undefined> => undefined),
        getWorkspace: vi.fn(async (): Promise<WorkspaceRef | undefined> => ({
          id: 'ws-1',
          title: '主工作区',
          path: '/workspace/proj-a',
          sessionIds: [],
        })),
      },
    });
    const r = await h2.dispatcher.handle(cmd('/状态'));
    const reply = r.reply ?? '';
    expect(reply).toContain('未选中');
    expect(reply).toContain('工作区作用域：主工作区 (/workspace/proj-a)');
    expect(reply).not.toContain('工作区作用域：ws-1');
  });
});

// ─────────────────────────── /会话（D21/D23/D33） ──────────────────────────

describe('契约: /会话 列表与三级寻址（D21/D23/D33）', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('列表项 = 序号 + 标题 + 相对时间；不显示「最后活跃」标签与「当前目标」标记（D33/D46）', async () => {
    const r = await h.dispatcher.handle(cmd('/会话'));
    const reply = r.reply ?? '';
    expect(reply).toContain('项目01');
    expect(reply).toContain('项目10');
    expect(reply).not.toContain('项目11'); // 第 1 页只有 10 条
    expect(reply).not.toContain('[当前');
    expect(reply).not.toContain('当前目标');
    // D46：对齐 WebUI 的相对时间（`刚刚`/`N分钟`/…），不再有「最后活跃」标签、不印「未知」
    expect(reply).not.toContain('最后活跃');
    expect(reply).not.toContain('未知');
    expect(reply).toMatch(/(^|\n)1\. 项目01 刚刚\n/);
    expect(reply).toMatch(/(^|\n)2\. 项目02 1分钟\n/);
    // 分页状态记住 listKind（§5）
    expect(h.paging.get(OPENID)).toEqual({ listKind: 'sessions', workspaceId: 'ws-1', page: 1 });
  });

  it('翻到第 2 页后仍以跨页连续编号定位（/会话 13 → 第 13 条，D22 验收要点 2）', async () => {
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 2 });

    // 先确认第 2 页显示的编号是 11..15，而不是 1..5
    const list = await h.dispatcher.handle(cmd('/会话'));
    expect(list.reply).toMatch(/(^|\n)11\. 项目11/);
    expect(list.reply).toContain('项目15');
    expect(h.paging.get(OPENID)?.page).toBe(2);

    // 第 2 页之后 /会话 13 仍然命中的是整份列表第 13 条
    const r = await h.dispatcher.handle(cmd('/会话 13'));
    expect(r.handled).toBe(true);
    expect(h.ctl.setTarget).toHaveBeenCalledTimes(1);
    expect(h.ctl.setTarget.mock.calls[0]?.[1]).toBe('session-1300');
  });

  it('序号越界如实回执，不静默选中别的会话', async () => {
    const r = await h.dispatcher.handle(cmd('/会话 999'));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('序号');
    expect(h.ctl.setTarget).not.toHaveBeenCalled();
  });

  it('标题唯一模糊命中 → 选中该会话', async () => {
    const r = await h.dispatcher.handle(cmd('/会话 项目07'));
    expect(r.reply).toBeTruthy();
    expect(h.ctl.setTarget).toHaveBeenCalledTimes(1);
    expect(h.ctl.setTarget.mock.calls[0]?.[1]).toBe('session-0700');
  });

  it('多命中必须列候选且不得静默取第一个（D23 验收要点 3）', async () => {
    const r = await h.dispatcher.handle(cmd('/会话 项目'));
    const reply = r.reply ?? '';
    expect(reply).toContain('多个');
    expect(reply).toContain('候选');
    expect(h.ctl.setTarget).not.toHaveBeenCalled();
  });

  it('标题全文精确匹配优先于模糊包含（§6 第 3 级）', async () => {
    const sessions: SessionRef[] = [
      { sessionId: 'session-aaa1', title: 'alpha', workspaceId: 'ws-1', workspaceTitle: '主工作区', archived: false },
      {
        sessionId: 'session-bbb2',
        title: 'alpha 项目',
        workspaceId: 'ws-1',
        workspaceTitle: '主工作区',
        archived: false,
      },
    ];
    const ctl = makeControl({ listSessions: vi.fn(async () => sessions) });
    const paging = createPagingStore();
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging, logger });
    const r = await dispatcher.handle(cmd('/会话 alpha'));
    expect(r.handled).toBe(true);
    expect(ctl.setTarget.mock.calls[0]?.[1]).toBe('session-aaa1');
  });

  it('接管失败（锁冲突等）如实回执，不假装成功（D30）', async () => {
    const ctl = makeControl({
      setTarget: vi.fn(async () => ({
        ok: false as const,
        code: 'locked' as const,
        reason: 'session is already owned by an active write handle',
      })),
    });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });
    const r = await dispatcher.handle(cmd('/会话 项目07'));
    expect(r.reply).toContain('is already owned by an active write handle');
  });
});

// ─────────────────────────── /切换（D19/D20） ───────────────────────────

describe('契约: /切换 工作区（D19/D20）', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('无参列出所有工作区（序号 + 标题 + 路径 + 会话数），10 条/页', async () => {
    const r = await h.dispatcher.handle(cmd('/切换'));
    const reply = r.reply ?? '';
    expect(reply).toContain('主工作区');
    expect(reply).toContain('/workspace/proj-01');
    expect(reply).toContain('工作区10');
    expect(reply).not.toContain('工作区11');
    expect(h.paging.get(OPENID)).toEqual({ listKind: 'workspaces', workspaceId: 'ws-1', page: 1 });
  });

  it('序号切换 → setWorkspace（由 control 清空控制目标，D19）', async () => {
    const r = await h.dispatcher.handle(cmd('/切换 2'));
    expect(r.reply).toBeTruthy();
    expect(h.ctl.setWorkspace).toHaveBeenCalledTimes(1);
    expect(h.ctl.setWorkspace.mock.calls[0]?.[1]).toBe('ws-2');
  });

  it('路径精确匹配切换', async () => {
    const r = await h.dispatcher.handle(cmd('/切换 /workspace/proj-03'));
    expect(r.reply).toBeTruthy();
    expect(h.ctl.setWorkspace.mock.calls[0]?.[1]).toBe('ws-3');
  });

  it('工作区未找到如实回执；标题多命中列候选', async () => {
    const miss = await h.dispatcher.handle(cmd('/切换 不存在的路径'));
    expect(miss.reply).toContain('未找到');
    expect(h.ctl.setWorkspace).not.toHaveBeenCalled();

    const multi = await h.dispatcher.handle(cmd('/切换 工作区'));
    expect(multi.reply).toContain('多个');
    expect(h.ctl.setWorkspace).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── /新建（§7.1 / D24/D25） ───────────────────────────

describe('契约: /新建 六种场景（§7.1）', () => {
  it('无参 → 交给 control.createSession（当前工作区作用域）', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.handle(cmd('/新建'));
    expect(r.handled).toBe(true);
    expect(h.ctl.createSession).toHaveBeenCalledTimes(1);
    expect(h.ctl.createSession.mock.calls[0]?.[0]).toBe(OPENID);
    expect(h.ctl.createSession.mock.calls[0]?.[1]).toBeUndefined();
    expect(r.reply).toBeTruthy();
  });

  it('带路径 → 原样传给 control（相对路径基准 $HOME / 自动注册 / mkdir -p 由 control 负责）', async () => {
    const h = makeHarness();
    await h.dispatcher.handle(cmd('/新建 ~/proj-new'));
    expect(h.ctl.createSession.mock.calls[0]?.[1]).toBe('~/proj-new');
  });

  it('路径是文件 → 如实报错，不假装新建成功', async () => {
    const h = makeHarness({
      control: {
        createSession: vi.fn(async (): Promise<CreateSessionResult> => ({
          ok: false,
          code: 'exists-as-file',
          reason: '/workspace/proj-a/README.md 是一个文件',
        })),
      },
    });
    const r = await h.dispatcher.handle(cmd('/新建 /workspace/proj-a/README.md'));
    expect(r.reply).toContain('文件');
    expect(r.reply).toContain('README.md');
  });

  it('allow_create_session=false → /新建 被拒且不调 control.createSession（D36：开关真的生效）', async () => {
    const h = makeHarness({ allowCreateSession: false });
    const r = await h.dispatcher.handle(cmd('/新建'));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('已禁用');
    expect(h.ctl.createSession).not.toHaveBeenCalled();
  });

  // 用户决策（本次修复）：/新建 回执必须显示「工作区标题 (路径)」，不能只印裸工作区 id
  it('/新建 成功回执显示工作区「标题 (路径)」而非裸 id', async () => {
    const h = makeHarness({
      control: {
        getWorkspace: vi.fn(async (id: string): Promise<WorkspaceRef | undefined> =>
          id === 'ws-1'
            ? { id: 'ws-1', title: '主工作区', path: '/workspace/proj-a', sessionIds: [] }
            : undefined,
        ),
      },
    });
    const r = await h.dispatcher.handle(cmd('/新建'));
    const reply = r.reply ?? '';
    expect(reply).toContain('已新建会话：session-new0001');
    expect(reply).toContain('主工作区 (/workspace/proj-a)');
    expect(reply).not.toContain('工作区：ws-1');
  });

  it('/新建 工作区解析不到时如实回退显示 id（不空白、不假装）', async () => {
    const h = makeHarness(); // getWorkspace 默认返回 undefined
    const r = await h.dispatcher.handle(cmd('/新建'));
    expect(r.reply).toContain('ws-1');
  });

  it('mkdir / register / create 失败各自如实回执具体环节（§7.1 末行）', async () => {
    const cases: Array<[CreateSessionResult, string]> = [
      [{ ok: false, code: 'mkdir-failed', reason: 'EACCES: permission denied' }, '目录'],
      [{ ok: false, code: 'register-failed', reason: 'duplicate path' }, '注册'],
      [{ ok: false, code: 'create-failed', reason: 'agents.create rejected' }, '会话'],
    ];
    for (const [result, keyword] of cases) {
      const h = makeHarness({ control: { createSession: vi.fn(async () => result) } });
      const r = await h.dispatcher.handle(cmd('/新建 /tmp/whatever'));
      expect(r.reply).toContain(keyword);
      expect(r.reply).toContain(result.ok === false ? result.reason : '');
    }
  });
});

// ─────────────────────────── /停止 /状态（D31/D32） ───────────────────────────

describe('契约: /停止 与 /状态（D31/D32）', () => {
  it('/停止 直调 control.cancel（官方 cancel）', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.handle(cmd('/停止'));
    expect(r.handled).toBe(true);
    expect(h.ctl.cancel).toHaveBeenCalledWith(OPENID);
    expect(r.reply).toBeTruthy();
  });

  it('/停止 失败如实回执原因', async () => {
    const h = makeHarness({ control: { cancel: vi.fn(async () => ({ ok: false, reason: 'no active turn' })) } });
    const r = await h.dispatcher.handle(cmd('/停止'));
    expect(r.reply).toContain('no active turn');
  });

  it('/状态 回显全部字段：标题+短 id / 工作区 / 模型 / 思考 / 权限 / 忙闲 / 上下文用量', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.handle(cmd('/状态'));
    const reply = r.reply ?? '';
    expect(reply).toContain('修 bug');
    expect(reply).toContain('session-abcd…');
    expect(reply).toContain('主工作区');
    expect(reply).toContain('/workspace/proj-a');
    expect(reply).toContain('deepseek-v4-flash');
    expect(reply).toContain('high');
    expect(reply).toContain('workspace-write');
    expect(reply).toContain('运行');
    expect(reply).toContain('12.3K');
    expect(reply).not.toContain('**');
  });

  it('/状态 空闲时显示空闲', async () => {
    const h = makeHarness();
    h.ctl.status.mockResolvedValueOnce({
      sessionId: 'session-abcdef123456',
      title: '修 bug',
      workspaceTitle: '主工作区',
      workspacePath: '/workspace/proj-a',
      busy: false,
    });
    const r = await h.dispatcher.handle(cmd('/状态'));
    expect(r.reply).toContain('空闲');
  });

  it('status_show_usage=false 时不显示上下文用量（D32 开关）', async () => {
    const h = makeHarness({ statusShowUsage: false });
    const r = await h.dispatcher.handle(cmd('/状态'));
    expect(r.reply).not.toContain('上下文用量');
  });
});

// ────────────────────────── /模型 /思考 /权限（D26/D31） ───────────────────────────

describe('契约: /模型 /思考 /权限 直调官方服务，插件不维护自有状态（D26/D31）', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('/模型 无参 → 显示当前模型与可用模型列表', async () => {
    const r = await h.dispatcher.handle(cmd('/模型'));
    expect(r.reply).toContain('deepseek-v4-flash');
    expect(r.reply).toContain('deepseek-v4-pro');
    expect(h.official.select).not.toHaveBeenCalled();
  });

  it('/模型 <名称> → 官方 select（不落插件自有状态）', async () => {
    const r = await h.dispatcher.handle(cmd('/模型 deepseek-v4-pro'));
    expect(r.reply).toBeTruthy();
    expect(h.official.select).toHaveBeenCalledTimes(1);
    expect(h.official.select.mock.calls[0]?.[0]).toBe('session-01');
    expect(h.official.select.mock.calls[0]?.[1]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
  });

  it('/模型 <provider>/<model> 显式指定供应商', async () => {
    await h.dispatcher.handle(cmd('/模型 opencode-go/deepseek-flash'));
    expect(h.official.select.mock.calls[0]?.[1]).toMatchObject({
      provider: 'opencode-go',
      model: 'deepseek-flash',
    });
  });

  it('/模型 不存在的模型 → 如实回执，不猜测供应商', async () => {
    const r = await h.dispatcher.handle(cmd('/模型 no-such-model'));
    expect(r.reply).toContain('no-such-model');
    expect(h.official.select).not.toHaveBeenCalled();
  });

  it('/思考 无参 → 显示当前档位与可选档位', async () => {
    const r = await h.dispatcher.handle(cmd('/思考'));
    expect(r.reply).toContain('high');
    expect(r.reply).toContain('max');
  });

  it('/思考 <档位> → 官方 select 携带 reasoningEffort', async () => {
    const r = await h.dispatcher.handle(cmd('/思考 max'));
    expect(r.reply).toBeTruthy();
    expect(h.official.select).toHaveBeenCalledTimes(1);
    expect(h.official.select.mock.calls[0]?.[1]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    });
  });

  it('/思考 中文档位别名（最大 → max）', async () => {
    await h.dispatcher.handle(cmd('/思考 最大'));
    expect(h.official.select.mock.calls[0]?.[1]).toMatchObject({ reasoningEffort: 'max' });
  });

  it('/思考 无效档位 → 列出可用档位，不调用 select', async () => {
    const r = await h.dispatcher.handle(cmd('/思考 无所谓'));
    expect(r.reply).toContain('off');
    expect(h.official.select).not.toHaveBeenCalled();
  });

  it('/权限 无参 → 显示当前档位与可选档位', async () => {
    const r = await h.dispatcher.handle(cmd('/权限'));
    expect(r.reply).toContain('workspace-write');
    expect(r.reply).toContain('danger-full-access');
  });

  it('/权限 <档位> → 直调官方 permissions.set 并回显新档位（C-R1）', async () => {
    const r = await h.dispatcher.handle(cmd('/权限 完全'));
    expect(h.official.permSet).toHaveBeenCalledWith('session-01', 'danger-full-access');
    expect(r.reply).toContain('danger-full-access');
  });

  it('/权限 无效档位 → 列出可用档位，不调用 set', async () => {
    const r = await h.dispatcher.handle(cmd('/权限 随便'));
    expect(r.reply).toContain('readonly');
    expect(h.official.permSet).not.toHaveBeenCalled();
  });

  it('官方服务未接线时如实回执「服务不可用」，而不是静默成功', async () => {
    const h2 = makeHarness({ withOfficial: false });
    for (const raw of ['/模型', '/思考', '/权限']) {
      const r = await h2.dispatcher.handle(cmd(raw));
      expect(r.handled).toBe(true);
      expect(r.reply).toContain('不可用');
    }
  });
});

// ───────────── 列表翻页提示的条件化展示（本次修复的用户决策） ─────────────

describe('契约: 翻页提示仅在列表超过 1 页时展示', () => {
  it('/会话 >10 条（>1 页）→ footer 提示翻页', async () => {
    const h = makeHarness(); // 15 条 → 2 页
    const r = await h.dispatcher.handle(cmd('/会话'));
    const reply = r.reply ?? '';
    expect(reply).toContain('翻页：/下一页 /上一页');
    expect(reply).toContain('选择：/会话 <序号|标题>');
  });

  it('/会话 ≤10 条（单页）→ footer 不出现翻页，仅保留选择提示', async () => {
    const ctl = makeControl({ listSessions: vi.fn(async () => makeSessions(5)) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });
    const r = await dispatcher.handle(cmd('/会话'));
    const reply = r.reply ?? '';
    expect(reply).toContain('项目05');
    expect(reply).not.toContain('翻页');
    expect(reply).toContain('选择：/会话 <序号|标题>');
  });

  it('/切换 >10 条（>1 页）→ footer 提示翻页', async () => {
    const h = makeHarness(); // 12 个 → 2 页
    const r = await h.dispatcher.handle(cmd('/切换'));
    const reply = r.reply ?? '';
    expect(reply).toContain('翻页：/下一页 /上一页');
    expect(reply).toContain('选择：/切换 <序号|路径>');
  });

  it('/切换 ≤10 条（单页）→ footer 不出现翻页', async () => {
    const ctl = makeControl({ listWorkspaces: vi.fn(async () => makeWorkspaces(5)) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });
    const r = await dispatcher.handle(cmd('/切换'));
    const reply = r.reply ?? '';
    expect(reply).toContain('工作区05');
    expect(reply).not.toContain('翻页');
    expect(reply).toContain('选择：/切换 <序号|路径>');
  });
});

// ─────────────────────────── 分页子命令（D22） ───────────────────────────

describe('契约: 分页子命令（D22）', () => {
  it('无分页时 /下一页 /上一页 按普通命令回执提示，不报错', async () => {
    const h = makeHarness();
    for (const raw of ['/下一页', '/上一页']) {
      const r = await h.dispatcher.handle(cmd(raw));
      expect(r.handled).toBe(true);
      expect(r.reply).toContain('分页');
      expect(r.reply).toContain('/会话');
    }
  });

  it('分页活跃时 /下一页 翻页且保持分页状态；边界页回执但保持在分页状态（§5）', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 1 });

    const r = await h.dispatcher.handle(cmd('/下一页'));
    expect(r.reply).toContain('项目11');
    expect(h.paging.get(OPENID)?.page).toBe(2);

    const r2 = await h.dispatcher.handle(cmd('/下一页'));
    expect(r2.reply).toBeTruthy();
    expect(r2.reply).toContain('最后');
    expect(h.paging.get(OPENID)?.page).toBe(2);
  });

  it('分页活跃时 /上一页 回退；第 1 页时回执且保持', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'workspaces', workspaceId: 'ws-1', page: 2 });
    const r = await h.dispatcher.handle(cmd('/上一页'));
    expect(r.reply).toContain('主工作区');
    expect(h.paging.get(OPENID)?.page).toBe(1);
  });

  it('分页活跃时收到无参列表命令 → 退出旧分页并重设为新列表第 1 页（自身管理分页，不被误清）', async () => {
    const h = makeHarness();
    h.paging.set(OPENID, { listKind: 'workspaces', workspaceId: 'ws-1', page: 2 });
    const r = await h.dispatcher.handle(cmd('/会话'));
    expect(r.exitPaging).toBeFalsy();
    expect(h.paging.get(OPENID)).toEqual({ listKind: 'sessions', workspaceId: 'ws-1', page: 1 });
  });
});

// ─────────────── /压缩（D44：等价 DSH `/compact`，直调官方接口） ───────────────
//
// 用户拍板：① 先回「正在压缩…」，完成后由 followUp 追加结果（同一 anchor 的两次被动回复）；
// ② **不可中断**，与官方对齐（`/停止` 只管 turn，不 abort 压缩）。

describe('契约: /压缩（D44）', () => {
  it('无参 → 立即回执「正在压缩」并给出 followUp；followUp 返回压缩结果', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.handle(cmd('/压缩'));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('正在压缩');
    expect(h.ctl.compact).toHaveBeenCalledWith(OPENID);
    expect(typeof r.followUp).toBe('function');
    const text = await r.followUp!();
    expect(text).toContain('已压缩 3 条历史');
    expect(text).toContain('1.5K'); // formatTokens(1500)
  });

  it('返回 null（无可压缩历史）→ followUp 如实说明，不假装压缩过', async () => {
    const h = makeHarness({
      control: { compact: vi.fn(async (): Promise<CompactOutcome> => ({ ok: true, compacted: false })) },
    });
    const r = await h.dispatcher.handle(cmd('/压缩'));
    const text = await r.followUp!();
    expect(text).toContain('没有');
    expect(text).not.toContain('已压缩');
  });

  it('失败 → followUp 如实回执官方错误码对应的原因', async () => {
    const h = makeHarness({
      control: {
        compact: vi.fn(
          async (): Promise<CompactOutcome> => ({ ok: false, code: 'busy', reason: '本进程已有压缩在进行' }),
        ),
      },
    });
    const r = await h.dispatcher.handle(cmd('/压缩'));
    const text = await r.followUp!();
    expect(text).toContain('压缩失败');
    expect(text).toContain('本进程已有压缩在进行');
  });

  it('带参数 → 拒绝且不调用 control.compact（对齐官方 usage: no arguments）', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.handle(cmd('/压缩 现在'));
    expect(r.reply).toContain('不接受参数');
    expect(h.ctl.compact).not.toHaveBeenCalled();
    expect(r.followUp).toBeUndefined();
  });

  it('未选中控制目标 → 只提示、不调用 compact（D27）', async () => {
    const h = makeHarness({
      control: { getTarget: vi.fn(async (): Promise<ControlTarget> => ({ workspaceId: 'ws-1', sessionId: null })) },
    });
    const r = await h.dispatcher.handle(cmd('/压缩'));
    expect(r.reply).toContain('请先 /会话 选会话');
    expect(h.ctl.compact).not.toHaveBeenCalled();
    expect(r.followUp).toBeUndefined();
  });

  it('followUp 文本同样按 reply_max_chars 截断（D34）', async () => {
    const h = makeHarness({ replyMaxChars: 20 });
    const r = await h.dispatcher.handle(cmd('/压缩'));
    const text = await r.followUp!();
    expect(text!.length).toBeLessThanOrEqual(20);
  });
});

// ─────────── /会话 与 WebUI 口径一致：归档会话不入列表（D45） ───────────
//
// 用户报告：`/会话` 会列出已归档会话（WebUI 不展示的那些）。根因：`SessionRef.archived`
// 算出来了却无人消费（workspaces.ts:177 生产 → 命令层从不读）。用户拍板：
// ① 直接隐藏；② 不加「已隐藏 N 条」提示；③ `/切换` 的「会话 N」一并对齐 WebUI（不计归档）。

describe('契约: 归档会话口径（D45）', () => {
  it('/会话 隐藏归档，且归档不参与序号/标题寻址', async () => {
    // 12 条中第 3 条（项目03）与第 12 条（项目12）已归档 → 可见 10 条
    const sessions = makeSessions(12).map((s, i) => (i === 2 || i === 11 ? { ...s, archived: true } : s));
    const ctl = makeControl({ listSessions: vi.fn(async () => sessions) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });

    const list = await dispatcher.handle(cmd('/会话'));
    const reply = list.reply ?? '';
    expect(reply).not.toContain('项目03');
    expect(reply).not.toContain('项目12');
    expect(reply).toContain('共 10 条');
    expect(reply).toContain('第 1/1 页');
    expect(reply).toContain('项目04');

    // 序号指向**可见列表**第 3 条 = 原第 4 条（项目04 → session-0400）
    await dispatcher.handle(cmd('/会话 3'));
    expect(ctl.setTarget).toHaveBeenCalledTimes(1);
    expect(ctl.setTarget.mock.calls[0]?.[1]).toBe('session-0400');

    // 归档标题不可命中（不得把用户引向必然失败的「切换失败（archived）」死胡同）
    const byTitle = await dispatcher.handle(cmd('/会话 项目03'));
    expect(byTitle.reply).toContain('未找到匹配的会话');
    expect(ctl.setTarget).toHaveBeenCalledTimes(1);
  });

  it('过滤归档后 /下一页 与跨页连续编号按可见列表计算（D22）', async () => {
    // 25 条中第 1、25 条归档 → 可见 23 条（项目02..项目24）→ 3 页
    const sessions = makeSessions(25).map((s, i) => (i === 0 || i === 24 ? { ...s, archived: true } : s));
    const h = makeHarness({ control: { listSessions: vi.fn(async () => sessions) } });

    const p1 = await h.dispatcher.handle(cmd('/会话'));
    expect(p1.reply).toContain('第 1/3 页');
    expect(p1.reply).toContain('共 23 条');
    expect(p1.reply).not.toContain('项目01');

    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 3 });
    const p3 = await h.dispatcher.handle(cmd('/会话'));
    const reply3 = p3.reply ?? '';
    expect(reply3).toMatch(/(^|\n)21\. /);
    expect(reply3).toContain('项目22'); // 可见第 21 条
    expect(reply3).toContain('项目24'); // 可见第 23 条
    expect(reply3).not.toContain('项目25'); // 已归档 ⇒ 任何页都不出现

    const next = await h.dispatcher.handle(cmd('/下一页'));
    expect(next.reply).toContain('最后');
    expect(h.paging.get(OPENID)?.page).toBe(3);
  });

  it('/切换 列表的「会话 N」不计归档（与 WebUI sessionCount 口径一致）', async () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'ws-1', title: '主工作区', path: '/workspace/proj-01', sessionIds: ['s-a', 's-b', 's-c'] },
      { id: 'ws-2', title: '工作区02', path: '/workspace/proj-02', sessionIds: ['s-d'] },
    ];
    const ctl = makeControl({
      listWorkspaces: vi.fn(async () => workspaces),
      listArchivedSessionIds: vi.fn(async () => ['s-b', 's-c']),
    });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });

    const r = await dispatcher.handle(cmd('/切换'));

    expect(r.reply).toContain('主工作区  路径 /workspace/proj-01  会话 1'); // 3 - 2 条归档
    expect(r.reply).toContain('工作区02  路径 /workspace/proj-02  会话 1');
  });
});

// ─────────── /会话 与 WebUI 口径对齐：空白会话可见性 + 活跃时间 + 最新在前（D46） ──────────
//
// 用户报告（2026-09-16）：`/会话` 第 1 条是 `session-36ac…`（WebUI 侧边栏根本看不到），
// 且每行「最后活跃 未知」。后者根因是 `SessionRef.lastActive` 声明了却**从不赋值**
// （`src/dsh/workspaces.ts` 构造时无该键）——而夹具自己喂了值、断言只校验格式，
// 于是单测全绿而真机恒「未知」（AGENTS §3.1 盲区）。本块同时钉死这两条。
//
// 权威口径（与 WebUI 同源，均出自 `dsh-api-session-controller` 的 `SessionSummary`）：
//   - 可见性：`sessionVisible = origin!=='subagent' && !archived && (!blank || id===current)`
//     【文档明写】`dsh-client-ui-workspace/lib/client.js:338-340`；
//   - 时间：`updatedAt = Math.max(header.createdAt, sessionListMetadata.lastPromptAt ?? 0)`
//     【文档明写】`dsh-api-session-controller/lib/index.js:1969-1971`；
//   - 排序：`byRecency` = `updatedAt` 新→旧【文档明写】同文件 `:326-329`；
//   - 相对时间文案：`刚刚`/`N分钟`/`N小时`/`N天`/`N个月`/`N年`
//     【文档明写】`client.js:2625-2629` + `dsh-client-ui-primitives/lib/index.js:4944-4972`。
// 用户拍板（2026-09-16）：直接照抄 WebUI；**时间拿不到就整段省略**（不印「未知」），绝不影响功能。

describe('契约: /会话 与 WebUI 可见性/时间/排序对齐（D46）', () => {
  it('空白会话按 WebUI 隐藏；但它是当前受控会话时仍显示（`!blank || id===current`）', async () => {
    // 第 2 条是无标题的空白会话（等价真机的 session-36ac…：无 turn/start、无 session/title）
    const sessions = makeSessions(3).map((s, i) =>
      i === 1 ? { ...s, title: undefined, blank: true } : s,
    );

    // 当前控制目标是 session-0100 ⇒ 空白会话不是 current ⇒ 隐藏
    const ctl = makeControl({ listSessions: vi.fn(async () => sessions) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });
    const hidden = await dispatcher.handle(cmd('/会话'));
    expect(hidden.reply).toContain('共 2 条');
    expect(hidden.reply).not.toContain('session-0200'); // 空白会话不进列表（不再出现「裸短 id」行）
    expect(hidden.reply).toContain('项目01');
    expect(hidden.reply).toContain('项目03');

    // 当前控制目标**就是**那个空白会话 ⇒ 显示（WebUI 同款豁免），并沿用 WebUI 的「新会话」标签
    const ctl2 = makeControl({
      listSessions: vi.fn(async () => sessions),
      getTarget: vi.fn(async () => ({ workspaceId: 'ws-1', sessionId: 'session-0200' })),
    });
    const dispatcher2 = createCommandDispatcher({ control: ctl2.control, paging: createPagingStore(), logger });
    const shown = await dispatcher2.handle(cmd('/会话'));
    expect(shown.reply).toContain('共 3 条');
    expect(shown.reply).toMatch(/(^|\n)2\. （新会话） /);
    expect(shown.reply).not.toContain('session-0200');
  });

  it('subagent 子会话按 WebUI 隐藏（origin 为 subagent 时不进列表）', async () => {
    const sessions = makeSessions(3).map((s, i) => (i === 1 ? { ...s, origin: 'subagent' } : s));
    const ctl = makeControl({ listSessions: vi.fn(async () => sessions) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });

    const r = await dispatcher.handle(cmd('/会话'));

    expect(r.reply).toContain('共 2 条');
    expect(r.reply).not.toContain('项目02');
    // 过滤后序号寻址必须落在**可见列表**上（可见第 2 条 = 项目03）
    await dispatcher.handle(cmd('/会话 2'));
    expect(ctl.setTarget).toHaveBeenCalledTimes(1);
    expect(ctl.setTarget.mock.calls[0]?.[1]).toBe('session-0300');
  });

  it('排序 = 最新在前（`byRecency`），序号随活跃度而非注册表顺序', async () => {
    const base = makeSessions(3);
    // 注册表顺序 01/02/03，但活跃度 02 最新、03 居中、01 最旧 ⇒ 期望 02, 03, 01
    const sessions = [
      { ...base[0]!, lastActive: 1_700_000_000_000 },
      { ...base[1]!, lastActive: 1_700_000_200_000 },
      { ...base[2]!, lastActive: 1_700_000_100_000 },
    ];
    const ctl = makeControl({ listSessions: vi.fn(async () => sessions) });
    const dispatcher = createCommandDispatcher({ control: ctl.control, paging: createPagingStore(), logger });

    const r = await dispatcher.handle(cmd('/会话'));
    expect(r.reply).toMatch(/1\. 项目02/);
    expect(r.reply).toMatch(/2\. 项目03/);
    expect(r.reply).toMatch(/3\. 项目01/);

    // 序号 1 命中最新（项目02），不得按注册表顺序落回项目01
    await dispatcher.handle(cmd('/会话 1'));
    expect(ctl.setTarget.mock.calls[0]?.[1]).toBe('session-0200');
  });

  it('缺时间元数据（服务缺席/降级）→ 整段省略时间段，且绝不印「未知」', async () => {
    const sessions = makeSessions(3).map((s) => ({ ...s, lastActive: undefined }));
    const h = makeHarness({ control: { listSessions: vi.fn(async () => sessions) } });

    const r = await h.dispatcher.handle(cmd('/会话'));
    const reply = r.reply ?? '';

    expect(reply).toContain('共 3 条');
    expect(reply).toMatch(/(^|\n)1\. 项目01\n/); // 行尾无时间片段
    expect(reply).not.toContain('未知');
    expect(reply).not.toContain('最后活跃');
  });

  it('相对时间档位与 WebUI 逐档一致（刚刚/N分钟/N小时/N天/N个月/N年）', async () => {
    const now = Date.now();
    const cases: ReadonlyArray<readonly [number, string]> = [
      [30_000, '刚刚'],
      [5 * 60_000, '5分钟'],
      [3 * 3_600_000, '3小时'],
      [4 * 86_400_000, '4天'],
      [70 * 86_400_000, '2个月'],
      [400 * 86_400_000, '1年'],
    ];
    const sessions: SessionRef[] = cases.map(([age, _label], i) => ({
      sessionId: `session-age${i}`,
      title: `项目${String(i + 1).padStart(2, '0')}`,
      workspaceId: 'ws-1',
      workspaceTitle: '主工作区',
      lastActive: now - age,
      blank: false,
      archived: false,
    }));
    const h = makeHarness({ control: { listSessions: vi.fn(async () => sessions) } });

    const reply = (await h.dispatcher.handle(cmd('/会话'))).reply ?? '';

    cases.forEach(([_age, label], i) => {
      expect(reply).toMatch(new RegExp(`(^|\\n)${i + 1}\\. 项目0${i + 1} ${label}\\n`));
    });
  });

  it('翻页路径同样应用可见性过滤与排序（不能只在首屏生效）', async () => {
    // 25 条：其中第 2 条 blank、第 3 条 subagent → 可见 23 条 ⇒ 3 页
    const sessions = makeSessions(25).map((s, i) => {
      if (i === 1) return { ...s, blank: true };
      if (i === 2) return { ...s, origin: 'subagent' };
      return s;
    });
    const h = makeHarness({ control: { listSessions: vi.fn(async () => sessions) } });

    const p1 = await h.dispatcher.handle(cmd('/会话'));
    expect(p1.reply).toContain('共 23 条');
    expect(p1.reply).toContain('第 1/3 页');
    expect(p1.reply).not.toContain('项目02');
    expect(p1.reply).not.toContain('项目03');

    h.paging.set(OPENID, { listKind: 'sessions', workspaceId: 'ws-1', page: 2 });
    const p2 = await h.dispatcher.handle(cmd('/下一页'));
    const reply2 = p2.reply ?? '';
    expect(reply2).toContain('第 3/3 页');
    // 可见列表第 21~23 条 = 项目23/24/25（前两条被隐藏后整体前移）
    expect(reply2).toMatch(/(^|\n)21\. 项目23 /);
    expect(reply2).toContain('项目25');
  });
});