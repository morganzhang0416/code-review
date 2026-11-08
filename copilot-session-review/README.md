# Copilot Session Review

A local Node.js tool that reads saved VS Code and Copilot session metadata, groups work into sessions, checks recorded tool and test outcomes, and writes a Markdown and JSON summary. Its findings are rule-based; it does not send history to a language model.

## Run

Requirements: Node.js 20 or later.

1. Install dependencies with `npm ci`.
2. Run `npm run review`.
3. Open the generated report under `reports/`.

Optional settings use environment variables. `SESSION_REVIEW_LOOKBACK_HOURS` sets the review window, `SESSION_REVIEW_REPORTS_DIR` changes the output folder, and `SESSION_REVIEW_SESSION_STATE` or `SESSION_REVIEW_VSCODE_DIRS` set the local history locations.

## Privacy

The tool reads local Copilot and VS Code history. Reports may contain prompt excerpts, project names, file paths, and activity details, even when common secrets are redacted. Keep generated reports private and review them before sharing. The project includes only synthetic test data, not real session history.

This demo contains analysis and reporting only. It does not schedule jobs, archive sessions, create commits, or push Git changes.
