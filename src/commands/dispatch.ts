/**
 * dsh-qqbot-bridge: 命令分发器
 *
 * 负责解析并执行 QQ 端输入的各类远程控制斜杠命令：
 * - 会话控制：/会话、/切换、/新建、/停止、/压缩；
 * - 模型与权限：/模型、/思考、/权限（直通 DSH 官方服务契约，无自有状态维护）；
 * - 辅助与导航：/状态、/帮助、/上一页、/下一页。
 *
 * 所有命令执行回执统一采用纯文本通道，并自动进行长度安全截断。
 */

import * as path from 'node:path';
import { homedir } from 'node:os';
import type {
  CommandContext,
  CommandDispatcher,
  CommandResult,
  CompactOutcome,
  ControlService,
  PagingStore,
  SessionRef,
  SessionStatus,
  WorkspaceRef,
} from '../types/index.js';
import type { Logger } from '../utils/logger.js';
import { REPLY_MAX_CHARS } from '../constants/index.js';
import { t } from '../i18n/index.js';
import { COMMAND_NAMES, isKnownCommand, isPagingCommand, PAGING_COMMANDS } from './parse.js';
import { defaultPageSize, paginate, type Page } from './paging.js';

// ═══════════════════ 官方服务门面（D26/D31：直调，不落插件自有状态） ═══════════════════

export interface ModelOption {
  provider: string;
  model: string;
  name?: string;
}

