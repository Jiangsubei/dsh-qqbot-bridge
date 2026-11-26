/**
 * dsh-qqbot-bridge: 被动回复超限/过期的主动消息兜底工具
 *
 * 原则（D9 兼容）：平时仍按被动回复下发（不做客户端预计数拦截）；
 * 仅当平台真实返回被动回复过期/超限错误码（40034005 / 40034128）时，
 * 才剥离 msg_id / event_id / msg_seq 降级为主动消息重试一次。
 */

import { QqErrorCode, type QqApiResult, type QqSendMessagePayload } from '../types/index.js';
import type { Logger } from '../utils/logger.js';

const PASSIVE_LIMIT_CODES = new Set<string>([
  QqErrorCode.PASSIVE_REPLY_EXPIRED,
  QqErrorCode.PASSIVE_REPLY_LIMIT_EXCEEDED,
]);

/** 判定返回结果是否属于被动回复过期/次数超限 */
export function isPassiveReplyLimitError(result: Pick<QqApiResult, 'ok' | 'code'>): boolean {
  if (result.ok || result.code === undefined || result.code === null) return false;
  return PASSIVE_LIMIT_CODES.has(String(result.code));
}

/** 剥离被动回复锚点与槽位号，转为纯主动消息载荷 */
export function stripPassiveReplyFields(payload: QqSendMessagePayload): QqSendMessagePayload {
  const { msg_id: _msgId, event_id: _eventId, msg_seq: _msgSeq, ...proactive } = payload;
  return proactive;
}

/**
 * 发送单条消息；若带被动锚点且真实命中 40034005 / 40034128，则降级为主动消息重试一次。
 * 返回 `{ result, fellBack }`，供多片发送在首片降级后后续片直接走主动消息。
 */
export async function sendWithProactiveFallback(
  client: { sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult> },
  openid: string,
  payload: QqSendMessagePayload,
  logger: Logger,
  label: string,
): Promise<{ result: QqApiResult; fellBack: boolean }> {
  const first = await client.sendMessage(openid, payload);
  if (first.ok || (!payload.msg_id && !payload.event_id) || !isPassiveReplyLimitError(first)) {
    return { result: first, fellBack: false };
  }
  logger.warn(
    `${label} 被动回复超限或已过期（code=${String(first.code ?? '')}），剥离锚点降级为主动消息重试一次`,
  );
  const retry = await client.sendMessage(openid, stripPassiveReplyFields(payload));
  return { result: retry, fellBack: true };
}
