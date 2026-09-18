import { describe, it, expect, vi } from 'vitest';

// card.tsx 从 DSH 平台 seed 引入图标；契约测试不加载真实 DSH 客户端运行时。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}));

import { buildSettingsBridge } from '../../src/client/index.js';
import { DEFAULT_BASE_CONFIG, SETTINGS_TABS } from '../../src/client/card.js';
import { QqbotFormModel } from '../../src/client/model.js';
import { PluginConfigSchema } from '../../src/config/schema.js';
import { SETTINGS_NAMESPACE } from '../../src/constants/index.js';
import { zhCN } from '../../src/i18n/index.js';
import type { PluginConfig } from '../../src/types/index.js';

/**
 * 契约测试：WebUI 设置卡片（T5）
 *
 * 目标（AGENTS.md §3 TDD）：
 *   1. 表单模型 `QqbotFormModel` 对 `PluginConfig` **全部 11 个字段**的读写、脏检查、重置与
 *      保存时 `expectedRevision` 透传；
 *   2. `buildSettingsBridge` 的读取路径与 op 构建；
 *   3. **`SETTINGS_CONFLICT` 的 revision 重读重试**（响应式 `ok:false` 与抛异常两条路径）。
 *
 * 不依赖真实 DOM：只加载 `model.ts` / `index.tsx` / `card.tsx` 的纯函数与常量（card.tsx 的平台
 * seed 以 mock 隔离）。
 */

const ns = SETTINGS_NAMESPACE;

/** `PluginConfig` 全字段基准值（读写契约用） */
const ALL_FIELDS: Required<PluginConfig> = {
  app_id: '102000001',
  app_secret: '',
  default_workspace: '/workspace/ws',
  stream_enabled: false,
  stream_throttle_ms: 800,
  allow_create_session: false,
  media_dir: '.dsh/qqbot/media',
  media_max_bytes: 1024,
  reply_max_chars: 900,
  list_page_size: 5,
  status_show_usage: false,
};

const PLUGIN_CONFIG_KEYS = Object.keys(ALL_FIELDS) as Array<keyof PluginConfig>;

describe('契约测试: 设置卡片分区（card.tsx）', () => {
  it('按「连接 / 行为 / 文件 / 命令」四组注册 Tab', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      'connection',
      'behavior',
      'files',
      'commands',
    ]);
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['连接', '行为', '文件', '命令']);
  });

  // 用户 2026-09-17 拍板：文案统一收敛到 `src/i18n/zh-CN.ts`。Tab 标签必须真的取自那里，
  // 而不是卡片里再写一份字面量（防止集中表与卡片各写一套而无人发现）。
  it('Tab 标签取自集中文案表（不各写一套）', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual([
      zhCN.settings.tabs.connection,
      zhCN.settings.tabs.behavior,
      zhCN.settings.tabs.files,
      zhCN.settings.tabs.commands,
    ]);
  });

  // D51 修正的真缺陷回归：卡片「重置」基线此前把 media_dir 写成 `.dsh/qqbot/media`，
  // 与 schema 默认（相对 $DSH_HOME 的 `qqbot/media`）不一致 —— 卡片显示值与插件真实落点不同路径。
  // 这条断言逐字段比对「卡片基线 vs schema 解析出的默认值」，防止同类漂移再犯。
  it('卡片的 11 个字段基线默认值与 config/schema.ts 逐字段一致（不得各写一份）', () => {
    const schemaDefaults = PluginConfigSchema({}) as Required<PluginConfig>;
    for (const key of Object.keys(ALL_FIELDS) as Array<keyof PluginConfig>) {
      expect(DEFAULT_BASE_CONFIG[key], `字段 ${key} 的默认值与 schema 不一致`).toEqual(
        schemaDefaults[key],
      );
    }
  });
});

