#!/usr/bin/env tsx
/**
 * 探针 FIRST-MESSAGE（D36）：**新装插件、未做任何选择就直接发第一条消息**的真机行为。
 *
 * 用户拍板的设计：
 *   - 路径：`$DSH_HOME/workspace/default`（跟随 DSH_HOME）；
 *   - 触发：任何未选中态的消息都自动新建；**有工作区作用域就落在该作用域**，没有才用默认工作区；
 *   - 惰性：首次真正用到时才 `mkdir -p` + 注册工作区（装了但没发消息不留空目录）；
 *   - 提示：新建后回一条**只报工作区名**的短提示（不带 session id）；
 *   - 开关：`allow_create_session=false` 时退回 D19/D27「只提示不转发」。
 *
 * 装配真值：`dsh-base` + `dsh-web-app` 两个 bundle 层（与 `~/.dsh/profiles/qqbot-test/package.json`
 * 的 `dsh.profile.bundles` 逐字一致），并真起 web 服务；只有 **QQ 开放平台客户端**为桩
 * （AGENTS §3.1 允许隔离外部网络依赖）。模型/凭据取自真实 home 的副本，turn 是真跑的。
 *
 * 观测：
 *   M1 首条消息 → 回执是不是「只报工作区名」的提示（且**不含 session id**）
 *   M2 `$DSH_HOME/workspace/default` 是否**惰性**创建 + 注册为工作区 + 新会话 cwd 落在其中
 *   M3 该消息是否继续作为新会话的首个 prompt 转发，且**回答真的发回 QQ**
 *      （首轮探针在此抓到过接缝缺陷：turn 跑了但回答被 turn-router 丢弃）
 *   M4 浏览器侧（工作区增量帧）：归到工作区分组，**不是「未分组」**
 *   M5 `allow_create_session=false` 时是否退回「请先 /会话 选会话」且不建会话
 *
 * 两个场景各自独立 boot（**不能在同一 DSH 进程里 wire 两次**：目标存储域 `qqbot_control_target`
 * 只允许打开一次，第二次会 `DomainError: already open`——首轮探针实测）。
 *
 * 产物：logs/probe/FIRST-MESSAGE-<ts>.jsonl + .summary.json
 * 用法：pnpm tsx scripts/probe-first-message.ts
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';

import { boot, healProfilesModuleFallback, initProfile, loadProfile } from '@deepseek-ai/dsh-app-boot';

import { wire, type QqBridgeWiring } from '../src/index.js';
import type {
  QqApiResult,
  QqC2CMessageEvent,
  QqClientLike,
  QqMessageHandler,
  QqReadyHandler,
  QqSendMessagePayload,
  QqStreamMessagePayload,
} from '../src/types/index.js';

const require = createRequire(import.meta.url);

const PROBE = 'FIRST-MESSAGE';
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const PROFILE = 'qqbot-test';
const RUN_TURN = process.env.PROBE_NO_TURN !== '1';
/** 真实 DSH home：**必须在任何场景改写 DSH_HOME 之前**固定下来（场景 1 会把 env 指到临时目录） */
const REAL_HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `${PROBE}-${stamp}.summary.json`);

const raw: Record<string, unknown>[] = [];
const rec = (o: Record<string, unknown>) => raw.push({ ts: Date.now(), ...o });

/** 出站载荷的可读文本（普通消息取 `content`，流式取 `markdown.content`） */
function payloadText(payload: QqSendMessagePayload | QqStreamMessagePayload): string {
  const anyPayload = payload as any;
  return String(anyPayload.content ?? anyPayload.markdown?.content ?? '');
}

/** 只隔离 QQ 开放平台网络；记录所有出站消息便于断言顺序与内容 */
class RecordingQqClient implements QqClientLike {
  readonly sent: Array<{ openid: string; payload: QqSendMessagePayload }> = [];
  readonly streamed: Array<{ openid: string; payload: QqStreamMessagePayload }> = [];
  private handlers: QqMessageHandler[] = [];
  private readyHandlers: QqReadyHandler[] = [];

