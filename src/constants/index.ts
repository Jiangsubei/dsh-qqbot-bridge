/**
 * dsh-qqbot-bridge: 常量表
 *
 * 汇集 QQ 开放平台 API 端点、消息类型、超时与重试时间、默认配额及插件核心元数据。
 */

// ───────────────────────── 端点 ─────────────────────────

/** REST API 基址（官方文档：api.sgroup.qq.com） */
export const QQ_API_BASE = 'https://api.sgroup.qq.com';
/** access_token 获取地址 */
export const QQ_BOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
/** 单聊事件 intent：GROUP_AND_C2C_EVENT */
export const QQ_INTENT_GROUP_AND_C2C_EVENT = 1 << 25;

// ──────────────────────── 消息类型（msg_type） ─────────────────────────

/** 0 = 纯文本（content） */
export const QQ_MSG_TYPE_TEXT = 0;
/** 2 = Markdown（markdown.content）——**注意：必须带 markdown 字段，否则 40034011（E4 实测）** */
export const QQ_MSG_TYPE_MARKDOWN = 2;
/** 6 = 输入中状态（input_notify）——E9 实测：服务端成功且客户端显示「正在输入」 */
export const QQ_MSG_TYPE_INPUT_NOTIFY = 6;
/** 7 = 富媒体（media.file_info） */
export const QQ_MSG_TYPE_MEDIA = 7;

// ───────────────────────── 富媒体 file_type ─────────────────────────

export const QQ_FILE_TYPE_IMAGE = 1;
export const QQ_FILE_TYPE_VIDEO = 2;
export const QQ_FILE_TYPE_AUDIO = 3;
export const QQ_FILE_TYPE_FILE = 4;

/** 软限制（超限降级为文件类型上传）与硬限制，单位字节（官方文档） */
export const QQ_MEDIA_SOFT_LIMIT_IMAGE = 20 * 1024 * 1024;
export const QQ_MEDIA_SOFT_LIMIT_VIDEO = 30 * 1024 * 1024;
export const QQ_MEDIA_SOFT_LIMIT_AUDIO = 20 * 1024 * 1024;
export const QQ_MEDIA_HARD_LIMIT = 200 * 1024 * 1024;

/**
 * 入站附件默认落盘目录（**相对 `$DSH_HOME`**）。
 *
 * D51 修正：此前 `src/config/schema.ts` 的默认值（`qqbot/media`）与设置卡片
 * `src/client/card.tsx` 的 `DEFAULT_MEDIA_DIR`（`.dsh/qqbot/media`）各写一份且不一致
 * ——卡片上显示/重置的值与插件真实默认落点不是同一路径。现改为**单一来源**：
 * schema 默认值与卡片基线都引用本常量，并由契约测试对齐全部 11 个字段的默认值。
 */
export const QQ_MEDIA_DEFAULT_DIR = 'qqbot/media';

/** 分片上传：`md5_10m` 的取值长度（官方定义：文件前 10002432 字节的 MD5） */
export const QQ_UPLOAD_MD5_10M_BYTES = 10002432;

// ───────────────────────── 流式 ─────────────────────────

/**
 * 流式分片节流间隔（ms）。
 * 默认 1000ms（避免手机端刷新过频，且远低于平台 50 QPS 上限）。
 */
export const QQ_STREAM_THROTTLE_MS = 1000;

/** 输入中状态的最大持续秒数（官方字段说明：最长 60s） */
export const QQ_INPUT_NOTIFY_MAX_SECONDS = 60;

// ───────────────────────── 单次请求长度上限（D50） ─────────────────────────

/**
 * 单次**流式请求** `content_raw` 的 UTF-8 字节上限（设防值）。
 *
 * 【实测 E3，2026-09-16】平台真实上限夹逼为 **∈ [20414, 20426) 字节**（失败码 `40054018`），
 * 且**按 UTF-8 字节计、与字符数无关**（CJK 6781 字符 ✅ / 6812 ❌；ASCII 20406 字符 ✅ / 20437 ❌，
 * 两条曲线的失败点都落在 ≈20.4 KB）。此处取 **8 KiB** 作保守设防值：
 *   - 远低于实测上限（留 ≈2.5× 余量）；
 *   - 单个 `text-delta` 通常仅几十字符，正常路径**几乎不会触发切分**；
 *   - 触发时按字节切成多片 `append`，**绝不丢弃内容**。
 *
 * ⚠️ 这是**单次请求**的约束，与"整段累积"无关：同一实测下单条流累积 **≥20000 字符**
 * （≈60 KB）仍全部 HTTP 200。旧实现把此上限套在整段累积正文上，导致 >4000 码点的回复被**静默切尾**。
 */
export const QQ_STREAM_REQUEST_MAX_BYTES = 8 * 1024;

/**
 * **非流式**单条普通消息的 UTF-8 字节上限（切条阈值，设防值）。
 *
 * 【实测 E3】单条 markdown 消息 ≥ **32000 CJK 字符（= 96 000 字节）** 仍被接受（未触限，
 * 真实上限未定界）；单条纯文本 ≥16000 字符同样未触限。此处取 **16 KiB**：
 * 既远低于已证可行的量级，又避免把长回复拆成过多条消息。
 */
export const QQ_MESSAGE_MAX_BYTES = 16 * 1024;

// ───────────────────────── 请求超时 ─────────────────────────

/** 普通 REST 请求超时（官方建议上传类接口 ≥5s，这里统一给 30s） */
export const QQ_REQUEST_TIMEOUT_MS = 30_000;
/** 分片 PUT 超时 */
export const QQ_UPLOAD_PUT_TIMEOUT_MS = 60_000;
/** access_token 提前刷新余量（提前 60s 刷新，防止临界点过期） */
export const QQ_TOKEN_REFRESH_MARGIN_MS = 60_000;

// ───────────────────────── 插件 ─────────────────────────

export const PLUGIN_NAME = 'dsh-qqbot-bridge';
/** DSH settings 命名空间 */
export const SETTINGS_NAMESPACE = 'dsh-qqbot-bridge';
/** 凭据在 `.credentials.yaml` 的 refs 键名 */
export const CRED_APP_ID = 'QQ_BOT_APP_ID';
export const CRED_SECRET = 'QQ_BOT_SECRET';

// ───────────────────────── 命令与分页 ─────────────────────────

/** 列表分页大小（一次最多 10 条） */
export const LIST_PAGE_SIZE = 10;

/** 命令回执的最大字符数（避免超长回执） */
export const REPLY_MAX_CHARS = 1500;

// ───────────────────────── 会话控制 ─────────────────────────

/** WS 重连退避延迟序列（毫秒） */
export const QQ_WS_BACKOFF_MS = [2000, 5000, 10000, 30000, 60000] as const;

/** 分片上传完成后的 file_info 缓存安全边界（TTL 减 60s） */
export const QQ_FILE_INFO_TTL_SAFETY_MS = 60_000;