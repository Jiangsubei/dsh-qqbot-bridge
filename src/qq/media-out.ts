/**
 * dsh-qqbot-bridge: 出站富媒体发送
 *
 * 实现 QQ 开放平台官方四步分片上传链路：
 * 1. 准备阶段：POST /v2/users/{openid}/files upload_prepare 申请分片元数据；
 * 2. 分片上传：对每个分片向预签名 URL 发送裸 PUT 请求，严格按累积偏移切片；
 * 3. 分片确认：逐片调用 upload_part_finish 上报分片字节数；
 * 4. 传输完成：POST /v2/users/{openid}/files 上报 upload_id，获取最终 file_info；
 * 5. 消息下发：组装 msg_type=7 富媒体消息发送给 QQ 用户。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  QQ_FILE_INFO_TTL_SAFETY_MS,
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_MEDIA_HARD_LIMIT,
  QQ_MEDIA_SOFT_LIMIT_AUDIO,
  QQ_MEDIA_SOFT_LIMIT_IMAGE,
  QQ_MEDIA_SOFT_LIMIT_VIDEO,
  QQ_MSG_TYPE_MEDIA,
  QQ_UPLOAD_MD5_10M_BYTES,
} from '../constants/index.js';
import type {
  MediaSender,
  OutboundTarget,
  QqApiResult,
  QqFileUploadResponse,
  QqSendMessagePayload,
  QqUploadPrepareResponse,
  SlotAllocator,
} from '../types/index.js';
import { QqErrorCode } from '../types/index.js';
import type { Logger } from '../utils/logger.js';
import { MsgSeqSlotAllocator } from './stream.js';

export interface QqMediaInput {
  /** 本地文件路径（与 `bytes` 二选一） */
  path?: string;
  /** 内存字节（与 `path` 二选一） */
  bytes?: Uint8Array;
  filename: string;
  /** 官方 file_type：1 图片 / 2 视频 / 3 语音 / 4 文件；缺省按扩展名推断 */
  fileType?: number;
}

/** MediaSender 实际需要的协议客户端最小面（`QqClientLike` 是它的超集） */
export interface QqMediaClient {
  apiPost(pathname: string, payload: unknown): Promise<QqApiResult>;
  putPresigned(url: string, body: Uint8Array): Promise<{ ok: boolean; status: number }>;
  sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult>;
}

export interface QqMediaSenderOptions {
  client: QqMediaClient;
  logger?: Logger;
  /** 默认上传目标 openid；未提供时必须经 `send(target, …)` 或 `upload(input, openid)` 显式给出 */
  defaultOpenid?: string;
  /**
   * per-`msg_id` 的 `msg_seq` 槽位分配器（**风险 R9**）。
   * **必须与流式/文本出站共享同一实例**，否则富媒体可能取到已被流式占用的格。
   * 缺省时本模块自建一份（与 `QqStreamManager` 同口径）。
   */
  slots?: SlotAllocator;
  /** `file_info` TTL 缓存开关（默认开；缓存键为本地文件身份，不是内容哈希"秒传"） */
  enableCache?: boolean;
  /** 整链重试次数（仅对**瞬态**失败：status 0 或 ≥500；默认 1） */
  maxUploadRetries?: number;
}

export class MediaUploadError extends Error {
  /** 瞬态失败（网络/5xx）可重试；业务失败（如 `850019`）不重试 */
  readonly transient: boolean;
  readonly code?: string | number;

  constructor(message: string, options: { transient?: boolean; code?: string | number } = {}) {
    super(message);
    this.name = 'MediaUploadError';
    this.transient = options.transient ?? false;
    if (options.code !== undefined) this.code = options.code;
  }
}

const DEFAULT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** 扩展名 → 官方 file_type */
const EXT_TO_FILE_TYPE: Record<string, number> = {
  '.png': QQ_FILE_TYPE_IMAGE,
  '.jpg': QQ_FILE_TYPE_IMAGE,
  '.jpeg': QQ_FILE_TYPE_IMAGE,
  '.gif': QQ_FILE_TYPE_IMAGE,
  '.webp': QQ_FILE_TYPE_IMAGE,
  '.bmp': QQ_FILE_TYPE_IMAGE,
  '.ico': QQ_FILE_TYPE_IMAGE,
  '.tiff': QQ_FILE_TYPE_IMAGE,
  '.mp4': QQ_FILE_TYPE_VIDEO,
  '.mov': QQ_FILE_TYPE_VIDEO,
  '.avi': QQ_FILE_TYPE_VIDEO,
  '.mkv': QQ_FILE_TYPE_VIDEO,
  '.webm': QQ_FILE_TYPE_VIDEO,
  '.flv': QQ_FILE_TYPE_VIDEO,
  '.wmv': QQ_FILE_TYPE_VIDEO,
  '.mp3': QQ_FILE_TYPE_AUDIO,
  '.wav': QQ_FILE_TYPE_AUDIO,
  '.aac': QQ_FILE_TYPE_AUDIO,
  '.ogg': QQ_FILE_TYPE_AUDIO,
  '.m4a': QQ_FILE_TYPE_AUDIO,
  '.silk': QQ_FILE_TYPE_AUDIO,
  '.amr': QQ_FILE_TYPE_AUDIO,
  '.flac': QQ_FILE_TYPE_AUDIO,
};

