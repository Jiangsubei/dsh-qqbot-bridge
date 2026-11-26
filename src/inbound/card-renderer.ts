/**
 * dsh-qqbot-bridge: 审批与提问卡片渲染与按钮编解码（纯函数）
 *
 * 实测约束（docs/调研纪要-交互卡片与功能增强实测-2026-11-26.md）：
 *   - K1：C2C 单聊 msg_type=2 支持附带 keyboard（InlineKeyboard）；
 *   - K2：keyboard 的 group_id 存在隐性长度限制（21 字符报 40011021，≤14 字符可用），
 *         故审批用 `ap-${nonce}`、提问用 `q-${nonce}`（均 ≤ 11 字符）；
 *   - K5：QQ 桌面端同组未点击按钮不会自动置灰，服务端必须依靠 nonce + 一次性 pending 槽位防重放；
 *   - K7：按钮 label 截断为 10 字符（超长取前 9 字 + `…`）。
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { QqInlineKeyboard, QqKeyboardRow } from '../types/qq.js';
import { t } from '../i18n/index.js';

export const BUTTON_LABEL_MAX = 10;
export const BUTTONS_PER_ROW = 2;
const COMMAND_CLIP_CHARS = 500;

export interface InteractionCardPayload {
  /** 带按钮引导的 Markdown 正文 */
  markdown: string;
  /** 按钮发送失败时的降级 Markdown 正文（引导纯文本作答） */
  fallbackMarkdown?: string;
  /** 可选内联按钮 */
  keyboard?: QqInlineKeyboard;
}

export interface ApprovalButtonData {
  t: 'approval';
  d: 'allow' | 'deny';
  n: string;
}

export interface QuestionButtonData {
  t: 'question';
  q: string;
  i: number;
}

export type InteractionButtonData = ApprovalButtonData | QuestionButtonData;

/** 截断按钮展示文本（按码点计数，最多 10 字符，实测 K7） */
export function truncateButtonLabel(raw: string | undefined): string {
  const s = String(raw ?? '').trim();
  const chars = Array.from(s);
  if (chars.length <= BUTTON_LABEL_MAX) return s;
  return `${chars.slice(0, BUTTON_LABEL_MAX - 1).join('')}…`;
}

export function encodeButtonData(data: InteractionButtonData): string {
  return JSON.stringify(data);
}

export function decodeButtonData(raw: string): InteractionButtonData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<InteractionButtonData> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (parsed.t === 'approval' && (parsed.d === 'allow' || parsed.d === 'deny') && typeof parsed.n === 'string') {
      return parsed as ApprovalButtonData;
    }
    if (parsed.t === 'question' && typeof parsed.q === 'string' && Number.isInteger(parsed.i)) {
      return parsed as QuestionButtonData;
    }
  } catch {
    // 非法 JSON 忽略
  }
  return undefined;
}

/** 从 JSON 或原始工具参数提取命令原文（优先 `.command`，否则截断原始参数） */
export function formatCommandFromArguments(rawArgs: string | undefined): string | undefined {
  if (typeof rawArgs !== 'string') return undefined;
  const trimmed = rawArgs.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && 'command' in parsed) {
      const cmd = (parsed as { command?: unknown }).command;
      if (typeof cmd === 'string' && cmd.trim()) {
        return cmd.length <= COMMAND_CLIP_CHARS ? cmd : `${cmd.slice(0, COMMAND_CLIP_CHARS)}…`;
      }
    }
  } catch {
    // 非 JSON 参数回退原文
  }
  return trimmed.length <= COMMAND_CLIP_CHARS ? trimmed : `${trimmed.slice(0, COMMAND_CLIP_CHARS)}…`;
}

