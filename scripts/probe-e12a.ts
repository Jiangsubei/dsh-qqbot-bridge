#!/usr/bin/env tsx
/**
 * E12-A 探针：**同一进程内**的会话接管机制（风险 R2 的核心假设）
 *
 * 生产架构（D1/D5/D30）是：QQ 桥接插件与 WebUI **挂在同一个 DSH 进程**里。
 * 因此本项目依赖三条机制，本脚本逐条实测：
 *   M1  `ctx.agents.get(sessionId)` 在会话被驱动时返回**同一个 live agent 实例**（而非 undefined / 新实例）
 *   M2  `turnBoundary` 投影的 `openTurnStartSeq !== null` 能正确表示"忙"（设计文档 §7.3 的判忙依据）
 *   M3  对该 live agent 调 `steer()`，消息能进入**正在运行的那个 turn**（而不是被丢弃或新开一个 turn）
 *
 * 说明：WebUI 建会话走 `apiSessionController.ensureSession()`；本脚本**优先走该路径**，
 * 该服务不可用时回退到 `ctx.agents.create()`（两者最终落到同一个 `ctx.agents` registry），
 * 回退情况会在结论里显式标注，不掩盖。
 *
 * 产物：logs/probe/E12A-concurrent-takeover-<ts>.jsonl + .summary.json
 * 用法：pnpm probe:e12a
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';

import { bootDshQqbotBridge } from '../src/boot.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const PROBE = 'E12A';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `${PROBE}-concurrent-takeover-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `${PROBE}-concurrent-takeover-${stamp}.summary.json`);

const raw: Record<string, unknown>[] = [];
const rec = (o: Record<string, unknown>) => raw.push({ ts: Date.now(), ...o });
const flush = () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RAW_PATH, raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

/** 一个会跑较久、且必然产生多 step 的提示词（多步工具调用，留出 steer 窗口） */
const LONG_PROMPT =
  '请依次执行下面三条 shell 命令，每执行完一条就用一句话说明结果，然后继续下一条：\n' +
  '1) ls -la\n2) pwd\n3) uname -a\n' +
  '三条都完成后，用三句话总结这次执行。';

const STEER_MARKER = '【E12A-STEER-MARKER】';

