/**
 * dsh-qqbot-bridge: DSH 会话控制服务
 *
 * 负责管理 QQ 用户对本地 DSH 工作区与 Agent 会话的远程操控：
 * 1. 同进程内存复用：优先通过 `ctx.agents.get(sessionId)` 复用 Live Agent 实例，避免无谓重加载；
 * 2. 状态机与并发保护：遇到排他锁冲突时如实报错，绝不降级新建空白会话破坏上下文；
 * 3. 运行中引导 (Steer)：针对正在运行的活跃 Turn，通过 steer 机制注入指令与纠偏；
 * 4. 严格遵循官方状态契约：不维护自有模型或权限副本，状态完全直通 DSH 官方服务。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  TurnBoundaryProjection,
} from '@deepseek-ai/dsh-agent';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction';

import type {
  CompactFailCode,
  CompactOutcome,
  ControlTarget,
  ControlService,
  CreateSessionResult,
  SessionRef,
  SessionStatus,
  TakeoverResult,
  WorkspaceRef,
} from '../types/index.js';
import {
  findWorkspaceRef,
  findWorkspaceRefByPath,
  isArchivedSession,
  listSessionRefs,
  listWorkspaceRefs,
  normalizePathForCompare,
  readSessionFacets,
  type SessionActivityEntry,
  type SessionActivitySource,
  type SessionObservationLike,
  type SessionQueryLike,
  type SessionTitleLike,
  type WorkspaceRegistryLike,
} from './workspaces.js';
import { resolveWorkspaceMatch } from './addressing.js';
import { openTargetStore, type TargetStore } from './target-store.js';
import { t } from '../i18n/index.js';

// ══════════════════════════ 注入面（显式结构类型，无 `as any` 兜底） ═══════════════════════════

/** `ctx.agents` 的最小结构面 */
export interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined;
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
}

/** `ctx.sessionProjections` 的最小结构面（只取本项目用到的两个面） */
export interface SessionProjectionsLike {
  stateOf(session: Session, key: 'turnBoundary'): TurnBoundaryProjection | undefined;
  /**
   * `modelSelection` 投影 state（D48）：`{ lastUsed, pending }`，
   * 【文档明写】`dsh-api-session-controller/lib/index.js:2039-2051`。
   * 官方 `selectionFor()` 就是用它读「该会话当前模型」（同文件 `:280-295`）。
   */
  stateOf(session: Session, key: 'modelSelection'): ModelSelectionProjectionStateLike | undefined;
  snapshot(
    session: Session,
    keys?: readonly ('contextPressure' | 'contextBreakdown')[],
  ): ProjectionSnapshotLike;
}

/** 一次模型选择（官方 `modelSelectionSchema`：`provider` / `model` / 可选 `reasoningEffort`） */
export interface ModelSelectionLike {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** `modelSelection` 投影的 state（官方 `modelSelectionProjectionStateSchema`） */
export interface ModelSelectionProjectionStateLike {
  readonly lastUsed: ModelSelectionLike | null;
  readonly pending: ModelSelectionLike | null;
}

export interface ProjectionSnapshotLike {
  readonly values: {
    readonly contextPressure?: { readonly contextWindow?: number };
    readonly contextBreakdown?: {
      readonly systemTokens: number;
      readonly toolsTokens: number;
      readonly messageTokens: number;
    };
  };
}

/** `ctx.permissionPresets` 的最小结构面 */
export interface PermissionPresetsLike {
  current(session: Session): string;
}

/** `ctx.agentDefaultModel` 的最小结构面（官方「无会话级选择时的默认模型」，D26 只读不写） */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
}

/** 一个 agent preset 的最小结构面（官方 `AgentPreset`：`dsh-agent-presets/lib/types/preset.d.ts:15-33`） */
export interface AgentPresetLike {
  /** 稳定 id（= preset 目录名）；写进会话 header 的就是它 */
  readonly id: string;
}

/** `ctx.agentPresets` 的最小结构面（`dsh-agent-presets` 的 `AgentPresets`：`resolve` + `mount` + `serviceFor`） */
export interface AgentPresetsLike {
  /**
   * 官方 `resolve(id?)`：**解析出真正要用的 preset**（`id` 缺省即部署默认——
   * `settings['agent-presets'].default` 优先于 `config.default`）。
   * 【文档明写】`dsh-agent-presets/lib/types/index.d.ts`（`resolve`）。
   * 官方建会话路径**先 resolve 再写会话元数据**：`dsh-api-session-controller/lib/index.js:355-361`
   * （`const resolvedId = (await presets.resolve(presetId)).id;`）。
   */
  resolve(id?: string): Promise<AgentPresetLike>;
  /**
   * 官方 `mount(agentCtx, id?)`：把 preset 组合挂到 agent 的 scope 上，**返回被组合的 preset**
   * （调用方据此记录）。`id` 缺省即部署默认。
   */
  mount(agentCtx: unknown, id?: string): Promise<AgentPresetLike>;
  /**
   * 官方 **READ 寻址**（`AgentPresets.serviceFor`）：持有 agent、从外部读其 preset realm 内
   * 被 `isolate` 隔离的服务实例。这是唯一官方支持的读法——realm 内的服务对 host 平面与
   * **agent 自己的 ctx** 都不可见（见 `compactionEngineFor` 的长注与出处）。
   */
  serviceFor(agent: { readonly ctx: unknown }, name: string): unknown;
}

/** `ctx.tokenMeter` 的最小结构面 */
export interface TokenMeterLike {
  measure(session: Session): TokenMeasurement;
}

export interface ControlLoggerLike {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 控制层依赖：全部来自官方 ctx，显式注入（不用 `ctx.get()` 字符串兜底） */
export interface ControlContext {
  workspaceRegistry: WorkspaceRegistryLike;
  agents: AgentRegistryLike;
  sessionProjections: SessionProjectionsLike;
  storageDomain: DomainFacility;
  permissionPresets?: PermissionPresetsLike;
  sessionTitle?: SessionTitleLike;
  sessionQuery?: SessionQueryLike;
  agentDefaultModel?: AgentDefaultModelLike;
  /**
   * `ctx.agentPresets` —— **真机验收暴露的必要依赖**。
   * web profile 里 `tool-bash`/`tool-pwsh`/`tool-jobs` 均为 `disabled: true`，它们由
   * **agent preset 按会话挂载**（WebUI 建会话时会 mount）。控制层若不 mount，
   * 新建/接管的会话就只有全局工具（模型会如实报告"我只有 send_file/send_image"）。
   *
   * D52 起还承担**会话记录**（`resolve()` → `meta.agentPreset`）与**接管复原**
   * （按该会话记录的 preset 重新挂载），见 `resolveAgentPreset` / `recordedAgentPreset`。
   */
  agentPresets?: AgentPresetsLike;
  tokenMeter?: TokenMeterLike;
  /**
   * `ctx.compaction` —— `/压缩`（D44）直调的官方压缩服务。
   * 由 `dsh-base` 装载（`compaction-basic`），web-app 也会再次接线；缺失时如实回「服务不可用」。
   */
  compaction?: CompactionEngine;
  /**
   * D46：会话活跃元数据来源（把官方 `ctx.sessionController.list()` 适配成一枪读取）。
   * 缺失或抛错时控制层降级——`/会话` 不显示时间、不过滤空白会话，**功能不受影响**。
   */
  sessionActivity?: SessionActivitySource;
  logger?: ControlLoggerLike;
}

// ══════════════════════════ 错误与判定工具 ═══════════════════════════

/** 调用方传入非法参数（如未注册的工作区 id）——失败必吵，不静默兜底 */
export class ControlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlInputError';
  }
}