/** 构建审批 Markdown 卡片与「允许一次 / 拒绝」内联按钮 */
export function buildApprovalCard(params: {
  tool: string;
  reason?: string;
  command?: string;
  nonce: string;
}): InteractionCardPayload {
  const baseLines: string[] = [
    t('interactions.approval.cardTitle'),
    '',
    t('interactions.approval.cardTool', { tool: params.tool }),
  ];
  if (params.command) {
    baseLines.push('', '```', params.command, '```');
  }
  if (params.reason) {
    baseLines.push('', t('interactions.approval.cardReason', { reason: params.reason }));
  }

  const groupId = `ap-${params.nonce}`;
  const keyboard: QqInlineKeyboard = {
    content: {
      rows: [
        {
          buttons: [
            {
              id: 'approval-allow',
              render_data: {
                label: t('interactions.approval.btnAllow'),
                visited_label: t('interactions.approval.btnAllowVisited'),
                style: 1,
              },
              action: {
                type: 1,
                permission: { type: 2 },
                click_limit: 1,
                data: encodeButtonData({ t: 'approval', d: 'allow', n: params.nonce }),
              },
              group_id: groupId,
            },
            {
              id: 'approval-deny',
              render_data: {
                label: t('interactions.approval.btnDeny'),
                visited_label: t('interactions.approval.btnDenyVisited'),
                style: 0,
              },
              action: {
                type: 1,
                permission: { type: 2 },
                click_limit: 1,
                data: encodeButtonData({ t: 'approval', d: 'deny', n: params.nonce }),
              },
              group_id: groupId,
            },
          ],
        },
      ],
    },
  };

  return {
    markdown: [...baseLines, '', t('interactions.approval.cardHintButtons')].join('\n'),
    fallbackMarkdown: [...baseLines, '', t('interactions.approval.cardHintText')].join('\n'),
    keyboard,
  };
}

/** 构建单道提问的 Markdown 卡片（单选题带 2 列按钮，多选/无选项纯文本回复） */
export function buildQuestionCard(params: {
  question: AskUserQuestionItem;
  index: number;
  total: number;
  nonce: string;
}): InteractionCardPayload {
  const q = params.question;
  const options = Array.isArray(q.options) ? q.options : [];
  const multi = q.multiSelect === true;

  const baseLines: string[] = [];
  const titlePrefix = q.header ? `[${q.header}] ` : '';
  const questionTitle = `${titlePrefix}${q.question}${multi ? t('interactions.question.multiSelectSuffix') : ''}`;
  baseLines.push(`**${questionTitle}**`);
  if (q.detail) baseLines.push(q.detail);

  if (options.length > 0) {
    baseLines.push('');
    options.forEach((o, idx) => {
      const row = t('interactions.question.optionLine', { index: idx + 1, label: o.label });
      baseLines.push(
        o.description ? `${row}${t('interactions.question.optionDesc', { description: o.description })}` : row,
      );
    });
  }

  const progressLine =
    params.total > 1
      ? t('interactions.question.hintMultiQuestion', { index: params.index + 1, total: params.total })
      : t('interactions.question.hintSingleQuestion');

  const textHintLines: string[] = [];
  if (options.length > 0) {
    textHintLines.push('', multi ? t('interactions.question.hintMulti') : t('interactions.question.hintSingle'));
  }
  textHintLines.push(progressLine);

  // 仅单选且带选项时渲染内联按钮；group_id 用 `q-${nonce}` 保证 ≤ 11 字符（K2）
  if (!multi && options.length > 0) {
    const groupId = `q-${params.nonce}`;
    const rows: QqKeyboardRow[] = [];
    for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
      rows.push({
        buttons: options.slice(i, i + BUTTONS_PER_ROW).map((o, offset) => {
          const idx = i + offset;
          return {
            id: `q-${params.nonce}-${idx}`,
            render_data: {
              label: truncateButtonLabel(o.label),
              visited_label: t('interactions.question.btnVisited'),
              style: 1,
            },
            action: {
              type: 1,
              permission: { type: 2 },
              click_limit: 1,
              data: encodeButtonData({ t: 'question', q: params.nonce, i: idx }),
            },
            group_id: groupId,
          };
        }),
      });
    }
    return {
      markdown: [...baseLines, '', t('interactions.question.hintButtons'), progressLine].join('\n'),
      fallbackMarkdown: [...baseLines, ...textHintLines].join('\n'),
      keyboard: { content: { rows } },
    };
  }

  const textOnly = [...baseLines, ...textHintLines].join('\n');
  return {
    markdown: textOnly,
    fallbackMarkdown: textOnly,
  };
}
