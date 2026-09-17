/**
 * dsh-qqbot-bridge: **冻结的内部契约**
 *
 * 本文件是 P2 并行开发的**唯一接口基准**（AGENTS.md §5.2「类型与契约先行」）。
 * 各模块按此实现，**不得擅自改动本文件的既有签名**；确需变更时由 Lead 统一修改并通知全员。
 *
 * 分层：
 *   types/qq.ts   官方协议类型
 *   types/index.ts（本文件）跨模块内部契约
 */

export * from './qq.js';

import type {
  QqC2CMessageEvent,
  QqCredential,
  QqFileUploadResponse,
  QqReadyInfo,
  QqSendMessagePayload,
  QqStreamMessagePayload,
  QqStreamMessageResponse,
  QqSendMessageResponse,
  QqMessageAttachment,
} from './qq.js';

// ═══════════════════════════ 配置 ═══════════════════════════

export interface PluginConfig {
  /** 机器人 AppID（也可由既 credential 解析链提供） */
  app_id?: string;
  /** AppSecret（优先走 credentials refs，避免落 settings） */
  app_secret?: string;
  /** 默认工作区路径（`/切换` 未指定、且无持久化作用域时使用） */
  default_workspace?: string;
  /** 是否启用流式（D9：整回合正文走流式） */
  stream_enabled?: boolean;
  /** 流式节流间隔 ms */
  stream_throttle_ms?: number;
  /** 是否允许 QQ 侧新建会话（D8：允许；归档/删除不做） */
  allow_create_session?: boolean;
  /** 入站附件落盘目录（相对 DSH_HOME） */
  media_dir?: string;
  /** 单文件落盘上限（字节） */
  media_max_bytes?: number;
  /** 命令回执最大字符数 */
  reply_max_chars?: number;
  /** 列表分页大小 */
  list_page_size?: number;
  /** 状态命令是否显示上下文用量（D32：是） */
  status_show_usage?: boolean;
}

// ═══════════════════════════ 协议客户端（qq/client.ts 实现） ═══════════════════════════

/**
 * 统一的 REST 返回。**不抛错**——探针与本项目都需要把失败码（如 `40054005` / `40007` / `850012`）
 * 作为**数据**处理，而不是异常（P1 探针已证明这条设计正确）。
 */
export interface QqApiResult {
  ok: boolean;
  status: number;
  /** 业务错误码（HTTP 200 的 body 里也可能带） */
  code?: string | number;
  message?: string;
  body: unknown;
}

export type QqMessageHandler = (event: QqC2CMessageEvent) => void | Promise<void>;
export type QqReadyHandler = (info: QqReadyInfo) => void | Promise<void>;

/**
 * QQ 官方 Bot 客户端契约。
 * 实现位于 `src/qq/client.ts`（Y1 复用 + E7 分片上传）。
 */
export interface QqClientLike {
  start(): Promise<void>;
  stop(): void;
  getAccessToken(): Promise<string>;
  authHeader(): Promise<Record<string, string>>;
  onC2CMessage(handler: QqMessageHandler): void;
  onReady(handler: QqReadyHandler): void;
  sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult>;
  sendStreamMessage(openid: string, payload: QqStreamMessagePayload): Promise<QqApiResult>;
  /** 通用 POST（相对 `/v2`），用于 `upload_prepare` / `upload_part_finish` / `files` */
  apiPost(pathname: string, payload: unknown): Promise<QqApiResult>;
  /** 分片 PUT 到预签名 URL（裸 PUT，无需额外 header——E7-7 实测） */
  putPresigned(url: string, body: Uint8Array): Promise<{ ok: boolean; status: number }>;
  /** 下载入站附件（裸 GET 即可——E8-1 实测） */
  fetchAttachment(url: string): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }>;
}

// ═══════════════════════════ 出站槽位与串行 ═══════════════════════════

/** 一条入站消息对应的出站锚点 */
export interface OutboundTarget {
  openid: string;
  /** 被动回复消息 ID */
  msgId?: string;
}

/**
 * `msg_seq` 槽位分配器（**风险 R9**，E2 实测：`(msg_id, msg_seq)` 唯一，重复发送报 `40054005`）。
 * 一条入站消息的 `msg_seq` 是一个有限命名空间：流式占一格，其余消息取未占用格。
 */
