#!/usr/bin/env tsx
/**
 * 探针 ACTIVE-MESSAGE：**主动消息能力 + 被动回复时间窗口**真机实测
 *
 * 触发背景：审批 / 提问卡片要投递到 QQ，但 `src/index.ts` 的 `sendText` 走
 * `reply({ openid }, text)`（**无 msg_id**）⇒ 实际是主动消息；而方向总纲 D6 明确
 * 「只回 QQ 发起的 turn；**不做主动消息推送**」。需要先拿到真机证据才能决定投递方案。
 *
 * 用例（**无需人工配合**，全部为服务端可判定的发信）：
 *   A1  无 `msg_id` 的**主动消息** → 能否发送、失败码是什么（如 40034xxx 额度/权限）
 *   A2  使用**历史入站 msg_id**（取自 `logs/probe/qq-*.jsonl`，本次约 4.4 小时前）做**被动回复**
 *       → 是否 `40034128 被动回复时间或次数超限`（验证时间窗口）
 *   A3  A1 成功后间隔补发 2 条主动消息 → 观察频控 / 额度
 *
 * 证据等级：本探针产物为【实测】；结论必须落 `docs/`（AGENTS §1.1）。
 *
 * 产物：`logs/probe/ACTIVE-MESSAGE-<ts>.jsonl`（原始请求/响应，**不入库**）
 *       + `.summary.json`（可入库的结论摘要）
 *
 * 用法：
 *   pnpm tsx scripts/probe-active-message.ts                 # 全量 A1→A2→A3
 *   pnpm tsx scripts/probe-active-message.ts --dry-run       # 只验证凭据（取 token）
 *   pnpm tsx scripts/probe-active-message.ts --count=2       # 控制 A3 条数
 *   pnpm tsx scripts/probe-active-message.ts --openid=xxx --msg-id=ROBOT1.0_xxx
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { QQProbeClient, resolveCredentials, type QQApiResult } from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `ACTIVE-MESSAGE-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `ACTIVE-MESSAGE-${stamp}.summary.json`);

const argv = process.argv.slice(2);
const args = new Map<string, string>();
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const dryRun = args.has('dry-run');
const extraActive = Math.max(0, Math.min(5, Number.parseInt(args.get('count') ?? '3', 10) - 1 || 0));
/** 用例过滤（如 `--cases=A2`），避免为了重测单条用例而重复发送其它消息 */
const casesFilter = (args.get('cases') ?? 'A1,A2,A3')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const runCase = (id: string): boolean => casesFilter.includes(id);

interface Rec {
  ts: number;
  case: 'A1' | 'A2' | 'A3';
  step: 'req' | 'res' | 'note';
  payload: unknown;
}
const raw: Rec[] = [];
function rec(r: Omit<Rec, 'ts'>): void {
  raw.push({ ts: Date.now(), ...r });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 从持久化控制目标域里取「当前受控会话」的 openid（避免手工传参） */
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

/**
 * 从历史探针产物里取最近一个**真实入站** `msg_id`，用于测被动回复时间窗口。
 *
 * ⚠️ 首轮踩坑（已更正）：出站消息的响应体里也有 `id`（同样是 `ROBOT1.0_…` 格式），
 * 早期实现扫「任意名为 `id` 的字段」会抓到**出站 id** —— 那种 id 本来就不能做被动回复
 * （实测返回 `40034024 请求参数msg_id无效或越权`），会把结论误导向「时间窗口」。
 * 故此处**只接受** `kind === 'event'` 且带 `payload.author.user_openid` 的记录（即真正的
 * `C2C_MESSAGE_CREATE` 入站事件体）。
 */
function discoverStaleMsgId(): { id: string; ts: number; file: string; openid: string } | undefined {
  if (!fs.existsSync(LOG_DIR)) return undefined;
  let best: { id: string; ts: number; file: string; openid: string } | undefined;
  const files = fs.readdirSync(LOG_DIR).filter((n) => /^qq-.*\.jsonl$/.test(n)).sort();
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(LOG_DIR, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let record: { ts?: number; kind?: string; payload?: unknown };
      try {
        record = JSON.parse(line) as { ts?: number; kind?: string; payload?: unknown };
      } catch {
        continue;
      }
      if (record.kind !== 'event') continue; // 出站 res / 请求 req 一律不算入站
      const payload = record.payload as
        | { id?: unknown; author?: { user_openid?: unknown } }
        | undefined;
      const id = payload?.id;
      const openid = payload?.author?.user_openid;
      if (typeof id !== 'string' || !id.startsWith('ROBOT1.0')) continue;
      if (typeof openid !== 'string' || openid.length === 0) continue;
      const ts = typeof record.ts === 'number' ? record.ts : 0;
      if (!best || ts > best.ts) best = { id, ts, file, openid };
    }
  }
  return best;
}

