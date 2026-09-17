/**
 * dsh-qqbot-bridge — 插件入口（**只做接线，不写业务逻辑**；AGENTS.md §6 约束）
 *
 * 装配链路：
 *   QQ WS/REST ─▶ QqClient ─▶ InboundPipeline（审批→提问→分页→命令→未选中检查→agent）
 *                                  │                                   │
 *                                  │                          ControlService（接管 DSH 会话）
 *                                  ▼                                   ▼
 *                        QqInteractions（审批/提问）        agent/assistant-stream
 *                                                                      │
 *                                                         TurnRouter ─▶ StreamManager ─▶ QQ stream_messages
 *
 * 关键实测依据见 `docs/调研纪要-第一期探针结论.md`：
 *   E11-1 root 可见 agent/assistant-stream；E11-4 只放行 text-delta；E12-A 同进程复用 live agent；
 *   E2-2 流式占一个 msg_seq 槽位；E7 分片上传 1-based index + 每片 block_size；E8 裸 GET 下载附件。
 *
 * `wire()` 与 `apply()` 分离：`apply()` 是 Cordis 入口；`wire()` 返回接线对象，
 * 便于装配契约测试在**真实 DSH 装配**上逐项断言（AGENTS.md §3.1），并允许隔离外部网络。
 */

import * as os from 'node:os';

import { Context } from '@deepseek-ai/cordis';

import { PLUGIN_NAME, SETTINGS_NAMESPACE, QQ_MSG_TYPE_TEXT } from './constants/index.js';
import { PluginConfigSchema } from './config/schema.js';
import { resolveCredentials, resolveDshHome } from './config/credentials.js';
import { resolveLogger, type Logger } from './utils/logger.js';
import { QqClient } from './qq/client.js';
import { QqMarkdownAdapter } from './qq/markdown.js';
import { MsgSeqSlotAllocator, QqStreamManager } from './qq/stream.js';
import { QqMediaReceiver } from './qq/media-in.js';
import { QqMediaSender } from './qq/media-out.js';
import { PerPeerSerialSender } from './outbound/queue.js';
import { TurnRouter } from './outbound/turn-router.js';
import { createTurnAnchors } from './dsh/anchors.js';
import { openControlService, type ControlContext } from './dsh/control.js';
import { resolveDefaultWorkspacePath } from './dsh/workspaces.js';
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { createPagingStore } from './commands/paging.js';
import {
  createCommandDispatcher,
  type OfficialModelService,
  type OfficialPermissionService,
} from './commands/dispatch.js';
import { createInboundPipeline } from './inbound/pipeline.js';
import { QqInteractions } from './inbound/interactions.js';
import { registerAgentTools } from './tools/index.js';
import { t } from './i18n/index.js';
import type {
  ControlService,
  InboundPipeline,
  OutboundTarget,
  PluginConfig,
  QqC2CMessageEvent,
  QqClientLike,
  QqCredential,
  StreamManager,
} from './types/index.js';

export const name = PLUGIN_NAME;

/**
 * fiber 级 inject：四个必需服务在 dsh-base 装配中均存在（T3 契约测试已实测）。
 * 其余服务（settings / llm / sessionController / permissionPresets / sessions / tools …）
 * **按需显式判定**，不做 `ctx.get('x') || (ctx as any).x` 双兜底。
 */
export const inject = ['agents', 'workspaceRegistry', 'sessionProjections', 'storageDomain'];

export const Config = PluginConfigSchema;

// ────────────────────── 最小结构服务面（避免依赖未声明的 Context 增强） ──────────────────────

interface SessionsLike {
  get(id: string): unknown;
}
interface PermissionPresetsLike {
  readonly names: readonly string[];
  set(session: unknown, name: string): void;
}
interface LlmLike {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(
    provider: string,
    model: string
  ): Promise<{
    reasoning?: {
      efforts: ReadonlyArray<{ id: string; name: string; description?: string }>;
      defaultEffort?: string;
    };
  }>;
}
/**
 * 官方 `SessionSummary` 的展示子集（D46）
 * 【文档明写】`dsh-api-session-controller/lib/types/types.d.ts:145-154`。
 */