/**
 * `/压缩` 失败文案（D44）：`busy|cancelled|changed|summary|commit|persistence` 六条与官方
 * `dsh-command-compact` 的 `expectedFailure` **逐条对齐**（译为中文），保证「官方怎么判、QQ 侧
 * 就怎么说」，不自己发明语义；其余三条是本项目接线层的前置失败。
 * 文案取自 `src/i18n/zh-CN.ts`（`control.compact`）——用户可见，故不进本模块。
 */
const COMPACT_FAIL_TEXT: Record<CompactFailCode, string> = {
  'no-target': t('control.compact.noTarget'),
  unavailable: t('control.compact.unavailable'),
  agent: t('control.compact.agent'),
  busy: t('control.compact.busy'),
  cancelled: t('control.compact.cancelled'),
  changed: t('control.compact.changed'),
  summary: t('control.compact.summary'),
  commit: t('control.compact.commit'),
  persistence: t('control.compact.persistence'),
  error: t('control.compact.error'),
};

function errorName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * D49：本桥接投喂消息 id 的记忆上限。回合归属只需覆盖「最近若干回合」，
 * 有界可避免长跑进程无界增长（真机上会话生命周期可跨天）。
 */
const OWN_MESSAGE_MEMORY = 256;

/**
 * 规范化一次模型选择为展示字段（D48）。
 * 与官方 `agentModelSelection`（`dsh-api-session-controller/lib/index.js:480-486`）同形：
 * `provider`/`model` 必填、`reasoningEffort` 缺省即不带该字段。
 */
function normalizeSelection(selection: ModelSelectionLike): {
  provider: string;
  model: string;
  reasoningEffort?: string;
} {
  return {
    provider: String(selection.provider),
    model: String(selection.model),
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(selection.reasoningEffort) }),
  };
}

/**
 * 排他锁冲突判定。
 * E12-B【实测】真实错误：`name === 'SessionAlreadyOwnedError'`，
 * `message === 'session "<id>" is already owned by an active write handle'`（另带 `sessionId` 字段，无 `code`）。
 * 这里同时接受错误名与消息原文标记，兼容官方措辞的小幅变化（不依赖单一特征）。
 */
export function isSessionAlreadyOwned(err: unknown): boolean {
  if (errorName(err) === 'SessionAlreadyOwnedError') return true;
  const message = errorMessage(err);
  return (
    message.includes('is already owned by an active write handle') ||
    message.includes('already owned') ||
    message.includes('SessionAlreadyOwnedError')
  );
}

/** 会话查询的「确定不存在」判定（`SessionQueryError` / `SESSION_QUERY_SESSION_NOT_FOUND`） */
export function isSessionNotFound(err: unknown): boolean {
  if (errorCode(err) === 'SESSION_QUERY_SESSION_NOT_FOUND') return true;
  if (errorName(err) === 'SessionQueryError' && /not found/i.test(errorMessage(err))) return true;
  return /not found/i.test(errorMessage(err));
}

// ══════════════════════════ 启动恢复报告 ═══════════════════════════

export interface StartupRestoreEntry {
  openid: string;
  /** 恢复前持久化的目标 */
  target: ControlTarget;
  /** 是否因归档/不存在而被清空（D29） */
  cleared: boolean;
  /** 接管结果（仅在目标有效且尝试接管时有值） */
  takeover?: TakeoverResult;
  notice?: string;
}

export interface StartupRestoreReport {
  targets: readonly StartupRestoreEntry[];
}

// ══════════════════════════ 服务实现 ═══════════════════════════

export interface ControlServiceOptions {
  /** 「/新建 <相对路径>」的基准目录；默认 `$HOME`（D24，不随会话 cwd 变） */
  homeDir?: string;
  /** 未选择工作区作用域时的默认工作区路径（`PluginConfig.default_workspace`） */
  defaultWorkspacePath?: string;
  /** 启动时是否自动恢复并 resume 持久化目标（D28；默认 true） */
  restoreOnStart?: boolean;
  /** 覆盖目标存储（装配/测试注入点）；缺省用 `ctx.storageDomain` 打开 */
  targetStore?: TargetStore;
}

interface AgentResolution {
  ok: true;
  agent: Agent;
  /** true = 复用了 live agent（E12-A 主路径，未触锁） */
  reusedLive: boolean;
}

interface AgentResolutionFailure {
  ok: false;
  code: 'locked' | 'error';
  reason: string;
}

interface SessionLocation {
  exists: boolean;
  archived: boolean;
  workspaceId: string | null;
  cwd?: string;
  error?: string;
}

/** 判定「路径已存在但不是目录」等输入错误时用 */
type PathPrecheck =
  | { kind: 'ok'; existed: boolean }
  | { kind: 'not-a-directory'; reason: string }
  | { kind: 'failed'; reason: string };

export class DshControlService implements ControlService {
  private readonly ownedHandles = new Map<string, AgentHandle>();
  private projectionWarningLogged = false;
  /** D49：本桥接投喂过的用户消息 id（有界；投喂顺序用于淘汰最旧） */
  private readonly ownMessageIds = new Set<string>();
  private readonly ownMessageOrder: string[] = [];

  constructor(
    private readonly ctx: ControlContext,
    private readonly store: TargetStore,
    private readonly options: ControlServiceOptions = {},
  ) {}

  // ───────────────────────── 工作区/会话枚举 ─────────────────────────

  async listWorkspaces(): Promise<WorkspaceRef[]> {
    return listWorkspaceRefs(this.ctx.workspaceRegistry);
  }