export interface SlotAllocator {
  /** 取下一个未占用的 `msg_seq`（从 1 开始） */
  alloc(msgId: string): number;
  /** 登记某格已被占用（流式开流时用） */
  occupy(msgId: string, seq: number): void;
  /** 查询已占用集合 */
  used(msgId: string): ReadonlySet<number>;
  /** 回收某 msg_id 的全部槽位（被动窗口结束/会话销毁） */
  release(msgId: string): void;
}

/** per-peer 串行发送队列接口 */
export interface SerialSender {
  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T>;
  clear(): void;
}

// ══════════════════════════ Markdown 适配（qq/markdown.ts 实现） ═══════════════════════════

/**
 * QQ markdown 适配层。
 * P1 结论大幅简化其职责（E5/E6/E5B 实测）：
 *   - **不需要**降级表格 / 代码块 / 行内码 / 四级标题（官方全支持，文档未列出而已）
 *   - **不需要**剥离链接（E6：单聊无 URL 白名单限制）与图片语法（E5B：图片可用）
 *   → 只剩两件事：`#` 后补空格（含字符集净化）、按字节切分。
 *
 * **D50（2026-09-16）**：本层**不再做任何长度截断**——真机缺陷证明"按整段累积截断"会静默丢内容，
 * 而【实测 E3】平台约束是**单次请求 ≈20 KiB 字节**、与累积总量无关。长度设防改由调用方按
 * **UTF-8 字节**切分承担（流式按片、非流式切条）。
 */
export interface MarkdownAdapter {
  /** 最小必要修补（Y3 的 `formatQQMarkdown`）：`#标题` → `# 标题`；并做字符集净化（**不截断**） */
  toQqMarkdown(text: string): string;
  /** 按字符（码点）上限切分为多段 */
  split(text: string, limitChars: number): string[];
  /**
   * 按 **UTF-8 字节**上限切分为多段（D50：单次请求维度的长度设防）。
   * 保证 `join('') === text`（绝不丢字符）、不切坏代理对、优先在换行边界断开。
   */
  splitByBytes(text: string, limitBytes: number): string[];
}

// ═══════════════════════════ 流式（qq/stream.ts 实现） ═══════════════════════════

/** 一条正在进行的出站流 */
export interface StreamHandle {
  /** 追加增量文本（来自 DSH `text-delta`） */
  push(delta: string): Promise<void>;
  /** 结束本段流（发 `input_state=10`）；失败时内部回退为普通消息 */
  finish(finalText?: string): Promise<void>;
  /** 当前已下发的全文（用于回退） */
  readonly sentText: string;
}

/**
 * 流式管理器契约（`qq/stream.ts` 实现）。
 * 关键实测约束：
 *   - **QQ 侧分片序号 `index` 必须自维护全局计数**：DSH 的 `chunk.index` 是 per-attempt（E11-6），
 *     透传会导致每个 step 边界序号回退（风险 R8）。
 *   - 整段流式**恒定使用同一个 `msg_seq`**（E2-2：占用一个槽位），分片靠 `index` 递增。
 *   - 节点文本可能被 markdown 适配层截断 → 必须用 `replace` 且**保证只追加**（否则 `40007`）。
 */
export interface StreamManager {
  /** 为一条出站目标开路；返回 null 表示流式不可用，调用方应走普通消息 */
  open(target: OutboundTarget): StreamHandle | null;
  /** 是否有活跃流 */
  isStreaming(openid: string): boolean;
  /**
   * 把一条普通消息排进 per-peer 串行队列（内部会先结束活跃流，保证时序）。
   *
   * ️ **截断防护（真机缺陷回归，2026-09-15）**：正文增量由 `turn-router` 的 per-openid
   * 异步链处理（含网络发送），**天然滞后于事件发射**；若收流前不等它跑完，会把正在进行的
   * 正文截断（真机表现为只剩一个「沙」字）。故实现必须先在“收流”前 await `settleStream`。
   *
   * `options.awaitStreamSettle === false` **仅供 turn-router 自身的降级发送路径**使用
   * （那条路径正在该链内部执行，再等自己会死锁）；其余调用方必须保持默认。
   */
  sendSerialized(
    target: OutboundTarget,
    payload: QqSendMessagePayload,
    options?: { awaitStreamSettle?: boolean },
  ): Promise<QqApiResult>;
  /** 当前活跃流的 msg_seq（供审批/提问取后续槽位） */
  activeSeq(openid: string): number | undefined;
}

// ═══════════════════════════ 出站富媒体与入站附件 ═══════════════════════════

