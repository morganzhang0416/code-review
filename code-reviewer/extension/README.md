# Reviewer

A read-only VS Code extension for reviewing local repository branches. It runs
on the user's Copilot model and does not connect to remote pull-request APIs.

## Install

```bash
code --install-extension reviewer-<version>.vsix
```

Reload VS Code after installing or upgrading.

## First-run checklist

1. Set `reviewer.rootDir` to the directory containing the repositories Reviewer
  may inspect (default: `~/workspace`).
2. Start a review with `@reviewer` or **Reviewer: Review...**.

## Use

- **Chat:** open Copilot Chat and mention `@reviewer`, e.g.
  `@reviewer review /path/to/repository on branch feature/x`.
- **Command:** run **Reviewer: Review…** from the Command Palette and answer the
  prompts with a local repository path and branch.

Example local review:

```text
@reviewer review /absolute/path/to/repo on branch feature/example against main
```

## Settings

| Setting | Purpose |
|---------|---------|
| `reviewer.rootDir` | Search root that must contain the repos you review (empty = `~/workspace`). |
| `reviewer.model` | Preferred Copilot model family (empty = default with fallback). |
The extension reads local repositories only. It does not store credentials,
post comments, edit files, commit, or push.