  async listSessions(workspaceId: string): Promise<SessionRef[]> {
    // D46：活跃元数据是**附带信息**——读不到就降级（不显示时间、不过滤空白），绝不让 /会话 报错
    const activity = await this.readSessionActivity();
    return listSessionRefs(
      {
        registry: this.ctx.workspaceRegistry,
        ...(this.ctx.sessionQuery !== undefined ? { sessionQuery: this.ctx.sessionQuery } : {}),
        ...(this.ctx.sessionTitle !== undefined ? { sessionTitle: this.ctx.sessionTitle } : {}),
        agents: this.ctx.agents,
        activity,
      },
      workspaceId,
    );
  }

  /**
   * D46：读取会话活跃元数据（官方 `sessionController.list()`），按 sessionId 建索引。
   *
   * **失败即降级**：来源缺失或抛错时返回空表并记一条 warn —— `/会话` 只是少一个时间片段
   * 与一条 WebUI 对齐的过滤，绝不因此失败（时间拿不到即降级，不影响基础列表展示）。
   */
  private async readSessionActivity(): Promise<ReadonlyMap<string, SessionActivityEntry>> {
    const source = this.ctx.sessionActivity;
    if (source === undefined) return new Map();
    try {
      const entries = await source.list();
      return new Map(entries.map((entry) => [entry.sessionId, entry]));
    } catch (error: unknown) {
      this.ctx.logger?.warn(`会话活跃元数据读取失败（/会话 不显示时间、不过滤空白会话）：${errorMessage(error)}`);
      return new Map();
    }
  }

  /**
   * 注册表中**被归档**的会话 id 集合（D45）。权威来源是 `workspaceRegistry.archivedSessionIds`
   * （registry-global；归档会话**保留** `sessionIds` 槽位以便取消归档还原位置）。
   * 命令层用它对齐 WebUI 默认口径：`/会话` 隐藏归档、`/切换` 的「会话 N」不计归档。
   */
  async listArchivedSessionIds(): Promise<string[]> {
    return this.ctx.workspaceRegistry.archivedSessionIds.map((id) => String(id));
  }

  async getWorkspace(workspaceIdOrPath: string): Promise<WorkspaceRef | undefined> {
    const raw = workspaceIdOrPath.trim();
    if (raw === '') return undefined;
    const byId = findWorkspaceRef(this.ctx.workspaceRegistry, raw);
    if (byId !== undefined) return byId;
    return findWorkspaceRefByPath(listWorkspaceRefs(this.ctx.workspaceRegistry), raw);
  }

  async resolveWorkspace(arg: string): Promise<WorkspaceRef | undefined> {
    // 多命中由 resolveWorkspaceMatch 抛 AmbiguousMatchError（严禁静默取第一个）
    return resolveWorkspaceMatch(arg, listWorkspaceRefs(this.ctx.workspaceRegistry));
  }

  // ───────────────────────── 控制目标生命周期（D19/D28/D29/D30） ─────────────────────────

  async getTarget(openid: string): Promise<ControlTarget> {
    return this.store.get(openid);
  }

  /**
   * 反查「当前把该 session 作为控制目标的 openid」。
   *
   * `TargetStore.entries()` 是 domain 的**权威内存态**（写成功才在内存生效），因此本方法
   * 反映的是**此刻**的受控关系，而非历史。多 openid 指向同一 session 时取首个命中
   * （单聊场景下同一 session 被多个 openid 同时控制属异常态，不做特殊处理，避免过度设计）。
   */
  findControlOwner(sessionId: string): string | undefined {
    const wanted = sessionId.trim();
    if (wanted === '') return undefined;
    for (const [openid, target] of this.store.entries()) {
      if (target.sessionId === wanted) return openid;
    }
    return undefined;
  }

  async setWorkspace(openid: string, workspaceId: string): Promise<void> {
    const ref = findWorkspaceRef(this.ctx.workspaceRegistry, workspaceId);
    if (ref === undefined) {
      throw new ControlInputError(`工作区 ${workspaceId} 未注册，无法切换`);
    }
    // D19：切换工作区必须清空控制目标（进入未选中态）
    await this.store.put(openid, { workspaceId: ref.id, sessionId: null });
  }

  async setTarget(openid: string, sessionId: string): Promise<TakeoverResult> {
    const wanted = sessionId.trim();
    if (wanted === '') return { ok: false, code: 'invalid', reason: '会话 id 为空' };

    const location = await this.locateSession(wanted);
    if (location.archived) {
      return { ok: false, code: 'archived', reason: `会话 ${wanted} 已被归档，请用 /会话 重新选择` };
    }
    if (location.error !== undefined) {
      return { ok: false, code: 'error', reason: `检查会话失败：${location.error}` };
    }
    if (!location.exists) {
      return { ok: false, code: 'not-found', reason: `会话 ${wanted} 不存在` };
    }

    const resolution = await this.ensureAgent(wanted);
    if (!resolution.ok) return { ok: false, code: resolution.code, reason: resolution.reason };

    const current = this.store.get(openid);
    const target: ControlTarget = {
      workspaceId: location.workspaceId ?? current.workspaceId,
      sessionId: wanted,
    };
    try {
      await this.store.put(openid, target);
    } catch (err) {
      return { ok: false, code: 'error', reason: `持久化控制目标失败：${errorMessage(err)}` };
    }
    this.log('info', '接管会话', { sessionId: wanted, reusedLive: resolution.reusedLive });
    return { ok: true, sessionId: wanted };
  }

  async clearTarget(openid: string, reason: string): Promise<void> {
    const current = this.store.get(openid);
    await this.store.put(openid, { workspaceId: current.workspaceId, sessionId: null });
    this.log('info', '清空控制目标', { openid, reason });
  }

