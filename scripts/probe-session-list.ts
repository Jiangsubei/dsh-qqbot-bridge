#!/usr/bin/env tsx
/**
 * 探针 SESSION-LIST（D46）：`/会话` 的**时间**与**可见性**是否与 WebUI 一致。
 *
 * 背景（用户报告 2026-09-16）：QQ 侧 `/会话` 第 1 条是 `session-36ac…`（WebUI 侧边栏根本看不到），
 * 且每行「最后活跃 未知」。
 *
 * 本探针**不是造桩自测**：
 *   - 装配层与真实 profile 一致：`dsh-base` + `dsh-web-app` + `@michengai/dsh-archive-manager`
 *     （用户真实 `web` profile 的投影缓存被后者顶替，不装就读到空缓存、结论失真）；
 *   - **把真实 home 的 `sessions/` 与 `storages/` 复制进隔离 `DSH_HOME`**，因此复现的是
 *     用户**真实那份列表**（含 `session-36ac…`）；真实 home 只读；
 *   - 只有 **QQ 开放平台客户端** 是骨头桩（外部网络边界，AGENTS §3.1 允许）。
 *
 * ⚠️ 关键教训（本探针的价值所在）：**必须用「插件作用域」的 ctx 驱动**，不能用 boot 后的宿主 ctx。
 * cordis 的服务解析沿 fiber 链上行、**遇 isolate 边界即止**（`cordis/lib/index.js:686-696`）：
 * 由其它 bundle 组注册的服务（如 `sessionController`）在**宿主 ctx 上可见、在插件 ctx 上不可见**，
 * 必须靠 `inject` 才拿得到。为此探针在 profile 末尾插入一个**生产形状的替身 bundle**（与本插件
 * 相同的静态 `inject`，用**它自己的 ctx** 调本插件的 `wire()` 并驱动真实入站管线），
 * 再把结果回传给探针。宿主 ctx 只用于读取官方权威值做对拍。
 *
 * 观测点：
 *   B1 宿主 ctx 上 `sessionController` 是否可达；
 *   B2 官方 `SessionSummary.updatedAt` → `/会话` 行内相对时间是否逐条对得上；
 *   A1 空白会话（非当前受控）是否被隐藏——即用户报的 `session-36ac…` 是否还在；
 *   A2 回执里是否还残留「最后活跃」/「未知」；
 *   A3 「共 N 条」是否等于 注册表 − 归档 − 空白(非当前) − subagent。
 *
 * 产物：logs/probe/SESSION-LIST-<ts>.jsonl + .summary.json
 * 用法：pnpm probe:session-list
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';

import { boot, healProfilesModuleFallback, initProfile, loadProfile } from '@deepseek-ai/dsh-app-boot';

const require = createRequire(import.meta.url);

const PROBE = 'SESSION-LIST';
const PORT = Number(process.env.PROBE_PORT || 3098);
/** 与用户真实 profile 的 bundle 列表一致（本插件由替身 bundle 以内联方式接线） */
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
/**
 * 额外 bundle（逗号分隔）。用户真实 profile 是 `web`，其中 `@michengai/dsh-archive-manager`
 * 用 `disabled: true` 摘掉官方 `session-projection-cache` 并插入自己的子类
 * （domain → `session_projcache_archive_manager_v2`；`cordis.patch.yml:5-17`、
 * `lib/projcache.js:198-205`）。**不装它**，`blank`/`lastPromptAt` 会因读到空的规范 domain
 * 而全部缺省 —— 探针结论会失真，故默认带上。
 */
