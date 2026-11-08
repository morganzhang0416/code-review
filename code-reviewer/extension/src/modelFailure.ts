// Copilot model selection failure helpers.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

export type ModelFailureClass =
  | "capacity"
  | "transport"
  | "caller-cancellation"
  | "generic-cancellation"
  | "authentication"
  | "other";

export const MODEL_CAPACITY_UNAVAILABLE = "MODEL_CAPACITY_UNAVAILABLE" as const;
export const MODEL_TRANSPORT_UNAVAILABLE = "MODEL_TRANSPORT_UNAVAILABLE" as const;
export const MODEL_RESPONSE_INTERRUPTED = "MODEL_RESPONSE_INTERRUPTED" as const;
export const MODEL_CALL_FAILED = "MODEL_CALL_FAILED" as const;

export type ModelFailureCode =
  | typeof MODEL_CAPACITY_UNAVAILABLE
  | typeof MODEL_TRANSPORT_UNAVAILABLE
  | typeof MODEL_RESPONSE_INTERRUPTED
  | typeof MODEL_CALL_FAILED;

export interface ModelFailureClassification {
  readonly failureClass: ModelFailureClass;
  readonly providerCode?: string;
}

const MAX_CAUSE_DEPTH = 8;
const STRUCTURED_TRANSPORT_CODES = [
  "ERR_HTTP2_PING_FAILED",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_STREAM_CANCEL",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
] as const;
const MESSAGE_TRANSPORT_CODES = STRUCTURED_TRANSPORT_CODES.filter(
  (code) => code !== "ETIMEDOUT",
);
const GENERIC_CANCELLATION_CODES = new Set([
  "ABORT_ERR",
  "CANCELED",
  "CANCELLED",
  "ERR_CANCELED",
  "ERR_CANCELLED",
]);
const AUTHENTICATION_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
]);

interface FailureEvidence {
  readonly codes: string[];
  readonly messages: string[];
  readonly names: string[];
  readonly statuses: Array<string | number>;
}

function readProperty(value: object, property: string): unknown {
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function collectEvidence(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  evidence: FailureEvidence,
): void {
  if (depth > MAX_CAUSE_DEPTH || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  const code = readProperty(value, "code");
  const message = readProperty(value, "message");
  const name = readProperty(value, "name");
  const status = readProperty(value, "status");
  const statusCode = readProperty(value, "statusCode");

  if (typeof code === "string") evidence.codes.push(code);
  if (typeof message === "string") evidence.messages.push(message);
  if (typeof name === "string") evidence.names.push(name);
  if (typeof status === "string" || typeof status === "number") {
    evidence.statuses.push(status);
  }
  if (typeof statusCode === "string" || typeof statusCode === "number") {
    evidence.statuses.push(statusCode);
  }

  collectEvidence(readProperty(value, "cause"), depth + 1, seen, evidence);
}

function containsToken(value: string, token: string): boolean {
  let offset = value.indexOf(token);
  while (offset >= 0) {
    const before = offset === 0 ? "" : value[offset - 1];
    const afterOffset = offset + token.length;
    const after = afterOffset === value.length ? "" : value[afterOffset];
    const beforeDelimited = before === "" || !/[A-Za-z0-9_]/.test(before);
    const afterDelimited = after === "" || !/[A-Za-z0-9_]/.test(after);
    if (beforeDelimited && afterDelimited) return true;
    offset = value.indexOf(token, offset + 1);
  }
  return false;
}

function findCode(codes: readonly string[], expected: readonly string[]): string | undefined {
  return expected.find((candidate) => codes.includes(candidate));
}

function findMessageToken(
  messages: readonly string[],
  expected: readonly string[],
): string | undefined {
  return expected.find((candidate) =>
    messages.some((message) => containsToken(message, candidate)),
  );
}

export function classifyModelFailure(
  error: unknown,
  signal?: AbortSignal,
): ModelFailureClassification {
  if (signal?.aborted) return { failureClass: "caller-cancellation" };

  const evidence: FailureEvidence = {
    codes: [],
    messages: [],
    names: [],
    statuses: [],
  };
  collectEvidence(error, 0, new WeakSet(), evidence);

  if (
    evidence.codes.includes("model_degraded") ||
    evidence.messages.some((message) => containsToken(message, "model_degraded"))
  ) {
    return { failureClass: "capacity", providerCode: "model_degraded" };
  }
  if (
    evidence.codes.includes("rateLimited") ||
    evidence.messages.some((message) => containsToken(message, "rateLimited"))
  ) {
    return { failureClass: "capacity", providerCode: "rateLimited" };
  }

  const structuredTransport = findCode(evidence.codes, STRUCTURED_TRANSPORT_CODES);
  if (structuredTransport) {
    return { failureClass: "transport", providerCode: structuredTransport };
  }
  const messageTransport = findMessageToken(evidence.messages, MESSAGE_TRANSPORT_CODES);
  if (messageTransport) {
    return { failureClass: "transport", providerCode: messageTransport };
  }

  if (
    evidence.codes.some((code) => GENERIC_CANCELLATION_CODES.has(code)) ||
    evidence.names.includes("AbortError") ||
    evidence.messages.some((message) =>
      /\b(?:cancel(?:ed|led)|cancellation)\b/i.test(message),
    )
  ) {
    return { failureClass: "generic-cancellation" };
  }

  if (
    evidence.codes.some((code) => AUTHENTICATION_CODES.has(code)) ||
    evidence.statuses.some((status) => status === 401 || status === 403 || status === "401" || status === "403") ||
    evidence.messages.some((message) =>
      /\b(?:authentication|forbidden|unauthorized)\b|\bpermission denied\b/i.test(message),
    )
  ) {
    return { failureClass: "authentication" };
  }

  return { failureClass: "other" };
}

const structuredFailures = new WeakSet<ModelCallFailure>();

export class ModelCallFailure extends Error {
  readonly failureClass: ModelFailureClass;
  readonly providerCode?: string;
  readonly providerStreamStarted: boolean;
  override readonly cause: unknown;

  constructor(cause: unknown, providerStreamStarted: boolean, signal?: AbortSignal) {
    super("Model call failed.", { cause });
    this.name = "ModelCallFailure";
    const classification = classifyModelFailure(cause, signal);
    this.failureClass = classification.failureClass;
    this.providerCode = classification.providerCode;
    this.providerStreamStarted = providerStreamStarted;
    this.cause = cause;
    structuredFailures.add(this);
  }
}

export function isModelCallFailure(error: unknown): error is ModelCallFailure {
  return error instanceof ModelCallFailure && structuredFailures.has(error);
}

export function modelFailureCode(error: unknown): ModelFailureCode {
  if (!isModelCallFailure(error)) return MODEL_CALL_FAILED;
  if (error.providerStreamStarted) return MODEL_RESPONSE_INTERRUPTED;
  if (error.failureClass === "capacity") return MODEL_CAPACITY_UNAVAILABLE;
  if (error.failureClass === "transport") return MODEL_TRANSPORT_UNAVAILABLE;
  return MODEL_CALL_FAILED;
}