  async createSession(openid: string, pathArg?: string): Promise<CreateSessionResult> {
    const scope = this.store.get(openid);

    // 1. 解析目标路径（D24：相对路径基准 $HOME；无参时用当前工作区作用域）
    let targetPath: string | undefined;
    const rawArg = pathArg?.trim() ?? '';
    if (rawArg !== '') {
      const base = this.options.homeDir ?? os.homedir();
      targetPath = path.isAbsolute(rawArg) ? path.resolve(rawArg) : path.resolve(base, rawArg);
    } else if (scope.workspaceId !== null) {
      const scopeRef = findWorkspaceRef(this.ctx.workspaceRegistry, scope.workspaceId);
      if (scopeRef !== undefined) targetPath = scopeRef.path;
    }
    if (targetPath === undefined && this.options.defaultWorkspacePath !== undefined) {
      const fallback = this.options.defaultWorkspacePath.trim();
      if (fallback !== '') targetPath = path.resolve(fallback);
    }
    if (targetPath === undefined) {
      return {
        ok: false,
        code: 'register-failed',
        reason: '未选择工作区作用域（且未配置默认工作区），请先 /切换 或 /新建 <路径>',
      };
    }

    // 1.5 解析本次要用的 agent preset（D52）。
    //     放在**目录/工作区副作用之前**：preset 解析失败（不存在/损坏）时不留空目录、不留空工作区。
    //     官方把 resolve 放在 mkdir 之后（`dsh-api-session-controller/lib/index.js:441-452`），
    //     这里只是把同一件事提前，语义不变、副作用更干净。
    let agentPreset: string | undefined;
    try {
      agentPreset = await this.resolveAgentPreset();
    } catch (err) {
      return {
        ok: false,
        code: 'create-failed',
        reason: t('control.create.presetResolveFailed', { error: errorMessage(err) }),
      };
    }

    // 2. 目录准备：存在但是文件 → 报错；不存在 → mkdir -p
    let createdDir = false;
    let precheck: PathPrecheck;
    try {
      const stat = await fsp.stat(targetPath);
      precheck = stat.isDirectory()
        ? { kind: 'ok', existed: true }
        : { kind: 'not-a-directory', reason: `该路径是文件，不是目录：${targetPath}` };
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        precheck = { kind: 'ok', existed: false };
      } else {
        precheck = { kind: 'failed', reason: `检查路径失败：${errorMessage(err)}` };
      }
    }
    if (precheck.kind === 'not-a-directory') {
      return { ok: false, code: 'exists-as-file', reason: precheck.reason };
    }
    if (precheck.kind === 'failed') {
      return { ok: false, code: 'mkdir-failed', reason: precheck.reason };
    }
    if (!precheck.existed) {
      try {
        await fsp.mkdir(targetPath, { recursive: true });
        createdDir = true;
      } catch (err) {
        return { ok: false, code: 'mkdir-failed', reason: `创建目录失败：${errorMessage(err)}` };
      }
    }

    // 3. 注册工作区（已注册则复用；未注册则自动注册，D24）
    const registered = await this.ensureWorkspaceRegistered(targetPath);
    if (!registered.ok) {
      return { ok: false, code: 'register-failed', reason: registered.reason };
    }
    const workspace = registered.workspace;