describe('契约测试: 表单模型 QqbotFormModel（PluginConfig 读写）', () => {
  it('构造时读入 initialValues 与 revision，getDraft 返回原样草稿', () => {
    const model = new QqbotFormModel({
      initialValues: ALL_FIELDS,
      revision: 7,
      baseDefaults: ALL_FIELDS,
    });

    expect(model.getRevision()).toBe(7);
    expect(model.getDraft()).toEqual(ALL_FIELDS);
    expect(model.isDirty()).toBe(false);
  });

  it('对 PluginConfig 全部 11 个字段逐个 setField / 读回', () => {
    const model = new QqbotFormModel({ initialValues: {} });
    expect(PLUGIN_CONFIG_KEYS).toHaveLength(11);

    // 逐个字段写入「非默认」值并读回，确保模型对每个 key 都无遗漏地支持读写。
    const mutated: Partial<PluginConfig> = {
      app_id: '999',
      app_secret: 'secret',
      default_workspace: '/tmp/ws2',
      stream_enabled: true,
      stream_throttle_ms: 2500,
      allow_create_session: true,
      media_dir: '/tmp/media',
      media_max_bytes: 2048,
      reply_max_chars: 42,
      list_page_size: 3,
      status_show_usage: true,
    };

    for (const key of PLUGIN_CONFIG_KEYS) {
      const before = model.getDraft()[key];
      model.setField(key, mutated[key] as never);
      expect(model.getDraft()[key]).toEqual(mutated[key]);
      expect(model.getDraft()[key]).not.toEqual(before);
    }
    expect(Object.keys(model.getDraft()).sort()).toEqual([...PLUGIN_CONFIG_KEYS].sort());
  });

  it('isDirty / discard 以 initialValues 为基准', () => {
    const model = new QqbotFormModel({ initialValues: ALL_FIELDS });
    expect(model.isDirty()).toBe(false);

    model.setField('stream_enabled', true);
    expect(model.isDirty()).toBe(true);

    model.discard();
    expect(model.isDirty()).toBe(false);
    expect(model.getDraft()).toEqual(ALL_FIELDS);
  });

  it('resetField 命中 baseDefaults 时回落到默认值，未命中时删除该 key', () => {
    const model = new QqbotFormModel({
      initialValues: {
        stream_throttle_ms: 5000,
        reply_max_chars: 800,
      },
      baseDefaults: {
        stream_throttle_ms: 1000,
      },
    });

    model.resetField('stream_throttle_ms');
    expect(model.getDraft().stream_throttle_ms).toBe(1000);

    model.resetField('reply_max_chars');
    expect('reply_max_chars' in model.getDraft()).toBe(false);
  });

  it('isOverridden 比较草稿与 baseDefaults（真实装配形态：value 与 base 同时含缺省值）', () => {
    const model = new QqbotFormModel({
      // 真实 DSH settings 行：`value` 是生效值（含 schema 缺省），`base` 是缺省值。
      initialValues: { app_id: '', list_page_size: 10, media_dir: '.dsh/qqbot/media' },
      baseDefaults: { app_id: '', list_page_size: 10, media_dir: '.dsh/qqbot/media' },
    });

    expect(model.isOverridden('app_id')).toBe(false);
    model.setField('app_id', '102000001');
    expect(model.isOverridden('app_id')).toBe(true);
    expect(model.isOverridden('list_page_size')).toBe(false);
    expect(model.isOverridden('media_dir')).toBe(false);
  });

  it('草稿缺失但 baseDefaults 有值时视为「已自定义」（copy 自 napcat 的原语义）', () => {
    const model = new QqbotFormModel({
      initialValues: {},
      baseDefaults: { list_page_size: 10 },
    });

    expect(model.isOverridden('list_page_size')).toBe(true);
    expect(model.isOverridden('status_show_usage')).toBe(false);
  });

  it('save 以本地 revision 作为 expectedRevision 提交，并采纳返回的新 revision', async () => {
    const model = new QqbotFormModel({
      initialValues: { ...ALL_FIELDS, stream_enabled: true },
      revision: 3,
    });
    model.setField('stream_enabled', false);

    const saveSettings = vi.fn().mockResolvedValue({ revision: 4 });
    await model.save({ saveSettings });

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const [values, options] = saveSettings.mock.calls[0] as [
      Partial<PluginConfig>,
      { expectedRevision: number },
    ];
    expect(options.expectedRevision).toBe(3);
    expect(values.stream_enabled).toBe(false);

    expect(model.getRevision()).toBe(4);
    expect(model.isDirty()).toBe(false); // 保存成功后 initialValues 已同步
  });

  it('save 在返回 void（官方 SettingsScopeController）时保留 revision 并同步 initialValues', async () => {
    const model = new QqbotFormModel({ initialValues: { ...ALL_FIELDS }, revision: 9 });
    model.setField('reply_max_chars', 100);

    const saveSettings = vi.fn().mockResolvedValue(undefined);
    await model.save({ saveSettings });

    expect(model.getRevision()).toBe(9);
    expect(model.isDirty()).toBe(false);
    expect(model.getDraft().reply_max_chars).toBe(100);
  });

  it('save 抛出的冲突异常向上透传（由卡片层转成 SETTINGS_CONFLICT 提示）', async () => {
    const model = new QqbotFormModel({ initialValues: { ...ALL_FIELDS }, revision: 1 });
    model.setField('app_id', 'x');

    const conflict: any = new Error('Settings document changed since it was read');
    conflict.code = 'SETTINGS_CONFLICT';

    await expect(model.save({ saveSettings: vi.fn().mockRejectedValue(conflict) })).rejects.toThrow(
      'Settings document changed since it was read'
    );
    // 冲突失败不得吞掉草稿与 revision
    expect(model.getDraft().app_id).toBe('x');
    expect(model.getRevision()).toBe(1);
  });
});

