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

interface InternalWiring extends QqBridgeWiring {
  credential: QqCredential;
  updateConfig: (newCfg: PluginConfig) => void;
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
 * 内部完整接线工厂：根据给定的有效凭据与配置构建全套桥接运行时。
 */
async function createWiring(
  ctx: Context,
  cfg: PluginConfig,
  credential: QqCredential,
  options: QqBridgeWireOptions,
  currentConfigGetter: () => PluginConfig,
  sessionActivity: ControlContext['sessionActivity'],
  logger: Logger,
): Promise<InternalWiring> {
  const disposers: Array<() => void> = [];
  const dshHome = resolveDshHome();

  // ── 1. 协议客户端与出站基础设施 ──
  const client =
    options.createClient?.({ credentials: credential, logger }) ??
    new QqClient({ credentials: credential, logger });
  const markdown = new QqMarkdownAdapter();
  const slots = new MsgSeqSlotAllocator();
  const sender = new PerPeerSerialSender();
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

  // ── 2. 控制层（接管 DSH 已有会话；D28 启动恢复） ──
  const permissionPresets = optionalService<PermissionPresetsLike>(ctx, 'permissionPresets');
  const sessionTitle = optionalService(ctx, 'sessionTitle');
  const sessionQuery = optionalService(ctx, 'sessionQuery');
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel');
  const agentPresets = optionalService(ctx, 'agentPresets');
  const tokenMeter = optionalService(ctx, 'tokenMeter');
  const compaction = optionalService<CompactionEngine>(ctx, 'compaction');

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
    defaultWorkspacePath: (cfg.default_workspace ?? '').trim() || resolveDefaultWorkspacePath(dshHome),
    restoreOnStart: true,
  });
  const control = opened.control;
  logger.info(`控制层就绪：启动恢复 ${opened.restore.targets.length} 条目标`);

  // ── 3. openid ↔ sessionId 归属与回复锚点 ──
  const lastInbound = new Map<string, OutboundTarget>();
  const openidOf = (sessionId: string): string | undefined => control.findControlOwner(sessionId);
  const turnOrigin = new Map<string, 'qq' | 'other'>();
  const isOwnTurn = (sessionId: string): boolean => turnOrigin.get(sessionId) === 'qq';

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

  const offUserMessage = eventCtx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as
      | { type?: string; data?: { id?: unknown; source?: { kind?: unknown } } }
      | undefined;
    if (event?.type !== 'user/message' || !session?.id) return;
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

  // ── 4. 远端交互 ──
  const interactions = new QqInteractions({
    sendText: async (openid, text) => {
      const anchor = resolveTarget(openid);
      if (anchor?.msgId) return reply(anchor, text);
      logger.warn(
        `[interactions] openid=${openid.slice(0, 8)}… 无入站锚点，降级为主动消息投递交互卡片（D6 例外）`,
      );
      return reply({ openid }, text);
    },
    controlledBy: (sessionId) => control.findControlOwner(sessionId),
    ownTurn: isOwnTurn,
    logger,
  });
  disposers.push(interactions.attach(ctx));

  // ── 5. 命令层 + 入站管线（使用 getter 函数动态获取当前配置） ──
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
    allowCreateSession: () => currentConfigGetter().allow_create_session !== false,
    replyMaxChars: () => currentConfigGetter().reply_max_chars,
    listPageSize: () => currentConfigGetter().list_page_size,
    statusShowUsage: () => currentConfigGetter().status_show_usage,
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
    allowCreateSession: () => currentConfigGetter().allow_create_session !== false,
    logger,
  });

  // ── 6. DSH 流式事件 → QQ 出站（turn-router） ──
  const router = new TurnRouter({
    streams,
    openidOf,
    resolveTarget,
    ownTurn: isOwnTurn,
    isStreamEnabled: () => currentConfigGetter().stream_enabled !== false,
    logger,
  });
  settleStreamPeer = (openid) => router.drainPeer(openid);
  disposers.push(router.attach(eventCtx));

  // ── 7. Agent 工具：send_file / send_image ──
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

  // ── 8. 入站消息监听 ──
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

  let isWiringDisposed = false;
  const dispose = async (): Promise<void> => {
    if (isWiringDisposed) return;
    isWiringDisposed = true;
    runDisposers(disposers);
    client.stop();
    await router.drain().catch(() => undefined);
    await opened.dispose().catch((err: unknown) => logger.error('释放控制层失败', err));
  };

  const updateConfig = (newCfg: PluginConfig): void => {
    streams.updateThrottle(newCfg.stream_throttle_ms);
    mediaReceiver.updateLimits({
      maxBytes: newCfg.media_max_bytes,
      mediaDir: newCfg.media_dir,
    });
  };

  return {
    client,
    control,
    pipeline,
    router,
    streams,
    interactions,
    isOwnTurn,
    credential,
    updateConfig,
    dispose,
  };
}

