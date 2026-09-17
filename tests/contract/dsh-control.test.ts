/**
 * T3 契约测试：DSH 会话控制层（真实装配）
 *
 * 本文件**不做纯桩自证**：在真实 `bootDshQqbotBridge` 装配上打开真实的
 * `workspaceRegistry` / `storageDomain` / `agents` / `sessionProjections` 等服务，
 * 覆盖 D19 / D24 / D25 / D26 / D28 / D29 / D30 / D32 与 E12-A / E12-B 的实测语义。
 *
 * 仅有的替身用于隔离**外部服务行为**（AGENTS.md §3.1 允许）：
 *   - `agents` 包装器：模拟「跨进程 registry 无该会话」以触发真实 resume 锁冲突；
 *   - `sessionProjections` 判忙替身：用于验证 steer/followup 分流，避免真机 LLM 调用。
 *
 * 两个**可失败断言**（任务书硬性要求）：
 *   1. `锁冲突时不会调用 agents.create`（D30/E12-B）；
 *   2. `setWorkspace 会清空控制目标`（D19）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-llm';

import { bootDshQqbotBridge, type BootedDsh } from '../../src/boot.js';
import {
  ControlInputError,
  errorMessage,
  isSessionAlreadyOwned,
  openControlService,
  type AgentDefaultModelLike,
  type AgentRegistryLike,
  type AgentPresetsLike,
  type ControlContext,
  type PermissionPresetsLike,
  type SessionProjectionsLike,
  type TokenMeterLike,
} from '../../src/dsh/control.js';
import { openTargetStore } from '../../src/dsh/target-store.js';
import { readSessionFacets } from '../../src/dsh/workspaces.js';
import type { SessionQueryLike, SessionTitleLike, WorkspaceRegistryLike } from '../../src/dsh/workspaces.js';
import type { CompactionEngine, CompactionResult } from '@deepseek-ai/dsh-compaction';
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import type { ControlTarget } from '../../src/types/index.js';

// ══════════════════ 真实装配读取助手（显式结构读，不做 `as any` 兜底） ══════════════════

interface OptionalServices {
  permissionPresets?: PermissionPresetsLike;
  sessionTitle?: SessionTitleLike;
  sessionQuery?: SessionQueryLike;
  agentDefaultModel?: AgentDefaultModelLike;
  /** `/压缩` 直调的官方压缩服务（LLM 外部依赖；测试用替身隔离） */
  compaction?: CompactionEngine;
}

interface WorkspaceRegistryProbe extends WorkspaceRegistryLike {
  archiveSession(sessionId: SessionId): Promise<void>;
}

/**
 * 读取官方 ctx 上的服务。
 * `permissionPresets` / `sessionTitle` / `sessionQuery` / `agentDefaultModel` 的官方类型
 * 不在本项目 node_modules 的类型图内，故按显式结构面读取；读不到就如实缺席（不假装有）。
 */
function readService<T>(host: object, key: string): T | undefined {
  try {
    const value: unknown = Reflect.get(host, key);
    return value === undefined || value === null ? undefined : (value as T);
  } catch {
    return undefined;
  }
}

function requireService<T>(host: object, key: string): T {
  const value = readService<T>(host, key);
  if (value === undefined) throw new Error(`真实装配缺少服务：${key}`);
  return value;
}

function readOptionalServices(host: object): OptionalServices {
  return {
    permissionPresets: readService<PermissionPresetsLike>(host, 'permissionPresets'),
    sessionTitle: readService<SessionTitleLike>(host, 'sessionTitle'),
    sessionQuery: readService<SessionQueryLike>(host, 'sessionQuery'),
    agentDefaultModel: readService<AgentDefaultModelLike>(host, 'agentDefaultModel'),
    compaction: readService<CompactionEngine>(host, 'compaction'),
  };
}

const silentLogger = {
  info: (..._args: unknown[]): void => undefined,
  warn: (..._args: unknown[]): void => undefined,
  error: (..._args: unknown[]): void => undefined,
};

// ══════════════════ 主装配套件 ══════════════════

