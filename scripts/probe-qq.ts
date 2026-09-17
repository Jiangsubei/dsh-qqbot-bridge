#!/usr/bin/env tsx
/**
 * QQ 官方 Bot 侧探针（P1-c）：E4 / E1 / E9 / E10 / E2
 *
 * 设计要点：
 *  - **一个用例一条入站消息**。因为被动回复额度是"按 msg_id 计数"的（单聊 60 分钟 / 4 次），
 *    若多个用例挤在同一条 msg_id 上，后面的用例会被前面的用例耗掉额度而失真。
 *    所以每个用例都等待用户新发一条 QQ 消息，各自拿一个全新的 msg_id。
 *  - 所有请求/响应（含失败码）原样落盘到 `logs/probe/qq-<ts>.jsonl`，供结论纪要引用。
 *  - 产物摘要 `logs/probe/qq-<ts>.summary.json`（可入库）。
 *
 * 用法：
 *   pnpm probe:qq                     # 跑全部用例（顺序：E4 → E1 → E9 → E10 → E2）
 *   pnpm probe:qq -- --cases=E4,E1    # 只跑指定用例
 *   pnpm probe:qq -- --dry-run        # 只验证凭据与 WS 连接，不跑用例
 *   pnpm probe:qq -- --whoami         # 只取一次 access_token（验证 AppID/Secret）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { QQProbeClient, resolveCredentials } from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `qq-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `qq-${stamp}.summary.json`);

const ALL_CASES = ['E4', 'E1', 'E9', 'E10', 'E2', 'E5', 'E6', 'E5B', 'E8', 'E7'] as const;
type CaseId = (typeof ALL_CASES)[number];

const argv = process.argv.slice(2);
const args = new Map<string, string>();
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const dryRun = args.has('dry-run');
const whoami = args.has('whoami');
const cases: CaseId[] = (args.get('cases')?.split(',').map((s) => s.trim()).filter(Boolean) as CaseId[]) ?? [
  ...ALL_CASES,
];
for (const c of cases) {
  if (!(ALL_CASES as readonly string[]).includes(c)) {
    console.error(`未知用例 ${c}；可选：${ALL_CASES.join(', ')}`);
    process.exit(2);
  }
}

interface Rec {
  ts: number;
  kind: 'req' | 'res' | 'event' | 'note';
  case?: string;
  step?: string;
  payload: unknown;
}
const raw: Rec[] = [];
function rec(r: Omit<Rec, 'ts'>): void {
  raw.push({ ts: Date.now(), ...r });
}
function flushRaw(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const caseResults: Record<string, unknown>[] = [];

function extractRefIdx(event: any): string | undefined {
  const ext: string[] = event?.message_scene?.ext ?? [];
  for (const e of ext) {
    const m = /^msg_idx=(.+)$/.exec(String(e));
    if (m) return m[1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const creds = resolveCredentials();
  console.log(`[probe:qq] AppID=${creds.appId}（Secret 已就绪，不回显）`);

  const client = new QQProbeClient({ credentials: creds, logger: (m) => console.log(m) });

  if (whoami) {
    const token = await client.getAccessToken();
    console.log(`[probe:qq] ✅ access_token 获取成功，长度 ${token.length}。凭据有效。`);
    return;
  }

  // 等待 READY，确保机器人"在线"（官方要求：发消息接口需 WS 在线）
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 READY 超时（30s）：WS 未就绪')), 30_000);
    client.onReady = () => {
      clearTimeout(t);
      resolve();
    };
  });

  await client.start();
  await ready;
  console.log('[probe:qq] ✅ 机器人已上线（WS READY）\n');

  if (dryRun) {
    console.log('[probe:qq] --dry-run：凭据与 WS 均正常，未执行任何用例。');
    client.stop();
    return;
  }

  // 用例驱动：每个用例等一条新的入站消息
  let caseIndex = 0;
  let pending: { resolve: (event: any) => void } | null = null;

  client.onC2CMessage = (event: any) => {
    const openid = event?.author?.user_openid ?? '';
    const content = String(event?.content ?? '');
    console.log(`\n[probe:qq] ← 收到消息 openid=${openid.slice(0, 8)}… msg_id=${String(event?.id ?? '').slice(0, 16)}…`);
    console.log(`[probe:qq]   内容: ${content.slice(0, 60)}`);
    rec({ kind: 'event', case: cases[caseIndex], payload: { id: event?.id, author: event?.author, content, message_type: event?.message_type, message_scene: event?.message_scene, attachments: event?.attachments } });
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve(event);
    } else {
      console.log('[probe:qq] （当前没有等待中的用例，忽略这条消息）');
    }
  };

  const waitForInbound = (caseId: string): Promise<any> =>
    new Promise((resolve) => {
      pending = { resolve };
      console.log('─'.repeat(64));
      console.log(`[probe:qq] ▶ 用例 ${caseId}：请用手机 QQ 给机器人发一条消息（内容随意，例如「${caseId}」）`);
      console.log(`[probe:qq]   预期：探针收到后会在同一条 msg_id 上连续回复多条并记录结果`);
      console.log('─'.repeat(64));
    });

  const globalTimeout = setTimeout(() => {
    console.log('[probe:qq]  总超时（45 分钟），退出');
    finish();
  }, 45 * 60 * 1000);

  async function finish(): Promise<void> {
    clearTimeout(globalTimeout);
    flushRaw();
    const summary = {
      probe: 'P1-c',
      ranAt: new Date().toISOString(),
      cases: cases.slice(0, caseResults.length),
      rawPath: RAW_PATH,
      results: caseResults,
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log('\n' + '='.repeat(72));
    console.log('[probe:qq] 结果摘要');
    console.log('='.repeat(72));
    for (const r of caseResults) console.log(JSON.stringify(r, null, 2));
    console.log(`\n[probe:qq] 原始产物: ${RAW_PATH}`);
    console.log(`[probe:qq] 结论摘要: ${SUMMARY_PATH}`);
    client.stop();
    process.exit(0);
  }

  try {
    for (caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const caseId = cases[caseIndex]!;
      const event = await waitForInbound(caseId);
      const openid = event?.author?.user_openid;
      const msgId = event?.id;
      if (!openid || !msgId) {
        console.log(`[probe:qq] ⚠ 事件缺少 openid/msg_id，跳过用例 ${caseId}`);
        caseResults.push({ case: caseId, error: 'missing openid/msg_id' });
        continue;
      }
      const result = await runCase(client, caseId, openid, msgId, event);
      caseResults.push(result);
      flushRaw();
    }
    await finish();
  } catch (err: any) {
    console.log(`[probe:qq] ❌ 探针异常: ${err?.message}`);
    rec({ kind: 'note', payload: { fatal: String(err?.stack || err) } });
    await finish();
  }
}

/** 统一的"发一条普通消息"助手，负责落盘 req/res */
async function send(
  client: QQProbeClient,
  openid: string,
  msgId: string,
  seq: number,
  payload: Record<string, unknown>,
  step: string,
  caseId: string
): Promise<any> {
  const full = { ...payload, msg_id: msgId, msg_seq: seq };
  rec({ kind: 'req', case: caseId, step, payload: { seq, ...full } });
  const res = await client.sendMessage(openid, full);
  rec({ kind: 'res', case: caseId, step, payload: { seq, ok: res.ok, status: res.status, code: res.code, message: res.message, body: res.body } });
  console.log(
    `[probe:qq]   seq=${seq} ${step} → ${res.ok ? '✅ 成功' : ' 失败'}` +
      `${res.status !== 200 ? ` HTTP ${res.status}` : ''}${res.code !== undefined ? ` code=${res.code}` : ''}` +
      `${res.message ? ` message=${res.message}` : ''}`
  );
  return res;
}