/**
 * 出站富媒体发送（`qq/media-out.ts` 实现，Y5 + E7）。
 * 实现必须遵守 E7 的**三条硬语义**：`parts[].index` 1-based、累积偏移、每片自己的 `block_size`。
 */
export interface MediaSender {
  /** 本地文件/Buffer → `file_info`（走四步分片上传），带 TTL 缓存 */
  upload(input: { path?: string; bytes?: Uint8Array; filename: string; fileType?: number }): Promise<QqFileUploadResponse>;
  /** 发送 `msg_type=7` 富媒体消息 */
  send(target: OutboundTarget, input: { path?: string; bytes?: Uint8Array; filename: string; fileType?: number }): Promise<QqApiResult>;
}

/** 落盘后的入站附件 */
export interface InboundMedia {
  filePath: string;
  fileName: string;
  bytes: number;
  mimeType: string | null;
  /** 图片可注入模型的 data URL payload */
  imageDataUrl?: string;
  /** 语音的 ASR 转写文本（E8-5 实测有值） */
  asrText?: string;
}

/**
 * 入站附件处理（`qq/media-in.ts` 实现，Y4 + E8）。
 * 实测要点：裸 GET 可下载；文件名净化后落盘；语音优先落 `voice_wav_url` 的 WAV。
 */
export interface MediaReceiver {
  fetchAll(event: QqC2CMessageEvent, sessionId: string): Promise<InboundMedia[]>;
  /** 生成注入模型上下文的说明文本 */
  describe(media: InboundMedia[]): string;
}

export type { QqMessageAttachment };

// ═══════════════════════════ DSH 会话控制（src/dsh/* 实现） ═══════════════════════════

export interface WorkspaceRef {
  id: string;
  title: string;
  path: string;
  sessionIds: readonly string[];
}

export interface SessionRef {
  sessionId: string;
  title?: string;
  workspaceId: string;
  workspaceTitle: string;
  /**
   * 最后活跃时间（ms，D33/D46）；对齐官方 `SessionSummary.updatedAt`：
   * `Math.max(header.createdAt, sessionListMetadata.lastPromptAt ?? 0)`。
   * 服务缺席/降级时缺省——命令层**整段省略时间，绝不印「未知」**。
   */
  lastActive?: number;
  /**
   * 官方 `blank`（无 `turn/start`，D46）。命令层据此对齐 WebUI：
   * 空白会话仅在「是当前受控会话」时可见（`!blank || id === current`）。
   */
  blank?: boolean;
  /** 官方 `origin`（D46）；`subagent` 在 WebUI 隐藏 */
  origin?: 'subagent';
  archived: boolean;
}

/** 控制目标：`sessionId === null` 表示**未选中态**（D19/D27） */
export interface ControlTarget {
  workspaceId: string | null;
  sessionId: string | null;
}

export type TakeoverFailCode = 'not-found' | 'archived' | 'locked' | 'invalid' | 'error';

export type TakeoverResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: TakeoverFailCode; reason: string };

export type CreateSessionResult =
  | { ok: true; sessionId: string; workspaceId: string; createdWorkspace: boolean; createdDir: boolean }
  | { ok: false; code: 'exists-as-file' | 'mkdir-failed' | 'register-failed' | 'create-failed'; reason: string };

/**
 * `/压缩` 的失败分类（D44）：`busy|cancelled|changed|summary|commit|persistence` 与官方
 * `ManualCompactionErrorCode` **逐字一致**；其余三个是本项目接线层自己的前置失败。
 */
export type CompactFailCode =
  | 'no-target'
  | 'unavailable'
  | 'agent'
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'
  | 'error';

/** `/压缩` 的结果；`ok:true && compacted:false` = 官方返回 `null`（没有安全可压缩的范围），**不是失败** */
export type CompactOutcome =
  | { ok: true; compacted: false }
  | { ok: true; compacted: true; shadowedItems: number; shadowedTokens: number }
  | { ok: false; code: CompactFailCode; reason: string };

export interface SessionStatus {
  sessionId: string;
  title?: string;
  workspaceTitle: string;
  workspacePath: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  /** 基于 `turnBoundary.openTurnStartSeq !== null`（设计文档 §7.3；E12-A 实测可靠） */
  busy: boolean;
  contextTokens?: number;
  contextWindow?: number;
}

