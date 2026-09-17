/**
 * 契约测试：QQ 官方 Bot API v2 协议客户端（`QqClient`，Y1 + E7 + E4）
 *
 * 锁死的实测语义：
 *   1. REST **不抛错**：HTTP 200 但 `body.code !== 0` 同样算失败（nyagent 的关键处理，易漏）；
 *   2. `sendStreamMessage` 的失败（如 `40007`）必须作为**数据**返回（由 stream 模块决定回退）；
 *   3. token singleflight + 提前 60s 刷新；
 *   4. WS 全生命周期：HELLO（IDENTIFY/RESUME）→ heartbeat（0.8 倍间隔）→ RECONNECT → INVALID_SESSION；
 *   5. 401 → 强制刷新 token 后重试一次；
 *   6. `putPresigned` 是**裸 PUT**（E7-7：无任何附加 header）；`fetchAttachment` 是**裸 GET**（E8-1）；
 *   7. E4：`msg_type=2` 必须带非空 markdown，否则本地直接判失败（`40034011`）；且只下发
 *      `markdown.content`，**不同时下发 `content`**。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QqClient, type QqWebSocketLike, type QqWsEvent } from '../../src/qq/client.js';
import { QQ_BOT_TOKEN_URL, QQ_API_BASE, QQ_INTENT_GROUP_AND_C2C_EVENT } from '../../src/constants/index.js';
import type { Logger } from '../../src/utils/logger.js';

const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const CREDS = { appId: 'app-1', appSecret: 'secret-1' };

interface FakeCall {
  url: string;
  init: RequestInit;
}

interface FakeResponseSpec {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** 构造可控 fetch：记录全部调用，逐次返回 handler 的结果 */
function makeFetch(handler: (url: string, init: RequestInit) => FakeResponseSpec | Promise<FakeResponseSpec>): {
  fn: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const spec = await handler(url, init ?? {});
    const text = spec.text ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
    return {
      ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
      status: spec.status ?? 200,
      headers: new Headers(spec.headers ?? { 'content-type': 'application/json' }),
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

/** 极简假 WebSocket：只实现被测代码实际使用到的面 */
class FakeWebSocket implements QqWebSocketLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
  private readonly listeners = new Map<string, Array<(ev: QqWsEvent) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (ev: QqWsEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, ev: QqWsEvent = {}): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }

  emitMessage(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  sentOps(): number[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { op: number }).op);
  }

  sentPayload(op: number): Record<string, unknown> | undefined {
    const found = this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((p) => p.op === op);
    return found[found.length - 1];
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 默认处理 token 端点的 fetch（REST 用例不必各自 mock 鉴权） */
function apiFetch(
  handler: (url: string, init: RequestInit) => FakeResponseSpec | Promise<FakeResponseSpec> = () => ({})
): { fn: typeof fetch; calls: FakeCall[] } {
  return makeFetch(async (url, init) => {
    if (url === QQ_BOT_TOKEN_URL) return { body: { access_token: 'tok', expires_in: 7200 } };
    return handler(url, init);
  });
}

function gatewayFetch(
  handler: (url: string, init: RequestInit) => FakeResponseSpec | Promise<FakeResponseSpec> = () => ({})
): { fn: typeof fetch; calls: FakeCall[] } {
  return apiFetch(async (url, init) => {
    if (url.includes('/gateway') && !url.includes('/v2')) return { body: { url: 'wss://gateway.example/ws' } };
    return handler(url, init);
  });
}

function makeClient(
  fetchFn: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof QqClient>[0]> = {}
): { client: QqClient; sockets: FakeWebSocket[] } {
  FakeWebSocket.instances = [];
  const client = new QqClient({
    credentials: CREDS,
    logger: silentLogger,
    fetchFn,
    createWebSocket: (url) => new FakeWebSocket(url),
    ...overrides,
  });
  return { client, sockets: FakeWebSocket.instances };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QqClient · REST（不抛错，失败码作为数据）', () => {
  it('HTTP 200 但 body.code=40007 也算失败（不抛错）', async () => {
    const { fn } = apiFetch(() => ({ status: 200, body: { code: 40007, message: '已经提交的消息内容不可修改' } }));
    const { client } = makeClient(fn);
    const res = await client.sendStreamMessage('openid-1', { input_state: 1, index: 0, content_raw: 'x' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(String(res.code)).toBe('40007');
    expect(res.message).toContain('不可修改');
  });

  it('HTTP 500 返回 ok=false 且 status=500（不抛错）', async () => {
    const { fn } = apiFetch(() => ({ status: 500, body: { code: 50001, message: '系统错误' } }));
    const { client } = makeClient(fn);
    const res = await client.sendMessage('openid-1', { msg_type: 0, content: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('code=0 视为成功，且携带响应 body', async () => {
    const { fn } = apiFetch(() => ({ status: 200, body: { id: 'msg-1', timestamp: '1', code: 0 } }));
    const { client } = makeClient(fn);
    const res = await client.sendMessage('openid-1', { msg_type: 0, content: 'hi' });
    expect(res.ok).toBe(true);
    expect(res.body).toMatchObject({ id: 'msg-1' });
  });

  it('sendMessage 打到 /v2/users/{openid}/messages 且 openid 被 URL 编码', async () => {
    const { fn, calls } = apiFetch(() => ({ body: { id: 'm' } }));
    const { client } = makeClient(fn);
    await client.sendMessage('openid/a b', { msg_type: 0, content: 'hi' });
    const messageCall = calls.find((c) => c.url.includes('/messages'))!;
    expect(messageCall.url).toBe(`${QQ_API_BASE}/v2/users/openid%2Fa%20b/messages`);
    expect(messageCall.init.method).toBe('POST');
    expect(JSON.parse(String(messageCall.init.body))).toEqual({ msg_type: 0, content: 'hi' });
  });

  it('apiPost 打到相对 /v2 路径（分片上传三步用）', async () => {
    const { fn, calls } = apiFetch(() => ({ body: { upload_id: 'u1' } }));
    const { client } = makeClient(fn);
    await client.apiPost('/v2/users/openid-1/upload_prepare', { file_type: 1 });
    expect(calls.find((c) => c.url.includes('/upload_prepare'))!.url).toBe(
      `${QQ_API_BASE}/v2/users/openid-1/upload_prepare`
    );
  });
});

describe('QqClient · token（singleflight + 提前 60s 刷新）', () => {
  it('并发 getAccessToken 只发一次取 token 请求（singleflight）', async () => {
    const { fn, calls } = makeFetch(() => ({ body: { access_token: 't1', expires_in: 7200 } }));
    const { client } = makeClient(fn);
    const [a, b, c] = await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
    expect([a, b, c]).toEqual(['t1', 't1', 't1']);
    expect(calls.filter((x) => x.url === QQ_BOT_TOKEN_URL)).toHaveLength(1);
  });

  it('有效期剩余 >60s 时复用缓存；剩余 ≤60s 时提前刷新', async () => {
    let issued = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url === QQ_BOT_TOKEN_URL) {
        issued += 1;
        return { body: { access_token: `t${issued}`, expires_in: 61 } };
      }
      return { body: {} };
    });
    const { client } = makeClient(fn);
    expect(await client.getAccessToken()).toBe('t1');
    // 61s > 60s 余量 → 命中缓存
    expect(await client.getAccessToken()).toBe('t1');
    expect(calls.filter((x) => x.url === QQ_BOT_TOKEN_URL)).toHaveLength(1);

    const shortLived = makeFetch(() => ({ body: { access_token: 't1', expires_in: 59 } }));
    const { client: client2 } = makeClient(shortLived.fn);
    await client2.getAccessToken();
    // 59s ≤ 60s 余量 → 视为已过期，必须重新取
    expect(await client2.getAccessToken()).toBe('t1');
    expect(shortLived.calls.filter((x) => x.url === QQ_BOT_TOKEN_URL)).toHaveLength(2);
  });

  it('authHeader 返回 QQBot 前缀的 Authorization', async () => {
    const { fn } = makeFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn);
    await expect(client.authHeader()).resolves.toEqual({
      Authorization: 'QQBot tok',
      'Content-Type': 'application/json',
    });
  });

  it('REST 遇 401 时强制刷新 token 并重试一次', async () => {
    let tokenIssued = 0;
    let messageCalls = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url === QQ_BOT_TOKEN_URL) {
        tokenIssued += 1;
        return { body: { access_token: `t${tokenIssued}`, expires_in: 7200 } };
      }
      messageCalls += 1;
      if (messageCalls === 1) return { status: 401, body: { code: 401, message: 'unauthorized' } };
      return { status: 200, body: { id: 'msg-after-retry', code: 0 } };
    });
    const { client } = makeClient(fn);
    const res = await client.sendMessage('openid-1', { msg_type: 0, content: 'hi' });
    expect(res.ok).toBe(true);
    expect((res.body as { id?: string }).id).toBe('msg-after-retry');
    expect(messageCalls).toBe(2);
    expect(calls.filter((x) => x.url === QQ_BOT_TOKEN_URL)).toHaveLength(2);
  });
});