describe('契约测试: 设置卡片保存桥接 buildSettingsBridge（settingsScope.mutate）', () => {
  describe('1. 守卫契约', () => {
    it('当 ctx.settingsScope 缺失时抛出「settings API 不可用」', async () => {
      const bridge = buildSettingsBridge({}, ns);
      await expect(
        bridge.onSaveSettings({ app_id: '102000001' }, { expectedRevision: 1 })
      ).rejects.toThrow(zhCN.settings.errors.unavailable);
    });

    it('当 ctx.settingsScope.bind 返回对象没有 mutate 方法时抛出「settings API 不可用」', async () => {
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({}),
        },
      };
      const bridge = buildSettingsBridge(ctx, ns);
      await expect(
        bridge.onSaveSettings({ stream_enabled: false }, { expectedRevision: 1 })
      ).rejects.toThrow(zhCN.settings.errors.unavailable);
    });

    it('当 ctx.settingsScope 既无 bind 也无 mutate 时抛出「settings API 不可用」', async () => {
      const bridge = buildSettingsBridge({ settingsScope: {} }, ns);
      await expect(
        bridge.onSaveSettings({ list_page_size: 5 }, { expectedRevision: 1 })
      ).rejects.toThrow(zhCN.settings.errors.unavailable);
    });
  });

  describe('2. Op 构建契约', () => {
    it('逐字段构建 [{ op: "set", path: [field], value }] 格式操作数组', async () => {
      const mutateFn = vi.fn().mockResolvedValue({
        ok: true,
        value: { revision: 2 },
      });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const values: Partial<PluginConfig> = {
        app_id: '102000001',
        app_secret: '',
        media_max_bytes: 2048,
        status_show_usage: false,
      };
      await bridge.onSaveSettings(values, { expectedRevision: 6 });

      expect(mutateFn).toHaveBeenCalledTimes(1);
      expect(mutateFn.mock.calls[0][0]).toEqual([
        { op: 'set', path: ['app_id'], value: '102000001' },
        { op: 'set', path: ['app_secret'], value: '' },
        { op: 'set', path: ['media_max_bytes'], value: 2048 },
        { op: 'set', path: ['status_show_usage'], value: false },
      ]);
      expect(mutateFn.mock.calls[0][1]).toBe(6);
    });

    it('values 为空对象时构建空 ops 数组并正常返回', async () => {
      const mutateFn = vi.fn().mockResolvedValue({ ok: true, value: { revision: 3 } });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings({}, { expectedRevision: 2 });

      expect(mutateFn.mock.calls[0][0]).toEqual([]);
      expect(res).toEqual({ revision: 3 });
    });
  });

  describe('3. Mutate 调用与 Revision 返回契约', () => {
    it('当 mutate 返回 { ok: true, value: { revision } } 时正确返回 revision', async () => {
      const mutateFn = vi.fn().mockResolvedValue({ ok: true, value: { revision: 42 } });
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings({ stream_throttle_ms: 1000 }, { expectedRevision: 5 });

      expect(res).toEqual({ revision: 42 });
    });

    it('适配官方 SettingsScopeController（mutate 返回 void，经 snapshot/describe 观测新版本）', async () => {
      let currentRevision = 1;
      const currentValue: Record<string, unknown> = { stream_enabled: false };

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            { ns, revision: currentRevision, value: currentValue, base: {} },
          ],
        },
      });

      const mutateFn = vi.fn().mockImplementation(async (ops, expectedRev) => {
        for (const op of ops) {
          currentValue[op.path[0]] = op.value;
        }
        currentRevision = expectedRev + 1;
        return undefined;
      });

      const ctx = {
        settingsScope: {
          describe: () => ({ getSnapshot: mockSnapshot }),
          bind: vi.fn().mockReturnValue({
            mutate: mutateFn,
            getSnapshot: () => ({
              revision: currentRevision,
              value: currentValue,
              status: 'ready',
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { stream_enabled: true, stream_throttle_ms: 1000 },
        { expectedRevision: 1 }
      );

      expect(mutateFn).toHaveBeenCalledWith(
        [
          { op: 'set', path: ['stream_enabled'], value: true },
          { op: 'set', path: ['stream_throttle_ms'], value: 1000 },
        ],
        1
      );
      expect(res).toEqual({ revision: 2 });
      expect(bridge.revision).toBe(2);
      expect(bridge.initialConfig).toEqual({ stream_enabled: true, stream_throttle_ms: 1000 });
    });
  });

  describe('4. SETTINGS_CONFLICT 版本冲突重试契约', () => {
    it('当 mutate 响应 ok=false 且 code=SETTINGS_CONFLICT 时，重读最新 revision 并重试一次', async () => {
      let currentRevision = 1;

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: { allow_create_session: true },
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          return {
            ok: false,
            error: {
              code: 'SETTINGS_CONFLICT',
              message: 'expected revision 1, but got 2',
            },
          };
        })
        .mockImplementationOnce(async (_ops, rev) => {
          expect(rev).toBe(2);
          currentRevision = 3;
          return { ok: true, value: { revision: 3 } };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({ getSnapshot: mockSnapshot }),
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings(
        { allow_create_session: false },
        { expectedRevision: 1 }
      );

      expect(mutateFn).toHaveBeenCalledTimes(2);
      expect(mutateFn.mock.calls[1][1]).toBe(2);
      expect(res).toEqual({ revision: 3 });
    });

    it('当 mutate 抛出版本冲突异常时，重读最新 revision 并重试一次', async () => {
      let currentRevision = 1;

      const mockSnapshot = () => ({
        view: {
          namespaces: [
            {
              ns,
              revision: currentRevision,
              value: { reply_max_chars: 1500 },
              base: {},
            },
          ],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          const err: any = new Error('Settings document changed since it was read');
          err.code = 'SETTINGS_CONFLICT';
          throw err;
        })
        .mockImplementationOnce(async (_ops, rev) => {
          expect(rev).toBe(2);
          currentRevision = 3;
          return { ok: true, value: { revision: 3 } };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({ getSnapshot: mockSnapshot }),
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const res = await bridge.onSaveSettings({ reply_max_chars: 500 }, { expectedRevision: 1 });

      expect(mutateFn).toHaveBeenCalledTimes(2);
      expect(mutateFn.mock.calls[1][1]).toBe(2);
      expect(res).toEqual({ revision: 3 });
    });

    it('当重试后仍失败时，正确抛出异常（不吞冲突）', async () => {
      let currentRevision = 1;

      const mockSnapshot = () => ({
        view: {
          namespaces: [{ ns, revision: currentRevision, value: {}, base: {} }],
        },
      });

      const mutateFn = vi
        .fn()
        .mockImplementationOnce(async () => {
          currentRevision = 2;
          return { ok: false, error: { message: 'conflict error 1' } };
        })
        .mockImplementationOnce(async () => {
          return { ok: false, error: { message: 'conflict error 2' } };
        });

      const ctx = {
        settingsScope: {
          describe: () => ({ getSnapshot: mockSnapshot }),
          bind: vi.fn().mockReturnValue({ mutate: mutateFn }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      await expect(
        bridge.onSaveSettings({ list_page_size: 3 }, { expectedRevision: 1 })
      ).rejects.toThrow('conflict error 2');
      expect(mutateFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('5. 读取路径契约', () => {
    it('通过 settingsScope.describe 正确读取 initialConfig、revision 与 baseDefaults', () => {
      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: () => ({
              view: {
                namespaces: [
                  {
                    ns,
                    revision: 7,
                    value: { app_id: '102000001', stream_enabled: true },
                    base: { app_id: '', stream_enabled: true },
                  },
                ],
              },
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      expect(bridge.revision).toBe(7);
      expect(bridge.initialConfig).toEqual({ app_id: '102000001', stream_enabled: true });
      expect(bridge.baseDefaults).toEqual({ app_id: '', stream_enabled: true });
      expect(bridge.hasSecret).toBe(false);
    });

    it('当 describe 缺失时降级从 bound scope.getSnapshot() 读取', () => {
      const ctx = {
        settingsScope: {
          bind: vi.fn().mockReturnValue({
            getSnapshot: () => ({
              status: 'ready',
              revision: 4,
              value: { list_page_size: 5 },
              base: { list_page_size: 10 },
            }),
            mutate: vi.fn(),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      expect(bridge.revision).toBe(4);
      expect(bridge.initialConfig).toEqual({ list_page_size: 5 });
      expect(bridge.baseDefaults).toEqual({ list_page_size: 10 });
    });

    it('命名空间不是本插件时读不到配置（回退空快照）', () => {
      const ctx = {
        settingsScope: {
          describe: () => ({
            getSnapshot: () => ({
              view: {
                namespaces: [{ ns: 'other-plugin', revision: 3, value: { app_id: 'x' }, base: {} }],
              },
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      expect(bridge.initialConfig).toEqual({});
      expect(bridge.revision).toBe(0);
      expect(bridge.baseDefaults).toEqual({});
    });

    it('当字段被 reset 后保存，必须下发 op: "unset" 操作以从存储中清除覆盖', async () => {
      const mutate = vi.fn().mockResolvedValue({ ok: true, value: { revision: 5 } });
      const ctx = {
        settingsScope: {
          bind: () => ({
            mutate,
            getSnapshot: () => ({
              revision: 4,
              value: { stream_throttle_ms: 600, list_page_size: 10 },
            }),
          }),
        },
      };

      const bridge = buildSettingsBridge(ctx, ns);
      const model = new QqbotFormModel({
        initialValues: { stream_throttle_ms: 600, list_page_size: 10 },
        revision: 4,
        baseDefaults: { stream_throttle_ms: 400, list_page_size: 5 },
      });

      // 用户重置 stream_throttle_ms，同时修改 list_page_size
      model.resetField('stream_throttle_ms');
      model.setField('list_page_size', 20);

      await model.save({
        saveSettings: (values, options) => bridge.onSaveSettings(values, options, model.getResetFields()),
      });

      expect(mutate).toHaveBeenCalledTimes(1);
      const ops = mutate.mock.calls[0][0];
      // 包含 unset stream_throttle_ms 与 set list_page_size
      expect(ops).toContainEqual({ op: 'unset', path: ['stream_throttle_ms'] });
      expect(ops).toContainEqual({ op: 'set', path: ['list_page_size'], value: 20 });
    });

    it('数值字段输入 0 时不能被判定为 falsy 而回退成默认值', () => {
      const model = new QqbotFormModel({
        initialValues: { stream_throttle_ms: 400 },
        revision: 1,
        baseDefaults: { stream_throttle_ms: 400 },
      });

      model.setField('stream_throttle_ms', 0);
      expect(model.getDraft().stream_throttle_ms).toBe(0);
      expect(model.isDirty()).toBe(true);
      expect(model.isOverridden('stream_throttle_ms')).toBe(true);
    });
  });
});