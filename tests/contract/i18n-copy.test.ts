/**
 * 契约测试：用户可见文案集中表与文案风格红线
 *
 * 用户决策（2026-09-17，经提问工具逐项确认）：
 *   1. Web UI 卡片标题简化为「QQ 官方机器人」，副标题精简为一句；
 *   2. 字段标签只留中文通用术语（去掉 snake_case 键名后缀）；
 *   3. 占位符只留纯格式提示（去掉「例如:」前缀与个人路径示例）；
 *   4. hint 去掉决策编号、缩短为一句话；
 *   5. QQ 回执删掉「等价于 DSH 的 xxx」类官方对照与「直调官方接口」类实现说明；
 *   6. 文案统一收敛到 `src/i18n/zh-CN.ts`（组织方式借 `nyagent/src/i18n`，见方向总纲 §7.2 Y11）。
 *
 * 本测试**只断言用户可见的文案规则**，不复制任何实现逻辑：它遍历集中文案表的叶子字符串，
 * 因此后续新增文案若违反规则会自然变红（而不是靠人工评审兜）。
 */

import { describe, expect, it } from 'vitest';
import { zhCN } from '../../src/i18n/zh-CN.js';
import { t, type MessageKey } from '../../src/i18n/index.js';

interface Leaf {
  path: string;
  value: string;
}

/** 展平嵌套文案表（含数组，忽略函数/对象以外的其他类型） */
function leaves(node: unknown, prefix = ''): Leaf[] {
  if (typeof node === 'string') return [{ path: prefix, value: node }];
  if (Array.isArray(node)) return node.flatMap((item, i) => leaves(item, `${prefix}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  throw new Error(`文案表出现了非字符串叶子：${prefix}（${typeof node}）`);
}

const ALL_LEAVES = leaves(zhCN);
const ALL_KEYS = ALL_LEAVES.map((l) => l.path) as MessageKey[];

/** QQ 侧文案域（命令回执、入站提示、交互卡片、共享提示、控制层用户可见原因） */
const QQ_SCOPES = ['commands.', 'common.', 'inbound.', 'interactions.', 'control.'];

describe('契约: 集中文案表可解析且无遗漏', () => {
  it('文案表非空，且每个叶子都能经 t() 取回原文', () => {
    expect(ALL_LEAVES.length).toBeGreaterThan(80);
    for (const { path, value } of ALL_LEAVES) {
      // 含参数的模板用「模板自身声明的参数名」渲染，验证替换器真的替换掉了占位符
      const params = Object.fromEntries(
        [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => [m[1]!, `«${m[1]}»`]),
      );
      const rendered = t(path as MessageKey, params);
      expect(rendered).not.toContain('{{');
      expect(rendered).not.toContain('}}');
      if (Object.keys(params).length > 0) {
        for (const key of Object.keys(params)) expect(rendered).toContain(`«${key}»`);
      }
    }
  });

  it('参数占位符只在模板里出现，不出现空参调用也能渲染出的残缺文案', () => {
    for (const { path, value } of ALL_LEAVES) {
      if (!value.includes('{{')) continue;
      // 带参模板：渲染时缺少参数必须能被测试发现（保留原样即视为「未接线」）
      const rendered = t(path as MessageKey);
      expect(rendered, `${path} 带参但未传参时不应静默丢字`).toContain('{{');
    }
  });
});

describe('契约: 文案不得泄漏内部术语与实现细节（用户 2026-09-17 拍板）', () => {
  it('不含决策编号（D8 / D17 / D34 …）', () => {
    for (const { path, value } of ALL_LEAVES) {
      expect(value, `${path} 不得出现决策编号`).not.toMatch(/(^|[^A-Za-z0-9])D\d{1,3}([^A-Za-z0-9]|$)/);
    }
  });

  it('不含「例如」字样（占位符只留纯格式提示）', () => {
    for (const { path, value } of ALL_LEAVES) {
      expect(value, `${path} 不得出现「例如」`).not.toContain('例如');
    }
  });

  it('不含「等价于 DSH …」类官方对照与「直调官方接口」类实现说明', () => {
    for (const { path, value } of ALL_LEAVES) {
      expect(value, `${path} 不得出现官方对照`).not.toContain('等价于');
      expect(value, `${path} 不得出现实现说明`).not.toContain('直调');
      expect(value, `${path} 不得出现插件自有状态说明`).not.toContain('维护自有');
    }
  });

  it('字段标签不得回潮写回 snake_case 键名后缀', () => {
    for (const { path, value } of ALL_LEAVES) {
      // 形如「（app_id）」/「(stream_enabled)」的键名后缀一律不允许
      expect(value, `${path} 不得出现 snake_case 键名后缀`).not.toMatch(
        /[（(][a-z][a-z0-9]*(?:_[a-z0-9]+)+[）)]/,
      );
    }
  });

  it('QQ 侧文案不得出现 DSH 内部对照（设置页允许 $DSH_HOME 这一真实路径变量）', () => {
    for (const { path, value } of ALL_LEAVES) {
      if (!QQ_SCOPES.some((scope) => path.startsWith(scope))) continue;
      expect(value, `${path} 属于 QQ 侧文案，不得出现 DSH`).not.toMatch(/DSH/i);
    }
  });

  it('文案为纯文本，不含 emoji（D34）', () => {
    for (const { path, value } of ALL_LEAVES) {
      expect(value, `${path} 不得含 emoji`).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('契约: 文案表与装配同源（防止与卡片/schema 各写一套）', () => {
  // 注：卡片 Tab 与文案表的一致性断言落在 `client-settings.test.ts`（那里已 mock 平台图标）；
  // 本文件不引 React/平台依赖，保持为纯文案规则测试。
  it('插件卡片标题为「QQ 官方机器人」，且不再包含插件包名', () => {
    expect(zhCN.plugin.name).toBe('QQ 官方机器人');
    expect(zhCN.plugin.name).not.toContain('dsh-qqbot-bridge');
  });

  it('未知命令回执确实取自集中文案表（接线，而非各写一套）', async () => {
    const { formatUnknownCommandReply } = await import('../../src/commands/parse.js');
    expect(formatUnknownCommandReply('工作区')).toBe(
      t('commands.unknown.reply', { label: '/工作区' }),
    );
    expect(formatUnknownCommandReply('')).toBe(
      t('commands.unknown.reply', { label: zhCN.commands.unknown.genericLabel }),
    );
  });

  it('权限档位标签确实取自集中文案表', async () => {
    const { permissionLabel } = await import('../../src/commands/dispatch.js');
    expect(permissionLabel('workspace-write')).toBe(
      t('commands.permission.withPreset', {
        label: zhCN.commands.permission.labelEdit,
        preset: 'workspace-write',
      }),
    );
    expect(permissionLabel(undefined)).toBe(zhCN.commands.permission.unknown);
  });
});