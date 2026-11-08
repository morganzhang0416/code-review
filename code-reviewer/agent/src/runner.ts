/**
 * Thin runner: the single seam that drives one review invocation on top of the
 * shared `createAgent()`. It is brain-agnostic (no `vscode`) — the caller
 * injects an `LlmProvider`, so the same runner serves the VS Code extension
 * (Copilot brain) today and a headless CLI (external API brain) later.
 *
 * It contains NO review logic: it only builds the `createAgent` context,
 * selects a model, and runs the portable tool loop to completion.
 */
import { createAgent } from "./local-adapter";
import {
  runToolLoop,
  type AgentProgress,
  type LlmMessage,
  type LlmProvider,
} from "./core/runtime";

/** Default Copilot model family; overridable per request (e.g. a setting). */
export const DEFAULT_MODEL_FAMILY = "claude-sonnet-4.6";

export interface RunReviewRequest {
  /** The user's local review request, including a repository path and branch. */
  task: string;
  /**
   * Root that holds the packaged persona + skills (`.github/**`). In the
   * extension this is the install dir (`extensionUri.fsPath`); `createAgent`
   * also requires it to be a real directory.
   */
  repoRoot: string;
  /** `createAgent` options, including the optional `rootDir`. */
  options: Record<string, unknown>;
  /** The brain. The extension supplies a Copilot-backed provider. */
  provider: LlmProvider;
  /** Preferred model family; falls back to provider defaults when absent. */
  modelFamily?: string;
  /** Live progress sink (narration + streamed answer). */
  onProgress?: AgentProgress;
  /** Diagnostics sink. */
  log?: (message: string) => void;
  /** Cancellation. */
  signal: AbortSignal;
  /** Prior conversation, to give the agent memory across turns. */
  history?: LlmMessage[];
}

export interface RunReviewResult {
  summary: string;
  steps: number;
  messages: LlmMessage[];
}

/** Build the agent, pick a model, and run one review to completion. */
export async function runReview(
  req: RunReviewRequest,
): Promise<RunReviewResult> {
  const log = req.log ?? ((): void => {});
  const agent = createAgent({
    id: "reviewer",
    repoRoot: req.repoRoot,
    options: req.options,
    getRegistryUrl: () => "",
    log,
  });
  const model = await req.provider.selectModel(
    req.modelFamily ?? DEFAULT_MODEL_FAMILY,
  );
  const runtime = agent.createRuntime(agent.id);
  const onProgress: AgentProgress = req.onProgress ?? ((): void => {});
  const result = await runToolLoop(
    model,
    agent.systemPrompt,
    req.task,
    runtime,
    onProgress,
    req.signal,
    req.history,
  );
  return {
    summary: result.summary,
    steps: result.steps,
    messages: result.messages,
  };
}
