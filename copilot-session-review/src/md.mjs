/** Markdown helpers for text that came from prompts, titles, paths or commands. */
export function mdText(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_[\]<>|#])/g, '\\$1');
}

export function code(value, max = 80) {
  let s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return `\`${s.replace(/`/g, "'")}\``;
}

export function quote(value) {
  return `“${mdText(value)}”`;
}

/**
 * Agent-written Markdown flattened to one line: keeps inline code and bold, stops at the first
 * table or code block, drops heading markers, neutralises HTML and unbalanced markers after truncation.
 */
export function mdInline(value, max = 320) {
  const kept = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (/^(\||```|~~~)/.test(t)) break;
    kept.push(t.replace(/^#{1,6}\s+/, ''));
  }
  let s = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (!s) s = String(value ?? '').replace(/[|`]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  if ((s.match(/`/g) || []).length % 2) s = s.replace(/`(?=[^`]*$)/, '');
  if ((s.match(/\*\*/g) || []).length % 2) s = s.replace(/\*\*(?=(?:(?!\*\*).)*$)/, '');
  return s;
}
