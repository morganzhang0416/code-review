// Portable tool loop used by the local reviewer.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

/**
 * Generic, agent-agnostic tool-calling loop driven by an `LlmModel`. Each agent
 * supplies its own system prompt and tool runtime; the loop logic is identical
 * and host-agnostic — it never imports `vscode`.
 */
import type { AgentProgress, AgentRuntime } from "./agent";
import type {
  LlmAssistantPart,
  LlmMessage,
  LlmModel,
  LlmToolCall,
  LlmToolResult,
} from "./llm";

const DEFAULT_MAX_STEPS = 12;

export interface LoopResult {
  summary: string;
  steps: number;
  /** The full conversation after this turn (prior history + this turn's user,
   * assistant, and tool messages). Persist it to give the agent memory across
   * turns of the same conversation. */
  messages: LlmMessage[];
}

function describeCall(
  call: LlmToolCall,
  args: Record<string, unknown>,
): string {
  const json = JSON.stringify(args);
  const summary = json.length > 120 ? `${json.slice(0, 117)}…` : json;
  return `→ ${call.name}(${summary})`;
}

function sanitizedArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return sanitizeObject(input as Record<string, unknown>, 0);
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth >= 5) return { truncated: "[TRUNCATED]" };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    // `pat` matches a whole token (personal access token), not a substring of
    // benign keys like `path`/`patch`/`compatible`.
    if (/(?:authorization|cookie|password|secret|token|api[_-]?key|pat(?![a-z]))/i.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeValue(item, depth + 1);
    }
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>, depth);
  }
  return `[${typeof value}]`;
}

function booleanMarker(
  input: Record<string, unknown>,
  names: string[],
): boolean | undefined {
  for (const name of names) {
    if (typeof input[name] === "boolean") return input[name];
  }
  return undefined;
}

async function executeToolCall(
  runtime: AgentRuntime,
  call: LlmToolCall,
  onProgress: AgentProgress,
  signal: AbortSignal,
): Promise<string> {
  const args = sanitizedArguments(call.input);
  const description = describeCall(call, args);
  onProgress(description);
  const startedAt = Date.now();
  let content: string;
  let failure: unknown;
  try {
    content = await runtime.dispatch(call, onProgress, signal);
  } catch (err) {
    failure = err;
    content = `ERROR: ${(err as Error).message}`;
  }
  const failed = failure !== undefined;
  let errorClass: string | undefined;
  if (failure instanceof Error) errorClass = failure.constructor.name;
  else if (failed) errorClass = "Error";
  onProgress(description, {
    kind: "tool",
    label: call.name,
    status: failed ? "error" : "ok",
    toolName: call.name,
    arguments: args,
    outcome: failed ? "failed" : "completed",
    durationMs: Date.now() - startedAt,
    errorClass,
    dryRun: booleanMarker(args, ["dryRun", "dry_run"]),
    confirmed: booleanMarker(args, ["confirmed", "confirm"]),
  });
  return content;
}

/** True when the model selected a tool whose raw output IS the answer. */
function findPassthrough(
  runtime: AgentRuntime,
  toolCalls: LlmToolCall[],
): LlmToolCall | undefined {
  const set = runtime.passthroughTools;
  if (!set?.length) return undefined;
  return toolCalls.find((c) => set.includes(c.name));
}

async function executeToolCalls(
  runtime: AgentRuntime,
  toolCalls: LlmToolCall[],
  onProgress: AgentProgress,
  signal: AbortSignal,
): Promise<LlmToolResult[]> {
  const results: LlmToolResult[] = [];
  for (const call of toolCalls) {
    const content = await executeToolCall(
      runtime,
      call,
      onProgress,
      signal,
    );
    results.push({ callId: call.callId, content });
  }
  return results;
}

/**
 * Pair a result with EVERY tool call in a passthrough turn: the passthrough's
 * real output, plus a "not run" note for any sibling calls the short-circuit
 * skipped. Without this, those siblings would be orphaned (a tool call with no
 * result) in the saved history — which the model API rejects on the next turn,
 * permanently wedging the conversation.
 */
