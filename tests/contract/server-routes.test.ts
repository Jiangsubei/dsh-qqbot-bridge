import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutline14: () => null,
}));
import {
  registerConfigRoute,
  CONFIG_ROUTE_PATH,
  sendJson,
  parseJsonBody,
} from '../../src/server/routes.js';
import { DEFAULT_BASE_CONFIG } from '../../src/client/card.js';
import type { PluginConfig } from '../../src/types/index.js';

function createMockReq(method: string, body?: any): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): { res: ServerResponse; getResult: () => Promise<{ status: number; headers: any; body: any }> } {
  const res = new EventEmitter() as any;
  let statusCode = 200;
  let headers: any = {};
  const chunks: Buffer[] = [];
  let isFinished = false;

  res.writeHead = vi.fn((status: number, h?: any) => {
    statusCode = status;
    if (h) headers = { ...headers, ...h };
    return res;
  });

  res.end = vi.fn((data?: any) => {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    isFinished = true;
    res.emit('finish');
    return res;
  });

  const parseResult = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: statusCode, headers, body };
  };

  const getResult = () =>
    new Promise<{ status: number; headers: any; body: any }>((resolve) => {
      if (isFinished) {
        resolve(parseResult());
        return;
      }
      res.on('finish', () => {
        resolve(parseResult());
      });
    });

  return { res, getResult };
}

describe('契约测试: 服务端配置 REST API 路由 (/plugins/dsh-qqbot-bridge/config)', () => {
  it('正确向 webServer 注册 exact 路径', () => {
    const registerMock = vi.fn();
    const mockCtx: any = {
      get: vi.fn((name) => (name === 'webServer' ? { register: registerMock } : undefined)),
      inject: vi.fn(),
    };

    registerConfigRoute(mockCtx, () => ({}), async () => {});

    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'exact',
        path: CONFIG_ROUTE_PATH,
        handler: expect.any(Function),
      })
    );
  });

  it('GET 请求返回当前配置，且 app_secret 始终脱敏为空字符串', async () => {
    let handler: any;
    const mockCtx: any = {
      get: vi.fn((name) =>
        name === 'webServer'
          ? {
              register: (route: any) => {
                handler = route.handler;
                return () => {};
              },
            }
          : undefined
      ),
      inject: vi.fn(),
    };

    const currentCfg: PluginConfig = {
      app_id: '10203040',
      app_secret: 'super-secret-key',
      stream_enabled: true,
      default_workspace: '/test/workspace',
    };

    registerConfigRoute(mockCtx, () => currentCfg, async () => {});

    const req = createMockReq('GET');
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.hasSecret).toBe(true);
    expect(result.body.config.app_id).toBe('10203040');
    expect(result.body.config.app_secret).toBe(''); // 绝不泄漏明文
    expect(result.body.config.default_workspace).toBe('/test/workspace');
    expect(result.body.baseDefaults).toEqual(DEFAULT_BASE_CONFIG);
  });

  it('POST 请求接收更新配置，并在 app_secret 为空时保留既有秘钥，触发 reconcile 热更新', async () => {
    let handler: any;
    const mutateMock = vi.fn().mockResolvedValue({ ok: true });
    const mockCtx: any = {
      get: vi.fn((name) => {
        if (name === 'webServer') {
          return {
            register: (route: any) => {
              handler = route.handler;
              return () => {};
            },
          };
        }
        if (name === 'settings') {
          return { mutate: mutateMock };
        }
        return undefined;
      }),
      inject: vi.fn(),
    };

    let currentCfg: PluginConfig = {
      app_id: 'old_app_id',
      app_secret: 'existing_secret',
      stream_enabled: false,
    };

    const reconcileMock = vi.fn().mockImplementation(async (next) => {
      if (next) currentCfg = { ...next };
    });

    registerConfigRoute(mockCtx, () => currentCfg, reconcileMock);

    // 提交新配置（app_secret 留空，表示保留既有秘钥）
    const updatePayload = {
      app_id: 'new_app_id_888',
      app_secret: '',
      stream_enabled: true,
      stream_throttle_ms: 500,
    };

    const req = createMockReq('POST', updatePayload);
    const { res, getResult } = createMockRes();

    await handler(req, res);
    const result = await getResult();

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.hasSecret).toBe(true);

    // 验证调用了 settings 持久化与 reconcile 热生效
    expect(reconcileMock).toHaveBeenCalled();
    const passedToReconcile = reconcileMock.mock.calls[0][0];
    expect(passedToReconcile.app_id).toBe('new_app_id_888');
    expect(passedToReconcile.app_secret).toBe('existing_secret'); // 保留了现有密钥
    expect(passedToReconcile.stream_enabled).toBe(true);
    expect(passedToReconcile.stream_throttle_ms).toBe(500);
  });
});
