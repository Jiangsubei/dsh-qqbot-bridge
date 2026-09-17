#!/usr/bin/env tsx
/**
 * 探针 E3：QQ 侧**真实长度上限**实测（单条消息 / 单条流累积 / 单次请求 payload）
 *
 * 触发背景（2026-09-16 真机缺陷）：
 *   一条 6118 码点的 agent 回复在 QQ 只收到前 **4000 码点**（截断点逐字吻合 `toQqMarkdown()`
 *   的 `QQ_MARKDOWN_MAX_CHARS = 4000`），且**无报错、无回退**。该 4000 是【推断】值：
 *   - 【文档明写】`Markdown 消息` 页 `content` 字段**通篇无长度上限**；
 *   - 【文档明写】`流式发送单聊消息` 页错误码只有 `40007/50001/50002`，**无长度错误码**；
 *   - 【文档明写】`发送单聊消息` 页错误码表**有** `40054007 消息长度超限` / `40054018 消息过长或异常`，
 *     但**未给出阈值**；
 *   - 【实测 E5】2200 字符单条 markdown 未拒（`docs/调研纪要-第一期探针结论.md` §E5）；
 *   - 【实测 E2-4】`remain_msg_len` 在 696 字符流下恒为 0。
 *   ⇒ 真实阈值至今未知（E3 长期挂在 `docs/方向总纲-*.md` §补测清单）。
 *
 * 设计要点：
 *  - ⚠ **用户口径（2026-09-16，最高优先）**：**不采信腾讯官方文档**——"已经被腾讯文档骗过很多回了，
 *    一切实测为准"。文档在本探针里只用于**挑待测区间**，全部结论一律以**实发响应**为准；
 *    凡引文档处均显式标注「未采信」。本项目已有两次同类更正（E5 推翻"必须降级"预设、
 *    E2 推翻"额度按 msg_id 计"预设），此教训已沉淀到 `docs/`。
 *  - **全部走主动消息（无 `msg_id`）**，无需人工配合，且实测可连续下发
 *    （`logs/probe/ACTIVE-MESSAGE-*.summary.json`：A1/A3 连发 3 条全 200）。
 *    「被动回复每消息最多 4 次」为【文档明写·未采信】口径，故不以它为前提，另设 E3-E 反向实测。
 *  - **短消息对照（E3-CTRL）**：第一次长度失败后立刻补发一条**短消息**。若对照成功 ⇒ 失败与长度相关；
 *    若对照也失败且 `code=40034100` ⇒ 是主动消息频控，结论应判为**不可信**。这是本次探针的
 *    混淆控制，避免把额度耗尽误判成"长度上限"。
 *  - 填充一律用 CJK `填`（1 字符 / 3 字节 UTF-8），因此若阈值落在 4 位数即可判定**按字符**计
 *    （按字节的话 2200 字符=6600 字节早就该被拒，E5 已证未拒）。
 *  - 主动消息频控【文档明写】单关系 20/qpm ⇒ 发送间隔 3.5s（≈17 条/分钟内），并落盘每条的时间戳。
 *
 * 产物：`logs/probe/E3-LENGTH-<ts>.jsonl`（原始请求/响应，**不入库**）
 *       + `.summary.json`（可入库结论摘要）
 *
 * 用法：
 *   pnpm probe:e3                       # 全量 A→B→C→D（A 至多到 24000 字符）
 *   pnpm probe:e3 -- --dry-run          # 只验证凭据与目标解析
 *   pnpm probe:e3 -- --cases=A          # 只跑单条消息上限
 *   pnpm probe:e3 -- --max=40000        # 放宽几何点上界（会多几条长消息）
 *   pnpm probe:e3 -- --msg-id=ROBOT1.0_xxx --msg-seq-base=1   # 改用被动回复（流式不支持主动时）
 *   pnpm probe:e3 -- --cases=E --msg-id=ROBOT1.0_xxx          # 反向实测"每 msg_id 最多 4 次"文档口径
 *   pnpm probe:e3 -- --cases=C,D,E --wait-inbound             # 用**全新入站** msg_id 跑被动段（消历史去重污染）
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { QQProbeClient, resolveCredentials, type QQApiResult } from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `E3-LENGTH-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `E3-LENGTH-${stamp}.summary.json`);

const argv = process.argv.slice(2);
const args = new Map<string, string>();
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const dryRun = args.has('dry-run');
const maxPoint = Math.max(8000, Number.parseInt(args.get('max') ?? '24000', 10) || 24000);
/** 几何点起点（用于跳过已测区间，避免重复刷屏/浪费主动消息额度） */
const minPoint = Math.max(1, Number.parseInt(args.get('min') ?? '4000', 10) || 4000);
/** 单条消息内容类型：2=markdown（默认）0=纯文本——用于对照两条通道是否同限 */
const msgType = Number.parseInt(args.get('msg-type') ?? '2', 10) === 0 ? 0 : 2;
const casesFilter = (args.get('cases') ?? 'A,B,C,D')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const shouldRun = (id: string): boolean => casesFilter.includes(id);
/** 被动回复模式：显式给一个**真实入站** msg_id（主动流式若不支持时的兜底） */
let passiveMsgId = args.get('msg-id');
/**
 * `--wait-inbound`：连 WS 等一条**全新入站**消息，用它的 msg_id 做被动回复。
 * 为什么必需：`(msg_id, msg_seq)` 有**跨天残留的去重记账**（实测：2026-09-15 的 E2 用过的
 * seq 1–5，在 2026-09-16 复用同一 msg_id 时仍被判 `40054005 消息被去重`），复用旧 msg_id
 * 会让 C/D/E 段全部失真。用全新 msg_id 才能得到干净结论。
 */
