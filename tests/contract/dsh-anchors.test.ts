/**
 * T3 契约测试：turn 级回复锚点（N9）
 *
 * 语义（对照 napcat `outbound/stream.ts:224-335`）：
 *   - 入站消息先 `trackPending`，`turn/start` 时把**最早一条** pending 绑到该 turn；
 *   - 同一 turn 跨 step 复用同一锚点；`turn/end` 清理；
 *   - 取锚点：turn 级绑定优先，未开 turn 时回退最近 pending；
 *   - 锚点按 openid 隔离，互不串台。
 */

import { describe, expect, it } from 'vitest';

import { createTurnAnchors, DshTurnAnchors, MAX_PENDING_PER_OPENID } from '../../src/dsh/anchors.js';
import type { OutboundTarget } from '../../src/types/index.js';

function target(openid: string, msgId: string): OutboundTarget {
  return { openid, msgId };
}

describe('DshTurnAnchors（N9）', () => {
  it('turn/start 把最早 pending 绑到该 turn，active 可取到', () => {
    const anchors = new DshTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    // turn 尚未开启时，回退到最近 pending（保证开流前首段也带锚点）
    expect(anchors.active('u1')?.msgId).toBe('m1');

    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')?.msgId).toBe('m1');
  });

  it('同一 turn 跨 step 复用同一锚点；turn 结束后清除', () => {
    const anchors = new DshTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    anchors.onTurnStart('u1', 1);
    const first = anchors.active('u1');
    expect(anchors.active('u1')).toBe(first);
    // 模拟 step 边界再取（同一 turn）
    expect(anchors.active('u1')).toBe(first);

    anchors.onTurnEnd('u1', 1);
    expect(anchors.active('u1')).toBeUndefined();
  });

  it('FIFO：多条 pending 时按最早一条绑定，剩余留给后续 turn', () => {
    const anchors = new DshTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    anchors.trackPending('m2', 'u1', target('u1', 'm2'));

    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')?.msgId).toBe('m1');

    anchors.onTurnEnd('u1', 1);
    anchors.onTurnStart('u1', 2);
    expect(anchors.active('u1')?.msgId).toBe('m2');
  });

  it('锚点按 openid 隔离，不串台', () => {
    const anchors = new DshTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    anchors.trackPending('m9', 'u2', target('u2', 'm9'));

    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')?.msgId).toBe('m1');
    expect(anchors.active('u2')?.msgId).toBe('m9');
    anchors.onTurnEnd('u1', 1);
    expect(anchors.active('u2')?.msgId).toBe('m9');
  });

  it('官方单聊适配：锚点携带的是 OutboundTarget（openid / msg_id），不是 CQ 引用', () => {
    const anchors = new DshTurnAnchors();
    const t = target('u1', 'm1');
    anchors.trackPending('m1', 'u1', t);
    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')).toEqual({ openid: 'u1', msgId: 'm1' });
  });

  it('clear 清空一切（会话销毁/被动窗口结束用）', () => {
    const anchors = new DshTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    anchors.onTurnStart('u1', 1);
    anchors.clear();
    expect(anchors.active('u1')).toBeUndefined();
    expect(anchors.pendingCount()).toBe(0);
  });

  it('pending 有界：每个 openid 只保留最近若干条，避免长跑无界增长', () => {
    const anchors = new DshTurnAnchors();
    for (let i = 0; i < MAX_PENDING_PER_OPENID + 5; i++) {
      anchors.trackPending(`m${i}`, 'u1', target('u1', `m${i}`));
    }
    expect(anchors.pendingCount()).toBe(MAX_PENDING_PER_OPENID);
    // 最旧的 5 条被丢弃，最早保留的是 m5
    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')?.msgId).toBe('m5');
  });

  it('工厂别名返回契约面实现', () => {
    const anchors = createTurnAnchors();
    anchors.trackPending('m1', 'u1', target('u1', 'm1'));
    anchors.onTurnStart('u1', 1);
    expect(anchors.active('u1')?.msgId).toBe('m1');
    anchors.onTurnEnd('u1', 1);
    anchors.clear();
  });
});