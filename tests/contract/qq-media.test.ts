/**
 * 契约测试：富媒体收发（`src/qq/media-out.ts` = Y5 + E7；`src/qq/media-in.ts` = Y4 + E8）
 * 以及 agent 工具注册（`send_file` / `send_image`）。
 *
 * 锁死的实测语义：
 *   E7-2  `parts[].index` 实测 **1-based**（文档称 0-based）→ 不得做 `index * block_size`；
 *   E7-3  每片自带 `block_size`（末片为余数），`upload_part_finish` 必须上报**该片自己的**值；
 *         切片必须按 index 升序做**累积偏移**；
 *   E7 首轮回归：单分片 148009B 场景**上传的不是 0 字节**（0-based 假设会静默传 0 字节）；
 *   E7-5  `ttl` 实测 86400，同一 `file_info` 可复用多次发送；
 *   E7-6  秒传未命中（同内容重传得到不同 `file_uuid`）→ **不得**做"内容哈希命中就跳过上传"的捷径；
 *   E8-1  入站附件**裸 GET** 即可下载（无鉴权头）；
 *   E8-3  `file` 类型保留真实文件名；图片/语音是哈希名 → 用 content_type 推断扩展名；
 *   E8-4  原始语音 URL 响应头 content-type 不可信（报 audio/mp3 实为 amr）→ 语音优先落
 *         `voice_wav_url` 的 WAV（audio/x-wav），并带上 `asr_refer_text`；
 *   E8-5  文件名是**外部输入** → `sanitizeFilename` + basename 净化，防路径穿越。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';

import {
  QqMediaSender,
  detectFileType,
  resolveUploadFileType,
  MediaUploadError,
  type QqMediaClient,
} from '../../src/qq/media-out.js';
import { QqMediaReceiver, validateSafeUrl } from '../../src/qq/media-in.js';
import { MsgSeqSlotAllocator } from '../../src/qq/stream.js';
import { registerAgentTools } from '../../src/tools/index.js';
import {
  QQ_UPLOAD_MD5_10M_BYTES,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
} from '../../src/constants/index.js';
import type { Logger } from '../../src/utils/logger.js';
import type { MediaSender, OutboundTarget, QqApiResult } from '../../src/types/index.js';

const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');

function ok(body: unknown): QqApiResult {
  return { ok: true, status: 200, code: 0, body };
}

interface RecordedPost {
  pathname: string;
  payload: Record<string, unknown>;
}

interface RecordedPut {
  url: string;
  body: Uint8Array;
}

/**
 * 假协议客户端（隔离网络）。
 * `prepareQueue` 支持按次数返回不同 prepare 响应，用于断言"没有秒传捷径"。
 */
function makeMediaClient(options: {
  prepare?: () => unknown;
  prepareQueue?: unknown[];
  merge?: (call: number) => unknown;
}): {
  client: QqMediaClient;
  posts: RecordedPost[];
  puts: RecordedPut[];
  sent: Array<{ openid: string; payload: Record<string, unknown> }>;
  counts: { prepare: number; partFinish: number; merge: number };
} {
  const posts: RecordedPost[] = [];
  const puts: RecordedPut[] = [];
  const sent: Array<{ openid: string; payload: Record<string, unknown> }> = [];
  const counts = { prepare: 0, partFinish: 0, merge: 0 };
  let mergeCall = 0;

  const client: QqMediaClient = {
    async apiPost(pathname, payload) {
      const record = payload as Record<string, unknown>;
      posts.push({ pathname, payload: record });
      if (pathname.includes('upload_prepare')) {
        counts.prepare += 1;
        if (options.prepareQueue && options.prepareQueue.length > 0) {
          return ok(options.prepareQueue[Math.min(counts.prepare - 1, options.prepareQueue.length - 1)]);
        }
        return ok(options.prepare ? options.prepare() : {});
      }
      if (pathname.includes('upload_part_finish')) {
        counts.partFinish += 1;
        return ok({ code: 0 });
      }
      if (pathname.endsWith('/files')) {
        counts.merge += 1;
        mergeCall += 1;
        return ok(options.merge ? options.merge(mergeCall) : { file_uuid: 'uuid-1', file_info: 'file-info-1', ttl: 86400 });
      }
      return ok({});
    },
    async putPresigned(url, body) {
      puts.push({ url, body });
      return { ok: true, status: 200 };
    },
    async sendMessage(openid, payload) {
      sent.push({ openid, payload: payload as unknown as Record<string, unknown> });
      return { ok: true, status: 200, code: 0, body: { id: 'out-1' } };
    },
  };

  return { client, posts, puts, sent, counts };
}

const TARGET: OutboundTarget = { openid: 'user-openid-1', msgId: 'msg-1' };