  async start(): Promise<void> {}
  stop(): void {}
  async getAccessToken(): Promise<string> {
    return 'probe-token';
  }
  async authHeader(): Promise<Record<string, string>> {
    return { Authorization: 'QQBot probe-token' };
  }
  onC2CMessage(handler: QqMessageHandler): void {
    this.handlers.push(handler);
  }
  onReady(handler: QqReadyHandler): void {
    this.readyHandlers.push(handler);
  }
  async sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult> {
    this.sent.push({ openid, payload });
    return { ok: true, status: 200, body: { id: `sent-${this.sent.length}` } };
  }
  async sendStreamMessage(openid: string, payload: QqStreamMessagePayload): Promise<QqApiResult> {
    this.streamed.push({ openid, payload });
    return { ok: true, status: 200, body: { id: 'stream-1' } };
  }
  async apiPost(): Promise<QqApiResult> {
    return { ok: true, status: 200, body: {} };
  }
  async putPresigned(): Promise<{ ok: boolean; status: number }> {
    return { ok: true, status: 200 };
  }
  async fetchAttachment(): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }> {
    return { ok: false, status: 404, bytes: new Uint8Array(), contentType: null };
  }

  /** 驱动真实的 onC2CMessage 监听链（等价于 QQ 网关投递一条 C2C 消息） */
  async emit(event: Partial<QqC2CMessageEvent>): Promise<void> {
    const full = {
      id: `msg-${Date.now()}`,
      author: { user_openid: 'probe-first' },
      content: '你好',
      timestamp: new Date().toISOString(),
      ...event,
    } as QqC2CMessageEvent;
    for (const handler of this.handlers) await handler(full);
  }
}

interface Scenario {
  home: string;
  defaultWorkspace: string;
  ctx: any;
  wiring: QqBridgeWiring;
  fake: RecordingQqClient;
  frames: any[];
  activity: string[];
  tmpHome: string;
  dispose: () => Promise<void>;
}

