/**
 * dsh-qqbot-bridge: 资源寻址算法
 *
 * 实现工作区与会话的三级寻址匹配：
 * 1. 序号命中：纯数字 → 列表第 N 项（1-based 连续序号）；
 * 2. 路径精确匹配（针对工作区：经绝对化与路径规范化比对）；
 * 3. 标题匹配：不区分大小写的精确比对优先，包含模糊匹配次之。
 *
 * 存在多个候选时严格拒绝静默降级，抛出 AmbiguousMatchError 引导用户精确选择。
 */

import { normalizePathForCompare } from './workspaces.js';
import type { SessionRef, WorkspaceRef } from '../types/index.js';

export { encodeSegment } from '../utils/path.js';

export type MatchKind = 'index' | 'path' | 'title-exact' | 'title-fuzzy';

export interface WorkspaceMatch {
  ref: WorkspaceRef;
  /** 1-based 序号（与列表展示一致） */
  index: number;
  kind: MatchKind;
}

export interface SessionMatch {
  ref: SessionRef;
  /** 1-based 序号（与分页列表的连续编号一致） */
  index: number;
  kind: MatchKind;
}

/** 命中多个候选时的显式错误——严禁静默取第一个 */
export class AmbiguousMatchError extends Error {
  readonly arg: string;
  readonly kind: MatchKind;
  readonly candidates: readonly (WorkspaceRef | SessionRef)[];

  constructor(arg: string, kind: MatchKind, candidates: readonly (WorkspaceRef | SessionRef)[]) {
    super(`"${arg}" 命中 ${candidates.length} 个候选（${kind}），请用序号重选`);
    this.name = 'AmbiguousMatchError';
    this.arg = arg;
    this.kind = kind;
    this.candidates = candidates;
  }
}

const DIGITS = /^\d+$/;

function titleEquals(title: string | undefined, wanted: string): boolean {
  return title !== undefined && title.toLowerCase() === wanted;
}

function titleContains(title: string | undefined, wanted: string): boolean {
  return title !== undefined && title.toLowerCase().includes(wanted);
}

/**
 * 按三级优先级返回**同一优先级档位**内的全部命中。
 * 返回空数组表示未命中；返回多项表示该档位存在歧义（由 `resolve*` 决定是否抛错）。
 */
export function matchWorkspaces(arg: string, refs: readonly WorkspaceRef[]): WorkspaceMatch[] {
  const raw = arg.trim();
  if (raw === '') return [];

  if (DIGITS.test(raw)) {
    const index = Number.parseInt(raw, 10);
    if (index >= 1 && index <= refs.length) {
      return [{ ref: refs[index - 1]!, index, kind: 'index' }];
    }
    return [];
  }

  const wantedPath = normalizePathForCompare(raw);
  const byPath = refs
    .map((ref, i) => ({ ref, index: i + 1, kind: 'path' as const }))
    .filter((m) => normalizePathForCompare(m.ref.path) === wantedPath);
  if (byPath.length > 0) return byPath;

  const wanted = raw.toLowerCase();
  const byExactTitle = refs
    .map((ref, i) => ({ ref, index: i + 1, kind: 'title-exact' as const }))
    .filter((m) => titleEquals(m.ref.title, wanted));
  if (byExactTitle.length > 0) return byExactTitle;

  return refs
    .map((ref, i) => ({ ref, index: i + 1, kind: 'title-fuzzy' as const }))
    .filter((m) => titleContains(m.ref.title, wanted));
}

/** 解析为唯一工作区；未命中返回 undefined，多命中抛 `AmbiguousMatchError` */
export function resolveWorkspaceMatch(arg: string, refs: readonly WorkspaceRef[]): WorkspaceRef | undefined {
  const matches = matchWorkspaces(arg, refs);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new AmbiguousMatchError(rawOf(arg), matches[0]!.kind, matches.map((m) => m.ref));
  }
  return matches[0]!.ref;
}

/**
 * 会话寻址：序号（1-based，列表须为跨页连续编号）→ 标题精确 → 标题模糊。
 * 与工作区一样，候选多于 1 时抛错而非静默取第一个。
 */
export function matchSessions(arg: string, sessions: readonly SessionRef[]): SessionMatch[] {
  const raw = arg.trim();
  if (raw === '') return [];

  if (DIGITS.test(raw)) {
    const index = Number.parseInt(raw, 10);
    if (index >= 1 && index <= sessions.length) {
      return [{ ref: sessions[index - 1]!, index, kind: 'index' }];
    }
    return [];
  }

  const wanted = raw.toLowerCase();
  const byExactTitle = sessions
    .map((ref, i) => ({ ref, index: i + 1, kind: 'title-exact' as const }))
    .filter((m) => titleEquals(m.ref.title, wanted));
  if (byExactTitle.length > 0) return byExactTitle;

  const byFuzzyTitle = sessions
    .map((ref, i) => ({ ref, index: i + 1, kind: 'title-fuzzy' as const }))
    .filter((m) => titleContains(m.ref.title, wanted));
  if (byFuzzyTitle.length > 0) return byFuzzyTitle;

  // 兜底：允许按完整 sessionId 命中（手机输入体验差，但比"找不到"更有用；不作为主路径宣传）
  return sessions
    .map((ref, i) => ({ ref, index: i + 1, kind: 'title-exact' as const }))
    .filter((m) => m.ref.sessionId === raw);
}

export function resolveSessionMatch(arg: string, sessions: readonly SessionRef[]): SessionRef | undefined {
  const matches = matchSessions(arg, sessions);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new AmbiguousMatchError(rawOf(arg), matches[0]!.kind, matches.map((m) => m.ref));
  }
  return matches[0]!.ref;
}

function rawOf(arg: string): string {
  return arg.trim();
}