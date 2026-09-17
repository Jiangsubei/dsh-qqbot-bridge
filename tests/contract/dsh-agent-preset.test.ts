/**
 * 契约测试：**agent preset 的会话记录与接管复原**（D52）——在真实 DSH 装配上跑。
 *
 * 背景（用户 2026-09-17 报告的真机 bug）：QQ 侧 `/新建` 出的会话**继承了部署默认 preset 的组合**
 * （`agentSetup()` 挂了 `presets.mount(agentCtx)`），但 WebUI 的会话标题旁**根本不显示预设**。
 *
 * 根因（官方源码逐条可引，非推断）：
 *   - 官方建会话路径先解析 preset 再写进会话创建元数据：
 *     `dsh-api-session-controller/lib/index.js:355-361` → `meta: { cwd, agentPreset: resolvedId }`；
 *   - 该字段落到 **durable header**：`dsh-session/lib/index.js:1402`（`meta.agentPreset`），
 *     `dsh-agent/lib/types/index.d.ts:64-72`（`CreateAgentOptions.meta.agentPreset`）；
 *   - 而 WebUI 的预设标签**只读 `agentPreset` 投影**：
 *     `dsh-client-ui-agent-preset/lib/client.js:191`（`projectionValues?.agentPreset`）、
 *     `:196`（`preset === undefined` → `return null`）；该投影 `init = header.agentPreset ?? null`
 *     （`dsh-agent-presets/lib/index.js:1074`）。
 *   ⇒ 桥接此前只传 `meta: { cwd }`，于是组合对、**记录缺席**、WebUI 无标签可显示。
 *
 * 为什么必须真实装配：本用例**不造 preset 桩**——真挂 `@deepseek-ai/dsh-agent-presets`
 * （`includeShippedRoot: false` + 两个 fixture preset），断言三条互相独立的真值：
 *   ① durable header；② `agentPreset` 投影（= WebUI 唯一判据）；③ `composedPreset(agent.ctx)`
 *      （= 真正挂上去的组合）。三者必须**同号**，否则「记录与实际分叉」。
 *
 * fixture preset 的正文**逐字照抄** `tests/contract/dsh-compaction-plane.test.ts` 已验证可在
 * base-only 装配里挂载成功的最小组合（为什么不用 shipped `standard`：它还挂 tool-subagent 等重行，
 * base-only 测试环境缺对应 host 服务，会因「有不可用行」被官方 mount 拒绝）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

import { SessionId } from '@deepseek-ai/dsh-session';

import { bootDshQqbotBridge, type BootedDsh } from '../../src/boot.js';
import { openControlService, type ControlContext } from '../../src/dsh/control.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 只取本用例用到的面（显式结构读，不做 `as any` 兜底） */
interface AgentProbe {
  session: { header: { agentPreset?: string }; id: unknown };
  ctx: unknown;
}
interface HandleProbe {
  agent: AgentProbe;
  dispose(): Promise<void>;
}
interface CtxProbe {
  get(name: string): unknown;
  agents: {
    get(id: unknown): AgentProbe | undefined;
    create(options: {
      sessionId: unknown;
      meta?: { cwd?: string; agentPreset?: string };
      setup?: (agentCtx: unknown, agent: AgentProbe) => Promise<void> | void;
    }): Promise<HandleProbe>;
  };
  sessionProjections: { stateOf(session: unknown, key: string): unknown };
  agentPresets: {
    /** 官方 `resolve(id?)`：`id` 缺省即部署默认 */
    resolve(id?: string): Promise<{ id: string }>;
    mount(agentCtx: unknown, id?: string): Promise<{ id: string }>;
    /** 官方 `composedPreset(agentCtx)`：该 live agent 真正加入的 preset id（读 scope 链） */
    composedPreset(agentCtx: unknown): string | undefined;
  };
}

