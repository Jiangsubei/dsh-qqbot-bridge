/**
 * dsh-qqbot-bridge: 路径与文件名安全处理工具
 *
 * 提供符合 DSH 存储目录规范的路径编码 (encodeSegment) 与文件名安全过滤 (sanitizeFilename)。
 */

/**
 * 将字符串转义为安全的文件路径段（对齐 DSH 0.1.5 session-persistence-jsonl 的 encodeSegment 规范）
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * 净化外部来源的文件名（入站附件的 `filename` 是**用户可控输入**，E8 实测文件会带真实文件名）。
 * 只取 basename、去掉控制字符与路径分隔符，防止路径穿越。
 */
export function sanitizeFilename(raw: string, fallback = 'file'): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/\0/g, '').replace(/[^\w.\-()\u4e00-\u9fa5]+/g, '_').replace(/^\.+/, '');
  return cleaned || fallback;
}