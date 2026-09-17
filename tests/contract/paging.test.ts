/**
 * 契约测试：分页状态（`src/commands/paging.ts`）
 *
 * 覆盖决策（`docs/设计方案-命令系统与远程控制状态机.md`）：
 *   - D22 / §5：分页状态必须记住 `listKind ∈ {sessions, workspaces}`；**无超时**；
 *   - D21 / §5：10 条/页、**跨页连续编号**（第 2 页从 11 开始）。
 *
 * 说明：本测试只断言分页原语（状态存储 + 切片窗口）的可观测行为，
 * 不复制 `src/` 实现逻辑（AGENTS.md §3.4）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPagingStore, paginate, defaultPageSize } from '../../src/commands/paging.js';
import type { PagingState } from '../../src/types/index.js';

const SESSIONS_PAGE_2: PagingState = {
  listKind: 'sessions',
  workspaceId: 'ws-1',
  page: 2,
};

describe('契约: PagingStore 状态存储', () => {
  let store: ReturnType<typeof createPagingStore>;

  beforeEach(() => {
    store = createPagingStore();
  });

  it('set/get/clear 按 openid 隔离，且保留 listKind 与 workspaceId', () => {
    store.set('user-a', SESSIONS_PAGE_2);
    store.set('user-b', { listKind: 'workspaces', workspaceId: 'ws-9', page: 3 });

    expect(store.get('user-a')).toEqual(SESSIONS_PAGE_2);
    expect(store.get('user-b')).toEqual({ listKind: 'workspaces', workspaceId: 'ws-9', page: 3 });

    store.clear('user-a');
    expect(store.get('user-a')).toBeUndefined();
    // 其他 openid 的分页状态不受影响
    expect(store.get('user-b')?.page).toBe(3);
  });

  it('无分页时 get 返回 undefined', () => {
    expect(store.get('nobody')).toBeUndefined();
  });

  it('【无超时】分页状态在任意长时间后仍然存在（D22：用户明确选择不加 TTL）', () => {
    vi.useFakeTimers();
    try {
      store.set('user-a', SESSIONS_PAGE_2);
      vi.advanceTimersByTime(6 * 60 * 60 * 1000); // 6 小时
      expect(store.get('user-a')).toEqual(SESSIONS_PAGE_2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认分页大小为 10（D21）', () => {
    expect(defaultPageSize()).toBe(10);
  });
});

describe('契约: paginate 跨页连续编号窗口', () => {
  const items = Array.from({ length: 13 }, (_, i) => `s${i + 1}`);

  it('第 1 页是 1..10，第 2 页是 11..13（跨页连续编号，D21/D22）', () => {
    const p1 = paginate(items, 1, 10);
    expect(p1.items).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    // 「跨页连续编号」= 第 2 页首项在整份列表中的序号为 11
    expect(p1.startIndex + 1).toBe(1);
    expect(p1.startIndex + p1.items.length + 1).toBe(11);

    const p2 = paginate(items, 2, 10);
    expect(p2.items).toEqual(['s11', 's12', 's13']);
    // 关键断言：第 2 页的编号从 11 开始（而不是重新从 1 开始）
    expect(p2.startIndex + 1).toBe(11);
    expect(p2.totalPages).toBe(2);
    expect(p2.hasPrev).toBe(true);
    expect(p2.hasNext).toBe(false);
  });

  it('页码越界被钳制到有效范围', () => {
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, 99, 10).page).toBe(2);
    expect(paginate(items, -5, 10).page).toBe(1);
  });

  it('空列表仍有一页且页码为 1', () => {
    const p = paginate([], 1, 10);
    expect(p.items).toEqual([]);
    expect(p.page).toBe(1);
    expect(p.totalPages).toBe(1);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });

  it('可自定义分页大小（不写死 10）', () => {
    const p = paginate(items, 2, 5);
    expect(p.items).toEqual(['s6', 's7', 's8', 's9', 's10']);
    expect(p.startIndex + 1).toBe(6);
    expect(p.totalPages).toBe(3);
  });
});