// ═══════════════════════════ 出站：E7 分片上传 ══════════════════════════

describe('QqMediaSender · E7 分片上传四步语义', () => {
  it('【0 字节回归】单分片 148009B：index=1（1-based）+ 累积偏移 → PUT 的不是 0 字节', async () => {
    const bytes = randomBytes(148009);
    const { client, posts, puts, counts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-single',
        block_size: '10485760',
        // E7-2 实测：单分片时 index 返回 1（不是 0）
        parts: [{ index: 1, presigned_url: 'https://cos.example/part-1', block_size: '148009' }],
      }),
      merge: () => ({ file_uuid: 'uuid-img', file_info: 'file-info-img', ttl: 86400 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const res = await sender.upload({ bytes, filename: 'e7-probe-image.png', fileType: 1 });

    expect(res.file_info).toBe('file-info-img');
    expect(counts.prepare).toBe(1);
    expect(puts).toHaveLength(1);
    // ️ 核心回归断言：按文档 0-based 实现会得到偏移 148009 → 上传 0 字节
    expect(puts[0]!.body.length).toBe(148009);
    expect(puts[0]!.body.length).not.toBe(0);
    expect(md5(puts[0]!.body)).toBe(md5(bytes));

    const finish = posts.find((p) => p.pathname.includes('upload_part_finish'))!;
    expect(finish.payload.part_index).toBe(1);
    // E7-3：上报该片自己的 block_size（余数），而不是全局 block_size（10485760）
    expect(String(finish.payload.block_size)).toBe('148009');
    expect(String(finish.payload.block_size)).not.toBe('10485760');
    // part_finish 的 md5 是**该片内容**的 md5
    expect(String(finish.payload.md5)).toBe(md5(bytes));
  });

  it('prepare 必带 md5 / sha1 / md5_10m（前 10002432 字节）三个校验值', async () => {
    const bytes = randomBytes(12 * 1024 * 1024);
    const { client, posts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-big',
        block_size: '10485760',
        parts: [
          { index: 1, presigned_url: 'https://cos.example/p1', block_size: '10485760' },
          { index: 2, presigned_url: 'https://cos.example/p2', block_size: '2097152' },
        ],
      }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    await sender.upload({ bytes, filename: 'e7-probe-12mb.bin', fileType: 4 });

    const prepare = posts.find((p) => p.pathname.includes('upload_prepare'))!;
    expect(prepare.payload.file_size).toBe('12582912');
    expect(String(prepare.payload.md5)).toBe(md5(bytes));
    expect(String(prepare.payload.sha1)).toBe(sha1(bytes));
    expect(String(prepare.payload.md5_10m)).toBe(md5(bytes.subarray(0, QQ_UPLOAD_MD5_10M_BYTES)));
    // 12MB > 10002432B → md5_10m 必然是"前 10MB"的 md5，与整文件 md5 不同
    expect(String(prepare.payload.md5_10m)).not.toBe(String(prepare.payload.md5));
  });

  it('多分片：按 index 升序累积偏移切片，末片用余数 block_size', async () => {
    const bytes = randomBytes(12 * 1024 * 1024); // 10485760 + 2097152
    const { client, posts, puts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-big',
        block_size: '10485760',
        parts: [
          { index: 2, presigned_url: 'https://cos.example/p2', block_size: '2097152' },
          { index: 1, presigned_url: 'https://cos.example/p1', block_size: '10485760' },
        ],
      }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    await sender.upload({ bytes, filename: 'e7-probe-12mb.bin', fileType: 4 });

    // 顺序必须按 index 升序（即使响应里乱序返回）
    expect(puts.map((p) => p.url)).toEqual(['https://cos.example/p1', 'https://cos.example/p2']);
    expect(puts.map((p) => p.body.length)).toEqual([10485760, 2097152]);
    const joined = Buffer.concat(puts.map((p) => Buffer.from(p.body)));
    expect(joined.length).toBe(bytes.length);
    expect(md5(joined)).toBe(md5(bytes));

    const finishes = posts.filter((p) => p.pathname.includes('upload_part_finish'));
    expect(finishes.map((p) => p.payload.part_index)).toEqual([1, 2]);
    // 末片必须用余数（2097152），而不是全局 block_size
    expect(finishes.map((p) => String(p.payload.block_size))).toEqual(['10485760', '2097152']);
    expect(finishes.map((p) => String(p.payload.md5))).toEqual([
      md5(bytes.subarray(0, 10485760)),
      md5(bytes.subarray(10485760)),
    ]);
  });

  it('合并阶段带 upload_id 调 /v2/users/{openid}/files，返回 file_info / ttl', async () => {
    const bytes = randomBytes(148009);
    const { client, posts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-merge',
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '148009' }],
      }),
      merge: () => ({ file_uuid: 'uuid-x', file_info: 'file-info-x', ttl: 86400 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    const res = await sender.upload({ bytes, filename: 'a.png', fileType: 1 });

    const merge = posts.find((p) => p.pathname.endsWith('/files'))!;
    expect(merge.pathname).toBe(`/v2/users/${encodeURIComponent(TARGET.openid)}/files`);
    expect(merge.payload.upload_id).toBe('up-merge');
    expect(res.ttl).toBe(86400);
  });

  it('put 失败 → 抛 MediaUploadError，且不再继续 part_finish/合并', async () => {
    const bytes = randomBytes(148009);
    const { client, counts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-fail',
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '148009' }],
      }),
    });
    const failing: QqMediaClient = {
      ...client,
      async putPresigned() {
        return { ok: false, status: 500 };
      },
    };
    const sender = new QqMediaSender({ client: failing, logger: silentLogger, defaultOpenid: TARGET.openid, maxUploadRetries: 0 });
    await expect(sender.upload({ bytes, filename: 'a.png', fileType: 1 })).rejects.toBeInstanceOf(MediaUploadError);
    expect(counts.partFinish).toBe(0);
    expect(counts.merge).toBe(0);
  });
});