/** 按扩展名推断官方 file_type（缺省 4=文件） */
export function detectFileType(filename?: string): number {
  if (!filename) return QQ_FILE_TYPE_FILE;
  const ext = path.extname(filename.split('?')[0] ?? '').toLowerCase();
  return EXT_TO_FILE_TYPE[ext] ?? QQ_FILE_TYPE_FILE;
}

/**
 * 软限降级 + 硬限拒绝（Y5）：
 * - 图片 >20MB / 视频 >30MB / 语音 >20MB → 降级为 file_type=4（文件卡片仍可下载）；
 * - 任何类型 >200MB → 直接拒绝。
 */
export function resolveUploadFileType(
  filename: string,
  sizeBytes: number,
  requested?: number
): { fileType: number; degraded: boolean } {
  if (sizeBytes > QQ_MEDIA_HARD_LIMIT) {
    throw new MediaUploadError(
      `Media size (${(sizeBytes / 1024 / 1024).toFixed(2)}MB) exceeds hard limit of 200MB.`
    );
  }
  const requestedType = requested ?? detectFileType(filename);
  const softLimit =
    requestedType === QQ_FILE_TYPE_IMAGE
      ? QQ_MEDIA_SOFT_LIMIT_IMAGE
      : requestedType === QQ_FILE_TYPE_VIDEO
        ? QQ_MEDIA_SOFT_LIMIT_VIDEO
        : requestedType === QQ_FILE_TYPE_AUDIO
          ? QQ_MEDIA_SOFT_LIMIT_AUDIO
          : Number.POSITIVE_INFINITY;
  if (sizeBytes > softLimit) {
    return { fileType: QQ_FILE_TYPE_FILE, degraded: true };
  }
  return { fileType: requestedType, degraded: false };
}

interface CachedFileInfo {
  file_uuid?: string;
  file_info: string;
  ttl: number;
  expiresAt: number;
}

