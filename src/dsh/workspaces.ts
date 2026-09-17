/**
 * dsh-qqbot-bridge: 工作区与会话枚举服务
 *
 * 负责通过 DSH 官方 `workspaceRegistry` 读取当前环境中的全部工作区及会话列表：
 * 1. 过滤已归档或已从磁盘移除的无效会话；
 * 2. 对齐 WebUI 会话计数与显示排序规则；
 * 3. 工作区本地路径的比对与规范化。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace';
import type { SessionRef, WorkspaceRef } from '../types/index.js';

/**
 * 工作区注册表的最小结构面。
 * 用结构类型而非直接依赖 `WorkspaceRegistry` 类的原因：该类含私有字段，
 * 直接用作注入类型会挡住契约测试的结构替身（AGENTS.md §3.1 允许对外部服务隔离）。
 */
export interface WorkspaceRegistryLike {
  list(): Workspace[];
  get(id: WorkspaceId): Workspace | undefined;
  readonly archivedSessionIds: readonly SessionId[];
  resolveByPath(path: string): Promise<Workspace | undefined>;
  create(path: string, title?: string): Promise<Workspace>;
}

/** 会话标题服务的最小结构面（`ctx.sessionTitle`） */
export interface SessionTitleLike {
  get(session: { readonly id: string }): { readonly title: string } | undefined;
}

/** 一条批量标题观测结果（对齐 `ctx.sessionQuery.readTitleSnapshots` 的返回形状） */
export interface SessionTitleObservationLike {
  readonly sessionId: SessionId;
  readonly status: 'fulfilled' | 'rejected';
  readonly value?: {
    /** `SessionHeader` 的结构子集；`origin` 是 D46 要用的**零新依赖**来源（标题观测本来就带 header） */
    readonly session?: { readonly cwd?: string; readonly createdAt?: number; readonly origin?: 'subagent' };
    readonly title?: { readonly title: string };
  };
  /** `rejected` 时携带的失败原因（`SessionQueryError` 等）；用于区分「不存在」与「存储故障」 */
  readonly error?: unknown;
}

/**
 * 一次**冷会话观测**（官方 `SessionObservation`）的最小结构面。
 * 【文档明写】`dsh-session-query/lib/types/observation.d.ts:7-31`：
 * `header` / `projections`（投影基线，registry 已挂载时才有）/ `[Symbol.dispose]`（**可释放租约**）。
 */
export interface SessionObservationLike {
  /** 不可变会话身份元数据（含 `agentPreset`：会话**创建时**记录的 preset） */
  readonly header: { readonly agentPreset?: string };
  /**
   * 投影基线（官方 `ProjectionSnapshot`，`dsh-session-projection/lib/types/index.d.ts:92-97`）：
   * `values` 是 `Partial<SessionProjectionMap>`，其中 `agentPreset: string | null`
   * （`dsh-api-session-controller/lib/typert.host.js:1801`）。**投影才是权威判据**——
   * 空白期切换 preset 只追加 `agent-preset/selected` 事件、不改 header
   * （`dsh-agent-presets/lib/types/session.d.ts`："Reconstruction reads the `agentPreset` Session
   * projection, never the header alone."）。
   */
  readonly projections?: { readonly values: { readonly agentPreset?: string | null } };
  /** 释放本次观测租约（官方 `SessionObservation extends Disposable`） */
  [Symbol.dispose]?(): void;
}

/** 会话查询服务的最小结构面（`ctx.sessionQuery`）；官方实现由 `session-query-sqlite` 提供 */
export interface SessionQueryLike {
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly SessionTitleObservationLike[]>;
  /**
   * 观测一条**live 优先 / 冷加载**的会话，返回可释放租约。
   * 【文档明写】`dsh-session-query/lib/types/index.d.ts:47`；
   * 官方控制层读会话 preset 走的就是它（`dsh-api-session-controller/lib/index.js:381-386`）。
   */
  observeSession(sessionId: string): Promise<SessionObservationLike>;
}

/** live agent 查询面（用于 live 会话标题回退） */
export interface AgentLookupLike {
  get(id: string): { readonly session: { readonly id: string } } | undefined;
}