describe('QqMediaSender · file_info 缓存与"无秒传捷径"（E7-5 / E7-6）', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-media-out-'));
  });
  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('E7-6：同内容重传必须真实上传两次（不得以内容哈希命中跳过上传）', async () => {
    const bytes = randomBytes(2048);
    let mergeCall = 0;
    const { client, counts } = makeMediaClient({
      prepare: () => ({
        upload_id: `up-${Date.now()}`,
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '2048' }],
      }),
      // E7-6 实测：同内容重传服务端返回**不同** file_uuid
      merge: () => {
        mergeCall += 1;
        return { file_uuid: `uuid-${mergeCall}`, file_info: `file-info-${mergeCall}`, ttl: 86400 };
      },
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const first = await sender.upload({ bytes, filename: 'same.bin', fileType: 4 });
    const second = await sender.upload({ bytes, filename: 'same.bin', fileType: 4 });

    expect(counts.prepare).toBe(2);
    expect(first.file_uuid).toBe('uuid-1');
    expect(second.file_uuid).toBe('uuid-2');
    expect(first.file_uuid).not.toBe(second.file_uuid);
  });

  it('E7-5：同一本地文件（path）在 TTL 内复用 file_info，两次 send 只上传一次', async () => {
    const filePath = path.join(tempDir, 'report.json');
    await fsp.writeFile(filePath, '{"hello":"world"}');
    const { client, counts, sent } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-cache',
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '17' }],
      }),
      merge: () => ({ file_uuid: 'uuid-cache', file_info: 'file-info-cache', ttl: 86400 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const uploaded = await sender.upload({ path: filePath, filename: 'report.json', fileType: 4 });
    expect(uploaded.ttl).toBe(86400);
    await sender.send(TARGET, { path: filePath, filename: 'report.json', fileType: 4 });
    await sender.send(TARGET, { path: filePath, filename: 'report.json', fileType: 4 });

    expect(counts.prepare).toBe(1); // 第二次/第三次命中 file_info 缓存
    expect(sent).toHaveLength(2); // 但消息确实发了两次（file_info 可复用）
    expect(sent[0]!.payload.media).toEqual({ file_info: 'file-info-cache' });
    expect(sent[1]!.payload.media).toEqual({ file_info: 'file-info-cache' });

    sender.clearCache();
    await sender.upload({ path: filePath, filename: 'report.json', fileType: 4 });
    expect(counts.prepare).toBe(2); // 清缓存后必须真实重传
  });

  it('缓存安全边界：ttl 小于 60s 时视为立即过期（不使用已过期的 file_info）', async () => {
    const filePath = path.join(tempDir, 'short.json');
    await fsp.writeFile(filePath, '{}');
    const { client, counts } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-short',
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '2' }],
      }),
      merge: () => ({ file_uuid: 'uuid-short', file_info: 'file-info-short', ttl: 30 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    await sender.upload({ path: filePath, filename: 'short.json', fileType: 4 });
    await sender.upload({ path: filePath, filename: 'short.json', fileType: 4 });
    expect(counts.prepare).toBe(2);
  });
});

