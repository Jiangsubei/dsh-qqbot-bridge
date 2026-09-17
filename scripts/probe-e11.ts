#!/usr/bin/env tsx
/**
 * E11 探针：DSH 侧 `agent/assistant-stream` 帧序列与 `text-delta` 边界实测
 *
 * 依 `docs/任务包-第一期真机探针与协议空白实测.md` E11，回答四个问题：
 *   Q1 流式帧序列是什么？（start → chunk* → end？）
 *   Q2 `chunk` 帧里出现哪些 `StreamChunk.type`？text/reasoning/tool-call 是否混在同一流里（即"必须过滤"）？
 *   Q3 只靠 `text-delta` 能否拼出与最终 `assistant/message` 完全一致的正文？
 *   Q4 **root 上下文的监听者能否收到 agent 作用域的 `agent/assistant-stream`？**
 *      （这决定本项目插件（挂在 root）能否直接观测它接管的会话的流）
 *
 * 额外观测：turn/step/revision/index 单调性、`end.outcome`、`assistant/message` 与 `end` 的时序。
 *
 * 产物：
 *   logs/probe/E11-assistant-stream-<ts>.jsonl          原始帧与会话事件（含 scope 标记）
 *   logs/probe/E11-assistant-stream-<ts>.summary.json  分析结论摘要
 *
 * 用法：pnpm probe:e11
 * 环境变量：
 *   PROBE_PROVIDER / PROBE_MODEL  覆盖模型路由（默认读 DSH settings 的 agent-default-model）
 *   PROBE_CWD                     会话 cwd（默认临时目录）
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';

import { bootDshQqbotBridge } from '../src/boot.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const PROBE = 'E11';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.resolve('logs/probe');
const RAW_PATH = path.join(LOG_DIR, `${PROBE}-assistant-stream-${stamp}.jsonl`);
const SUMMARY_PATH = path.join(LOG_DIR, `${PROBE}-assistant-stream-${stamp}.summary.json`);

/** 两个用例：纯文本（无工具） 与 需要工具调用的多 step 回合 */
const CASES = [
  {
    id: 'A-text-only',
    prompt: '请用三句话解释什么是 WebSocket，不要使用任何工具，也不要写代码。',
    expectTools: false,
  },
  {
    id: 'B-with-tool',
    prompt:
      '请先执行一条 shell 命令列出当前目录下的文件，然后告诉我一共有几个文件。必须真的执行命令。',
    expectTools: true,
  },
];

interface RawEvent {
  ts: number;
  case: string;
  scope: 'root' | 'agent' | 'session';
  kind: 'frame' | 'session-event';
  payload: unknown;
}

const raw: RawEvent[] = [];

function writeJsonl(): void {
  const body = raw.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(RAW_PATH, body, 'utf8');
}

