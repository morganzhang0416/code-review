// Public exports for the portable agent runtime.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

/**
 * Public surface of the internal LLM runtime module.
 *
 * Everything re-exported here is host-agnostic (no `vscode` imports) and is the
 * intended seam for a future standalone runtime package. The
 * Copilot adapter under `providers/` is host-specific and imported directly,
 * not re-exported here, so this entry point stays portable.
 */
export type {
  AgentDefinition,
  AgentEvidence,
  AgentCommandRequest,
  AgentCommandResult,
  AgentRuntime,
  AgentHealth,
  AgentProgress,
  ProgressKind,
  ProgressEvent,
  ProgressStatus,
} from "./agent";
export type {
  LlmTool,
  LlmToolCall,
  LlmTextPart,
  LlmToolCallPart,
  LlmStreamPart,
  LlmAssistantPart,
  LlmToolResult,
  LlmMessage,
  LlmChatRequest,
  LlmModel,
  LlmProvider,
} from "./llm";
export { runToolLoop, type LoopResult } from "./toolLoop";
