// Portable language model interfaces for the local reviewer.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

/**
 * Provider-neutral LLM types and the `LlmProvider` seam.
 *
 * The tool loop and agent runtime depend ONLY on these types — never on
 * `vscode.lm`. A concrete provider (e.g. `CopilotProvider`) adapts a real
 * backend to this interface. This seam is what lets the runtime split into a
 * standalone library later: everything in this folder except `providers/` is
 * host-agnostic and free of `vscode` imports.
 */

/** A tool the model may call. Shape mirrors a JSON-schema tool declaration. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema?: object;
}

/** A single tool invocation requested by the model. */
export interface LlmToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface LlmTextPart {
  kind: "text";
  text: string;
}

export interface LlmToolCallPart {
  kind: "tool-call";
  call: LlmToolCall;
}

/** A streamed chunk from the model: assistant text or a requested tool call. */
export type LlmStreamPart = LlmTextPart | LlmToolCallPart;

/** The parts that make up one assistant turn (echoed back into history). */
export type LlmAssistantPart = LlmTextPart | LlmToolCallPart;

/** The result of executing one tool call, fed back to the model next turn. */
export interface LlmToolResult {
  callId: string;
  content: string;
}

/** Provider-neutral conversation message. */
export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: LlmAssistantPart[] }
  | { role: "tool"; results: LlmToolResult[] };

/** One chat turn's input: prior messages plus the tools on offer. */
export interface LlmChatRequest {
  messages: LlmMessage[];
  tools: LlmTool[];
}

/** A selected model instance able to stream a single chat turn. */
export interface LlmModel {
  readonly vendor: string;
  readonly id: string;
  readonly family: string;
  /** Stream assistant text + tool calls for one turn. Honors `signal`. */
  chat(
    request: LlmChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamPart>;
}

/**
 * The brain seam. A consumer supplies a provider (Copilot today; a direct API
 * provider once the runtime is split into its own library).
 */
export interface LlmProvider {
  /** Resolve the exact requested family or reject when it is unavailable. */
  selectModel(family: string): Promise<LlmModel>;
}