/**
 * 完成全部接线。凭据缺失时返回 `undefined`（离线待机，插件仍挂载并注册设置面板）。
 * 内置 Reconciler 状态机，当设置面板更新凭据时自动热上线。
 */
export async function wire(
  ctx: Context,
  config: PluginConfig = {},
  options: QqBridgeWireOptions = {}
): Promise<QqBridgeWiring | undefined> {
  const logger: Logger = resolveLogger(ctx, PLUGIN_NAME);
  const dshHome = resolveDshHome();

  let activeWiring: InternalWiring | undefined = undefined;
  let configSource: (() => PluginConfig) | undefined = undefined;
  let settingsInstalled = false;
  let isRootDisposed = false;
  let isInitializing = true;

  // ── 读取动态合并配置 ──
  const readSettings = (): PluginConfig => {
    if (configSource) return configSource() ?? {};
    const settingsService = optionalService<any>(ctx, 'settings');
    return settingsService?.get?.(SETTINGS_NAMESPACE) ?? {};
  };

  const currentConfig = (): PluginConfig => ({
    ...config,
    ...readSettings(),
  });

  // ── 会话活跃元数据动态数据源 ──
  let activitySource: ControlContext['sessionActivity'];
  ctx.inject(['sessionController'], (scCtx) => {
    const controller = (scCtx as unknown as { sessionController?: SessionControllerLike }).sessionController;
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
  const sessionActivity: ControlContext['sessionActivity'] = {
    async list() {
      return activitySource === undefined ? [] : activitySource.list();
    },
  };

  // ── Reconciler 状态机：配置变更时对齐运行状态 ──
  const reconcile = async (forcedConfig?: PluginConfig): Promise<void> => {
    if (isRootDisposed) return;
    const latestConfig = forcedConfig ? { ...config, ...forcedConfig } : currentConfig();
    const { credential: newCred } = resolveCredentials(latestConfig, { dshHome });

    if (!activeWiring) {
      // 当前处于离线待机状态
      if (newCred) {
        logger.info('检测到有效 QQ 凭据，正在上线 QQ 机器人桥接...');
        try {
          activeWiring = await createWiring(
            ctx,
            latestConfig,
            newCred,
            options,
            currentConfig,
            sessionActivity,
            logger,
          );
          await activeWiring.client.start();
          logger.info('QQ 机器人桥接热上线成功');
        } catch (err) {
          logger.error('QQ 机器人桥接热上线失败：', err);
        }
      }
      return;
    }

    // 当前已处于上线状态
    if (!newCred) {
      logger.warn('凭据已失效或被移除，QQ 机器人桥接进入离线待机');
      const oldWiring = activeWiring;
      activeWiring = undefined;
      await oldWiring.dispose().catch((err) => logger.error('释放旧接线失败：', err));
      return;
    }

    // 检查凭据是否发生实质变更
    const credChanged =
      newCred.appId !== activeWiring.credential.appId ||
      newCred.appSecret !== activeWiring.credential.appSecret;

    if (credChanged) {
      logger.info('凭据已变更，正在重启 QQ 机器人桥接...');
      const oldWiring = activeWiring;
      activeWiring = undefined;
      await oldWiring.dispose().catch((err) => logger.error('释放旧接线失败：', err));
      try {
        activeWiring = await createWiring(
          ctx,
          latestConfig,
          newCred,
          options,
          currentConfig,
          sessionActivity,
          logger,
        );
        await activeWiring.client.start();
        logger.info('QQ 机器人桥接重启成功');
      } catch (err) {
        logger.error('QQ 机器人桥接重启失败：', err);
      }
      return;
    }

    // 凭据未变，通知动态参数热更新
    activeWiring.updateConfig(latestConfig);
  };

  let reconcileRunning = false;
  let pendingConfig: PluginConfig | undefined = undefined;

  const queueReconcile = async (newVal?: PluginConfig): Promise<void> => {
    if (newVal) pendingConfig = newVal;
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      while (pendingConfig !== undefined || (!activeWiring && !isInitializing)) {
        const nextCfg = pendingConfig;
        pendingConfig = undefined;
        await reconcile(nextCfg);
        if (pendingConfig === undefined) break;
      }
    } finally {
      reconcileRunning = false;
    }
  };

  // ── 设置面板注册（消除 Fiber 调度导致的离线死锁） ──
  const installSettings = (settingsService: any) => {
    if (!settingsService?.installSection || settingsInstalled) return;
    settingsInstalled = true;
    settingsService.installSection(ctx, SETTINGS_NAMESPACE, PluginConfigSchema, config, {
      setSource: (source: () => PluginConfig) => {
        configSource = source;
        if (!isInitializing && !activeWiring && !isRootDisposed) {
          void queueReconcile();
        }
      },
      onChange: (newVal: PluginConfig) => {
        if (isInitializing) return;
        logger.info('配置已更新，正在对齐运行状态...');
        void queueReconcile(newVal);
      },
    });
  };

  // 优先直接调用已就绪的 settings 服务（消除延迟），同时保留 inject 监听保证异步挂载兼容
  const directSettings = optionalService<any>(ctx, 'settings');
  if (directSettings) {
    installSettings(directSettings);
  }
  ctx.inject(['settings'], (settingsCtx) => {
    installSettings((settingsCtx as any)?.settings);
  });

  // ── 初次尝试组装运行链路 ──
  const initialCfg = currentConfig();
  const { credential, reason } = resolveCredentials(initialCfg, { dshHome });

  if (credential) {
    activeWiring = await createWiring(
      ctx,
      initialCfg,
      credential,
      options,
      currentConfig,
      sessionActivity,
      logger,
    );
    if (options.autoStart !== false) {
      void activeWiring.client.start().catch((err: unknown) => logger.error('启动 QQ 客户端失败：', err));
    }
  } else {
    logger.warn(`QQ 凭据缺失，插件处于离线待机：${reason}`);
  }

  isInitializing = false;

  // ── 插件根生命周期清理 ──
  type EventCtx = { on(event: string, handler: (...args: unknown[]) => unknown): unknown };
  const eventCtx = ctx as unknown as EventCtx;

  const rootDispose = async (): Promise<void> => {
    if (isRootDisposed) return;
    isRootDisposed = true;
    if (activeWiring) {
      const w = activeWiring;
      activeWiring = undefined;
      await w.dispose().catch(() => undefined);
    }
  };

  eventCtx.on('dispose', () => {
    void rootDispose();
    logger.info('插件已卸载');
  });

  if (!activeWiring) {
    return undefined;
  }

  // 包装外部暴露的 wiring 引用，确保外部显式 dispose 时同步清理 activeWiring
  return {
    client: activeWiring.client,
    control: activeWiring.control,
    pipeline: activeWiring.pipeline,
    router: activeWiring.router,
    streams: activeWiring.streams,
    interactions: activeWiring.interactions,
    isOwnTurn: (sessionId: string) => activeWiring?.isOwnTurn(sessionId) ?? false,
    dispose: async () => {
      await rootDispose();
    },
  };
}

/**
 * Cordis 插件入口。`apply` 只做接线与生命周期登记（业务逻辑全在 `wire()` 装配的模块里）。
 */
export async function apply(ctx: Context, config: PluginConfig = {}): Promise<void> {
  await wire(ctx, config);
}