function passthroughResults(
  toolCalls: LlmToolCall[],
  passthrough: LlmToolCall,
  content: string,
): LlmToolResult[] {
  return toolCalls.map((call) =>
    call === passthrough
      ? { callId: call.callId, content }
      : {
          callId: call.callId,
          content:
            "Not run: a passthrough tool was selected this turn (its output is " +
            "returned directly). Re-issue this call next turn if needed.",
        },
  );
}

export async function runToolLoop(
  model: LlmModel,
  systemPrompt: string,
  task: string,
  runtime: AgentRuntime,
  onProgress: AgentProgress,
  signal: AbortSignal,
  history: LlmMessage[] = [],
): Promise<LoopResult> {
  // The system prompt rides on the FIRST user turn of a conversation (this
  // runtime has no dedicated system role). On follow-up turns the prompt is
  // already in `history`, so we only add the new user message.
  const messages: LlmMessage[] = history.length
    ? [...history, { role: "user", text: task }]
    : [{ role: "user", text: `${systemPrompt}\n\nTask:\n${task}` }];
  let lastText = "";
  let step = 0;

  // The step cap is a safety net, not a workflow limit. An agent with a long,
  // legitimate multi-step task (e.g. a wiki ingest) can set maxSteps=0 to run
  // uncapped; cancellation via the signal still applies.
  const cap = runtime.maxSteps ?? DEFAULT_MAX_STEPS;
  const bounded = Number.isFinite(cap) && cap > 0;

  for (; !bounded || step < cap; step++) {
    if (signal.aborted) {
      return { summary: "Task cancelled.", steps: step, messages };
    }

    const assistantParts: LlmAssistantPart[] = [];
    const toolCalls: LlmToolCall[] = [];
    let text = "";
    for await (const part of model.chat(
      { messages, tools: runtime.tools },
      signal,
    )) {
      if (part.kind === "text") {
        text += part.text;
        assistantParts.push(part);
        // Stream the answer as it grows. Each event carries the full text so
        // far for this turn, so the consumer can render it live by replacing.
        if (text.trim()) onProgress(text, "answer");
      } else {
        toolCalls.push(part.call);
        assistantParts.push(part);
      }
    }

    if (text.trim()) {
      lastText = text;
    }
    messages.push({ role: "assistant", parts: assistantParts });

    if (toolCalls.length === 0) {
      return { summary: lastText || "Done.", steps: step + 1, messages };
    }

    // Passthrough clerk: if the model picked a tool whose raw output IS the
    // answer, run just that one and return its body verbatim — no truncation,
    // no second LLM pass (the brain never reads it). It still streams to the
    // caller as the answer. This keeps content-processing in the caller alone.
    const passthrough = findPassthrough(runtime, toolCalls);
    if (passthrough) {
      const content = await executeToolCall(
        runtime,
        passthrough,
        onProgress,
        signal,
      );
      onProgress(content, "answer");
      // Every tool call in this assistant turn needs a paired result, or the
      // saved history is malformed and poisons the next turn (see
      // passthroughResults).
      messages.push({
        role: "tool",
        results: passthroughResults(toolCalls, passthrough, content),
      });
      return { summary: content, steps: step + 1, messages };
    }

    // Strict stepping: an orchestrator can require one tool call per step so it
    // reasons between hops instead of fanning out several calls at once. Extra
    // calls are deferred, but every tool call still needs a result (the model
    // API pairs each call id with a result), so we answer the deferred ones
    // with an instruction to re-issue them next step.
    const limit = runtime.maxToolCallsPerStep;
    const runNow =
      limit && limit > 0 ? toolCalls.slice(0, limit) : toolCalls;
    const deferred = limit && limit > 0 ? toolCalls.slice(limit) : [];

    const results = await executeToolCalls(runtime, runNow, onProgress, signal);
    for (const call of deferred) {
      results.push({
        callId: call.callId,
        content:
          "Deferred: make only one tool call per step. Review the result " +
          "above, then re-issue this call on the next step if still needed.",
      });
    }
    messages.push({ role: "tool", results });
  }

  return {
    summary: `${lastText}\n\n(Stopped after reaching the ${cap}-step limit.)`,
    steps: step,
    messages,
  };
}
