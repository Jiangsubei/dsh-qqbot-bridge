/**
 * dsh-qqbot-bridge: 控制目标持久化
 *
 * 采用 DSH 官方 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain` / `domainTable` 规范，
 * 将每个 QQ 用户（openid）当前所选中的工作区与受控会话映射安全持久化。
 *
 * 只持久化控制目标指针，会话运行时的模型、思考强度及权限状态完全由 DSH 官方服务管理。
 */

import { z } from 'zod';
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain';
import type { ControlTarget } from '../types/index.js';

/** 领域内唯一的表名（须匹配 `UNIT_NAME_RE`：`^[a-z][a-z0-9_]*$`） */
export const CONTROL_TARGET_TABLE = 'targets' as const;

/** 一条持久化记录；字段与 D28 的 `{workspaceId, targetSessionId}` 一一对应 */
export const controlTargetRecord = z.object({
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
});

export type ControlTargetRecord = z.infer<typeof controlTargetRecord>;

/** 领域规格：域名同样须匹配 `UNIT_NAME_RE` */
export const controlTargetDomainSpec = defineDomain({
  name: 'qqbot_control_target',
  version: 1,
  tables: {
    targets: domainTable<string, ControlTargetRecord>(controlTargetRecord),
  },
});

/** 未选中态的规范值（D19/D27） */
export function unselectedTarget(): ControlTarget {
  return { workspaceId: null, sessionId: null };
}

/**
 * 控制目标存储接口。
 * `get` 为**同步读**（domain 的权威内存态）；`put` 为**异步durable写**，
 * 只有后端落盘成功后才在内存生效（领域实现保证：写失败不留内存分叉）。
 */
export interface TargetStore {
  get(openid: string): ControlTarget;
  put(openid: string, target: ControlTarget): Promise<void>;
  /** 启动恢复用：枚举全部已持久化记录 */
  entries(): IterableIterator<[string, ControlTarget]>;
}

class DomainTargetStore implements TargetStore {
  constructor(private readonly table: KvTable<string, ControlTargetRecord>) {}

  get(openid: string): ControlTarget {
    const record = this.table.get(openid);
    if (record === undefined) return unselectedTarget();
    return { workspaceId: record.workspaceId, sessionId: record.sessionId };
  }

  async put(openid: string, target: ControlTarget): Promise<void> {
    await this.table.put(openid, { workspaceId: target.workspaceId, sessionId: target.sessionId });
  }

  entries(): IterableIterator<[string, ControlTarget]> {
    const pairs: [string, ControlTarget][] = [];
    for (const [openid, record] of this.table.entries()) {
      pairs.push([openid, { workspaceId: record.workspaceId, sessionId: record.sessionId }]);
    }
    return pairs[Symbol.iterator]();
  }
}

/** 已打开的控制目标存储（调用方持有生命周期） */
export interface OpenedTargetStore {
  store: TargetStore;
  close(): Promise<void>;
}

/**
 * 在真实 DSH 装配上打开控制目标域。
 * 调用方（`src/index.ts` 接线层 / 契约测试）负责在插件卸载时调用 `close()`。
 */
export async function openTargetStore(ctx: { storageDomain: DomainFacility }): Promise<OpenedTargetStore> {
  const domain: Domain<typeof controlTargetDomainSpec> = await ctx.storageDomain.open(controlTargetDomainSpec);
  return {
    store: new DomainTargetStore(domain.table(CONTROL_TARGET_TABLE)),
    close: () => domain.close(),
  };
}