async function main(): Promise<void> {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qqbot-e12a-'));
  const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'e12a-cwd-'));

  // 复用真实 DSH 的 settings/credentials（复制，避免写穿），其余隔离
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(realHome, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(tmpHome, name));
      await fsp.chmod(path.join(tmpHome, name), 0o600).catch(() => {});
    }
  }
  console.log(`[${PROBE}] 临时 DSH_HOME = ${tmpHome}`);
  console.log(`[${PROBE}] cwd          = ${cwd}`);

  let booted: Awaited<ReturnType<typeof bootDshQqbotBridge>> | undefined;
  const report: Record<string, unknown> = { probe: PROBE, ranAt: new Date().toISOString() };

  try {
    // ️ 实测发现：`@deepseek-ai/dsh-api-session-controller` 单独 insert 进 dsh-base **起不来**——
    //   它 `pending (waiting for service: fileUploads)`，而 fileUploads 只在 dsh-web-app 那层提供。
    //   故本探针不挂它，改用 `ctx.agents.create()`（与 WebUI 的 ensureSession 最终落到**同一个 registry**），
    //   并把这一限制如实记入结论，不掩盖。
    booted = await bootDshQqbotBridge({ dshHome: tmpHome, mountPlugin: false });
    const ctx: any = booted.ctx;

    const defaultModelSvc = ctx.get?.('agentDefaultModel');
    const sel = defaultModelSvc?.currentSelection?.() ?? {};
    const provider = process.env.PROBE_PROVIDER || sel.provider || 'deepseek-official';
    const model = process.env.PROBE_MODEL || sel.model || 'deepseek-v4-flash';
    report.modelRoute = { provider, model };

    const sessionId = `session-e12a-${Date.now()}`;
    report.sessionId = sessionId;

    const events: any[] = [];
    ctx.on('session/event', (session: any, event: any) => {
      if (session?.id !== sessionId) return;
      events.push({ t: Date.now(), type: event?.type, data: event?.data });
      rec({ kind: 'session-event', payload: { type: event?.type, turn: event?.data?.turn, step: event?.data?.step } });
    });

    // ── 1. 建会话：优先走 WebUI 的路径
    let createdVia = 'agents.create（api-session-controller 无法单独挂载：依赖 fileUploads，见上）';
    let agent: any;
    if (!agent) {
      const handle = await ctx.agents.create({
        sessionId,
        agentOptions: { provider, model },
        meta: { cwd },
      });
      agent = handle.agent;
      report.agentHandleDispose = 'agents.create 返回 handle，本探针不主动 dispose 以保持 live';
    }
    report.createdVia = createdVia;
    console.log(`[${PROBE}] 建会话方式 = ${createdVia}，sessionId=${sessionId}`);

    // ── 2. 开启一个长 turn
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text: LONG_PROMPT }], source: { kind: 'user' } })
    );

    // 等到 turn 真正打开（出现 turn/start）
    const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
      rec({ kind: 'note', payload: { timeout: label } });
      return false;
    };

    const turnOpened = await waitFor(() => events.some((e) => e.type === 'turn/start'), 30_000, 'turnOpened');
    report.turnOpened = turnOpened;

    // ── M1: agents.get 是否返回同一个 live agent
    const viaGet = ctx.agents.get(sessionId);
    report.M1 = {
      agentsGetReturnsLiveAgent: Boolean(viaGet),
      sameInstance: viaGet === agent,
      question: 'agents.get(sessionId) 是否返回与建会话时同一个 live agent 实例',
    };
    console.log(
      `[${PROBE}] M1 agents.get → ${viaGet ? '有值' : 'undefined'}；与建会话实例相同 = ${viaGet === agent}`
    );

    // ── M2: turnBoundary 判忙
    const readBusy = () => {
      try {
        const tb = ctx.sessionProjections?.stateOf?.(agent.session, 'turnBoundary');
        return { stateOfOk: true, tb };
      } catch (err: any) {
        return { stateOfOk: false, error: err?.message };
      }
    };
    const busyBefore = readBusy();
    report.M2 = {
      stateOfOk: busyBefore.stateOfOk,
      error: busyBefore.error ?? null,
      openTurnStartSeq: busyBefore.tb?.openTurnStartSeq ?? null,
      lastTurn: busyBefore.tb?.lastTurn ?? null,
      busyDuringTurn: busyBefore.tb ? busyBefore.tb.openTurnStartSeq !== null : null,
      question: 'turnBoundary.openTurnStartSeq 在 turn 运行期间是否为非 null（判忙依据）',
    };
    console.log(
      `[${PROBE}] M2 turnBoundary → openTurnStartSeq=${String(busyBefore.tb?.openTurnStartSeq)} busy=${busyBefore.tb ? busyBefore.tb.openTurnStartSeq !== null : 'n/a'}`
    );

    // 让 turn 真正跑起来（等到第一个 step 之后）再 steer
    await waitFor(() => events.filter((e) => e.type === 'step/start').length >= 1, 30_000, 'firstStep');
    const stepsBefore = events.filter((e) => e.type === 'step/start').length;

    // ── M3: steer 注入正在运行的 turn
    const steerAt = Date.now();
    const steerTarget = ctx.agents.get(sessionId) ?? agent;
    steerTarget.steer(
      createUserMessage({
        content: [{ type: 'text', text: `${STEER_MARKER} 请立刻用一句话回答：你刚才执行到第几条命令了？` }],
        source: { kind: 'user' },
      })
    );
    rec({ kind: 'note', payload: { steerIssuedAt: steerAt, stepsBefore } });
    console.log(`[${PROBE}] M3 已发出 steer（此时 step 数=${stepsBefore}），等待其落点…`);

    // 等 turn 结束（或超时）
    const turnEnded = await waitFor(() => events.some((e) => e.type === 'turn/end'), 240_000, 'turnEnd');
    report.turnEnded = turnEnded;

    const stepsAfter = events.filter((e) => e.type === 'step/start').length;
    const steerUserMsg = events.find(
      (e) => e.type === 'user/message' && JSON.stringify(e.data ?? '').includes(STEER_MARKER)
    );
    const turnEndEvent = events.find((e) => e.type === 'turn/end');
    const lastTurnStart = [...events].reverse().find((e) => e.type === 'turn/start');

    const m3 = {
      stepsBefore,
      stepsAfter,
      steerAppearedAsUserMessage: Boolean(steerUserMsg),
      steerUserMessageSeenBeforeTurnEnd: steerUserMsg ? steerUserMsg.t < (turnEndEvent?.t ?? Number.MAX_SAFE_INTEGER) : null,
      newStepAfterSteer: stepsAfter > stepsBefore,
      turnStartCount: events.filter((e) => e.type === 'turn/start').length,
      turnEndCount: events.filter((e) => e.type === 'turn/end').length,
      lastTurnStartTurn: lastTurnStart?.data?.turn ?? null,
      turnEndTurn: turnEndEvent?.data?.turn ?? null,
      steerLandedInSameTurn:
        Boolean(steerUserMsg) && lastTurnStart?.data?.turn === turnEndEvent?.data?.turn,
      question: 'steer 是否进入正在运行的那个 turn（同一 turn 内新增 step），而非新开 turn 或被丢弃',
    };
    report.M3 = m3;
    console.log(
      `[${PROBE}] M3 steer → 出现在 user/message=${m3.steerAppearedAsUserMessage}，` +
        `step ${stepsBefore}→${stepsAfter}，turn/start 次数=${m3.turnStartCount}，同 turn 落点=${m3.steerLandedInSameTurn}`
    );

    // turn 结束后再读一次判忙（应为 false）
    const busyAfter = readBusy();
    report.busyAfterTurnEnd = {
      openTurnStartSeq: busyAfter.tb?.openTurnStartSeq ?? null,
      idleAfterTurn: busyAfter.tb ? busyAfter.tb.openTurnStartSeq === null : null,
    };
    console.log(`[${PROBE}] 收尾判忙 → openTurnStartSeq=${String(busyAfter.tb?.openTurnStartSeq)}（应为 null）`);

    report.eventSummary = {
      counts: events.reduce((acc: Record<string, number>, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
  } finally {
    flush();
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (booted) await booted.dispose().catch(() => {});
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
    console.log('\n' + '='.repeat(72));
    console.log(`${PROBE} 结论摘要`);
    console.log('='.repeat(72));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n[${PROBE}] 原始产物: ${RAW_PATH}`);
    console.log(`[${PROBE}] 结论摘要: ${SUMMARY_PATH}`);
  }
}

void main().catch((err) => {
  console.error(`[${PROBE}] 致命错误:`, err);
  flush();
  process.exit(1);
});