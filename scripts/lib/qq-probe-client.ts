/**
 * QQ 官方 Bot API v2 客户端（**探针版**）
 *
 * **来源**：copy 自 `~/nyagent/src/plugins/qq-gateway/client.ts`（AGENTS.md §2.4 复用优先原则）。
 * **适配点**（相对原实现）：
 *   1. WebSocket 由 `ws` 包改为 **Node 内置全局 WebSocket**（Node ≥22 提供，去掉运行时依赖）；
 *   2. 所有 REST 调用**不抛错**，统一返回 `{ ok, status, code, message, body }`
 *      —— 探针必须记录失败码（如 `40034128 被动回复时间或次数超限`）而不是中断实验；
 *   3. 凭据来源改为「env → `$DSH_HOME/.credentials.yaml` 的 refs」（D17 键名 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`）；
 *   4. 只保留探针所需能力（token / WS / 发消息 / 流式消息），**删掉**分片上传、媒体发送等 P1 不需要的部分。
 *
 * P2 实现 `src/qq/client.ts` 时，应以本文件为起点继续适配（含 401 强制刷新重试与 HELLO 看门狗）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const QQ_BOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
export const QQ_API_BASE = 'https://api.sgroup.qq.com';
export const QQ_INTENT_GROUP_AND_C2C_EVENT = 1 << 25;

export interface QQCredentials {
  appId: string;
  appSecret: string;
}

export interface QQApiResult {
  ok: boolean;
  status: number;
  /** QQ 在 HTTP 200 的 body 里也可能带业务错误码（如流式 40007） */
  code?: string | number;
  message?: string;
  body: any;
}

