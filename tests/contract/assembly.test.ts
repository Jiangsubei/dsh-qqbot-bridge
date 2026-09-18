/**
 * 装配契约测试：dsh-qqbot-bridge 的真实闭环（AGENTS.md §3.1）
 *
 * 本文件是本项目的**装配验证**：在真实 `bootDshQqbotBridge` 装配上跑，断言
 *   「零件 → 装配 → 运行路径」完整闭环，而不是"模块自建 mock + 单测全绿"。
 *
 * 唯一被替换的是 **QQ 网络客户端**（`createClient` 注入点）——AGENTS §3.1 明确允许
 * "mock 桩仅用于隔离外部依赖（网络、第三方服务）"。DSH 侧全部为真实服务：
 * 真实 `ctx.agents` / `workspaceRegistry` / `sessionProjections` / `storageDomain` /
 * `settings` / `tools`，真实控制层、真实命令层、真实入站管线、真实串行队列与流管理器。
 *
 * 覆盖：
 *   1. 无凭据 → 离线待机，但**设置面板仍注册**（插件可挂载、可配置）
 *   2. 有凭据 → 完整接线：设置命名空间、工具注册、入站事件监听
 *   3. 运行路径：模拟入站消息 → 管线 → 控制层（未选中态）→ 串行出站 → QQ 客户端
 *   4. `/帮助` 命中命令层并**以纯文本**回执（D34）
 *   5. D36：默认工作区（`$DSH_HOME/workspace/default`）在真实装配上生效（惰性建目录 + 首次直发引导）
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootDshQqbotBridge, type BootedDsh } from '../../src/boot.js';
import { wire, type QqBridgeWiring } from '../../src/index.js';
import { SETTINGS_NAMESPACE } from '../../src/constants/index.js';
import type {
  QqApiResult,
  QqC2CMessageEvent,
  QqClientLike,
  QqMessageHandler,
  QqReadyHandler,
  QqSendMessagePayload,
  QqStreamMessagePayload,
} from '../../src/types/index.js';

// ───────────────────────── 只隔离"QQ 网络"的假客户端 ─────────────────────────

interface SentRecord {
  openid: string;
  payload: QqSendMessagePayload | QqStreamMessagePayload;
}

class FakeQqClient implements QqClientLike {
  readonly sent: SentRecord[] = [];
  readonly streamed: SentRecord[] = [];
  private messageHandlers: QqMessageHandler[] = [];
  private readyHandlers: QqReadyHandler[] = [];
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  async getAccessToken(): Promise<string> {
    return 'fake-token';
  }
  async authHeader(): Promise<Record<string, string>> {
    return { Authorization: 'QQBot fake-token' };
  }
  onC2CMessage(handler: QqMessageHandler): void {
    this.messageHandlers.push(handler);
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
    return { ok: true, status: 200, bytes: new Uint8Array(), contentType: null };
  }

  /** 测试驱动：把一条入站 C2C 事件喂给插件（走真实 onC2CMessage 监听链） */
  async emitC2C(event: Partial<QqC2CMessageEvent>): Promise<void> {
    const full = {
      id: 'msg-1',
      author: { user_openid: 'openid-1' },
      content: '你好',
      timestamp: new Date().toISOString(),
      ...event,
    } as QqC2CMessageEvent;
    for (const handler of this.messageHandlers) await handler(full);
  }
}

/** 结构面读取 settings 服务（避免依赖未声明的 Context 增强） */
function settingsNamespaceRow(ctxHost: object, ns: string): unknown {
  const settings = (ctxHost as { get?: (k: string) => unknown }).get?.('settings') as
    | { get?: (n: string) => unknown }
    | undefined;
  return settings?.get?.(ns);
}

/** 轮询等待条件成立（插件 `apply` 是异步的：`ctx.plugin()` 不 await 其完成） */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/** 结构面读取 tools 服务并查询工具是否注册 */
function toolRegistered(ctxHost: object, name: string): boolean {
  return readTool(ctxHost, name) !== undefined;
}