/** 从 ContentBlock[] 里取出全部 text，返回拼接结果 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('');
}

function main(): void {
  void run().catch(async (err) => {
    console.error(`[${PROBE}] 探针异常终止:`, err);
    process.exitCode = 1;
  });
}

async function run(): Promise<void> {
  await fsp.mkdir(LOG_DIR, { recursive: true });

  const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qqbot-e11-'));
  const probeCwd = process.env.PROBE_CWD || (await fsp.mkdtemp(path.join(os.tmpdir(), 'e11-cwd-')));

  // 隔离运行：复制 settings/credentials 到临时 DSH_HOME，避免探针读写用户真实配置
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(realHome, name);
    const dst = path.join(tmpHome, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, dst);
      await fsp.chmod(dst, 0o600).catch(() => {});
    } else {
      console.warn(`[${PROBE}] 注意：${src} 不存在，相关能力可能不可用`);
    }
  }
  console.log(`[${PROBE}] 临时 DSH_HOME = ${tmpHome}`);
  console.log(`[${PROBE}] 会话 cwd      = ${probeCwd}`);

  let booted: Awaited<ReturnType<typeof bootDshQqbotBridge>> | undefined;

  try {
    // ── 1. 装配真实 DSH（不挂载本插件：P1 阶段 src/index.ts 尚不存在）
    booted = await bootDshQqbotBridge({ dshHome: tmpHome, mountPlugin: false });
    const ctx: any = booted.ctx;

    // ── 2. 模型路由：优先 env，其次 DSH 设置里的 agent-default-model，最后回退
    const defaultModelSvc = ctx.get?.('agentDefaultModel');
    const sel = defaultModelSvc?.currentSelection?.() ?? {};
    const provider = process.env.PROBE_PROVIDER || sel.provider || 'deepseek-official';
    const model = process.env.PROBE_MODEL || sel.model || 'deepseek-v4-flash';
    console.log(`[${PROBE}] 模型路由 = ${provider} / ${model}（来源：${process.env.PROBE_PROVIDER ? 'env' : 'agent-default-model'}）`);

    // ─ 3. 逐用例执行
    const caseResults = [];
    for (const c of CASES) {
      caseResults.push(await runCase(ctx, c, provider, model, probeCwd));
    }

    // ─ 4. 汇总
    const summary = {
      probe: PROBE,
      ranAt: new Date().toISOString(),
      dshHome: tmpHome,
      probeCwd,
      modelRoute: { provider, model },
      rawPath: RAW_PATH,
      cases: caseResults,
    };
    await fsp.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    writeJsonl();

    printSummary(summary);
  } finally {
    if (booted) await booted.dispose().catch(() => {});
    if (fs.existsSync(RAW_PATH)) writeJsonl();
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    console.log(`[${PROBE}] 已清理临时 DSH_HOME`);
    console.log(`[${PROBE}] 原始产物: ${RAW_PATH}`);
    console.log(`[${PROBE}] 结论摘要: ${SUMMARY_PATH}`);
  }
}

interface CaseSpec {
  id: string;
  prompt: string;
  expectTools: boolean;
}

async function runCase(
  ctx: any,
  spec: CaseSpec,
  provider: string,
  model: string,
  cwd: string
): Promise<Record<string, unknown>> {
  const sessionId = `session-probe-${PROBE.toLowerCase()}-${spec.id}-${Date.now()}`;
  console.log(`\n[${PROBE}] ==== 用例 ${spec.id} ==== sessionId=${sessionId}`);

  const framesRoot: any[] = [];
  const framesAgent: any[] = [];
  const sessionEvents: any[] = [];

  // root 作用域监听（本项目插件的真实挂载位置）—— Q4 的关键
  const offRoot = ctx.on('agent/assistant-stream', (payload: any) => {
    framesRoot.push(payload?.frame);
    raw.push({ ts: Date.now(), case: spec.id, scope: 'root', kind: 'frame', payload: payload?.frame });
  });

  const offSession = ctx.on('session/event', (session: any, event: any) => {
    if (session?.id !== sessionId) return;
    sessionEvents.push(event);
    raw.push({ ts: Date.now(), case: spec.id, scope: 'session', kind: 'session-event', payload: event });
  });

  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider, model },
    meta: { cwd },
    // agent 作用域监听（对照组）
    setup: (agentCtx: any) => {
      agentCtx.on('agent/assistant-stream', (payload: any) => {
        framesAgent.push(payload?.frame);
        raw.push({ ts: Date.now(), case: spec.id, scope: 'agent', kind: 'frame', payload: payload?.frame });
      });
    },
  });

  // 等 turn/end
  const turnEnded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 turn/end 超时（240s）')), 240_000);
    const check = () => {
      if (sessionEvents.some((e) => e?.type === 'turn/end')) {
        clearTimeout(timer);
        offSession();
        resolve();
      }
    };
    const iv = setInterval(check, 250);
    // 也直接挂一个一次性监听，减少轮询延迟
    ctx.on('session/event', (session: any, event: any) => {
      if (session?.id === sessionId && event?.type === 'turn/end') {
        clearTimeout(timer);
        clearInterval(iv);
        offSession();
        resolve();
      }
    });
    check();
  });

  handle.agent.followup(
    createUserMessage({ content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } })
  );

  let turnEndError: string | null = null;
  try {
    await turnEnded;
  } catch (err: any) {
    turnEndError = err?.message || String(err);
    console.warn(`[${PROBE}] 用例 ${spec.id}: ${turnEndError}`);
  }

  offRoot();

  // ── 分析
  const chunkTypes: Record<string, number> = {};
  const textDeltas: string[] = [];
  const frameTypes: string[] = [];
  const revisions: number[] = [];
  const indices: number[] = [];
  let endOutcome: unknown = null;

  for (const f of framesRoot) {
    if (!f) continue;
    frameTypes.push(f.type);
    if (typeof f.revision === 'number') revisions.push(f.revision);
    if (f.type === 'chunk') {
      const t = f.chunk?.type ?? 'unknown';
      chunkTypes[t] = (chunkTypes[t] ?? 0) + 1;
      if (typeof f.index === 'number') indices.push(f.index);
      if (t === 'text-delta' && typeof f.chunk.text === 'string') textDeltas.push(f.chunk.text);
    }
    if (f.type === 'end') endOutcome = f.outcome;
  }

  const assistantMessages = sessionEvents.filter((e) => e?.type === 'assistant/message');
  const finalText = assistantMessages
    .map((e) => extractText(e?.data?.message?.content ?? e?.data?.content))
    .filter(Boolean)
    .join('');

  const streamedText = textDeltas.join('');
  const streamedNormalized = streamedText.trim();
  const finalNormalized = finalText.trim();

  const turnNums = sessionEvents
    .filter((e) => e?.type === 'turn/start' || e?.type === 'turn/end')
    .map((e) => e?.data?.turn);
  const stepNums = sessionEvents
    .filter((e) => e?.type === 'step/start')
    .map((e) => e?.data?.step);

  const result = {
    case: spec.id,
    sessionId,
    turnEndError,
    /** Q1 帧序列 */
    frameSequence: frameTypes.join(' → ') || '(无帧)',
    frameCounts: countBy(frameTypes),
    /** Q4 root 可见性 */
    rootVisible: framesRoot.length > 0,
    agentScopeVisible: framesAgent.length > 0,
    rootFrameCount: framesRoot.length,
    agentFrameCount: framesAgent.length,
    /** Q2 chunk 类型分布 */
    chunkTypes,
    hasReasoningDelta: (chunkTypes['reasoning-delta'] ?? 0) > 0,
    hasToolCallDelta: (chunkTypes['tool-call-delta'] ?? 0) > 0,
    hasBlockMarkers:
      (chunkTypes['block-start'] ?? 0) + (chunkTypes['block-end'] ?? 0) > 0,
    /** Q3 拼装一致性 */
    streamedTextLen: streamedNormalized.length,
    finalTextLen: finalNormalized.length,
    /** 只比较"流的可见文本是否是最终正文的前缀/等价"——最终正文可能由多段 assistant/message 组成 */
    streamedEqualsFinal: streamedNormalized === finalNormalized,
    streamedIsPrefixOfFinal: finalNormalized.startsWith(streamedNormalized),
    streamedTextPreview: streamedNormalized.slice(0, 200),
    finalTextPreview: finalNormalized.slice(0, 200),
    /** 时序与单调性 */
    revisionsMonotonic: isMonotonic(revisions),
    indicesMonotonic: isMonotonic(indices),
    turnNums,
    stepNums,
    assistantMessageCount: assistantMessages.length,
    endOutcome,
  };

  console.log(
    `[${PROBE}] 用例 ${spec.id}: root可见=${result.rootVisible} 帧数=${framesRoot.length} ` +
      `chunk类型=${JSON.stringify(chunkTypes)} 流式字符=${streamedNormalized.length} 最终字符=${finalNormalized.length} ` +
      `一致=${result.streamedEqualsFinal} 前缀=${result.streamedIsPrefixOfFinal}`
  );

  await handle.dispose().catch(() => {});
  return result;
}