export interface ModelSelectionInput {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ReasoningEffortOption {
  id: string;
  name: string;
  description?: string;
}

export interface ReasoningInfo {
  supported: boolean;
  efforts: readonly ReasoningEffortOption[];
  defaultEffort?: string;
}

/**
 * 官方模型/思考服务门面。实现由 `src/index.ts` 用真实 DSH 服务装配
 * （`llm.listProviders/listModels` + `sessionController.selectModel` + `llm.resolveModelInfo`）。
 * 本插件不自建模型状态（D26）。
 */
export interface OfficialModelService {
  list(): Promise<readonly ModelOption[]>;
  select(sessionId: string, selection: ModelSelectionInput): Promise<void>;
  reasoning(provider: string, model: string): Promise<ReasoningInfo>;
}

/** 官方权限预设服务门面（`ctx.permissionPresets`，D31） */
export interface OfficialPermissionService {
  list(): Promise<readonly string[]>;
  set(sessionId: string, preset: string): Promise<void>;
}

export interface CommandDispatcherOptions {
  control: ControlService;
  paging: PagingStore;
  logger: Logger;
  /** 官方模型/思考服务；缺省时相关命令如实回执「服务不可用」（不静默假成功） */
  models?: OfficialModelService;
  /** 官方权限预设服务；缺省时如实回执 */
  permissions?: OfficialPermissionService;
  /** D34：回执截断上限（默认 `REPLY_MAX_CHARS`） */
  replyMaxChars?: number;
  /** 分页大小（默认 `LIST_PAGE_SIZE` = 10，D21） */
  listPageSize?: number;
  /** D32：`/状态` 是否显示上下文用量（默认显示） */
  statusShowUsage?: boolean;
  /**
   * D36：`allow_create_session` 开关（默认 true）。
   * 关闭时 `/新建` 被拒（该字段此前只是配置项，未真正生效——本次一并接上）。
   */
  allowCreateSession?: boolean;
}

// ═══════════════════════════ 纯文本渲染工具 ═══════════════════════════

/** D34：命令回执按 `reply_max_chars` 截断 */
export function truncateReply(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Token 紧凑格式化：<1k 原值 / <1M 一位小数 K / 否则 M */
export function formatTokens(value: number): string {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return '0';
  const scaled = (candidate: number) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return `${scaled(value / 1e3)}K`;
  return `${scaled(value / 1e6)}M`;
}

/** `/状态` 的短 id：`session-<前 4 位>…`（设计文档 §7.4） */
export function shortSessionId(sessionId: string): string {
  const rest = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  if (rest.length <= 4) return sessionId;
  return sessionId.startsWith('session-') ? `session-${rest.slice(0, 4)}…` : `${rest.slice(0, 6)}…`;
}

/**
 * 工作区展示标签（用户决策）：优先「标题 (路径)」，缺标题退路径、缺路径退标题，
 * 都缺才回退裸 id。`/新建`、未选中态 `/状态`、`/切换` 成功后一律不得只印裸工作区 id——
 * 裸 id 在 QQ 侧无法判断「到底落在哪个工作区」（复刻 `inbound/pipeline.ts` 的解析方式）。
 */
export function formatWorkspaceLabel(workspace: WorkspaceRef | undefined, fallbackId: string): string {
  if (!workspace) return fallbackId;
  const title = workspace.title?.trim() ?? '';
  const path = workspace.path?.trim() ?? '';
  if (title && path) return title === path ? path : `${title} (${path})`;
  return path || title || fallbackId;
}

/**
 * 相对时间（D46）：与 WebUI **逐档对齐**——`刚刚` / `N分钟` / `N小时` / `N天` / `N个月` / `N年`。
 *
 * 【文档明写】分档边界 `dsh-client-ui-primitives/lib/index.js:4944-4972`；
 * 中文文案 `dsh-client-ui-workspace/lib/client.js:2625-2629`。
 * 例：`刚刚`、`5分钟`、`3小时`、`4天`、`2个月`、`1年`。
 *
 * 规范：时间缺失时整段省略，不显示冗余占位符。
 * 文案取自 `src/i18n/zh-CN.ts`（`commands.sessions.time`）。
 */
function formatRelativeTime(ms?: number, now: number = Date.now()): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return t('commands.sessions.time.justNow');
  if (diff < HOUR) return t('commands.sessions.time.minutes', { n: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('commands.sessions.time.hours', { n: Math.floor(diff / HOUR) });
  if (diff < 30 * DAY) return t('commands.sessions.time.days', { n: Math.floor(diff / DAY) });
  if (diff < 365 * DAY) return t('commands.sessions.time.months', { n: Math.floor(diff / (30 * DAY)) });
  return t('commands.sessions.time.years', { n: Math.floor(diff / (365 * DAY)) });
}

/** 权限档位展示（中文档位 + 官方 preset 便于与 DSH 侧核对） */
export function permissionLabel(preset?: string): string {
  if (!preset) return t('commands.permission.unknown');
  const map: Record<string, string> = {
    readonly: t('commands.permission.labelReadonly'),
    'read-only': t('commands.permission.labelReadonly'),
    'workspace-write': t('commands.permission.labelEdit'),
    edit: t('commands.permission.labelEdit'),
    'danger-full-access': t('commands.permission.labelFull'),
    yolo: t('commands.permission.labelFull'),
  };
  const label = map[preset];
  return label ? t('commands.permission.withPreset', { label, preset }) : preset;
}

/** `status.model` 可能是 `model` 或 `provider / model`（两种形态都接受，不假设实现细节） */
function splitModelField(field?: string): { provider?: string; model?: string } {
  const text = (field ?? '').trim();
  if (!text) return {};
  const idx = text.indexOf(' / ');
  if (idx > 0) return { provider: text.slice(0, idx).trim(), model: text.slice(idx + 3).trim() };
  return { model: text };
}

/** 工作区路径规范化（支持 `~` 展开；用于 `/切换 <路径>` 精确匹配，§6） */
function normalizeWorkspacePath(raw: string): string {
  const expanded = raw.startsWith('~/') ? path.join(homedir(), raw.slice(2)) : raw;
  const abs = path.resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

const ZH_EFFORT: Record<string, string> = {
  关: 'off',
  关闭: 'off',
  低: 'low',
  高: 'high',
  最大: 'max',
  极高: 'max',
  默认: 'default',
  重置: 'reset',
};

const ZH_PERMISSION: Record<string, readonly string[]> = {
  只读: ['readonly', 'read-only'],
  编辑: ['workspace-write', 'edit'],
  完全: ['danger-full-access', 'yolo'],
};

function renderHelp(): string {
  return [t('commands.help.title'), t('commands.help.body')].join('\n');
}

/**
 * `/会话` 的可选列表与 WebUI 侧边栏逐条对齐。
 *
 * 可见性：
 * ```text
 * session.origin !== 'subagent' && !archived.has(id) && (!blank || id === current)
 * ```
 * 其中 `current` 映射为**当前 QQ 控制目标**——桥接自己 `/新建` 出来的正是 blank 会话
 * （`src/dsh/control.ts` 的 createSession），不给这条例外，用户刚建完就会在列表里看不到它。
 *
 * 排序同 WebUI 的 `byRecency`：`updatedAt` 新→旧。这里用**稳定排序**，
 * 缺值/同值时保持注册表顺序，使降级路径（无时间元数据）行为可预期。
 *
 * 仍然**只在命令层**过滤与排序：`ControlService.listSessions` 保持「忠实投影 + 标记」语义。
 */
function visibleSessions(sessions: readonly SessionRef[], currentSessionId?: string | null): SessionRef[] {
  return sessions
    .filter((s) => !s.archived && s.origin !== 'subagent' && (!s.blank || s.sessionId === currentSessionId))
    .sort((a, b) => (b.lastActive ?? Number.NEGATIVE_INFINITY) - (a.lastActive ?? Number.NEGATIVE_INFINITY));
}

/** 空白会话的展示标签：对齐 WebUI 对 blank 行的本地化「新会话」标签 */
const BLANK_SESSION_LABEL = t('commands.sessions.blankTitle');

/** 列表行的标题：有标题用标题；空白会话用「新会话」标签；其余按短 id 兜底 */
function sessionListTitle(s: SessionRef): string {
  const title = s.title?.trim();
  if (title) return title;
  return s.blank ? BLANK_SESSION_LABEL : shortSessionId(s.sessionId);
}

function renderSessionList(sessions: readonly SessionRef[], page: Page<SessionRef>): string {
  const header = t('commands.sessions.header', {
    page: page.page,
    totalPages: page.totalPages,
    total: sessions.length,
  });
  // 同一屏用同一个「现在」，避免逐行取 now 造成同一时间显示两个档位
  const now = Date.now();
  const lines = page.items.map((s, i) => {
    const num = page.startIndex + i + 1;
    const title = sessionListTitle(s);
    const time = formatRelativeTime(s.lastActive, now);
    // 格式：`<序号>. <标题> <相对时间>`；拿不到时间就整段省略
    return time === undefined
      ? t('commands.sessions.row', { num, title })
      : t('commands.sessions.rowWithTime', { num, title, time });
  });
  // 翻页提示只在列表实际超过 1 页时出现；单页时仅保留选择提示
  const footer = `${page.totalPages > 1 ? t('commands.paging.footerPaging') : ''}${t('commands.paging.footerSelectSessions')}`;
  return [header, ...(lines.length ? lines : [t('commands.sessions.empty')]), '', footer].join('\n');
}

function renderWorkspaceList(
  workspaces: readonly WorkspaceRef[],
  page: Page<WorkspaceRef>,
  archivedIds: ReadonlySet<string>,
): string {
  const header = t('commands.workspaces.header', {
    page: page.page,
    totalPages: page.totalPages,
    total: workspaces.length,
  });
  const lines = page.items.map((w, i) => {
    const num = page.startIndex + i + 1;
    // 会话数与 WebUI 的 sessionCount 口径一致：不计归档
    const visible = w.sessionIds.filter((id) => !archivedIds.has(String(id))).length;
    return t('commands.workspaces.row', { num, title: w.title || w.id, path: w.path, count: visible });
  });
  // 翻页提示在超过 1 页时才展示
  const footer = `${page.totalPages > 1 ? t('commands.paging.footerPaging') : ''}${t('commands.paging.footerSelectWorkspaces')}`;
  return [header, ...(lines.length ? lines : [t('commands.workspaces.empty')]), '', footer].join('\n');
}

function renderSessionCandidates(all: readonly SessionRef[], matched: readonly SessionRef[]): string {
  return matched
    .map((s) =>
      t('commands.sessions.candidate', { num: all.indexOf(s) + 1, title: sessionListTitle(s) }),
    )
    .join('\n');
}

function renderWorkspaceCandidates(all: readonly WorkspaceRef[], matched: readonly WorkspaceRef[]): string {
  return matched
    .map((w) =>
      t('commands.workspaces.candidate', {
        num: all.indexOf(w) + 1,
        title: w.title || w.id,
        path: w.path,
      }),
    )
    .join('\n');
}

// ═══════════════════════════ 寻址（D23 / §6） ══════════════════════════

type SessionResolve =
  | { kind: 'one'; session: SessionRef }
  | { kind: 'multi'; matched: SessionRef[] }
  | { kind: 'none'; message: string };

/** 三级寻址：序号 → 标题全文 → 标题模糊；多命中返回候选，**严禁静默取第一个**（D23） */
function resolveSessionArg(sessions: readonly SessionRef[], arg: string): SessionResolve {
  const query = arg.trim();
  if (/^\d+$/.test(query)) {
    const n = Number.parseInt(query, 10);
    if (n < 1 || n > sessions.length) {
      return { kind: 'none', message: t('commands.sessions.indexOutOfRange', { max: sessions.length }) };
    }
    const session = sessions[n - 1];
    return session ? { kind: 'one', session } : { kind: 'none', message: t('commands.sessions.indexMissing') };
  }

  const lower = query.toLowerCase();
  const titled = sessions.filter((s) => (s.title ?? '').trim().length > 0);
  const exact = titled.filter((s) => (s.title ?? '').trim().toLowerCase() === lower);
  if (exact.length === 1 && exact[0]) return { kind: 'one', session: exact[0] };
  if (exact.length > 1) return { kind: 'multi', matched: exact };

  const fuzzy = titled.filter((s) => (s.title ?? '').toLowerCase().includes(lower));
  if (fuzzy.length === 1 && fuzzy[0]) return { kind: 'one', session: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: 'multi', matched: fuzzy };

  return { kind: 'none', message: t('commands.sessions.notFound', { query }) };
}

type WorkspaceResolve =
  | { kind: 'one'; workspace: WorkspaceRef }
  | { kind: 'multi'; matched: WorkspaceRef[] }
  | { kind: 'none'; message: string };

/** 工作区寻址：序号 → 路径精确 → 标题模糊（§6 末段） */
function resolveWorkspaceArg(workspaces: readonly WorkspaceRef[], arg: string): WorkspaceResolve {
  const query = arg.trim();
  if (/^\d+$/.test(query)) {
    const n = Number.parseInt(query, 10);
    if (n < 1 || n > workspaces.length) {
      return { kind: 'none', message: t('commands.workspaces.indexOutOfRange', { max: workspaces.length }) };
    }
    const workspace = workspaces[n - 1];
    return workspace ? { kind: 'one', workspace } : { kind: 'none', message: t('commands.workspaces.indexMissing') };
  }

  const wanted = normalizeWorkspacePath(query);
  const exactPath = workspaces.filter((w) => normalizeWorkspacePath(w.path) === wanted);
  if (exactPath.length === 1 && exactPath[0]) return { kind: 'one', workspace: exactPath[0] };
  if (exactPath.length > 1) return { kind: 'multi', matched: exactPath };

  const lower = query.toLowerCase();
  const fuzzy = workspaces.filter((w) => (w.title ?? '').toLowerCase().includes(lower));
  if (fuzzy.length === 1 && fuzzy[0]) return { kind: 'one', workspace: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: 'multi', matched: fuzzy };
  return { kind: 'none', message: t('commands.workspaces.notFound', { query }) };
}

// ══════════════════════════ 分发器 ═══════════════════════════

export function createCommandDispatcher(options: CommandDispatcherOptions): CommandDispatcher {
  const { control, paging, logger } = options;
  const pageSize = Number.isFinite(options.listPageSize) && (options.listPageSize ?? 0) >= 1
    ? Math.floor(options.listPageSize as number)
    : defaultPageSize();
  const replyMax = Number.isFinite(options.replyMaxChars) && (options.replyMaxChars ?? 0) > 0
    ? Math.floor(options.replyMaxChars as number)
    : REPLY_MAX_CHARS;
  const statusShowUsage = options.statusShowUsage !== false;
  /** D36：`allow_create_session` 开关（默认开启） */
  const allowCreateSession = options.allowCreateSession !== false;

  const done = (reply: string, exitPaging = false): CommandResult => ({
    handled: true,
    reply: truncateReply(reply, replyMax),
    exitPaging,
  });

  /** 目标相关命令的未选中态门（D27：只提示不报错）；文案与入站层同源（`common.noTarget`） */
  async function requireSession(cmd: CommandContext): Promise<{ sessionId: string } | CommandResult> {
    const target = await control.getTarget(cmd.openid);
    if (!target.sessionId) return done(t('common.noTarget'));
    return { sessionId: target.sessionId };
  }

  async function handleSessions(cmd: CommandContext): Promise<CommandResult> {
    const target = await control.getTarget(cmd.openid);
    if (!target.workspaceId) {
      return done(t('commands.sessions.noScope'));
    }
    // D45/D46：归档、subagent 子会话不进列表，空白会话仅当前受控时可见
    //（也不参与序号/标题寻址与分页编号）
    const sessions = visibleSessions(await control.listSessions(target.workspaceId), target.sessionId);

    if (!cmd.args) {
      const existing = paging.get(cmd.openid);
      const resumePage =
        existing && existing.listKind === 'sessions' && existing.workspaceId === target.workspaceId
          ? existing.page
          : 1;
      const page = paginate(sessions, resumePage, pageSize);
      // 分页状态必须记住 listKind（§5）
      paging.set(cmd.openid, { listKind: 'sessions', workspaceId: target.workspaceId, page: page.page });
      return done(renderSessionList(sessions, page));
    }

    const resolved = resolveSessionArg(sessions, cmd.args);
    if (resolved.kind === 'none') return done(resolved.message);
    if (resolved.kind === 'multi') {
      return done(
        `${t('commands.sessions.multi')}\n${renderSessionCandidates(sessions, resolved.matched)}`,
      );
    }

    const takeover = await control.setTarget(cmd.openid, resolved.session.sessionId);
    const title = resolved.session.title?.trim() || shortSessionId(resolved.session.sessionId);
    if (!takeover.ok) {
      return done(t('commands.sessions.switchFailed', { code: takeover.code, reason: takeover.reason }));
    }
    return done(t('commands.sessions.switched', { title, id: resolved.session.sessionId }), true);
  }

  async function handleWorkspaces(cmd: CommandContext): Promise<CommandResult> {
    const target = await control.getTarget(cmd.openid);
    const workspaces = await control.listWorkspaces();

    if (!cmd.args) {
      const existing = paging.get(cmd.openid);
      const archivedIds = new Set(await control.listArchivedSessionIds());
      const page = paginate(workspaces, existing && existing.listKind === 'workspaces' ? existing.page : 1, pageSize);
      paging.set(cmd.openid, {
        listKind: 'workspaces',
        workspaceId: target.workspaceId ?? '',
        page: page.page,
      });
      return done(renderWorkspaceList(workspaces, page, archivedIds));
    }

    const resolved = resolveWorkspaceArg(workspaces, cmd.args);
    if (resolved.kind === 'none') return done(resolved.message);
    if (resolved.kind === 'multi') {
      return done(
        `${t('commands.workspaces.multi')}\n${renderWorkspaceCandidates(workspaces, resolved.matched)}`,
      );
    }

    await control.setWorkspace(cmd.openid, resolved.workspace.id);
    return done(
      t('commands.workspaces.switched', {
        label: formatWorkspaceLabel(resolved.workspace, resolved.workspace.id),
      }),
      true,
    );
  }

  async function handleNew(cmd: CommandContext): Promise<CommandResult> {
    // D36：`allow_create_session=false` 时拒绝新建（此前该配置项未真正生效）
    if (!allowCreateSession) {
      return done(t('commands.new.disabled'));
    }
    // 语义（D36）：永远在**当前选中的工作区**新建；未选中任何工作区才回退默认工作区
    // （落点在 control.createSession 内部解析：作用域优先 → 默认工作区）
    const pathArg = cmd.args.trim() || undefined;
    const result = await control.createSession(cmd.openid, pathArg);
    if (!result.ok) {
      const stage: Record<string, string> = {
        'exists-as-file': t('commands.new.stageExistsAsFile'),
        'mkdir-failed': t('commands.new.stageMkdirFailed'),
        'register-failed': t('commands.new.stageRegisterFailed'),
        'create-failed': t('commands.new.stageCreateFailed'),
      };
      return done(t('commands.new.failed', { stage: stage[result.code] ?? result.code, reason: result.reason }));
    }
    const notes: string[] = [];
    if (result.createdWorkspace) notes.push(t('commands.new.noteWorkspace'));
    if (result.createdDir) notes.push(t('commands.new.noteDir'));
    // 用户决策：回执显示「工作区标题 (路径)」而非裸 id——`CreateSessionResult` 只回传 id，
    // 故此处按 `inbound/pipeline.ts` 的既有做法补一次 getWorkspace 解析；解析不到才回退 id。
    const workspace = await control.getWorkspace(result.workspaceId);
    return done(
      t('commands.new.done', {
        sessionId: result.sessionId,
        workspace: formatWorkspaceLabel(workspace, result.workspaceId),
        notes: notes.length ? t('commands.new.notes', { list: notes.join('；') }) : '',
      }),
    );
  }

  async function handleStop(cmd: CommandContext): Promise<CommandResult> {
    const gate = await requireSession(cmd);
    if ('handled' in gate) return gate;
    const result = await control.cancel(cmd.openid);
    return result.ok
      ? done(t('commands.stop.done'))
      : done(t('commands.stop.failed', { reason: result.reason ?? t('inbound.unknownReason') }));
  }

  function renderUsage(status: SessionStatus): string {
    const fmt = (v: number) => (v > 0 ? `~${formatTokens(v)}` : '0');
    const used = fmt(status.contextTokens ?? 0);
    const window = status.contextWindow;
    if (typeof window === 'number' && window > 0) {
      const percent = Math.min(100, Math.round(((status.contextTokens ?? 0) / window) * 100));
      return t('commands.status.usageRatio', { used, window: formatTokens(window), percent });
    }
    return used;
  }

  async function handleStatus(cmd: CommandContext): Promise<CommandResult> {
    const target = await control.getTarget(cmd.openid);
    const status = await control.status(cmd.openid);
    if (!status || !target.sessionId) {
      // 用户决策：作用域同样显示「标题 (路径)」而非裸 id
      const scope = target.workspaceId
        ? `\n${t('commands.status.scope', {
            scope: formatWorkspaceLabel(await control.getWorkspace(target.workspaceId), target.workspaceId),
          })}`
        : '';
      return done(`${t('commands.status.title')}\n${t('commands.status.none')}${scope}`);
    }
    const title = status.title?.trim() || shortSessionId(status.sessionId);
    const lines = [
      t('commands.status.title'),
      t('commands.status.target', { title, id: shortSessionId(status.sessionId) }),
      t('commands.status.workspace', { title: status.workspaceTitle, path: status.workspacePath }),
      t('commands.status.model', { value: status.model || t('commands.status.unknown') }),
      t('commands.status.effort', { value: status.reasoningEffort || t('commands.status.unset') }),
      t('commands.status.permission', { value: permissionLabel(status.permissionPreset) }),
      t('commands.status.running', {
        value: status.busy ? t('commands.status.busy') : t('commands.status.idle'),
      }),
    ];
    if (statusShowUsage) lines.push(t('commands.status.usage', { value: renderUsage(status) }));
    return done(lines.join('\n'));
  }

  /** `/压缩` 的结果文案（纯文本、无 emoji；D34） */
  function renderCompactOutcome(outcome: CompactOutcome): string {
    if (!outcome.ok) return t('commands.compact.failed', { reason: outcome.reason });
    if (!outcome.compacted) return t('commands.compact.noop');
    return t('commands.compact.done', {
      items: outcome.shadowedItems,
      tokens: formatTokens(outcome.shadowedTokens),
    });
  }

  /**
   * `/压缩`——直调 DSH 官方 `ctx.compaction.compactNow`。
   *
   * 流程说明：① 先回「正在压缩…」，完成后由 `followUp` 追加结果；
   * ② 保持不可中断（与官方对齐，不被 `/停止` abort）。
   */
  async function handleCompact(cmd: CommandContext): Promise<CommandResult> {
    const gate = await requireSession(cmd);
    if ('handled' in gate) return gate;

    // 对齐官方 `/compact` 的 `Usage: /compact (no arguments)`
    if (cmd.args.trim() !== '') return done(t('commands.compact.noArgs'));

    // 立即发起（不 await），先回执再追加结果
    const run = control.compact(cmd.openid);
    return {
      ...done(t('commands.compact.running')),
      followUp: async () => truncateReply(renderCompactOutcome(await run), replyMax),
    };
  }

  async function handleModel(cmd: CommandContext): Promise<CommandResult> {
    const gate = await requireSession(cmd);
    if ('handled' in gate) return gate;
    if (!options.models) return done(t('commands.model.unavailable'));
    const models = options.models;
    const status = await control.status(cmd.openid);
    const current = splitModelField(status?.model);
    const arg = cmd.args.trim();

    if (!arg) {
      const list = await models.list();
      const lines = [
        t('commands.model.current', {
          value: `${current.provider ? `${current.provider} / ` : ''}${current.model || t('commands.model.unknown')}`,
        }),
        t('commands.model.listHeader'),
        ...(list.length
          ? list.map((m) =>
              m.name && m.name !== m.model
                ? t('commands.model.listRowWithName', { provider: m.provider, model: m.model, name: m.name })
                : t('commands.model.listRow', { provider: m.provider, model: m.model }),
            )
          : [t('commands.model.listEmpty')]),
        '',
        t('commands.model.switchHint'),
      ];
      return done(lines.join('\n'));
    }

    let provider: string | undefined;
    let model: string | undefined;
    if (arg.includes('/')) {
      const [head, ...rest] = arg.split('/');
      provider = head?.trim() || undefined;
      model = rest.join('/').trim() || undefined;
    }

    if (!provider || !model) {
      const list = await models.list();
      const lower = arg.toLowerCase();
      const exact = list.filter((m) => m.model.toLowerCase() === lower || (m.name ?? '').toLowerCase() === lower);
      const fuzzy = list.filter((m) => m.model.toLowerCase().includes(lower));
      if (exact.length === 1 || (exact.length === 0 && fuzzy.length === 1)) {
        const hit = exact[0] ?? fuzzy[0];
        if (hit) {
          provider = hit.provider;
          model = hit.model;
        } else {
          return done(t('commands.model.notFound', { arg }));
        }
      } else if (exact.length > 1 || fuzzy.length > 1) {
        const candidates = (exact.length > 1 ? exact : fuzzy)
          .map((m) => t('commands.model.candidate', { provider: m.provider, model: m.model }))
          .join('\n');
        return done(`${t('commands.model.multi')}\n${candidates}`);
      } else {
        // 未知模型名：如实回执、不猜测供应商（避免静默切到意料之外的模型）
        return done(t('commands.model.notFound', { arg }));
      }
    }

    await models.select(gate.sessionId, { provider, model });
    return done(t('commands.model.switched', { provider, model }));
  }

  async function handleThinking(cmd: CommandContext): Promise<CommandResult> {
    const gate = await requireSession(cmd);
    if ('handled' in gate) return gate;
    if (!options.models) return done(t('commands.thinking.unavailable'));
    const models = options.models;
    const status = await control.status(cmd.openid);
    const { provider, model } = splitModelField(status?.model);
    if (!provider || !model) {
      return done(t('commands.thinking.modelUnknown'));
    }
    const info = await models.reasoning(provider, model);
    if (!info.supported) {
      return done(t('commands.thinking.unsupported', { provider, model }));
    }
    const current = status?.reasoningEffort;
    const arg = cmd.args.trim();

    if (!arg) {
      const lines = [
        t('commands.thinking.currentModel', { value: `${provider} / ${model}` }),
        t('commands.thinking.currentEffort', {
          value: current || info.defaultEffort || t('commands.thinking.defaultLabel'),
        }),
        t('commands.thinking.listHeader'),
        ...info.efforts.map((e) => {
          const row = t('commands.thinking.listRow', { id: e.id, name: e.name });
          const badge =
            (e.id === info.defaultEffort ? t('commands.thinking.badgeDefault') : '') +
            (e.id === current ? t('commands.thinking.badgeCurrent') : '');
          return `${row}${badge}`;
        }),
        '',
        t('commands.thinking.switchHint'),
      ];
      return done(lines.join('\n'));
    }

    const wanted = (ZH_EFFORT[arg] ?? arg).toLowerCase();
    if (wanted === 'default' || wanted === 'reset') {
      await models.select(gate.sessionId, { provider, model });
      return done(t('commands.thinking.reset', { provider, model }));
    }
    const hit = info.efforts.find((e) => e.id.toLowerCase() === wanted || e.name.toLowerCase() === wanted);
    if (!hit) {
      return done(
        t('commands.thinking.invalid', {
          arg,
          list: info.efforts.map((e) => `${e.id} (${e.name})`).join('、'),
        }),
      );
    }
    await models.select(gate.sessionId, { provider, model, reasoningEffort: hit.id });
    return done(t('commands.thinking.switched', { id: hit.id, name: hit.name }));
  }

  async function handlePermission(cmd: CommandContext): Promise<CommandResult> {
    const gate = await requireSession(cmd);
    if ('handled' in gate) return gate;
    if (!options.permissions) return done(t('commands.permission.unavailable'));
    const permissions = options.permissions;
    const status = await control.status(cmd.openid);
    const presets = await permissions.list();
    const current = status?.permissionPreset;
    const arg = cmd.args.trim();

    if (!arg) {
      return done(
        [
          t('commands.permission.current', { value: permissionLabel(current) }),
          t('commands.permission.listHeader'),
          ...presets.map((p) => t('commands.permission.listRow', { value: permissionLabel(p) })),
          '',
          t('commands.permission.switchHint'),
        ].join('\n'),
      );
    }

    const aliases = ZH_PERMISSION[arg];
    const preset = aliases ? aliases.find((p) => presets.includes(p)) ?? aliases[0] : arg;
    if (!preset || !presets.includes(preset)) {
      return done(
        t('commands.permission.invalid', {
          arg,
          list: presets.map((p) => permissionLabel(p)).join('、'),
        }),
      );
    }
    await permissions.set(gate.sessionId, preset);
    return done(t('commands.permission.switched', { value: permissionLabel(preset) }));
  }

  /** 翻页边界处理：越界回执（保持分页状态），否则给出目标页 */
  function stepPage<T>(
    items: readonly T[],
    currentPage: number,
    step: number,
  ): { ok: true; page: Page<T> } | { ok: false; reply: string } {
    const current = paginate(items, currentPage, pageSize);
    const wanted = current.page + step;
    if (wanted < 1) {
      return {
        ok: false,
        reply: t('commands.paging.first', { page: current.page, totalPages: current.totalPages }),
      };
    }
    if (wanted > current.totalPages) {
      return {
        ok: false,
        reply: t('commands.paging.last', { page: current.page, totalPages: current.totalPages }),
      };
    }
    return { ok: true, page: paginate(items, wanted, pageSize) };
  }

  async function handlePagingTurn(cmd: CommandContext): Promise<CommandResult> {
    const state = paging.get(cmd.openid);
    if (!state) {
      return done(t('commands.paging.noList'));
    }
    const step = cmd.name === PAGING_COMMANDS[0] ? 1 : -1;

    if (state.listKind === 'sessions') {
      // D46：翻页路径必须复用同一套可见性过滤与排序（否则首屏与翻页口径不一致）
      const target = await control.getTarget(cmd.openid);
      const sessions = visibleSessions(await control.listSessions(state.workspaceId), target.sessionId);
      const stepped = stepPage(sessions, state.page, step);
      if (!stepped.ok) return done(stepped.reply);
      paging.set(cmd.openid, { ...state, page: stepped.page.page });
      return done(renderSessionList(sessions, stepped.page));
    }

    const workspaces = await control.listWorkspaces();
    const stepped = stepPage(workspaces, state.page, step);
    if (!stepped.ok) return done(stepped.reply);
    paging.set(cmd.openid, { ...state, page: stepped.page.page });
    // D45：翻页路径同样按「不计归档」的会话数渲染
    return done(renderWorkspaceList(workspaces, stepped.page, new Set(await control.listArchivedSessionIds())));
  }

  async function route(cmd: CommandContext): Promise<CommandResult> {
    switch (cmd.name) {
      case '帮助':
        return done(renderHelp());
      case '会话':
        return handleSessions(cmd);
      case '切换':
        return handleWorkspaces(cmd);
      case '新建':
        return handleNew(cmd);
      case '停止':
        return handleStop(cmd);
      case '状态':
        return handleStatus(cmd);
      case '压缩':
        return handleCompact(cmd);
      case '模型':
        return handleModel(cmd);
      case '思考':
        return handleThinking(cmd);
      case '权限':
        return handlePermission(cmd);
      case PAGING_COMMANDS[0]:
      case PAGING_COMMANDS[1]:
        return handlePagingTurn(cmd);
      default:
        // 管线已用 isKnown 拦截未知命令；直接调用时按契约返回未处理，继续走后续状态机层
        return { handled: false };
    }
  }

  return {
    names(): string[] {
      return [...COMMAND_NAMES];
    },
    isKnown(name: string): boolean {
      return isKnownCommand(name);
    },
    async handle(cmd: CommandContext): Promise<CommandResult> {
      logger.debug(`[commands] dispatch /${cmd.name}`, { openid: cmd.openid, args: cmd.args });
      const pagingActive = paging.get(cmd.openid) !== undefined;
      const result = await route(cmd);
      // 建立/翻动分页的命令自身管理分页状态（无参列表命令会重设分页，不得被误清）
      const managesPaging =
        isPagingCommand(cmd.name) || ((cmd.name === '会话' || cmd.name === '切换') && cmd.args.trim() === '');
      // D22：分页活跃时收到无关命令 → 退出分页后正常处理（管线负责清理，这里给出契约信号）
      if (pagingActive && !managesPaging) {
        return { ...result, exitPaging: true };
      }
      return result;
    },
  };
}