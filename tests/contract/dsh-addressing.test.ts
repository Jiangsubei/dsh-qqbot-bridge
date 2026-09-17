/**
 * T3 契约测试：寻址（D23 / 设计方案 §6）
 *
 * 覆盖：序号 → path 精确 → 标题精确 → 标题模糊；**多命中不得静默取第一个**。
 * 纯函数测试，不依赖 DSH 装配（真实装配路径的寻址见 dsh-control.test.ts）。
 */

import { describe, expect, it } from 'vitest';

import { encodeSegment, AmbiguousMatchError, matchSessions, matchWorkspaces, resolveSessionMatch, resolveWorkspaceMatch } from '../../src/dsh/addressing.js';
import type { SessionRef, WorkspaceRef } from '../../src/types/index.js';

function ws(id: string, title: string, path: string, sessionIds: string[] = []): WorkspaceRef {
  return { id, title, path, sessionIds };
}

function sess(sessionId: string, title: string | undefined): SessionRef {
  const ref: SessionRef = {
    sessionId,
    workspaceId: 'ws-1',
    workspaceTitle: 'ws-1',
    archived: false,
  };
  if (title !== undefined) ref.title = title;
  return ref;
}

describe('工作区寻址（D23）', () => {
  const refs: WorkspaceRef[] = [
    ws('ws-a', 'dsh-qqbot-bridge', '/workspace/dsh-qqbot-bridge'),
    ws('ws-b', 'dsh-demo-bridge', '/workspace/dsh-demo-bridge'),
    ws('ws-c', 'dsh-bridge-实验室', '/workspace/lab'),
  ];

  it('纯数字按 1-based 序号命中（跨页连续编号由调用方保证）', () => {
    expect(resolveWorkspaceMatch('2', refs)?.id).toBe('ws-b');
    expect(resolveWorkspaceMatch('1', refs)?.id).toBe('ws-a');
    expect(resolveWorkspaceMatch('0', refs)).toBeUndefined();
    expect(resolveWorkspaceMatch('99', refs)).toBeUndefined();
  });

  it('path 精确匹配优先于标题，且两侧都做规范化（尾斜杠 / ..）', () => {
    expect(resolveWorkspaceMatch('/workspace/dsh-demo-bridge/', refs)?.id).toBe('ws-b');
    expect(resolveWorkspaceMatch('/workspace/./lab', refs)?.id).toBe('ws-c');
    // 标题与路径同时可能命中时，path 优先级更高
    expect(resolveWorkspaceMatch('/workspace/lab', refs)?.id).toBe('ws-c');
  });

  it('path 不做包含式模糊匹配（未规范化一致的路径不得命中）', () => {
    expect(resolveWorkspaceMatch('/workspace', refs)).toBeUndefined();
  });

  it('标题精确匹配大小写不敏感，且优先于模糊匹配', () => {
    expect(resolveWorkspaceMatch('DSH-QQBOT-BRIDGE', refs)?.id).toBe('ws-a');
  });

  it('标题模糊匹配唯一命中时返回该工作区', () => {
    expect(resolveWorkspaceMatch('实验室', refs)?.id).toBe('ws-c');
  });

  it('多命中必须报错并给出全部候选，不得静默取第一个', () => {
    // 'bridge' 同时命中 ws-a / ws-b / ws-c（模糊包含）
    const matches = matchWorkspaces('bridge', refs);
    expect(matches.map((m) => m.ref.id)).toEqual(['ws-a', 'ws-b', 'ws-c']);
    expect(matches[0]!.kind).toBe('title-fuzzy');

    let thrown: unknown;
    try {
      resolveWorkspaceMatch('bridge', refs);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AmbiguousMatchError);
    const ambiguous = thrown as AmbiguousMatchError;
    expect(ambiguous.kind).toBe('title-fuzzy');
    expect(ambiguous.candidates.map((c) => c.id)).toEqual(['ws-a', 'ws-b', 'ws-c']);
    expect(ambiguous.message).toContain('请用序号重选');
  });

  it('同名工作区（标题允许重复）精确匹配出现歧义时同样报错', () => {
    const dup: WorkspaceRef[] = [ws('ws-1', '同名', '/tmp/a'), ws('ws-2', '同名', '/tmp/b')];
    expect(() => resolveWorkspaceMatch('同名', dup)).toThrow(AmbiguousMatchError);
  });

  it('空参数/未命中返回 undefined', () => {
    expect(resolveWorkspaceMatch('   ', refs)).toBeUndefined();
    expect(resolveWorkspaceMatch('不存在的名字', refs)).toBeUndefined();
  });
});

describe('会话寻址（D23）', () => {
  const sessions: SessionRef[] = [
    sess('session-1111', '修复流式分片'),
    sess('session-2222', '修复登录'),
    sess('session-3333', undefined),
  ];

  it('序号命中（1-based）', () => {
    expect(resolveSessionMatch('3', sessions)?.sessionId).toBe('session-3333');
    expect(resolveSessionMatch('4', sessions)).toBeUndefined();
  });

  it('标题精确 > 模糊', () => {
    expect(resolveSessionMatch('修复登录', sessions)?.sessionId).toBe('session-2222');
    expect(resolveSessionMatch('流式', sessions)?.sessionId).toBe('session-1111');
  });

  it('无标题会话不参与标题匹配，但可按完整 sessionId 兜底命中', () => {
    expect(matchSessions('修复', sessions).map((m) => m.ref.sessionId)).toEqual([
      'session-1111',
      'session-2222',
    ]);
    expect(resolveSessionMatch('session-3333', sessions)?.sessionId).toBe('session-3333');
  });

  it('多命中必须报错并列出全部候选', () => {
    expect(() => resolveSessionMatch('修复', sessions)).toThrow(AmbiguousMatchError);
    expect(matchSessions('修复', sessions)).toHaveLength(2);
  });
});

describe('N4 路径编码在 addressing 目标位可用', () => {
  it('encodeSegment 与 utils/path 同源（含 V3 逃逸规则）', () => {
    expect(encodeSegment('session-1')).toBe('session-1');
    expect(encodeSegment('..')).toBe('~002E~002E');
    expect(encodeSegment('a b')).toBe('a~0020b');
  });
});