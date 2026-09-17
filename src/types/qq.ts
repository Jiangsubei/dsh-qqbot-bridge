/**
 * QQ 官方 Bot API v2 类型定义
 *
 * 覆盖 QQ 开放平台单聊消息、网关连接事件、打字机流式与富媒体分片上传接口的数据结构。
 */

// ───────────────────────── 鉴权 ─────────────────────────

export interface QqAccessTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface QqCredential {
  appId: string;
  appSecret: string;
}

// ───────────────────────── WebSocket 网关 ─────────────────────────

export interface QqGatewayResponse {
  url: string;
  shards?: number;
}

export enum QqOpCode {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

export interface QqWsPayload<T = unknown> {
  op: QqOpCode;
  d?: T;
  s?: number;
  t?: string;
}

export interface QqReadyData {
  version: number;
  session_id: string;
  user: { id: string; username: string; bot: boolean };
}

export interface QqReadyInfo {
  sessionId: string;
  botId: string;
  botName: string;
}

// ───────────────────────── 入站事件 ─────────────────────────

/**
 * 附件（E8 实测）：
 * - 图片：`content_type=image/png`，`filename` 是**哈希名**（如 `95C5…A03B7A.png`）
 * - 文件：`content_type=file`，`filename` 保留**真实文件名**（如 `首尾帧_动态壁纸.json`）
 * - 语音：`content_type=voice`，`filename` 为哈希名 + `.amr`，且**响应头 content-type 不可信**
 *   （实测报 `audio/mp3` 而文件是 amr）；应以 `voice_wav_url` 为准
 * - 下载：**裸 GET 即可**，无需鉴权头（E8 实测）
 */
export interface QqMessageAttachment {
  url: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  /** `voice` | `image/jpeg` | `image/png` | `image/gif` | `video/mp4` | `file` */
  content_type?: string;
  /** 语音的 SILK/AMR → WAV 地址（E8 实测可用，`audio/x-wav`） */
  voice_wav_url?: string;
  /** 语音的 ASR 转写文本（E8 实测有值，例如「一条测试语音。」） */
  asr_refer_text?: string;
}

/**
 * 单聊消息事件（`C2C_MESSAGE_CREATE`）
 * 官方字段：id / author / content / timestamp / message_type / message_scene / attachments /
 *          ark_data / msg_elements
 */
export interface QqC2CMessageEvent {
  /** 消息 ID，用于被动回复与撤回 */
  id: string;
  author: {
    id?: string;
    user_openid?: string;
    union_openid?: string;
    username?: string;
    bot?: boolean;
  };
  content?: string;
  timestamp?: string;
  /** 0=普通文本 / 3=结构化卡片 / 101=并行消息 / 102=聊天记录 / 103=引用消息 */
  message_type?: number;
  /** 场景上下文，`ext` 为 `key=value` 字符串列表（含 `msg_idx=REFIDX_…`） */
  message_scene?: { source?: string; ext?: string[] };
  attachments?: QqMessageAttachment[];
  ark_data?: unknown;
  msg_elements?: unknown[];
}

// ───────────────────────── 出站消息 ─────────────────────────

/**
 * 发送单聊消息 payload。
 * ⚠️ E4 实测更正：文档称「传了 markdown 后 content 必须为空」，**实际同时下发不报错**（content 被静默忽略）；
 *    但**反向会硬失败**：`msg_type=2` 不带 `markdown` → `40034011 无效 markdown content`。
 *    → 本项目 `msg_type=2` 时**只发 `markdown.content`**（卫生），且**必须**保证 markdown 字段非空。
 */
export interface QqSendMessagePayload {
  msg_type: number;
  /** `msg_type=0` 时的全文 */
  content?: string;
  /** `msg_type=2` 时必填 */
  markdown?: { content: string };
  /** `msg_type=6` 输入中状态 */
  input_notify?: { input_type: 1; input_second: number };
  /** `msg_type=7` 富媒体 */
  media?: { file_info: string };
  /** 被动回复消息 ID（与 event_id 二选一） */
  msg_id?: string;
  event_id?: string;
  /**
   * 回复序号。**同一 `(msg_id, msg_seq)` 重复发送会失败 `40054005`**（E2 实测：
   * 流式占用的那一格不能再被普通消息使用）→ 必须经 per-msg_id 槽位分配器取用。
   */
  msg_seq?: number;
}

/**
 * 流式消息 payload（`POST /v2/users/{openid}/stream_messages`）。
 * E2 实测：`append`（只发增量，默认）与 `replace`（累积全文，**必须以上次已下发内容为前缀**）**都可用**；
 *        客户端表现均为"同一条消息原地增长"，且**首片即时可见**（无需等 `input_state=10`）。
 */
export interface QqStreamMessagePayload {
  input_mode?: 'append' | 'replace';
  /** 1=生成中，10=生成结束 */
  input_state: number;
  /** 分片序号，从 0 递增（**这是 QQ 侧的分片序号，不是 DSH 的 `chunk.index`**） */
  index: number;
  content_type?: 'text' | 'markdown';
  content_raw?: string;
  msg_id?: string;
  event_id?: string;
  /** 首片由服务端返回，后续分片必须携带 */
  stream_msg_id?: string;
  /** 整段流式**恒定**用同一个值（E2 实测：占用一个槽位） */
  msg_seq?: number;
}

/** 流式响应体（E2-4 实测：`remain_msg_len` 恒为 0，**不可用作长度预算依据**） */
export interface QqStreamMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: { ref_idx?: string };
  remain_msg_len?: number;
}