interface SessionSummaryLike {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly blank: boolean;
  readonly origin?: 'subagent';
}
interface SessionControllerLike {
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>;
  /**
   * D46：读全部可见会话摘要（WebUI 侧边栏同源数据）。**可选**——服务或该方法缺席时
   * 控制层自动降级（`/会话` 不显示时间、不过滤空白会话），功能不受影响。
   */
  list?(
    request: { readonly cursor?: string },
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly SessionSummaryLike[] }>;
}

/** 必需服务缺失即大声失败（装配问题不能静默） */
function requireService<T>(ctx: Context, key: string): T {
  const value = ctx.get(key as never) as T | undefined;
  if (value === undefined) {
    throw new Error(`${PLUGIN_NAME}: 装配缺少必需服务「${key}」（应在 inject 中声明）`);
  }
  return value;
}

/** 可选服务：缺失返回 undefined（调用方决定降级行为），不抛错 */
function optionalService<T>(ctx: Context, key: string): T | undefined {
  try {
    return (ctx.get(key as never) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/** `wire()` 的测试/诊断注入点（仅用于隔离外部依赖，不替代装配验证） */
export interface QqBridgeWireOptions {
  /** 替换 QQ 客户端（契约测试用；生产路径缺省为真实 `QqClient`） */
  createClient?: (options: { credentials: QqCredential; logger: Logger }) => QqClientLike;
  /** 是否注册 `ctx.on('ready')` 自动启动（契约测试置 false，避免真实网络） */
  autoStart?: boolean;
}

/** `wire()` 的接线结果，供装配契约测试逐项断言 */
export interface QqBridgeWiring {
  client: QqClientLike;
  control: ControlService;
  pipeline: InboundPipeline;
  router: TurnRouter;
  streams: StreamManager;
  interactions: QqInteractions;
  /**
   * D49：该会话**当前回合**是否由本桥接投喂（回合归属）。供装配契约测试断言接线真实生效：
   * 未投喂前为 `false`，本桥接 `control.send()` 之后为 `true`。
   */
  isOwnTurn(sessionId: string): boolean;
  /** 释放全部接线（幂等） */
  dispose(): Promise<void>;
}

function runDisposers(disposers: Array<() => void>): void {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // 清理阶段不得因单个失败中断其余清理
    }
  }
}

/**
 * 完成全部接线。凭据缺失时返回 `undefined`（离线待机，插件仍挂载并注册设置面板）。
 */
export async function wire(
  ctx: Context,
  config: PluginConfig = {},
  options: QqBridgeWireOptions = {}
): Promise<QqBridgeWiring | undefined> {
  const logger: Logger = resolveLogger(ctx, PLUGIN_NAME);
  let currentConfig = (): PluginConfig => config;

  // ── 1. 设置面板（注册配置命名空间与模式） ──
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as unknown as { settings?: { installSection?: (...a: unknown[]) => void } }).settings;
    if (!settings?.installSection) {
      logger.warn('settings 服务不可用：配置面板未注册（插件仍按传入/默认配置运行）');
      return;
    }
    settings.installSection(ctx, SETTINGS_NAMESPACE, PluginConfigSchema, config, {
      setSource: (source: () => PluginConfig) => {
        currentConfig = () => ({ ...config, ...(source() ?? {}) });
      },
      onChange: () => {
        logger.info('配置已更新（连接类改动需重启插件生效）');
      },
    });
  });

  const cfg = currentConfig();

  // ── 2. 凭据：缺失则进入"离线待机"（不阻断插件挂载） ──
  const dshHome = resolveDshHome();
  const { credential, reason } = resolveCredentials(cfg, { dshHome });
  if (!credential) {
    logger.warn(`QQ 凭据缺失，插件处于离线待机：${reason}`);
    return undefined;
  }

  const disposers: Array<() => void> = [];

  // ── 3. 协议客户端与出站基础设施 ──
  const client =
    options.createClient?.({ credentials: credential, logger }) ??
    new QqClient({ credentials: credential, logger });
  const markdown = new QqMarkdownAdapter();
  const slots = new MsgSeqSlotAllocator();
  const sender = new PerPeerSerialSender();
  /**
   * 发普通消息前先等该 peer 的正文流处理完（防截断，见 `QqStreamManagerOptions.settleStream`）。
   * 由下方 turn-router 装配后赋值——两者互相依赖（router 需要 streams），故用闭包间接引用。
   */
  let settleStreamPeer: (openid: string) => Promise<void> = async () => undefined;
  const streams = new QqStreamManager({
    client,
    markdown,
    sender,
    slots,
    settleStream: (openid) => settleStreamPeer(openid),
    ...(cfg.stream_throttle_ms !== undefined ? { throttleMs: cfg.stream_throttle_ms } : {}),
    logger,
  });
  const mediaSender = new QqMediaSender({ client, logger, slots });
  const mediaReceiver = new QqMediaReceiver({
    client,
    logger,
    ...(cfg.media_dir ? { mediaDir: cfg.media_dir } : {}),
    dshHome,
    ...(cfg.media_max_bytes !== undefined ? { maxBytes: cfg.media_max_bytes } : {}),
  });

  // ── 4. 控制层（接管 DSH 已有会话；D28 启动恢复） ──
  const permissionPresets = optionalService<PermissionPresetsLike>(ctx, 'permissionPresets');
  const sessionTitle = optionalService(ctx, 'sessionTitle');
  const sessionQuery = optionalService(ctx, 'sessionQuery');
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel');
  const agentPresets = optionalService(ctx, 'agentPresets');
  const tokenMeter = optionalService(ctx, 'tokenMeter');
  // `/压缩`（D44）直调的官方压缩服务（由 dsh-base 的 compaction-basic 装载；缺失时如实回「不可用」）
  const compaction = optionalService<CompactionEngine>(ctx, 'compaction');
  /**
   * D46：会话活跃元数据（时间 / 空白 / origin）——官方 `sessionController.list()`
   * 就是 WebUI 侧边栏的数据源（`SessionSummary.updatedAt/blank/origin`）。
   *
   * ⚠️ **必须用 `ctx.inject` 动态注入，不能在 `apply()` 里用 `ctx.get` 读一次**。
   * 这是**时序**问题（不是 isolate 隔离）：插件 `apply()` 执行得很早，后挂载的服务此刻尚未注册，
   * `ctx.get` 只返回**当时**的快照。真机探针 SESSION-LIST 的替身 bundle（与本插件同位置、同静态
   * `inject`）实测：
   *   - `apply` 时刻：`sessionController` 等**全部**服务都是 `undefined`；
   *   - `apply+2s`：**普通 `ctx.get` 已能拿到** `sessionController` ⇒ 证明**没有隔离边界**，
   *     只是 apply 时还没装配好。本插件静态 `inject` 里的 4 个必需服务则因注入被 cordis 等待；
   * ⇒ 旧实现把 `optionalService(ctx,'sessionController')` 读在 `apply()` 里，于是**永远读不到**，
   * 表现为「时间与空白过滤整体失效」。`ctx.inject` 让 cordis 在该服务可用后再执行回调。
   *
   * 不用静态 `inject` 数组：`sessionController` 在 headless / base-only 装配里**不存在**，
   * 放进静态 inject 会让插件永远等待、`apply` 不执行。动态注入只在该服务出现时接线，
   * 缺席则永不回调（控制层降级：不显示时间、不过滤空白，功能不受影响）。
   */
  let activitySource: ControlContext['sessionActivity'];
  ctx.inject(['sessionController'], (scCtx) => {
    const controller = (scCtx as unknown as { sessionController?: SessionControllerLike }).sessionController;
    // ⚠️ 必须 `bind`：裸取 `?.list` 会丢 `this`，调用即抛（探针 SESSION-LIST 抓到过这个降级静默）
    const list = controller?.list?.bind(controller);
    if (list === undefined) return;
    activitySource = {
      async list() {
        const value = await list({}, new AbortController().signal);
        return value.items.map((item) => ({
          sessionId: String(item.sessionId),
          updatedAt: item.updatedAt,
          blank: item.blank,
          ...(item.origin !== undefined ? { origin: item.origin } : {}),
        }));
      },
    };
  });
  /**
   * 稳定的转发对象：注入回调可能在 `openControlService` 之后才执行，因此**调用时**才读取
   * `activitySource`；未接线时返回空表（控制层据此降级）。
   */
  const sessionActivity: ControlContext['sessionActivity'] = {
    async list() {
      return activitySource === undefined ? [] : activitySource.list();
    },
  };

  const controlCtx: ControlContext = {
    workspaceRegistry: requireService(ctx, 'workspaceRegistry'),
    agents: requireService(ctx, 'agents'),
    sessionProjections: requireService(ctx, 'sessionProjections'),
    storageDomain: requireService(ctx, 'storageDomain'),
    ...(permissionPresets ? { permissionPresets: permissionPresets as unknown as ControlContext['permissionPresets'] } : {}),
    ...(sessionTitle ? { sessionTitle: sessionTitle as ControlContext['sessionTitle'] } : {}),
    ...(sessionQuery ? { sessionQuery: sessionQuery as ControlContext['sessionQuery'] } : {}),
    ...(agentDefaultModel ? { agentDefaultModel: agentDefaultModel as ControlContext['agentDefaultModel'] } : {}),
    ...(agentPresets ? { agentPresets: agentPresets as unknown as ControlContext['agentPresets'] } : {}),
    ...(tokenMeter ? { tokenMeter: tokenMeter as ControlContext['tokenMeter'] } : {}),
    ...(compaction ? { compaction } : {}),
    ...(sessionActivity !== undefined ? { sessionActivity } : {}),
    logger,
  };
  const opened = await openControlService(controlCtx, {
    homeDir: os.homedir(),
    // D36：默认工作区 —— 配置留空时用内置 `$DSH_HOME/workspace/default`
    //（惰性 mkdir -p + 注册工作区，由 createSession 完成；不会落到用户主目录）
    defaultWorkspacePath: (cfg.default_workspace ?? '').trim() || resolveDefaultWorkspacePath(dshHome),
    restoreOnStart: true,
  });
  const control = opened.control;
  logger.info(`控制层就绪：启动恢复 ${opened.restore.targets.length} 条目标`);
  /** D36：`allow_create_session`（默认 true）——同时管住 `/新建` 与未选中态的自动新建 */
  const allowCreateSession = cfg.allow_create_session !== false;

  // ── 5. openid ↔ sessionId 归属与回复锚点（turn-router / 交互层 / 工具都要用） ──
  const lastInbound = new Map<string, OutboundTarget>(); // openid -> 最近一条入站锚点
  /**
   * 「谁当前控制该会话」——**权威来源是控制目标表**（`control.findControlOwner`），
   * 不是历史映射。
   *
   * D49 修掉的真实缺陷：此前这里是一张 **只写不删** 的 `sessionOwner` 映射
   * （写于 `onSessionSelected` 与每条入站消息，全仓无 delete/clear）⇒ 用户 `/会话` 切走之后，
   * 旧会话在 WebUI 里说话仍会被出站到 QQ。D40 早已把**卡片**判据换成 `findControlOwner`，
   * 但**正文出站没换**，`tests/contract/dsh-control.test.ts:209` 的注释也点名过这张历史映射。
   */
  const openidOf = (sessionId: string): string | undefined => control.findControlOwner(sessionId);

  /**
   * D49：**回合归属**（sessionId → 当前 turn 是否由本桥接投喂）。
   *
   * 官方没有「回合发起方 / prompt 来源」字段（`ApprovalRequestEvent`/`AskUserQuestionRequestEvent`
   * 载荷都不带来源；`lastPromptAt` 的 `source.kind === 'user'` 对 WebUI 与 QQ 完全同质），
   * 所以只能桥接侧自记：投喂时记下 `Message.id`（官方明写跨表示边界稳定），
   * 再用 `'user/message'` 事件的 data（就是那个 `UserMessage`）对拍。
   *
   * 规则：由最后一条 user/message 决定回合归属。WebUI 发起的回合在 QQ 侧保持静默。
   */
  const turnOrigin = new Map<string, 'qq' | 'other'>();
  const isOwnTurn = (sessionId: string): boolean => turnOrigin.get(sessionId) === 'qq';

  /**
   * turn 级回复锚点（N9，`src/dsh/anchors.ts`）。
   * 入站消息先 `trackPending` 排队，`session/event` 的 `turn/start` 把它锚定到该 turn；
   * 出站优先取活跃 turn 的锚点，取不到再回退"最近一条入站"。
   * 这样多条消息排队时，每个 turn 的引用/@ 前缀都能绑到**它自己那条**入站消息。
   */
  const anchors = createTurnAnchors();
  const resolveTarget = (openid: string): OutboundTarget | undefined =>
    anchors.active(openid) ?? lastInbound.get(openid);

  type EventCtx = { on(event: string, handler: (...args: unknown[]) => unknown): unknown };
  const eventCtx = ctx as unknown as EventCtx;
  const offTurnStart = eventCtx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as { type?: string; data?: { turn?: number } } | undefined;
    if (event?.type !== 'turn/start') return;
    const openid = session?.id ? openidOf(session.id) : undefined;
    const turn = event.data?.turn;
    if (openid && typeof turn === 'number') anchors.onTurnStart(openid, turn);
  });
  disposers.push(() => {
    if (typeof offTurnStart === 'function') (offTurnStart as () => void)();
    anchors.clear();
  });

  /**
   * D49：回合归属监听 —— `'user/message'` 事件的 data **就是**投喂时创建的那个 `UserMessage`
   *（【文档明写】`dsh-session/lib/types/types.d.ts:281`），用 `Message.id` 对拍即可判定这个 turn
   * 是不是 QQ 投喂的。官方没有来源字段（载荷级证据见 `isOwnTurn` 注释），这是唯一可靠判据。
   */
  const offUserMessage = eventCtx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as
      | { type?: string; data?: { id?: unknown; source?: { kind?: unknown } } }
      | undefined;
    if (event?.type !== 'user/message' || !session?.id) return;
    // ⚠️ 只把**真人 prompt**（`source.kind === 'user'`）算作回合来源。真机装配测试抓到：
    //    每回合 DSH 还会注入一条 `source.kind === 'plugin'` 的 **system-prompt 快照**
    //    （`@deepseek-ai/dsh-system-prompt`，同为 `user/message`）——它不是 prompt 来源，
    //    若算进来会立刻把归属翻成「非 QQ」，导致 QQ 自己的回合也不出站。
    //    谓词与官方 `lastPromptAt` 完全一致（`dsh-api-session-controller/lib/types/list.js:28-36`）。
    if (event.data?.source?.kind !== 'user') return;
    const messageId = event.data.id;
    if (typeof messageId !== 'string') {
      logger.warn(`user/message 缺消息 id，无法判定回合归属（session ${session.id}）`);
      return;
    }
    turnOrigin.set(session.id, control.isOwnMessage(messageId) ? 'qq' : 'other');
  });
  disposers.push(() => {
    if (typeof offUserMessage === 'function') (offUserMessage as () => void)();
    turnOrigin.clear();
  });

  const reply = async (target: OutboundTarget, text: string): Promise<void> => {
    const res = await streams.sendSerialized(target, { msg_type: QQ_MSG_TYPE_TEXT, content: text });
    if (!res.ok) {
      logger.warn(`回执发送失败 code=${String(res.code ?? '')} ${res.message ?? ''}`);
    }
  };

  // ── 6. 远端交互（审批 / 提问；设计文档 §4 前两层） ──
  const interactions = new QqInteractions({
    sendText: async (openid, text) => {
      // 投递通道设计：**锚点优先**
      //   - 活跃 turn 锚点 → 最近一条入站消息（`OutboundTarget.msgId`）⇒ 走**被动回复**；
      //     真机实测（logs/probe/ACTIVE-MESSAGE-*.summary.json）：4.4 小时前的入站 msg_id 仍可用，
      //     且同一 msg_id 连发 20 条不触发 40034128 ⇒ 锚点覆盖绝大多数场景。
      //   - 无锚点（重启后该 openid 尚未发过消息）⇒ 降级为**主动消息**（已实测可发）。
      //     这是 D6「不做主动消息」的**显式例外**：仅用于审批/提问这类**阻塞型**交互——
      //     不发则 agent 一直阻塞到超时并 fail-closed，用户手机上毫无提示。
      const anchor = resolveTarget(openid);
      if (anchor?.msgId) return reply(anchor, text);
      logger.warn(
        `[interactions] openid=${openid.slice(0, 8)}… 无入站锚点，降级为主动消息投递交互卡片（D6 例外）`,
      );
      return reply({ openid }, text);
    },
    // 判定依据是「该会话此刻是否为某 openid 的控制目标」，不是历史映射
    controlledBy: (sessionId) => control.findControlOwner(sessionId),
    // 只有本桥接发起的 turn 才处理交互卡片；WebUI 发起的回合委派回 WebUI
    ownTurn: isOwnTurn,
    logger,
  });
  disposers.push(interactions.attach(ctx));

  // ── 7. 命令层 + 入站管线（paging 必须与 dispatcher 共用同一实例） ──
  const paging = createPagingStore();
  const models: OfficialModelService = {
    async list() {
      const llm = optionalService<LlmLike>(ctx, 'llm');
      if (!llm) return [];
      const out: Array<{ provider: string; model: string; name?: string }> = [];
      for (const provider of llm.listProviders()) {
        try {
          for (const model of await llm.listModels(provider.id)) {
            out.push({ provider: provider.id, model: model.id, ...(model.name ? { name: model.name } : {}) });
          }
        } catch (err: unknown) {
          logger.warn(`列举 provider ${provider.id} 的模型失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return out;
    },
    async select(sessionId, selection) {
      const sc = optionalService<SessionControllerLike>(ctx, 'sessionController');
      if (!sc?.selectModel) throw new Error('sessionController 不可用，无法切换模型');
      await sc.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      });
    },
    async reasoning(provider, model) {
      const llm = optionalService<LlmLike>(ctx, 'llm');
      if (!llm?.resolveModelInfo) return { supported: false, efforts: [] };
      const info = await llm.resolveModelInfo(provider, model);
      const reasoning = info?.reasoning;
      if (!reasoning || reasoning.efforts.length === 0) return { supported: false, efforts: [] };
      return {
        supported: true,
        efforts: reasoning.efforts.map((e) => ({
          id: e.id,
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
        })),
        ...(reasoning.defaultEffort ? { defaultEffort: reasoning.defaultEffort } : {}),
      };
    },
  };
  const permissions: OfficialPermissionService = {
    async list() {
      return permissionPresets ? [...permissionPresets.names] : [];
    },
    async set(sessionId, preset) {
      if (!permissionPresets) throw new Error('permissionPresets 不可用，无法切换权限预设');
      const sessions = optionalService<SessionsLike>(ctx, 'sessions');
      const session = sessions?.get(sessionId);
      if (!session) throw new Error(`找不到会话 ${sessionId}，无法切换权限预设`);
      permissionPresets.set(session, preset);
    },
  };

  const commands = createCommandDispatcher({
    control,
    paging,
    logger,
    models,
    permissions,
    allowCreateSession,
    ...(cfg.reply_max_chars !== undefined ? { replyMaxChars: cfg.reply_max_chars } : {}),
    ...(cfg.list_page_size !== undefined ? { listPageSize: cfg.list_page_size } : {}),
    ...(cfg.status_show_usage !== undefined ? { statusShowUsage: cfg.status_show_usage } : {}),
  });
  const pipeline = createInboundPipeline({
    approval: interactions.approval,
    question: interactions.question,
    paging,
    commands,
    control,
    streams,
    media: mediaReceiver,
    markdown,
    reply,
    allowCreateSession,
    // D49：不再需要「自动新建后补写 sessionId→openid 映射」——归属改由控制目标表权威反查
    // （`openidOf` = `control.findControlOwner`），`createSession` 本身就会设定控制目标。
    logger,
  });

  // ── 8. DSH 流式事件 → QQ 出站（turn-router） ──
  const router = new TurnRouter({ streams, openidOf, resolveTarget, ownTurn: isOwnTurn, logger });
  // 接线：普通消息（审批/提问卡片、命令回执）收流前，先等该 peer 的正文增量推完
  settleStreamPeer = (openid) => router.drainPeer(openid);
  disposers.push(router.attach(eventCtx));

  // ── 9. Agent 工具：send_file / send_image ──
  disposers.push(
    registerAgentTools(ctx, {
      media: mediaSender,
      resolveTarget: (exec) => {
        const sessionId = exec.agent?.session?.id;
        const openid = sessionId ? openidOf(sessionId) : undefined;
        return openid ? lastInbound.get(openid) : undefined;
      },
      logger,
    })
  );

  // ── 10. 入站消息入口 ──
  client.onC2CMessage(async (event: QqC2CMessageEvent) => {
    const openid = event?.author?.user_openid;
    const msgId = event?.id;
    if (!openid || !msgId) {
      logger.warn('入站消息缺少 openid 或 msg_id，已丢弃');
      return;
    }
    const target: OutboundTarget = { openid, msgId };
    lastInbound.set(openid, target);
    anchors.trackPending(msgId, openid, target);

    // D49：归属/出站判据都改为**实时反查控制目标表**（`openidOf` / `isOwnTurn`），
    // 因此这里不再需要维护任何历史映射（旧实现每次入站都往 sessionOwner 写一条、永不清理）。

    try {
      await pipeline.handle(event);
    } catch (err: unknown) {
      logger.error('入站管线处理失败', err);
      const message = err instanceof Error ? err.message : String(err);
      await reply({ openid, msgId }, t('inbound.handlingFailed', { message })).catch(() => undefined);
    }
  });
  client.onReady((info) => {
    logger.info(`机器人已上线：${info.botName}(${info.botId})`);
  });

  // ── 11. 生命周期 ──
  if (options.autoStart !== false) {
    // DSH 插件在 apply 执行时服务已注入完毕，客户端在此直接启动并进入连接循环。
    void client.start().catch((err: unknown) => logger.error('启动 QQ 客户端失败', err));
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    runDisposers(disposers);
    client.stop();
    await router.drain().catch(() => undefined);
    await opened.dispose().catch((err: unknown) => logger.error('释放控制层失败', err));
  };

  eventCtx.on('dispose', () => {
    void dispose();
    logger.info('插件已卸载');
  });

  return { client, control, pipeline, router, streams, interactions, isOwnTurn, dispose };
}

/**
 * Cordis 插件入口。`apply` 只做接线与生命周期登记（业务逻辑全在 `wire()` 装配的模块里）。
 */
export async function apply(ctx: Context, config: PluginConfig = {}): Promise<void> {
  await wire(ctx, config);
}