// Portable agent runtime types and helpers.

/**
 * The agent contract — the surface a runtime consumer implements. Host-agnostic
 * and free of `vscode` imports, so it travels with the runtime when it splits
 * into a standalone library.
 */
import type { AgentSkill } from "./a2a-types";
import type { LlmTool, LlmToolCall } from "./llm";

/**
 * What a progress update represents:
 * - "narration": status/trace (model selection, tool calls). Transient.
 * - "answer": the agent's answer text as it streams in. Cumulative — each
 *   event carries the full answer-so-far for the current turn, so consumers can
 *   render it live by replacement.
 * - "delegate": a sub-agent's live stream this agent is relaying upward.
 *   Cumulative like "answer", but NOT this agent's own answer — a consumer
 *   should show it as one replacing "what my delegate is doing" line, never the
 *   main answer and never an appended trace note.
 */
export type ProgressKind = "narration" | "answer" | "delegate";

/** Lifecycle of a hop/tool node in a delegation trace. */
export type ProgressStatus =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "ok"
  | "error"
  | "running";

/**
 * A STRUCTURED progress event carrying WHO is acting and on WHAT, so a console
 * can render a nested delegation trace ("parent-agent → delegated-agent: <task>") instead
 * of flat narration. Emit one when an agent delegates to a peer (`kind: "hop"`)
 * or runs a tool (`kind: "tool"`). All fields are optional; a plain
 * `onProgress(text)` or `onProgress(text, "answer")` still works unchanged.
 */
export interface ProgressEvent {
  /**
   * Event class. "hop" = this agent delegated to another agent; "tool" = a tool
   * call by the acting agent; "note" = misc narration; or one of the streaming
   * kinds ("answer"/"delegate"/"narration").
   */
  kind?: ProgressKind | "hop" | "tool" | "note";
  /** For a hop: the delegate (callee). For a tool: the acting agent. */
  agentId?: string;
  /** Human-friendly name of `agentId`, for the trace badge. */
  agentName?: string;
  /** For a hop: the caller, so a console can nest the callee under the caller. */
  parentAgentId?: string;
  /**
   * Nesting depth if the emitter knows it (0 = root). Usually left undefined —
   * a console computes it from the `parentAgentId` chain.
   */
  depth?: number;
  /** Short label — for a hop, the task delegated; for a tool, the call. */
  label?: string;
  /** Lifecycle of the hop/tool node (working → completed/failed). */
  status?: ProgressStatus;
  /** Stable tool identifier and sanitized invocation facts for evidence capture. */
  toolName?: string;
  arguments?: Record<string, unknown>;
  outcome?: "completed" | "failed";
  durationMs?: number;
  errorClass?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

/**
 * Report progress during a run. The optional second argument is either a plain
 * streaming `ProgressKind` (back-compat) or a structured `ProgressEvent` for a
 * delegation hop / tool call that a console can render as a nested trace.
 */
export type AgentProgress = (
  text: string,
  meta?: ProgressKind | ProgressEvent,
) => void;

/**
 * Per-task execution surface for an agent: the tools it offers the model, a
 * dispatcher that runs one tool call, and an optional footer appended to the
 * final answer (e.g. a list of files changed).
 *
 * Created fresh per task (via `AgentDefinition.createRuntime`) so it can hold
 * per-run state and read live configuration.
 */
export interface AgentRuntime {
  tools: LlmTool[];
  /**
   * Maximum UTF-8 bytes this runtime intentionally returns as model-facing
   * answer text. Hosts advertise this through capability discovery so callers
   * can reject an incompatible lower response ceiling before delegation.
   */
  modelOutputMaxBytes?: number;
  /**
   * Run one tool call and return its result. The optional `onProgress` lets a
   * tool stream narration while it works (e.g. an orchestrator forwarding a
   * sub-agent's live updates, or announcing why it is calling a specialist).
   * The optional `signal` aborts in-flight work when the run is cancelled — a
   * tool that delegates to a peer over A2A must forward it so a cancel
   * propagates down the whole chain, not just the local call.
   */
  dispatch: (
    call: LlmToolCall,
    onProgress?: AgentProgress,
    signal?: AbortSignal,
  ) => Promise<string>;
  /**
   * Cap on how many tool calls the loop will actually execute per step. When
   * set (e.g. 1 for a strict ReAct orchestrator), any extra calls the model
   * emits in the same turn are deferred — the model is told to re-issue them on
   * the next step, after it has seen the first result. Unset = no limit.
   */
  maxToolCallsPerStep?: number;
  /**
   * Cap on how many reason→act steps the loop runs before it stops and returns
   * what it has. Unset = the loop's default safety cap. Set `0` (or a
   * non-finite value) to run UNCAPPED — appropriate for a long, legitimate
   * multi-step workflow (e.g. a wiki ingest that writes many files) where the
   * task itself, not an arbitrary counter, decides when it's done. Cancellation
   * via the AbortSignal still applies.
   */
  maxSteps?: number;
  /**
   * Tools whose raw output IS the answer. When one of these runs, the loop
   * returns its result verbatim as the final answer — the brain never reads it,
   * no truncation, no second LLM pass. Use for a "clerk" agent that only picks
   * the right tool and faithfully delivers the payload (e.g. a Confluence page)
   * for the caller to process. The brain still chooses which passthrough tool
   * to call; it just doesn't ingest the body.
   */
  passthroughTools?: string[];
  finalize?: () => string;
}

/**
 * A lightweight liveness/credentials report an agent can expose so an operator
 * UI can show its status. "ok" = ready; "degraded" = reachable but not fully
 * functional (e.g. an invalid/expired token). `detail` carries a short reason.
 */
export interface AgentHealth {
  status: "ok" | "degraded";
  detail?: string;
}

export interface AgentEvidence {
  sourceRevision?: string;
  sourceDirty?: boolean;
  personaHash?: string;
  skillHash?: string;
}

export interface AgentCommandRequest {
  text: string;
  contextId: string;
  signal: AbortSignal;
}

export type AgentCommandResult =
  | { kind: "unhandled" }
  | { kind: "response"; text: string };

/** A tenant of the hub: one discoverable A2A agent backed by an `LlmProvider`. */
export interface AgentDefinition {
  /** URL-safe id; becomes the mount path /agents/<id>. */
  id: string;
  name: string;
  description: string;
  skill: AgentSkill;
  systemPrompt: string;
  /** Content-addressed source provenance captured by the host at registration. */
  evidence?: AgentEvidence;
  /**
   * Optionally handle an exact command before model selection and runtime
   * creation. Return `unhandled` to preserve the normal model/tool path.
   */
  handleCommand?: (
    request: AgentCommandRequest,
  ) => AgentCommandResult | Promise<AgentCommandResult>;
  /**
   * Build a fresh per-task runtime. Receives the chat session id (A2A
   * contextId) so an agent can scope outbound calls to the same session
   * (e.g. an orchestrator sharing the chat with the specialists it delegates
   * to). Stateless agents may ignore it.
   */
  createRuntime: (contextId: string) => AgentRuntime;
  /**
   * Optional health probe. When defined, the host exposes it at
   * `GET /agents/<id>/health` so an operator UI can poll it (e.g. to flag an
   * agent whose backing token is invalid). Should be cheap/cached and must not
   * throw — return `{ status: "degraded", detail }` on failure. Agents that
   * omit it are reported healthy.
   */
  checkHealth?: () => Promise<AgentHealth>;
}