describe('QqMediaSender · file_type 映射与降级（Y5）', () => {
  it('按扩展名映射 file_type：图片/视频/语音/文件', () => {
    expect(detectFileType('a.png')).toBe(QQ_FILE_TYPE_IMAGE);
    expect(detectFileType('a.JPEG')).toBe(QQ_FILE_TYPE_IMAGE);
    expect(detectFileType('a.mp4')).toBe(2);
    expect(detectFileType('a.amr')).toBe(3);
    expect(detectFileType('a.bin')).toBe(QQ_FILE_TYPE_FILE);
    expect(detectFileType(undefined)).toBe(QQ_FILE_TYPE_FILE);
  });

  it('超软限的图片降级为 file_type=4；超硬限（200MB）直接拒绝', () => {
    const degraded = resolveUploadFileType('big.png', 21 * 1024 * 1024, QQ_FILE_TYPE_IMAGE);
    expect(degraded.fileType).toBe(QQ_FILE_TYPE_FILE);
    expect(degraded.degraded).toBe(true);

    const kept = resolveUploadFileType('small.png', 1024, QQ_FILE_TYPE_IMAGE);
    expect(kept.fileType).toBe(QQ_FILE_TYPE_IMAGE);
    expect(kept.degraded).toBe(false);

    expect(() => resolveUploadFileType('huge.bin', 201 * 1024 * 1024, QQ_FILE_TYPE_FILE)).toThrow(/hard limit/);
  });
});

describe('QqMediaSender · msg_type=7 发送', () => {
  it('发送 msg_type=7 富媒体，带 msg_id / 显式 msg_seq，且**不引用**入站消息', async () => {
    const bytes = randomBytes(256);
    const { client, sent } = makeMediaClient({
      prepare: () => ({
        upload_id: 'up-send',
        block_size: '10485760',
        parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '256' }],
      }),
      merge: () => ({ file_uuid: 'uuid-s', file_info: 'file-info-s', ttl: 86400 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    const res = await sender.send(TARGET, { bytes, filename: 'x.png', fileType: 1 }, { msgSeq: 3 });

    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.openid).toBe(TARGET.openid);
    expect(sent[0]!.payload.msg_type).toBe(7);
    expect(sent[0]!.payload.media).toEqual({ file_info: 'file-info-s' });
    expect(sent[0]!.payload.msg_id).toBe('msg-1');
    expect(sent[0]!.payload.msg_seq).toBe(3);
    // 真机反馈（2026-09-15）：富媒体消息引用入站消息会干扰阅读 → 显式去掉引用锚点
    expect(sent[0]!.payload.message_reference).toBeUndefined();
  });

  it('上传失败时 send 抛 MediaUploadError（不静默发空媒体）', async () => {
    const { client } = makeMediaClient({
      prepare: () => ({ upload_id: 'up-e', block_size: '10485760', parts: [] }),
      merge: () => ({ file_uuid: 'x', file_info: undefined, ttl: 86400 }),
    });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });
    await expect(sender.send(TARGET, { bytes: new Uint8Array([1]), filename: 'x.bin', fileType: 4 })).rejects.toBeInstanceOf(
      MediaUploadError
    );
  });
});

/**
 * R9 · 富媒体也必须占用一个未占用的 `(msg_id, msg_seq)` 槽位（真机 2026-09-15 复现）。
 *
 * 【实测】同一轮对话内连续调用 `send_file` / `send_image`，除第一条外全部被 QQ 拒
 * `40054005 消息被去重，请检查请求msgseq`；等待 60s 不恢复。根因是富媒体发送路径
 * **完全不下发 `msg_seq`**，而 `(msg_id, msg_seq)` 在本轮已被流式回复占格。
 * 修复口径与设计文档 §7.5 / 流式路径一致：从**共享** `SlotAllocator` 取未占用格。
 */