/** 结构面读取已注册的工具定义（用于断言模型可见的 schema 形状） */
function readTool(
  ctxHost: object,
  name: string
): { parameters?: Record<string, unknown>; output?: { schema?: Record<string, unknown> } } | undefined {
  const tools = (ctxHost as { get?: (k: string) => unknown }).get?.('tools') as
    | { get?: (n: string, scope?: unknown) => unknown }
    | undefined;
  return tools?.get?.(name) as
    | { parameters?: Record<string, unknown>; output?: { schema?: Record<string, unknown> } }
    | undefined;
}

/**
 * 断言工具入参 schema 是**模型 API 能接受**的对象 schema。
 * 真机教训：`ToolRuntime.register()` 会接受缺 `type:'object'` 的属性表，但模型 API 会拒绝
 * （`Invalid schema for function 'send_file': schema must be a JSON Schema of 'type: "object"'`）。
 * 因此这里必须直接断言 schema 形状，而不能只看"注册是否成功"。
 */
function assertModelSafeToolSchema(ctxHost: object, name: string): void {
  const tool = readTool(ctxHost, name);
  expect(tool, `工具 ${name} 未注册`).toBeDefined();
  expect(tool!.parameters?.type, `${name}.parameters.type 必须是 'object'`).toBe('object');
  const required = tool!.parameters?.required;
  expect(Array.isArray(required), `${name}.parameters.required 必须是数组`).toBe(true);
  expect(required as unknown[]).toContain('file_path');
  expect(tool!.output?.schema?.type, `${name}.output.schema.type 必须是 'object'`).toBe('object');
}

// ───────────────────────── 装配套件 ─────────────────────────