    // 4. 新建会话：id = session-<uuid>，标题交 DSH 自动命名（不调 sessionTitle.rename）。
    //    模型/思考强度**取自 DSH 官方默认**（`agentDefaultModel.currentSelection()`）——
    //    ⚠️ 真机实测更正：原按 D26 字面传 `agentOptions: undefined`，会让 DSH 的
    //    persona-prefix 装配失败：`prompt variable "{{model}}" has no value for this assembly`。
    //    D26 的本意是"插件不维护**自有**状态"，而不是"不向官方传初值"；这里读的正是官方默认。
    //
    //    D52：`meta.agentPreset` 必须带上（官方 `composeAgent` 的同一件事，`lib/index.js:444-452`）——
    //    它落到 durable header（`dsh-session/lib/index.js:1402`）并由 `agentPreset` 投影暴露给 WebUI；
    //    不写 ⇒ 组合对但**记录缺席**，WebUI 预设标签 `return null`（真机 bug）。
    //    `setup` 挂载的是**同一个** `agentPreset`（记录与实际不得分叉）。
    const sessionId = `session-${randomUUID()}`;
    const initialAgentOptions = this.officialAgentOptions();
    const setup = this.agentSetup(agentPreset);
    try {
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: workspace.path, ...(agentPreset !== undefined ? { agentPreset } : {}) },
        ...(initialAgentOptions !== undefined ? { agentOptions: initialAgentOptions } : {}),
        ...(setup !== undefined ? { setup } : {}),
      });
      this.ownedHandles.set(sessionId, handle);
    } catch (err) {
      return { ok: false, code: 'create-failed', reason: `创建会话失败：${errorMessage(err)}` };
    }

    try {
      await workspace.attachSession(SessionId(sessionId));
    } catch (err) {
      return {
        ok: false,
        code: 'create-failed',
        reason: `会话已创建但挂载到工作区失败：${errorMessage(err)}`,
      };
    }

    try {
      await this.store.put(openid, { workspaceId: String(workspace.id), sessionId });
    } catch (err) {
      return {
        ok: false,
        code: 'create-failed',
        reason: `会话已创建但控制目标持久化失败：${errorMessage(err)}`,
      };
    }

    return {
      ok: true,
      sessionId,
      workspaceId: String(workspace.id),
      createdWorkspace: registered.created,
      createdDir,
    };
  }

  // ───────────────────────── 驱动（D7 忙闲 / steer-vs-followup） ────────────────────────

  async send(
    openid: string,
    text: string,
  ): Promise<{ ok: boolean; mode: 'steer' | 'followup' | 'none'; reason?: string }> {
    const target = this.store.get(openid);
    if (target.sessionId === null) {
      return { ok: false, mode: 'none', reason: '未选中控制目标，请先 /会话 选择' };
    }
    const resolution = await this.ensureAgent(target.sessionId);
    if (!resolution.ok) return { ok: false, mode: 'none', reason: resolution.reason };

    const busy = this.isBusy(resolution.agent.session);
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    // D49：**先**记住这条消息的 id，再投喂——`user/message` 事件的 data 就是该 UserMessage，
    // 回合路由据此判定「这个回合是不是 QQ 投喂的」（官方无来源字段，只能自记）。
    this.rememberOwnMessage(String(message.id));
    try {
      // D7 + E12-A 实测：忙（turn 未结束）→ steer 注入当前 turn；空闲 → followup 开新 turn。
      if (busy) resolution.agent.steer(message);
      else resolution.agent.followup(message);
    } catch (err) {
      return { ok: false, mode: 'none', reason: `发送失败：${errorMessage(err)}` };
    }
    return { ok: true, mode: busy ? 'steer' : 'followup' };
  }

  /**
   * D49：该 `messageId` 是否由**本桥接**投喂（回合归属判定的基石）。
   *
   * 【文档明写】`Message.id` 跨表示边界稳定（`dsh-llm/lib/types/message.d.ts:119-122`），
   * 且 `'user/message'` 会话事件的 data 就是该 `UserMessage`（`dsh-session/lib/types/types.d.ts:281`）。
   *
   * 有界记忆：只保留最近 `OWN_MESSAGE_MEMORY` 条，避免长跑进程无界增长。
   */
  isOwnMessage(messageId: string): boolean {
    return this.ownMessageIds.has(messageId);
  }

  private rememberOwnMessage(messageId: string): void {
    this.ownMessageIds.add(messageId);
    this.ownMessageOrder.push(messageId);
    while (this.ownMessageOrder.length > OWN_MESSAGE_MEMORY) {
      const oldest = this.ownMessageOrder.shift();
      if (oldest !== undefined) this.ownMessageIds.delete(oldest);
    }
  }

  async cancel(openid: string): Promise<{ ok: boolean; reason?: string }> {
    const target = this.store.get(openid);
    if (target.sessionId === null) return { ok: false, reason: '未选中控制目标' };
    const resolution = await this.ensureAgent(target.sessionId);
    if (!resolution.ok) return { ok: false, reason: resolution.reason };
    try {
      resolution.agent.cancel({ kind: 'user' });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `取消失败：${errorMessage(err)}` };
    }
  }

  /**
   * `/压缩`：直调官方 `ctx.compaction.compactNow(agent, signal)`。
   * 与官方 `/compact` 对齐：保持不可中断 ⇒ 传一个永不 abort 的 `AbortController` signal。
   */
  async compact(openid: string): Promise<CompactOutcome> {
    const target = this.store.get(openid);
    if (target.sessionId === null) {
      return { ok: false, code: 'no-target', reason: COMPACT_FAIL_TEXT['no-target'] };
    }
    const resolution = await this.ensureAgent(target.sessionId);
    if (!resolution.ok) {
      return { ok: false, code: 'agent', reason: `${COMPACT_FAIL_TEXT.agent}：${resolution.reason}` };
    }
    // 解析必须发生在拿到 agent 之后：web profile 下压缩只存在于 agent scoped 平面
    const engine = this.compactionEngineFor(resolution.agent);
    if (engine === undefined) {
      return { ok: false, code: 'unavailable', reason: COMPACT_FAIL_TEXT.unavailable };
    }

    try {
      const result = await engine.compactNow(resolution.agent, new AbortController().signal);
      if (result === null) return { ok: true, compacted: false };
      return {
        ok: true,
        compacted: true,
        shadowedItems: result.shadowedSeqs.length,
        shadowedTokens: result.shadowedTokenCount,
      };
    } catch (err) {
      if (err instanceof ManualCompactionError) {
        return { ok: false, code: err.code, reason: COMPACT_FAIL_TEXT[err.code] };
      }
      return { ok: false, code: 'error', reason: `压缩失败：${errorMessage(err)}` };
    }
  }

  /**
   * 解析压缩引擎（D44）——**两个平面都要看**，但读法完全不同：
   *
   *   1. **会话 preset realm 内的实例**（web profile 的真实形状）：
   *      `dsh-web-app/cordis.patch.yml:427/430/433` 在 host 平面把 `compaction-basic` /
   *      `command-compact` / `tool-result-pruner` 全部 `disabled: true`，改由 agent preset 以
   *      `isolate: { compaction: true }` 的 realm 挂进**每个会话**
   *      （`dsh-agent-presets/presets/standard/agent.cordis.yml:138-153`）。官方 `/compact` 之所以可用，
   *      是因为 `command-compact` 自己的 ctx **就在 realm 内**；而 host 平面与 **`agent.ctx` 都在 realm 外**。
   *      ⇒ 必须用官方 READ 寻址 `agentPresets.serviceFor(agent, 'compaction')`
   *      （`dsh-agent-presets/lib/types/index.d.ts:311-325`：*"invisible outside the group that declares
   *      them — including to the host … This is how a caller holding the agent reads one anyway"*；
   *      生产先例 `dsh-api-session-controller/lib/index.js:2272-2273` 就是这么读 `skills` 的）。
   *   2. `ControlContext.compaction`（host 平面）：headless / base-only profile 的回退。
   *
   * ⚠️ **两处已更正的错误结论（2026-09-15 真机 + 源码复核，留作前车之鉴）**：
   *   - 初版只读 host 平面 ⇒ 真机永远回「压缩服务未接线」；
   *   - 二版改为读 `agent.ctx.get('compaction')` 并配了一条**伪造 `agent.ctx.get` 的假测试** ⇒
   *     仍是死路：`ctx.get` 按**调用方 ctx 的 isolate 映射**解析（`cordis/lib/index.js:762-771`），
   *     realm 的标签与根默认键是两个不同 Symbol，故 agent.ctx 永远取不到；那条测试因此是假信号
   *     （AGENTS §3.1「造桩自嗨」）。现已删除该回退路径与假测试，并补一条**反假桩回归**。
   */
  private compactionEngineFor(agent: Agent): CompactionEngine | undefined {
    const scoped = this.ctx.agentPresets?.serviceFor(agent, 'compaction') as CompactionEngine | undefined;
    // 会话 preset realm 内的实例与官方 /compact 解析到的是同一个；host 平面仅作回退
    return scoped ?? this.ctx.compaction;
  }

  // ───────────────────────── /状态（D32） ─────────────────────────

  async status(openid: string): Promise<SessionStatus | undefined> {
    const target = this.store.get(openid);
    if (target.sessionId === null) return undefined;

    let workspaceTitle = '';
    let workspacePath = '';
    if (target.workspaceId !== null) {
      const ref = findWorkspaceRef(this.ctx.workspaceRegistry, target.workspaceId);
      if (ref !== undefined) {
        workspaceTitle = ref.title;
        workspacePath = ref.path;
      }
    }

    const live = this.ctx.agents.get(SessionId(target.sessionId));
    let title: string | undefined;
    if (live !== undefined && this.ctx.sessionTitle !== undefined) {
      title = this.ctx.sessionTitle.get(live.session)?.title;
    }
    if (title === undefined) {
      const facet = (await readSessionFacets(this.ctx.sessionQuery, [target.sessionId])).get(target.sessionId);
      title = facet?.title;
      if (workspacePath === '' && facet?.cwd !== undefined) {
        const ref = findWorkspaceRefByPath(listWorkspaceRefs(this.ctx.workspaceRegistry), facet.cwd);
        if (ref !== undefined) {
          workspaceTitle = ref.title;
          workspacePath = ref.path;
        }
      }
    }

    const status: SessionStatus = {
      sessionId: target.sessionId,
      workspaceTitle,
      workspacePath,
      busy: false,
    };
    if (title !== undefined) status.title = title;

    const selection = this.resolveModelSelection(live);
    if (selection.model !== undefined) {
      // `provider / model` 形态：T4 的 dispatcher 据此切分（`splitModelField`），
      // 同时让用户在 /状态 与 /模型 里能分辨同名模型的供应商。
      status.model =
        selection.provider !== undefined && selection.provider !== ''
          ? `${selection.provider} / ${selection.model}`
          : selection.model;
    }
    if (selection.reasoningEffort !== undefined) status.reasoningEffort = selection.reasoningEffort;

    if (live !== undefined) {
      status.busy = this.isBusy(live.session);
      if (this.ctx.permissionPresets !== undefined) {
        status.permissionPreset = this.ctx.permissionPresets.current(live.session);
      }
      const measurement = this.measureQuietly(live.session);
      if (measurement !== undefined) {
        status.contextTokens = measurement.totalTokens;
        const window = this.contextWindowQuietly(live.session);
        if (window !== undefined) status.contextWindow = window;
      }
    }

    return status;
  }

  // ───────────────────────── D29：目标有效性校验 ─────────────────────────

  async validateTarget(openid: string): Promise<{ valid: boolean; notice?: string }> {
    const target = this.store.get(openid);
    if (target.sessionId === null) return { valid: false };

    const location = await this.locateSession(target.sessionId);
    if (location.archived) {
      await this.clearTargetQuietly(openid, '目标已归档');
      return {
        valid: false,
        notice: t('common.targetArchived'),
      };
    }
    if (location.error !== undefined) {
      return {
        valid: false,
        notice: t('common.targetCheckFailed', { error: location.error }),
      };
    }
    if (!location.exists) {
      await this.clearTargetQuietly(openid, '目标不存在');
      return {
        valid: false,
        notice: t('common.targetMissing'),
      };
    }
    return { valid: true };
  }

  // ───────────────────────── 启动恢复（D28） ─────────────────────────

  /** 读取全部持久化目标：有效则 resume，归档/不存在则清空（D29），并如实回报每一条。 */
  async restorePersistedTargets(): Promise<StartupRestoreReport> {
    const entries: StartupRestoreEntry[] = [];
    const resumedSessions = new Map<string, TakeoverResult>();

    for (const [openid, target] of this.store.entries()) {
      if (target.sessionId === null) {
        entries.push({ openid, target, cleared: false });
        continue;
      }
      const location = await this.locateSession(target.sessionId);
      if (location.archived || (!location.exists && location.error === undefined)) {
        await this.clearTargetQuietly(openid, location.archived ? '目标已归档' : '目标不存在');
        entries.push({
          openid,
          target,
          cleared: true,
          notice: location.archived ? t('common.targetArchived') : t('common.targetMissing'),
        });
        continue;
      }
      if (location.error !== undefined) {
        entries.push({ openid, target, cleared: false, notice: `检查会话失败：${location.error}` });
        continue;
      }

      const cached = resumedSessions.get(target.sessionId);
      if (cached !== undefined) {
        entries.push({ openid, target, cleared: false, takeover: cached });
        continue;
      }
      const resolution = await this.ensureAgent(target.sessionId);
      const takeover: TakeoverResult = resolution.ok
        ? { ok: true, sessionId: target.sessionId }
        : { ok: false, code: resolution.code, reason: resolution.reason };
      resumedSessions.set(target.sessionId, takeover);
      entries.push({ openid, target, cleared: false, takeover });
    }

    return { targets: entries };
  }

  /** 释放本服务自己持有的 AgentHandle（resume/新建产生的句柄） */
  async dispose(): Promise<void> {
    const handles = [...this.ownedHandles.values()];
    this.ownedHandles.clear();
    for (const handle of handles) {
      await handle.dispose().catch(() => undefined);
    }
  }

  // ───────────────────────── 内部实现 ─────────────────────────

  /**
   * 接管核心：**优先 `agents.get` 复用 live agent**（E12-A：同进程同一实例，不触锁）；
   * 仅在其缺席时才 `agents.resume`，且**只尝试一次、绝不复试、绝不降级 create**（D30 / E12-B）。
   */
  private async ensureAgent(sessionId: string): Promise<AgentResolution | AgentResolutionFailure> {
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) return { ok: true, agent: live, reusedLive: true };

    const owned = this.ownedHandles.get(sessionId);
    if (owned !== undefined) return { ok: true, agent: owned.agent, reusedLive: false };

    try {
      const resumeSelection = this.officialAgentOptions();
      // D52：按**该会话记录在案**的 preset 重新组合（官方 `resumeObserved` 的同一判据，
      // `dsh-api-session-controller/lib/index.js:401`）。原文理由（`dsh-session/lib/types/types.d.ts:88-94`）：
      //   "Durable because the preset decides the session's tools and prompt: a resume that restored
      //    a different composition would replay history the model can no longer act on."
      // 记录缺席（老会话 / 无 preset 部署）→ `agentSetup(undefined)` 落部署默认，
      // 与官方 `composeAgent(undefined)` 同义。
      const recordedPreset = await this.recordedAgentPreset(sessionId);
      const resumeSetup = this.agentSetup(recordedPreset);
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        ...(resumeSelection !== undefined ? { agentOptions: resumeSelection } : {}),
        ...(resumeSetup !== undefined ? { setup: resumeSetup } : {}),
      });
      this.ownedHandles.set(sessionId, handle);
      return { ok: true, agent: handle.agent, reusedLive: false };
    } catch (err) {
      if (isSessionAlreadyOwned(err)) {
        // E12-B：锁由 live agent 的 write handle 持有，与 turn 是否在跑无关；
        // 内部退避重试实测无意义 → 立即如实回执，绝不 resume().catch(() => create())。
        return {
          ok: false,
          code: 'locked',
          reason: t('common.sessionBusy'),
        };
      }
      return { ok: false, code: 'error', reason: `恢复会话失败：${errorMessage(err)}` };
    }
  }

  /**
   * 判忙（设计方案 §7.3）：`turnBoundary.openTurnStartSeq !== null` 即忙。
   * E12-A【实测】运行中非 null、结束后 null。投影缺席时**如实告警**并视为空闲
   * （不自行维护 turn 配对；`dsh-agent-loop` 必然注册该投影）。
   */
  private isBusy(session: Session): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary');
    if (boundary === undefined) {
      if (!this.projectionWarningLogged) {
        this.projectionWarningLogged = true;
        this.log('warn', 'sessionProjections 缺席 turnBoundary 投影，判忙退化为「空闲」');
      }
      return false;
    }
    return boundary.openTurnStartSeq !== null;
  }

  /**
   * 读取 DSH 官方的默认模型选择（`ctx.agentDefaultModel.currentSelection()`）。
   * 用于给新建/接管的 agent 提供 `agentOptions`——**不是**插件自有的模型状态（D26 合规）。
   */
  /**
   * 构造 agent 的 `setup(agentCtx)`：挂载 **agent preset**，使新建/接管的会话拥有
   * 与 WebUI 一致的完整工具集（bash / 读写文件等）。
   * 依 `mount()` 文档「Call from the agent factory's `setup(agentCtx)`」，
   * 且失败会**回滚 agent 创建**——这正是我们要的（不产出半装配会话）。
   *
   * @param presetId - 要挂载的 preset id（D52）；**缺省即部署默认**。新建时传
   *   `resolveAgentPreset()` 的结果、接管时传 `recordedAgentPreset()` 的结果，
   *   保证「记录的 id」与「挂载的 id」是同一个。
   */
  private agentSetup(presetId?: string): AgentSetup | undefined {
    const presets = this.ctx.agentPresets;
    if (presets === undefined) return undefined;
    return (agentCtx: unknown): Promise<void> => presets.mount(agentCtx, presetId).then(() => undefined);
  }

  /**
   * 解析**本次新建会话**要用的 preset id（D52）。
   *
   * 官方判据【文档明写】`dsh-api-session-controller/lib/index.js:355-361`：
   * `const resolvedId = (await presets.resolve(presetId)).id;` ⇒ 写 `meta.agentPreset` 的、
   * 与 `mount(agentCtx, resolvedId)` 挂载的**必须是同一个 id**。
   * `resolve()` 缺省即**部署默认**（`settings['agent-presets'].default` 优先于 `config.default`）。
   *
   * 服务缺席（部署没装 agent-presets）→ `undefined`：不写 header、不挂 preset（与旧行为一致）。
   * 解析失败**抛出**，由调用方如实回报为 `create-failed`（不静默落到别的 preset）。
   */
  private async resolveAgentPreset(): Promise<string | undefined> {
    const presets = this.ctx.agentPresets;
    if (presets === undefined) return undefined;
    return (await presets.resolve()).id;
  }

  /**
   * 读取**该会话记录在案的 agent preset**（D52），用于接管/冷 resume 时复原组合。
   *
   * 官方判据【文档明写】`dsh-api-session-controller/lib/index.js:401`（`resumeObserved`）：
   * 用 `presetForObservation(observation)` → `observation.projections.values.agentPreset`；
   * 而**绝不只看 header**（`dsh-agent-presets/lib/types/session.d.ts`：
   * *"Reconstruction reads the `agentPreset` Session projection, never the header alone."*）——
   * 会话在空白期切换 preset 只追加 `agent-preset/selected` 事件、不改 header。
   *
   * 读不到（无 `sessionQuery`、会话不存在、存储故障）时返回 `undefined`，
   * 调用方按官方 `composeAgent(undefined)` 的语义落到**部署默认**（如实降级，不猜）。
   */
  private async recordedAgentPreset(sessionId: string): Promise<string | undefined> {
    const query = this.ctx.sessionQuery;
    if (query === undefined) return undefined;

    let observation: SessionObservationLike;
    try {
      observation = await query.observeSession(sessionId);
    } catch (err) {
      this.log('warn', '读取会话 agent preset 失败，接管时按部署默认挂载', {
        sessionId,
        error: errorMessage(err),
      });
      return undefined;
    }

    try {
      const projected = observation.projections?.values.agentPreset;
      return typeof projected === 'string' ? projected : undefined;
    } finally {
      // 官方 `SessionObservation extends Disposable`：不释放会把冷会话条目钉在缓存里
      observation[Symbol.dispose]?.();
    }
  }

  private officialAgentOptions(): AgentOptions | undefined {
    const service = this.ctx.agentDefaultModel;
    if (service === undefined) return undefined;
    try {
      const selection = service.currentSelection();
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          // 官方服务交回的是普通 string；`AgentOptions.reasoningEffort` 是 branded 类型，
          // 在此边界做一次**显式收窄**（brand 仅为编译期标记，运行期就是该字符串）。
          ...(selection.reasoningEffort !== undefined
            ? { reasoningEffort: selection.reasoningEffort as AgentOptions['reasoningEffort'] }
            : {}),
        };
      }
    } catch {
      // 官方服务读取失败 → 不传 agentOptions（DSH 会用自己的默认）
    }
    return undefined;
  }

  /**
   * 读取「该会话**当前**的模型选择」（D48）。
   *
   * **必须照抄官方判据**——官方 `selectionFor().current` 的唯一实现是
   * 【文档明写】`dsh-api-session-controller/lib/index.js:282-295`：
   *   ① `modelSelection` 投影的 `pending`（刚切换、尚未被请求消费）
   *   ② `session.requestHeader().config`（**最后一次真实请求**的头，含 provider）
   *   ③ `agentDefaultModel.currentSelection()`（部署默认）
   *
   * ️ **绝不能读 `agent.options`**：那是**会话创建时**的配置。官方 `/模型` 切换走
   * `agents.selectForNextRequest()`【文档明写】`lib/index.js:315-318`：
   * `agent.session.append('model/selection', selection)` + 该服务内部 Map，
   * **不会更新 `options`** ⇒ 读它会永远显示旧模型。真机 bug（用户报告 2026-09-16）：
   * `/模型` 切到 `opencode-go / deepseek-flash` 成功、WebUI 已生效，
   * 而 `/思考` 仍报 `aliyun-token-plan / deepseek-v4.1-flash`。
   */
  private resolveModelSelection(live: Agent | undefined): {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  } {
    if (live === undefined) {
      // 冷会话（无 live Agent）：读不到会话投影与请求头，只能回部署默认（如实降级）
      const fallback = this.ctx.agentDefaultModel?.currentSelection();
      return fallback === undefined ? {} : normalizeSelection(fallback);
    }

    // ① 投影 pending：官方 `/模型` 刚装上、还没被真实请求消费的选择
    const pending = this.readPendingModelSelection(live.session);
    if (pending !== undefined) return normalizeSelection(pending);

    // ② 该会话最后一次真实请求的头（含 provider —— 官方也在这里取 provider）
    const header = live.session.requestHeader();
    if (header !== undefined) {
      const logged = header.config;
      const out: { provider?: string; model?: string; reasoningEffort?: string } = {};
      if (logged.provider !== undefined) out.provider = String(logged.provider);
      if (logged.model !== undefined) out.model = String(logged.model);
      // 官方：由适配器**默认**得到的 effort 不算「会话选择了该档位」（`:293`）
      if (logged.reasoningEffort !== undefined && header.adapterDefaults?.reasoningEffort !== true) {
        out.reasoningEffort = String(logged.reasoningEffort);
      }
      if (out.provider !== undefined || out.model !== undefined) return out;
    }

    // ③ 部署默认
    if (this.ctx.agentDefaultModel !== undefined) {
      return normalizeSelection(this.ctx.agentDefaultModel.currentSelection());
    }
    return {};
  }

  /**
   * 安静读取 `modelSelection` 投影的 `pending`（D48）。
   * 该投影单元由 `dsh-api-session-controller` 注册（web 平面）；base-only / headless 装配里
   * 不存在——官方此时会**抛错**（`lib/index.js:281`），我们只做降级（不显示升/降级噪声）。
   */
  private readPendingModelSelection(session: Session): ModelSelectionLike | undefined {
    try {
      const state = this.ctx.sessionProjections.stateOf(session, 'modelSelection');
      return state?.pending ?? undefined;
    } catch {
      return undefined;
    }
  }

  private measureQuietly(session: Session): TokenMeasurement | undefined {
    if (this.ctx.tokenMeter === undefined) return undefined;
    try {
      return this.ctx.tokenMeter.measure(session);
    } catch (err) {
      this.log('warn', 'tokenMeter.measure 失败', errorMessage(err));
      return undefined;
    }
  }

  private contextWindowQuietly(session: Session): number | undefined {
    try {
      const snapshot = this.ctx.sessionProjections.snapshot(session, ['contextPressure']);
      const contextWindow = snapshot.values.contextPressure?.contextWindow;
      return typeof contextWindow === 'number' ? contextWindow : undefined;
    } catch (err) {
      this.log('warn', 'contextPressure 投影读取失败', errorMessage(err));
      return undefined;
    }
  }

  /** 会话存在性/归档定位；区分「确定不存在」与「存储故障」 */
  private async locateSession(sessionId: string): Promise<SessionLocation> {
    const archived = isArchivedSession(this.ctx.workspaceRegistry, sessionId);
    const membership = this.ctx.workspaceRegistry
      .list()
      .find((workspace) => workspace.sessionIds.some((id) => String(id) === sessionId));
    const memberWorkspaceId = membership === undefined ? null : String(membership.id);

    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) {
      const cwd = live.session.header.cwd;
      return {
        exists: true,
        archived,
        workspaceId: memberWorkspaceId ?? (await this.workspaceIdForCwd(cwd)),
        ...(cwd !== undefined ? { cwd } : {}),
      };
    }

    if (memberWorkspaceId !== null) {
      return { exists: true, archived, workspaceId: memberWorkspaceId };
    }

    if (this.ctx.sessionQuery !== undefined) {
      try {
        const results = await this.ctx.sessionQuery.readTitleSnapshots([sessionId]);
        const first = results[0];
        if (first !== undefined && first.status === 'fulfilled') {
          const cwd = first.value?.session?.cwd;
          return {
            exists: true,
            archived,
            workspaceId: await this.workspaceIdForCwd(cwd),
            ...(cwd !== undefined ? { cwd } : {}),
          };
        }
        if (first !== undefined && first.status === 'rejected') {
          const cause = first.error;
          if (cause !== undefined && !isSessionNotFound(cause)) {
            return { exists: false, archived, workspaceId: null, error: errorMessage(cause) };
          }
        }
        return { exists: false, archived, workspaceId: null };
      } catch (err) {
        if (isSessionNotFound(err)) return { exists: false, archived, workspaceId: null };
        return { exists: false, archived, workspaceId: null, error: errorMessage(err) };
      }
    }

    return { exists: false, archived, workspaceId: null };
  }

  private async workspaceIdForCwd(cwd: string | undefined): Promise<string | null> {
    if (cwd === undefined || cwd === '') return null;
    const byList = findWorkspaceRefByPath(listWorkspaceRefs(this.ctx.workspaceRegistry), cwd);
    if (byList !== undefined) return byList.id;
    try {
      const resolved = await this.ctx.workspaceRegistry.resolveByPath(cwd);
      return resolved === undefined ? null : String(resolved.id);
    } catch {
      return null;
    }
  }

  private async ensureWorkspaceRegistered(
    targetPath: string,
  ): Promise<{ ok: true; workspace: WorkspaceLike; created: boolean } | { ok: false; reason: string }> {
    const canonical = normalizePathForCompare(targetPath);
    const existing = await this.lookupWorkspace(targetPath);
    if (existing !== undefined) return { ok: true, workspace: existing, created: false };
    try {
      const created = await this.ctx.workspaceRegistry.create(canonical);
      return { ok: true, workspace: created, created: true };
    } catch (err) {
      // 注册竞态：注册失败后回查一次，命中则复用
      const again = await this.lookupWorkspace(targetPath);
      if (again !== undefined) return { ok: true, workspace: again, created: false };
      return { ok: false, reason: `注册工作区失败：${errorMessage(err)}` };
    }
  }

  private async lookupWorkspace(targetPath: string): Promise<WorkspaceLike | undefined> {
    const canonical = normalizePathForCompare(targetPath);
    const byList = this.ctx.workspaceRegistry
      .list()
      .find((workspace) => normalizePathForCompare(workspace.path) === canonical);
    if (byList !== undefined) return byList;
    try {
      return await this.ctx.workspaceRegistry.resolveByPath(canonical);
    } catch {
      return undefined;
    }
  }

  private async clearTargetQuietly(openid: string, reason: string): Promise<void> {
    try {
      await this.clearTarget(openid, reason);
    } catch (err) {
      this.log('warn', '清空控制目标失败', { openid, reason, error: errorMessage(err) });
    }
  }

  private log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
    const logger = this.ctx.logger;
    if (logger === undefined) return;
    logger[level](...args);
  }
}