describe('QqClient · WebSocket 生命周期', () => {
  it('HELLO → IDENTIFY（携带 intents 与 QQBot token）', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client, sockets } = makeClient(fn);
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();

    const identify = ws.sentPayload(2);
    expect(identify).toBeDefined();
    const d = identify!.d as Record<string, unknown>;
    expect(d.token).toBe('QQBot tok');
    expect(d.intents).toBe(QQ_INTENT_GROUP_AND_C2C_EVENT);
    client.stop();
    expect(sockets.length).toBeGreaterThan(0);
  });

  it('READY 触发 onReady；重连后的 HELLO 走 RESUME（带 session_id/seq）', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const ready: Array<{ sessionId: string; botId: string; botName: string }> = [];
    const { client } = makeClient(fn);
    client.onReady((info) => {
      ready.push(info);
    });
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    ws.emitMessage({
      op: 0,
      s: 5,
      t: 'READY',
      d: { version: 1, session_id: 'sess-1', user: { id: 'bot-1', username: 'Bot', bot: true } },
    });
    await flush();
    expect(ready).toEqual([{ sessionId: 'sess-1', botId: 'bot-1', botName: 'Bot' }]);

    // 第二次 HELLO（重连场景）：必须 RESUME 而不是重新 IDENTIFY
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    const resume = ws.sentPayload(6);
    expect(resume).toBeDefined();
    const d = resume!.d as Record<string, unknown>;
    expect(d.session_id).toBe('sess-1');
    expect(d.seq).toBe(5);
    client.stop();
  });

  it('HELLO 后按 0.8 倍间隔发心跳（op=1，携带 lastSeq）', async () => {
    vi.useFakeTimers();
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn);
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 100 } });
    await vi.advanceTimersByTimeAsync(80);
    expect(ws.sentOps()).toContain(1);
    client.stop();
  });

  it('INVALID_SESSION（op=9）清空会话并重新 IDENTIFY', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn);
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    ws.emitMessage({
      op: 0,
      s: 3,
      t: 'READY',
      d: { version: 1, session_id: 'sess-1', user: { id: 'bot-1', username: 'Bot', bot: true } },
    });
    await flush();

    ws.emitMessage({ op: 9 });
    await flush();
    expect(ws.sentOps().filter((op) => op === 2).length).toBeGreaterThanOrEqual(2);
    // session 已清空 → 下一次 HELLO 必须重新 IDENTIFY
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    expect(ws.sentPayload(6)).toBeUndefined();
    client.stop();
  });

  it('服务端 RECONNECT（op=7）触发关闭并走退避重连', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn, { backoffDelaysMs: [10] });
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    ws.emitMessage({ op: 7 });
    await flush();
    expect(ws.closeCount).toBe(1);

    // close 事件 → 退避后新建连接
    ws.emit('close', { code: 1000, reason: 'reconnect' });
    await sleepReal(40);
    expect(FakeWebSocket.instances.length).toBe(2);
    client.stop();
  });

  it('HELLO 看门狗：连接后迟迟收不到 HELLO 时主动断开重连', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn, { helloTimeoutMs: 20, backoffDelaysMs: [10] });
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    await sleepReal(60);
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
    client.stop();
  });

  it('C2C_MESSAGE_CREATE 事件分发给 onC2CMessage', async () => {
    const { fn } = gatewayFetch(() => ({ body: { access_token: 'tok', expires_in: 7200 } }));
    const { client } = makeClient(fn);
    const events: string[] = [];
    client.onC2CMessage((ev) => {
      events.push(ev.id);
    });
    await client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('open');
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 45000 } });
    await flush();
    ws.emitMessage({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'in-1', content: 'hi' } });
    await flush();
    expect(events).toEqual(['in-1']);
    client.stop();
  });
});