/**
 * 发送响应：`id` 为消息 ID（可用于撤回），`ext_info.ref_idx` 可用于**引用机器人自己的消息**（E10）。
 */
export interface QqSendMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: { ref_idx?: string };
}

// ───────────────────────── 富媒体分片上传（E7 实测语义） ─────────────────────────

/**
 * 预上传响应。
 * ⚠️ **E7 实测更正（文档与线上不一致，共两处）**：
 *   1. 文档称 `parts[].index`「从 0 开始」，**实测返回 1、2（1-based）**；
 *   2. 文档称"分片大小默认 5MB"，**实测 `block_size = 10485760`（10MB）**；
 *      且**每片自带 `block_size`**（末片为余数，如 2097152）。
 *   → 切片必须按 `index` 升序做**累积偏移**，`upload_part_finish` 必须上报**该片自己的** `block_size`。
 */
export interface QqUploadPrepareResponse {
  upload_id: string;
  /** 标准分片大小（字节，字符串） */
  block_size?: string;
  parts?: QqUploadPart[];
  upload_config?: { concurrency?: number; retry_timeout?: number; retry_delay?: number };
}

export interface QqUploadPart {
  /** ️ 实测为 1-based（文档称 0-based） */
  index: number;
  presigned_url: string;
  /** 该片实际大小（字节，字符串）；末片为余数 */
  block_size?: string;
}

/** 合并响应：`file_info` 用于 `msg_type=7`；`ttl` 实测 86400（24h），**可复用多次发送**（E7-5） */
export interface QqFileUploadResponse {
  file_uuid?: string;
  file_info?: string;
  ttl?: number;
}

// ───────────────────────── 错误码（实测遇到的） ─────────────────────────

export const QqErrorCode = {
  /** 富媒体格式不支持（E7 首轮：因上传 0 字节触发） */
  MEDIA_FORMAT_UNSUPPORTED: '850019',
  /** 分片内部代理错误（E7 首轮：因 `part_finish` 上报全局 block_size 触发） */
  PART_FINISH_PROXY_ERROR: '850012',
  /** 请求参数错误（E7 首轮：合并阶段因内容不完整触发） */
  INVALID_REQUEST: '40093006',
  /** 消息被去重：同 `(msg_id, msg_seq)` 重复发送（E2 实测） */
  MESSAGE_DEDUPLICATED: '40054005',
  /** 无效 markdown content：`msg_type=2` 未带 markdown 字段（E4 实测） */
  INVALID_MARKDOWN: '40034011',
  /** 流式前缀不可修改（E2 首轮踩到） */
  STREAM_PREFIX_IMMUTABLE: '40007',
  /** 无好友关系 */
  NO_FRIEND_RELATION: '40054004',
} as const;