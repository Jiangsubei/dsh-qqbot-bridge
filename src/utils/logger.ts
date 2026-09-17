/**
 * dsh-qqbot-bridge: 日志工具
 *
 * 优先使用 DSH 注入的 `ctx.logger`，不可用时自动回退至标准 console 输出。
 */

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** 创建一个 console 兜底 logger（DSH ctx.logger 不可用时使用） */
export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  return {
    info: (...a: unknown[]) => console.log(prefix, ...a),
    warn: (...a: unknown[]) => console.warn(prefix, ...a),
    error: (...a: unknown[]) => console.error(prefix, ...a),
    debug: (...a: unknown[]) => {
      if (process.env.DEBUG) console.debug(prefix, ...a);
    },
  };
}

/**
 * 把 DSH 的 `ctx.logger(name)`（可能是函数）适配成 Logger；不可用时回退 console。
 * 依 AGENTS.md §2.4「去债不去功能」：**不做 `ctx.get('x') || (ctx as any).x` 双兜底**，
 * 只做一次显式的能力判断。
 */
export function resolveLogger(ctx: { logger?: unknown }, name: string): Logger {
  const factory = (ctx as { logger?: (n: string) => Partial<Logger> }).logger;
  if (typeof factory === 'function') {
    try {
      const l = factory(name);
      if (l && typeof l.info === 'function') return l as Logger;
    } catch {
      // 回退 console
    }
  }
  return createLogger(name);
}