/**
 * dsh-qqbot-bridge: 配置 Schema 定义
 *
 * 采用 @deepseek-ai/schemastery 规范声明插件的各项配置模式与默认值：
 * 字段说明与 `src/i18n/zh-CN.ts` 保持同源，确保设置面板与配置元数据统一。
 */

import z from '@deepseek-ai/schemastery';
import type { PluginConfig } from '../types/index.js';
import {
  LIST_PAGE_SIZE,
  QQ_MEDIA_DEFAULT_DIR,
  QQ_MEDIA_HARD_LIMIT,
  REPLY_MAX_CHARS,
  QQ_STREAM_THROTTLE_MS,
} from '../constants/index.js';
import { zhCN } from '../i18n/index.js';

const fields = zhCN.settings.fields;

export const PluginConfigSchema = z.object({
  app_id: z.string().default('').description(fields.appId.hint).volatile(),
  app_secret: z.string().default('').role('secret').description(fields.appSecret.hint).volatile(),
  default_workspace: z.string().default('').description(fields.defaultWorkspace.hint).volatile(),
  stream_enabled: z.boolean().default(true).description(fields.streamEnabled.hint).volatile(),
  stream_throttle_ms: z.number().default(QQ_STREAM_THROTTLE_MS).description(fields.streamThrottleMs.hint).volatile(),
  allow_create_session: z.boolean().default(true).description(fields.allowCreateSession.hint).volatile(),
  media_dir: z.string().default(QQ_MEDIA_DEFAULT_DIR).description(fields.mediaDir.hint).volatile(),
  media_max_bytes: z.number().default(QQ_MEDIA_HARD_LIMIT).description(fields.mediaMaxBytes.hint).volatile(),
  reply_max_chars: z.number().default(REPLY_MAX_CHARS).description(fields.replyMaxChars.hint).volatile(),
  list_page_size: z.number().default(LIST_PAGE_SIZE).description(fields.listPageSize.hint).volatile(),
  status_show_usage: z.boolean().default(true).description(fields.statusShowUsage.hint).volatile(),
});

export type { PluginConfig };