describe('装配闭环：dsh-qqbot-bridge（真实 DSH 装配）', () => {
  let booted: BootedDsh;
  let home: string;
  let wiring: QqBridgeWiring | undefined;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqbot-assembly-'));
  });

  afterEach(async () => {
    if (wiring) await wiring.dispose().catch(() => undefined);
    wiring = undefined;
    if (booted) await booted.dispose().catch(() => undefined);
    if (home) await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('1) 无凭据 → 离线待机返回 undefined，但设置面板命名空间仍注册', async () => {
    // 确保环境与 refs 均不提供凭据（临时 DSH_HOME 内无 .credentials.yaml）
    const savedId = process.env.QQ_BOT_APP_ID;
    const savedSecret = process.env.QQ_BOT_SECRET;
    delete process.env.QQ_BOT_APP_ID;
    delete process.env.QQ_BOT_SECRET;
    try {
      booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
      wiring = await wire(booted.ctx, {});
      expect(wiring).toBeUndefined();

      // 设置面板仍注册：插件可挂载、可配置（离线不等于不可用）
      const row = settingsNamespaceRow(booted.ctx as object, SETTINGS_NAMESPACE);
      expect(row).toBeDefined();
    } finally {
      if (savedId !== undefined) process.env.QQ_BOT_APP_ID = savedId;
      if (savedSecret !== undefined) process.env.QQ_BOT_SECRET = savedSecret;
    }
  });

  it('2) 有凭据 → 完整接线：设置命名空间 + send_file/send_image 工具注册 + 客户端被注入', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    expect(wiring).toBeDefined();
    expect(wiring!.client).toBe(fake); // 注入点生效（网络被隔离）
    expect(settingsNamespaceRow(booted.ctx as object, SETTINGS_NAMESPACE)).toBeDefined();
    expect(toolRegistered(booted.ctx as object, 'send_file')).toBe(true);
    expect(toolRegistered(booted.ctx as object, 'send_image')).toBe(true);
    // 真机教训：注册成功 ≠ 模型可用。必须断言 schema 形状。
    assertModelSafeToolSchema(booted.ctx as object, 'send_file');
    assertModelSafeToolSchema(booted.ctx as object, 'send_image');
  });

  it('3) 运行路径：开关关闭时未选中态入站 → 真实管线 → 真实控制层 → 串行出站 → QQ 客户端', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret', allow_create_session: false },
      { createClient: () => fake, autoStart: false }
    );

    await fake.emitC2C({ id: 'msg-inbound-1', author: { user_openid: 'openid-1' }, content: '你好' });

    expect(fake.sent.length).toBeGreaterThanOrEqual(1);
    const first = fake.sent[0]!;
    expect(first.openid).toBe('openid-1');
    // `allow_create_session=false` 时退回 D19/D27：只提示、不建会话、不转发给 agent
    expect(first.payload.msg_type).toBe(0);
    expect(String(first.payload.content ?? '')).toContain('请先');
    expect(String(first.payload.content ?? '')).toContain('/会话');
    expect((await wiring!.control.getTarget('openid-1')).sessionId).toBeNull();
  });

  it('7) D36：无参数 createSession 在真实装配上落到 $DSH_HOME/workspace/default（不落用户主目录）', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    const expected = path.join(home, 'workspace', 'default');
    expect(fs.existsSync(expected)).toBe(false); // 惰性：没用到之前不创建

    const created = await wiring!.control.createSession('openid-default');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(fs.statSync(expected).isDirectory()).toBe(true);
    const workspace = await wiring!.control.getWorkspace(created.workspaceId);
    expect(workspace?.path).toBe(expected);
    expect((await wiring!.control.getTarget('openid-default')).sessionId).toBe(created.sessionId);
  });

  it('8) D36：默认（开关开）下列表里的第一条普通消息 → 自动新建 + 只报工作区名的提示 + 转发', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    await fake.emitC2C({ id: 'msg-first', author: { user_openid: 'openid-3' }, content: '你好' });

    const first = fake.sent.find((r) => r.openid === 'openid-3');
    expect(first).toBeDefined();
    const text = String(first!.payload.content ?? '');
    expect(text).toContain('未选中会话');
    expect(text).toContain('default');
    expect(text).not.toMatch(/session-[0-9a-f-]{8}/); // 按用户决定：提示不带 session id

    // 真实控制目标已被钉到新会话，且落在默认工作区
    const target = await wiring!.control.getTarget('openid-3');
    expect(target.sessionId).not.toBeNull();
    const workspace = await wiring!.control.getWorkspace(target.workspaceId ?? '');
    expect(workspace?.path).toBe(path.join(home, 'workspace', 'default'));
  });

  it('4) `/帮助` 命中命令层，并以纯文本（msg_type=0）回执（D34）', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    await fake.emitC2C({ id: 'msg-help', author: { user_openid: 'openid-2' }, content: '/帮助' });

    const replies = fake.sent.filter((r) => r.openid === 'openid-2');
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const text = String(replies[0]!.payload.content ?? '');
    expect(replies[0]!.payload.msg_type).toBe(0); // D34：命令回执纯文本
    expect(text).toContain('/会话');
    expect(text).toContain('/切换');
  });

  it('5) 启动路径：默认 autoStart 下客户端被真实启动（守住 DSH 无 ready 事件的实测结论）', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    expect(fake.started).toBe(false);
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake } // 默认 autoStart=true
    );
    // DSH 0.1.5 无 'ready' 事件：客户端必须在 apply 内启动，不能依赖该事件
    if (fake.started === false) {
      // 允许 start() 是异步落地：短暂等待后再断言
      await waitFor(() => fake.started, 1_000);
    }
    expect(fake.started).toBe(true);
  });

  it('6) 插件可被真实装配挂载（mountPlugin: true 不抛错）', async () => {
    booted = await bootDshQqbotBridge({
      dshHome: home,
      mountPlugin: true,
      config: { app_id: 'test-app-id', app_secret: 'test-app-secret' },
    });
    expect(booted.ctx).toBeDefined();
    // `ctx.plugin()` 不 await 异步 `apply`：轮询等待设置面板注册完成
    const registered = await waitFor(() => settingsNamespaceRow(booted.ctx as object, SETTINGS_NAMESPACE) !== undefined);
    expect(registered).toBe(true);
  });

  it('9) D46：会话活跃元数据服务缺席时 /会话 走降级——仍可用、空白会话豁免、绝不印「未知」', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });

    // 前提：本装配（base-only 测试 boot）确实没有 `api-session-controller` ⇒ 命中降级路径。
    // 若哪天 base 也挂了它，这条会红，提醒同步调整本用例的前提与断言。
    const ctxHost = booted.ctx as { get?: (key: string) => unknown };
    expect(ctxHost.get?.('sessionController')).toBeUndefined();

    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    // 真实创建：新会话是 blank（无 turn/start），且 createSession 会把它设为当前控制目标
    const created = await wiring!.control.createSession('openid-d46');
    expect(created.ok).toBe(true);

    await fake.emitC2C({ id: 'msg-list-d46', author: { user_openid: 'openid-d46' }, content: '/会话' });
    const reply = String(fake.sent.at(-1)?.payload.content ?? '');

    expect(reply).toContain('当前工作区会话');
    // 降级路径**拿不到 blank** ⇒ 不能凭空把无标题会话标成「新会话」，也不能因此隐藏它：
    // 保留改动前的短 id 兜底（不引入新的谎），仅省略时间片段。
    expect(reply).toMatch(/(^|\n)1\. session-[0-9a-f]{4}…\n/);
    // 降级：没有时间元数据就整段省略；绝不出现旧的「最后活跃 未知」
    expect(reply).not.toContain('最后活跃');
    expect(reply).not.toContain('未知');
  });

  it('10) D46：sessionController.list 必须保留 this（裸取方法会丢 this → 被降级静默吞掉）', async () => {
    // 真实探针 SESSION-LIST 抓到过这个 bug：`optionalService(...)?.list` 裸取方法 →
    // 调用时 `this` 丢失 → 抛错 → 控制层降级 → `/会话` 静默失去时间与空白过滤。
    // 这里在真实装配上注入一个「依赖 this」的桩，把该行为钉死。
    const items: Array<{ sessionId: string; updatedAt: number; blank: boolean }> = [];
    const service = {
      items,
      selectModel: async () => undefined,
      async list(this: { items: typeof items } | undefined) {
        if (this?.items === undefined) throw new TypeError('sessionController.list lost its receiver');
        return { items: this.items };
      },
    };

    booted = await bootDshQqbotBridge({
      dshHome: home,
      mountPlugin: false,
      prepare: (hostCtx) => {
        (hostCtx as unknown as { provide: (k: string, v: unknown) => void }).provide('sessionController', service);
      },
    });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    const created = await wiring!.control.createSession('openid-d46b');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 空白 + 当前受控 + 刚刚活跃 → 期望 WebUI 同款豁免与标签，且时间来自我们注入的 updatedAt
    items.push({ sessionId: created.sessionId, updatedAt: Date.now(), blank: true });

    await fake.emitC2C({ id: 'msg-list-d46b', author: { user_openid: 'openid-d46b' }, content: '/会话' });
    const reply = String(fake.sent.at(-1)?.payload.content ?? '');

    expect(reply).toContain('共 1 条');
    expect(reply).toMatch(/(^|\n)1\. （新会话） 刚刚\n/);
  });

  it('11) D49：回合归属的基石——user/message 事件里的 id 就是本桥接投喂的那条', async () => {
    booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
    const fake = new FakeQqClient();
    wiring = await wire(
      booted.ctx,
      { app_id: 'test-app-id', app_secret: 'test-app-secret' },
      { createClient: () => fake, autoStart: false }
    );

    const created = await wiring!.control.createSession('openid-d49');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 尚未投喂任何消息 ⇒ 不属于 QQ 回合（此时 WebUI 驱动的回合不该出站）
    expect(wiring!.isOwnTurn(created.sessionId)).toBe(false);

    // 捕获真实 `user/message` 事件：其 data **就是**投喂时创建的 UserMessage
    //（【文档明写】`dsh-session/lib/types/types.d.ts:281`）
    const messageIds: string[] = [];
    const ctxOn = booted.ctx as unknown as {
      on: (event: string, handler: (...a: unknown[]) => unknown) => unknown;
    };
    const off = ctxOn.on('session/event', (...args: unknown[]) => {
      const session = args[0] as { id?: string } | undefined;
      const event = args[1] as { type?: string; data?: { id?: unknown } } | undefined;
      if (event?.type === 'user/message' && session?.id === created.sessionId && typeof event.data?.id === 'string') {
        messageIds.push(event.data.id);
      }
    });

    const sent = await wiring!.control.send('openid-d49', 'D49 归属探针');
    expect(sent.ok).toBe(true);
    await waitFor(() => messageIds.length > 0);
    if (typeof off === 'function') (off as () => void)();

    // U1 前提**实测**（不是推断）：事件里的 Message.id 确实等于桥接记录的那条
    expect(messageIds.length).toBeGreaterThan(0);
    expect(wiring!.control.isOwnMessage(messageIds[0]!)).toBe(true);
    expect(wiring!.control.isOwnMessage('not-ours')).toBe(false);
    // 生产接线生效：投喂之后该会话被判定为「QQ 回合」
    expect(wiring!.isOwnTurn(created.sessionId)).toBe(true);
  });

  it('12) 核心 Bug 修复契约：当入参 config 为空、凭据来自 settings.yaml（面板填写）时能成功上线', async () => {
    // 确保环境不提供凭据
    const savedId = process.env.QQ_BOT_APP_ID;
    const savedSecret = process.env.QQ_BOT_SECRET;
    delete process.env.QQ_BOT_APP_ID;
    delete process.env.QQ_BOT_SECRET;
    try {
      // 预先写入 settings.yaml
      const settingsYamlPath = path.join(home, 'settings.yaml');
      await fsp.writeFile(
        settingsYamlPath,
        `dsh-qqbot-bridge:\n  app_id: 'panel-app-id'\n  app_secret: 'panel-app-secret'\n`,
        'utf8'
      );

      booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
      const fake = new FakeQqClient();

      wiring = await wire(booted.ctx, {}, { createClient: () => fake, autoStart: false });

      expect(wiring).toBeDefined();
      expect(wiring!.client).toBe(fake);
    } finally {
      if (savedId !== undefined) process.env.QQ_BOT_APP_ID = savedId;
      if (savedSecret !== undefined) process.env.QQ_BOT_SECRET = savedSecret;
    }
  });

  it('13) 迟到凭据契约：插件初始离线待机，用户在面板填写保存后（settings 更新）自动热上线', async () => {
    const savedId = process.env.QQ_BOT_APP_ID;
    const savedSecret = process.env.QQ_BOT_SECRET;
    delete process.env.QQ_BOT_APP_ID;
    delete process.env.QQ_BOT_SECRET;
    try {
      booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
      const fake = new FakeQqClient();

      // 初始无凭据，处于离线待机
      wiring = await wire(booted.ctx, {}, { createClient: () => fake, autoStart: false });
      expect(wiring).toBeUndefined();

      // 模拟用户在设置面板填入凭据并保存（通过 settings.update）
      const settingsService = booted.ctx.get('settings') as {
        update: (ns: string, patch: object) => Promise<void>;
      };
      expect(settingsService).toBeDefined();

      await settingsService.update(SETTINGS_NAMESPACE, {
        app_id: 'late-app-id',
        app_secret: 'late-app-secret',
      });

      // 等待 Reconciler 监听到变化并自动上线
      const online = await waitFor(() => fake.started, 2000);
      expect(online).toBe(true);
    } finally {
      if (savedId !== undefined) process.env.QQ_BOT_APP_ID = savedId;
      if (savedSecret !== undefined) process.env.QQ_BOT_SECRET = savedSecret;
    }
  });
});