async function runCase(
  client: QQProbeClient,
  caseId: CaseId,
  openid: string,
  msgId: string,
  event: any
): Promise<Record<string, unknown>> {
  console.log(`[probe:qq] 开始执行用例 ${caseId}`);

  if (caseId === 'E4') {
    // content / markdown 互斥边界
    const a = await send(client, openid, msgId, 1, { msg_type: 0, content: '[E4-a] 纯文本 msg_type=0' }, 'a:纯文本', caseId);
    const b = await send(client, openid, msgId, 2, { msg_type: 2, markdown: { content: '# [E4-b] 仅 markdown' } }, 'b:仅markdown', caseId);
    const c = await send(
      client,
      openid,
      msgId,
      3,
      { msg_type: 2, content: '[E4-c] 同时带 content', markdown: { content: '# [E4-c] markdown 内容' } },
      'c:content+markdown',
      caseId
    );
    const d = await send(client, openid, msgId, 4, { msg_type: 2, content: '[E4-d] 只有 content 无 markdown' }, 'd:仅content', caseId);
    return {
      case: 'E4',
      question: 'content 与 markdown 是否硬互斥？',
      a_text_ok: a.ok,
      b_markdown_only_ok: b.ok,
      c_both_ok: c.ok,
      c_code: c.code ?? null,
      c_message: c.message ?? null,
      d_content_only_ok: d.ok,
      d_code: d.code ?? null,
      d_message: d.message ?? null,
    };
  }

  if (caseId === 'E1') {
    // 被动回复额度：同一条 msg_id 递增 msg_seq 到第几次失败
    const seqs: { seq: number; ok: boolean; code: unknown; message: unknown }[] = [];
    for (let seq = 1; seq <= 6; seq++) {
      const r = await send(client, openid, msgId, seq, { msg_type: 0, content: `[E1] 第 ${seq} 次回复` }, `第${seq}次`, caseId);
      seqs.push({ seq, ok: r.ok, code: r.code ?? null, message: r.message ?? null });
      if (!r.ok && seq >= 2) break; // 已观测到失败即可停止（避免无意义请求）
    }
    const firstFail = seqs.find((s) => !s.ok);
    return {
      case: 'E1',
      question: '被动回复额度如何计数？',
      attempts: seqs,
      allowedCount: seqs.filter((s) => s.ok).length,
      firstFailSeq: firstFail?.seq ?? null,
      firstFailCode: firstFail?.code ?? null,
      firstFailMessage: firstFail?.message ?? null,
    };
  }

  if (caseId === 'E9') {
    // msg_type=6 输入中状态
    // ⚠ 方法修正（首次运行时踩到）：发完输入中状态后**不能立刻**连发后续消息，
    //   否则"正在输入"提示会瞬间被新消息盖掉，观测不到。用 --typing-delay-ms 留出观察窗口。
    const typingDelayMs = Number(args.get('typing-delay-ms') ?? 0);
    const typing = await send(
      client,
      openid,
      msgId,
      1,
      { msg_type: 6, input_notify: { input_type: 1, input_second: 60 } },
      '输入中状态',
      caseId
    );
    if (typingDelayMs > 0 && typing.ok) {
      console.log(
        `[probe:qq]   已发送「输入中状态」，保持静默 ${Math.round(typingDelayMs / 1000)}s 以便观察手机上的提示…`
      );
      await new Promise((r) => setTimeout(r, typingDelayMs));
    }
    const after: { seq: number; ok: boolean; code: unknown }[] = [];
    for (let seq = 2; seq <= 6; seq++) {
      const r = await send(client, openid, msgId, seq, { msg_type: 0, content: `[E9] 输入状态后第 ${seq - 1} 条` }, `后续第${seq - 1}条`, caseId);
      after.push({ seq, ok: r.ok, code: r.code ?? null });
      if (!r.ok) break;
    }
    const okAfter = after.filter((x) => x.ok).length;
    return {
      case: 'E9',
      question: 'msg_type=6 是否占用回复额度？',
      typing_ok: typing.ok,
      typing_code: typing.code ?? null,
      typing_message: typing.message ?? null,
      normalsAfter: after,
      normalsSucceeded: okAfter,
      typingDelayMs,
      /** 注意：E1 实测显示"每条消息最多 4 次"未被强制执行，故本项不再能靠失败推断额度占用 */
      interpretation:
        okAfter >= 4
          ? '未占用额度（可再发 4 条以上）'
          : okAfter === 3
            ? '疑似占用了 1 个额度（可再发 3 条）'
            : '需人工判读（见 normalsAfter）',
    };
  }

  if (caseId === 'E10') {
    const inboundRef = extractRefIdx(event);
    const r1 = inboundRef
      ? await send(
          client,
          openid,
          msgId,
          1,
          { msg_type: 0, content: '[E10-a] 引用你刚才的消息', message_reference: { message_id: inboundRef } },
          'a:引用入站消息',
          caseId
        )
      : null;
    const ownRef = r1?.body?.ext_info?.ref_idx;
    const r2 =
      ownRef
        ? await send(
            client,
            openid,
            msgId,
            2,
            { msg_type: 0, content: '[E10-b] 引用我自己上一条', message_reference: { message_id: ownRef } },
            'b:引用机器人自己的消息',
            caseId
          )
        : null;
    const r3 = await send(client, openid, msgId, 3, { msg_type: 0, content: '[E10-c] 对照：不带引用' }, 'c:对照', caseId);
    return {
      case: 'E10',
      question: '单聊 message_reference 是否可用？',
      inboundRefIdx: inboundRef ?? null,
      a_ok: r1?.ok ?? null,
      a_code: r1?.code ?? null,
      a_message: r1?.message ?? null,
      ownRefIdx: ownRef ?? null,
      b_ok: r2?.ok ?? null,
      b_code: r2?.code ?? null,
      c_control_ok: r3.ok,
    };
  }

// E5：markdown 子集能力与降级需求
  //   文档【明写】支持的语法作为对照；文档**未列出**的（表格 / 围栏代码块 / 行内代码 / 四级标题）
  //   是本实验的核心——探针只能证明"接口没报错"，渲染正确与否必须由用户肉眼确认。
  if (caseId === 'E5') {
    const longLine = '[E5-8] 超长单行开始 ' + '填'.repeat(2200) + ' 结束';
    const items: { key: string; label: string; markdown: string }[] = [
      {
        key: 'e5-1',
        label: '表格（文档未列出）',
        markdown: '[E5-1] 表格\n\n| 列A | 列B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |',
      },
      {
        key: 'e5-2',
        label: '围栏代码块（文档未列出）',
        markdown: '[E5-2] 围栏代码块\n\n```js\nconst x = 1;\nconsole.log(x);\n```',
      },
      {
        key: 'e5-3',
        label: '行内代码（文档未列出）',
        markdown: '[E5-3] 行内代码：这是 `inline code` 测试',
      },
      {
        key: 'e5-4',
        label: '四级标题（文档只列了 #/##）',
        markdown: '[E5-4] 标题层级\n\n#### 这是一个四级标题',
      },
      {
        key: 'e5-5',
        label: '嵌套列表（文档明写支持）',
        markdown: '[E5-5] 嵌套列表\n\n1. 一级项\n    - 二级项\n        - 三级项',
      },
      {
        key: 'e5-6',
        label: '块引用 + 分割线（文档明写支持）',
        markdown: '[E5-6] 引用与分割线\n\n> 引用第一行\n> 引用第二行\n\n***\n\n引用后的段落',
      },
      {
        key: 'e5-7',
        label: '粗体/下划线加粗/删除线（文档明写支持·对照组）',
        markdown: '[E5-7] 文字样式：**加粗** __下划线加粗__ ~~删除线~~',
      },
      {
        key: 'e5-8',
        label: '超长单行 2200 字符（长度边界）',
        markdown: longLine,
      },
      {
        key: 'e5-9',
        label: '图片（公网 URL，文档明写支持）',
        markdown: '[E5-9] 图片\n\n![测试图](https://avatars.githubusercontent.com/u/9919?s=200)',
      },
      {
        key: 'e5-10',
        label: '裸 URL（非 markdown 链接）',
        markdown: '[E5-10] 裸链接 https://www.qq.com 结束',
      },
    ];

    const results: Record<string, unknown>[] = [];
    let seq = 1;
    for (const it of items) {
      const r = await send(client, openid, msgId, seq++, { msg_type: 2, markdown: { content: it.markdown } }, `${it.key} ${it.label}`, caseId);
      results.push({
        key: it.key,
        label: it.label,
        ok: r.ok,
        code: r.code ?? null,
        message: r.message ?? null,
        /** 超长项的原始长度，便于判读 40054007 */
        contentLen: it.key === 'e5-8' ? longLine.length : it.markdown.length,
      });
    }
    return { case: 'E5', question: '文档未列出的 markdown 语法（表格/代码块/行内码/四级标题）真实渲染与报错？', results };
  }

  // E7：富媒体分片上传全链路（官方四步）
  //   1. POST /v2/users/{openid}/upload_prepare  → upload_id + block_size + parts[].presigned_url
  //   2. 逐片 HTTP PUT 到 parts[].presigned_url
  //   3. POST /v2/users/{openid}/upload_part_finish（每片一次，带 part_index/block_size/md5）
  //   4. POST /v2/users/{openid}/files 带 upload_id → file_info
  //   然后 msg_type=7 + media.file_info 发送。
  //   文档：file_type 1图片/2视频/3语音/4文件；软限超限降级为文件；硬限 200MB。
  if (caseId === 'E7') {
    const { createHash, randomBytes } = await import('node:crypto');
    const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
    const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
    /** md5_10m = 文件前 10002432 字节的 MD5（官方定义） */
    const md5_10m = (b: Buffer) => md5(b.subarray(0, 10002432));

    /** 走完整四步，返回 file_info 与逐步证据 */
    const chunkedUpload = async (buf: Buffer, fileType: number, fileName: string) => {
      const trace: Record<string, unknown> = { fileType, fileName, size: buf.length };
      const prep = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/upload_prepare`, {
        file_type: fileType,
        file_size: String(buf.length),
        file_name: fileName,
        md5: md5(buf),
        sha1: sha1(buf),
        md5_10m: md5_10m(buf),
      });
      rec({ kind: 'res', case: 'E7', step: `${fileName}#prepare`, payload: { ok: prep.ok, status: prep.status, code: prep.code, message: prep.message, body: prep.body } });
      trace.prepareOk = prep.ok;
      trace.prepareCode = prep.code ?? null;
      trace.prepareMessage = prep.message ?? null;
      if (!prep.ok) {
        console.log(`[probe:qq]   ${fileName} prepare ❌ code=${prep.code} ${prep.message ?? ''}`);
        return { trace, fileInfo: null as string | null };
      }
      const uploadId: string = prep.body?.upload_id;
      const blockSize = Number(prep.body?.block_size ?? 0);
      const parts: any[] = Array.isArray(prep.body?.parts) ? prep.body.parts : [];
      trace.uploadId = uploadId;
      trace.blockSize = blockSize;
      trace.partsCount = parts.length;
      trace.partsRaw = parts.map((x: any) => ({ index: x.index, block_size: x.block_size }));
      trace.presignedHost = (() => {
        try {
          return new URL(parts[0]?.presigned_url).host;
        } catch {
          return null;
        }
      })();
      console.log(`[probe:qq]   ${fileName} prepare ✅ upload_id=${String(uploadId).slice(0, 14)}… block_size=${blockSize} parts=${parts.length}`);

      const partResults: Record<string, unknown>[] = [];
      // ⚠️ 实测更正（官方文档与线上不一致）：文档写 `parts[].index`「从 0 开始」，
      //    **实测返回 1、2（1-based）**；且**每片自带 `block_size`**（末片为余数，如 2097152）。
      //    因此不能按 `index * 全局blockSize` 定位，必须按 index 升序做**累积偏移**，
      //    并用**该片自己的 block_size** 切片与上报（含 part_finish 的 block_size 字段）。
      const ordered = [...parts].sort((a: any, b: any) => Number(a.index) - Number(b.index));
      let offset = 0;
      for (const p of ordered) {
        const partSize = Number(p.block_size ?? blockSize);
        const chunk = buf.subarray(offset, Math.min(offset + partSize, buf.length));
        offset += chunk.length;
        // 2) PUT 预签名 URL
        let putOk = false;
        let putStatus: number | null = null;
        let putError: string | null = null;
        try {
          const putRes = await fetch(p.presigned_url, { method: 'PUT', body: new Uint8Array(chunk) } as any);
          putOk = putRes.ok;
          putStatus = putRes.status;
        } catch (err: any) {
          putError = err?.message ?? String(err);
        }
        // 3) part_finish
        const fin = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/upload_part_finish`, {
          upload_id: uploadId,
          part_index: p.index,
          block_size: String(partSize),
          md5: md5(chunk),
        });
        partResults.push({
          index: p.index,
          chunkBytes: chunk.length,
          putOk,
          putStatus,
          putError,
          finishOk: fin.ok,
          finishCode: fin.code ?? null,
          finishMessage: fin.message ?? null,
        });
        console.log(
          `[probe:qq]   ${fileName} part#${p.index} (${chunk.length}B) PUT=${putOk ? '✅' : `❌${putStatus ?? putError}`} finish=${fin.ok ? '✅' : `❌${fin.code}`}`
        );
        if (!putOk || !fin.ok) break;
      }
      trace.parts = partResults;

      // 4) 合并 → file_info
      const merge = await client.apiPost(`/v2/users/${encodeURIComponent(openid)}/files`, { upload_id: uploadId });
      rec({ kind: 'res', case: 'E7', step: `${fileName}#files`, payload: { ok: merge.ok, status: merge.status, code: merge.code, message: merge.message, body: merge.body } });
      trace.mergeOk = merge.ok;
      trace.mergeCode = merge.code ?? null;
      trace.mergeMessage = merge.message ?? null;
      trace.fileUuid = merge.body?.file_uuid ?? null;
      trace.ttl = merge.body?.ttl ?? null;
      const fileInfo = merge.ok ? (merge.body?.file_info as string) : null;
      console.log(
        `[probe:qq]   ${fileName} files ${merge.ok ? `✅ file_uuid=${String(trace.fileUuid).slice(0, 12)}… ttl=${trace.ttl}` : ` code=${merge.code} ${merge.message ?? ''}`}`
      );
      return { trace, fileInfo };
    };

    // ── 素材 1：真实图片（用 E5B 已验证可下载的腾讯 COS 图），走 file_type=1
    const imgRes = await fetch('https://resource5-1255303497.cos.ap-guangzhou.myqcloud.com/abcmouse_word_watch/markdown/building.png');
    const imgBuf = Buffer.from(await imgRes.arrayBuffer());
    console.log(`[probe:qq] 素材图片下载：${imgRes.status} ${imgBuf.length}B`);

    const imageUpload = await chunkedUpload(imgBuf, 1, 'e7-probe-image.png');
    let imageSentOk: boolean | null = null;
    if (imageUpload.fileInfo) {
      const r = await send(client, openid, msgId, 1, {
        msg_type: 7,
        content: ' ',
        media: { file_info: imageUpload.fileInfo },
      }, 'E7 发送图片(msg_type=7)', caseId);
      imageSentOk = r.ok;
    }

    // ── 素材 2：同一张图再传一次，验证 md5 秒传（file_uuid 是否复用）
    const imageUploadAgain = await chunkedUpload(imgBuf, 1, 'e7-probe-image.png');
    const dedupSameUuid =
      imageUpload.trace.fileUuid && imageUploadAgain.trace.fileUuid
        ? imageUpload.trace.fileUuid === imageUploadAgain.trace.fileUuid
        : null;

    // ── 素材 3：12MB 二进制文件，走 file_type=4（尽量逼出多分片）
    const bigBuf = randomBytes(12 * 1024 * 1024);
    const bigUpload = await chunkedUpload(bigBuf, 4, 'e7-probe-12mb.bin');
    let bigSentOk: boolean | null = null;
    if (bigUpload.fileInfo) {
      const r = await send(client, openid, msgId, 2, {
        msg_type: 7,
        content: ' ',
        media: { file_info: bigUpload.fileInfo },
      }, 'E7 发送文件(msg_type=7)', caseId);
      bigSentOk = r.ok;
    }

    // ── file_info 复用：同一个 file_info 再发一次（验证 TTL/复用性）
    let reuseOk: boolean | null = null;
    if (bigUpload.fileInfo) {
      const r = await send(client, openid, msgId, 3, {
        msg_type: 7,
        content: ' ',
        media: { file_info: bigUpload.fileInfo },
      }, 'E7 复用 file_info 再发一次', caseId);
      reuseOk = r.ok;
    }

    await send(
      client,
      openid,
      msgId,
      4,
      {
        msg_type: 0,
        content:
          `[E7] 分片上传结果：图片=${imageUpload.trace.mergeOk ? '成功' : '失败'}，` +
          `12MB文件=${bigUpload.trace.mergeOk ? '成功' : '失败'}，` +
          `block_size=${bigUpload.trace.blockSize ?? '?'}，分片数=${bigUpload.trace.partsCount ?? '?'}，` +
          `秒传同 uuid=${dedupSameUuid}`,
      },
      'E7 摘要回执',
      caseId
    );

    return {
      case: 'E7',
      question: '分片上传四步链路是否可用？block_size / 分片数 / 秒传 / file_info 复用如何？',
      imageBytes: imgBuf.length,
      imageUpload: { ...imageUpload.trace, fileInfoObtained: Boolean(imageUpload.fileInfo), sentOk: imageSentOk },
      imageUploadAgain: { ...imageUploadAgain.trace, dedupSameUuid },
      bigFileUpload: { ...bigUpload.trace, fileInfoObtained: Boolean(bigUpload.fileInfo), sentOk: bigSentOk },
      fileInfoReuseOk: reuseOk,
    };
  }

  // E8：入站附件下载与鉴权
  //   用户发来的图片/文件/语音通过事件 `attachments[]` 携带（官方文档：url / filename / size /
  //   content_type / voice_wav_url / asr_refer_text）。本实验分三种方式尝试下载，判断是否需要鉴权头：
  //   (a) 裸 GET  (b) 带 `Authorization: QQBot <access_token>`  (c) 带 message_scene.ext 的 auth_token
  //   注意：附件 URL 常带 rkey 之类的凭证型查询串，落盘只记 host + path 前缀，不记完整 query。
  if (caseId === 'E8') {
    const token = await client.getAccessToken();
    const safeUrl = (u: unknown): string => {
      if (typeof u !== 'string' || !u) return '(空)';
      try {
        const parsed = new URL(u);
        return `${parsed.host}${parsed.pathname.slice(0, 40)}…?<已隐去query>`;
      } catch {
        return '(非法URL)';
      }
    };
    const tryFetch = async (
      url: string,
      headers: Record<string, string>
    ): Promise<{ label: string; status: number | null; ok: boolean; contentType: string | null; bytes: number | null; error: string | null }> => {
      const label = Object.keys(headers).length === 0 ? 'a:裸GET' : headers.Authorization?.startsWith('QQBot') ? 'b:QQBot token' : 'c:auth_token';
      try {
        const res = await fetch(url, { headers });
        const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
        return {
          label,
          status: res.status,
          ok: res.ok,
          contentType: res.headers.get('content-type'),
          bytes: res.ok ? buf.length : null,
          error: null,
        };
      } catch (err: any) {
        return { label, status: null, ok: false, contentType: null, bytes: null, error: err?.message ?? String(err) };
      }
    };

    const attachments: any[] = Array.isArray(event?.attachments) ? event.attachments : [];
    const ext: string[] = event?.message_scene?.ext ?? [];
    const authToken = ext
      .map((e) => /^auth_token=(.*)$/.exec(String(e))?.[1])
      .find((v) => v !== undefined);

    const results: Record<string, unknown>[] = [];
    for (const [i, a] of attachments.entries()) {
      const url = typeof a?.url === 'string' ? a.url : '';
      const attempts: Record<string, unknown>[] = [];
      if (url) {
        attempts.push(await tryFetch(url, {}));
        attempts.push(await tryFetch(url, { Authorization: `QQBot ${token}` }));
        if (authToken && !authToken.startsWith('QQBot')) {
          attempts.push(await tryFetch(url, { Authorization: authToken }));
        }
      }
      if (typeof a?.voice_wav_url === 'string' && a.voice_wav_url) {
        attempts.push(await tryFetch(a.voice_wav_url, {}));
      }
      results.push({
        index: i,
        contentType: a?.content_type ?? null,
        filename: a?.filename ?? null,
        size: a?.size ?? null,
        urlSafe: safeUrl(url),
        voiceWavUrlSafe: a?.voice_wav_url ? safeUrl(a.voice_wav_url) : null,
        asrReferText: a?.asr_refer_text ?? null,
        attempts,
      });
      console.log(
        `[probe:qq]   附件#${i} content_type=${a?.content_type ?? 'n/a'} → ` +
          attempts.map((x) => `${x.label}=${x.ok ? `✅${x.bytes}B` : `❌${x.status ?? x.error}`}`).join(' | ')
      );
    }

    // 回一条摘要，让用户确认探针真的收到了附件
    const summary =
      attachments.length === 0
        ? '[E8] 这条消息没有携带 attachments（未检测到图片/文件/语音）'
        : `[E8] 收到 ${attachments.length} 个附件：` +
          attachments.map((a: any, i: number) => `#${i} ${a?.content_type ?? '?'} ${a?.size ?? '?'}B`).join('，');
    await send(client, openid, msgId, 1, { msg_type: 0, content: summary }, 'E8 摘要回执', caseId);

    return {
      case: 'E8',
      question: '入站附件如何下载？是否需要鉴权头？语音是否有 wav/asr？',
      attachmentCount: attachments.length,
      hasAuthTokenInScene: Boolean(authToken),
      results,
    };
  }

  // E5B：markdown 图片为什么只显示 [测试图] 占位？
  //   E5-9 用 GitHub 头像 URL，服务端 200 但客户端显示 `[测试图]` 占位。
  //   需区分两种可能：(a) 平台取不到该 URL；(b) 单聊根本不渲染 markdown 图片。
  //   这里换用**腾讯自家域名**（含官方文档示例用的 COS 地址）复测。
  if (caseId === 'E5B') {
    const urls = [
      {
        key: 'e5b-1',
        label: '官方文档示例的 COS 图',
        url: 'https://resource5-1255303497.cos.ap-guangzhou.myqcloud.com/abcmouse_word_watch/markdown/building.png',
      },
      {
        key: 'e5b-2',
        label: '百度 logo（公网常见图）',
        url: 'https://www.baidu.com/img/flexible/logo/pc/result.png',
      },
    ];
    const results: Record<string, unknown>[] = [];
    let seq = 1;
    for (const u of urls) {
      const md = `[${u.key}] ${u.label}\n\n![${u.key}](${u.url})`;
      const r = await send(client, openid, msgId, seq++, { msg_type: 2, markdown: { content: md } }, `${u.key} ${u.label}`, caseId);
      results.push({ key: u.key, label: u.label, url: u.url, ok: r.ok, code: r.code ?? null, message: r.message ?? null });
    }
    return { case: 'E5B', question: 'markdown 图片是否因 URL 不可取而失败？（换成腾讯/百度域名复测）', results };
  }

  // E6：URL 白名单（群聊错误码表有 40054010 不允许发送URL，但单聊错误码表**未列出**该码）
  if (caseId === 'E6') {
    const items = [
      { key: 'e6-1', label: 'markdown 链接', markdown: '[E6-1] markdown 链接：[腾讯网](https://www.qq.com)' },
      { key: 'e6-2', label: '裸 URL', markdown: '[E6-2] 裸 URL：https://www.qq.com' },
      {
        key: 'e6-3',
        label: 'markdown 图片（公网 URL）',
        markdown: '[E6-3] markdown 图片：![图](https://avatars.githubusercontent.com/u/9919?s=200)',
      },
    ];
    const results: Record<string, unknown>[] = [];
    let seq = 1;
    for (const it of items) {
      const r = await send(client, openid, msgId, seq++, { msg_type: 2, markdown: { content: it.markdown } }, `${it.key} ${it.label}`, caseId);
      results.push({ key: it.key, label: it.label, ok: r.ok, code: r.code ?? null, message: r.message ?? null });
    }
    return { case: 'E6', question: '单聊是否受 URL 白名单限制（40054010 是否出现）？', results };
  }

  // E2（含 E3 的 remain_msg_len 观测）
  //
  // ⚠ 方法修正（首次运行踩到 40007）：首版用 `replace` 模式，但分片文本里带了 index
  //   （`分片 1/20` → `分片 2/20`），导致后片的 content_raw 不以已下发内容为前缀，
  //   被服务端拒绝：`40007 已经提交的消息内容不可修改`。官方文档明确要求 replace 的
  //   content_raw「须以上游已下发前缀 SentContent 开头」。
  //   修正为**两种模式各测一遍**（各自占用一个 msg_seq），同时确定 P2 该用哪种。
  const N = 8;
  const streamOnce = async (label: string, seq: number, mode: 'append' | 'replace') => {
    const steps: {
      index: number;
      ok: boolean;
      code: unknown;
      message: unknown;
      remainMsgLen: unknown;
      contentLen: number;
    }[] = [];
    let streamMsgId: string | undefined;
    let acc = '';
    for (let i = 0; i < N; i++) {
      const delta = `第 ${i + 1} 行：${'填补字符'.repeat(20)}\n`;
      let contentRaw: string;
      if (mode === 'append') {
        contentRaw = delta; // 只发增量
      } else {
        acc += delta; // 累积全文，但**只追加**，前缀天然稳定
        contentRaw = acc;
      }
      const payload: Record<string, unknown> = {
        input_mode: mode,
        input_state: i === N - 1 ? 10 : 1,
        index: i,
        content_type: 'markdown',
        content_raw: contentRaw,
        msg_id: msgId,
        msg_seq: seq,
        ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
      };
      rec({ kind: 'req', case: 'E2', step: `${label}#${i}`, payload });
      const res = await client.sendStreamMessage(openid, payload);
      rec({
        kind: 'res',
        case: 'E2',
        step: `${label}#${i}`,
        payload: { ok: res.ok, status: res.status, code: res.code, message: res.message, body: res.body },
      });
      const id = res.body?.id;
      const remain = res.body?.remain_msg_len;
      if (!streamMsgId && typeof id === 'string') streamMsgId = id;
      steps.push({
        index: i,
        ok: res.ok,
        code: res.code ?? null,
        message: res.message ?? null,
        remainMsgLen: remain ?? null,
        contentLen: contentRaw.length,
      });
      if (i === 0 || i === N - 1 || !res.ok) {
        console.log(
          `[probe:qq]   ${label}#${i} → ${res.ok ? '✅' : '❌'}` +
            `${res.code !== undefined ? ` code=${res.code}` : ''} remain_msg_len=${remain ?? 'n/a'} content_len=${contentRaw.length}`
        );
      }
      if (!res.ok) break;
    }
    return {
      mode,
      msgSeq: seq,
      chunksAttempted: steps.length,
      allOk: steps.every((s) => s.ok),
      firstFail: steps.find((s) => !s.ok) ?? null,
      streamMsgIdObtained: Boolean(streamMsgId),
      remainMsgLenSeries: steps.map((s) => s.remainMsgLen),
      contentLenSeries: steps.map((s) => s.contentLen),
    };
  };

  const appendMode = await streamOnce('append', 1, 'append');
  const replaceMode = await streamOnce('replace', 2, 'replace');

  // 流式之后：同 msg_id 的普通消息按 msg_seq 递增，看是否被去重 / 是否有上限
  const afterStream: { seq: number; ok: boolean; code: unknown; message: unknown }[] = [];
  for (let seq = 1; seq <= 5; seq++) {
    const r = await send(
      client,
      openid,
      msgId,
      seq,
      { msg_type: 0, content: `[E2] 流式之后 msg_seq=${seq}` },
      `流式后seq=${seq}`,
      caseId
    );
    afterStream.push({ seq, ok: r.ok, code: r.code ?? null, message: r.message ?? null });
  }

  return {
    case: 'E2',
    question:
      'append/replace 两种流式模式是否都可用？流式是否占用 (msg_id, msg_seq) 槽位？remain_msg_len 行为？',
    appendMode,
    replaceMode,
    afterStream,
    /** 占用槽位证据：msg_seq=1（append 流式用过）应被去重拒绝；msg_seq=2（replace 流式用过）同理 */
    seq1Duplicate: afterStream[0] ? !afterStream[0].ok : null,
    seq2Duplicate: afterStream[1] ? !afterStream[1].ok : null,
    normalsSucceededAfterStream: afterStream.filter((x) => x.ok).length,
  };
}

void main().catch((err) => {
  console.error(`[probe:qq] 致命错误:`, err);
  flushRaw();
  process.exit(1);
});