describe('QqMediaSender · R9 msg_seq 槽位分配', () => {
  const PREPARE = (): unknown => ({
    upload_id: 'up-r9',
    block_size: '10485760',
    parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '64' }],
  });
  const MERGE = (): unknown => ({ file_uuid: 'uuid-r9', file_info: 'file-info-r9', ttl: 86400 });

  it('共享分配器：流式已占 1 格 → 连续两条富媒体分别取 2、3（不重复用格）', async () => {
    const slots = new MsgSeqSlotAllocator();
    slots.occupy('msg-1', 1); // 模拟本轮流式回复先占格

    const { client, sent } = makeMediaClient({ prepare: PREPARE, merge: MERGE });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid, slots });

    await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE });
    await sender.send(TARGET, { bytes: randomBytes(64), filename: 'b.png', fileType: QQ_FILE_TYPE_IMAGE });

    expect(sent.map((s) => s.payload.msg_seq)).toEqual([2, 3]);
    expect(sent.map((s) => s.payload.msg_id)).toEqual(['msg-1', 'msg-1']);
  });

  it('未注入 slots 时自建分配器：同一 msg_id 连续两条同样不重复', async () => {
    const { client, sent } = makeMediaClient({ prepare: PREPARE, merge: MERGE });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE });
    await sender.send(TARGET, { bytes: randomBytes(64), filename: 'b.png', fileType: QQ_FILE_TYPE_IMAGE });

    expect(sent.map((s) => s.payload.msg_seq)).toEqual([1, 2]);
  });

  it('显式 msgSeq 优先，且不占用分配器的格', async () => {
    const slots = new MsgSeqSlotAllocator();
    const { client, sent } = makeMediaClient({ prepare: PREPARE, merge: MERGE });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid, slots });

    await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE }, { msgSeq: 5 });

    expect(sent[0]!.payload.msg_seq).toBe(5);
    expect([...slots.used('msg-1')]).toEqual([]);
  });

  it('target 无 msgId（主动消息）→ 既不带 msg_id 也不带 msg_seq', async () => {
    const slots = new MsgSeqSlotAllocator();
    const { client, sent } = makeMediaClient({ prepare: PREPARE, merge: MERGE });
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid, slots });

    await sender.send(
      { openid: TARGET.openid },
      { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE }
    );

    expect(sent[0]!.payload.msg_id).toBeUndefined();
    expect(sent[0]!.payload.msg_seq).toBeUndefined();
    expect([...slots.used('msg-1')]).toEqual([]);
  });
});

/**
 * 真机 2026-09-15（额度探针轮）抓到的一次残留：同一 `msg_id` 上**并发首条**偶发
 * `40054005 消息被去重`，随后同一文件单独重发即成功，其后 19 条无复现。
 * 兜底口径（用户拍板）：遇 `40054005` → **换一个新 `msg_seq`** 重试**一次**。
 * 新格按定义未被占用，故该重试安全；仅重试一次，不掩盖其它真实失败。
 */
