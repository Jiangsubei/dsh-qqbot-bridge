/**
 * dsh-qqbot-bridge: QQ Markdown 语法适配层（MarkdownAdapter 实现）
 *
 * 负责将标准 Markdown 文本适配为 QQ 官方客户端友好渲染的格式：
 * 1. 规范化标题语法：修补 `#标题` 为 `# 标题`，确保移动端标题正确渲染；
 * 2. 文本完整性保护：不执行全局硬截断，长度切分由调用方在单次请求维度处理；
 * 3. 字符集净化：清洗孤立代理项（lone surrogate），确保符合标准 UTF-16/UTF-8 编码。
 */

import type { MarkdownAdapter } from '../types/index.js';

/**
 * 逐行修补标题：`#标题` → `# 标题`。
 * 规范化处理：只处理 `#` 紧跟非空白、非 `#` 的情形，已带空格的标题与孤立 `#` 保持不变。
 */
export function formatQQMarkdown(markdown: string): string {
  if (!markdown) return '';
  return markdown.replace(/^(#{1,6})([^\s#\n])/gm, '$1 $2');
}

/** 把孤立代理项替换为 U+FFFD，保证输出是合法 UTF-16（QQ 侧不会收到非法字节） */
function toWellFormedText(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD');
}

/**
 * 剔除 NUL 等 C0 控制字符（保留 `\n` `\r` `\t`）。
 * 这些字符在 pass-through 场景下会破坏客户端渲染，且无任何合法 markdown 语义。
 */
function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * 按 **UTF-8 字节数**上限切分文本（D50）。
 *
 * 语义要点：
 *   - 以**码点**为最小单位累积（`for...of`）⇒ 绝不切坏代理对（emoji / 增补平面字符）；
 *   - **优先在换行边界**断开（先按行块贪心装箱）⇒ 尽量不把 Markdown 结构切成两半；
 *   - 单个行块自身超限时才按码点硬切；
 *   - 上限小于单个码点字节数（最多 4）时，仍保证**每片至少推进 1 个码点**
 *     （不死循环、不产生空片）；
 *   - `parts.join('') === text` 恒成立（**绝不丢字符**）。
 */
export function splitByUtf8Bytes(text: string, limitBytes: number): string[] {
  if (!text) return [];
  const limit = Number.isFinite(limitBytes) && limitBytes >= 1 ? Math.floor(limitBytes) : 1;
  const parts: string[] = [];
  /** 行块（含行尾 `\n`；末行可无换行） */
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  let buf = '';
  let bufBytes = 0;
  const flush = (): void => {
    if (buf) {
      parts.push(buf);
      buf = '';
      bufBytes = 0;
    }
  };
  /** 单个行块超限：按码点硬切，余量留给后续行块继续装箱 */
  const hardSplit = (segment: string): void => {
    let cur = '';
    let curBytes = 0;
    for (const ch of segment) {
      const size = Buffer.byteLength(ch, 'utf8');
      if (curBytes + size > limit && curBytes > 0) {
        parts.push(cur);
        cur = '';
        curBytes = 0;
      }
      cur += ch;
      curBytes += size;
    }
    buf = cur;
    bufBytes = curBytes;
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > limit) {
      flush();
      hardSplit(line);
      continue;
    }
    if (bufBytes + lineBytes > limit) flush();
    buf += line;
    bufBytes += lineBytes;
  }
  flush();
  return parts;
}

/** `MarkdownAdapter` 实现：QQ markdown 最小必要修补（规范化，**不截断**） */
export class QqMarkdownAdapter implements MarkdownAdapter {
  /** 最小必要修补（Y3）：`#标题` → `# 标题`；再做字符集净化。**不做长度截断**（D50） */
  toQqMarkdown(text: string): string {
    if (!text) return '';
    return formatQQMarkdown(stripControlChars(toWellFormedText(text)));
  }

  /** 按字符（码点）上限切分为多段；空串返回空数组 */
  split(text: string, limitChars: number): string[] {
    if (!text) return [];
    const limit = Number.isFinite(limitChars) ? Math.max(1, Math.floor(limitChars)) : 1;
    const chars = Array.from(text);
    const parts: string[] = [];
    for (let i = 0; i < chars.length; i += limit) {
      parts.push(chars.slice(i, i + limit).join(''));
    }
    return parts;
  }

  /** 按 **UTF-8 字节**上限切分（D50：单次请求维度的长度设防） */
  splitByBytes(text: string, limitBytes: number): string[] {
    return splitByUtf8Bytes(text, limitBytes);
  }
}