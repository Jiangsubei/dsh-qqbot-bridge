/**
 * dsh-qqbot-bridge: 斜杠命令解析工具
 *
 * 负责将用户发送的文本消息解析为标准的命令与参数对象：
 * - 兼容半角 `/` 与全角 `／` 斜杠前缀；
 * - 纯函数解析，不产生外部副作用。
 */

import { t, zhCN } from '../i18n/index.js';

/** 主命令（两字中文，§3 命令总表） */
export const MAIN_COMMANDS: readonly string[] = [
  '会话',
  '切换',
  '新建',
  '停止',
  '状态',
  '压缩',
  '模型',
  '思考',
  '权限',
  '帮助',
];

/**
 * 列表命令的专属子命令（D22）——**非全局命令**：
 * 只在分页状态活跃时有意义；无分页时按普通命令回执提示。
 */
export const PAGING_COMMANDS: readonly string[] = ['下一页', '上一页'];

/** 全部已知命令名（`/帮助` 与 `isKnown` 用） */
export const COMMAND_NAMES: readonly string[] = [...MAIN_COMMANDS, ...PAGING_COMMANDS];

export interface ParsedCommand {
  /** 命令名（不含 `/`，已小写） */
  name: string;
  /** 命令名之后的原始输入（已 trim；大小写保留，便于模型/路径参数） */
  args: string;
}

/** 是否为斜杠命令（兼容半角 `/` 与全角 `／`） */
export function isSlashCommand(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('／');
}

/**
 * 解析斜杠命令；非斜杠输入返回 `undefined`。
 * `/` 单独输入会解析出空命令名，由上层按未知命令处理。
 */
export function parseCommand(raw: string): ParsedCommand | undefined {
  if (!isSlashCommand(raw)) return undefined;
  const trimmed = raw.trim().replace(/^／/, '/');
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return undefined;
  return {
    name: (match[1] ?? '').toLowerCase(),
    args: (match[2] ?? '').trim(),
  };
}

/** 是否为分页专属子命令（D22） */
export function isPagingCommand(name: string): boolean {
  return PAGING_COMMANDS.includes(name);
}

/** 是否为已知命令 */
export function isKnownCommand(name: string): boolean {
  return COMMAND_NAMES.includes(name.toLowerCase());
}

/**
 * 未知命令回执（C-R5：文案必须明确「该消息未发送给会话」，避免用户误以为已发出）。
 * 纯文本（D34）；文案取自 `src/i18n/zh-CN.ts`。
 */
export function formatUnknownCommandReply(name: string): string {
  const label = name ? `/${name}` : zhCN.commands.unknown.genericLabel;
  return t('commands.unknown.reply', { label });
}