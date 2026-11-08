// Portable, repository-scoped read and execution tools for local reviews.

/**
 * Repo-scoped filesystem + shell primitives — the harness layer every A2A agent
 * needs and that Copilot's own tools cannot provide headlessly (its terminal
 * tool requires a live chat invocation token; see repo notes). These are the
 * battle-tested implementations of the `read / edit / search / execute`
 * primitives an agent's `.github/agents/*.agent.md` declares, scoped to a single
 * repo root.
 *
 * Design rules:
 * - Every operation is confined to `root` by a LEXICAL containment check
 *   (`resolveInRoot`). `read`/`search` may still follow an intentional in-repo
 *   symlink that points at external code. `writeFileInRoot` additionally refuses to
 *   write THROUGH a symlink that escapes the root (realpath guard) so the agent
 *   can never clobber files outside the repo.
 * - All I/O is async (never blocks the server event loop).
 * - Output is byte-accurate and capped so a single tool call can't blow up the
 *   model context or the process memory.
 * - `search` shells out to `grep` via `execFile` (no shell) so the query is
 *   never interpreted; `execute` is the one intentional shell, used by skills
 *   (e.g. `python scripts/fetch-confluence.py`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentProgress,
  LlmTool,
  LlmToolCall,
} from "./runtime";

const execFileAsync = promisify(execFile);

/** Tunable limits; all have safe defaults. */
export interface RepoToolLimits {
  /** Max bytes returned by a read before truncation. Default 40_000. */
  maxReadBytes: number;
  /** Hard cap on file size we will even attempt to read. Default 5 MiB. */
  maxReadFileBytes: number;
  /** Max bytes returned by search/execute before truncation. Default 16_000. */
  maxOutputBytes: number;
  /** execute timeout in ms. Default 180_000. */
  execTimeoutMs: number;
  /**
   * Grace period after a graceful SIGTERM before a canceled or timed-out
   * command's process group is force-killed with SIGKILL. Default 2_000.
   */
  killGraceMs: number;
  /** search timeout in ms. Default 60_000. */
  searchTimeoutMs: number;
  /** Child-process stdout/stderr buffer cap in bytes. Default 8 MiB. */
  maxBuffer: number;
  /** Directory names `search` never descends into. Default [.git, node_modules]. */
  excludeDirs: string[];
  /**
   * Case-insensitive name globs (`*`, `?`) that `read`, `search` and `edit`
   * refuse to touch, e.g. `.env`, `.env.*`, `*.pem`, `.auth`, `output`. A path
   * is denied when ANY of its segments matches, so a denied directory hides
   * everything under it. Entries are single names, never paths. Default []
   * keeps the historical behaviour. An agent that also has `execute` can still
   * reach these files via the shell.
   */
  deniedPaths: string[];
  /**
   * Mask likely credential values (quoted, env/YAML and XML secret-key
   * assignments, Postman/HAR-style key/value header pairs, connection-string
   * and query keys, URL userinfo, Bearer/Basic auth, JWTs, private-key blocks)
   * in `read` and `search` output. Search masks each whole file BEFORE
   * matching (always via the Node engine), so multi-line secrets are masked
   * and hits cannot confirm guessed values. Heuristic; complements
   * `deniedPaths`. Default false.
   */
  redactSecrets: boolean;
}

export const DEFAULT_REPO_TOOL_LIMITS: RepoToolLimits = {
  maxReadBytes: 40_000,
  maxReadFileBytes: 5 * 1024 * 1024,
  maxOutputBytes: 16_000,
  execTimeoutMs: 180_000,
  killGraceMs: 2_000,
  searchTimeoutMs: 60_000,
  maxBuffer: 8 * 1024 * 1024,
  excludeDirs: [".git", "node_modules"],
  deniedPaths: [],
  redactSecrets: false,
};

function limitsWith(partial?: Partial<RepoToolLimits>): RepoToolLimits {
  return partial ? { ...DEFAULT_REPO_TOOL_LIMITS, ...partial } : DEFAULT_REPO_TOOL_LIMITS;
}

/** Longest model-supplied filename glob `search` accepts. */
const MAX_GLOB_LENGTH = 200;

/**
 * Match a name against a `*`/`?` wildcard pattern without RegExp, using the
 * classic two-pointer walk that backtracks only to the last `*`. Runs in
 * O(pattern × name) worst case with no catastrophic backtracking, so a
 * model-controlled glob cannot stall the event loop.
 */
export function wildcardMatch(pattern: string, name: string, ignoreCase: boolean): boolean {
  const p = ignoreCase ? pattern.toLowerCase() : pattern;
  const s = ignoreCase ? name.toLowerCase() : name;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

type NameMatcher = (name: string) => boolean;

function nameMatcher(patterns: readonly string[], ignoreCase: boolean): NameMatcher {
  const list = patterns
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().replace(/\*+/g, "*"));
  return (name) => list.some((pattern) => wildcardMatch(pattern, name, ignoreCase));
}

function deniedNameMatcher(patterns: readonly string[]): NameMatcher {
  return nameMatcher(patterns, true);
}

function hasDeniedSegment(filePath: string, denied: NameMatcher): boolean {
  return filePath.split(/[\\/]+/).some((segment) => segment !== "" && denied(segment));
}

// ---------------------------------------------------------------------------
// Secret redaction. Every pattern starts at a literal or token boundary and
// has bounded repetition, so masking attacker-controlled file content stays
// roughly linear in its size.
// ---------------------------------------------------------------------------

