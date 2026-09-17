#!/usr/bin/env tsx
/**
 * E12-B 探针：**跨进程**接管同一会话时的排他锁行为
 *
 * 背景：E12-A 已证明"同进程"三机制全通（`agents.get` 复用 live agent → 不触锁）。
 * 本脚本回答另一半问题：如果 QQ 桥接**没有**与 WebUI 同进程（例如用户另起一个 DSH 实例，
 * 或插件装在别的 profile），去 resume 一个正被别的进程持有的会话，会发生什么？
 *
 * 设计：两个进程共用**同一个临时 DSH_HOME**（完全隔离，不碰真实数据）——
 *   holder 角色：建会话 → 开一个长 turn → 保持存活，并打印 sessionId
 *   taker  角色：在另一个进程 boot 同一 DSH_HOME → 尝试 agents.resume(同一 sessionId) → 记录结果
 *
 * 用法：
 *   tsx scripts/probe-e12b.ts --role=holder --home=<临时目录>
 *   tsx scripts/probe-e12b.ts --role=taker  --home=<同一临时目录> --session=<sessionId>
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';

import { bootDshQqbotBridge } from '../src/boot.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const PROBE = 'E12B';
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const role = args.get('role') ?? 'holder';
const home = args.get('home') ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qqbot-e12b-')));
const LOG_DIR = path.resolve('logs/probe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const raw: Record<string, unknown>[] = [];
const rec = (o: Record<string, unknown>) => raw.push({ ts: Date.now(), ...o });
const flush = (tag: string) => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, `${PROBE}-${tag}-${stamp}.jsonl`), raw.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

const LONG_PROMPT =
  '请依次执行下面四条 shell 命令，每执行完一条用一句话说明结果，然后继续下一条：\n' +
  '1) ls -la\n2) pwd\n3) uname -a\n4) df -h\n' +
  '四条都完成后，用三句话总结。';

async function prepareHome(): Promise<void> {
  // 临时 home 需要真实 settings/credentials 才能跑模型（复制而非符号链接，避免写穿）
  const realHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  await fsp.mkdir(home, { recursive: true });
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(realHome, name);
    const dst = path.join(home, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      await fsp.copyFile(src, dst);
      await fsp.chmod(dst, 0o600).catch(() => {});
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await prepareHome();
  console.log(`[${PROBE}] role=${role} home=${home}`);

  const booted = await bootDshQqbotBridge({ dshHome: home, mountPlugin: false });
  const ctx: any = booted.ctx;
  const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  const provider = process.env.PROBE_PROVIDER || sel.provider || 'deepseek-official';
  const model = process.env.PROBE_MODEL || sel.model || 'deepseek-v4-flash';
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'e12b-cwd-'));

  try {
    if (role === 'holder') {
      const sessionId = `session-e12b-holder-${Date.now()}`;
      const handle = await ctx.agents.create({ sessionId, agentOptions: { provider, model }, meta: { cwd } });
      rec({ kind: 'note', payload: { role, sessionId } });
      console.log(`[${PROBE}] HOLDER_SESSION_ID=${sessionId}`);

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: LONG_PROMPT }], source: { kind: 'user' } }));

      // 保持存活：等它真正进入 turn 后再多活一段，给 taker 留出窗口
      let sawTurnStart = false;
      ctx.on('session/event', (session: any, event: any) => {
        if (session?.id !== sessionId) return;
        if (event?.type === 'turn/start') sawTurnStart = true;
        if (event?.type === 'turn/end') rec({ kind: 'note', payload: { holderTurnEnded: true } });
      });
      for (let i = 0; i < 100 && !sawTurnStart; i++) await sleep(200);
      console.log(`[${PROBE}] HOLDER_TURN_STARTED=${sawTurnStart} → 保持存活 180s 供 taker 探测`);
      await sleep(180_000);
      rec({ kind: 'note', payload: { holderDone: true } });
      return;
    }

    // ── taker：尝试接管 holder 正持有的同一会话
    const sessionId = args.get('session');
    if (!sessionId) throw new Error('taker 角色需要 --session=<sessionId>');

    const out: Record<string, unknown> = { role, sessionId, provider, model };
    // 1) 先看 live registry 里有没有（跨进程应为 undefined）
    const live = ctx.agents.get(sessionId);
    out.agentsGetReturnsLiveAgent = Boolean(live);
    console.log(`[${PROBE}] taker: agents.get(${sessionId}) → ${live ? '有值（同进程？）' : 'undefined（符合跨进程预期）'}`);

    // 2) 尝试 resume，观测是否撞排他锁
    const t0 = Date.now();
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider, model } });
      out.resumeOk = true;
      out.resumeMs = Date.now() - t0;
      out.resumedAgentId = handle?.agent?.id ?? null;
      console.log(`[${PROBE}] taker: agents.resume → ✅ 成功（${out.resumeMs}ms）`);
      await handle.dispose?.().catch(() => {});
    } catch (err: any) {
      out.resumeOk = false;
      out.resumeMs = Date.now() - t0;
      out.errorName = err?.name ?? err?.constructor?.name ?? null;
      out.errorMessage = err?.message ?? String(err);
      out.isOwnedError =
        String(out.errorName ?? '').includes('SessionAlreadyOwned') ||
        /already has a live persistence owner|while it is live|already owned|SessionAlreadyOwned/i.test(String(out.errorMessage));
      console.log(`[${PROBE}] taker: agents.resume → ❌ 失败 name=${out.errorName} isOwnedError=${out.isOwnedError}`);
      console.log(`[${PROBE}]         message=${String(out.errorMessage).slice(0, 300)}`);
      rec({ kind: 'res', payload: out });
    }

    rec({ kind: 'res', payload: out });
    await fsp.writeFile(path.join(LOG_DIR, `${PROBE}-taker-${stamp}.summary.json`), JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[${PROBE}] 结论: ${JSON.stringify(out, null, 2)}`);
  } finally {
    flush(role);
    await booted.dispose().catch(() => {});
    await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

void main().catch((err) => {
  console.error(`[${PROBE}] 致命错误:`, err);
  flush(role);
  process.exit(1);
});