function countBy(list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of list) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function isMonotonic(nums: number[]): boolean {
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! < nums[i - 1]!) return false;
  }
  return true;
}

function printSummary(summary: any): void {
  console.log('\n' + '='.repeat(72));
  console.log(`${PROBE} 结论摘要（原始产物见 ${RAW_PATH}）`);
  console.log('='.repeat(72));
  for (const c of summary.cases) {
    console.log(`\n用例 ${c.case}`);
    console.log(`  Q4 root 作用域是否可见      : ${c.rootVisible}  (root=${c.rootFrameCount}, agent=${c.agentFrameCount})`);
    console.log(`  Q1 帧序列                   : ${c.frameSequence}`);
    console.log(`  Q2 chunk 类型分布           : ${JSON.stringify(c.chunkTypes)}`);
    console.log(`     reasoning-delta 出现     : ${c.hasReasoningDelta}`);
    console.log(`     tool-call-delta 出现     : ${c.hasToolCallDelta}`);
    console.log(`     block 标记出现           : ${c.hasBlockMarkers}`);
    console.log(`  Q3 流式文本 vs 最终正文     : 一致=${c.streamedEqualsFinal} 前缀=${c.streamedIsPrefixOfFinal}`);
    console.log(`     流式 ${c.streamedTextLen} 字符 / 最终 ${c.finalTextLen} 字符`);
    console.log(`  revision 单调 / index 单调  : ${c.revisionsMonotonic} / ${c.indicesMonotonic}`);
    console.log(`  turn 序列 / step 序列       : ${JSON.stringify(c.turnNums)} / ${JSON.stringify(c.stepNums)}`);
    console.log(`  assistant/message 条数      : ${c.assistantMessageCount}`);
    console.log(`  end.outcome                 : ${JSON.stringify(c.endOutcome)}`);
    if (c.turnEndError) console.log(`  ️ 错误                     : ${c.turnEndError}`);
  }
  console.log('\n');
}

main();