const EXTRA_BUNDLES = (process.env.PROBE_EXTRA_BUNDLES ?? '@michengai/dsh-archive-manager')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PROFILE = 'qqbot-test';
const OPENID = 'openid-probe-d46';
const TARGET_SESSION = 'session-36ac1333-52ab-45b1-ac95-83b077a789d3';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.summary.json`);

const raw: Record<string, unknown>[] = [];
const rec = (o: Record<string, unknown>) => raw.push({ ts: Date.now(), ...o });

/**
 * 替身 bundle 源码：**生产形状**——静态 `inject` 与本插件一致（这是跨 bundle 组可见性的前提），
 * 用**自己的插件 ctx** 调本插件的 `wire()`，再通过真实入站管线发 `/会话`，把回执写文件。
 * 只桩掉 QQ 平台客户端（网络外部依赖）。
 */
function standinSource(): string {
  return [
    "import fs from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "export const name = 'dsh-probe-standin';",
    "export const inject = ['agents', 'workspaceRegistry', 'sessionProjections', 'storageDomain'];",
    "const OUT = process.env.PROBE_STANDIN_OUT;",
    "const KEYS = ['sessionController','sessionProjectionCache','workspaceRegistry','sessionQuery','sessionTitle','agentPresets','agentDefaultModel','tokenMeter','permissionPresets','compaction','llm','sessions','tools','settings','storageDomain','agents','sessionProjections'];",
    'function snapshot(ctx, phase) {',
    '  const state = {};',
    '  for (const k of KEYS) {',
    "    try { const v = ctx.get(k); state[k] = v === undefined ? 'undefined' : typeof v; }",
    "    catch (e) { state[k] = 'THROW:' + String(e?.message ?? e); }",
    '  }',
    "  fs.appendFileSync(process.env.PROBE_ORDER_OUT, JSON.stringify({ phase, at: Date.now(), state }) + '\\n');",
    '}',
    '/** QQ 平台客户端骨头桩：抓取出站回执，并可注入入站事件 */',
    'function captureClient() {',
    '  const sent = [];',
    '  const handlers = [];',
    '  const ok = { ok: true, status: 200, body: { code: 0 } };',
    '  return { sent, emit: (e) => { for (const h of handlers) void h(e); }, client: {',
    '    start: async () => undefined, stop: () => undefined,',
    "    getAccessToken: async () => 'probe-token',",
    "    authHeader: async () => ({ Authorization: 'QQBot probe-token' }),",
    '    onC2CMessage: (h) => { handlers.push(h); },',
    '    onReady: () => undefined,',
    '    sendMessage: async (openid, payload) => { sent.push({ openid, content: String(payload?.content ?? "") }); return { ok: true, status: 200, body: { id: "probe-" + sent.length } }; },',
    '    sendStreamMessage: async (openid, payload) => { sent.push({ openid, content: String(payload?.content ?? "") }); return { ok: true, status: 200, body: { id: "probe-s-" + sent.length } }; },',
    '    apiPost: async () => ok, putPresigned: async () => ({ ok: true, status: 200 }),',
    '    fetchAttachment: async () => ({ ok: false, status: 404, bytes: new Uint8Array(), contentType: null }),',
    '  } };',
    '}',
    'export function apply(ctx) {',
    "  snapshot(ctx, 'apply');",
    "  setTimeout(() => snapshot(ctx, 'apply+2s'), 2000);",
    '  const done = (payload) => { try { fs.writeFileSync(OUT, JSON.stringify(payload, null, 2)); } catch {} };',
    '  (async () => {',
    '    try {',
    "      const mod = await import('dsh-qqbot-bridge');",
    '      const qq = captureClient();',
    "      const wiring = await mod.wire(ctx, {}, { createClient: () => qq.client, autoStart: false });",
    "      if (wiring === undefined) return done({ error: 'wire() 返回 undefined（凭据缺失？）' });",
    '      const workspaces = await wiring.control.listWorkspaces();',
    '      const target = workspaces.find((w) => w.sessionIds.includes(process.env.PROBE_TARGET_SESSION))',
    '        ?? workspaces.find((w) => w.path === process.env.PROBE_TARGET_PATH);',
    "      if (target === undefined) return done({ error: '找不到目标工作区' });",
    '      await wiring.control.setWorkspace(process.env.PROBE_OPENID, target.id);',
    "      const archivedIds = await wiring.control.listArchivedSessionIds();",
    "      qq.emit({ id: 'probe-msg-d46', author: { user_openid: process.env.PROBE_OPENID }, content: '/会话' });",
    '      const deadline = Date.now() + 20000;',
    '      while (qq.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));',
    '      done({ wired: true, targetWorkspace: { id: target.id, title: target.title, path: target.path, sessionIds: target.sessionIds.map(String) }, archivedIds, reply: qq.sent.at(-1)?.content ?? "" });',
    '    } catch (e) { done({ error: String(e?.stack ?? e) }); }',
    '  })();',
    '}',
    '',
  ].join('\n');
}

/** 相对时间分档（探针侧独立实现，用于与 `src/commands/dispatch.ts` 对拍）。口径【文档明写】：
 * `dsh-client-ui-primitives/lib/index.js:4944-4972`（边界）+ `dsh-client-ui-workspace/lib/client.js:2625-2629`（文案）。 */
function expectedRelativeTime(ms: number, now: number): string {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const diff = Math.max(0, now - ms);
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分钟`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}个月`;
  return `${Math.floor(diff / (365 * DAY))}年`;
}

async function main(): Promise<void> {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qqbot-sessionlist-'));
  const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));

  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(realHome, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(tmpHome, name));
      await fsp.chmod(path.join(tmpHome, name), 0o600).catch(() => undefined);
    }
  }
  const copied: Record<string, boolean> = {};
  for (const name of ['sessions', 'storages']) {
    const src = path.join(realHome, name);
    if (fs.existsSync(src)) {
      await fsp.cp(src, path.join(tmpHome, name), { recursive: true });
      copied[name] = true;
    } else {
      copied[name] = false;
    }
  }
  process.env.DSH_HOME = tmpHome;
  console.log(`[${PROBE}] 隔离 DSH_HOME = ${tmpHome}`);
  console.log(`[${PROBE}] 真实数据复制 = ${JSON.stringify(copied)}`);

  const orderOut = path.join(tmpHome, 'probe-order.jsonl');
  const standinOut = path.join(tmpHome, 'probe-standin-result.json');
  const standinDir = path.join(tmpHome, 'profiles', 'node_modules', 'dsh-probe-standin');
  await fsp.mkdir(standinDir, { recursive: true });
  await fsp.writeFile(
    path.join(standinDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-probe-standin',
        version: '1.0.0',
        main: 'index.js',
        type: 'module',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    ),
    'utf8'
  );
  await fsp.writeFile(
    path.join(standinDir, 'cordis.patch.yml'),
    '- insert:\n    - id: dsh-probe-standin\n      name: dsh-probe-standin\n',
    'utf8'
  );
  await fsp.writeFile(path.join(standinDir, 'index.js'), standinSource(), 'utf8');
  process.env.PROBE_ORDER_OUT = orderOut;
  process.env.PROBE_STANDIN_OUT = standinOut;
  process.env.PROBE_OPENID = OPENID;
  process.env.PROBE_TARGET_SESSION = TARGET_SESSION;
  process.env.PROBE_TARGET_PATH = os.homedir();

  const report: Record<string, any> = {
    probe: PROBE,
    ranAt: new Date().toISOString(),
    bundles: [...BUNDLES, ...EXTRA_BUNDLES, 'dsh-probe-standin'],
    extraBundles: EXTRA_BUNDLES,
    driver: 'plugin-scope（生产形状：替身 bundle 用自己的 ctx 调 wire()）',
    webPort: PORT,
    tmpHome,
    realHome,
    copiedRealData: copied,
  };

  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profileDir = path.join(tmpHome, 'profiles', PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });
  initProfile(profileDir, [...BUNDLES, ...EXTRA_BUNDLES, 'dsh-probe-standin'], 'live');
  const rootConfig = path.join(profileDir, 'cordis.yml');
  await fsp.writeFile(rootConfig, '[]\n', 'utf8');
  await healProfilesModuleFallback({ installAnchor, home: tmpHome });
  // 额外 bundle 不在 DSH 安装闭包里（用户 profile 自装），按包名软链进隔离 profiles/node_modules
  for (const name of EXTRA_BUNDLES) {
    const src = path.join(realHome, 'profiles', 'web', 'node_modules', name);
    if (!fs.existsSync(src)) {
      console.warn(`[${PROBE}] 额外 bundle 源不存在，跳过：${src}`);
      continue;
    }
    const dest = path.join(tmpHome, 'profiles', 'node_modules', name);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) await fsp.symlink(src, dest, 'dir');
  }
  {
    // 替身要 import 本插件（真实 dist）：直接放在 profiles/node_modules 下，
    // 其模块解析会向上走到 profiles/node_modules 找到软链过来的 `dsh-qqbot-bridge`。
    const bridgeLink = path.join(tmpHome, 'profiles', 'node_modules', 'dsh-qqbot-bridge');
    if (!fs.existsSync(bridgeLink)) {
      await fsp.symlink(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), bridgeLink, 'dir');
    }
  }
  const profile = loadProfile('dsh-qqbot-bridge-probe', PROFILE, installAnchor, tmpHome);
  const bundlePatches = profile.layers.flatMap((layer: any) => layer.patches);
  report.profileLayers = profile.layers.map((l: any) => l.packageName);

  const overlays: any[] = [
    { id: 'hmr', disabled: true },
    { id: 'settings', config: { path: path.join(tmpHome, 'settings.yaml'), dshHome: tmpHome, watch: false } },
    { id: 'credentials', config: { dshHome: tmpHome, watch: false } },
    { id: 'storage-json', config: { root: path.join(tmpHome, 'storages') } },
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
  ];

  const booted = await boot(
    'dsh-qqbot-bridge-probe',
    rootConfig,
    [...bundlePatches, ...(profile.patches as any[]), ...overlays],
    (hostCtx: any) => {
      hostCtx.provide('cmdlineArgs', { get: () => ['--port', String(PORT), '--no-open'] });
      hostCtx.provide('appExit', () => undefined);
      hostCtx.provide('appReady', { onReady: (l: () => void) => { l(); return () => undefined; } });
    }
  );
  const hostCtx = booted as any;
  console.log(`[${PROBE}] DSH 装配完成：${profile.layers.length} 个 bundle 层`);

  // ── 等替身完成接线与 `/会话` 驱动
  const deadline = Date.now() + 90_000;
  while (!fs.existsSync(standinOut) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // 等替身的「apply+2s」快照落地（用于观察注入是否在装配稍后动态生效）
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (fs.existsSync(orderOut)) {
    report.serviceVisibility = fs
      .readFileSync(orderOut, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    console.log(`[${PROBE}] ===== 插件作用域的服务可见性快照 =====`);
    for (const snap of report.serviceVisibility as any[]) {
      const miss = Object.entries(snap.state as Record<string, string>)
        .filter(([, v]) => v !== 'object')
        .map(([k, v]) => `${k}=${v}`);
      console.log(`  [${snap.phase}] 不可见/异常：${miss.length ? miss.join(', ') : '（无）'}`);
    }
  }
  if (!fs.existsSync(standinOut)) throw new Error('替身 bundle 未产出结果（接线或 /会话 驱动失败）');
  const standin = JSON.parse(fs.readFileSync(standinOut, 'utf8'));
  report.standin = standin;
  if (standin.error !== undefined) throw new Error(`替身接线失败：${standin.error}`);
  report.targetWorkspace = standin.targetWorkspace;
  const reply: string = standin.reply ?? '';
  report.reply = reply;
  rec({ kind: 'standin', payload: { targetWorkspace: report.targetWorkspace, reply } });
  console.log(`\n[${PROBE}] ===== /会话 真实回执（插件作用域驱动）=====\n${reply}\n`);

  // ── B1：宿主 ctx 上官方 sessionController 是否可达（仅用于读取权威值对拍）
  const controller = hostCtx.get('sessionController');
  report.B1_hostCtx_sessionControllerReachable = controller !== undefined;
  report.B1_hasList = typeof controller?.list === 'function';

  const targetSessionIds: string[] = standin.targetWorkspace?.sessionIds ?? [];
  const officialItems: any[] = [];
  if (typeof controller?.list === 'function') {
    const value = await controller.list({}, new AbortController().signal);
    for (const item of value.items) {
      if (!targetSessionIds.includes(String(item.sessionId))) continue;
      officialItems.push({
        sessionId: String(item.sessionId),
        updatedAt: item.updatedAt,
        blank: item.blank,
        origin: item.origin ?? null,
      });
    }
  }
  report.officialItems = officialItems;
  const archivedIds: string[] = standin.archivedIds ?? [];
  report.archivedCount = archivedIds.length;

  const now = Date.now();
  const officialById = new Map(officialItems.map((o) => [o.sessionId, o]));
  const expectedVisible = targetSessionIds.filter(
    (id) =>
      !archivedIds.includes(id) && officialById.get(id)?.origin !== 'subagent' && officialById.get(id)?.blank !== true
  );
  const perSession = expectedVisible.map((id) => {
    const o = officialById.get(id);
    const expected = o !== undefined && Number.isFinite(o.updatedAt) ? expectedRelativeTime(o.updatedAt, now) : null;
    return {
      sessionId: id,
      updatedAt: o?.updatedAt ?? null,
      expectedRelativeTime: expected,
      tokenPresentInReply: expected === null ? null : reply.includes(expected),
    };
  });
  report.perSession = perSession;

  const countMatch = /共 (\d+) 条/.exec(reply);
  report.conclusions = {
    'B1 宿主 ctx 上 sessionController 可达': report.B1_hostCtx_sessionControllerReachable && report.B1_hasList,
    'B2 官方 updatedAt → 相对时间逐条落在回执中': perSession.every(
      (p) => p.tokenPresentInReply === null || p.tokenPresentInReply === true
    ),
    'A1 空白会话 session-36ac… 是否已从列表消失（期望 true）': !reply.includes('session-36ac'),
    'A1 空白(非当前)会话数': targetSessionIds.filter((id) => officialById.get(id)?.blank === true).length,
    'A2 回执残留「最后活跃」（期望 false）': reply.includes('最后活跃'),
    'A2 回执残留「未知」（期望 false）': reply.includes('未知'),
    'A3 回执含相对时间 token（期望 true）': /(\d+(分钟|小时|天|个月|年)|刚刚)/.test(reply),
    'A3 「共 N 条」= 注册表−归档−空白(非当前)（期望 true）':
      countMatch !== null && Number(countMatch[1]) === expectedVisible.length,
    'A3 期望可见条数': expectedVisible.length,
    'A3 实际「共 N 条」': countMatch ? Number(countMatch[1]) : null,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  rec({ kind: 'conclusions', payload: report.conclusions });
  rec({ kind: 'serviceVisibility', payload: report.serviceVisibility ?? [] });
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`[${PROBE}] ===== 结论 =====`);
  for (const [k, v] of Object.entries(report.conclusions)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log(`[${PROBE}] 产物：${RAW_PATH}`);
  console.log(`[${PROBE}] 产物：${SUMMARY_PATH}`);

  // ── 回归门：本探针可失败。任何结论与期望不符 → 退出码 1（便于在交付流程里当门禁用）。
  //    坏版本（跨 bundle 组不注入 sessionController）会在此处失败并逐字复现用户报告的现象。
  const failures = Object.entries(report.conclusions).filter(([key, value]) => {
    if (key.includes('（期望 false）')) return value !== false;
    if (key.includes('（期望 true）')) return value !== true;
    return false;
  });
  if (failures.length > 0) {
    console.error(
      `[${PROBE}]  回归门失败：${failures.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('；')}`
    );
    await booted?.fiber?.dispose?.();
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
    process.exit(1);
  }

  await booted?.fiber?.dispose?.();
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${PROBE}] 失败：`, err);
    process.exit(1);
  }
);