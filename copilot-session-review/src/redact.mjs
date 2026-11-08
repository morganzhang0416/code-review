/**
 * Best-effort masking for text copied into reports. Reports stay on this PC, but prompts and
 * commands can still contain credentials or customer identifiers, so they are masked and shortened.
 */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private-key]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[jwt]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[token]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [secret]'],
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|pat|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1[secret]',
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\b\d{2}-\d{4}-\d{7}-\d{2,3}\b/g, '[account]'],
  [/\b\d{7,}\b/g, '[number]'],
];

const BLOB = /[A-Za-z0-9+/=_-]{32,}/g;

function looksLikeSecretBlob(s) {
  const digits = (s.match(/\d/g) || []).length;
  const upper = (s.match(/[A-Z]/g) || []).length;
  const lower = (s.match(/[a-z]/g) || []).length;
  const separators = (s.match(/[-/]/g) || []).length;
  return digits >= 2 && upper >= 2 && lower >= 2 && separators <= 2;
}

export function redact(text) {
  if (!text) return '';
  let out = String(text);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out.replace(BLOB, (m) => (looksLikeSecretBlob(m) ? '[blob]' : m));
}

/** Single-line, redacted, truncated excerpt. */
export function snippet(text, max = 200) {
  const flat = redact(String(text || '')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** First meaningful line, used as a fallback title. */
export function titleFrom(text, max = 80) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return snippet(line || '', max);
}
