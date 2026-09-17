/**
 * dsh-qqbot-bridge: QQ 官方 Bot API v2 协议客户端
 *
 * 封装 QQ 开放平台核心连接与通信逻辑：
 * 1. 鉴权体系：Token Singleflight 获取、提前 60s 自动刷新、401 自动重试；
 * 2. 网关连接：基于 Node.js 原生 WebSocket 的 Gateway 连接维持、心跳保活与 HELLO 看门狗、自动退避重连；
 * 3. 统一数据交互：REST 请求全量数据化处理（不抛裸异常，封装为 QqApiResult）；
 * 4. 媒体分片传输：支持预签名上传 PUT 与附件 GET。
 */

import {
  QQ_API_BASE,
  QQ_BOT_TOKEN_URL,
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_REQUEST_TIMEOUT_MS,
  QQ_TOKEN_REFRESH_MARGIN_MS,
  QQ_WS_BACKOFF_MS,
} from '../constants/index.js';
import {
  QqOpCode,
  QqErrorCode,
  type QqAccessTokenResponse,
  type QqC2CMessageEvent,
  type QqCredential,
} from '../types/qq.js';
import type {
  QqApiResult,
  QqClientLike,
  QqMessageHandler,
  QqReadyHandler,
  QqSendMessagePayload,
  QqStreamMessagePayload,
} from '../types/index.js';
import type { Logger } from '../utils/logger.js';

/** 被测代码用到的 WebSocket 最小面（便于契约测试注入假实现；Node 内置 WebSocket 是它的超集） */
export interface QqWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: QqWsEvent) => void): void;
}

export interface QqWsEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface QqClientOptions {
  credentials: QqCredential;
  logger?: Logger;
  /** 便于契约测试注入（默认全局 fetch） */
  fetchFn?: typeof fetch;
  /** 便于契约测试注入（默认 Node 内置 WebSocket） */
  createWebSocket?: (url: string) => QqWebSocketLike;
  /** 心跳间隔安全比例（默认 0.8，防止由于网络抖动错过心跳周期） */
  heartbeatIntervalRatio?: number;
  /** HELLO 看门狗：连接建立后该时长内收不到 HELLO 则判定假死并重连 */
  helloTimeoutMs?: number;
  /** 退避重连序列 */
  backoffDelaysMs?: readonly number[];
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;

const DEFAULT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Node 内置 WebSocket 具备本文件使用的全部能力（`as unknown` 仅为跨 lib 结构对齐，非 any 兜底） */
function defaultCreateWebSocket(url: string): QqWebSocketLike {
  return new WebSocket(url) as unknown as QqWebSocketLike;
}

interface RawHttpResponse {
  ok: boolean;
  status: number;
  text: string;
  contentType: string | null;
  bytes: Uint8Array;
}

export class QqClient implements QqClientLike {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string) => QqWebSocketLike;
  private readonly heartbeatIntervalRatio: number;
  private readonly helloTimeoutMs: number;
  private readonly backoffDelays: readonly number[];

  // ── token ─
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | null = null;

  // ── WebSocket ──
  private ws: QqWebSocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private helloWatchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private lastSeq = 0;
  private reconnectAttempts = 0;
  private isClosing = false;

  private messageHandler: QqMessageHandler | null = null;
  private readyHandler: QqReadyHandler | null = null;

  constructor(options: QqClientOptions) {
    this.appId = options.credentials.appId;
    this.appSecret = options.credentials.appSecret;
    this.log = options.logger ?? DEFAULT_LOGGER;
    this.fetchFn = options.fetchFn ?? fetch;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.heartbeatIntervalRatio = options.heartbeatIntervalRatio ?? 0.8;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.backoffDelays = options.backoffDelaysMs ?? QQ_WS_BACKOFF_MS;
  }

  // ─────────────────────────────── 鉴权 ──────────────────────────────