interface CaseResult {
  case: string;
  label: string;
  ok: boolean;
  status: number;
  code?: string | number;
  message?: string;
  sentAt: string;
}

function summarize(result: QQApiResult, caseId: string, label: string): CaseResult {
  return {
    case: caseId,
    label,
    ok: result.ok,
    status: result.status,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.message === undefined ? {} : { message: result.message }),
    sentAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const credentials = resolveCredentials();
  const client = new QQProbeClient({ credentials, logger: (m) => console.log(m) });

  // 鉴权自检（不发消息）
  await client.getAccessToken();
  rec({ case: 'A1', step: 'note', payload: { stage: 'auth-ok' } });

  const openid = args.get('openid') || discoverOpenid();
  if (!openid) {
    console.error('未找到目标 openid（可用 --openid= 显式指定；或确认 qqbot_control_target.json 里存在受控会话）');
    process.exit(2);
  }
  const stale = args.get('msg-id')
    ? { id: args.get('msg-id')!, ts: 0, file: 'cli', openid: '' }
    : discoverStaleMsgId();
  const ageMinutes = stale && stale.ts > 0 ? Math.round((Date.now() - stale.ts) / 60000) : undefined;

  console.log(`目标 openid: ${openid.slice(0, 8)}…${openid.slice(-4)}（共 ${openid.length} 字符）`);
  console.log(
    `旧 msg_id: ${stale ? `${stale.id.slice(0, 14)}…${stale.id.slice(-4)}（${ageMinutes ?? '?'} 分钟前，来自 ${stale.file}）` : '未找到'}`
  );
  console.log(`A3 追加主动消息条数: ${extraActive}`);

  if (dryRun) {
    console.log('[dry-run] 凭据与目标解析均正常；未发送任何消息。');
    return;
  }

  const results: CaseResult[] = [];
  let a1: QQApiResult | undefined;

  // ── A1：主动消息（无 msg_id） ─
  if (runCase('A1')) {
    const a1Payload = {
      msg_type: 0,
      content: '【探针A1】主动消息（无 msg_id）——用于确认审批/提问卡片在无锚点时的兜底通道是否可用。',
    };
    rec({ case: 'A1', step: 'req', payload: a1Payload });
    a1 = await client.sendMessage(openid, a1Payload);
    rec({ case: 'A1', step: 'res', payload: a1 });
    results.push(summarize(a1, 'A1', '主动消息（无 msg_id）'));
    console.log(`A1 ${a1.ok ? '✅ 成功' : '❌ 失败'} status=${a1.status} code=${String(a1.code ?? '')} msg=${a1.message ?? ''}`);
  } else {
    console.log('A1 跳过（--cases 未包含）');
  }

  // ── A2：旧**入站** msg_id 被动回复（测时间窗口） ──
  if (runCase('A2') && stale) {
    const sameTarget = stale.openid === '' ? 'unknown' : stale.openid === openid;
    const a2Payload = {
      msg_type: 0,
      content: `【探针A2】使用 ${ageMinutes ?? '?'} 分钟前的旧入站 msg_id 做被动回复——验证被动回复时间窗口（预期可能 40034128）。`,
      msg_id: stale.id,
      msg_seq: 1,
    };
    rec({ case: 'A2', step: 'note', payload: { provenance: stale.file, ageMinutes, sameTarget } });
    rec({ case: 'A2', step: 'req', payload: a2Payload });
    const a2 = await client.sendMessage(openid, a2Payload);
    rec({ case: 'A2', step: 'res', payload: a2 });
    results.push(summarize(a2, 'A2', `旧入站 msg_id（${ageMinutes ?? '?'} 分钟前）被动回复`));
    console.log(
      `A2 ${a2.ok ? '✅ 成功' : '❌ 失败'} status=${a2.status} code=${String(a2.code ?? '')} msg=${a2.message ?? ''}` +
        `（来源 ${stale.file}，同目标=${sameTarget}）`
    );
  } else if (!runCase('A2')) {
    console.log('A2 跳过（--cases 未包含）');
  } else {
    console.log('A2 跳过：未找到历史**入站** msg_id');
  }

  // ── A3：主动消息连发（观察频控/额度） ──
  if (runCase('A3') && a1?.ok) {
    for (let i = 1; i <= extraActive; i++) {
      await sleep(1500);
      const payload = { msg_type: 0, content: `【探针A3-${i}】主动消息连发第 ${i + 1} 条——用于观察主动消息频控/额度。` };
      rec({ case: 'A3', step: 'req', payload });
      const res = await client.sendMessage(openid, payload);
      rec({ case: 'A3', step: 'res', payload: res });
      results.push(summarize(res, `A3-${i}`, `主动消息连发第 ${i + 1} 条`));
      console.log(`A3-${i} ${res.ok ? '✅ 成功' : '❌ 失败'} status=${res.status} code=${String(res.code ?? '')} msg=${res.message ?? ''}`);
      if (!res.ok) break;
    }
  } else if (!runCase('A3')) {
    console.log('A3 跳过（--cases 未包含）');
  } else {
    console.log('A3 跳过：A1 主动消息失败或未执行，连发无意义');
  }

  const activeResults = results.filter((r) => r.label.startsWith('主动消息'));
  const summary = {
    probe: 'ACTIVE-MESSAGE',
    ranAt: new Date().toISOString(),
    casesRun: casesFilter,
    openidShort: `${openid.slice(0, 8)}…${openid.slice(-4)}`,
    staleMsgId: stale
      ? {
          prefix: `${stale.id.slice(0, 14)}…`,
          ageMinutes: ageMinutes ?? null,
          source: stale.file,
          sameTarget: stale.openid === '' ? 'unknown' : stale.openid === openid,
        }
      : null,
    cases: results,
    conclusion: {
      proactiveSendable: activeResults.length > 0 && activeResults.every((r) => r.ok),
      passiveOldInboundIdRejected: results.some((r) => r.case === 'A2' && !r.ok),
      passiveOldInboundIdErrorCode: results.find((r) => r.case === 'A2' && !r.ok)?.code ?? null,
      notes: [
        'A1/A3 看主动消息是否可用与是否触发频控；A2 用**真实入站** msg_id 看时间窗口（出站 id 不能做被动回复，已从提取算法排除）。',
        '若 A1 失败，审批/提问在无锚点场景**不可**降级为主动消息（应如实回执并失败关闭）。',
      ],
    },
  };
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n产物：${RAW_PATH}`);
  console.log(`摘要：${SUMMARY_PATH}`);
  console.log(
    `结论：主动消息可发=${summary.conclusion.proactiveSendable}，旧入站 msg_id 被拒=${summary.conclusion.passiveOldInboundIdRejected}` +
      `（错误码 ${String(summary.conclusion.passiveOldInboundIdErrorCode ?? '无')}）`
  );
}

main().catch((err: unknown) => {
  console.error(`探针异常：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});