/**
 * 会话控制服务契约（`src/dsh/control.ts` 实现）。
 *
 * 关键实测约束（D28/D29/D30，E12-A/E12-B）：
 *   - **优先 `ctx.agents.get(sessionId)` 复用 live agent**（E12-A：同进程返回同一实例，**不触锁**）
 *   - resume 遇锁冲突 → **立即如实回执**，**绝不降级 `agents.create`**（E12-B：跨进程 13ms 即
 *     `SessionAlreadyOwnedError`，内部盲重试无意义）；错误原文 `is already owned by an active write handle`
 *   - steer vs followup 由 `busy` 决定（D7）
 */
export interface ControlService {
  listWorkspaces(): Promise<WorkspaceRef[]>;
  listSessions(workspaceId: string): Promise<SessionRef[]>;
  /**
   * 注册表中**被归档**的会话 id 集合（registry-global，`dsh-workspace` 的 `archivedSessionIds`）。
   *
   * 命令层据此对齐 WebUI 默认口径（D45）：`/会话` 隐藏归档、`/切换` 的「会话 N」不计归档。
   * 注意 `listSessions` **不过滤**（忠实投影 + `archived` 标记）——D29 的目标校验与将来
   * 「标注 / opt-in 开关」方案都依赖它，隐藏归档只是展示策略。
   */
  listArchivedSessionIds(): Promise<string[]>;
  getWorkspace(workspaceIdOrPath: string): Promise<WorkspaceRef | undefined>;
  /** 解析工作区（序号/path/标题）——由命令层传已解析的 id 或 path */
  resolveWorkspace(arg: string): Promise<WorkspaceRef | undefined>;

  getTarget(openid: string): Promise<ControlTarget>;
  /**
   * 反查：**哪个 openid 当前把该会话作为控制目标**（无则 `undefined`）。
   *
   * 这是交互层判定「该会话是否正被远程受控」的唯一依据。**禁止**用「曾经由 QQ 驱动过」
   * 的历史映射代替：用户 `/切换` 或改目标后，旧会话不应再抢 QQ 侧的审批/提问卡片
   * （架构设计：远程控制语境下没有「QQ 会话」概念，只有「当前受控会话」概念）。
   */
  findControlOwner(sessionId: string): string | undefined;
  /**
   * D49：该 `messageId` 是否由**本桥接**投喂（回合归属判定的基石）。
   *
   * 官方没有「回合发起方 / prompt 来源」字段（`ApprovalRequestEvent` 与
   * `AskUserQuestionRequestEvent` 载荷都不带来源；`lastPromptAt` 的谓词
   * `source.kind === 'user'` 对 WebUI 与 QQ **完全同质**），因此只能桥接侧自记：
   * 投喂时记下 `Message.id`（官方明写跨表示边界稳定，`dsh-llm/lib/types/message.d.ts:119-122`），
   * 再用 `'user/message'` 事件的 data（就是该 `UserMessage`，`dsh-session/lib/types/types.d.ts:281`）对拍。
   */
  isOwnMessage(messageId: string): boolean;
  /** 切换工作区作用域并**清空控制目标**（D19） */
  setWorkspace(openid: string, workspaceId: string): Promise<void>;
  /** 设定控制目标（接管）；内部做存在性/归档校验与 live agent 复用 */
  setTarget(openid: string, sessionId: string): Promise<TakeoverResult>;
  /** 清空控制目标（目标失效时用，D29） */
  clearTarget(openid: string, reason: string): Promise<void>;

  /** 新建会话（D24/D25：`session-<uuid>`、DSH 自动命名、立即成为控制目标） */
  createSession(openid: string, pathArg?: string): Promise<CreateSessionResult>;

  /** 发送用户消息：busy → steer，空闲 → followup */
  send(openid: string, text: string): Promise<{ ok: boolean; mode: 'steer' | 'followup' | 'none'; reason?: string }>;
  cancel(openid: string): Promise<{ ok: boolean; reason?: string }>;
  status(openid: string): Promise<SessionStatus | undefined>;

  /**
   * `/压缩`：直调官方 `ctx.compaction.compactNow(agent, signal)`。
   * 与官方 `/compact` 语义对齐：保持不可中断。
   */
  compact(openid: string): Promise<CompactOutcome>;

  /** D29：下一条消息前校验目标是否仍有效；失效则清空并返回告知文本 */
  validateTarget(openid: string): Promise<{ valid: boolean; notice?: string }>;
}

// ═══════════════════════════ 命令（src/commands/* 实现） ═══════════════════════════