/** 列表展示用的会话附加信息 */
export interface SessionFacet {
  title?: string;
  cwd?: string;
  createdAt?: number;
  /** D46：`SessionHeader.origin`（`subagent` 在 WebUI 隐藏） */
  origin?: 'subagent';
}

/**
 * 一条会话**活跃元数据**（D46）——对齐官方 `SessionSummary` 的展示子集
 * 【文档明写】`dsh-api-session-controller/lib/types/types.d.ts:145-154`。
 */
export interface SessionActivityEntry {
  readonly sessionId: string;
  /**
   * 官方 `updatedAt` = `Math.max(header.createdAt, sessionListMetadata.lastPromptAt ?? 0)`
   * 【文档明写】`dsh-api-session-controller/lib/index.js:1969-1971`；
   * `lastPromptAt` 取**最后一条** `user/message` 且 `source.kind === 'user'` 的事件时间
   * （`lib/types/list.js:28-36`）。本项目发给 DSH 的 QQ 消息正写 `source:{kind:'user'}`
   * （`src/dsh/control.ts`），故 QQ 侧消息会被正确计入。
   */
  readonly updatedAt: number;
  /** 官方 `blank`（= 无 `turn/start`，`lib/index.js:1749-1756`）；WebUI `sessionVisible` 判据之一 */
  readonly blank: boolean;
  /** 官方 `origin`；`subagent` 在 WebUI 隐藏 */
  readonly origin?: 'subagent';
}

/**
 * 会话活跃元数据来源（D46）：由 `src/index.ts` 把官方 `ctx.sessionController` 适配成
 * **一次读取全部可见会话**（`list()` 的 JSDoc：「Read all visible Session rows … ordered by activity」
 * 【文档明写】`dsh-api-session-controller/lib/types/index.d.ts:68-73`）。
 *
 * 缺失或抛错时控制层**降级**：不显示时间、不过滤空白会话，功能不受影响。
 */
export interface SessionActivitySource {
  list(): Promise<readonly SessionActivityEntry[]>;
}

/**
 * D36：**内置默认工作区**路径 —— `$DSH_HOME/workspace/default`。
 *
 * 用途：新装插件后用户没做任何选择就直接发消息时，会话落在这里，
 * **不会**落到用户主目录，也不会落到 DSH 内部目录（`sessions/`、`storages/`…）。
 * 目录**惰性创建**（首次真正用到时 `mkdir -p` + 注册工作区，见 `DshControlService.createSession`），
 * 因此"装了但没发消息"不会留下空目录。
 *
 * 语义边界：仅作为「无工作区作用域」时的兜底；用户在 `/切换` 选过工作区后，
 * `/新建` 与自动新建都落在**该作用域工作区**（D36）。
 */
export function resolveDefaultWorkspacePath(dshHome: string): string {
  return path.join(dshHome, 'workspace', 'default');
}

/** 规范化路径用于**精确比较**：解析为绝对路径，并尽量折叠符号链接/`..`/尾斜杠 */
export function normalizePathForCompare(raw: string): string {
  let out = path.resolve(raw);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // 路径可能尚不存在（如 `/新建 <相对路径>` 的待创建目录）——退回 resolve 结果即可。
  }
  if (out.length > 1 && out.endsWith(path.sep)) out = out.slice(0, -1);
  return out;
}

export function toWorkspaceRef(workspace: Workspace): WorkspaceRef {
  return {
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionIds: workspace.sessionIds.map((id) => String(id)),
  };
}

export function listWorkspaceRefs(registry: WorkspaceRegistryLike): WorkspaceRef[] {
  return registry.list().map(toWorkspaceRef);
}

export function findWorkspaceRef(registry: WorkspaceRegistryLike, workspaceId: string): WorkspaceRef | undefined {
  const found = registry.get(workspaceId as WorkspaceId);
  return found === undefined ? undefined : toWorkspaceRef(found);
}

/** path 精确匹配（两侧都先规范化比较；不做模糊/包含匹配） */
export function findWorkspaceRefByPath(refs: readonly WorkspaceRef[], rawPath: string): WorkspaceRef | undefined {
  const wanted = normalizePathForCompare(rawPath);
  return refs.find((ref) => normalizePathForCompare(ref.path) === wanted);
}