describe('QqClient · 裸 PUT / 裸 GET（E7-7 / E8-1）', () => {
  it('putPresigned 是裸 PUT：无 Authorization，body 原样上传', async () => {
    const { fn, calls } = apiFetch(() => ({ status: 200 }));
    const { client } = makeClient(fn);
    const body = new Uint8Array([1, 2, 3, 4]);
    const res = await client.putPresigned('https://cos.example/part-1', body);
    expect(res).toEqual({ ok: true, status: 200 });
    const headers = calls[0]!.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
    expect(headers?.['Content-Type']).toBeUndefined();
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.body).toEqual(body);
  });

  it('fetchAttachment 是裸 GET：无鉴权头，返回字节与 content-type', async () => {
    const { fn, calls } = apiFetch(() => ({
      status: 200,
      text: 'hello',
      headers: { 'content-type': 'audio/x-wav' },
    }));
    const { client } = makeClient(fn);
    const res = await client.fetchAttachment('https://multimedia.example/a.wav');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('audio/x-wav');
    expect(Array.from(res.bytes)).toEqual(Array.from(new TextEncoder().encode('hello')));
    const headers = calls[0]!.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
    expect(calls[0]!.init.method).toBe('GET');
  });
});

describe('QqClient · E4（markdown 必填且与 content 互斥）', () => {
  it('msg_type=2 同时给 content 与 markdown：线上下发只保留 markdown.content', async () => {
    const { fn, calls } = apiFetch(() => ({ body: { id: 'm' } }));
    const { client } = makeClient(fn);
    const res = await client.sendMessage('openid-1', {
      msg_type: 2,
      content: '这段文本必须被丢弃',
      markdown: { content: '# 标题' },
    });
    expect(res.ok).toBe(true);
    const wire = JSON.parse(String(calls.find((c) => c.url.includes('/messages'))!.init.body)) as Record<string, unknown>;
    expect(wire.markdown).toEqual({ content: '# 标题' });
    // 关键断言：不得同时下发 content
    expect('content' in wire).toBe(false);
  });

  it('msg_type=2 但缺少 markdown（或 markdown 为空）→ 本地即判失败 40034011，不发请求', async () => {
    const { fn, calls } = apiFetch(() => ({ body: { id: 'm' } }));
    const { client } = makeClient(fn);

    const missing = await client.sendMessage('openid-1', { msg_type: 2, content: '只有 content' });
    expect(missing.ok).toBe(false);
    expect(String(missing.code)).toBe('40034011');

    const empty = await client.sendMessage('openid-1', { msg_type: 2, markdown: { content: '   ' } });
    expect(empty.ok).toBe(false);
    expect(String(empty.code)).toBe('40034011');

    expect(calls).toHaveLength(0);
  });

  it('msg_type=0 保留 content', async () => {
    const { fn, calls } = apiFetch(() => ({ body: { id: 'm' } }));
    const { client } = makeClient(fn);
    await client.sendMessage('openid-1', { msg_type: 0, content: '纯文本' });
    const wire = JSON.parse(String(calls.find((c) => c.url.includes('/messages'))!.init.body)) as Record<string, unknown>;
    expect(wire.content).toBe('纯文本');
  });
});