describe('T3 控制层（真实 DSH 装配）', () => {
  let booted: BootedDsh;
  let ctxHost: object;
  let home: string;
  let workRoot: string;
  let optional: OptionalServices;
  let fixtureSessionId: string;
  let fixtureWorkspaceId: string;
  let fixtureAgent: Agent;

  function agents(): AgentRegistryLike {
    return requireService<AgentRegistryLike>(ctxHost, 'agents');
  }

  function registry(): WorkspaceRegistryProbe {
    return requireService<WorkspaceRegistryProbe>(ctxHost, 'workspaceRegistry');
  }

  function realDeps(overrides: Partial<ControlContext> = {}): ControlContext {
    const deps: ControlContext = {
      workspaceRegistry: registry(),
      agents: agents(),
      sessionProjections: requireService<SessionProjectionsLike>(ctxHost, 'sessionProjections'),
      storageDomain: requireService<ControlContext['storageDomain']>(ctxHost, 'storageDomain'),
      tokenMeter: requireService<TokenMeterLike>(ctxHost, 'tokenMeter'),
      logger: silentLogger,
      ...(optional.permissionPresets ? { permissionPresets: optional.permissionPresets } : {}),
      ...(optional.sessionTitle ? { sessionTitle: optional.sessionTitle } : {}),
      ...(optional.sessionQuery ? { sessionQuery: optional.sessionQuery } : {}),
      ...(optional.agentDefaultModel ? { agentDefaultModel: optional.agentDefaultModel } : {}),
      ...(optional.compaction ? { compaction: optional.compaction } : {}),
      ...overrides,
    };
    return deps;
  }

  async function withService<T>(
    overrides: Partial<ControlContext>,
    options: Parameters<typeof openControlService>[1],
    body: (control: Awaited<ReturnType<typeof openControlService>>) => Promise<T>,
  ): Promise<T> {
    const opened = await openControlService(realDeps(overrides), options);
    try {
      return await body(opened);
    } finally {
      await opened.dispose();
    }
  }

  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 't3-control-home-'));
    const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    for (const name of ['settings.yaml', '.credentials.yaml']) {
      const src = path.join(realHome, name);
      if (fs.existsSync(src)) {
        await fsp.copyFile(src, path.join(home, name));
        await fsp.chmod(path.join(home, name), 0o600).catch(() => undefined);
      }
    }
    workRoot = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't3-control-ws-')));

    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    ctxHost = booted.ctx as object;
    optional = readOptionalServices(ctxHost);

    // 夹具：真实工作区 + 真实会话（接管类用例的公共目标）
    const workspace = await registry().create(workRoot, 't3-control-ws');
    fixtureWorkspaceId = String(workspace.id);
    fixtureSessionId = `session-${Date.now()}-fixture`;
    const handle: AgentHandle = await agents().create({
      sessionId: SessionId(fixtureSessionId),
      meta: { cwd: workspace.path },
    });
    await workspace.attachSession(SessionId(fixtureSessionId));
    fixtureAgent = handle.agent;
  }, 300_000);

  afterAll(async () => {
    await booted?.dispose().catch(() => undefined);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // ─────────────── D28：首次未选中态 ───────────────

  it('D28：首次读取为未选中态（{workspaceId:null, sessionId:null}）', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      expect(await control.getTarget('openid-brand-new')).toEqual({
        workspaceId: null,
        sessionId: null,
      });
      expect(await control.status('openid-brand-new')).toBeUndefined();
      expect((await control.validateTarget('openid-brand-new')).valid).toBe(false);
    });
  });

  // ─────────────── 受控会话反查（交互层判定「当前正受远程受控」的唯一依据） ───────────────

  it('findControlOwner：只反映**此刻**的控制目标，清空后立即失效（不留历史映射）', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      // 初始未受控
      expect(control.findControlOwner(fixtureSessionId)).toBeUndefined();

      const taken = await control.setTarget('openid-owner-a', fixtureSessionId);
      expect(taken.ok).toBe(true);
      expect(control.findControlOwner(fixtureSessionId)).toBe('openid-owner-a');

      // ← 关键可失败断言：清空控制目标后反查必须立即失效。
      //   若实现退回「曾经由 QQ 驱动过」的历史映射（sessionOwner），此处会残留 owner-a，
      //   导致用户已切走的会话仍抢占 QQ 侧的审批/提问卡片。
      await control.clearTarget('openid-owner-a', '测试：清空后反查必须失效');
      expect(control.findControlOwner(fixtureSessionId)).toBeUndefined();

      // 空/空白 sessionId 不猜
      expect(control.findControlOwner('')).toBeUndefined();
      expect(control.findControlOwner('   ')).toBeUndefined();
    });
  });

  // ────────── /压缩（D44：直调官方 ctx.compaction.compactNow） ───────────

  function makeFakeCompactionEngine(
    impl: (agent: Agent, signal: AbortSignal) => Promise<CompactionResult | null>,
  ): { engine: CompactionEngine; calls: Array<{ agent: Agent; signal: AbortSignal }> } {
    const calls: Array<{ agent: Agent; signal: AbortSignal }> = [];
    const engine = {
      compactNow: async (agent: Agent, signal: AbortSignal): Promise<CompactionResult | null> => {
        calls.push({ agent, signal });
        return impl(agent, signal);
      },
    } as unknown as CompactionEngine; // 替身仅隔离 LLM 外部依赖（AGENTS §3.1 允许）
    return { engine, calls };
  }

  /**
   * 造一个**真实 API 形状**的 `agentPresets` 替身：`serviceFor` 是官方 READ 寻址
   * （`dsh-agent-presets/lib/types/index.d.ts:323-325`），也就是生产先例
   * `dsh-api-session-controller/lib/index.js:2273` 读 `skills` 的同一写法。
   *
   * ️ 教训：本文件先前那条「web 形状」用例伪造的是 `agent.ctx.get('compaction')`——
   * 而 realm 内的服务对 **agent 自己的 ctx 也不可见**（`dsh-agent-presets/lib/index.js:795-802`
   * 原文："invisible to everything outside the group — including the agent's own scope context
   * and the host"），于是「红→绿」是假信号。此处只替身**官方存在的 API**。
   */
  function fakeAgentPresets(engine: CompactionEngine | undefined): {
    presets: AgentPresetsLike;
    serviceFor: ReturnType<typeof vi.fn>;
  } {
    const serviceFor = vi.fn((_agent: unknown, name: string) =>
      name === 'compaction' ? engine : undefined,
    );
    return {
      // D52：`resolve`/`mount` 只补成官方形状（本用例不建会话，不会被调用）；
      // 任何断言都未改动，见 tests/contract/dsh-agent-preset.test.ts 的真实装配用例。
      presets: {
        resolve: vi.fn(async () => ({ id: 'test-preset' })),
        mount: vi.fn(async () => ({ id: 'test-preset' })),
        serviceFor,
      } as unknown as AgentPresetsLike,
      serviceFor,
    };
  }

  /** 造一个「在 `agent.ctx` 上放诱饵压缩引擎」的注册表替身——用于反假桩回归 */
  function registryWithDecoyAgentCtx(decoy: CompactionEngine): AgentRegistryLike {
    const real = agents();
    const decoyAgent = Object.create(fixtureAgent) as Agent;
    Object.defineProperty(decoyAgent, 'ctx', {
      value: { get: (key: string) => (key === 'compaction' ? decoy : undefined) },
      enumerable: true,
    });
    return {
      get: (id: SessionId) => (String(id) === fixtureSessionId ? decoyAgent : real.get(id)),
      create: (options) => real.create(options),
      resume: (options) => real.resume(options),
    };
  }

  it('/压缩（web profile 形状）：host 平面无压缩 → 用 **agentPresets.serviceFor** 读 preset realm 内的实例', async () => {
    const { engine, calls } = makeFakeCompactionEngine(
      async () =>
        ({
          shadowedSeqs: ['s1'],
          shadowedTokenCount: 42,
        }) as unknown as CompactionResult,
    );
    const { presets, serviceFor } = fakeAgentPresets(engine);
    await withService(
      // host 平面无压缩（= web profile 的真实形状）+ 只有 agentPresets 注册表
      { compaction: undefined, agentPresets: presets },
      { restoreOnStart: false },
      async ({ control }) => {
        const taken = await control.setTarget('u-scoped', fixtureSessionId);
        expect(taken.ok).toBe(true);

        const outcome = await control.compact('u-scoped');

        // ← 关键可失败断言：只读 host 平面的实现会在这里回 unavailable（真机缺陷）
        expect(outcome).toEqual({ ok: true, compacted: true, shadowedItems: 1, shadowedTokens: 42 });
        expect(calls).toHaveLength(1);
        expect(serviceFor).toHaveBeenCalledWith(expect.anything(), 'compaction');
      },
    );
  });

  it('/压缩：**不得**读 agent.ctx（realm 内服务对 agent ctx 不可见）——诱饵引擎必须被忽略', async () => {
    const { engine: decoy, calls: decoyCalls } = makeFakeCompactionEngine(async () => null);
    await withService(
      {
        compaction: undefined,
        agentPresets: undefined,
        agents: registryWithDecoyAgentCtx(decoy),
      },
      { restoreOnStart: false },
      async ({ control }) => {
        await control.setTarget('u-decoy', fixtureSessionId);

        const outcome = await control.compact('u-decoy');

        // 两个平面都没有压缩 ⇒ 必须如实回 unavailable
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe('unavailable');
        // ← 反假桩回归：若有人把 `agent.ctx.get('compaction')` 回退加回来，诱饵会被采用（不变红才怪）
        expect(decoyCalls).toHaveLength(0);
      },
    );
  });

  it('/压缩：直调官方 compactNow（live agent + AbortSignal），结果折算成条数与 tokens', async () => {
    const { engine, calls } = makeFakeCompactionEngine(
      async () =>
        ({
          shadowedSeqs: ['seq-1', 'seq-2', 'seq-3'],
          shadowedTokenCount: 1500,
        }) as unknown as CompactionResult,
    );
    await withService({ compaction: engine }, { restoreOnStart: false }, async ({ control }) => {
      const taken = await control.setTarget('u-compact', fixtureSessionId);
      expect(taken.ok).toBe(true);

      const outcome = await control.compact('u-compact');

      expect(outcome).toEqual({ ok: true, compacted: true, shadowedItems: 3, shadowedTokens: 1500 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.agent.session.id).toBe(fixtureSessionId);
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it('/压缩：compactNow 返回 null（无可压缩范围）→ compacted:false，不假装压缩过', async () => {
    const { engine } = makeFakeCompactionEngine(async () => null);
    await withService({ compaction: engine }, { restoreOnStart: false }, async ({ control }) => {
      await control.setTarget('u-compact-null', fixtureSessionId);
      expect(await control.compact('u-compact-null')).toEqual({ ok: true, compacted: false });
    });
  });

  it('/压缩：官方 ManualCompactionError(code) → 按码如实回执（不吞成通用错误）', async () => {
    const { engine } = makeFakeCompactionEngine(async () => {
      throw new ManualCompactionError('busy', 'compaction already active');
    });
    await withService({ compaction: engine }, { restoreOnStart: false }, async ({ control }) => {
      await control.setTarget('u-compact-busy', fixtureSessionId);
      const outcome = await control.compact('u-compact-busy');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('busy');
        expect(outcome.reason.length).toBeGreaterThan(0);
      }
    });
  });

  it('/压缩：host 与 preset realm **都没有**压缩服务 → 明确 unavailable（不假装成功）', async () => {
    await withService(
      // preset 里没挂压缩（如 minimal/自建 preset）→ serviceFor 返回 undefined
      { compaction: undefined, agentPresets: fakeAgentPresets(undefined).presets },
      { restoreOnStart: false },
      async ({ control }) => {
        await control.setTarget('u-compact-none', fixtureSessionId);
        const outcome = await control.compact('u-compact-none');
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe('unavailable');
      },
    );
  });

  it('/压缩：未选中控制目标 → no-target，且不触碰压缩引擎', async () => {
    const { engine, calls } = makeFakeCompactionEngine(async () => null);
    await withService({ compaction: engine }, { restoreOnStart: false }, async ({ control }) => {
      const outcome = await control.compact('u-compact-unselected');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('no-target');
      expect(calls).toHaveLength(0);
    });
  });

  // ────── 归档口径的分层（D45：dsh 层保留标记、命令层负责隐藏） ──────

  it('listSessions 保留 archived 标记 + listArchivedSessionIds 暴露归档集合（D29 语义不变）', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't3-arch-')));
      const ws = await registry().create(dir, 't3-arch-ws');
      const sid = `session-${Date.now()}-arch`;
      await agents().create({ sessionId: SessionId(sid), meta: { cwd: ws.path } });
      await ws.attachSession(SessionId(sid));
      await registry().archiveSession(SessionId(sid));

      // ← 关键断言：dsh 层**不过滤**（忠实投影 + 标记），隐藏责任在命令层。
      //   若将来有人把过滤下沉到 listSessions，这条会红，提醒同步 D29 与命令层语义。
      const listed = await control.listSessions(String(ws.id));
      expect(listed.find((s) => s.sessionId === sid)?.archived).toBe(true);
      expect(await control.listArchivedSessionIds()).toContain(sid);
    });
  });

  // ────── D46：会话活跃元数据（时间 / 空白 / origin）的权威来源与降级 ──────

  it('listSessions 合入 sessionActivity 的 updatedAt/blank/origin（D46，且 dsh 层不做展示策略）', async () => {
    await withService(
      {
        sessionActivity: {
          list: async () => [
            { sessionId: fixtureSessionId, updatedAt: 1_700_000_123_456, blank: true, origin: 'subagent' },
          ],
        },
      },
      { restoreOnStart: false },
      async ({ control }) => {
        const listed = await control.listSessions(fixtureWorkspaceId);
        const ref = listed.find((s) => s.sessionId === fixtureSessionId);

        expect(ref?.lastActive).toBe(1_700_000_123_456);
        expect(ref?.blank).toBe(true);
        expect(ref?.origin).toBe('subagent');
        // 关键分层：dsh 层**不**按 blank/origin 过滤，只如实带标记（隐藏责任在命令层）
        expect(listed).toHaveLength(1);
      },
    );
  });

  it('sessionActivity 未覆盖的会话不被凭空补值（缺省 = 时间未知、非空白）', async () => {
    const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't3-act-')));
    const ws = await registry().create(dir, 't3-act-ws');
    const covered = `session-${Date.now()}-covered`;
    const uncovered = `session-${Date.now()}-uncovered`;
    for (const id of [covered, uncovered]) {
      await agents().create({ sessionId: SessionId(id), meta: { cwd: ws.path } });
      await ws.attachSession(SessionId(id));
    }

    await withService(
      { sessionActivity: { list: async () => [{ sessionId: covered, updatedAt: 42, blank: false }] } },
      { restoreOnStart: false },
      async ({ control }) => {
        const listed = await control.listSessions(String(ws.id));
        const coveredRef = listed.find((s) => s.sessionId === covered);
        const uncoveredRef = listed.find((s) => s.sessionId === uncovered);

        expect(coveredRef?.lastActive).toBe(42);
        expect(coveredRef?.blank).toBe(false);
        expect(uncoveredRef?.lastActive).toBeUndefined();
        expect(uncoveredRef?.blank).toBeUndefined();
      },
    );
  });

  it('sessionActivity 抛错 → listSessions 不抛错且字段缺省（D46 降级：时间拿不到就不显示）', async () => {
    await withService(
      {
        sessionActivity: {
          list: async () => {
            throw new Error('activity source exploded');
          },
        },
      },
      { restoreOnStart: false },
      async ({ control }) => {
        const listed = await control.listSessions(fixtureWorkspaceId);

        expect(listed.length).toBeGreaterThan(0);
        expect(listed.every((s) => s.lastActive === undefined && s.blank === undefined)).toBe(true);
      },
    );
  });

  it('readSessionFacets 采集 header 的 origin（D46：零新依赖即可对齐 subagent 隐藏）', async () => {
    const query: SessionQueryLike = {
      readTitleSnapshots: async (ids) =>
        ids.map((sessionId) => ({
          sessionId: SessionId(sessionId),
          status: 'fulfilled' as const,
          value: {
            session: { cwd: '/tmp/x', createdAt: 7, origin: 'subagent' as const },
            title: { title: '子会话' },
          },
        })),
    };

    const facets = await readSessionFacets(query, ['s-1']);

    expect(facets.get('s-1')?.origin).toBe('subagent');
    expect(facets.get('s-1')?.title).toBe('子会话');
  });

  // ────── D48：会话当前模型的权威读取（真机 bug：/模型 切换成功后 /思考 仍显示旧模型） ──────
  //
  // 用户报告（2026-09-16）：`/模型 opencode-go/deepseek-flash` 回执成功、WebUI 已生效，
  // 但 `/思考` 仍报 `aliyun-token-plan / deepseek-v4.1-flash`。
  // 根因：`resolveModelSelection` 把 `agent.options`（**会话创建时**的配置）当第一优先，
  // 而官方 `/模型` 切换走 `agents.selectForNextRequest()`——它把选择 append 成
  // `model/selection` 事件并写进 `modelSelection` 投影，**不更新 `options`**
  // （`dsh-api-session-controller/lib/index.js:315-318`）。
  // 官方读法（同文件 `:282-295`）：投影 `pending` → 会话请求头 → 部署默认。

  it('D48：模型取自 modelSelection 投影 pending，压过会话创建时的 options（真机 bug 回归）', async () => {
    // 造一个「options 说旧模型」的 live Agent（精确复现真机里的陈旧来源）
    const staleOptionsAgent = new Proxy(fixtureAgent as Agent, {
      get(target, prop, receiver) {
        if (prop === 'options') return { provider: 'aliyun-token-plan', model: 'deepseek-v4.1-flash' };
        return Reflect.get(target, prop, receiver);
      },
    });
    const agentsWithStaleOptions: AgentRegistryLike = new Proxy(agents(), {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (id: SessionId): Agent | undefined =>
            String(id) === fixtureSessionId ? staleOptionsAgent : target.get(id);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const projections: SessionProjectionsLike = {
      stateOf: (_session: Session, key: 'turnBoundary' | 'modelSelection') => {
        if (key === 'modelSelection') {
          return { lastUsed: null, pending: { provider: 'opencode-go', model: 'deepseek-flash' } };
        }
        return undefined;
      },
      snapshot: (session, keys) =>
        requireService<SessionProjectionsLike>(ctxHost, 'sessionProjections').snapshot(session, keys),
    };

    await withService(
      { agents: agentsWithStaleOptions, sessionProjections: projections },
      { restoreOnStart: false },
      async ({ control }) => {
        await control.setTarget('u-d48', fixtureSessionId);
        const status = await control.status('u-d48');

        // 必须显示**投影里的新模型**；若退回读 `options` 会得到 aliyun-token-plan / deepseek-v4.1-flash
        expect(status?.model).toBe('opencode-go / deepseek-flash');
      },
    );
  });

  it('D48：modelSelection 投影未注册/抛错时安静降级（不回落到陈旧 options，也不报错）', async () => {
    await withService(
      {
        sessionProjections: {
          stateOf: (_session: Session, key: 'turnBoundary' | 'modelSelection') => {
            if (key === 'modelSelection') throw new Error('modelSelection projection is not registered');
            return undefined;
          },
          snapshot: (session, keys) =>
            requireService<SessionProjectionsLike>(ctxHost, 'sessionProjections').snapshot(session, keys),
        },
      },
      { restoreOnStart: false },
      async ({ control }) => {
        await control.setTarget('u-d48b', fixtureSessionId);
        const status = await control.status('u-d48b');

        // 不抛错即可；取值来自会话请求头或部署默认（此装配下两者都可用）
        expect(status).toBeDefined();
        expect(typeof status?.model).toBe('string');
      },
    );
  });

  // ────────────── D19：setWorkspace 清空控制目标（可失败断言） ────────────────

  it('D19：setWorkspace 清空控制目标并保留工作区作用域', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      const taken = await control.setTarget('u-d19', fixtureSessionId);
      expect(taken).toEqual({ ok: true, sessionId: fixtureSessionId });
      expect((await control.getTarget('u-d19')).sessionId).toBe(fixtureSessionId);

      await control.setWorkspace('u-d19', fixtureWorkspaceId);

      const after = await control.getTarget('u-d19');
      // ← 关键可失败断言：切换工作区必须进入未选中态
      expect(after.sessionId).toBeNull();
      expect(after.workspaceId).toBe(fixtureWorkspaceId);
    });
  });

  it('D19：setWorkspace 传未注册工作区 id 时失败必吵（ControlInputError）', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      await expect(control.setWorkspace('u-d19-bad', 'ws-does-not-exist')).rejects.toBeInstanceOf(
        ControlInputError,
      );
    });
  });

  // ─────────────── E12-A / D30：优先复用 live agent ───────────────

  it('E12-A：agents.get 同进程返回同一 live 实例；接管不触发 resume/create', async () => {
    expect(agents().get(SessionId(fixtureSessionId))).toBe(fixtureAgent);

    let resumeCalls = 0;
    let createCalls = 0;
    const spyAgents: AgentRegistryLike = new Proxy(agents(), {
      get(target, prop, receiver) {
        if (prop === 'resume') {
          return async (_options: ResumeAgentOptions): Promise<AgentHandle> => {
            resumeCalls += 1;
            throw new Error('不该 resume：live agent 已可由 agents.get 复用');
          };
        }
        if (prop === 'create') {
          return async (_options: CreateAgentOptions): Promise<AgentHandle> => {
            createCalls += 1;
            throw new Error('不该 create');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await withService({ agents: spyAgents }, { restoreOnStart: false }, async ({ control }) => {
      const result = await control.setTarget('u-reuse', fixtureSessionId);
      expect(result).toEqual({ ok: true, sessionId: fixtureSessionId });
    });

    expect(resumeCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  // ─────────────── E12-B / D30：锁冲突立即如实回执（可失败断言） ───────────────

  it('D30/E12-B：锁冲突 → 立即如实回执、resume 仅尝试一次、绝不 agents.create', async () => {
    const createCalls: CreateAgentOptions[] = [];
    let resumeCalls = 0;
    let resumeErrorName: string | undefined;
    let resumeErrorMessage: string | undefined;

    // 模拟跨进程：本进程 registry 看不到该会话 → 必须走真实 resume（真实排他锁错误）
    const lockedAgents: AgentRegistryLike = {
      get: () => undefined,
      resume: async (options: ResumeAgentOptions): Promise<AgentHandle> => {
        resumeCalls += 1;
        try {
          return await agents().resume(options);
        } catch (err) {
          resumeErrorName = err instanceof Error ? err.name : undefined;
          resumeErrorMessage = errorMessage(err);
          throw err;
        }
      },
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        createCalls.push(options);
        throw new Error('契约违规：锁冲突时不得调用 agents.create（D30/E12-B）');
      },
    };

    await withService({ agents: lockedAgents }, { restoreOnStart: false }, async ({ control }) => {
      const result = await control.setTarget('u-lock', fixtureSessionId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('locked');
      expect(result.reason).toContain('正被占用');
      // 目标不得被写入
      expect((await control.getTarget('u-lock')).sessionId).toBeNull();
    });

    // ← 关键可失败断言：绝不降级新建空会话
    expect(createCalls).toHaveLength(0);
    // 已取消退避重试（E12-B：13ms 即硬失败，盲重试无意义）→ 只尝试一次
    expect(resumeCalls).toBe(1);
    // 真实错误名校准（D30 错误匹配依据）
    expect(resumeErrorName).toBe('SessionAlreadyOwnedError');
    expect(resumeErrorMessage).toContain('is already owned by an active write handle');
    expect(isSessionAlreadyOwned(new Error(resumeErrorMessage))).toBe(true);
  });

  // ─────────────── D28：持久化 + 启动自动恢复 ───────────────

  it('D28：控制目标持久化，重开服务后自动恢复并复用 live agent', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      expect(await control.setTarget('u-d28', fixtureSessionId)).toEqual({
        ok: true,
        sessionId: fixtureSessionId,
      });
    });

    // 重新打开（模拟插件重启）：默认 restoreOnStart=true
    const reopened = await openControlService(realDeps());
    try {
      const entry = reopened.restore.targets.find((item) => item.openid === 'u-d28');
      expect(entry).toBeDefined();
      expect(entry?.takeover).toEqual({ ok: true, sessionId: fixtureSessionId });
      expect(await reopened.control.getTarget('u-d28')).toEqual({
        workspaceId: fixtureWorkspaceId,
        sessionId: fixtureSessionId,
      });
      // 恢复时优先复用 live agent，不重复 resume（未新增自有句柄）
      expect(agents().get(SessionId(fixtureSessionId))).toBe(fixtureAgent);
    } finally {
      await reopened.dispose();
    }
  });

  // ─────────────── D29：归档 / 不存在 → 自动清空 + 告知 ───────────────

  it('D29：目标被归档 → validateTarget 自动清空并返回告知文本', async () => {
    const direction = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't3-arch-')));
    const workspace = await registry().create(direction, 't3-arch-ws');
    const sid = `session-${Date.now()}-arch`;
    const handle = await agents().create({ sessionId: SessionId(sid), meta: { cwd: workspace.path } });
    await workspace.attachSession(SessionId(sid));

    try {
      await withService({}, { restoreOnStart: false }, async ({ control }) => {
        expect((await control.setTarget('u-arch', sid)).ok).toBe(true);
        await registry().archiveSession(SessionId(sid));

        const verdict = await control.validateTarget('u-arch');
        expect(verdict.valid).toBe(false);
        expect(verdict.notice).toContain('归档');
        expect((await control.getTarget('u-arch')).sessionId).toBeNull();

        // 归档会话不可再被接管
        const retake = await control.setTarget('u-arch-2', sid);
        expect(retake.ok).toBe(false);
        if (!retake.ok) expect(retake.code).toBe('archived');
      });
    } finally {
      await handle.dispose().catch(() => undefined);
      await fsp.rm(direction, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('D29：持久化目标指向不存在的会话 → validateTarget 自动清空并告知', async () => {
    // 直接写入持久化记录，模拟「重启前目标存在、重启后已被删除」
    // 注：`openTargetStore` 的入参是**带 storageDomain 的 ctx 形对象**（见 src/dsh/target-store.ts:96），
    //     此处修正实参形状（T3 收尾前失活遗留）；断言语义未改动。
    const store = await openTargetStore({
      storageDomain: requireService<ControlContext['storageDomain']>(ctxHost, 'storageDomain'),
    });
    const ghost: ControlTarget = { workspaceId: fixtureWorkspaceId, sessionId: 'session-ghost-not-exist' };
    await store.store.put('u-ghost', ghost);
    await store.close();

    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      const verdict = await control.validateTarget('u-ghost');
      expect(verdict.valid).toBe(false);
      expect(verdict.notice).toContain('不存在');
      expect((await control.getTarget('u-ghost')).sessionId).toBeNull();
    });
  });

  it('agentPreset：新建 agent 时挂载 preset（否则会话只有全局工具，真机实测教训）', async () => {
    // 真机验收暴露：web profile 里 tool-bash/tool-pwsh/tool-jobs 均 `disabled: true`，
    // 它们由 agent preset 按会话挂载；控制层不 mount 时，新会话只剩全局工具
    // （模型如实报告"我只有 send_file/send_image，没有 bash/写入"）。
    //
    // D52 追加：`resolve()` 解析出的 id 必须**同时**用于 ① `meta.agentPreset`（会话记录，
    // WebUI 预设标签的唯一判据）② `mount(agentCtx, id)`（真正挂载的组合）。二者分叉就是 bug。
    // 本用例只断言「控制层把 id 传对了」；「header / 投影 / 实际组合三者同号」由
    // tests/contract/dsh-agent-preset.test.ts 在真挂 agent-presets 的装配上验证。
    const mounted: Array<string | undefined> = [];
    const resolved: Array<string | undefined> = [];
    const fakePresets: AgentPresetsLike = {
      resolve: async (id?: string): Promise<{ id: string }> => {
        resolved.push(id);
        return { id: 'test-preset' };
      },
      mount: async (agentCtx: unknown, id?: string): Promise<{ id: string }> => {
        mounted.push(id);
        void agentCtx;
        return { id: 'test-preset' };
      },
      serviceFor: () => undefined,
    };

    const createArgs: CreateAgentOptions[] = [];
    const recordingAgents: AgentRegistryLike = new Proxy(agents(), {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return async (options: CreateAgentOptions): Promise<AgentHandle> => {
            createArgs.push(options);
            return target.create(options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await withService(
      { agentPresets: fakePresets, agents: recordingAgents },
      { restoreOnStart: false, homeDir: workRoot },
      async ({ control }) => {
        const created = await control.createSession('u-preset', 'preset-ws');
        expect(created.ok).toBe(true);
        // 真实 agents.create 会调用我们的 setup(agentCtx) → 必须触发一次 mount
        expect(mounted.length).toBeGreaterThanOrEqual(1);
      },
    );

    // ① 解析：无参 resolve = 部署默认
    expect(resolved).toEqual([undefined]);
    // ② 记录：`meta.agentPreset` 就是 resolve 出来的 id（不写 ⇒ WebUI 标签 return null）
    expect(createArgs).toHaveLength(1);
    expect((createArgs[0] as { meta?: { agentPreset?: string } }).meta?.agentPreset).toBe('test-preset');
    // ③ 挂载：同一个 id（记录与实际不得分叉；全 undefined 说明退回"无条件默认"）
    expect(mounted).toEqual(['test-preset']);
  });

  // ─────────────── D7：忙时 steer、空闲时 followup ───────────────

  it('D7：忙（turnBoundary.openTurnStartSeq !== null）→ steer；空闲 → followup', async () => {
    const calls: string[] = [];
    let busySeq: number | null = null;

    const spyAgent: Agent = new Proxy(fixtureAgent, {
      get(target, prop, receiver) {
        if (prop === 'steer') {
          return (_message: UserMessage): void => {
            calls.push('steer');
          };
        }
        if (prop === 'followup') {
          return (_message: UserMessage): void => {
            calls.push('followup');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spyAgents: AgentRegistryLike = new Proxy(agents(), {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (id: SessionId): Agent | undefined => {
            const live = target.get(id);
            return live === undefined ? undefined : spyAgent;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const projections: SessionProjectionsLike = {
      stateOf: (_session: Session, _key: 'turnBoundary') => ({
        openTurnStartSeq: busySeq as Session['id'] extends never ? never : never,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: busySeq === null ? 0 : 1,
      }),
      snapshot: (session, keys) =>
        requireService<SessionProjectionsLike>(ctxHost, 'sessionProjections').snapshot(session, keys),
    };

    await withService(
      { agents: spyAgents, sessionProjections: projections },
      { restoreOnStart: false },
      async ({ control }) => {
        expect((await control.setTarget('u-send', fixtureSessionId)).ok).toBe(true);

        busySeq = null;
        const idleSend = await control.send('u-send', '空闲消息');
        expect(idleSend).toEqual({ ok: true, mode: 'followup' });

        busySeq = 7;
        const busySend = await control.send('u-send', '繁忙插话');
        expect(busySend).toEqual({ ok: true, mode: 'steer' });
      },
    );

    expect(calls).toEqual(['followup', 'steer']);
    // 真实 followup/steer 已被告替身拦截：真实投影仍为「无未结束 turn」
    expect(
      requireService<SessionProjectionsLike>(ctxHost, 'sessionProjections').stateOf(
        fixtureAgent.session,
        'turnBoundary',
      )?.openTurnStartSeq,
    ).toBeNull();
  });

  // ─────────────── D24 / D25 / D26：/新建 ───────────────

  it('D24/D25/D26：createSession 递归建目录+注册工作区+自动命名+立即成为目标+不写初始值', async () => {
    const createArgs: CreateAgentOptions[] = [];
    const renameCalls: string[] = [];

    const recordingAgents: AgentRegistryLike = new Proxy(agents(), {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return async (options: CreateAgentOptions): Promise<AgentHandle> => {
            createArgs.push(options);
            return target.create(options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const titleSpy: SessionTitleLike | undefined =
      optional.sessionTitle === undefined
        ? undefined
        : new Proxy(optional.sessionTitle, {
            get(target, prop, receiver) {
              if (prop === 'rename') {
                return (_session: unknown, title: string): never => {
                  renameCalls.push(title);
                  throw new Error('D26 违规：不得调用 sessionTitle.rename');
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });

    await withService(
      {
        agents: recordingAgents,
        ...(titleSpy ? { sessionTitle: titleSpy } : {}),
      },
      { restoreOnStart: false, homeDir: workRoot },
      async ({ control }) => {
        // 相对路径基准 = homeDir（生产默认 $HOME）
        const created = await control.createSession('u-new', 'proj/sub');
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.createdDir).toBe(true);
        expect(created.createdWorkspace).toBe(true);
        expect(created.sessionId).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(fs.existsSync(path.join(workRoot, 'proj', 'sub'))).toBe(true);
        expect(created.workspaceId).toBe(
          String(
            (await registry().resolveByPath(path.join(workRoot, 'proj', 'sub')))?.id,
          ),
        );

        // D25：创建后立即成为控制目标
        expect((await control.getTarget('u-new')).sessionId).toBe(created.sessionId);
        // 新会话已挂载到工作区（列表可见）
        const listed = await control.listSessions(created.workspaceId);
        expect(listed.map((item) => item.sessionId)).toContain(created.sessionId);

        // D26 **真机更正**（2026-09-15，由用户在真机验收中暴露）：
        //   原断言「调用参数里没有 agentOptions」把 D26 过度字面化了。
        //   不传 agentOptions 会让会话没有模型，DSH 的 persona-prefix 装配直接失败：
        //     prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
        //   D26 的本意是「插件不维护**自有**模型状态」——读官方默认再传给 agent 正是合规做法。
        //   故此处改为**更强**的断言：agentOptions 的 provider/model 必须与官方
        //   `agentDefaultModel.currentSelection()` 逐字一致（证明数值来自官方、而非插件自造）。
        expect(createArgs).toHaveLength(1);
        const createArg0 = createArgs[0] as { agentOptions?: { provider?: string; model?: string } };
        const officialSelection = optional.agentDefaultModel?.currentSelection();
        if (officialSelection?.provider && officialSelection?.model) {
          expect(createArg0.agentOptions?.provider).toBe(officialSelection.provider);
          expect(createArg0.agentOptions?.model).toBe(officialSelection.model);
        } else {
          // 官方无默认选择时才允许缺席（此时 DSH 只能用自己的兜底）
          expect('agentOptions' in createArg0).toBe(false);
        }
        // 标题交 DSH 自动命名：绝不调 sessionTitle.rename
        expect(renameCalls).toHaveLength(0);

        // 二次在同一路径新建：复用已注册工作区与已存在目录
        const again = await control.createSession('u-new-2', 'proj/sub');
        expect(again.ok).toBe(true);
        if (again.ok) {
          expect(again.createdWorkspace).toBe(false);
          expect(again.createdDir).toBe(false);
        }
      },
    );
  });

  it('D24：路径存在但是文件 → exists-as-file 如实报错，不创建会话', async () => {
    const filePath = path.join(workRoot, 'this-is-a-file.txt');
    await fsp.writeFile(filePath, 'x', 'utf8');

    await withService({}, { restoreOnStart: false, homeDir: workRoot }, async ({ control }) => {
      const result = await control.createSession('u-file', 'this-is-a-file.txt');
      expect(result).toEqual({
        ok: false,
        code: 'exists-as-file',
        reason: expect.stringContaining('文件'),
      });
      expect((await control.getTarget('u-file')).sessionId).toBeNull();
    });
  });

  it('D24：无路径参数且无工作区作用域 → register-failed 如实回报（不假成功）', async () => {
    await withService({}, { restoreOnStart: false, homeDir: workRoot }, async ({ control }) => {
      const result = await control.createSession('u-noscope');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('register-failed');
        expect(result.reason).toContain('工作区作用域');
      }
    });
  });

  it('D36：无路径参数 + 无作用域 + 配了默认工作区 → 惰性建目录+注册工作区+立即成为控制目标', async () => {
    const fallback = path.join(workRoot, 'nested', 'default');
    expect(fs.existsSync(fallback)).toBe(false);

    await withService(
      {},
      { restoreOnStart: false, homeDir: workRoot, defaultWorkspacePath: fallback },
      async ({ control }) => {
        const result = await control.createSession('u-default');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // 惰性：首次真正用到时才 mkdir -p（不让"装完插件就留空目录"发生）
        expect(result.createdDir).toBe(true);
        expect(result.createdWorkspace).toBe(true);
        expect(fs.statSync(fallback).isDirectory()).toBe(true);

        const workspace = await control.getWorkspace(result.workspaceId);
        expect(workspace?.path).toBe(fallback);
        const target = await control.getTarget('u-default');
        expect(target.sessionId).toBe(result.sessionId);
        expect(target.workspaceId).toBe(result.workspaceId);
        // 新会话的 cwd 就是该默认工作区（不落到用户主目录）
        const session = (await control.listSessions(result.workspaceId)).map((s) => s.sessionId);
        expect(session).toContain(result.sessionId);
      },
    );
  });

  it('D36：已有工作区作用域时，无参数 /新建 落在**作用域工作区**（默认工作区不参与）', async () => {
    const fallback = path.join(workRoot, 'should-not-be-used');
    await withService(
      {},
      { restoreOnStart: false, homeDir: workRoot, defaultWorkspacePath: fallback },
      async ({ control }) => {
        await control.setWorkspace('u-scoped', fixtureWorkspaceId);
        const result = await control.createSession('u-scoped');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.workspaceId).toBe(fixtureWorkspaceId);
        expect(fs.existsSync(fallback)).toBe(false);
      },
    );
  });

  // ────────────── D32：/状态 全字段 ───────────────

  it('D32：status 取模型/思考/权限/用量/忙闲（全部来自官方服务）', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      expect((await control.setTarget('u-status', fixtureSessionId)).ok).toBe(true);

      const status = await control.status('u-status');
      expect(status).toBeDefined();
      if (status === undefined) return;
      expect(status.sessionId).toBe(fixtureSessionId);
      expect(status.workspaceTitle).toBe('t3-control-ws');
      expect(status.workspacePath).toBe(workRoot);
      expect(status.busy).toBe(false);
      expect(typeof status.model).toBe('string');
      expect((status.model ?? '').length).toBeGreaterThan(0);
      expect(typeof status.contextTokens).toBe('number');
      expect(status.contextTokens ?? -1).toBeGreaterThanOrEqual(0);
      if (optional.permissionPresets !== undefined) {
        expect(status.permissionPreset).toBe(optional.permissionPresets.current(fixtureAgent.session));
        expect((status.permissionPreset ?? '').length).toBeGreaterThan(0);
      }
    });
  });

  // ─────────────── 寻址在工作区枚举上的真实装配路径 ───────────────

  it('D23：resolveWorkspace 在真实注册表上按 path 精确/标题模糊命中', async () => {
    await withService({}, { restoreOnStart: false }, async ({ control }) => {
      expect((await control.resolveWorkspace(workRoot))?.id).toBe(fixtureWorkspaceId);
      expect((await control.resolveWorkspace('t3-control-ws'))?.id).toBe(fixtureWorkspaceId);
      expect((await control.getWorkspace(fixtureWorkspaceId))?.path).toBe(workRoot);
      expect(await control.resolveWorkspace('不存在的名字')).toBeUndefined();
    });
  });
});

// ══════════════════ 跨进程重启：D28 自动恢复并 resume ══════════════════

describe('T3 启动恢复（跨进程重启）', () => {
  it('D28：重启后读取持久化目标并 resume 该会话（同进程 live 复用之外的路径）', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 't3-restore-home-'));
    const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    for (const name of ['settings.yaml', '.credentials.yaml']) {
      const src = path.join(realHome, name);
      if (fs.existsSync(src)) {
        await fsp.copyFile(src, path.join(home, name));
        await fsp.chmod(path.join(home, name), 0o600).catch(() => undefined);
      }
    }
    const direction = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't3-restore-ws-')));
    const sid = `session-${Date.now()}-restore`;

    let first: BootedDsh | undefined;
    try {
      first = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
      const hostA = first.ctx as object;
      const registryA = requireService<WorkspaceRegistryProbe>(hostA, 'workspaceRegistry');
      const agentsA = requireService<AgentRegistryLike>(hostA, 'agents');
      const workspace = await registryA.create(direction, 't3-restore-ws');
      const handle = await agentsA.create({ sessionId: SessionId(sid), meta: { cwd: workspace.path } });
      await workspace.attachSession(SessionId(sid));

      const opened = await openControlService({
        workspaceRegistry: registryA,
        agents: agentsA,
        sessionProjections: requireService<SessionProjectionsLike>(hostA, 'sessionProjections'),
        storageDomain: requireService<ControlContext['storageDomain']>(hostA, 'storageDomain'),
        tokenMeter: requireService<TokenMeterLike>(hostA, 'tokenMeter'),
        ...readOptionalServices(hostA),
        logger: silentLogger,
      }, { restoreOnStart: false });
      expect((await opened.control.setTarget('u-restore', sid)).ok).toBe(true);
      await opened.dispose();
      await handle.dispose();
    } finally {
      await first?.dispose().catch(() => undefined);
    }

    // 进程 B：同一 DSH_HOME，会话不在内存 registry 中 → 只能靠持久化恢复 + resume
    let second: BootedDsh | undefined;
    try {
      second = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
      const hostB = second.ctx as object;
      const agentsB = requireService<AgentRegistryLike>(hostB, 'agents');
      expect(agentsB.get(SessionId(sid))).toBeUndefined();

      const reopened = await openControlService({
        workspaceRegistry: requireService<WorkspaceRegistryProbe>(hostB, 'workspaceRegistry'),
        agents: agentsB,
        sessionProjections: requireService<SessionProjectionsLike>(hostB, 'sessionProjections'),
        storageDomain: requireService<ControlContext['storageDomain']>(hostB, 'storageDomain'),
        tokenMeter: requireService<TokenMeterLike>(hostB, 'tokenMeter'),
        ...readOptionalServices(hostB),
        logger: silentLogger,
      });
      try {
        const entry = reopened.restore.targets.find((item) => item.openid === 'u-restore');
        expect(entry?.takeover).toEqual({ ok: true, sessionId: sid });
        // 真的 resume 了：会话在 B 进程变为 live
        expect(agentsB.get(SessionId(sid))).toBeDefined();
        expect((await reopened.control.getTarget('u-restore')).sessionId).toBe(sid);
      } finally {
        await reopened.dispose();
      }
    } finally {
      await second?.dispose().catch(() => undefined);
      await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(direction, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 300_000);
});