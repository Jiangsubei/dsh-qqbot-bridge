#!/usr/bin/env tsx
/**
 * 卡片与内联按钮真机探针 v2
 *
 * 第二轮实测目标（补全首轮发现的两个关键缺口）：
 *   1. IDENTIFY 订阅 intents = (1 << 25) | (1 << 26)（含 INTERACTION）是否正常 READY；
 *   2. 探针 A 的 group_id 缩短为 `ap-${nonce}`（9 字符，对照首轮 21 字符报 40011021），
 *      验证审批按钮「允许一次 / 拒绝」能否正常下发并互斥变灰；
 *   3. 用户点击按钮后是否收到 WS `INTERACTION_CREATE` 事件、事件完整字段是什么、
 *      `PUT /interactions/{id}` 是否成功；
 *   4. 用 `event_id: 'INTERACTION_CREATE:' + id` vs 裸 `id` 被动回复是否成功；
 *   5. 额外测一个「带长选项名 + 4 个按钮」的提问卡片与表格排版。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  QQProbeClient,
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QQ_INTENT_INTERACTION,
  resolveCredentials,
} from './lib/qq-probe-client.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `card-keyboard-v2-${stamp}.jsonl`);

function writeLog(entry: Record<string, unknown>): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(RAW_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

async function sendAndLog(
  client: QQProbeClient,
  openid: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ ok: boolean; status: number; code?: string | number; message?: string; body: any }> {
  writeLog({ kind: 'req', label, payload });
  const res = await client.sendMessage(openid, payload);
  writeLog({ kind: 'res', label, ok: res.ok, status: res.status, code: res.code, message: res.message, body: res.body });
  console.log(
    `[probe:card2] ${label} → ${res.ok ? 'OK' : 'FAIL'} HTTP=${res.status}` +
      (res.code !== undefined ? ` code=${res.code}` : '') +
      (res.message ? ` msg=${res.message}` : ''),
  );
  return res;
}

function buildApprovalCard(nonce: string) {
  const groupId = `ap-${nonce}`; // 9 字符（探针 1 已实测 21 字符会报 40011021）
  return {
    markdown: {
      content: [
        '🔐 **执行审批（探针 A2：短 group_id）**',
        '',
        '🔧 工具: `bash`',
        '',
        '```bash',
        'pnpm test',
        '```',
        '',
        '📝 请点击下方按钮测试回调与同组互斥变灰',
        '',
        '> 👇 点击下方按钮确认，或直接回复 y / n',
      ].join('\n'),
    },
    keyboard: {
      content: {
        rows: [
          {
            buttons: [
              {
                id: 'probe-allow',
                render_data: { label: '✅ 允许一次', visited_label: '✓ 已允许', style: 1 },
                action: {
                  type: 1,
                  permission: { type: 2 },
                  click_limit: 1,
                  data: JSON.stringify({ t: 'approval', d: 'allow', n: nonce }),
                },
                group_id: groupId,
              },
              {
                id: 'probe-deny',
                render_data: { label: '❌ 拒绝', visited_label: '✓ 已拒绝', style: 0 },
                action: {
                  type: 1,
                  permission: { type: 2 },
                  click_limit: 1,
                  data: JSON.stringify({ t: 'approval', d: 'deny', n: nonce }),
                },
                group_id: groupId,
              },
            ],
          },
        ],
      },
    },
  };
}

function buildFourOptionQuestionCard(nonce: string) {
  const opts = [
    { label: '方案A：完全接管', desc: '接管当前会话并启用按钮' },
    { label: '方案B：仅Markdown', desc: '只排版不带按钮' },
    { label: '方案C：英文别名', desc: '支持 /model /help 等别名' },
    { label: '方案D：全部开启', desc: '一次性全部启用' },
  ];
  const lines = [
    '**功能选择（探针 B2：4 选项两行按钮）**',
    '点击任一按钮验证 `INTERACTION_CREATE` 回调与 `event_id` 回复：',
    ...opts.map((o, i) => `${i + 1}. ${o.label} · ${o.desc}`),
    '',
    '> 👇 点击下方按钮选择，或回复序号',
  ];
  const buttons = opts.map((o, i) => ({
    id: `probe-q-${i}`,
    render_data: {
      label: o.label.length > 10 ? `${o.label.slice(0, 9)}…` : o.label,
      visited_label: '✓ 已选',
      style: 1,
    },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: JSON.stringify({ t: 'question', q: `q-${nonce}`, i }),
    },
    group_id: `q-${nonce}`, // 8 字符
  }));

  return {
    markdown: { content: lines.join('\n') },
    keyboard: {
      content: {
        rows: [
          { buttons: buttons.slice(0, 2) },
          { buttons: buttons.slice(2, 4) },
        ],
      },
    },
  };
}

async function main(): Promise<void> {
  const creds = resolveCredentials();
  const intents = QQ_INTENT_GROUP_AND_C2C_EVENT | QQ_INTENT_INTERACTION;
  console.log(`[probe:card2] AppID=${creds.appId} intents=${intents} (1<<25 | 1<<26) 日志=${RAW_PATH}`);

  const client = new QQProbeClient({
    credentials: creds,
    intents,
    logger: (m) => console.log(m),
  });

  let lastMsgTarget: { openid: string; msgId: string } | null = null;
  let seqCounter = 0;

  client.onReady = (info) => {
    writeLog({ kind: 'ready', info, intents });
    console.log(`[probe:card2] ✅ READY bot=${info.botName}(${info.botId})，请用 QQ 发任意消息触发第 2 轮卡片...`);
  };

  client.onAnyDispatch = (eventType, data) => {
    if (eventType === 'READY' || eventType === 'RESUMED') return;
    writeLog({ kind: 'ws_dispatch', eventType, data });
    if (eventType === 'INTERACTION_CREATE') {
      void handleInteraction(data as Record<string, any>);
    }
  };

  async function handleInteraction(event: Record<string, any>): Promise<void> {
    const id = String(event?.id ?? '');
    const openid = String(event?.user_openid ?? lastMsgTarget?.openid ?? '');
    const buttonData = event?.data?.resolved?.button_data;
    console.log(`[probe:card2] 🖱️ 收到 INTERACTION_CREATE id=${id} user_openid=${openid} button_data=${String(buttonData)}`);

    if (id) {
      const ackRes = await client.apiPut(`/interactions/${encodeURIComponent(id)}`, { code: 0 });
      writeLog({ kind: 'interaction_ack', id, ok: ackRes.ok, status: ackRes.status, code: ackRes.code, message: ackRes.message, body: ackRes.body });
      console.log(`[probe:card2] PUT /interactions/${id} → HTTP=${ackRes.status} ok=${ackRes.ok} code=${String(ackRes.code ?? '')}`);
    }

    if (openid && id) {
      // 测试 1：使用 `INTERACTION_CREATE:${id}` 作为 event_id（腾讯官方插件 msgid-cache 写法）
      const prefixedEventId = id.startsWith('INTERACTION_CREATE:') ? id : `INTERACTION_CREATE:${id}`;
      const r1 = await sendAndLog(
        client,
        openid,
        {
          msg_type: 2,
          markdown: {
            content: `✅ **收到按钮回调（event_id 带前缀）**\n- \`button_data\`: \`${String(buttonData)}\`\n- \`event.id\`: \`${id}\``,
          },
          event_id: prefixedEventId,
          msg_seq: 1,
        },
        'interaction_reply_prefixed_event_id',
      );
      if (!r1.ok) {
        // 测试 2：如果带前缀失败，试裸 id；再失败退回 msg_id
        const r2 = await sendAndLog(
          client,
          openid,
          {
            msg_type: 2,
            markdown: {
              content: `✅ **收到按钮回调（裸 event_id）**\n- \`button_data\`: \`${String(buttonData)}\``,
            },
            event_id: id,
            msg_seq: 2,
          },
          'interaction_reply_raw_event_id',
        );
        if (!r2.ok && lastMsgTarget?.msgId) {
          await sendAndLog(
            client,
            openid,
            {
              msg_type: 2,
              markdown: {
                content: `✅ **收到按钮回调（回退 msg_id）**\n- \`button_data\`: \`${String(buttonData)}\``,
              },
              msg_id: lastMsgTarget.msgId,
              msg_seq: ++seqCounter,
            },
            'interaction_reply_msgid_fallback',
          );
        }
      }
    }
  }

  client.onC2CMessage = async (event: any) => {
    const openid = String(event?.author?.user_openid ?? event?.author?.id ?? '');
    const msgId = String(event?.id ?? '');
    const content = String(event?.content ?? '').trim();
    console.log(`[probe:card2] 💬 收到 C2C 消息 openid=${openid} msgId=${msgId} content=${JSON.stringify(content)}`);

    if (!openid || !msgId) return;
    lastMsgTarget = { openid, msgId };
    seqCounter = 0;

    const nonce = String(Date.now()).slice(-6);

    const cardA = buildApprovalCard(nonce);
    const resA = await sendAndLog(
      client,
      openid,
      { msg_type: 2, ...cardA, msg_id: msgId, msg_seq: ++seqCounter },
      'A2_approval_short_group_id',
    );
    if (!resA.ok) {
      await sendAndLog(
        client,
        openid,
        {
          msg_type: 2,
          markdown: { content: `${cardA.markdown.content}\n\n⚠️ *(A2 失败 code=${String(resA.code ?? resA.status)} ${resA.message ?? ''})*` },
          msg_id: msgId,
          msg_seq: ++seqCounter,
        },
        'A2_approval_fallback',
      );
    }

    const cardB = buildFourOptionQuestionCard(nonce);
    const resB = await sendAndLog(
      client,
      openid,
      { msg_type: 2, ...cardB, msg_id: msgId, msg_seq: ++seqCounter },
      'B2_question_4_options',
    );
    if (!resB.ok) {
      await sendAndLog(
        client,
        openid,
        {
          msg_type: 2,
          markdown: { content: `${cardB.markdown.content}\n\n⚠️ *(B2 失败 code=${String(resB.code ?? resB.status)} ${resB.message ?? ''})*` },
          msg_id: msgId,
          msg_seq: ++seqCounter,
        },
        'B2_question_fallback',
      );
    }
  };

  await client.start();

  setTimeout(() => {
    console.log('[probe:card2] 探针超时（20分钟）自动退出');
    client.stop();
    process.exit(0);
  }, 20 * 60 * 1000);
}

main().catch((err) => {
  console.error('[probe:card2] 致命错误:', err);
  process.exit(1);
});