/** 工作区实体（`Workspace` 的结构面，避免与命名空间冲突） */
type WorkspaceLike = Awaited<ReturnType<WorkspaceRegistryLike['create']>>;

// ═══════════════════════════ 装配入口 ══════════════════════════

export interface OpenedControlService {
  /** 冻结契约面，供 `InboundDeps.control` 注入 */
  control: ControlService;
  /** 具体实现（接线层可调 `restorePersistedTargets` / 诊断方法） */
  service: DshControlService;
  /** 启动恢复结果（D28） */
  restore: StartupRestoreReport;
  /** 释放：本服务持有的 AgentHandle + 目标存储域 */
  dispose(): Promise<void>;
}

/**
 * 装配控制服务：打开目标存储域 → 构造服务 → 按 D28 自动恢复并 resume 持久化目标。
 * 调用方（`src/index.ts`）持有 `dispose()` 生命周期。
 */
export async function openControlService(
  ctx: ControlContext,
  options: ControlServiceOptions = {},
): Promise<OpenedControlService> {
  const opened = options.targetStore !== undefined
    ? { store: options.targetStore, close: async () => undefined }
    : await openTargetStore(ctx);

  const service = new DshControlService(ctx, opened.store, options);
  let restore: StartupRestoreReport = { targets: [] };
  if (options.restoreOnStart !== false) {
    restore = await service.restorePersistedTargets();
  }

  return {
    control: service,
    service,
    restore,
    dispose: async () => {
      await service.dispose();
      await opened.close();
    },
  };
}