describe('QqMediaSender · 40054005 换格重试一次', () => {
  const PREPARE = (): unknown => ({
    upload_id: 'up-retry',
    block_size: '10485760',
    parts: [{ index: 1, presigned_url: 'https://cos.example/p1', block_size: '64' }],
  });
  const MERGE = (): unknown => ({ file_uuid: 'uuid-rt', file_info: 'file-info-rt', ttl: 86400 });

  const dedup = (): QqApiResult => ({
    ok: false,
    status: 200,
    code: '40054005',
    message: '消息被去重，请检查请求msgseq',
    body: {},
  });
  const succeeded = (): QqApiResult => ({ ok: true, status: 200, code: 0, body: { id: 'out-ok' } });

  /** 按队列脚本化 `sendMessage` 返回值，并记录每次实际下发的 payload */
  function scriptedClient(results: QqApiResult[]): {
    client: QqMediaClient;
    sent: Array<{ openid: string; payload: Record<string, unknown> }>;
  } {
    const { client, sent } = makeMediaClient({ prepare: PREPARE, merge: MERGE });
    let call = 0;
    client.sendMessage = async (openid, payload) => {
      sent.push({ openid, payload: payload as unknown as Record<string, unknown> });
      const result = results[Math.min(call, results.length - 1)] ?? succeeded();
      call += 1;
      return result;
    };
    return { client, sent };
  }

  it('首条 40054005 → 换新 msg_seq 重试，第二条成功返回 ok', async () => {
    const slots = new MsgSeqSlotAllocator();
    const { client, sent } = scriptedClient([dedup(), succeeded()]);
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid, slots });

    const res = await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE });

    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload.msg_seq).toBe(1);
    expect(sent[1]!.payload.msg_seq).toBe(2); // 换格，绝不复用第一条
    expect(sent[1]!.payload.media).toEqual({ file_info: 'file-info-rt' }); // 复用上传结果，不重传
  });

  it('非 40054005 失败不重试（只发一次）', async () => {
    const { client, sent } = scriptedClient([
      { ok: false, status: 200, code: '850012', message: 'proxy error', body: {} },
    ]);
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const res = await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE });

    expect(res.ok).toBe(false);
    expect(String(res.code)).toBe('850012');
    expect(sent).toHaveLength(1);
  });

  it('重试后仍是 40054005 → 如实返回失败，且只重试一次', async () => {
    const { client, sent } = scriptedClient([dedup(), dedup(), succeeded()]);
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const res = await sender.send(TARGET, { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE });

    expect(res.ok).toBe(false);
    expect(String(res.code)).toBe('40054005');
    expect(sent).toHaveLength(2); // 不无限重试
  });

  it('target 无 msgId（主动消息）时无格可换 → 不重试', async () => {
    const { client, sent } = scriptedClient([dedup(), succeeded()]);
    const sender = new QqMediaSender({ client, logger: silentLogger, defaultOpenid: TARGET.openid });

    const res = await sender.send(
      { openid: TARGET.openid },
      { bytes: randomBytes(64), filename: 'a.png', fileType: QQ_FILE_TYPE_IMAGE }
    );

    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

// ══════════════════════════ 入站：E8 附件下载落盘 ═══════════════════════════

interface RecordedFetch {
  url: string;
}

function makeReceiveClient(responses: Record<string, { status?: number; bytes: Uint8Array; contentType?: string }>): {
  client: { fetchAttachment(url: string): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }> };
  fetches: RecordedFetch[];
} {
  const fetches: RecordedFetch[] = [];
  return {
    fetches,
    client: {
      async fetchAttachment(url: string) {
        fetches.push({ url });
        const spec = responses[url];
        if (!spec) return { ok: false, status: 404, bytes: new Uint8Array(), contentType: null };
        return {
          ok: (spec.status ?? 200) === 200,
          status: spec.status ?? 200,
          bytes: spec.bytes,
          contentType: spec.contentType ?? null,
        };
      },
    },
  };
}

describe('QqMediaReceiver · E8 入站附件', () => {
  let mediaDir: string;
  beforeEach(async () => {
    mediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-media-in-'));
  });
  afterEach(async () => {
    await fsp.rm(mediaDir, { recursive: true, force: true });
  });

  function receiver(client: { fetchAttachment(url: string): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }> }) {
    return new QqMediaReceiver({ client, logger: silentLogger, mediaDir });
  }

  it('E8-1/E8-3：file 类型保留真实文件名（经净化）且裸 GET 下载', async () => {
    const content = Buffer.from('{"a":1}');
    const url = 'https://grouptalk.c2c.qq.com/file/abc';
    const { client, fetches } = makeReceiveClient({ [url]: { bytes: content, contentType: 'application/octet-stream' } });
    const event = {
      id: 'in-1',
      attachments: [{ url, filename: '首尾帧_动态壁纸.json', size: content.length, content_type: 'file' }],
    };

    const media = await receiver(client).fetchAll(event, 'session-abc');
    expect(fetches.map((f) => f.url)).toEqual([url]);
    expect(media).toHaveLength(1);
    expect(media[0]!.fileName).toBe('首尾帧_动态壁纸.json');
    expect(media[0]!.bytes).toBe(content.length);
    expect(await fsp.readFile(media[0]!.filePath)).toEqual(content);
    expect(media[0]!.filePath).toContain('session-abc');
  });

  it('E8-5：文件名是外部输入，路径穿越被 basename + 净化拦下', async () => {
    const url = 'https://multimedia.example/f';
    const { client } = makeReceiveClient({ [url]: { bytes: Buffer.from('x'), contentType: 'application/octet-stream' } });
    const event = { id: 'in-2', attachments: [{ url, filename: '../../../../etc/passwd', content_type: 'file' }] };

    const media = await receiver(client).fetchAll(event, 'session-abc');
    expect(media).toHaveLength(1);
    const sessionDir = path.resolve(mediaDir, 'session-abc');
    expect(path.dirname(media[0]!.filePath)).toBe(sessionDir);
    expect(path.relative(sessionDir, media[0]!.filePath).startsWith('..')).toBe(false);
    expect(media[0]!.fileName.includes('/')).toBe(false);
    expect(media[0]!.fileName.includes('..')).toBe(false);
  });

  it('E8-3：图片（哈希名）保留读出扩展名并生成 data URL 注入载荷', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const url = 'https://multimedia.nt.qq.com.cn/img/95C5A03B7A.png';
    const { client } = makeReceiveClient({ [url]: { bytes: png, contentType: 'image/png' } });
    const event = {
      id: 'in-3',
      attachments: [{ url, filename: '95C521C9A03B7A.png', size: png.length, content_type: 'image/png', width: 1, height: 1 }],
    };

    const media = await receiver(client).fetchAll(event, 'session-img');
    expect(media).toHaveLength(1);
    expect(media[0]!.mimeType).toBe('image/png');
    expect(media[0]!.fileName.endsWith('.png')).toBe(true);
    expect(media[0]!.imageDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(media[0]!.imageDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });

  it('E8-4/E8-5：语音优先落 voice_wav_url 的 WAV，不信任原始 URL 的 content-type，并带上 ASR 文本', async () => {
    const amrUrl = 'https://multimedia.nt.qq.com.cn/voice/abc.amr';
    const wavUrl = 'https://qqbot.ugcimg.cn/voice/abc.wav';
    const wav = randomBytes(1024);
    const { client, fetches } = makeReceiveClient({
      // 响应头报 audio/mp3，实为 amr（E8-4）——绝不能用它命名/定 mime
      [amrUrl]: { bytes: randomBytes(64), contentType: 'audio/mp3' },
      [wavUrl]: { bytes: wav, contentType: 'audio/x-wav' },
    });
    const event = {
      id: 'in-4',
      attachments: [
        {
          url: amrUrl,
          filename: '5052e04a327e.amr',
          size: 64,
          content_type: 'voice',
          voice_wav_url: wavUrl,
          asr_refer_text: '一条测试语音。',
        },
      ],
    };

    const media = await receiver(client).fetchAll(event, 'session-voice');
    // 只应下载 wav（不落 amr）
    expect(fetches.map((f) => f.url)).toEqual([wavUrl]);
    expect(media).toHaveLength(1);
    expect(media[0]!.mimeType).toBe('audio/x-wav');
    expect(media[0]!.fileName.endsWith('.wav')).toBe(true);
    expect(media[0]!.asrText).toBe('一条测试语音。');
    expect(await fsp.readFile(media[0]!.filePath)).toEqual(Buffer.from(wav));
  });

  it('语音无 voice_wav_url 时退回原始 URL，但 mimeType 不以不可信的响应头为准', async () => {
    const amrUrl = 'https://multimedia.nt.qq.com.cn/voice/only.amr';
    const { client, fetches } = makeReceiveClient({ [amrUrl]: { bytes: randomBytes(32), contentType: 'audio/mp3' } });
    const event = {
      id: 'in-5',
      attachments: [{ url: amrUrl, filename: 'only.amr', content_type: 'voice', asr_refer_text: '你好' }],
    };
    const media = await receiver(client).fetchAll(event, 'session-voice2');
    expect(fetches.map((f) => f.url)).toEqual([amrUrl]);
    expect(media).toHaveLength(1);
    // 响应头 audio/mp3 不可信：按 voice 语义归一到 amr
    expect(media[0]!.mimeType).toBe('audio/amr');
    expect(media[0]!.fileName.endsWith('.amr')).toBe(true);
  });

  it('SSRF 守卫：内网/环回附件被拒绝下载（不发起请求）', async () => {
    const publicUrl = 'https://multimedia.example/ok.png';
    const { client, fetches } = makeReceiveClient({
      [publicUrl]: { bytes: randomBytes(8), contentType: 'image/png' },
    });
    const event = {
      id: 'in-6',
      attachments: [
        { url: 'http://127.0.0.1:8080/steal', filename: 'a.json', content_type: 'file' },
        { url: 'http://169.254.169.254/latest/meta-data', filename: 'b.json', content_type: 'file' },
        { url: 'file:///etc/passwd', filename: 'c.json', content_type: 'file' },
        { url: publicUrl, filename: 'ok.png', content_type: 'image/png' },
      ],
    };

    const media = await receiver(client).fetchAll(event, 'session-ssrf');
    expect(fetches.map((f) => f.url)).toEqual([publicUrl]);
    expect(media).toHaveLength(1);
    expect(validateSafeUrl('http://127.0.0.1/x').safe).toBe(false);
    expect(validateSafeUrl('https://multimedia.nt.qq.com.cn/x').safe).toBe(true);
  });

  it('describe() 汇总落盘路径 / 语音 ASR 文本，供注入模型上下文', async () => {
    const wavUrl = 'https://qqbot.ugcimg.cn/voice/abc.wav';
    const { client } = makeReceiveClient({ [wavUrl]: { bytes: randomBytes(16), contentType: 'audio/x-wav' } });
    const event = {
      id: 'in-7',
      attachments: [{ url: wavUrl, filename: 'abc.wav', content_type: 'voice', voice_wav_url: wavUrl, asr_refer_text: '语音内容' }],
    };
    const media = await receiver(client).fetchAll(event, 'session-desc');
    const text = receiver(client).describe(media);
    expect(text).toContain(media[0]!.filePath);
    expect(text).toContain('语音内容');
    // D51：附件说明文案已收敛到集中表（`[附件 n/total] 类型：文件名（字节数，MIME）已保存到 路径`）
    expect(text).toContain('[附件 1/1] 语音：abc.wav（16 字节，audio/x-wav）已保存到 ');
  });

  it('无 attachments → 返回空数组', async () => {
    const { client } = makeReceiveClient({});
    await expect(receiver(client).fetchAll({ id: 'in-8' }, 's')).resolves.toEqual([]);
  });
});

// ══════════════════════════ agent 工具注册 ═══════════════════════════

describe('registerAgentTools · send_file / send_image', () => {
  interface RegisteredTool {
    name: string;
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>;
    output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    parameters: Record<string, unknown>;
  }

  function makeFakeTools(): { definitions: RegisteredTool[]; service: { register(def: RegisteredTool): () => void } } {
    const definitions: RegisteredTool[] = [];
    let unregistered = 0;
    return {
      definitions,
      service: {
        register(def: RegisteredTool) {
          definitions.push(def);
          return () => {
            unregistered += 1;
          };
        },
      },
    };
  }

  function makeFakeMediaSender(): { sender: MediaSender; calls: Array<{ target: OutboundTarget; input: { path?: string; bytes?: Uint8Array; filename: string; fileType?: number } }> } {
    const calls: Array<{ target: OutboundTarget; input: { path?: string; bytes?: Uint8Array; filename: string; fileType?: number } }> = [];
    return {
      calls,
      sender: {
        async upload() {
          return { file_info: 'file-info-tool' };
        },
        async send(target, input) {
          calls.push({ target, input });
          return { ok: true, status: 200, code: 0, body: { id: 'tool-msg' } };
        },
      },
    };
  }

  it('tools 服务已就绪时立即注册 send_file / send_image', () => {
    const fakeTools = makeFakeTools();
    const media = makeFakeMediaSender();
    const ctx = {
      get: (name: string) => (name === 'tools' ? fakeTools.service : undefined),
      inject: () => undefined,
    } as unknown as Context;

    const dispose = registerAgentTools(ctx, { media: media.sender, resolveTarget: () => TARGET, logger: silentLogger });
    expect(fakeTools.definitions.map((d) => d.name)).toEqual(['send_file', 'send_image']);
    dispose();
  });

  it('tools 服务尚未就绪时经 ctx.inject 延迟注册（不静默丢工具）', () => {
    const fakeTools = makeFakeTools();
    const media = makeFakeMediaSender();
    const injected: Array<() => void> = [];
    const ctx = {
      get: () => undefined,
      inject: (_deps: string[], cb: () => void) => {
        injected.push(cb);
        return undefined;
      },
    } as unknown as Context;

    registerAgentTools(ctx, { media: media.sender, resolveTarget: () => TARGET, logger: silentLogger });
    expect(fakeTools.definitions).toHaveLength(0);
    expect(injected).toHaveLength(1);

    // 服务就绪后回调触发
    (ctx as unknown as { get: (n: string) => unknown }).get = (name: string) =>
      name === 'tools' ? fakeTools.service : undefined;
    injected[0]!();
    expect(fakeTools.definitions.map((d) => d.name)).toEqual(['send_file', 'send_image']);
  });

  it('send_image 映射 file_type=1；send_file 映射 file_type=4；均走 MediaSender.send', async () => {
    const fakeTools = makeFakeTools();
    const media = makeFakeMediaSender();
    const ctx = {
      get: (name: string) => (name === 'tools' ? fakeTools.service : undefined),
      inject: () => undefined,
    } as unknown as Context;
    registerAgentTools(ctx, { media: media.sender, resolveTarget: () => TARGET, logger: silentLogger });

    const image = fakeTools.definitions.find((d) => d.name === 'send_image')!;
    const file = fakeTools.definitions.find((d) => d.name === 'send_file')!;

    const imageResult = await image.execute({ file_path: '/tmp/a.png' }, { agent: { session: { id: 's-1' } } });
    const fileResult = await file.execute({ file_path: '/tmp/b.zip', file_name: 'b.zip' }, { agent: { session: { id: 's-1' } } });

    expect(media.calls[0]!.target).toEqual(TARGET);
    expect(media.calls[0]!.input.fileType).toBe(QQ_FILE_TYPE_IMAGE);
    expect(media.calls[0]!.input.path).toBe('/tmp/a.png');
    expect(media.calls[1]!.input.fileType).toBe(QQ_FILE_TYPE_FILE);
    expect(imageResult).toMatchObject({ success: true });
    expect(fileResult).toMatchObject({ success: true });
  });

  it('缺少 file_path 或无法解析目标时不静默成功', async () => {
    const fakeTools = makeFakeTools();
    const media = makeFakeMediaSender();
    const ctx = {
      get: (name: string) => (name === 'tools' ? fakeTools.service : undefined),
      inject: () => undefined,
    } as unknown as Context;
    registerAgentTools(ctx, { media: media.sender, resolveTarget: () => undefined, logger: silentLogger });

    const image = fakeTools.definitions.find((d) => d.name === 'send_image')!;
    await expect(image.execute({}, {})).resolves.toMatchObject({ success: false });
    await expect(image.execute({ file_path: '/tmp/a.png' }, {})).resolves.toMatchObject({ success: false });
    expect(media.calls).toHaveLength(0);
  });
});