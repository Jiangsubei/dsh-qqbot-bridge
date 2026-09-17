#!/usr/bin/env tsx
/**
 * 探针 WEBUI-SYNC：插件新建的会话，**状态是否同步到 WebUI**、**是否会落到侧边栏「未分组」**。
 *
 * 背景（用户提问）：`/新建` 是在插件里用 `ctx.agents.create()` + `workspace.attachSession()`
 * 建的会话，而 WebUI 建会话走的是官方 `sessionController.create()`。
 * 两条路不同，故必须实测「WebUI 那侧收到的数据里，这个会话落在哪个分组」。
 *
 * 本探针**不是**造桩自测：装配层 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
 * （与真实 profile `qqbot-test` 的 `dsh.profile.bundles` 逐字一致），并且真的起 web 服务；
 * 只有 **QQ 开放平台客户端** 被替换为骨头桩（外部网络边界，AGENTS §3.1 允许隔离外部依赖），
 * 因为本探针不涉及任何 QQ 平台语义，只关心 DSH 侧的会话/工作区同步。
 *
 * 观测点（WebUI 浏览器真正消费的就是这些）：
 *   M1 `api-session/added` 帧——浏览器 `ctx.remote.$on("api-session/added")` 据此把会话并入侧边栏列表
 *      （`dsh-api-session-controller/lib/client.js:3507`）。
 *   M2 工作区增量帧——浏览器 `remote.workspace.follow()` 流据此更新
 *      `workspace.sessionIds`（`dsh-api-workspace-controller/lib/client.js:365-367`）。
 *   M3 浏览器分组判据——`owningGroupKey(workspaces, sessionId)`：**会话 id 不出现在任何
 *      `workspace.sessionIds` 里才会落到 `""`（即「未分组」）**
 *      （`dsh-client-ui-workspace/lib/client.js:311-321`、`groupByWorkspace` 同文件 :389-405）。
 *   M4 可见性——`sessionVisible()`：**`blank` 为真且不是当前打开项 → 不渲染**
 *      （`dsh-client-ui-workspace/lib/client.js:337-343`）。若启用 `PROBE_TURN=1`，
 *      本探针会真的跑一个 turn，观测 `api-session/status` 把 `blank` 落为可见的时机。
 *
 * 产物：logs/probe/WEBUI-SYNC-<ts>.jsonl + .summary.json
 * 用法：pnpm tsx scripts/probe-webui-sync.ts          （仅建会话，不跑模型）
 *       PROBE_TURN=1 pnpm tsx scripts/probe-webui-sync.ts  （额外跑一个最小真机 turn）
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';

import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot';

import { wire } from '../src/index.js';
import type { QqClientLike } from '../src/types/index.js';

const require = createRequire(import.meta.url);

const PROBE = 'WEBUI-SYNC';
const PORT = Number(process.env.PROBE_PORT || 3099);
const RUN_TURN = process.env.PROBE_TURN === '1';
/** 与 ~/.dsh/profiles/qqbot-test/package.json 的 dsh.profile.bundles 一致（去掉插件本体，插件由 wire() 直接接线） */
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const PROFILE = 'qqbot-test';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.summary.json`);

const raw: Record<string, unknown>[] = [];
const rec = (o: Record<string, unknown>) => raw.push({ ts: Date.now(), ...o });

/** 骨头桩：本探针只隔离 QQ 开放平台（网络外部依赖），DSH 侧全部真实 */
function stubQqClient(): QqClientLike {
  const ok = { ok: true, status: 200, body: { code: 0 } } as unknown as Awaited<
    ReturnType<QqClientLike['sendMessage']>
  >;
  return {
    start: async () => undefined,
    stop: () => undefined,
    getAccessToken: async () => 'probe-access-token',
    authHeader: async () => ({ Authorization: 'QQBot probe-access-token' }),
    onC2CMessage: () => undefined,
    onReady: () => undefined,
    sendMessage: async () => ok,
    sendStreamMessage: async () => ok,
    apiPost: async () => ok,
    putPresigned: async () => ({ ok: true, status: 200 }),
    fetchAttachment: async () => ({ ok: false, status: 404, bytes: new Uint8Array(), contentType: null }),
  };
}

async function main(): Promise<void> {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qqbot-webuisync-'));
  const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'webuisync-cwd-'));

  // 复用真实 DSH 的 settings/credentials（复制，避免写穿真实 home）
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(realHome, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(tmpHome, name));
      await fsp.chmod(path.join(tmpHome, name), 0o600).catch(() => undefined);
    }
  }
  // 用户自撰 preset 根（`USER_PRESET_DIR = '.agent-presets'`，`dsh-agent-presets/lib/index.js:195`）
  // 也必须一起搬：真实 `settings.yaml` 的 `agent-presets.default` 可能指向用户自撰 preset
  // （本机实测：`default: standard-gitbash`）。不搬 ⇒ 隔离 home 里该 preset 不存在，
  // roster 只剩 shipped 的 standard/ptc/minimal/cordis，探针就不再是真实形状。
  const realPresetRoot = path.join(realHome, '.agent-presets');
  if (fs.existsSync(realPresetRoot)) {
    await fsp.cp(realPresetRoot, path.join(tmpHome, '.agent-presets'), { recursive: true });
    console.log(`[${PROBE}] 复制用户 preset 根 = ${realPresetRoot}`);
  }
  process.env.DSH_HOME = tmpHome;
  console.log(`[${PROBE}] 隔离 DSH_HOME = ${tmpHome}`);
  console.log(`[${PROBE}] 新建目录 cwd  = ${cwd}`);
  console.log(`[${PROBE}] web 端口      = ${PORT}`);

  const report: Record<string, any> = {
    probe: PROBE,
    ranAt: new Date().toISOString(),
    bundles: BUNDLES,
    webPort: PORT,
    ranTurn: RUN_TURN,
    tmpHome,
    createdCwd: cwd,
  };

  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profileDir = path.join(tmpHome, 'profiles', PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });
  initProfile(profileDir, BUNDLES, 'live');
  const rootConfig = path.join(profileDir, 'cordis.yml');
  await fsp.writeFile(rootConfig, '[]\n', 'utf8');
  await healProfilesModuleFallback({ installAnchor, home: tmpHome });
  const profile = loadProfile('dsh-qqbot-bridge-probe', PROFILE, installAnchor, tmpHome);
  const bundlePatches = profile.layers.flatMap((layer: any) => layer.patches);
  report.profileLayers = profile.layers.map((l: any) => l.packageName);

  const overlays: any[] = [
    { id: 'hmr', disabled: true },
    {
      id: 'settings',
      config: { path: path.join(tmpHome, 'settings.yaml'), dshHome: tmpHome, watch: false },
    },
    { id: 'credentials', config: { dshHome: tmpHome, watch: false } },
    { id: 'storage-json', config: { root: path.join(tmpHome, 'storages') } },
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
  ];

  let bootedCtx: any;
  const booted = await boot(
    'dsh-qqbot-bridge-probe',
    rootConfig,
    [...bundlePatches, ...(profile.patches as any[]), ...overlays],
    (hostCtx: any) => {
      // 复刻 CLI 的 provideCmdline：web 各行的 config 用 !!js 读这两项服务，
      // 不提供则 webserver / web-runtime / connection 会 pending → boot 的 settle 审计直接失败。
      hostCtx.provide('cmdlineArgs', { get: () => ['--port', String(PORT), '--no-open'] });
      hostCtx.provide('appExit', () => undefined);
      hostCtx.provide('appReady', { onReady: (l: () => void) => { l(); return () => undefined; } });
    }
  );
  bootedCtx = booted;
  console.log(`[${PROBE}] DSH 装配完成：${profile.layers.length} 个 bundle 层`);

  // 真实 web 服务是否真的起来了
  let serverStatus: number | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    serverStatus = res.status;
  } catch (err) {
    serverStatus = null;
    rec({ kind: 'note', payload: { serverFetchError: String(err) } });
  }
  report.server = { url: `http://127.0.0.1:${PORT}/`, status: serverStatus };
  console.log(`[${PROBE}] web 服务 ${report.server.url} → HTTP ${String(serverStatus)}`);

  const ctx = bootedCtx;
  const frames = {
    sessionCreated: [] as any[],
    apiSessionAdded: [] as any[],
    apiSessionStatus: [] as any[],
    apiSessionActivity: [] as any[],
    workspaceDomainChanged: [] as any[],
    workspaceFollow: [] as any[],
  };

  ctx.on('session/created', (session: any) => {
    frames.sessionCreated.push({ id: String(session.id), seq: session.seq });
    rec({ kind: 'session/created', payload: { id: String(session.id) } });
  });
  ctx.on('api-session/added', (summary: any) => {
    frames.apiSessionAdded.push(summary);
    rec({ kind: 'api-session/added', payload: summary });
  });
  ctx.on('api-session/status', (id: string, running: boolean) => {
    frames.apiSessionStatus.push({ id: String(id), running });
    rec({ kind: 'api-session/status', payload: { id: String(id), running } });
  });
  ctx.on('api-session/activity', (id: string, at: number) => {
    frames.apiSessionActivity.push({ id: String(id), at });
  });
  ctx.on('domain/changed', (change: any) => {
    if (change?.domain !== 'workspace') return;
    frames.workspaceDomainChanged.push({
      table: change.table,
      operation: change.operation,
      key: change.key === undefined ? undefined : String(change.key),
      sessionIds: change.value?.sessionIds,
    });
    rec({ kind: 'domain/changed', payload: { table: change.table, operation: change.operation, key: change.key } });
  });

  // M2：订阅浏览器真正消费的工作区增量流（baseline + increments）
  const followAbort = new AbortController();
  const workspaceController: any = ctx.get('workspaceController');
  const followTask = (async () => {
    if (workspaceController?.follow === undefined) return;
    try {
      for await (const frame of workspaceController.follow(followAbort.signal)) {
        frames.workspaceFollow.push(frame);
        rec({ kind: 'workspace.follow', payload: frame });
        if (frames.workspaceFollow.length > 40) break;
      }
    } catch (err) {
      rec({ kind: 'note', payload: { followEnded: String(err) } });
    }
  })();

  const registryBefore = (ctx.workspaceRegistry as any).list().map((w: any) => ({
    id: String(w.id),
    path: w.path,
    title: w.title,
    sessionIds: w.sessionIds.map(String),
  }));
  report.workspacesBefore = registryBefore;

  // ── 真实接线：调用插件组合根 wire()（apply() 的全部业务逻辑），仅隔离 QQ 平台客户端
  const wiring = await wire(ctx, {}, { createClient: (() => stubQqClient()) as any });
  if (wiring === undefined) {
    throw new Error('wire() 返回 undefined（凭据缺失？）——本探针需要真实凭据走完整接线');
  }
  report.wired = true;

  // ── 走插件的 `/新建 <路径>` 真实路径：路径未注册 → 会自动注册新工作区（最容易被判成「未分组」的场景）
  const OPENID = 'probe-openid';
  const created = await wiring.control.createSession(OPENID, cwd);
  report.created = created;
  console.log(
    `[${PROBE}] /新建 → ok=${String((created as any).ok)} sessionId=${String((created as any).sessionId)} ` +
      `workspaceId=${String((created as any).workspaceId)} createdWorkspace=${String((created as any).createdWorkspace)}`
  );
  if (!(created as any).ok) throw new Error(`创建会话失败：${JSON.stringify(created)}`);

  const sessionId = String((created as any).sessionId);
  const workspaceId = String((created as any).workspaceId);

  await new Promise((r) => setTimeout(r, 800));

  // ── M6（D52）：会话**记录**的 agent preset —— WebUI 预设标签的唯一判据。
  //    浏览器侧读的是 `state.byId[sessionId].projectionValues.agentPreset`
  //    （`dsh-client-ui-agent-preset/lib/client.js:191`），`undefined` ⇒ 标签 `return null`（同文件 :196）。
  //    `projectionValues` 的宿主来源就是 `sessionProjections.snapshot(session, ['agentPreset'])`
  //    （官方 `ProjectionSnapshot`，client-visible view）。故此处三点齐验：
  //      durable header / 投影（client-visible）/ 真正挂载的组合，必须**同号**。
  const presetFacts: Record<string, unknown> = {};
  try {
    const presets: any = ctx.get('agentPresets');
    presetFacts.defaultId = presets?.defaultId ?? null;
    const liveAgent: any = (ctx.agents as any).get(sessionId);
    presetFacts.headerAgentPreset = liveAgent?.session?.header?.agentPreset ?? null;
    try {
      presetFacts.composedPreset =
        liveAgent === undefined ? null : presets?.composedPreset?.(liveAgent.ctx) ?? null;
    } catch (err) {
      presetFacts.composedPresetError = String(err);
    }
    try {
      const snapshot: any = (ctx.sessionProjections as any).snapshot(liveAgent.session, ['agentPreset']);
      presetFacts.projectionValues = snapshot?.values ?? null;
    } catch (err) {
      presetFacts.projectionError = String(err);
    }
    try {
      // 冷读（不看 live 对象）：durable 日志 header + 投影基线
      const observation: any = await (ctx.sessionQuery as any).observeSession(sessionId);
      presetFacts.coldHeaderAgentPreset = observation?.header?.agentPreset ?? null;
      presetFacts.coldProjectedPreset = observation?.projections?.values?.agentPreset ?? null;
      observation?.[Symbol.dispose]?.();
    } catch (err) {
      presetFacts.coldReadError = String(err);
    }
  } catch (err) {
    presetFacts.error = String(err);
  }
  // 浏览器真正收到的 `api-session/added` 帧里带的投影提示
  const addedFrame = frames.apiSessionAdded.find((s: any) => String(s.sessionId) === sessionId);
  presetFacts.addedFrameProjections = addedFrame?.projections ?? null;
  report.agentPreset = presetFacts;
  console.log(
    `[${PROBE}] agentPreset → 默认=${String(presetFacts.defaultId)} header=${String(presetFacts.headerAgentPreset)} ` +
      `投影=${JSON.stringify(presetFacts.projectionValues)} 实际组合=${String(presetFacts.composedPreset)}`
  );

  // ── M3 前置：宿主真值 —— 会话是否被某个工作区「记账」
  const registryAfter = (ctx.workspaceRegistry as any).list().map((w: any) => ({
    id: String(w.id),
    path: w.path,
    title: w.title,
    sessionIds: w.sessionIds.map(String),
  }));
  report.workspacesAfter = registryAfter;
  const owner = registryAfter.find((w: any) => w.sessionIds.includes(sessionId));
  report.hostMembership = { inWorkspace: owner !== undefined, workspaceId: owner?.id ?? null, title: owner?.title ?? null };

  // ── M3：把浏览器判据套用到浏览器真正收到的帧上
  const baseline = frames.workspaceFollow.find((f: any) => f.type === 'baseline');
  const upserts = frames.workspaceFollow.filter((f: any) => f.type === 'upsert');
  const membershipsFromFrames = [
    ...(baseline?.value?.items ?? []),
    ...upserts.map((f: any) => f.workspace),
  ].filter((w: any) => Array.isArray(w?.sessionIds));
  const owningGroupKey =
    membershipsFromFrames.find((w: any) => w.sessionIds.map(String).includes(sessionId))?.workspaceId ?? '';
  report.browserFrames = {
    baselineWorkspaceIds: (baseline?.value?.items ?? []).map((w: any) => String(w.workspaceId)),
    upsertWorkspaceIds: upserts.map((f: any) => String(f.workspace.workspaceId)),
    upsertCarriesNewSession:
      upserts.some((f: any) => f.workspace.sessionIds.map(String).includes(sessionId)) ||
      (baseline?.value?.items ?? []).some(
        (w: any) => String(w.workspaceId) === workspaceId && w.sessionIds.map(String).includes(sessionId)
      ),
    owningGroupKey,
    ungroupped: owningGroupKey === '',
  };

  // ── M5：**往同一个已存在的工作区里再建一个会话**（真实 WebUI 里工作区通常已有多个会话）。
  //     attachSession 走的是 workspace 记录的 mutate，其中有一次
  //     `sessionIds.filter((id) => sessionPath(id) === path)` 的剪枝（`dsh-workspace/lib/index.js:170-190`）。
  //     若剪枝把**老会话**挤出去，老会话就会掉进「未分组」——这才是真事故，故必须实测。
  const second = await wiring.control.createSession(OPENID, cwd);
  report.secondCreated = second;
  await new Promise((r) => setTimeout(r, 800));

  const registryAfterSecond = (ctx.workspaceRegistry as any).list().map((w: any) => ({
    id: String(w.id),
    sessionIds: w.sessionIds.map(String),
  }));
  const secondId = String((second as any).sessionId);
  const ownerAfterSecond = registryAfterSecond.find((w: any) => w.sessionIds.includes(secondId));
  const latestUpsert = [...frames.workspaceFollow].reverse().find((f: any) => f.type === 'upsert');
  report.browserFramesAfterSecond = {
    ownerWorkspaceId: ownerAfterSecond?.id ?? null,
    ownerSessionIds: ownerAfterSecond?.sessionIds ?? [],
    firstStillAccounted: ownerAfterSecond?.sessionIds.includes(sessionId) ?? false,
    latestUpsertSessionIds: latestUpsert?.workspace?.sessionIds?.map(String) ?? [],
    latestUpsertCarriesBoth:
      (latestUpsert?.workspace?.sessionIds?.map(String) ?? []).includes(secondId) &&
      (latestUpsert?.workspace?.sessionIds?.map(String) ?? []).includes(sessionId),
  };
  console.log(
    `[${PROBE}] 第二个会话 ${secondId} → 归属工作区 ${String(ownerAfterSecond?.id)}；` +
      `老会话仍在记账 = ${String(ownerAfterSecond?.sessionIds.includes(sessionId))}`
  );

  // ── M4：会话列表投影（浏览器 remote.session.list 的同源数据）
  const readSummaries = async () => {
    const controller: any = ctx.get('sessionController');
    if (controller?.list === undefined) return undefined;
    const ac = new AbortController();
    const value = await controller.list(ac.signal);
    return value;
  };
  const listBeforeTurn = await readSummaries();
  const summaryBeforeTurn = listBeforeTurn?.items?.find((s: any) => String(s.sessionId) === sessionId);
  report.sessionSummaryBeforeTurn = summaryBeforeTurn
    ? { blank: summaryBeforeTurn.blank, running: summaryBeforeTurn.running, cwd: summaryBeforeTurn.cwd }
    : null;

  // ── M4 实测：跑一个最小真机 turn，看 blank/可见性怎么走
  if (RUN_TURN) {
    const turnEvents: any[] = [];
    const off = ctx.on('session/event', (session: any, event: any) => {
      if (String(session?.id) !== sessionId) return;
      turnEvents.push({ type: event?.type, time: event?.time });
    });
    const takeover = await wiring.control.setTarget(OPENID, sessionId);
    report.takeover = takeover;
    const sent = await wiring.control.send(OPENID, '只回复两个字：收到');
    report.sent = sent;
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      if (turnEvents.some((e) => e.type === 'turn/end')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    off();
    report.turnEvents = turnEvents.map((e) => e.type);
    const listAfterTurn = await readSummaries();
    const summaryAfterTurn = listAfterTurn?.items?.find((s: any) => String(s.sessionId) === sessionId);
    report.sessionSummaryAfterTurn = summaryAfterTurn
      ? {
          blank: summaryAfterTurn.blank,
          running: summaryAfterTurn.running,
          title: summaryAfterTurn.title,
        }
      : null;
  }

  followAbort.abort();
  await followTask;

  report.frames = {
    sessionCreated: frames.sessionCreated,
    apiSessionAdded: frames.apiSessionAdded.map((s: any) => ({
      sessionId: String(s.sessionId),
      blank: s.blank,
      running: s.running,
      cwd: s.cwd,
    })),
    apiSessionStatus: frames.apiSessionStatus,
    apiSessionActivity: frames.apiSessionActivity,
    workspaceDomainChanged: frames.workspaceDomainChanged,
    workspaceFollowTypes: frames.workspaceFollow.map((f: any) => f.type),
  };

  // ── 结论
  const conclusions = {
    'M1 会话建立后是否有 api-session/added 帧（浏览器据此并入列表）':
      frames.apiSessionAdded.some((s: any) => String(s.sessionId) === sessionId),
    'M2 工作区增量流是否送达该会话的归属（浏览器据此分组）': report.browserFrames
      ? (report.browserFrames as any).upsertCarriesNewSession
      : false,
    'M3 浏览器分组键为空字符串？（空 = 未分组）': (report.browserFrames as any).ungroupped,
    'M3 最终归属工作区': (report.browserFrames as any).owningGroupKey || '(未分组)',
    'M5 再建一个会话后，老会话是否被挤出工作区（挤出=老会话会掉进未分组）': report.browserFramesAfterSecond
      ? (report.browserFramesAfterSecond as any).firstStillAccounted
        ? false
        : '是老会话被挤出了！'
      : null,
    'M5 浏览器收到的最后一帧是否同时包含两个会话': report.browserFramesAfterSecond
      ? (report.browserFramesAfterSecond as any).latestUpsertCarriesBoth
      : null,
    'M4 建会话后、首个 turn 前 blank（未分组之外还会被 blank 隐藏）':
      (report.sessionSummaryBeforeTurn ?? null) === null
        ? '列表里读不到该会话'
        : (report.sessionSummaryBeforeTurn as any).blank,
    'M4 首个 turn 后 blank':
      report.sessionSummaryAfterTurn === undefined
        ? '未跑 turn（PROBE_TURN=1 可实测）'
        : (report.sessionSummaryAfterTurn as any).blank,
    'M6 会话记录的 agent preset（D52：header / 投影 / 实际组合必须同号）': (() => {
      const facts = report.agentPreset as Record<string, any> | undefined;
      if (facts === undefined) return '未观测';
      const header = facts.headerAgentPreset ?? null;
      const projected = facts.projectionValues?.agentPreset ?? null;
      const composed = facts.composedPreset ?? null;
      return {
        defaultId: facts.defaultId ?? null,
        headerAgentPreset: header,
        projectionValues: facts.projectionValues ?? null,
        composedPreset: composed,
        三者同号: header !== null && header === projected && header === composed,
      };
    })(),
  };
  report.conclusions = conclusions;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`\n[${PROBE}] ===== 结论 =====`);
  for (const [k, v] of Object.entries(conclusions)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log(`[${PROBE}] 产物：${RAW_PATH}`);
  console.log(`[${PROBE}] 产物：${SUMMARY_PATH}`);

  await wiring.dispose?.();
  await followAbort.abort();
  await (booted as any).fiber?.dispose?.();
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
  await fsp.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${PROBE}] 失败：`, err);
    process.exit(1);
  }
);