const SECRET_KEY =
  /(passw(or)?d|passphrase|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|subscription[_-]?key|functions?[_-]?key|master[_-]?key|token|connection[_-]?string|account[_-]?key|shared[_-]?access[_-]?key|credential|signature|authorization|cookie|\bsig\b|\bsas\b)/i;
const NON_SECRET_KEY_SUFFIX =
  /(url|uri|endpoint|path|file|filename|name|type|selector|field|label|placeholder|length|expiry|expires|expiresin|header|prefix|policy|id)$/i;
/** Unquoted values that are code or type annotations rather than literals. */
const CODE_LIKE_VALUE =
  /^(?:(?:string|number|boolean|any|unknown|object|null|undefined|true|false|never|void)\b.*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\([^)]{0,256}\))?\s*[;,]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([^)]{0,256}\)\s*)$/;
const QUOTED_ASSIGNMENT =
  /(?<![\w.$-])(["']?)([\w.$-]{1,128})\1(\s{0,8}(?:=>|:|=)\s{0,8})(["'`])((?:\\.|(?!\4)[^\\\r\n]){0,4096})\4/g;
const LINE_ASSIGNMENT =
  /^([ \t]{0,64}(?:export[ \t]+|set[ \t]+|\$env:)?)([\w.$-]{1,128})([ \t]{0,8}[:=][ \t]{0,8})([^"'`\r\n]{1,4096}?)((?:[ \t]+#[^\r\n]*)?[ \t]*)$/gm;
const DELIMITED_PAIR = /([;?&"'`])([\w.$-]{1,128})=([^;&\s"'`]{1,4096})/g;
/** Postman/HAR-style `{"key"|"name": "<header>", "value": "<secret>"}` pairs, across lines. */
const KEY_VALUE_PAIR =
  /((["'])(?:key|name)\2[ \t]{0,8}:[ \t]{0,8}(["']))([^"'\r\n]{1,128})\3(\s{0,8},\s{0,64}(["'])value\6[ \t]{0,8}:[ \t]{0,8}(["']))((?:\\.|(?!\7)[^\\\r\n]){0,4096})\7/g;
/** The same pair with `"value"` first. */
const VALUE_KEY_PAIR =
  /((["'])value\2[ \t]{0,8}:[ \t]{0,8}(["']))((?:\\.|(?!\3)[^\\\r\n]){1,4096})\3(\s{0,8},\s{0,64}(["'])(?:key|name)\6[ \t]{0,8}:[ \t]{0,8}(["']))([^"'\r\n]{1,128})\7/g;
/** A quoted secret header name followed by a quoted value: `set("x-api-key", "…")`, `['x-api-key', '…']`. */
const HEADER_ARGUMENT_PAIR =
  /((["'])(?:x-api-key|api-key|apikey|ocp-apim-subscription-key|x-functions-key|x-ibm-client-secret|x-auth-token|authorization|cookie|x-[\w-]{0,64}(?:key|secret|token))\2\s{0,8},\s{0,64}(["']))((?:\\.|(?!\3)[^\\\r\n]){1,4096})\3(?![ \t]{0,8}:)/gi;
/** XML/.config `key="<name>" value="<secret>"` attribute pairs. */
const XML_ATTRIBUTE_PAIR =
  /(\bkey[ \t]{0,8}=[ \t]{0,8}(["']))([^"'\r\n]{1,128})\2([ \t]{1,64}value[ \t]{0,8}=[ \t]{0,8}(["']))((?:(?!\5)[^\r\n]){0,4096})\5/gi;
/** XML elements such as `<password>…</password>`. */
const XML_ELEMENT = /<([\w.:-]{1,128})>([^<\r\n]{1,4096})<\/\1>/g;
const SECRET_HEADER =
  /^(x-api-key|api-key|apikey|ocp-apim-subscription-key|x-functions-key|x-ibm-client-secret|authorization|x-auth-token|cookie|set-cookie)$/i;
/** Well-known token formats (GitHub, AWS access key id, Slack, OpenAI-style). */
const KNOWN_TOKEN =
  /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})(?![\w-])/g;
/** Maximal alphanumeric runs long enough to be keys; filtered by `looksRandom`. */
const LONG_ALNUM_RUN = /(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/:@]{1,256}):([^\s/@]{1,256})@/gi;
const BEARER = /\b(Bearer)([ \t]{1,4})[\w.~+/-]{16,}=*/g;
const BASIC = /\b(Basic)([ \t]{1,4})(?=[A-Za-z0-9+/]{0,512}[0-9+/=])[A-Za-z0-9+/]{12,512}={0,2}/g;
const JWT = /(?<![\w-])eyJ[\w-]{5,4096}\.eyJ[\w-]{5,8192}\.[\w-]{0,4096}/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN ([A-Z ]{0,40})PRIVATE KEY-----/g;
const MAX_PRIVATE_KEY_BLOCK = 20_000;
const REDACTED = "[REDACTED]";

/**
 * True for a random-looking key such as an unlabelled API key: it mixes upper
 * case, lower case and digits, and switches character class often. CamelCase
 * identifiers and hex hashes/GUIDs (no upper case) do not qualify.
 */
function looksRandom(token: string): boolean {
  const classOf = (ch: string): number => (ch >= "0" && ch <= "9" ? 0 : ch >= "a" && ch <= "z" ? 1 : 2);
  const seen = [false, false, false];
  let transitions = 0;
  let previous = -1;
  for (const ch of token) {
    const current = classOf(ch);
    seen[current] = true;
    if (previous !== -1 && current !== previous) transitions++;
    previous = current;
  }
  return seen.every(Boolean) && transitions >= Math.max(10, Math.ceil(token.length / 3));
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NON_SECRET_KEY_SUFFIX.test(key);
}

/**
 * Mask `BEGIN … PRIVATE KEY` blocks in one forward pass: END markers are
 * indexed once, so many unclosed BEGIN headers cannot cause rescanning.
 */
function redactPrivateKeyBlocks(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text;
  const ends: number[] = [];
  for (let i = text.indexOf("-----END "); i >= 0; i = text.indexOf("-----END ", i + 1)) ends.push(i);
  if (ends.length === 0) return text;
  const begin = new RegExp(PRIVATE_KEY_BEGIN.source, "g");
  let out = "";
  let cursor = 0;
  let e = 0;
  let m: RegExpExecArray | null;
  while ((m = begin.exec(text)) !== null) {
    const marker = `-----END ${m[1] ?? ""}PRIVATE KEY-----`;
    const limit = m.index + MAX_PRIVATE_KEY_BLOCK;
    while (e < ends.length && (ends[e] ?? 0) < begin.lastIndex) e++;
    let stop = -1;
    for (let k = e; k < ends.length && (ends[k] ?? Infinity) <= limit; k++) {
      if (text.startsWith(marker, ends[k] ?? 0)) {
        stop = (ends[k] ?? 0) + marker.length;
        break;
      }
    }
    if (stop < 0) continue;
    out += `${text.slice(cursor, m.index)}[REDACTED PRIVATE KEY]`;
    cursor = stop;
    begin.lastIndex = stop;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/** Best-effort masking of credential values in text; see `redactSecrets`. */
export function redactSecretValues(text: string): string {
  return redactPrivateKeyBlocks(text)
    .replace(JWT, "[REDACTED_JWT]")
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(URL_USERINFO, `$1$2:${REDACTED}@`)
    .replace(BEARER, `$1$2${REDACTED}`)
    .replace(BASIC, `$1$2${REDACTED}`)
    .replace(KEY_VALUE_PAIR, (match, head: string, _q: string, q2: string, name: string, mid: string, _q3: string, q4: string, value: string) =>
      value !== "" && (isSecretKey(name) || SECRET_HEADER.test(name))
        ? `${head}${name}${q2}${mid}${REDACTED}${q4}`
        : match)
    .replace(VALUE_KEY_PAIR, (match, head: string, _q: string, q2: string, _value: string, mid: string, _q3: string, q4: string, name: string) =>
      isSecretKey(name) || SECRET_HEADER.test(name)
        ? `${head}${REDACTED}${q2}${mid}${name}${q4}`
        : match)
    .replace(HEADER_ARGUMENT_PAIR, (_match, head: string, _q: string, q2: string) => `${head}${REDACTED}${q2}`)
    .replace(XML_ATTRIBUTE_PAIR, (match, head: string, q: string, name: string, mid: string, q2: string, value: string) =>
      value !== "" && (isSecretKey(name) || SECRET_HEADER.test(name))
        ? `${head}${name}${q}${mid}${REDACTED}${q2}`
        : match)
    .replace(XML_ELEMENT, (match, tag: string) =>
      isSecretKey(tag.slice(tag.lastIndexOf(":") + 1)) ? `<${tag}>${REDACTED}</${tag}>` : match)
    .replace(QUOTED_ASSIGNMENT, (match, q: string, key: string, op: string, quote: string, value: string) =>
      value !== "" && isSecretKey(key) ? `${q}${key}${q}${op}${quote}${REDACTED}${quote}` : match)
    .replace(LINE_ASSIGNMENT, (match, lead: string, key: string, op: string, value: string, tail: string) =>
      isSecretKey(key) && !CODE_LIKE_VALUE.test(value.trim()) && !value.includes(REDACTED)
        ? `${lead}${key}${op}${REDACTED}${tail}`
        : match)
    .replace(DELIMITED_PAIR, (match, delim: string, key: string) =>
      isSecretKey(key) || ((delim === "?" || delim === "&") && /^code$/i.test(key))
        ? `${delim}${key}=${REDACTED}`
        : match)
    .replace(LONG_ALNUM_RUN, (token) => (looksRandom(token) ? REDACTED : token));
}

/**
 * True if `abs` (already lexically inside `root`) is denied either by its
 * requested path or by the real path it (or its nearest existing ancestor)
 * resolves to, so an in-repo symlink alias cannot expose a protected file.
 */
async function isDeniedPath(root: string, abs: string, denied: NameMatcher): Promise<boolean> {
  if (hasDeniedSegment(path.relative(path.resolve(root), abs), denied)) return true;
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
  } catch {
    rootReal = path.resolve(root);
  }
  let probe = abs;
  let tail = "";
  for (;;) {
    try {
      const real = await fs.promises.realpath(probe);
      const resolved = tail ? path.join(real, tail) : real;
      const inside = resolved === rootReal || resolved.startsWith(rootReal + path.sep);
      return hasDeniedSegment(inside ? path.relative(rootReal, resolved) : resolved, denied);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      tail = tail ? path.join(path.basename(probe), tail) : path.basename(probe);
      probe = parent;
    }
  }
}

/** Truncate `text` to `max` bytes (UTF-8 aware), appending a marker. */
function cap(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  // Slice by bytes, then trim any partial trailing multi-byte sequence.
  const buf = Buffer.from(text, "utf8").subarray(0, max);
  return `${buf.toString("utf8").replace(/\uFFFD+$/u, "")}\n…(truncated)`;
}

/**
 * Resolve a repo-relative path, refusing anything that escapes `root`
 * lexically. Returns the absolute path, or `undefined` if it escapes (including
 * absolute inputs that resolve outside, `..` traversal, or empty input).
 */
export function resolveInRoot(root: string, rel: string): string | undefined {
  if (typeof rel !== "string" || rel.trim() === "") return undefined;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  return abs === base || abs.startsWith(base + path.sep) ? abs : undefined;
}

/**
 * True if the nearest EXISTING ancestor of `abs` resolves (via realpath, so
 * symlinks are followed) to a location still inside `root`. Used by writes to
 * refuse following a symlink that escapes the repo, while still allowing new
 * files/dirs under real in-repo directories.
 */
async function realpathStaysInRoot(root: string, abs: string): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
  } catch {
    rootReal = path.resolve(root);
  }
  let p = abs;
  // Walk up until we find an existing path we can realpath.
  for (;;) {
    try {
      const real = await fs.promises.realpath(p);
      return real === rootReal || real.startsWith(rootReal + path.sep);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return false;
      p = parent;
    }
  }
}

/** Max directory entries a `read` of a directory lists. */
const MAX_LISTED_ENTRIES = 500;

/**
 * Immediate entries of a directory (dirs suffixed with `/`), omitting denied
 * names, so agents without `execute` can still navigate the repo.
 */
async function listDirectory(abs: string, rel: string, lim: RepoToolLimits): Promise<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return `${rel} is a directory and cannot be listed: ${(err as Error).message}`;
  }
  const denied = deniedNameMatcher(lim.deniedPaths);
  const names: string[] = [];
  for (const ent of entries) {
    if (denied(ent.name)) continue;
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(path.join(abs, ent.name))).isDirectory();
      } catch {
        /* broken link — list as a plain name */
      }
    }
    names.push(isDir ? `${ent.name}/` : ent.name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = names.slice(0, MAX_LISTED_ENTRIES);
  const more = names.length > shown.length ? `\n…(${names.length - shown.length} more entries)` : "";
  const body = shown.length > 0 ? shown.join("\n") : "(empty)";
  return cap(`${rel} is a directory. Entries:\n${body}${more}`, lim.maxReadBytes);
}

/** Read a UTF-8 file under `root`. Returns the (capped) text or an error line. */
export async function readFileInRoot(
  root: string,
  rel: string,
  limits?: Partial<RepoToolLimits>,
): Promise<string> {
  const lim = limitsWith(limits);
  const abs = resolveInRoot(root, rel);
  if (!abs) return `Path escapes the repo root: ${rel || "(empty)"}`;
  if (
    lim.deniedPaths.length > 0 &&
    (await isDeniedPath(root, abs, deniedNameMatcher(lim.deniedPaths)))
  ) {
    return `Refused: ${rel} is a protected path (for example secrets or credentials) and cannot be read.`;
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch (err) {
    return `Cannot read ${rel}: ${(err as Error).message}`;
  }
  if (stat.isDirectory()) {
    return listDirectory(abs, rel, lim);
  }
  if (!stat.isFile()) return `${rel} is not a regular file.`;
  if (stat.size > lim.maxReadFileBytes) {
    return `${rel} is too large to read (${stat.size} bytes > ${lim.maxReadFileBytes}).`;
  }
  try {
    const text = await fs.promises.readFile(abs, "utf8");
    // Redact BEFORE capping so truncation cannot split a secret past the masker.
    return cap(lim.redactSecrets ? redactSecretValues(text) : text, lim.maxReadBytes);
  } catch (err) {
    return `Cannot read ${rel}: ${(err as Error).message}`;
  }
}

/**
 * Create or overwrite a file under `root` with full `content`. Creates parent
 * directories. Refuses paths that escape the root lexically or via a symlink,
 * and paths matching `limits.deniedPaths`.
 * Returns a confirmation line or an error line.
 */
export async function writeFileInRoot(
  root: string,
  rel: string,
  content: string,
  limits?: Partial<RepoToolLimits>,
): Promise<string> {
  const lim = limitsWith(limits);
  const abs = resolveInRoot(root, rel);
  if (!abs) return `Path escapes the repo root: ${rel || "(empty)"}`;
  if (!(await realpathStaysInRoot(root, abs))) {
    return `Refusing to write through a symlink that escapes the repo root: ${rel}`;
  }
  if (
    lim.deniedPaths.length > 0 &&
    (await isDeniedPath(root, abs, deniedNameMatcher(lim.deniedPaths)))
  ) {
    return `Refused: ${rel} is a protected path and cannot be written.`;
  }
  const body = typeof content === "string" ? content : String(content ?? "");
  try {
    const dir = path.dirname(abs);
    await fs.promises.mkdir(dir, { recursive: true });
    // Refuse to clobber a directory with the same name.
    try {
      const st = await fs.promises.stat(abs);
      if (st.isDirectory()) return `Cannot write ${rel}: it is a directory.`;
    } catch {
      /* does not exist yet — fine */
    }
    await fs.promises.writeFile(abs, body, "utf8");
    return `Wrote ${rel} (${Buffer.byteLength(body, "utf8")} bytes).`;
  } catch (err) {
    return `Cannot write ${rel}: ${(err as Error).message}`;
  }
}

/**
 * Top-level symlinked entries of `root`, returned as extra `grep` targets that
 * force the link to be followed (directories get a trailing slash). Both BSD
 * and GNU `grep -r` SKIP symlinks encountered during recursion, so an
 * intentional in-repo mount is invisible to
 * `grep -r .` unless we name it explicitly. Excluded or denied names and
 * broken links are skipped. Resolution failures yield an empty list (search
 * still runs).
 */
async function symlinkSearchTargets(
  root: string,
  excluded: NameMatcher,
  denied: NameMatcher,
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: string[] = [];
  for (const ent of entries) {
    if (!ent.isSymbolicLink() || excluded(ent.name) || denied(ent.name)) continue;
    const abs = path.join(root, ent.name);
    // A mount whose REAL target is denied (e.g. `notes -> .env`) is skipped too.
    if (await isDeniedPath(root, abs, denied)) continue;
    try {
      // stat (not lstat) follows the link to learn the target's type.
      const st = await fs.promises.stat(abs);
      targets.push(st.isDirectory() ? `${ent.name}/` : ent.name);
    } catch {
      /* broken symlink — skip */
    }
  }
  return targets;
}

/** Max hits reported per file, matching grep's `-m 50`. */
const MAX_MATCHES_PER_FILE = 50;

/** Files the Node search engine reads concurrently per ordered batch. */
const SEARCH_BATCH_SIZE = 32;

/** Max bytes of file content the Node search engine holds per read group. */
const SEARCH_BATCH_BYTES = 16 * 1024 * 1024;

/** Validate a model-supplied filename glob; returns an error line or undefined. */
function invalidGlob(glob: string): string | undefined {
  if (glob.length > MAX_GLOB_LENGTH) {
    return `Search glob is too long (${glob.length} > ${MAX_GLOB_LENGTH} characters).`;
  }
  if (/[\\/]/.test(glob)) return "Search glob must be a filename pattern such as *.md, not a path.";
  return undefined;
}

/**
 * Dependency-free equivalent of the grep search below, used on Windows (where
 * Git-for-Windows grep is unreliable) and wherever `grep` is missing:
 * case-insensitive fixed string, binary files skipped, at most 50 hits per
 * file, `excludeDirs`/`glob` as `*`/`?` name wildcards (no `[...]` classes;
 * case-insensitive on Windows), and only TOP-LEVEL symlink mounts followed.
 * Files larger than `maxReadFileBytes` are skipped.
 */
export async function searchInRootWithNode(
  root: string,
  query: string,
  glob?: string,
  limits?: Partial<RepoToolLimits>,
): Promise<string> {
  const lim = limitsWith(limits);
  if (typeof query !== "string" || query === "") {
    return "Provide a non-empty 'query' to search for.";
  }
  const needle = query.toLowerCase();
  const g = (glob ?? "").trim();
  const globError = g ? invalidGlob(g) : undefined;
  if (globError) return globError;
  const ignoreCase = process.platform === "win32";
  const include = g ? nameMatcher([g], ignoreCase) : undefined;
  const denied = deniedNameMatcher(lim.deniedPaths);
  const excluded = nameMatcher(lim.excludeDirs, ignoreCase);
  const deadline = Date.now() + lim.searchTimeoutMs;
  let stoppedByTimeout = false;
  const timedOut = (): boolean => {
    if (Date.now() > deadline) stoppedByTimeout = true;
    return stoppedByTimeout;
  };
  const candidates: Array<{ abs: string; display: string }> = [];

  const searchFile = async (abs: string, display: string): Promise<string[]> => {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      return [];
    }
    if (buf.includes(0)) return [];
    // With redaction on, mask the WHOLE file first (multi-line secrets) and
    // match against the masked text, so hits cannot confirm guessed values.
    const raw = buf.toString("utf8");
    const lines = (lim.redactSecrets ? redactSecretValues(raw) : raw).split(/\r?\n/);
    const found: string[] = [];
    for (let i = 0; i < lines.length && found.length < MAX_MATCHES_PER_FILE; i++) {
      const line = lines[i] ?? "";
      if (line.toLowerCase().includes(needle)) found.push(`${display}:${i + 1}:${line}`);
    }
    return found;
  };

  const walk = async (dirAbs: string, prefix: string, topLevel: boolean): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (timedOut()) return;
      if (denied(ent.name)) continue;
      const abs = path.join(dirAbs, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      let display = `${prefix}${ent.name}`;
      if (ent.isSymbolicLink()) {
        // Like grep -r, follow only top-level mounts (named as bare targets),
        // and never one whose real target is denied.
        if (!topLevel || excluded(ent.name) || (await isDeniedPath(root, abs, denied))) continue;
        try {
          const st = await fs.promises.stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
        display = ent.name;
      }
      if (isDir) {
        if (excluded(ent.name)) continue;
        await walk(abs, `${display}/`, false);
      } else if (isFile && (!include || include(ent.name))) {
        candidates.push({ abs, display });
      }
    }
  };

  await walk(path.resolve(root), "./", true);
  // Read files in ordered groups (bounded count and bytes): concurrent I/O,
  // bounded memory, deterministic output order.
  const hits: string[] = [];
  let bytes = 0;
  const collect = (found: string[]): void => {
    for (const hit of found) {
      hits.push(hit);
      bytes += Buffer.byteLength(hit, "utf8") + 1;
    }
  };
  for (let i = 0; i < candidates.length && bytes <= lim.maxOutputBytes && !timedOut(); i += SEARCH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SEARCH_BATCH_SIZE);
    const sizes = await Promise.all(
      batch.map((c) =>
        fs.promises.stat(c.abs).then(
          (st) => (st.isFile() && st.size <= lim.maxReadFileBytes ? st.size : -1),
          () => -1,
        ),
      ),
    );
    let j = 0;
    while (j < batch.length && bytes <= lim.maxOutputBytes && !timedOut()) {
      const group: Array<{ abs: string; display: string }> = [];
      let groupBytes = 0;
      while (j < batch.length) {
        const size = sizes[j] ?? -1;
        if (size < 0) {
          j++;
          continue;
        }
        if (group.length > 0 && groupBytes + size > SEARCH_BATCH_BYTES) break;
        group.push(batch[j]!);
        groupBytes += size;
        j++;
      }
      for (const found of await Promise.all(group.map((c) => searchFile(c.abs, c.display)))) {
        collect(found);
      }
    }
  }
  const output = hits.join("\n");
  if (stoppedByTimeout && bytes <= lim.maxOutputBytes) {
    const stopReason = `timed out after ${lim.searchTimeoutMs} ms`;
    return output
      ? `${cap(output, lim.maxOutputBytes)}\n(search ended early: ${stopReason})`
      : `Search failed: ${stopReason}`;
  }
  return cap(output || "No matches.", lim.maxOutputBytes);
}

/**
 * Turn `grep --null` output (`path\0line:text`) into `path:line:text` hits,
 * dropping hits whose path has a denied segment (grep's own globs are
 * case-sensitive). Exported for tests.
 */
export function formatGrepOutput(
  stdout: string,
  limits?: Partial<RepoToolLimits>,
): string {
  const lim = limitsWith(limits);
  const denied = deniedNameMatcher(lim.deniedPaths);
  const hits: string[] = [];
  for (const raw of stdout.split("\n")) {
    const nul = raw.indexOf("\0");
    if (nul < 0) continue;
    const filePath = raw.slice(0, nul);
    if (hasDeniedSegment(filePath, denied)) continue;
    hits.push(`${filePath}:${raw.slice(nul + 1).replace(/\r$/, "")}`);
  }
  return hits.join("\n");
}

/**
 * Case-insensitive fixed-string search under `root` via `grep` (no shell).
 * Returns `path:line:snippet` hits, "No matches.", or an error line. `glob`
 * (e.g. `*.md`) filters filenames. Intentional top-level symlink mounts are
 * searched too (grep skips symlinks met during recursion; see helper above).
 * On Windows, when `grep` is not on PATH, or when `redactSecrets` is on (which
 * needs whole-file masking before matching), the Node engine above is used.
 */
export async function searchInRoot(
  root: string,
  query: string,
  glob?: string,
  limits?: Partial<RepoToolLimits>,
): Promise<string> {
  const lim = limitsWith(limits);
  if (typeof query !== "string" || query === "") {
    return "Provide a non-empty 'query' to search for.";
  }
  if (process.platform === "win32" || lim.redactSecrets) {
    return searchInRootWithNode(root, query, glob, limits);
  }
  const g = (glob ?? "").trim();
  const globError = g ? invalidGlob(g) : undefined;
  if (globError) return globError;
  const denied = deniedNameMatcher(lim.deniedPaths);
  // -r recursive, -I skip binary, -n line numbers, -F fixed string,
  // -i case-insensitive, -m cap matches per file, --null NUL after the path.
  const args = ["-rInFi", "--null", "-m", String(MAX_MATCHES_PER_FILE)];
  for (const dir of lim.excludeDirs) args.push(`--exclude-dir=${dir}`);
  for (const pattern of lim.deniedPaths) {
    args.push(`--exclude=${pattern}`, `--exclude-dir=${pattern}`);
  }
  if (g) args.push(`--include=${g}`);
  // `.` covers the real tree (grep skips the mount symlinks during recursion);
  // the explicit mount targets cover those links with no double-traversal.
  const mounts = await symlinkSearchTargets(root, nameMatcher(lim.excludeDirs, false), denied);
  args.push("-e", query, ".", ...mounts);
  try {
    const { stdout } = await execFileAsync("grep", args, {
      cwd: root,
      timeout: lim.searchTimeoutMs,
      maxBuffer: lim.maxBuffer,
    });
    const visible = formatGrepOutput(stdout, lim).trim();
    return cap(visible || "No matches.", lim.maxOutputBytes);
  } catch (err) {
    const e = err as { code?: number | string; message?: string; stdout?: string };
    // grep exits 1 when there are simply no matches.
    if (e.code === 1) return "No matches.";
    if (e.code === "ENOENT") {
      return searchInRootWithNode(root, query, glob, limits);
    }
    // Partial output may still be useful (e.g. on timeout).
    const partialText = e.stdout ? formatGrepOutput(e.stdout, lim).trim() : "";
    const partial = partialText ? cap(partialText, lim.maxOutputBytes) : "";
    return partial
      ? `${partial}\n(search ended early: ${e.message})`
      : `Search failed: ${e.message}`;
  }
}

/** Structured outcome of a shell run, so a caller can tell a DEFINITE result
 * (completed/failed) from an UNKNOWN one (canceled or timed out mid-run) where a
 * mutation may or may not have taken effect. */
export type ExecOutcome = "completed" | "failed" | "timed-out" | "canceled";

export interface ExecResult {
  /** Combined stdout/stderr (capped), or an error/status line. */
  text: string;
  outcome: ExecOutcome;
  /** True once the child was actually spawned. A command canceled BEFORE it
   * started never ran, so re-running it is safe. */
  started: boolean;
}

/**
 * Run a shell command from `root` and report a STRUCTURED outcome alongside the
 * combined stdout/stderr (capped).
 *
 * Cancellation: the child is `detached` so it leads its OWN process group. A
 * timeout or an aborted `signal` reaps the WHOLE tree (shell -> npm -> node ->
 * ...) with one group signal — SIGTERM, a bounded grace window, then SIGKILL —
 * instead of orphaning grandchildren the way `exec`'s single-child timeout does.
 * The promise resolves only after the child has actually exited, so a caller
 * that awaits it knows the owned work is quiescent.
 */
export async function execWithOutcome(
  root: string,
  command: string,
  limits?: Partial<RepoToolLimits>,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const lim = limitsWith(limits);
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd) {
    return { text: "Provide a non-empty 'command' to run.", outcome: "failed", started: false };
  }
  if (signal?.aborted) {
    return { text: "Command canceled before it started.", outcome: "canceled", started: false };
  }

  return new Promise<ExecResult>((resolve) => {
    // `detached` puts the child in a new process group so a cancel/timeout can
    // reap the whole tree with a single group signal; `shell: true` preserves
    // the existing "run a shell command" contract (pipes, &&, redirects).
    const child = spawn(cmd, {
      cwd: root,
      env: process.env,
      shell: true,
      // A detached Windows child loses its console output, so only POSIX uses a group.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const pid = child.pid;

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let canceled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Signal the whole process group (negative pid, POSIX). Fall back to the
    // direct child if the group send fails (already exited, or non-POSIX host).
    // Windows has no groups: end the tree of the still-running child we own.
    const signalGroup = (sig: NodeJS.Signals): void => {
      if (process.platform === "win32") {
        if (pid === undefined) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          // The shell already exited but a descendant may hold the pipes open, so
          // `close` would never fire. Release the pipes so the run can finish.
          child.stdout?.destroy();
          child.stderr?.destroy();
          return;
        }
        const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        // taskkill /F is already forceful, so the SIGKILL grace step adds nothing here.
        spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
          .on("error", () => child.kill(sig));
        return;
      }
      try {
        if (pid !== undefined) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already exited */
        }
      }
    };

    const terminate = (): void => {
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => signalGroup("SIGKILL"), lim.killGraceMs);
      graceTimer.unref?.();
    };

    const onAbort = (): void => {
      canceled = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer =
      lim.execTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, lim.execTimeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    const absorb = (chunk: Buffer, into: "out" | "err"): void => {
      if (bytes >= lim.maxBuffer) return;
      bytes += chunk.length;
      const text = chunk.toString("utf8");
      if (into === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (c: Buffer) => absorb(c, "out"));
    child.stderr?.on("data", (c: Buffer) => absorb(c, "err"));

    const settle = (result: string, outcome: ExecOutcome, started = true): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        text: cap(result.trim() || "(no output)", lim.maxOutputBytes),
        outcome,
        started,
      });
    };

    child.on("error", (err) => {
      // A spawn failure (ENOENT/EACCES/…) means the child never began
      // executing, so mark it NOT started: re-running is safe and it must not
      // ladder into the ambiguous-command guard.
      settle(`Command failed (spawn error): ${(err as Error).message}`, "failed", false);
    });

    child.on("close", (code, sig) => {
      const tail = stderr ? `\n[stderr]\n${stderr}` : "";
      const out = `${stdout}${tail}`.trim();
      const sigNote = sig ? ` (${sig})` : "";
      if (canceled) {
        settle(`Command canceled${sigNote}:\n${out}`, "canceled");
      } else if (timedOut) {
        settle(
          `Command failed (timed out after ${lim.execTimeoutMs} ms${sigNote}):\n${out}`,
          "timed-out",
        );
      } else if (code === 0) {
        settle(`${stdout}${tail}`, "completed");
      } else {
        settle(`Command failed (exit ${code ?? "?"}${sigNote}):\n${out}`, "failed");
      }
    });
  });
}

/**
 * Run a shell command from `root`. Returns combined stdout/stderr (capped), or
 * a "Command failed"/"Command canceled" line. Thin wrapper over
 * `execWithOutcome` that keeps the historical string-only contract for callers
 * that don't need the structured outcome.
 */
export async function execInRoot(
  root: string,
  command: string,
  limits?: Partial<RepoToolLimits>,
  signal?: AbortSignal,
): Promise<string> {
  return (await execWithOutcome(root, command, limits, signal)).text;
}

// ---------------------------------------------------------------------------
// Toolset factory — the read/edit/search/execute tool SPECS + dispatch wiring,
// shared by every agent so none has to re-declare them. An agent composes this
// with its own skill/domain tools.
// ---------------------------------------------------------------------------

export type RepoToolName = "read" | "edit" | "search" | "execute";

/** Every primitive the shared toolset can expose, in advertised order. */
export const REPO_TOOL_NAMES: readonly RepoToolName[] = ["read", "edit", "search", "execute"];

function isRepoToolName(name: string): name is RepoToolName {
  return (REPO_TOOL_NAMES as readonly string[]).includes(name);
}

/** Model-facing descriptions for each primitive; override per repo flavor. */
export type RepoToolDescriptions = Record<RepoToolName, string>;

export const DEFAULT_REPO_TOOL_DESCRIPTIONS: RepoToolDescriptions = {
  read:
    "Read a UTF-8 file from the repo. The path is relative to the repo root, " +
    "e.g. README.md or src/index.ts. A directory path (e.g. . or src) lists " +
    "its entries.",
  edit:
    "Create or overwrite a file in the repo with full content. Parent " +
    "directories are created. Pass the COMPLETE new file content.",
  search:
    "Search repo text for a fixed string (case-insensitive). Returns " +
    "path:line:snippet hits. Optional glob filters filenames, e.g. *.md.",
  execute:
    "Run a shell command from the repo root. Returns combined stdout/stderr.",
};

export interface RepoToolsetOptions {
  /** Repo root, or a getter resolved when the runtime is created. */
  root: string | (() => string);
  /** Override any of the default model-facing tool descriptions. */
  descriptions?: Partial<RepoToolDescriptions>;
  /** Tunable limits (sizes, timeouts). */
  limits?: Partial<RepoToolLimits>;
  /**
   * Subset of read/edit/search/execute to expose. Omit for all four. Tools
   * left out are not advertised and are refused if the model calls them anyway.
   */
  allowedTools?: readonly RepoToolName[];
}

export interface RepoToolset {
  /** The enabled LlmTool specs (read, edit, search, execute by default). */
  tools: LlmTool[];
  /**
   * Handle a tool call if it is one of read/edit/search/execute; otherwise
   * resolves to `undefined` so the caller can try its other tools. A call to a
   * primitive that is not in `allowedTools` resolves to a refusal line.
   */
  dispatch(
    call: LlmToolCall,
    onProgress?: AgentProgress,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * Build the shared read/edit/search/execute toolset bound to a repo root.
 * Returns the tool specs plus a `dispatch` that delegates to the tested
 * primitives above. Compose it with an agent's skill/domain tools:
 *
 *   const repo = createRepoToolset({ root });
 *   const tools = [skillTool, ...repo.tools];
 *   const dispatch = async (call, onProgress) =>
 *     (await repo.dispatch(call, onProgress)) ?? handleMyOwn(call);
 */
export function createRepoToolset(opts: RepoToolsetOptions): RepoToolset {
  const getRoot = typeof opts.root === "function" ? opts.root : () => opts.root as string;
  const limits = opts.limits;
  const desc: RepoToolDescriptions = {
    ...DEFAULT_REPO_TOOL_DESCRIPTIONS,
    ...opts.descriptions,
  };
  const requested = opts.allowedTools ?? REPO_TOOL_NAMES;
  for (const name of requested) {
    if (!isRepoToolName(name)) {
      throw new Error(
        `Unknown repo tool "${String(name)}"; expected one of ${REPO_TOOL_NAMES.join(", ")}.`,
      );
    }
  }
  const allowed = new Set<RepoToolName>(requested);

  // Guardrails against duplicating a side effect via `execute` (see
  // docs/hub/end-to-end-task-cancellation.md, CXL-08). Both sets key on the
  // EXACT trimmed command string and are per-toolset — i.e. per task, since the
  // toolset is created per task via createRuntime.
  //
  // `ambiguousExecutes`: commands whose last run ended with an UNKNOWN outcome
  //   (canceled or timed out AFTER starting) — re-issuing could double a
  //   mutation, so it is blocked for the rest of the task. v1 has no explicit
  //   "recovery clear": the block lifts only when the task (and its toolset) ends.
  // `inFlightExecutes`: commands currently running, so a CONCURRENT duplicate is
  //   blocked instead of racing the first to the same side effect.
  //
  // This is a SAFETY NUDGE, not an enforcement boundary: it keys on the literal
  // string, so a reformatted-but-equivalent command (extra spaces, different
  // quoting) bypasses it. It is not a security control.
  const ambiguousExecutes = new Set<string>();
  const inFlightExecutes = new Set<string>();

  const allTools: LlmTool[] = [
    {
      name: "read",
      description: desc.read,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
        },
        required: ["path"],
      },
    },
    {
      name: "edit",
      description: desc.edit,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
          content: { type: "string", description: "Full new file content." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "search",
      description: desc.search,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for." },
          glob: {
            type: "string",
            description: "Optional filename glob, e.g. *.md.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "execute",
      description: desc.execute,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run in the repo root.",
          },
        },
        required: ["command"],
      },
    },
  ];
  const tools = allTools.filter((tool) => allowed.has(tool.name as RepoToolName));

  const dispatch = async (
    call: LlmToolCall,
    onProgress?: AgentProgress,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (isRepoToolName(call.name) && !allowed.has(call.name)) {
      return `Refused: the "${call.name}" tool is not enabled for this agent.`;
    }
    const input = (call.input ?? {}) as Record<string, unknown>;
    const root = getRoot();
    switch (call.name) {
      case "read":
        return readFileInRoot(root, asString(input.path), limits);
      case "edit": {
        const rel = asString(input.path);
        const result = await writeFileInRoot(
          root,
          rel,
          asString(input.content),
          limits,
        );
        if (result.startsWith("Wrote ")) onProgress?.(`wrote ${rel}`);
        return result;
      }
      case "search":
        return searchInRoot(root, asString(input.query), asString(input.glob), limits);
      case "execute": {
        const command = asString(input.command).trim();
        if (command && ambiguousExecutes.has(command)) {
          return (
            "Blocked: a previous run of this exact command was canceled or " +
            "timed out with an UNKNOWN side-effect outcome, so re-running it " +
            "could duplicate a mutation. Do not retry it. Report the ambiguous " +
            "outcome and either ask for an explicit recovery decision or run a " +
            "read-only check to see whether the first run already took effect."
          );
        }
        if (command && inFlightExecutes.has(command)) {
          return (
            "Blocked: this exact command is already running in this task. Wait " +
            "for it to finish instead of starting a concurrent duplicate that " +
            "could double a mutation."
          );
        }
        if (command) {
          onProgress?.(`$ ${command}`);
          inFlightExecutes.add(command);
        }
        try {
          const result = await execWithOutcome(root, command, limits, signal);
          if (
            command &&
            result.started &&
            (result.outcome === "canceled" || result.outcome === "timed-out")
          ) {
            ambiguousExecutes.add(command);
          }
          return result.text;
        } finally {
          if (command) inFlightExecutes.delete(command);
        }
      }
      default:
        return undefined;
    }
  };

  return { tools, dispatch };
}