export interface CommandContext {
  openid: string;
  raw: string;
  /** 命令名（不含 `/`，已小写） */
  name: string;
  /** 命令名之后的原始输入 */
  args: string;
  target: OutboundTarget;
}

export interface CommandResult {
  /** 是否已处理（未处理则继续走后续状态机层） */
  handled: boolean;
  /** 回执文本（纯文本 `msg_type=0`，D34）；为空则不发 */
  reply?: string;
  /** 是否需要退出分页状态 */
  exitPaging?: boolean;
  /**
   * **追加回执**（D44）：先发 `reply`，再等它产出第二条回执并发送。
   *
   * 用于长耗时命令——`/压缩` 要调 LLM 做摘要（可能十几秒到一分钟），先回「正在压缩…」，
   * 完成后由本回调给出结果。返回 `undefined` 表示不发第二条。抛错时由管线如实回执并记 error。
   */
  followUp?: () => Promise<string | undefined>;
}

export interface CommandDispatcher {
  /** 命令名清单（`/帮助` 用） */
  names(): string[];
  /** 是否为已知命令 */
  isKnown(name: string): boolean;
  handle(cmd: CommandContext): Promise<CommandResult>;
}

/** 分页状态（D22：非全局命令、无超时、跨页连续编号） */
export interface PagingState {
  listKind: 'sessions' | 'workspaces';
  workspaceId: string;
  page: number;
}

export interface PagingStore {
  get(openid: string): PagingState | undefined;
  set(openid: string, state: PagingState): void;
  /** 退出分页（收到非斜杠消息或无关命令时） */
  clear(openid: string): void;
}

// ═══════════════════════════ 入站管线（src/inbound/pipeline.ts 实现） ═══════════════════════════

/** 入站状态机的 pending 交互（审批 / 提问） */
export interface PendingInteraction {
  hasPending(openid: string): boolean;
  /** 返回 true 表示本消息已被该交互消费 */
  handle(openid: string, text: string): boolean;
}

/**
 * 入站依赖：全部由 `src/index.ts` 注入（便于契约测试替换）。
 * 状态机优先级（设计文档 §4）：审批 → 提问 → 分页 → 命令 → 未选中检查 → agent
 */
export interface InboundDeps {
  approval: PendingInteraction;
  question: PendingInteraction;
  paging: PagingStore;
  commands: CommandDispatcher;
  control: ControlService;
  streams: StreamManager;
  media: MediaReceiver;
  markdown: MarkdownAdapter;
  /**
   * D36：`allow_create_session` 开关（默认 true）。
   * 关闭时未选中态的普通消息退回 D19/D27 的「只提示不转发」，**不自动新建会话**。
   */
  allowCreateSession?: boolean;
  /**
   * D36 接线钩子：自动新建会话成功后**立即**回调 `(sessionId, openid)`。
   *
   * 为什么必须有：`turn-router` 靠 `openidOf(sessionId)` 决定往哪个 openid 发回答
   * （`src/outbound/turn-router.ts:110-111`），而该映射原先只在**入站前**读取一次
   * （`src/index.ts` 的 inbound handler）。自动新建的会话在那一刻还不存在，
   * 若不在此处补写映射，**这条消息的回答会被静默丢弃**（真机探针 FIRST-MESSAGE 实测抓到）。
   */
  onSessionSelected?: (sessionId: string, openid: string) => void;
  /** 发一条普通消息（经串行队列） */
  reply(target: OutboundTarget, text: string): Promise<void>;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void };
}

/** 入站消息处理入口 */
export interface InboundPipeline {
  handle(event: QqC2CMessageEvent): Promise<void>;
}

// ═══════════════════════════ turn 锚点（src/dsh/anchors.ts 实现） ═══════════════════════════

/**
 * turn 级回复锚点绑定。
 * 作用：把"Dsh turn"与"是哪条 QQ 入站消息触发的"绑定，保证回复串到正确的引用锚点。
 */
export interface TurnAnchors {
  trackPending(messageId: string, openid: string, target: OutboundTarget): void;
  /** turn/start 时把 pending 锚定到该 turn */
  onTurnStart(openid: string, turn: number): void;
  /** 取某 peer 当前活跃 turn 的锚点 */
  active(openid: string): OutboundTarget | undefined;
  onTurnEnd(openid: string, turn: number): void;
  clear(): void;
}

export type { QqCredential, QqStreamMessageResponse, QqSendMessageResponse, QqFileUploadResponse };