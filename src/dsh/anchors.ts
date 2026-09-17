/**
 * dsh-qqbot-bridge: Turn 级回复锚点绑定
 *
 * 负责将 QQ 端入站消息的被动回复上下文（msg_id、openid）与 DSH Agent 的执行 Turn 绑定：
 * 1. turn/start：登记当前活跃 turn，将对应的入站消息上下文锚定到该回合；
 * 2. turn/end：清理回合绑定，完成生命周期收敛；
 * 3. 内存保护：限制单个 openid 最大保留的 pending 锚点数，防止内存无界增长。
 */

import type { OutboundTarget, TurnAnchors } from '../types/index.js';

/** 每个 openid 最多保留的 pending 锚点数（超出丢最旧） */
export const MAX_PENDING_PER_OPENID = 8;

interface PendingAnchor {
  messageId: string;
  openid: string;
  target: OutboundTarget;
}

export class DshTurnAnchors implements TurnAnchors {
  /** 入站消息 → 待锚定上下文（保持插入顺序 = FIFO） */
  private readonly pending = new Map<string, PendingAnchor>();
  /** openid → 当前活跃 turn 号 */
  private readonly activeTurns = new Map<string, number>();
  /** openid → (turn 号 → 锚点) */
  private readonly turnTargets = new Map<string, Map<number, OutboundTarget>>();

  trackPending(messageId: string, openid: string, target: OutboundTarget): void {
    this.pending.set(messageId, { messageId, openid, target });
    this.evictOldestPending(openid);
  }

  onTurnStart(openid: string, turn: number): void {
    this.activeTurns.set(openid, turn);
    const pending = this.takeEarliestPending(openid);
    if (pending === undefined) return;
    let byTurn = this.turnTargets.get(openid);
    if (byTurn === undefined) {
      byTurn = new Map<number, OutboundTarget>();
      this.turnTargets.set(openid, byTurn);
    }
    if (!byTurn.has(turn)) byTurn.set(turn, pending.target);
  }

  active(openid: string): OutboundTarget | undefined {
    const turn = this.activeTurns.get(openid);
    if (turn !== undefined) {
      const bound = this.turnTargets.get(openid)?.get(turn);
      if (bound !== undefined) return bound;
    }
    // turn 尚未开启（或未绑定）时回退到最近一条 pending，保证开流前的首段也能带上被动回复锚点。
    return this.earliestPending(openid)?.target;
  }

  onTurnEnd(openid: string, turn: number): void {
    const byTurn = this.turnTargets.get(openid);
    if (byTurn !== undefined) {
      byTurn.delete(turn);
      if (byTurn.size === 0) this.turnTargets.delete(openid);
    }
    if (this.activeTurns.get(openid) === turn) this.activeTurns.delete(openid);
  }

  clear(): void {
    this.pending.clear();
    this.activeTurns.clear();
    this.turnTargets.clear();
  }

  /** 仅供诊断/测试：当前 pending 条数 */
  pendingCount(): number {
    return this.pending.size;
  }

  private earliestPending(openid: string): PendingAnchor | undefined {
    for (const entry of this.pending.values()) {
      if (entry.openid === openid) return entry;
    }
    return undefined;
  }

  private takeEarliestPending(openid: string): PendingAnchor | undefined {
    const found = this.earliestPending(openid);
    if (found !== undefined) this.pending.delete(found.messageId);
    return found;
  }

  private evictOldestPending(openid: string): void {
    const mine: string[] = [];
    for (const [messageId, entry] of this.pending) {
      if (entry.openid === openid) mine.push(messageId);
    }
    while (mine.length > MAX_PENDING_PER_OPENID) {
      const oldest = mine.shift();
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }
}

/** 工厂别名，便于接线层与测试按契约名构造 */
export function createTurnAnchors(): TurnAnchors {
  return new DshTurnAnchors();
}