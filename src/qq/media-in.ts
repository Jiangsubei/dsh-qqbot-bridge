/**
 * dsh-qqbot-bridge: 入站附件下载落盘与模型注入
 *
 * 负责解析 QQ 单聊消息中携带的多媒体与文件附件：
 * 1. 安全守卫：内联 SSRF 防御（拦截私有/内网/环回 IP 与本地 Host）、文件名净化与防目录穿越；
 * 2. 媒体解析：针对图片、视频、文件、语音（含 ASR 语音识别文字回显）推断 MIME 与扩展名；
 * 3. 上下文注入：将文件下载落盘至工作区媒体目录，并组装结构化文本注入 Agent 提示词。
 */

import * as net from 'node:net';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { InboundMedia, MediaReceiver, QqC2CMessageEvent, QqClientLike, QqMessageAttachment } from '../types/index.js';
import { encodeSegment, sanitizeFilename } from '../utils/path.js';
import { t } from '../i18n/index.js';
import type { Logger } from '../utils/logger.js';

export type QqAttachmentKind = 'image' | 'video' | 'voice' | 'file';

export interface QqMediaReceiverOptions {
  /** 下载通道（`QqClientLike.fetchAttachment`，E8-1 裸 GET） */
  client: Pick<QqClientLike, 'fetchAttachment'>;
  logger?: Logger;
  /** 落盘根目录（绝对路径优先；相对路径按 dshHome 解析） */
  mediaDir?: string;
  /** DSH_HOME（用于解析相对 `media_dir`）；缺省取环境变量或 `~/.dsh` */
  dshHome?: string;
  /** 单文件落盘上限（字节，默认 200MB） */
  maxBytes?: number;
}

const DEFAULT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/** MIME → 扩展名推断 */
export function getExtensionFromMime(mimeType?: string | null): string {
  if (!mimeType) return 'bin';
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return MIME_TO_EXT[mime] ?? 'bin';
}

/** 附件类型判定（官方 `content_type`：`voice` | `image/*` | `video/mp4` | `file`） */
export function inferAttachmentKind(contentType?: string | null): QqAttachmentKind {
  const mime = (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'voice') return 'voice';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// ─────────────────────────── SSRF 安全守卫 ───────────────────────────

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', '127.0.0.1', '0.0.0.0', '::1', '::']);

/** 私有/内网/环回地址判定 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [p0 = 0, p1 = 0] = parts;
    if (p0 === 0 || p0 === 10 || p0 === 127) return true;
    if (p0 === 169 && p1 === 254) return true;
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    if (p0 === 192 && p1 === 168) return true;
    if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase().trim();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) {
      const rest = lower.slice(7);
      if (net.isIPv4(rest)) return isPrivateIp(rest);
    }
    if (/^fe[89ab]/.test(lower) || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return false;
}

/** 下载 URL 的 SSRF 校验（协议白名单 + 主机名/IP 黑名单） */
export function validateSafeUrl(rawUrl: string): { safe: boolean; error?: string; url?: URL } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { safe: false, error: `Disallowed protocol: ${parsed.protocol}` };
    }
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    if (BLOCKED_HOSTS.has(hostname)) return { safe: false, error: `Blocked host: ${hostname}` };
    if (hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return { safe: false, error: `Blocked domain suffix: ${hostname}` };
    }
    if (net.isIP(hostname) && isPrivateIp(hostname)) {
      return { safe: false, error: `Private IP access denied: ${hostname}` };
    }
    return { safe: true, url: parsed };
  } catch (err) {
    return { safe: false, error: `Invalid URL: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────────── 接收器 ───────────────────────────────────

export class QqMediaReceiver implements MediaReceiver {
  private readonly client: Pick<QqClientLike, 'fetchAttachment'>;
  private readonly log: Logger;
  private readonly mediaDir: string;
  private readonly maxBytes: number;

  constructor(options: QqMediaReceiverOptions) {
    this.client = options.client;
    this.log = options.logger ?? DEFAULT_LOGGER;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.mediaDir = resolveMediaDir(options.mediaDir, options.dshHome);
  }

  async fetchAll(event: QqC2CMessageEvent, sessionId: string): Promise<InboundMedia[]> {
    const attachments = Array.isArray(event.attachments) ? event.attachments : [];
    if (attachments.length === 0) return [];

    const sessionDir = path.join(this.mediaDir, encodeSegment(sessionId));
    await fsp.mkdir(sessionDir, { recursive: true });

    const results: InboundMedia[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const media = await this.downloadOne(attachment, index, sessionDir);
      if (media) results.push(media);
    }
    return results;
  }

  describe(media: InboundMedia[]): string {
    if (media.length === 0) return '';
    return media
      .map((item, index) => {
        const kind = item.imageDataUrl
          ? t('media.kindImage')
          : item.asrText !== undefined
            ? t('media.kindVoice')
            : t('media.kindFile');
        let line = t('media.describe', {
          index: index + 1,
          total: media.length,
          kind,
          name: item.fileName,
          bytes: item.bytes,
          mime: item.mimeType ?? t('media.unknownType'),
          path: item.filePath,
        });
        if (item.imageDataUrl) line += t('media.imageInjected');
        if (item.asrText) line += t('media.voiceTranscript', { text: item.asrText });
        return line;
      })
      .join('\n');
  }

  private async downloadOne(
    attachment: QqMessageAttachment,
    index: number,
    sessionDir: string
  ): Promise<InboundMedia | undefined> {
    const kind = inferAttachmentKind(attachment.content_type);
    const wavUrl = kind === 'voice' && attachment.voice_wav_url ? attachment.voice_wav_url : undefined;
    const url = wavUrl ?? attachment.url;
    if (!url) {
      this.log.warn(`附件 #${index} 缺少 url，跳过`);
      return undefined;
    }

    const safe = validateSafeUrl(url);
    if (!safe.safe || !safe.url) {
      this.log.warn(`附件 #${index} 未通过 SSRF 校验（${safe.error ?? 'unknown'}），跳过`);
      return undefined;
    }

    const downloaded = await this.client.fetchAttachment(safe.url.toString());
    if (!downloaded.ok) {
      this.log.warn(`附件 #${index} 下载失败（HTTP ${downloaded.status}），跳过`);
      return undefined;
    }
    if (downloaded.bytes.length > this.maxBytes) {
      this.log.warn(`附件 #${index} 超出入站落盘上限（${downloaded.bytes.length} > ${this.maxBytes} 字节），跳过`);
      return undefined;
    }

    const mimeType = resolveMime(kind, attachment.content_type, downloaded.contentType, Boolean(wavUrl));
    const ext = getExtensionFromMime(mimeType);
    const fileName = resolveFileName(attachment.filename, url, index, kind, ext);
    const filePath = path.join(sessionDir, fileName);
    // 双保险：净化后的文件名绝不允许越出 session 目录
    if (!filePath.startsWith(sessionDir + path.sep)) {
      this.log.warn(`附件 #${index} 文件名越界（${fileName}），跳过`);
      return undefined;
    }

    await fsp.writeFile(filePath, Buffer.from(downloaded.bytes));

    const result: InboundMedia = {
      filePath,
      fileName,
      bytes: downloaded.bytes.length,
      mimeType,
    };
    if (kind === 'image') {
      result.imageDataUrl = `data:${mimeType};base64,${Buffer.from(downloaded.bytes).toString('base64')}`;
    }
    if (kind === 'voice' && typeof attachment.asr_refer_text === 'string' && attachment.asr_refer_text !== '') {
      result.asrText = attachment.asr_refer_text;
    }
    this.log.debug(`附件 #${index} 已落盘：${filePath}（${mimeType}）`);
    return result;
  }
}