/** 简单 YAML 取值：只取 `refs:` 块下的 `KEY: "value"`，避免为探针引入 yaml 依赖 */
function readRefsFromCredentialsFile(dshHome: string): Record<string, string> {
  const file = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  let inRefs = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^[a-zA-Z@]/.test(line)) break; // 出了 refs 块
    if (!inRefs) continue;
    const m = /^\s{2}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 凭据解析顺序（对齐 nyagent diagnosis.ts 的四级解析思路，键名按 D17）：
 *   1. 进程环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`
 *   2. `$DSH_HOME/.credentials.yaml` 的 `refs` 同名键
 *   3. 调用方直接传入（仅内存，不落盘）
 */
export function resolveCredentials(explicit?: Partial<QQCredentials>): QQCredentials {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const refs = readRefsFromCredentialsFile(dshHome);
  const appId = process.env.QQ_BOT_APP_ID || refs.QQ_BOT_APP_ID || explicit?.appId || '';
  const appSecret = process.env.QQ_BOT_SECRET || refs.QQ_BOT_SECRET || explicit?.appSecret || '';
  if (!appId || !appSecret) {
    throw new Error(
      `凭据缺失：需要 QQ_BOT_APP_ID / QQ_BOT_SECRET（查过环境变量与 ${path.join(dshHome, '.credentials.yaml')} 的 refs）`
    );
  }
  return { appId, appSecret };
}

export interface QQProbeClientOptions {
  credentials: QQCredentials;
  logger?: (msg: string) => void;
}

export class QQProbeClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly log: (msg: string) => void;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | null = null;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private lastSeq = 0;
  private reconnectAttempts = 0;
  private isClosing = false;
  private readonly backoffDelays = [2000, 5000, 10000, 30000, 60000];

  /** 收到单聊消息的回调（含原始事件体，探针需要 message_scene.ext） */
  public onC2CMessage: ((event: any) => void) | null = null;
  /** 连接就绪（READY）回调 */
  public onReady: ((info: { sessionId: string; botId: string; botName: string }) => void) | null = null;

  constructor(options: QQProbeClientOptions) {
    this.appId = options.credentials.appId;
    this.appSecret = options.credentials.appSecret;
    this.log = options.logger ?? ((m) => console.log(m));
  }

  // ─────────────────────────────── 鉴权 ───────────────────────────────

  public async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt - now > 60_000) return this.accessToken;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      try {
        const res = await fetch(QQ_BOT_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`取 token 失败 [${res.status}]: ${text}`);
        const data = JSON.parse(text) as { access_token?: string; expires_in?: number; code?: number; message?: string };
        if (!data.access_token) {
          throw new Error(`取 token 响应异常（code=${data.code} message=${data.message ?? ''}）`);
        }
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
        this.log('[qq] access_token 已获取（有效期 %ds）'.replace('%d', String(data.expires_in ?? 7200)));
        return this.accessToken;
      } finally {
        this.tokenPromise = null;
      }
    })();
    return this.tokenPromise;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `QQBot ${await this.getAccessToken()}`, 'Content-Type': 'application/json' };
  }

  // ─────────────────────────────── Gateway ───────────────────────────────

  public async getGatewayUrl(): Promise<string> {
    const res = await fetch(`${QQ_API_BASE}/gateway`, { headers: await this.authHeaders() });
    const text = await res.text();
    if (!res.ok) throw new Error(`取 gateway 失败 [${res.status}]: ${text}`);
    return (JSON.parse(text) as { url: string }).url;
  }

  /** 建立 WS 连接并开始事件循环（含 HELLO/IDENTIFY/RESUME/heartbeat/退避重连） */
  public async start(): Promise<void> {
    this.isClosing = false;
    await this.connect();
  }

  public stop(): void {
    this.isClosing = true;
    this.clearHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    try {
      const url = await this.getGatewayUrl();
      this.log(`[qq] 连接 Gateway: ${url.split('?')[0]}`);
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        this.log('[qq] WebSocket 已连接，等待 HELLO');
        this.reconnectAttempts = 0;
      });
      ws.addEventListener('message', (ev: any) => {
        try {
          this.handlePayload(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)));
        } catch (err: any) {
          this.log(`[qq] 解析 WS 消息失败: ${err?.message}`);
        }
      });
      ws.addEventListener('close', (ev: any) => {
        this.log(`[qq] WebSocket 关闭 [${ev?.code}]: ${ev?.reason ?? ''}`);
        this.clearHeartbeat();
        if (!this.isClosing) this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        this.log('[qq] WebSocket 出错');
      });
    } catch (err: any) {
      this.log(`[qq] 建立 WS 连接失败: ${err?.message}`);
      this.scheduleReconnect();
    }
  }

  private handlePayload(payload: any): void {
    if (payload?.s !== undefined && payload?.s !== null) this.lastSeq = payload.s;

    switch (payload?.op) {
      case 10: {
        // HELLO
        const interval = payload?.d?.heartbeat_interval || 45000;
        this.startHeartbeat(Math.floor(interval * 0.8));
        if (this.sessionId) void this.sendResume();
        else void this.sendIdentify();
        break;
      }
      case 0: {
        // DISPATCH
        if (payload.t === 'READY') {
          this.sessionId = payload.d?.session_id ?? null;
          this.log(`[qq] READY：机器人 ${payload.d?.user?.username}(${payload.d?.user?.id})`);
          this.onReady?.({
            sessionId: String(this.sessionId ?? ''),
            botId: String(payload.d?.user?.id ?? ''),
            botName: String(payload.d?.user?.username ?? ''),
          });
        } else if (payload.t === 'RESUMED') {
          this.log('[qq] RESUMED');
        } else if (payload.t === 'C2C_MESSAGE_CREATE') {
          this.onC2CMessage?.(payload.d);
        }
        break;
      }
      case 11:
        break; // HEARTBEAT_ACK
      case 7:
        this.log('[qq] 服务端要求 RECONNECT');
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        break;
      case 9:
        this.log('[qq] INVALID_SESSION：重置并重新 IDENTIFY');
        this.sessionId = null;
        this.lastSeq = 0;
        void this.sendIdentify();
        break;
      default:
        break;
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.getAccessToken();
    this.sendWS({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: QQ_INTENT_GROUP_AND_C2C_EVENT,
        properties: { os: process.platform, browser: 'dsh-qqbot-bridge-probe', device: 'dsh-qqbot-bridge-probe' },
      },
    });
  }

  private async sendResume(): Promise<void> {
    const token = await this.getAccessToken();
    this.sendWS({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendWS({ op: 1, d: this.lastSeq || null }), intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendWS(payload: unknown): void {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload));
    } catch (err: any) {
      this.log(`[qq] 发送 WS 帧失败: ${err?.message}`);
    }
  }

  private scheduleReconnect(): void {
    const delay = this.backoffDelays[Math.min(this.reconnectAttempts, this.backoffDelays.length - 1)] ?? 5000;
    this.reconnectAttempts += 1;
    this.log(`[qq] ${delay}ms 后发起第 ${this.reconnectAttempts} 次重连`);
    setTimeout(() => {
      if (!this.isClosing) void this.connect();
    }, delay);
  }

  // ─────────────────────────────── REST ───────────────────────────────

  private async request(url: string, payload: unknown): Promise<QQApiResult> {
    const res = await fetch(url, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const code = body && typeof body === 'object' ? (body.code ?? body.errcode) : undefined;
    const message = body && typeof body === 'object' ? (body.message ?? body.msg ?? body.errmsg) : undefined;
    const ok = res.ok && (code === undefined || String(code) === '0');
    return { ok, status: res.status, code, message, body };
  }

  /** 发送单聊消息（`POST /v2/users/{openid}/messages`） */
  public async sendMessage(openid: string, payload: Record<string, unknown>): Promise<QQApiResult> {
    return this.request(`${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`, payload);
  }

  /** 流式发送单聊消息（`POST /v2/users/{openid}/stream_messages`） */
  public async sendStreamMessage(openid: string, payload: Record<string, unknown>): Promise<QQApiResult> {
    return this.request(`${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/stream_messages`, payload);
  }

  /** 暴露鉴权头，供探针直接调用其它官方接口（如分片上传）与预签名 URL */
  public async authHeader(): Promise<Record<string, string>> {
    return this.authHeaders();
  }

  /** 通用 POST（相对 `/v2` 的路径），供探针调用非消息类接口 */
  public async apiPost(pathname: string, payload: unknown): Promise<QQApiResult> {
    return this.request(`${QQ_API_BASE}${pathname}`, payload);
  }
}