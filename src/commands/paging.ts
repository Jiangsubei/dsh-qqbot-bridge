/**
 * dsh-qqbot-bridge: 列表分页状态管理
 *
 * 管理会话与工作区列表的跨页连续编号、上下翻页导航与活跃生命周期。
 */

import { LIST_PAGE_SIZE } from '../constants/index.js';
import type { PagingState, PagingStore } from '../types/index.js';

/** 一页的切片结果（含跨页连续编号所需的全局起点） */
export interface Page<T> {
  /** 钳制后的页码（1-based） */
  page: number;
  totalPages: number;
  /** 本页首项在整份列表中的 0-based 下标；全局序号 = startIndex + 本页序号 + 1 */
  startIndex: number;
  items: T[];
  hasPrev: boolean;
  hasNext: boolean;
}

/** 默认分页大小（10 条/页，D21） */
export function defaultPageSize(): number {
  return LIST_PAGE_SIZE;
}

/** 切出第 `page` 页（越界页码钳制到有效范围；空列表仍有 1 页） */
export function paginate<T>(items: readonly T[], page: number, pageSize: number = defaultPageSize()): Page<T> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : defaultPageSize();
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const rawPage = Number.isFinite(page) ? Math.floor(page) : 1;
  const clamped = Math.min(Math.max(1, rawPage), totalPages);
  const startIndex = (clamped - 1) * size;
  return {
    page: clamped,
    totalPages,
    startIndex,
    items: items.slice(startIndex, startIndex + size),
    hasPrev: clamped > 1,
    hasNext: clamped < totalPages,
  };
}

/** per-openid 分页状态存储（进程内，无 TTL） */
export function createPagingStore(): PagingStore {
  const states = new Map<string, PagingState>();
  return {
    get(openid: string): PagingState | undefined {
      return states.get(openid);
    },
    set(openid: string, state: PagingState): void {
      states.set(openid, { ...state });
    },
    clear(openid: string): void {
      states.delete(openid);
    },
  };
}