const waitInbound = args.has('wait-inbound');
/** 只取 A 段的夹逼区间（几何点触限后不做二分），用于"知道下限就够"的场景，避免刷屏 */
const bracketOnly = args.has('bracket-only');
let msgSeqBase = Number.parseInt(args.get('msg-seq-base') ?? '1', 10) || 1;

type Case = 'E3-A' | 'E3-B' | 'E3-C' | 'E3-D' | 'E3-E' | 'E3-G' | 'E3-CTRL';
interface Rec {
  ts: number;
  case: Case;
  step: string;
  payload: unknown;
}
const raw: Rec[] = [];
function rec(r: Omit<Rec, 'ts'>): void {
  raw.push({ ts: Date.now(), ...r });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 从持久化控制目标域里取「当前受控会话」的 openid（与 probe-active-message.ts 同法） */
function discoverOpenid(): string | undefined {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(dshHome, 'storages', 'qqbot_control_target.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      tables?: { targets?: Record<string, { sessionId?: string | null }> };
    };
    for (const [openid, record] of Object.entries(parsed.tables?.targets ?? {})) {
      if (record && typeof record.sessionId === 'string' && record.sessionId.length > 0) return openid;
    }
  } catch {
    /* 解析失败按未找到处理 */
  }
  return undefined;
}

/** 生成**恰好** `totalChars` 码点的正文（CJK 填充，1 字符 / 3 字节） */
function padded(totalChars: number, tag: string): string {
  const head = `【E3 ${tag}】`;
  const tail = '｜结束';
  const filler = Math.max(0, totalChars - head.length - tail.length);
  return `${head}${'填'.repeat(filler)}${tail}`;
}

const codePoints = (s: string): number => Array.from(s).length;