function resolveMediaDir(mediaDir?: string, dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.dsh');
  // 兜底默认须与 `src/config/schema.ts` 的 `media_dir` 默认值保持一致（相对 DSH_HOME）；
  // 接线时 index.ts 总会传入配置值，此处仅是无配置场景的兜底。
  const configured = mediaDir ?? 'qqbot/media';
  return path.isAbsolute(configured) ? configured : path.join(path.resolve(home), configured);
}

/** 按附件类型定 mime（E8-4：语音绝不信原始 URL 的响应头） */
function resolveMime(
  kind: QqAttachmentKind,
  declared: string | undefined,
  responseType: string | null,
  isWav: boolean
): string {
  const declaredMime = (declared ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  const responseMime = (responseType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (kind === 'voice') {
    // voice_wav_url 明确返回 audio/x-wav（E8-4）；原始语音 URL 的响应头不可信 → 归一为 amr
    return isWav ? 'audio/x-wav' : 'audio/amr';
  }
  if (kind === 'image') return declaredMime.startsWith('image/') ? declaredMime : responseMime.startsWith('image/') ? responseMime : 'application/octet-stream';
  if (kind === 'video') return declaredMime.startsWith('video/') ? declaredMime : responseMime.startsWith('video/') ? responseMime : 'application/octet-stream';
  // file：`content_type` 字段是字面量 'file'（不是 MIME），只能用响应头兜底
  return responseMime !== '' && responseMime !== 'file' ? responseMime : 'application/octet-stream';
}

/**
 * 文件名策略（E8-3）：
 * - `file` 类型保留真实文件名（净化后），仅当缺扩展名时补推断扩展名；
 * - 图片/语音是哈希名 → 只保留 stem，扩展名以 `content_type`/`voice_wav_url` 语义为准。
 */
function resolveFileName(
  declaredName: string | undefined,
  url: string,
  index: number,
  kind: QqAttachmentKind,
  ext: string
): string {
  const raw = declaredName && declaredName.trim() !== '' ? declaredName : basenameFromUrl(url);
  const sanitized = sanitizeFilename(raw, `attachment-${index}`);
  if (kind === 'file' && /\.[A-Za-z0-9]{1,10}$/.test(sanitized)) return sanitized;
  const stem = sanitized.replace(/\.[^.]*$/, '') || `attachment-${index}`;
  return `${stem}.${ext}`;
}

function basenameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : '';
  } catch {
    return '';
  }
}