describe('契约：agent preset 的会话记录与接管复原（真实 DSH 装配）', () => {
  let booted: BootedDsh;
  let home: string;
  let workRoot: string;
  let fixtureRoot: string;
  let ctx: CtxProbe;

  const DEFAULT_PRESET = 'qqbot-preset-alpha';
  const OTHER_PRESET = 'qqbot-preset-beta';

  /** 与 compaction-plane 用例同源的最小可挂载组合（见文件头注释） */
  async function writeFixturePreset(root: string, id: string, name: string): Promise<void> {
    const dir = path.join(root, id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'preset.yml'),
      [`name: ${name}`, `description: D52 契约测试 fixture（${id}）`, 'order: 99', ''].join('\n'),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'agent.cordis.yml'),
      [
        '- id: compaction',
        '  name: cordis:group',
        '  group: true',
        '  isolate:',
        '    compaction: true',
        '    toolResultPruner: true',
        '  config:',
        '    - id: compaction-basic',
        "      name: '@deepseek-ai/dsh-compaction-basic'",
        '',
        '    - id: command-compact',
        "      name: '@deepseek-ai/dsh-command-compact'",
        '',
        '    - id: tool-result-pruner',
        "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
        '      config:',
        '        thresholdChars: 8192',
        '        headChars: 4096',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  /** 控制层依赖：全部来自**真实 ctx**，只注入 preset 相关的结构面读法 */
  function deps(): ControlContext {
    const read = <T>(key: string): T => {
      const value = ctx.get(key);
      if (value === undefined) throw new Error(`真实装配缺少服务：${key}`);
      return value as T;
    };
    return {
      workspaceRegistry: read<ControlContext['workspaceRegistry']>('workspaceRegistry'),
      agents: read<ControlContext['agents']>('agents'),
      sessionProjections: read<ControlContext['sessionProjections']>('sessionProjections'),
      storageDomain: read<ControlContext['storageDomain']>('storageDomain'),
      sessionQuery: read<ControlContext['sessionQuery']>('sessionQuery'),
      agentPresets: read<ControlContext['agentPresets']>('agentPresets'),
      logger: silentLogger,
    };
  }

  async function openControl() {
    return openControlService(deps(), {
      restoreOnStart: false,
      homeDir: workRoot,
      defaultWorkspacePath: path.join(workRoot, 'default-ws'),
    });
  }

  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 't-preset-home-'));
    workRoot = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't-preset-ws-')));
    fixtureRoot = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't-preset-root-')));
    await writeFixturePreset(fixtureRoot, DEFAULT_PRESET, 'D52 默认 fixture');
    await writeFixturePreset(fixtureRoot, OTHER_PRESET, 'D52 备选 fixture');

    booted = await bootDshQqbotBridge({
      dshHome: home,
      mountPlugin: false,
      extraPatches: [
        {
          insert: [
            {
              id: 'agent-presets',
              name: '@deepseek-ai/dsh-agent-presets',
              // patch 是「整段替换 config」⇒ 四个字段都要给
              config: {
                default: DEFAULT_PRESET,
                roots: [{ path: fixtureRoot, trust: 'user' }],
                includeShippedRoot: false,
                includeUserRoot: false,
              },
            },
          ],
        },
      ],
    });
    ctx = booted.ctx as unknown as CtxProbe;

    // 前置断言：装配真的按 fixture 配置生效（否则后面全是假绿）
    const roster = await (ctx.get('agentPresets') as { list(): Promise<Array<{ id: string }>> }).list();
    expect(roster.map((preset) => preset.id).sort()).toEqual([DEFAULT_PRESET, OTHER_PRESET].sort());
  }, 300_000);

  afterAll(async () => {
    await booted?.dispose().catch(() => undefined);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  /** 真值三连：durable header / 投影（WebUI 判据）/ 实际组合，必须同号 */
  function expectPresetTriplet(sessionId: string, expected: string): void {
    const agents = (ctx.get('agents') as CtxProbe['agents']);
    const live = agents.get(SessionId(sessionId));
    expect(live).toBeDefined();
    if (live === undefined) return;
    // ① durable header（`dsh-session/lib/index.js:1402`）
    expect(live.session.header.agentPreset).toBe(expected);
    // ② `agentPreset` 投影 —— WebUI 标签唯一读的就是它（`dsh-client-ui-agent-preset/lib/client.js:191`）
    expect(ctx.sessionProjections.stateOf(live.session, 'agentPreset')).toBe(expected);
    // ③ 真正挂上去的组合（读 scope 链，不是读我们自己的字段）
    expect((ctx.get('agentPresets') as CtxProbe['agentPresets']).composedPreset(live.ctx)).toBe(expected);
  }

  it('A：`/新建` 必须把默认 preset 写进会话记录（header + agentPreset 投影），且挂载的是同一个 id', async () => {
    const opened = await openControl();
    try {
      const created = await opened.control.createSession('openid-preset-a');
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // ← 关键可失败断言：修前 header/投影**都是缺席**（真机 476b802c / 9d1504c8 实测）
      expectPresetTriplet(created.sessionId, DEFAULT_PRESET);
    } finally {
      await opened.dispose();
    }
  });

  it('B：接管**冷会话**时按会话记录的 preset 复原组合，而不是部署默认', async () => {
    const agents = ctx.get('agents') as CtxProbe['agents'];
    const presets = ctx.get('agentPresets') as CtxProbe['agentPresets'];
    const cwd = fs.realpathSync(await fsp.mkdtemp(path.join(workRoot, 'beta-')));
    const sid = `session-${Date.now()}-preset-beta`;

    // 造一个「部署默认 = alpha、但会话自己记录为 beta」的会话（= WebUI 上用 hero chip 选过 beta 的会话）
    const handle = await agents.create({
      sessionId: SessionId(sid),
      meta: { cwd, agentPreset: OTHER_PRESET },
      setup: (agentCtx) => presets.mount(agentCtx, OTHER_PRESET).then(() => undefined),
    });
    expect(presets.composedPreset(handle.agent.ctx)).toBe(OTHER_PRESET);

    // 变冷：dispose 会 unregister agent（`dsh-agent/lib/types/index.d.ts:163-164`）
    await handle.dispose();
    expect(agents.get(SessionId(sid))).toBeUndefined();

    const workspace = await (
      ctx.get('workspaceRegistry') as { create(p: string, t?: string): Promise<{ attachSession(id: unknown): Promise<void> }> }
    ).create(cwd, 't-preset-beta-ws');
    await workspace.attachSession(SessionId(sid));

    const opened = await openControl();
    try {
      const taken = await opened.control.setTarget('openid-preset-b', sid);
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;

      const resumed = agents.get(SessionId(sid));
      expect(resumed).toBeDefined();
      // ← 关键可失败断言：修前这里会是 alpha（`agentSetup()` 无条件挂默认）
      expect(presets.composedPreset(resumed?.ctx)).toBe(OTHER_PRESET);
    } finally {
      await opened.dispose();
    }
  });

  it('C：会话未记录 preset（老会话 / 无 preset 部署）→ 按官方 `composeAgent(undefined)` 语义落部署默认', async () => {
    const agents = ctx.get('agents') as CtxProbe['agents'];
    const presets = ctx.get('agentPresets') as CtxProbe['agentPresets'];
    const cwd = fs.realpathSync(await fsp.mkdtemp(path.join(workRoot, 'legacy-')));
    const sid = `session-${Date.now()}-preset-legacy`;

    // 模拟修前的桥接会话：组合挂上了，但 header 没有 agentPreset
    const handle = await agents.create({
      sessionId: SessionId(sid),
      meta: { cwd },
      setup: (agentCtx) => presets.mount(agentCtx).then(() => undefined),
    });
    expect(handle.agent.session.header.agentPreset).toBeUndefined();
    await handle.dispose();
    expect(agents.get(SessionId(sid))).toBeUndefined();

    const workspace = await (
      ctx.get('workspaceRegistry') as { create(p: string, t?: string): Promise<{ attachSession(id: unknown): Promise<void> }> }
    ).create(cwd, 't-preset-legacy-ws');
    await workspace.attachSession(SessionId(sid));

    const opened = await openControl();
    try {
      const taken = await opened.control.setTarget('openid-preset-c', sid);
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;
      const resumed = agents.get(SessionId(sid));
      expect(presets.composedPreset(resumed?.ctx)).toBe(DEFAULT_PRESET);
    } finally {
      await opened.dispose();
    }
  });
});