export function isArchivedSession(registry: WorkspaceRegistryLike, sessionId: string): boolean {
  return registry.archivedSessionIds.some((id) => String(id) === sessionId);
}

/**
 * 批量读取会话标题/头部信息（D33 列表展示）。
 * 读不到（`rejected`）的会话**不静默丢弃**——保留在结果之外由调用方决定，调用方按 id 兜底展示。
 */
export async function readSessionFacets(
  query: SessionQueryLike | undefined,
  sessionIds: readonly string[],
): Promise<Map<string, SessionFacet>> {
  const facets = new Map<string, SessionFacet>();
  if (query === undefined || sessionIds.length === 0) return facets;
  const results = await query.readTitleSnapshots(sessionIds);
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value === undefined) continue;
    const facet: SessionFacet = {};
    if (result.value.title !== undefined) facet.title = result.value.title.title;
    if (result.value.session?.cwd !== undefined) facet.cwd = result.value.session.cwd;
    if (result.value.session?.createdAt !== undefined) facet.createdAt = result.value.session.createdAt;
    // D46：origin 随标题观测的 header 一起来，**零新依赖**即可对齐 WebUI 的 subagent 隐藏
    if (result.value.session?.origin !== undefined) facet.origin = result.value.session.origin;
    facets.set(String(result.sessionId), facet);
  }
  return facets;
}

export interface SessionRefDeps {
  registry: WorkspaceRegistryLike;
  sessionQuery?: SessionQueryLike;
  sessionTitle?: SessionTitleLike;
  agents?: AgentLookupLike;
  /** D46：会话活跃元数据（时间 / 空白 / origin），由控制层读取后按 sessionId 传入 */
  activity?: ReadonlyMap<string, SessionActivityEntry>;
}

/**
 * 列出某个工作区下的会话（D33）。
 *
 * 顺序沿用 `workspace.sessionIds` 的**手工归属顺序**（新增在最前，活动不重排——官方语义）。
 * 标题来源优先级：① `sessionQuery.readTitleSnapshots`（live 优先，可读历史会话）；
 * ② live agent 的 `sessionTitle.get`（查询服务缺席时的降级）。两者都拿不到时 `title` 留空。
 *
 * D46：本函数仍是**忠实投影＋不做展示策略**——`activity` 只用来补 `lastActive` / `blank` /
 * `origin` 三个字段；「按 WebUI 隐藏空白会话、按活跃度排序、渲染相对时间」全部留在命令层
 * （与 D45 的分层一致，避免把展示口径下沉到数据层）。
 */
export async function listSessionRefs(deps: SessionRefDeps, workspaceId: string): Promise<SessionRef[]> {
  const workspace = deps.registry.get(workspaceId as WorkspaceId);
  if (workspace === undefined) return [];

  const sessionIds = workspace.sessionIds.map((id) => String(id));
  const facets = await readSessionFacets(deps.sessionQuery, sessionIds);

  return sessionIds.map((sessionId) => {
    const facet = facets.get(sessionId);
    let title = facet?.title;
    if (title === undefined && deps.sessionTitle !== undefined && deps.agents !== undefined) {
      const live = deps.agents.get(sessionId);
      if (live !== undefined) title = deps.sessionTitle.get(live.session)?.title;
    }
    const ref: SessionRef = {
      sessionId,
      workspaceId: String(workspace.id),
      workspaceTitle: workspace.title,
      archived: isArchivedSession(deps.registry, sessionId),
    };
    if (title !== undefined) ref.title = title;
    // D46：origin 先取零依赖来源（标题观测的 header 本来就带），
    // 活跃元数据到达时再补齐时间/空白，并用它更权威的 origin 覆盖。
    if (facet?.origin !== undefined) ref.origin = facet.origin;
    const activity = deps.activity?.get(sessionId);
    if (activity !== undefined) {
      ref.lastActive = activity.updatedAt;
      ref.blank = activity.blank;
      if (activity.origin !== undefined) ref.origin = activity.origin;
    }
    return ref;
  });
}