/**
 * `qq/markdown.ts` 契约测试（T1）
 *
 * 依据（AGENTS.md §2.2 证据分级）：
 *   - 【实测】E5：表格 / 围栏代码块 / 行内代码 / 四级标题**全部正常渲染**（2200 字符单条未被拒）
 *     → 适配层**只做** `#标题`→`# 标题` 与字符集净化，**不做**任何降级转换；
 *   - 【实测】E3（2026-09-16）：**上限是"单次流式请求 ≈20 KiB 字节"**，与**整段累积**无关
 *     → 适配层**不再截断**（D50）：长度设防改由**调用方按 UTF-8 字节切分**（`splitByBytes`）承担；
 *   - 【实测】E6：单聊不受 URL 白名单限制 → **不剥离链接**；
 *   - 【实测】E5B：markdown 图片可用 → **不剥离图片语法**；
 *   - 【复用】Y3 `formatQQMarkdown`（nyagent `qq-gateway/stream.ts:19-22`）作为最小修补起点。
 *
 * 断言全部是"真实实现的边界用例"，不复制实现逻辑自证（AGENTS.md §3.4）。
 */

import { describe, expect, it } from 'vitest';
import { QQ_STREAM_REQUEST_MAX_BYTES } from '../../src/constants/index.js';
import { QqMarkdownAdapter, formatQQMarkdown } from '../../src/qq/markdown.js';

const adapter = new QqMarkdownAdapter();

/** 是否存在未配对的代理项（截断是否切坏了 emoji / 生成了非法 UTF-16） */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('qq/markdown · formatQQMarkdown（Y3 复用）', () => {
  it('`#标题` → `# 标题`（1~6 级都补空格）', () => {
    expect(formatQQMarkdown('#标题')).toBe('# 标题');
    expect(formatQQMarkdown('##标题')).toBe('## 标题');
    expect(formatQQMarkdown('####四级标题')).toBe('#### 四级标题');
    expect(formatQQMarkdown('######六级')).toBe('###### 六级');
  });

  it('已带空格的标题、孤立 `#`、行中 `#` 不被改动', () => {
    expect(formatQQMarkdown('# 已空格')).toBe('# 已空格');
    expect(formatQQMarkdown('#')).toBe('#');
    expect(formatQQMarkdown('行内 # 不是标题')).toBe('行内 # 不是标题');
    expect(formatQQMarkdown('正文\n\n# 标题')).toBe('正文\n\n# 标题');
  });

  it('多行逐行修补', () => {
    expect(formatQQMarkdown('#一\n正文\n##二')).toBe('# 一\n正文\n## 二');
  });

  it('toQqMarkdown 走同一修补（适配层入口不留原始 `#标题`）', () => {
    expect(adapter.toQqMarkdown('#标题')).toBe('# 标题');
    expect(adapter.toQqMarkdown('#一\n正文\n##二')).toBe('# 一\n正文\n## 二');
    expect(adapter.toQqMarkdown('# 已空格')).toBe('# 已空格');
  });

  it('空串安全', () => {
    expect(formatQQMarkdown('')).toBe('');
    expect(adapter.toQqMarkdown('')).toBe('');
  });
});

describe('qq/markdown · 不做降级转换（E5/E5B/E6 实测结论）', () => {
  it('表格语法原样保留（不降级为文本）', () => {
    const table = '| 名称 | 值 |\n| --- | --- |\n| a | 1 |';
    expect(adapter.toQqMarkdown(table)).toBe(table);
  });

  it('围栏代码块与行内代码原样保留', () => {
    const fenced = '说明：\n```js\nconst a = 1;\n```\n';
    expect(adapter.toQqMarkdown(fenced)).toBe(fenced);
    expect(adapter.toQqMarkdown('行内 `code` 保留')).toBe('行内 `code` 保留');
  });

  it('链接与图片语法不被剥离', () => {
    const link = '[腾讯网](https://www.qq.com)';
    const image = '![图](https://example.com/a.png)';
    const bare = 'https://www.qq.com';
    expect(adapter.toQqMarkdown(link)).toBe(link);
    expect(adapter.toQqMarkdown(image)).toBe(image);
    expect(adapter.toQqMarkdown(bare)).toBe(bare);
  });

  it('加粗 / 删除线 / 列表 / 引用 / 分割线原样保留', () => {
    const sample = '**粗** __粗__ ~~删~~\n- 项\n> 引用\n\n***\n';
    expect(adapter.toQqMarkdown(sample)).toBe(sample);
  });
});

