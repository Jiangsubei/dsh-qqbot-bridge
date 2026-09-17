/**
 * dsh-qqbot-bridge: Agent 工具注册（`send_file` / `send_image`）
 *
 * 为当前 DSH Agent 注册文件与图片发送工具：
 * 1. 允许 Agent 将本地生成的文件或图片主动发送给 QQ 用户；
 * 2. 基于 QQ 开放平台 `msg_type=7` 富媒体分片上传接口完成传输；
 * 3. 严格遵循 Cordis 服务的延迟注入契约（`ctx.inject(['tools'], ...)`）。
 */

import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { QQ_FILE_TYPE_FILE, QQ_FILE_TYPE_IMAGE } from '../constants/index.js';
import { t } from '../i18n/index.js';
import type { MediaSender, OutboundTarget } from '../types/index.js';
import type { Logger } from '../utils/logger.js';

/** 工具执行上下文（只声明本模块用到的面：会话身份 + 取消信号） */
export interface QqAgentToolExec {
  agent?: { session?: { id?: string } };
  signal?: AbortSignal;
}

/**
 * 工具返回的规范值结构。
 * 遵循 @deepseek-ai/dsh-tools 的 ToolOutputDefinition JsonSchemaNode 规范。
 */
export interface QqToolResult {
  success: boolean;
  error?: string;
  file_path?: string;
  file_name?: string;
  file_type?: number;
  message_id?: string | null;
}

/** `ctx.tools` 的最小结构契约（真实类型来自 `@deepseek-ai/dsh-tools`） */
/** 合法 JSON Schema 节点（够用即可，不引入 dsh-tools 依赖） */
export type QqJsonSchemaNode = Record<string, unknown>;

export interface QqToolDefinition {
  name: string;
  description: string;
  parameters: QqJsonSchemaNode;
  output: {
    schema: QqJsonSchemaNode;
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>;
  };
  execute: (args: Record<string, unknown>, exec: QqAgentToolExec) => Promise<unknown>;
}

/** `QqToolResult` 的规范 JSON Schema（真实 ToolRuntime 会用它校验 execute 的返回值） */
const QQ_TOOL_RESULT_SCHEMA: QqJsonSchemaNode = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: { type: 'string' },
    file_path: { type: 'string' },
    file_name: { type: 'string' },
    file_type: { type: 'integer' },
  },
  required: ['success'],
  additionalProperties: true,
};

export interface QqToolsService {
  register(definition: QqToolDefinition): () => void;
}

export interface QqAgentToolsOptions {
  /** 出站富媒体发送器（四步分片上传 + `msg_type=7`） */
  media: MediaSender;
  /** 解析当前工具调用应发往的 QQ 目标（由接线层注入；返回 undefined 表示无法定位，工具如实报错） */
  resolveTarget: (exec: QqAgentToolExec) => OutboundTarget | undefined | Promise<OutboundTarget | undefined>;
  logger?: Logger;
}

const DEFAULT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * 工具入参 schema。
 *
 * ⚠️ 真机验收抓到的第二个真实断链：原实现写成了 `{ file_path: { type:'string', required:true }, … }`
 * —— 这是**属性表**而不是 JSON Schema（缺 `type: 'object'` 外壳，且 `required` 位置错误）。
 * 真实 `ToolRuntime.register()` 能接受它，但**模型 API 会拒绝**：
 *   `Invalid schema for function 'send_file': schema must be a JSON Schema of 'type: "object"', got 'type: null'.`
 * 也就是说工具虽注册成功，模型一调用就报错。故此处给出规范的对象 schema，并由装配测试断言其形状。
 */
/** 工具入参 schema（描述文案取自 `src/i18n/zh-CN.ts` 的 `tools.*`） */
const SEND_PARAMETERS: QqJsonSchemaNode = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: t('tools.paramPath') },
    file_name: { type: 'string', description: t('tools.paramName') },
  },
  required: ['file_path'],
  additionalProperties: false,
};

async function executeSend(
  kind: 'image' | 'file',
  args: Record<string, unknown>,
  exec: QqAgentToolExec,
  options: QqAgentToolsOptions
): Promise<QqToolResult> {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  if (!filePath) {
    return { success: false, error: t('tools.missingPath') };
  }
  const target = await options.resolveTarget(exec);
  if (!target) {
    return { success: false, error: t('tools.noTarget') };
  }

  const declaredName = typeof args.file_name === 'string' ? args.file_name.trim() : '';
  const fileName = declaredName || path.basename(filePath);
  const fileType = kind === 'image' ? QQ_FILE_TYPE_IMAGE : QQ_FILE_TYPE_FILE;

  try {
    const result = await options.media.send(target, { path: filePath, filename: fileName, fileType });
    if (!result.ok) {
      return {
        success: false,
        error: t('tools.mediaFailed', { code: result.code ?? 'n/a', message: result.message ?? '' }).trim(),
      };
    }
    const body = result.body && typeof result.body === 'object' ? (result.body as { id?: unknown }) : undefined;
    return {
      success: true,
      file_path: filePath,
      file_name: fileName,
      file_type: fileType,
      message_id: typeof body?.id === 'string' ? body.id : null,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function createSendTool(kind: 'image' | 'file', options: QqAgentToolsOptions): QqToolDefinition {
  const label = kind === 'image' ? t('tools.kindImage') : t('tools.kindFile');
  return {
    name: kind === 'image' ? 'send_image' : 'send_file',
    description: t('tools.description', { kind: label }),
    parameters: SEND_PARAMETERS,
    output: {
      schema: QQ_TOOL_RESULT_SCHEMA,
      render: (_args, value) => {
        const result = value as QqToolResult | null;
        if (result?.success) {
          return [
            {
              type: 'text',
              text: t('tools.sent', { kind: label, name: result.file_name ?? '', path: result.file_path ?? '' }),
            },
          ];
        }
        return [
          {
            type: 'text',
            text: t('tools.failed', { kind: label, error: result?.error ?? t('tools.unknownError') }),
          },
        ];
      },
    },
    execute: (args, exec) => executeSend(kind, args, exec, options),
  };
}

/**
 * 向 DSH 工具运行时（`ctx.tools`）注册 `send_file` / `send_image`。
 * 返回卸载函数（插件 dispose 时调用）。
 */
export function registerAgentTools(ctx: Context, options: QqAgentToolsOptions): () => void {
  const log = options.logger ?? DEFAULT_LOGGER;
  const unregisters: Array<() => void> = [];
  let disposed = false;

  const tryRegister = (): boolean => {
    if (disposed || unregisters.length > 0) return true;
    const tools: QqToolsService | undefined = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') return false;
    unregisters.push(tools.register(createSendTool('file', options)));
    unregisters.push(tools.register(createSendTool('image', options)));
    log.info('已注册 agent 工具：send_file / send_image');
    return true;
  };

  if (!tryRegister()) {
    // tools 服务尚未就绪：用 cordis 官方的依赖注入等待（不是 `(ctx as any).on('ready')` 兜底）
    ctx.inject(['tools'], () => {
      tryRegister();
    });
  }

  return () => {
    disposed = true;
    for (const unregister of unregisters) {
      try {
        unregister();
      } catch (err) {
        log.warn(`卸载工具失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    unregisters.length = 0;
  };
}