interface Attempt {
  step: string;
  chars: number;
  bytes: number;
  ok: boolean;
  status: number;
  code?: string | number;
  message?: string;
  id?: string;
  remainMsgLen?: number | null;
  at: string;
}
function summarize(res: QQApiResult, step: string, chars: number, bytes: number): Attempt {
  const body = res.body as { id?: unknown; remain_msg_len?: unknown } | null;
  return {
    step,
    chars,
    bytes,
    ok: res.ok,
    status: res.status,
    ...(res.code === undefined ? {} : { code: res.code }),
    ...(res.message === undefined ? {} : { message: res.message }),
    ...(typeof body?.id === 'string' ? { id: body.id } : {}),
    ...(body && 'remain_msg_len' in body ? { remainMsgLen: (body.remain_msg_len as number) ?? null } : {}),
    at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const credentials = resolveCredentials();
  const client = new QQProbeClient({ credentials, logger: (m) => console.log(m) });

  await client.getAccessToken(); // 鉴权自检（不发消息）
  let openid = args.get('openid') || discoverOpenid();

  if (dryRun) {
    if (!openid) {
      console.error('未找到目标 openid（可用 --openid= 显式指定）');
      process.exit(2);
    }
    console.log(`[dry-run] 凭据与目标解析均正常（openid=${openid.slice(0, 8)}…）；未发送任何消息。`);
    return;
  }

  if (waitInbound) {
    const ready = new Promise<void>((resolve) => {
      client.onReady = () => resolve();
    });
    await client.start();
    await Promise.race([ready, sleep(45_000)]);
    console.log('[E3] 机器人已上线。▶ 请现在给机器人发**任意一条** QQ 消息（探针要拿它的 msg_id 做被动回复）');
    const event = await new Promise<{ id?: unknown; author?: { user_openid?: unknown } }>((resolve) => {
      client.onC2CMessage = (e: unknown) => resolve(e as { id?: unknown; author?: { user_openid?: unknown } });
    });
    const inboundId = event?.id;
    const inboundOpenid = event?.author?.user_openid;
    if (typeof inboundId !== 'string' || typeof inboundOpenid !== 'string' || !inboundId) {
      console.error('入站事件缺少 id/openid，无法继续');
      process.exit(3);
    }
    passiveMsgId = inboundId;
    openid = inboundOpenid;
    console.log(`[E3] 已捕获**全新**入站 msg_id=${passiveMsgId.slice(0, 14)}…（msg_seq 从 1 开始，无历史污染）`);
  }

  if (!openid) {
    console.error('未找到目标 openid（可用 --openid= 显式指定；或确认 qqbot_control_target.json 存在受控会话）');
    process.exit(2);
  }
  const mode = passiveMsgId ? `被动回复（msg_id=${passiveMsgId.slice(0, 14)}…）` : '主动消息（无 msg_id）';
  console.log(`[E3] 目标 openid=${openid.slice(0, 8)}…${openid.slice(-4)}  模式=${mode}  几何上界=${maxPoint}`);

  // 主动消息频控【文档明写·未采信】20/qpm ⇒ 3.5s 间隔；被动回复则无需限速
  const gapMs = passiveMsgId ? 300 : 3500;

  const runA = async (): Promise<void> => {
    // ── E3-A：单条普通 markdown 消息（msg_type=2）的真实上限 ──
    const geometry: number[] = [];
    for (let n = minPoint; n <= maxPoint; n *= 2) geometry.push(n);
    let lastOk = 0;
    let firstFail: number | null = null;
    const attempts: Attempt[] = [];
    /** 短消息对照的落盘（用数组而非 `let`：闭包内赋值不会刷新 TS 的窄化，见 typecheck 报错史） */
    const controls: Attempt[] = [];

    const tryLen = async (len: number, tag: string): Promise<boolean> => {
      const content = padded(len, tag);
      const chars = codePoints(content);
      const payload: Record<string, unknown> =
        msgType === 0 ? { msg_type: 0, content } : { msg_type: 2, markdown: { content } };
      if (passiveMsgId) {
        payload.msg_id = passiveMsgId;
        payload.msg_seq = msgSeqBase++;
      }
      const redacted =
        msgType === 0
          ? { ...payload, content: `<${chars}码点已省略>` }
          : { ...payload, markdown: { content: `<${chars}码点已省略>` } };
      rec({ case: 'E3-A', step: `req ${tag}`, payload: redacted });
      const res = await client.sendMessage(openid!, payload);
      const a = summarize(res, tag, chars, Buffer.byteLength(content, 'utf8'));
      attempts.push(a);
      rec({ case: 'E3-A', step: `res ${tag}`, payload: a });
      console.log(
        `  A msg_type=${msgType} ${tag} chars=${chars} → ${res.ok ? '✅' : '❌'} status=${res.status} code=${String(res.code ?? '')} ${res.message ?? ''}`
      );
      return res.ok;
    };

    /** 混淆控制：一条短消息。长消息失败后它若成功 ⇒ 失败与长度相关而非额度 */
    const control = async (why: string): Promise<Attempt> => {
      const payload: Record<string, unknown> = {
        msg_type: 0,
        content: `【E3 对照】短消息仍可发（用于排除"额度耗尽"混淆：${why}）`,
      };
      if (passiveMsgId) {
        payload.msg_id = passiveMsgId;
        payload.msg_seq = msgSeqBase++;
      }
      rec({ case: 'E3-CTRL', step: 'req', payload });
      const res = await client.sendMessage(openid!, payload);
      const attempt = summarize(res, 'CTRL', 0, 0);
      controls.push(attempt);
      rec({ case: 'E3-CTRL', step: 'res', payload: attempt });
      console.log(
        `  对照短消息 → ${res.ok ? '✅ 可发' : '❌ 不可发'} code=${String(res.code ?? '')} ${res.message ?? ''}`
      );
      return attempt;
    };

    for (const len of geometry) {
      const ok = await tryLen(len, `A-几何 L=${len}`);
      if (ok) {
        lastOk = len;
      } else {
        firstFail = len;
        await control(`几何点 ${len} 失败`);
        break;
      }
      await sleep(gapMs);
    }
    // 未触限 ⇒ 不再二分：对修复决策而言"远高于 4000"的下界已经足够，避免刷屏
    while (!bracketOnly && firstFail !== null && firstFail - lastOk > 64) {
      await sleep(gapMs);
      const mid = lastOk + Math.floor((firstFail - lastOk) / 2);
      const ok = await tryLen(mid, `A-二分 L=${mid}`);
      if (ok) lastOk = mid;
      else firstFail = mid;
    }

    console.log(
      `[E3-A] 结论：最大成功=${lastOk}${firstFail === null ? `（未触限，下界）` : `，最小失败=${firstFail}`}`
    );
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-A-${stamp}.summary.json`),
      JSON.stringify(
        {
          probe: 'E3-A',
          mode,
          msgType,
          attempts,
          controlAfterFail: controls.at(-1) ?? null,
          conclusion: {
            maxOkChars: lastOk,
            minFailChars: firstFail,
            bracket: firstFail === null ? `≥${lastOk}（未触限）` : `(${lastOk}, ${firstFail}]`,
            failureCode: attempts.find((a) => !a.ok)?.code ?? null,
            /** true ⇒ 短消息也发不出去了，本次 A 的长度结论**不可信**（额度/频控混淆） */
            quotaConfound: controls.length === 0 ? null : !(controls.at(-1)?.ok ?? true),
            counting: 'CJK 填充（1 字符 = 3 字节）；2200 字符=6600 字节已被 E5 证明未拒 ⇒ 阈值若为 4 位数则按字符计',
          },
        },
        null,
        2
      ),
      'utf8'
    );
  };

  // ── 流式：优先主动流式（无 msg_id） ──
  const streamCall = async (
    caseId: Case,
    step: string,
    payloadBase: Record<string, unknown>,
    seq: number | null
  ): Promise<QQApiResult> => {
    const payload: Record<string, unknown> = { ...payloadBase };
    if (passiveMsgId) {
      payload.msg_id = passiveMsgId;
      payload.msg_seq = seq ?? msgSeqBase++;
    }
    rec({ case: caseId, step: `req ${step}`, payload: { ...payload, content_raw: `<${codePoints(String(payload.content_raw ?? ''))}码点已省略>` } });
    const res = await client.sendStreamMessage(openid!, payload);
    return res;
  };

  const runB = async (): Promise<void> => {
    // ── E3-B：单条流能否承载 >4000 的**累积**正文（append 小增量；每片只发增量） ──
    const seq = passiveMsgId ? msgSeqBase++ : null;
    const deltaChars = 2000;
    const chunks = 10; // 累积 20000 码点
    const attempts: Attempt[] = [];
    let streamMsgId: string | undefined;
    let cum = 0;
    let supported = true;
    for (let i = 0; i < chunks; i++) {
      const delta = padded(deltaChars, `B#${i}`);
      cum += codePoints(delta);
      const res = await streamCall(
        'E3-B',
        `累积#${i} cum=${cum}`,
        {
          input_mode: 'append',
          input_state: 1,
          index: i,
          content_type: 'markdown',
          content_raw: delta,
          ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
        },
        seq
      );
      const body = res.body as { id?: unknown; remain_msg_len?: unknown } | null;
      if (!streamMsgId && typeof body?.id === 'string') streamMsgId = body.id;
      const a = summarize(res, `B#${i}`, codePoints(delta), Buffer.byteLength(delta, 'utf8'));
      attempts.push(a);
      rec({ case: 'E3-B', step: `res 累积#${i}`, payload: a });
      console.log(
        `  B#${i} cum=${cum} remain_msg_len=${String(body?.remain_msg_len ?? 'n/a')} → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')} ${res.message ?? ''}`
      );
      if (!res.ok) {
        if (i === 0) supported = false; // 首片就失败 ⇒ 主动流式本身不被支持
        break;
      }
      await sleep(800);
    }
    if (supported && attempts.every((a) => a.ok)) {
      // 收尾片（state=10，非空）
      const tail = padded(40, 'B-收尾');
      const res = await streamCall(
        'E3-B',
        `收尾 cum=${cum}`,
        {
          input_mode: 'append',
          input_state: 10,
          index: attempts.length,
          content_type: 'markdown',
          content_raw: tail,
          ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
        },
        seq
      );
      attempts.push(summarize(res, 'B-收尾', codePoints(tail), Buffer.byteLength(tail, 'utf8')));
      console.log(`  B 收尾(state=10) → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')}`);
    }
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-B-${stamp}.summary.json`),
      JSON.stringify(
        {
          probe: 'E3-B',
          mode,
          deltaChars,
          cumulativeChars: cum,
          activeStreamSupported: supported,
          attempts,
          conclusion: {
            cumulativeOkChars: attempts.filter((a) => a.ok).length === attempts.length ? cum : null,
            firstFail: attempts.find((a) => !a.ok) ?? null,
            remainMsgLenSeries: attempts.map((a) => a.remainMsgLen ?? null),
          },
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const runC = async (): Promise<void> => {
    // ─ E3-C：**单次请求** `content_raw` 上限（新流首片直接给大负载） ──
    const results: Attempt[] = [];
    for (const len of [4000, 8000].filter((n) => n <= maxPoint)) {
      const seq = passiveMsgId ? msgSeqBase++ : null;
      const content = padded(len, `C 首片 L=${len}`);
      const res = await streamCall(
        'E3-C',
        `首片 L=${len}`,
        { input_mode: 'append', input_state: 1, index: 0, content_type: 'markdown', content_raw: content },
        seq
      );
      const body = res.body as { id?: unknown } | null;
      const a = summarize(res, `C-首片 L=${len}`, codePoints(content), Buffer.byteLength(content, 'utf8'));
      results.push(a);
      rec({ case: 'E3-C', step: `res 首片 L=${len}`, payload: a });
      console.log(`  C 首片 L=${len} → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')} ${res.message ?? ''}`);
      if (res.ok && typeof body?.id === 'string') {
        const close = await streamCall(
          'E3-C',
          `收尾 L=${len}`,
          { input_mode: 'append', input_state: 10, index: 1, content_type: 'markdown', content_raw: '｜完', stream_msg_id: body.id },
          seq
        );
        rec({ case: 'E3-C', step: `res 收尾 L=${len}`, payload: summarize(close, `C-收尾 L=${len}`, 2, 6) });
      }
      if (!res.ok) break;
      await sleep(800);
    }
    console.log(`[E3-C] 结论：单次 payload 最大成功=${results.filter((r) => r.ok).map((r) => r.chars).pop() ?? 0}`);
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-C-${stamp}.summary.json`),
      JSON.stringify(
        {
          probe: 'E3-C',
          mode,
          attempts: results,
          conclusion: {
            maxOkChars: results.filter((r) => r.ok).map((r) => r.chars).pop() ?? 0,
            firstFail: results.find((r) => !r.ok) ?? null,
          },
          at: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const runD = async (): Promise<void> => {
    // ── E3-D：空 `content_raw` 片是否被接受（生产路径当前会发空末片：`src/qq/stream.ts:196-198`） ──
    const seq = passiveMsgId ? msgSeqBase++ : null;
    const plan: [string, string, number, number][] = [
      ['片1 非空(state=1)', 'A', 1, 0],
      ['片2 空串(state=1)', '', 1, 1],
      ['片3 非空(state=10)', 'B', 10, 2],
    ];
    let streamMsgId: string | undefined;
    const results: Attempt[] = [];
    for (const [label, content, state, index] of plan) {
      const res = await streamCall(
        'E3-D',
        label,
        {
          input_mode: 'append',
          input_state: state,
          index,
          content_type: 'markdown',
          content_raw: content,
          ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
        },
        seq
      );
      const body = res.body as { id?: unknown } | null;
      if (!streamMsgId && typeof body?.id === 'string') streamMsgId = body.id;
      const a = summarize(res, label, codePoints(content), Buffer.byteLength(content, 'utf8'));
      results.push(a);
      rec({ case: 'E3-D', step: `res ${label}`, payload: a });
      console.log(`  D ${label} → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')} ${res.message ?? ''}`);
      await sleep(500);
    }
    console.log(`[E3-D] 结论：空片被接受=${results[1]?.ok ?? null}`);
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-D-${stamp}.summary.json`),
      JSON.stringify(
        {
          probe: 'E3-D',
          mode,
          attempts: results,
          conclusion: {
            emptyChunkAccepted: results[1]?.ok ?? null,
            nonEmptyChunksOk: [results[0]?.ok ?? null, results[2]?.ok ?? null],
          },
          at: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const runE = async (): Promise<void> => {
    // ─ E3-E：实测「被动回复每个 msg_id 最多 4 次」这条【文档明写】口径的真伪 ──
    //   用户口径（2026-09-16）：**不采信腾讯文档**，文档只用于挑待测区间；本用例需一条真实入站 msg_id。
    if (!passiveMsgId) {
      console.log('[E3-E] 跳过：未提供 --msg-id（该用例必须用**真实入站** msg_id 做被动回复）');
      return;
    }
    const attempts: Attempt[] = [];
    for (let i = 0; i < 6; i++) {
      const content = `【E3-E 第${i + 1}条】被动回复次数上限实测（文档口径称每 msg_id 最多 4 次，未采信）。`;
      const payload: Record<string, unknown> = {
        msg_type: 0,
        content,
        msg_id: passiveMsgId,
        msg_seq: msgSeqBase++,
      };
      rec({ case: 'E3-E', step: `req #${i + 1}`, payload });
      const res = await client.sendMessage(openid!, payload);
      const a = summarize(res, `E#${i + 1}`, codePoints(content), Buffer.byteLength(content, 'utf8'));
      attempts.push(a);
      rec({ case: 'E3-E', step: `res #${i + 1}`, payload: a });
      console.log(`  E#${i + 1} → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')} ${res.message ?? ''}`);
    }
    const okCount = attempts.filter((a) => a.ok).length;
    console.log(`[E3-E] 结论：同一 msg_id 连发 6 条，成功 ${okCount} 条`);
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-E-${stamp}.summary.json`),
      JSON.stringify(
        {
          probe: 'E3-E',
          claim: '【文档明写·未采信】发送单聊消息页："被动消息有效时间 60 分钟，每个消息最多回复 4 次"',
          sent: attempts.length,
          okCount,
          firstFail: attempts.find((a) => !a.ok) ?? null,
          attempts,
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const runG = async (): Promise<void> => {
    // ─ E3-G：单次流式 `content_raw` 上限（二分夹逼）+ 字符/字节判别 ──
    //   C 已实测：4000 ✅ / 8000 ❌（40054018）。此处夹逼出阈值；再用 `--filler=ascii` 复跑一遍对照
    //   （CJK 1 字符 = 3 字节，ASCII 1 字符 = 1 字节）：
    //     - 两个阈值**字符数相近** ⇒ 按**字符**计；
    //     - ASCII 阈值 ≈ 3× CJK 阈值 ⇒ 按**字节**计。
    if (!passiveMsgId) {
      console.log('[E3-G] 跳过：需要 --msg-id= 或 --wait-inbound（流式必须带 msg_id，实测主动流式返回 50015001）');
      return;
    }
    const cjk = args.get('filler') !== 'ascii';
    let lo = Number.parseInt(args.get('lo') ?? '4000', 10) || 4000;
    let hi = Number.parseInt(args.get('hi') ?? '8000', 10) || 8000;
    const attempts: Attempt[] = [];
    const tryFirst = async (chars: number, tag: string): Promise<boolean> => {
      const head = `【E3 ${tag}】`;
      const content = `${head}${(cjk ? '填' : 'a').repeat(Math.max(0, chars - head.length))}`;
      const seq = msgSeqBase++;
      const res = await streamCall(
        'E3-G',
        `首片 ${tag} chars=${chars}`,
        { input_mode: 'append', input_state: 1, index: 0, content_type: 'markdown', content_raw: content },
        seq
      );
      const a = summarize(res, tag, codePoints(content), Buffer.byteLength(content, 'utf8'));
      attempts.push(a);
      console.log(
        `  G filler=${cjk ? 'cjk' : 'ascii'} ${tag} chars=${a.chars} bytes=${a.bytes} → ${res.ok ? '✅' : '❌'} code=${String(res.code ?? '')} ${res.message ?? ''}`
      );
      return res.ok;
    };
    while (hi - lo > 32) {
      await sleep(400);
      const mid = lo + Math.floor((hi - lo) / 2);
      if (await tryFirst(mid, `G-二分`)) lo = mid;
      else hi = mid;
    }
    const filler = cjk ? 'cjk' : 'ascii';
    console.log(`[E3-G] filler=${filler}：最大成功=${lo} 字符，最小失败=${hi} 字符（夹逼区间 ${hi - lo}）`);
    fs.writeFileSync(
      path.join(LOG_DIR, `E3-G-${stamp}-${filler}.summary.json`),
      JSON.stringify(
        { probe: 'E3-G', filler, maxOkChars: lo, minFailChars: hi, attempts, at: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    );
  };

  if (shouldRun('A')) await runA();
  if (shouldRun('B')) await runB();
  if (shouldRun('C')) await runC();
  if (shouldRun('D')) await runD();
  if (shouldRun('E')) await runE();
  if (shouldRun('G')) await runG();

  const summary = {
    probe: 'E3',
    ranAt: new Date().toISOString(),
    casesRun: casesFilter,
    mode,
    openidShort: `${openid.slice(0, 8)}…${openid.slice(-4)}`,
    geometryUpperBound: maxPoint,
    rawPath: RAW_PATH,
    notes: [
      '⚠ 用户口径：不采信腾讯官方文档，一切以实发响应为准；以下文档条目仅作待测区间来源。',
      '【文档明写·未采信】发送单聊消息页列有 40054007 消息长度超限 / 40054018 消息过长或异常，但未给阈值。',
      '【文档明写·未采信】Markdown 消息页 content 字段无长度上限；流式页错误码无长度类目。',
      '【文档明写·未采信】"被动回复每消息最多 4 次" → 由 E3-E 用真实入站 msg_id 反向实测（默认走主动消息）。',
      'E3-CTRL 短消息对照用于排除"主动消息额度耗尽"混淆；若对照也失败，A 结论不可信。',
    ],
  };
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n原始产物：${RAW_PATH}`);
  console.log(`结论摘要：${SUMMARY_PATH}`);
  if (waitInbound) client.stop();
}

main().catch((err: unknown) => {
  console.error(`探针异常：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});