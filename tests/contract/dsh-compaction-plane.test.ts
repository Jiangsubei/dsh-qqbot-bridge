/**
 * 契约测试：压缩服务的**平面寻址**（D44）——在**真实 DSH 装配**上复刻 web profile 形状。
 *
 * 复刻要点（全部来自 web profile 的真实接线）：
 *   - host 平面禁用压缩三件套：`dsh-web-app/cordis.patch.yml:427/430/433`；
 *   - 压缩由 agent preset 以 `isolate: { compaction: true }` 的 realm 挂进**每个会话**：
 *     `dsh-agent-presets/presets/standard/agent.cordis.yml:138-153`；
 *   - 因此 realm 内的服务对 host 平面**与 `agent.ctx` 都不可见**，唯一官方读法是
 *     `agentPresets.serviceFor(agent, 'compaction')`（`dsh-agent-presets/lib/types/index.d.ts:311-325`；
 *     生产先例 `dsh-api-session-controller/lib/index.js:2273` 读 `skills`）。
 *
 * 为什么必须有这一条：本功能连续两版实现都被「注入 host 平面 / 伪造 `agent.ctx.get`」的**假测试**
 * 骗过，真机两次失败——AGENTS §3.1「单测全绿 ≠ 装配可达」。这里的每一条断言都跑在真实 cordis
 * isolate realm 上，不做任何桩。
 *
 * 注：本文件**不调用** `compactNow`（那会发起真实 LLM 摘要请求）；引擎是否被触达由
 * `dsh-control.test.ts` 的 `serviceFor` / 反假桩用例把关。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

import { SessionId } from '@deepseek-ai/dsh-session';

import { bootDshQqbotBridge, type BootedDsh } from '../../src/boot.js';
import { openControlService } from '../../src/dsh/control.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 只取本用例用到的面（显式结构读，不做 `as any` 兜底） */
interface CtxProbe {
  get(name: string): unknown;
  agents: {
    create(options: { sessionId: ReturnType<typeof SessionId>; meta: { cwd: string } }): Promise<{
      agent: { ctx: { get(name: string): unknown } };
    }>;
  };
  agentPresets: {
    mount(agentCtx: unknown, id?: string): Promise<unknown>;
    serviceFor(agent: unknown, name: string): unknown;
  };
}

describe('契约：压缩服务的平面寻址（真实 DSH 装配，复刻 web profile 形状）', () => {
  let booted: BootedDsh;
  let home: string;
  let workRoot: string;
  let fixtureRoot: string;

  /** 只含压缩组的**最小 fixture preset**（逐字照抄 `presets/standard/agent.cordis.yml:138-153`）。
   *  为什么不直接用 shipped `standard`：它还会挂 tool-subagent 等重行，base-only 测试环境缺 host 服务。 */
  async function writeCompactionPresetFixture(root: string): Promise<void> {
    const dir = path.join(root, 'qqbot-compaction-fixture');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'preset.yml'),
      ['name: QQ bot 压缩 fixture', 'description: 仅含 compaction 组，用于平面寻址契约测试', 'order: 99', ''].join('\n'),
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

  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 't-plane-home-'));
    workRoot = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't-plane-ws-')));
    fixtureRoot = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 't-plane-presets-')));
    await writeCompactionPresetFixture(fixtureRoot);
    booted = await bootDshQqbotBridge({
      dshHome: home,
      mountPlugin: false,
      // 复刻 web profile：host 平面关掉压缩三件套，改由 agent preset 挂进会话 realm
      extraPatches: [
        { id: 'compaction-basic', disabled: true },
        { id: 'command-compact', disabled: true },
        { id: 'tool-result-pruner', disabled: true },
        {
          insert: [
            {
              id: 'agent-presets',
              name: '@deepseek-ai/dsh-agent-presets',
              // patch 是「整段替换 config」⇒ 四个字段都要给
              config: {
                default: 'qqbot-compaction-fixture',
                roots: [{ path: fixtureRoot, trust: 'user' }],
                includeShippedRoot: false,
                includeUserRoot: false,
              },
            },
          ],
        },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await booted?.dispose().catch(() => undefined);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('host 与 agent.ctx 都读不到压缩；只有 agentPresets.serviceFor 能读到', async () => {
    const ctx = booted.ctx as unknown as CtxProbe;

    // ① 形状锁：host 平面确实没有压缩（= web profile 的真实形状）
    expect(ctx.get('compaction')).toBeUndefined();

    const presets = ctx.agentPresets;
    expect(presets).toBeDefined();
    expect(typeof presets?.serviceFor).toBe('function');

    // ② 真建一个会话，并按插件的 `agentSetup()` 同形把默认 preset（standard）挂到它的 agent
    const sid = SessionId(`session-${Date.now()}-plane`);
    const handle = await ctx.agents.create({ sessionId: sid, meta: { cwd: workRoot } });
    await presets.mount(handle.agent.ctx);

    // ③ 语义锁：realm 内的服务对 **agent 自己的 ctx** 也不可见——这是上一版实现的死路，
    //    伪造 `agent.ctx.get` 的假测试永远测不到这一点。
    expect(handle.agent.ctx.get('compaction')).toBeUndefined();

    // ④ 官方 READ 寻址可用：持 agent 从外部读到该会话 preset realm 内的实例
    const engine = presets.serviceFor(handle.agent, 'compaction') as { compactNow?: unknown } | undefined;
    expect(engine).toBeDefined();
    expect(typeof engine?.compactNow).toBe('function');
  }, 120_000);

  it('控制层在真实 realm 上经 serviceFor 解析到引擎：host 无压缩也不回 unavailable', async () => {
    const ctx = booted.ctx as unknown as CtxProbe & { get(name: string): unknown };
    const registry = ctx.get('workspaceRegistry') as {
      create(path: string, title?: string): Promise<{ id: unknown; attachSession(id: unknown): Promise<void> }>;
    };
    const ws = await registry.create(workRoot, 'plane-ctl-ws');
    const sid = SessionId(`session-${Date.now()}-ctl`);
    const handle = await ctx.agents.create({ sessionId: sid, meta: { cwd: workRoot } });
    await ws.attachSession(sid);
    await ctx.agentPresets.mount(handle.agent.ctx);

    const opened = await openControlService(
      {
        workspaceRegistry: ctx.get('workspaceRegistry') as never,
        agents: ctx.get('agents') as never,
        sessionProjections: ctx.get('sessionProjections') as never,
        storageDomain: ctx.get('storageDomain') as never,
        tokenMeter: ctx.get('tokenMeter') as never,
        // 真实 preset 注册表 + host 平面无压缩（= web profile 形状）
        agentPresets: ctx.agentPresets as never,
        compaction: undefined,
        logger: silentLogger,
      },
      { restoreOnStart: false },
    );
    try {
      const taken = await opened.control.setTarget('u-plane-ctl', String(sid));
      expect(taken.ok).toBe(true);

      const outcome = await opened.control.compact('u-plane-ctl');

      // 引擎已被触达 ⇒ 绝不能是 unavailable（本环境无 LLM 渠道，因此会是
      // ManualCompactionError('summary') 或 null，二者都证明「引擎解析成功并被调用」）
      if (!outcome.ok) expect(outcome.code).not.toBe('unavailable');
    } finally {
      await opened.dispose();
    }
  }, 120_000);
});