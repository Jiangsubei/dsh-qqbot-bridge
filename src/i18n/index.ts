/**
 * dsh-qqbot-bridge：文案解析器
 *
 * 提供零依赖的轻量文案模版解析（`t(path, params)`）：
 * 1. 编译期字面量联合类型约束（`MessageKey`），杜绝键名拼写错误；
 * 2. 键不存在时抛出明确异常；
 * 3. 服务端与 WebUI client bundle 共享同一套文案常量。
 */

import { zhCN } from './zh-CN.js';

export { zhCN };

/**
 * 取嵌套文案表里所有**字符串叶子**的点分路径。
 * 字符串以外的对象继续下钻，非字符串且非对象的叶子（如数组）不产生键
 * ——它们由调用方直接读 `zhCN`（本项目当前无此类叶子，保留以防将来误加）。
 */
type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends readonly unknown[]
      ? never
      : `${K}.${LeafPaths<T[K]>}`;
}[keyof T & string];

/** 全部可经 `t()` 取用的文案键（编译期字面量联合） */
export type MessageKey = LeafPaths<typeof zhCN>;

/** 模板参数：只接受可安全插值的基元 */
export type MessageParams = Record<string, string | number>;

function resolve(key: string): unknown {
  let current: unknown = zhCN;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 取一条文案并做 `{{name}}` 替换。
 *
 * @example
 * t('commands.sessions.switched', { title: '修 bug', id: 'session-1' })
 */
export function t(key: MessageKey, params: MessageParams = {}): string {
  const raw = resolve(key);
  if (typeof raw !== 'string') {
    throw new Error(`i18n：未找到文案键「${key}」（键名拼写错误或文案表缺项）`);
  }
  return raw.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder,
  );
}