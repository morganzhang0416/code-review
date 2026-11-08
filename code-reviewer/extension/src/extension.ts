/**
 * Thin VS Code layer for the standalone Reviewer. It contains NO review logic:
 * it only (1) reads local review settings, (2) picks the Copilot brain,
 * and (3) hands a review request to the local `runReview` runner.
 *
 * The user chooses the surface: a chat participant (`@reviewer`) or a command
 * (`Reviewer: Review…`). Both call the identical runner.
 */
import * as os from "node:os";
import * as vscode from "vscode";
import { runReview, DEFAULT_MODEL_FAMILY } from "../../agent/src/runner";
import { CopilotProvider } from "./copilotProvider";

/** Read `reviewer.*` settings into the `createAgent` options object. */
function readOptions(): Record<string, unknown> {
  const cfg = vscode.workspace.getConfiguration("reviewer");
  const options: Record<string, unknown> = {};
  const rootDir = cfg.get<string>("rootDir")?.trim();
  if (rootDir) options.rootDir = rootDir;
  return options;
}

function modelFamily(): string {
  const fam = vscode.workspace
    .getConfiguration("reviewer")
    .get<string>("model")
    ?.trim();
  return fam || DEFAULT_MODEL_FAMILY;
}

/** Bridge a VS Code cancellation token to a web `AbortSignal`. */
function abortFrom(token: vscode.CancellationToken): AbortController {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  else token.onCancellationRequested(() => ac.abort());
  return ac;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Reviewer");
  context.subscriptions.push(output);
  const log = (message: string): void => output.appendLine(message);
  const provider = new CopilotProvider({ log });
  // The install dir holds the packaged persona + skills (.github/**).
  const repoRoot = context.extensionUri.fsPath;

  // Surface 1: chat participant `@reviewer`.
  const participant = vscode.chat.createChatParticipant(
    "reviewer",
    async (request, _chatContext, stream, token) => {
      const task = request.prompt.trim();
      if (!task) {
        stream.markdown(
          "Tell me what to review, e.g. `review /path/to/repo on branch feature/x` " +
            "or name a local repository branch.",
        );
        return;
      }
      const ac = abortFrom(token);
      try {
        const result = await runReview({
          task,
          repoRoot,
          options: readOptions(),
          provider,
          modelFamily: modelFamily(),
          onProgress: (message, meta) => {
            const kind = typeof meta === "string" ? meta : meta?.kind;
            // Answer events carry the cumulative text; render it once at the
            // end. Narration streams live as progress.
            if (kind === "answer") return;
            stream.progress(message.split("\n")[0].slice(0, 160));
          },
          log,
          signal: ac.signal,
        });
        stream.markdown(result.summary);
      } catch (err) {
        stream.markdown(`**Reviewer error:** ${errorText(err)}`);
      }
    },
  );
  context.subscriptions.push(participant);

  // Surface 2: command `Reviewer: Review…` (local repo and branch prompt).
  context.subscriptions.push(
    vscode.commands.registerCommand("reviewer.review", async () => {
      const task = await promptForReviewTask();
      if (!task) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Reviewer",
          cancellable: true,
        },
        async (progress, token) => {
          const ac = abortFrom(token);
          try {
            const result = await runReview({
              task,
              repoRoot,
              options: readOptions(),
              provider,
              modelFamily: modelFamily(),
              onProgress: (message, meta) => {
                const kind = typeof meta === "string" ? meta : meta?.kind;
                if (kind === "answer") return;
                progress.report({ message: message.split("\n")[0].slice(0, 80) });
              },
              log,
              signal: ac.signal,
            });
            const doc = await vscode.workspace.openTextDocument({
              language: "markdown",
              content: result.summary,
            });
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (err) {
            void vscode.window.showErrorMessage(`Reviewer: ${errorText(err)}`);
          }
        },
      );
    }),
  );

}

export function deactivate(): void {}

async function promptForReviewTask(): Promise<string | undefined> {
  const repo = await vscode.window.showInputBox({
    prompt: "Absolute path of the repo to review",
    value: firstWorkspaceFolder() ?? os.homedir(),
    ignoreFocusOut: true,
  });
  if (!repo?.trim()) return undefined;
  const branch = await vscode.window.showInputBox({
    prompt: "Branch to review (leave empty for the current branch)",
    ignoreFocusOut: true,
  });
  if (branch === undefined) return undefined;
  return branch.trim()
    ? `Review ${repo.trim()} on branch ${branch.trim()}`
    : `Review ${repo.trim()} on its current branch`;
}

function firstWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
