// VS Code Copilot model provider for the local reviewer.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

/**
 * Copilot brain adapter: implements the runtime's `LlmProvider`/`LlmModel` seam
 * on top of `vscode.lm` (GitHub Copilot, e.g. Claude Sonnet 4.6).
 *
 * This is the ONLY file in the host-kit that imports `vscode`. It isolates the
 * host dependency so the A2A server (`server.ts`) and the runtime stay portable.
 * Any agent that runs inside a VS Code extension host (its own F5 session) uses
 * this provider to borrow Copilot's brain locally.
 */
import * as vscode from "vscode";
import type {
  LlmChatRequest,
  LlmMessage,
  LlmModel,
  LlmProvider,
  LlmStreamPart,
  LlmTool,
} from "../../agent/src/core/runtime";
import { bridgeAbortSignal, observeModelAttempt } from "./modelAttempt";
import { selectStrictCopilotModel } from "./modelSelection";

export interface CopilotProviderOptions {
  /** Optional sink for model-selection diagnostics. */
  log?: (message: string) => void;
}

function toVsTools(tools: LlmTool[]): vscode.LanguageModelChatTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function toVsMessages(
  messages: LlmMessage[],
): vscode.LanguageModelChatMessage[] {
  return messages.map((m) => {
    if (m.role === "user") {
      return vscode.LanguageModelChatMessage.User(m.text);
    }
    if (m.role === "assistant") {
      const parts = m.parts.map((p) =>
        p.kind === "text"
          ? new vscode.LanguageModelTextPart(p.text)
          : new vscode.LanguageModelToolCallPart(
              p.call.callId,
              p.call.name,
              (p.call.input ?? {}) as object,
            ),
      );
      return vscode.LanguageModelChatMessage.Assistant(parts);
    }
    // Tool results travel as a User message carrying result parts.
    const parts = m.results.map(
      (r) =>
        new vscode.LanguageModelToolResultPart(r.callId, [
          new vscode.LanguageModelTextPart(r.content),
        ]),
    );
    return vscode.LanguageModelChatMessage.User(parts);
  });
}

class CopilotModel implements LlmModel {
  constructor(private readonly model: vscode.LanguageModelChat) {}

  get vendor(): string {
    return this.model.vendor;
  }

  get id(): string {
    return this.model.id;
  }

  get family(): string {
    return this.model.family;
  }

  async *chat(
    request: LlmChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamPart> {
    const bridge = bridgeAbortSignal(
      signal,
      () => new vscode.CancellationTokenSource(),
    );
    try {
      const stream = observeModelAttempt(
        async () => {
          const response = await this.model.sendRequest(
            toVsMessages(request.messages),
            {
              tools: toVsTools(request.tools),
              toolMode: vscode.LanguageModelChatToolMode.Auto,
            },
            bridge.source.token,
          );
          return response.stream;
        },
        (part): LlmStreamPart | undefined => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return { kind: "text", text: part.value };
          }
          if (part instanceof vscode.LanguageModelToolCallPart) {
            return {
              kind: "tool-call",
              call: { callId: part.callId, name: part.name, input: part.input },
            };
          }
          return undefined;
        },
        signal,
      );
      yield* stream;
    } finally {
      bridge.dispose();
    }
  }
}

/** Selects and adapts the exact requested Copilot chat model family. */
export class CopilotProvider implements LlmProvider {
  constructor(private readonly options: CopilotProviderOptions = {}) {}

  async selectModel(family: string): Promise<LlmModel> {
    const model = await selectStrictCopilotModel(
      family,
      async (selector) => vscode.lm.selectChatModels(selector),
    );
    this.options.log?.(
      `Selected Copilot model "${model.id}" (${model.family}, ${model.version}).`,
    );
    return new CopilotModel(model);
  }
}