describe('qq/markdown · 长度安全（D50：不再截断，改由调用方按字节切分）', () => {
  it('超长文本**不再**被截断（真机缺陷回归：6118 码点回复曾被静默切到 4000）', () => {
    const long = 'a'.repeat(6118);
    expect(adapter.toQqMarkdown(long)).toBe(long);
  });

  it('上限之内不截断（E5 实测 2200 字符单条未被拒）', () => {
    const medium = 'a'.repeat(2200);
    expect(adapter.toQqMarkdown(medium)).toBe(medium);
  });

  it('超长 emoji 文本不被截断、且不产生孤立代理项', () => {
    const emoji = '😀'.repeat(6500);
    const out = adapter.toQqMarkdown(emoji);
    expect(out).toBe(emoji);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('剔除 NUL 等 C0 控制字符，保留换行/制表', () => {
    expect(adapter.toQqMarkdown('a\u0000b\u0007c')).toBe('abc');
    expect(adapter.toQqMarkdown('a\nb\tc')).toBe('a\nb\tc');
  });

  it('孤立代理项被替换为 U+FFFD（保证合法 UTF-16）', () => {
    const out = adapter.toQqMarkdown('x\uD83Dy');
    expect(out).toBe('x\uFFFDy');
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

describe('qq/markdown · split 按字符上限切分', () => {
  it('短文本原样一段；空串得到空数组', () => {
    expect(adapter.split('abcdef', 10)).toEqual(['abcdef']);
    expect(adapter.split('', 10)).toEqual([]);
  });

  it('按上限切分且拼接可还原原文（不吞字符）', () => {
    const text = 'a'.repeat(25);
    const parts = adapter.split(text, 10);
    expect(parts).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    expect(parts.join('')).toBe(text);
  });

  it('切分不切坏 emoji（按码点边界）', () => {
    const parts = adapter.split('😀😀😀', 2);
    expect(parts).toEqual(['😀😀', '😀']);
    for (const part of parts) expect(hasLoneSurrogate(part)).toBe(false);
  });

  it('非正数 / 非有限上限被夹到 1，不进入死循环', () => {
    expect(adapter.split('abc', 0)).toEqual(['a', 'b', 'c']);
    expect(adapter.split('abc', -5)).toEqual(['a', 'b', 'c']);
    expect(adapter.split('abc', Number.NaN)).toEqual(['a', 'b', 'c']);
  });

  it('保留换行结构（不丢字符）', () => {
    const text = '第一行\n第二行\n第三行';
    expect(adapter.split(text, 5).join('')).toBe(text);
  });
});

describe('qq/markdown · splitByBytes 按 UTF-8 字节上限切分（E3 实测的设防维度）', () => {
  const LIMIT = QQ_STREAM_REQUEST_MAX_BYTES;

  it('空串 → 空数组', () => {
    expect(adapter.splitByBytes('', LIMIT)).toEqual([]);
  });

  it('ASCII：超限时切成多片，每片字节数不超上限，拼接可还原原文', () => {
    const text = 'a'.repeat(LIMIT * 2 + 37);
    const parts = adapter.splitByBytes(text, LIMIT);
    expect(parts.length).toBe(3);
    for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(LIMIT);
    expect(parts.join('')).toBe(text);
  });

  it('CJK：按字节而非字符计（1 字符 = 3 字节）', () => {
    const text = '填'.repeat(7000); // 21 000 字节
    const parts = adapter.splitByBytes(text, LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(LIMIT);
    expect(parts.join('')).toBe(text);
  });

  it('emoji：按字节切分且不切坏代理对', () => {
    const text = '😀'.repeat(3000); // 12 000 字节
    const parts = adapter.splitByBytes(text, LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(LIMIT);
      expect(hasLoneSurrogate(part)).toBe(false);
    }
    expect(parts.join('')).toBe(text);
  });

  it('上限小于单个字符的字节数时仍保证每片至少推进 1 个码点（不死循环、不产空片）', () => {
    const parts = adapter.splitByBytes('填填', 1);
    expect(parts).toEqual(['填', '填']);
  });

  it('非正数 / 非有限上限被夹到 1', () => {
    expect(adapter.splitByBytes('ab', 0).join('')).toBe('ab');
    expect(adapter.splitByBytes('ab', Number.NaN).join('')).toBe('ab');
  });

  it('优先在换行边界切分（避免把 Markdown 结构切成两半）', () => {
    const line = `${'填'.repeat(1000)}\n`; // 3001 字节/行
    const text = line.repeat(4); // 12 004 字节
    const parts = adapter.splitByBytes(text, LIMIT);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.endsWith('\n'))).toBe(true);
    expect(parts.join('')).toBe(text);
  });
});