const md5Hex = (data: Uint8Array): string => createHash('md5').update(data).digest('hex');
const sha1Hex = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class QqMediaSender implements MediaSender {
  private readonly client: QqMediaClient;
  private readonly log: Logger;
  private readonly slots: SlotAllocator;
  private readonly enableCache: boolean;
  private readonly maxUploadRetries: number;
  private readonly fileInfoCache = new Map<string, CachedFileInfo>();

  /** openid 缺省值（`upload()` 单独调用时使用；`send()` 会以 target.openid 显式传入） */
  private activeOpenid: string | undefined;

  constructor(options: QqMediaSenderOptions) {
    this.client = options.client;
    this.log = options.logger ?? DEFAULT_LOGGER;
    this.slots = options.slots ?? new MsgSeqSlotAllocator();
    this.enableCache = options.enableCache !== false;
    this.maxUploadRetries = options.maxUploadRetries ?? 1;
    this.activeOpenid = options.defaultOpenid;
  }

  /**
   * 本地文件/Buffer → `file_info`（四步分片上传），带 TTL 缓存。
   * `openidOverride` 为契约测试与显式调用路径保留；缺省用 `defaultOpenid`。
   */
  async upload(input: QqMediaInput, openidOverride?: string): Promise<QqFileUploadResponse> {
    const openid = openidOverride ?? this.activeOpenid;
    if (!openid) {
      throw new MediaUploadError('缺少 openid：上传单聊富媒体必须知道目标用户（请用 send(target, …) 或传 openid）');
    }

    const bytes = this.loadBytes(input);
    const { fileType, degraded } = resolveUploadFileType(input.filename, bytes.length, input.fileType);
    if (degraded) {
      this.log.warn(`富媒体超软限，降级为 file_type=4：${input.filename}（${bytes.length}B）`);
    }

    const cacheKey = this.fileInfoCacheKey(openid, fileType, input);
    if (cacheKey) {
      const cached = this.fileInfoCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        this.log.debug(`命中 file_info 缓存：${input.filename}`);
        return { file_uuid: cached.file_uuid, file_info: cached.file_info, ttl: cached.ttl };
      }
      if (cached) this.fileInfoCache.delete(cacheKey);
    }

    const result = await this.uploadWithRetry(openid, bytes, input.filename, fileType);
    if (!result.file_info) {
      throw new MediaUploadError('合并阶段未返回 file_info');
    }
    if (cacheKey && this.enableCache) {
      const ttl = result.ttl ?? 0;
      this.fileInfoCache.set(cacheKey, {
        file_uuid: result.file_uuid,
        file_info: result.file_info,
        ttl,
        // TTL 缓存：保留安全时间余量（TTL - 60s）
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 - QQ_FILE_INFO_TTL_SAFETY_MS : Number.POSITIVE_INFINITY,
      });
    }
    return result;
  }

  /** 发送 `msg_type=7` 富媒体消息（file_info 由 `upload` 保证） */
  async send(
    target: OutboundTarget,
    input: QqMediaInput,
    options: { msgSeq?: number } = {}
  ): Promise<QqApiResult> {
    const uploaded = await this.upload(input, target.openid);
    if (!uploaded.file_info) throw new MediaUploadError('上传未返回 file_info，拒绝发送空媒体');

    const payload: QqSendMessagePayload = {
      msg_type: QQ_MSG_TYPE_MEDIA,
      // E7 探针实测送达的形态（msg_type=7 + media.file_info）；content 为占位空串
      content: ' ',
      media: { file_info: uploaded.file_info },
    };
    if (target.msgId) payload.msg_id = target.msgId;
    // R9（真机 2026-09-15 复现）：`(msg_id, msg_seq)` 唯一，**不下发 msg_seq 不等于不占格** ——
    // 同一 msg_id 上第一条富媒体之后的发送会被 QQ 拒 `40054005 消息被去重`（等 60s 不恢复）。
    // 口径与流式/文本出站一致：从共享分配器里取一个未占用的格。
    const seq = options.msgSeq ?? (target.msgId ? this.allocSlot(target.msgId) : undefined);
    if (seq !== undefined) payload.msg_seq = seq;
    // 真机反馈（2026-09-15）：富媒体引用入站消息会干扰阅读 → **不再**下发 message_reference。
    const first = await this.client.sendMessage(target.openid, payload);
    if (first.ok || String(first.code) !== QqErrorCode.MESSAGE_DEDUPLICATED) return first;

    // 真机 2026-09-15（额度探针轮）：同一 msg_id 上**并发首条**偶发 `40054005`，
    // 同一文件单独重发即成功 ⇒ 属可恢复的服务端去重。兜底设计：换一个**新**格重试一次。
    // 新格按定义未被占用，故重试安全；只重试一次，不掩盖其它真实失败。
    // 无 `msgId`（主动消息）时没有槽位可换，直接如实返回失败。
    if (!target.msgId) return first;
    const retrySeq = this.allocSlot(target.msgId);
    this.log.warn(`富媒体发送遇 40054005（msg_id=${target.msgId}），换 msg_seq=${retrySeq} 重试一次`);
    return this.client.sendMessage(target.openid, { ...payload, msg_seq: retrySeq });
  }

  /** 清空 `file_info` 缓存（dispose 时调用） */
  clearCache(): void {
    this.fileInfoCache.clear();
  }

  /** 取一个未占用的 `msg_seq` 格并登记占用（与 `QqStreamManager.allocSlot` 同口径） */
  private allocSlot(msgId: string): number {
    const seq = this.slots.alloc(msgId);
    this.slots.occupy(msgId, seq);
    return seq;
  }

  // ─────────────────────────────── 内部实现 ───────────────────────────────

  private loadBytes(input: QqMediaInput): Uint8Array {
    if (input.bytes) return input.bytes;
    if (input.path) {
      try {
        return new Uint8Array(fs.readFileSync(path.resolve(input.path)));
      } catch (err) {
        throw new MediaUploadError(`读取本地文件失败：${input.path}（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    throw new MediaUploadError('必须提供 path 或 bytes');
  }

  /**
   * 缓存键：**本地文件身份**（绝对路径 + size + mtime 秒），不是"内容哈希秒传"。
   * 内存 bytes 输入返回 null（一律真实上传，E7-6 不依赖服务端秒传）。
   */
  private fileInfoCacheKey(openid: string, fileType: number, input: QqMediaInput): string | null {
    if (!input.path) return null;
    const abs = path.resolve(input.path);
    let stamp = 'missing';
    try {
      const stat = fs.statSync(abs);
      stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      /* 读取阶段会再报错，这里只求缓存键稳定 */
    }
    return `${openid}|${fileType}|${abs}|${stamp}`;
  }

  private async uploadWithRetry(
    openid: string,
    bytes: Uint8Array,
    filename: string,
    fileType: number
  ): Promise<QqFileUploadResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxUploadRetries; attempt += 1) {
      try {
        return await this.chunkedUpload(openid, bytes, filename, fileType);
      } catch (err) {
        lastError = err;
        const canRetry = attempt < this.maxUploadRetries && err instanceof MediaUploadError && err.transient;
        if (!canRetry) throw err;
        const delay = 500 * 2 ** attempt;
        this.log.warn(`分片上传瞬态失败，${delay}ms 后重试（第 ${attempt + 1}/${this.maxUploadRetries} 次）：${(err as Error).message}`);
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new MediaUploadError(String(lastError));
  }

  /**
   * 官方四步分片上传。
   * E7 实测语义：`index` 1-based、每片自带 `block_size`、**累积偏移**切片、
   * `upload_part_finish` 上报**该片自己的** `block_size`。
   */
  private async chunkedUpload(
    openid: string,
    bytes: Uint8Array,
    filename: string,
    fileType: number
  ): Promise<QqFileUploadResponse> {
    const base = `/v2/users/${encodeURIComponent(openid)}`;
    const prepare = await this.client.apiPost(`${base}/upload_prepare`, {
      file_type: fileType,
      file_size: String(bytes.length),
      file_name: filename,
      md5: md5Hex(bytes),
      sha1: sha1Hex(bytes),
      md5_10m: md5Hex(bytes.subarray(0, QQ_UPLOAD_MD5_10M_BYTES)),
    });
    if (!prepare.ok) {
      throw new MediaUploadError(`upload_prepare 失败（code=${prepare.code ?? 'n/a'} ${prepare.message ?? ''}）`, {
        transient: isTransient(prepare),
        code: prepare.code,
      });
    }

    const body = prepare.body as QqUploadPrepareResponse | null;
    const uploadId = body?.upload_id;
    if (typeof uploadId !== 'string' || uploadId === '') {
      throw new MediaUploadError('upload_prepare 响应缺少 upload_id');
    }
    const rawParts = Array.isArray(body?.parts) ? body.parts : [];
    if (rawParts.length === 0) {
      throw new MediaUploadError('upload_prepare 响应未返回任何 parts');
    }
    const globalBlockSize = Number(body?.block_size ?? 0);
    // E7-2：实测 index 为 1-based；必须按 index 升序处理并做**累积偏移**
    const parts = [...rawParts].sort((a, b) => Number(a.index) - Number(b.index));

    let offset = 0;
    for (const part of parts) {
      if (offset >= bytes.length) break;
      const remaining = bytes.length - offset;
      // E7-3：每片自带 block_size（末片为余数）；缺失时才退回全局
      const declaredSize = Number(part.block_size ?? globalBlockSize) || remaining;
      const take = Math.min(declaredSize, remaining);
      const chunk = bytes.subarray(offset, offset + take);
      offset += chunk.length;

      const put = await this.client.putPresigned(part.presigned_url, chunk);
      if (!put.ok) {
        throw new MediaUploadError(`分片 #${part.index} PUT 预签名 URL 失败（status=${put.status}）`, {
          transient: put.status === 0 || put.status >= 500,
        });
      }

      const finish = await this.client.apiPost(`${base}/upload_part_finish`, {
        upload_id: uploadId,
        part_index: part.index,
        // 关键：该片自己的 block_size（不是全局值；上报全局会 850012 / 合并 40093006）
        block_size: String(declaredSize),
        md5: md5Hex(chunk),
      });
      if (!finish.ok) {
        throw new MediaUploadError(
          `upload_part_finish 分片 #${part.index} 失败（code=${finish.code ?? 'n/a'} ${finish.message ?? ''}）`,
          { transient: isTransient(finish), code: finish.code }
        );
      }
    }

    if (offset !== bytes.length) {
      throw new MediaUploadError(`分片覆盖不完整：已上传 ${offset}/${bytes.length} 字节`);
    }

    const merge = await this.client.apiPost(`${base}/files`, { upload_id: uploadId });
    if (!merge.ok) {
      throw new MediaUploadError(`文件合并失败（code=${merge.code ?? 'n/a'} ${merge.message ?? ''}）`, {
        transient: isTransient(merge),
        code: merge.code,
      });
    }
    const merged = merge.body as QqFileUploadResponse | null;
    if (typeof merged?.file_info !== 'string' || merged.file_info === '') {
      throw new MediaUploadError('文件合并响应缺少 file_info');
    }
    return { file_uuid: merged.file_uuid, file_info: merged.file_info, ttl: merged.ttl };
  }
}

/** 瞬态失败：网络层（status 0）或 5xx，可重试；业务错误码不重试 */
function isTransient(result: QqApiResult): boolean {
  return result.status === 0 || result.status >= 500;
}