/** 装配「真实 profile（base + web）+ 真实 web 服务」并接线插件（QQ 客户端为桩） */
async function openScenario(config: Record<string, unknown> = {}): Promise<Scenario> {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-first-msg-'));
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(REAL_HOME, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(tmpHome, name));
      await fsp.chmod(path.join(tmpHome, name), 0o600).catch(() => undefined);
    }
  }
  process.env.DSH_HOME = tmpHome;

  const port = 3099 + Math.floor(Math.random() * 30);
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profileDir = path.join(tmpHome, 'profiles', PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });
  initProfile(profileDir, BUNDLES, 'live');
  const rootConfig = path.join(profileDir, 'cordis.yml');
  await fsp.writeFile(rootConfig, '[]\n', 'utf8');
  await healProfilesModuleFallback({ installAnchor, home: tmpHome });
  const profile = loadProfile('dsh-qqbot-bridge-probe', PROFILE, installAnchor, tmpHome);
  const bundlePatches = profile.layers.flatMap((layer: any) => layer.patches);
  const overlays: any[] = [
    { id: 'hmr', disabled: true },
    { id: 'settings', config: { path: path.join(tmpHome, 'settings.yaml'), dshHome: tmpHome, watch: false } },
    { id: 'credentials', config: { dshHome: tmpHome, watch: false } },
    { id: 'storage-json', config: { root: path.join(tmpHome, 'storages') } },
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
  ];
  const ctx: any = await boot(
    'dsh-qqbot-bridge-probe',
    rootConfig,
    [...bundlePatches, ...(profile.patches as any[]), ...overlays],
    (hostCtx: any) => {
      hostCtx.provide('cmdlineArgs', { get: () => ['--port', String(port), '--no-open'] });
      hostCtx.provide('appExit', () => undefined);
      hostCtx.provide('appReady', { onReady: (l: () => void) => { l(); return () => undefined; } });
    }
  );

  const frames: any[] = [];
  const activity: string[] = [];
  ctx.on('session/event', (_s: any, e: any) => {
    if (e?.type === 'turn/start' || e?.type === 'turn/end' || e?.type === 'assistant/message') activity.push(e.type);
  });
  const followAbort = new AbortController();
  const workspaceController: any = ctx.get('workspaceController');
  const followTask = (async () => {
    if (workspaceController?.follow === undefined) return;
    try {
      for await (const frame of workspaceController.follow(followAbort.signal)) {
        frames.push(frame);
        rec({ kind: 'workspace.follow', payload: frame });
      }
    } catch {
      /* 关闭时的正常退出 */
    }
  })();

  const fake = new RecordingQqClient();
  const wiring = await wire(ctx, config, { createClient: () => fake });
  if (!wiring) throw new Error('wire() 返回 undefined（凭据缺失）');

  const defaultWorkspace = path.join(tmpHome, 'workspace', 'default');
  return {
    home: tmpHome,
    tmpHome,
    defaultWorkspace,
    ctx,
    wiring,
    fake,
    frames,
    activity,
    dispose: async () => {
      followAbort.abort();
      await followTask;
      await wiring.dispose().catch(() => undefined);
      await ctx.fiber?.dispose?.().catch(() => undefined);
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 从浏览器真正消费的工作区帧里解析分组键（空串 = 「未分组」） */
function owningGroupKey(frames: any[], sessionId: string): { key: string; ungroupped: boolean; upsertCarries: boolean } {
  const memberships = [
    ...(frames.find((f) => f.type === 'baseline')?.value?.items ?? []),
    ...frames.filter((f) => f.type === 'upsert').map((f) => f.workspace),
  ].filter((w) => Array.isArray(w?.sessionIds));
  const owning = memberships.find((w) => w.sessionIds.map(String).includes(sessionId));
  return {
    key: owning ? String(owning.workspaceId) : '',
    ungroupped: owning === undefined,
    upsertCarries: frames.some(
      (f) => f.type === 'upsert' && f.workspace.sessionIds.map(String).includes(sessionId)
    ),
  };
}

/** 场景 1：全新 openid 直接发消息（默认开关） */
async function scenarioFirstMessage(): Promise<Record<string, any>> {
  const s = await openScenario();
  try {
    const out: Record<string, any> = {
      defaultWorkspace: s.defaultWorkspace,
      beforeExists: fs.existsSync(s.defaultWorkspace),
      workspacesBefore: (s.ctx.workspaceRegistry as any).list().map((w: any) => String(w.path)),
    };
    console.log(
      `[${PROBE}] 场景1 发消息前：默认工作区存在=${String(out.beforeExists)}，已注册工作区=${JSON.stringify(out.workspacesBefore)}`
    );

    await s.fake.emit({ author: { user_openid: 'probe-first' }, content: '你好，简单回一句话就好' });

    const notice = s.fake.sent.find((m) => m.openid === 'probe-first');
    const target = await s.wiring.control.getTarget('probe-first');
    const workspace = await s.wiring.control.getWorkspace(target.workspaceId ?? '');
    out.noticeText = notice ? payloadText(notice.payload) : null;
    out.noticeIsPlainText = notice ? notice.payload.msg_type === 0 : null;
    out.noticeHasSessionId = notice ? /session-[0-9a-f-]{8}/.test(payloadText(notice.payload)) : null;
    out.target = { sessionId: target.sessionId, workspaceId: target.workspaceId };
    out.workspacePath = workspace?.path ?? null;
    out.workspaceTitle = workspace?.title ?? null;
    out.afterExists = fs.existsSync(s.defaultWorkspace);
    console.log(`[${PROBE}] 场景1 回执 = ${JSON.stringify(out.noticeText)}`);
    console.log(`[${PROBE}] 场景1 落点 = ${String(out.workspacePath)}（目录已建=${String(out.afterExists)}，标题=${String(out.workspaceTitle)}）`);

    const t0 = Date.now();
    while (RUN_TURN && Date.now() - t0 < 180_000) {
      if (s.activity.includes('turn/end')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const afterNotice = s.fake.sent.filter((m) => m.openid === 'probe-first').length - 1;
    out.turn = {
      events: s.activity,
      normalMessagesAfterNotice: afterNotice,
      streamedChunks: s.fake.streamed.length,
      streamedText: s.fake.streamed.map((m) => payloadText(m.payload)).join('').slice(0, 200),
    };
    out.answerReachedQq = afterNotice > 0 || s.fake.streamed.length > 0;
    console.log(
      `[${PROBE}] 场景1 turn 事件=${JSON.stringify(s.activity)}；回答送达 QQ=${String(out.answerReachedQq)}（普通 ${String(afterNotice)} 条 / 流式 ${String(s.fake.streamed.length)} 片）`
    );

    const sessionController: any = s.ctx.get('sessionController');
    if (sessionController?.list) {
      const items = (await sessionController.list(new AbortController().signal))?.items ?? [];
      const summary = items.find((x: any) => String(x.sessionId) === String(target.sessionId));
      out.sessionSummary = summary
        ? { blank: summary.blank, running: summary.running, title: summary.title, cwd: summary.cwd }
        : null;
    }
    out.browserGrouping = owningGroupKey(s.frames, String(target.sessionId));
    console.log(
      `[${PROBE}] 场景1 浏览器分组键=${out.browserGrouping.key || '(未分组)'}，未分组=${String(out.browserGrouping.ungroupped)}`
    );
    return out;
  } finally {
    await s.dispose();
  }
}

/** 场景 2：`allow_create_session=false` → 必须退回 D19/D27 */
async function scenarioSwitchOff(): Promise<Record<string, any>> {
  const s = await openScenario({ allow_create_session: false });
  try {
    await s.fake.emit({ author: { user_openid: 'probe-disabled' }, content: '你好' });
    const reply = s.fake.sent.find((m) => m.openid === 'probe-disabled');
    const target = await s.wiring.control.getTarget('probe-disabled');
    const out = {
      reply: reply ? payloadText(reply.payload) : null,
      targetSessionId: target.sessionId,
      sessionCreated: target.sessionId !== null,
      defaultWorkspaceCreated: fs.existsSync(s.defaultWorkspace),
    };
    console.log(`[${PROBE}] 场景2 开关关闭时回执 = ${JSON.stringify(out.reply)}`);
    return out;
  } finally {
    await s.dispose();
  }
}

async function main(): Promise<void> {
  const first = await scenarioFirstMessage();
  const off = await scenarioSwitchOff();

  const report: Record<string, any> = {
    probe: PROBE,
    ranAt: new Date().toISOString(),
    ranTurn: RUN_TURN,
    firstMessage: first,
    switchOff: off,
    conclusions: {
      'M1 首条消息回一条「只报工作区名」的提示': String(first.noticeText ?? '').includes('未选中会话'),
      'M1 提示为纯文本且不含 session id': first.noticeIsPlainText === true && first.noticeHasSessionId === false,
      'M2 默认工作区惰性创建（发消息前不存在、之后存在）':
        first.beforeExists === false && first.afterExists === true,
      'M2 新会话落点为 $DSH_HOME/workspace/default（非用户主目录）':
        first.workspacePath === first.defaultWorkspace,
      'M3 该消息作为首个 prompt 真的跑出 turn': (first.turn?.events ?? []).includes('turn/end'),
      'M3 回答真的发回 QQ（未被 turn-router 丢弃）': first.answerReachedQq === true,
      'M4 浏览器分组键非空（不落「未分组」）': first.browserGrouping?.ungroupped === false,
      'M5 allow_create_session=false → 不建会话且退回「请先 /会话」':
        off.sessionCreated === false && String(off.reply ?? '').includes('请先 /会话'),
    },
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`\n[${PROBE}] ===== 结论 =====`);
  for (const [k, v] of Object.entries(report.conclusions)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log(`[${PROBE}] 产物：${SUMMARY_PATH}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${PROBE}] 失败：`, err);
    process.exit(1);
  }
);