  /** 取 access_token：singleflight + 提前 60s 刷新（Y1） */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt - now > QQ_TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      try {
        const res = await this.fetchFn(QQ_BOT_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`取 access_token 失败 [${res.status}]: ${text}`);
        const data = JSON.parse(text) as QqAccessTokenResponse & { code?: number; message?: string };
        if (!data.access_token) {
          throw new Error(`取 access_token 响应异常（code=${data.code ?? 'n/a'} message=${data.message ?? ''}）`);
        }
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
        this.log.debug(`access_token 已刷新（有效期 ${data.expires_in ?? 7200}s）`);
        return this.accessToken;
      } finally {
        this.tokenPromise = null;
      }
    })();
    return this.tokenPromise;
  }

  /** 作废缓存 token（401 后强制刷新用） */
  private invalidateToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async authHeader(): Promise<Record<string, string>> {
    return { Authorization: `QQBot ${await this.getAccessToken()}`, 'Content-Type': 'application/json' };
  }

  // ─────────────────────────────── Gateway / WS ───────────────────────────────

  async start(): Promise<void> {
    this.isClosing = false;
    await this.connect();
  }

  stop(): void {
    this.isClosing = true;
    this.clearHeartbeat();
    this.clearHelloWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* 关闭失败无需上抛 */
    }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.isClosing) return;
    let url: string;
    try {
      const res = await this.fetchFn(`${QQ_API_BASE}/gateway`, {
        headers: { Authorization: `QQBot ${await this.getAccessToken()}` },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`取 gateway 失败 [${res.status}]: ${text}`);
      url = (JSON.parse(text) as { url: string }).url;
    } catch (err) {
      this.log.error(`建立 WS 连接失败：${errorMessage(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.log.debug(`连接 Gateway：${url.split('?')[0]}`);
    const ws = this.createWebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.log.debug('WebSocket 已连接，等待 HELLO');
      this.reconnectAttempts = 0;
      this.armHelloWatchdog();
    });
    ws.addEventListener('message', (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        this.handlePayload(JSON.parse(raw) as { op: number; s?: number; t?: string; d?: unknown });
      } catch (err) {
        this.log.warn(`解析 WS 消息失败：${errorMessage(err)}`);
      }
    });
    ws.addEventListener('close', (ev) => {
      this.log.warn(`WebSocket 关闭 [${ev.code ?? '?'}]：${ev.reason ?? ''}`);
      this.clearHeartbeat();
      this.clearHelloWatchdog();
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      this.log.warn('WebSocket 出错');
    });
  }

  private handlePayload(payload: { op: number; s?: number; t?: string; d?: unknown }): void {
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case QqOpCode.HELLO: {
        this.clearHelloWatchdog();
        const hello = payload.d as { heartbeat_interval?: number } | undefined;
        const interval = hello?.heartbeat_interval ?? 45000;
        this.startHeartbeat(Math.floor(interval * this.heartbeatIntervalRatio));
        if (this.sessionId) {
          this.fireAndLog(this.sendResume());
        } else {
          this.fireAndLog(this.sendIdentify());
        }
        break;
      }
      case QqOpCode.DISPATCH: {
        if (payload.t === 'READY') {
          const ready = payload.d as { session_id?: string; user?: { id?: string; username?: string } };
          this.sessionId = ready.session_id ?? null;
          this.log.info(`READY：机器人 ${ready.user?.username ?? '?'}(${ready.user?.id ?? '?'})`);
          void Promise.resolve(
            this.readyHandler?.({
              sessionId: String(this.sessionId ?? ''),
              botId: String(ready.user?.id ?? ''),
              botName: String(ready.user?.username ?? ''),
            })
          ).catch((err: unknown) => this.log.error(`onReady 处理失败：${errorMessage(err)}`));
        } else if (payload.t === 'RESUMED') {
          this.log.info('RESUMED');
        } else if (payload.t === 'C2C_MESSAGE_CREATE') {
          void Promise.resolve(this.messageHandler?.(payload.d as QqC2CMessageEvent)).catch((err: unknown) =>
            this.log.error(`onC2CMessage 处理失败：${errorMessage(err)}`)
          );
        }
        break;
      }
      case QqOpCode.HEARTBEAT_ACK:
        break;
      case QqOpCode.RECONNECT:
        this.log.warn('服务端要求 RECONNECT');
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        break;
      case QqOpCode.INVALID_SESSION:
        this.log.warn('INVALID_SESSION：重置会话并重新 IDENTIFY');
        this.sessionId = null;
        this.lastSeq = 0;
        this.fireAndLog(this.sendIdentify());
        break;
      default:
        break;
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.getAccessToken();
    this.sendWS({
      op: QqOpCode.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: QQ_INTENT_GROUP_AND_C2C_EVENT,
        properties: { os: process.platform, browser: 'dsh-qqbot-bridge', device: 'dsh-qqbot-bridge' },
      },
    });
  }

  private async sendResume(): Promise<void> {
    const token = await this.getAccessToken();
    this.sendWS({ op: QqOpCode.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    if (intervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => this.sendWS({ op: QqOpCode.HEARTBEAT, d: this.lastSeq || null }), intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** HELLO 看门狗：连接后长时间收不到 HELLO 视为假死（Y1 缺口补充） */
  private armHelloWatchdog(): void {
    this.clearHelloWatchdog();
    this.helloWatchdog = setTimeout(() => {
      this.helloWatchdog = null;
      if (this.isClosing) return;
      this.log.warn(`连接后 ${this.helloTimeoutMs}ms 未收到 HELLO，判定假死并重连`);
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    }, this.helloTimeoutMs);
  }

  private clearHelloWatchdog(): void {
    if (this.helloWatchdog) {
      clearTimeout(this.helloWatchdog);
      this.helloWatchdog = null;
    }
  }

  private sendWS(payload: unknown): void {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.log.warn(`发送 WS 帧失败：${errorMessage(err)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.isClosing || this.reconnectTimer) return;
    const delay = this.backoffDelays[Math.min(this.reconnectAttempts, this.backoffDelays.length - 1)] ?? 5000;
    this.reconnectAttempts += 1;
    this.log.info(`${delay}ms 后发起第 ${this.reconnectAttempts} 次重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isClosing) void this.connect();
    }, delay);
  }

  /** 事件回调与内部异步动作统一兜底日志，避免 unhandled rejection */
  private fireAndLog(promise: Promise<void>): void {
    void promise.catch((err: unknown) => this.log.error(`WS 内部动作失败：${errorMessage(err)}`));
  }

  // ─────────────────────────────── REST ───────────────────────────────

  private async rawRequest(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }
  ): Promise<RawHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${QQ_REQUEST_TIMEOUT_MS}ms）`)), QQ_REQUEST_TIMEOUT_MS);
    const requestInit: RequestInit = { method: init.method, headers: init.headers, signal: controller.signal };
    if (typeof init.body === 'string') {
      requestInit.body = init.body;
    } else if (init.body !== undefined) {
      // TS 5.9 的 DOM `BufferSource` 收窄为 `ArrayBufferView<ArrayBuffer>`，而分片是
      // `subarray` 视图（ArrayBufferLike）；运行时 fetch 接受任意 ArrayBufferView。
      requestInit.body = init.body as unknown as BodyInit;
    }
    try {
      const res = await this.fetchFn(url, requestInit);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      return {
        ok: res.ok,
        status: res.status,
        text,
        contentType: res.headers.get('content-type'),
        bytes,
      };
    } catch (err) {
      return { ok: false, status: 0, text: errorMessage(err), contentType: null, bytes: new Uint8Array() };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST JSON 到绝对 URL。**不抛错**：网络异常/超时 → `{ok:false,status:0}`。
   * 401 时强制刷新 token 并重试一次（Y1 缺口补充）。
   */
  private async postJson(url: string, payload: unknown, allowAuthRetry = true): Promise<QqApiResult> {
    const headers = await this.authHeader();
    const res = await this.rawRequest(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (res.status === 401 && allowAuthRetry) {
      this.log.warn('REST 401：强制刷新 access_token 后重试一次');
      this.invalidateToken();
      return this.postJson(url, payload, false);
    }
    return toApiResult(res);
  }

  /** 通用 POST（相对 `/v2`），用于 `upload_prepare` / `upload_part_finish` / `files` */
  async apiPost(pathname: string, payload: unknown): Promise<QqApiResult> {
    return this.postJson(`${QQ_API_BASE}${pathname}`, payload);
  }

  /** 发送单聊消息（`POST /v2/users/{openid}/messages`）；E4 约束在发送前本地校验并归一 */
  async sendMessage(openid: string, payload: QqSendMessagePayload): Promise<QqApiResult> {
    const prepared = normalizeMarkdownPayload(payload);
    if (prepared.error) return prepared.error;
    return this.postJson(`${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`, prepared.payload);
  }

  /** 流式发送单聊消息（`POST /v2/users/{openid}/stream_messages`）——失败也作为数据返回（E2） */
  async sendStreamMessage(openid: string, payload: QqStreamMessagePayload): Promise<QqApiResult> {
    return this.postJson(`${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/stream_messages`, payload);
  }

  /** 分片 PUT 到预签名 URL（E7-7 实测：裸 PUT + 二进制 body，无需任何附加 header） */
  async putPresigned(url: string, body: Uint8Array): Promise<{ ok: boolean; status: number }> {
    const res = await this.rawRequest(url, { method: 'PUT', body });
    return { ok: res.ok, status: res.status };
  }

  /** 下载入站附件（E8-1 实测：裸 GET 即可，无需鉴权头） */
  async fetchAttachment(
    url: string
  ): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null }> {
    const res = await this.rawRequest(url, { method: 'GET' });
    return { ok: res.ok, status: res.status, bytes: res.bytes, contentType: res.contentType };
  }

  // ─────────────────────────────── 事件注册 ───────────────────────────────

  onC2CMessage(handler: QqMessageHandler): void {
    this.messageHandler = handler;
  }

  onReady(handler: QqReadyHandler): void {
    this.readyHandler = handler;
  }
}

/** HTTP 状态与业务码统一归一化：HTTP 200 但 `body.code !== 0` 判定为失败 */
function toApiResult(res: RawHttpResponse): QqApiResult {
  let body: unknown = null;
  if (res.text) {
    try {
      body = JSON.parse(res.text) as unknown;
    } catch {
      body = res.text;
    }
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const code = record?.code ?? record?.errcode;
  const message = record?.message ?? record?.msg ?? record?.errmsg;
  const ok = res.ok && (code === undefined || String(code) === '0');
  return {
    ok,
    status: res.status,
    ...(code === undefined ? {} : { code: code as string | number }),
    ...(message === undefined ? {} : { message: String(message) }),
    body,
  };
}

/**
 * E4：`msg_type=2` 必须带非空 `markdown`（否则官方 `40034011`），
 * 且只下发 `markdown.content`——**不同时下发 `content`**。
 */
function normalizeMarkdownPayload(payload: QqSendMessagePayload): {
  payload: QqSendMessagePayload;
  error?: QqApiResult;
} {
  if (payload.msg_type !== QQ_MSG_TYPE_MARKDOWN) return { payload };
  const markdown = payload.markdown?.content;
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return {
      payload,
      error: {
        ok: false,
        status: 400,
        code: QqErrorCode.INVALID_MARKDOWN,
        message: 'msg_type=2 必须携带非空 markdown.content（E4 实测：否则官方报 40034011）',
        body: null,
      },
    };
  }
  const { content: _omittedContent, ...rest } = payload;
  return { payload: { ...rest, markdown: { content: markdown } } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}