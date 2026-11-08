# Local AI Code Reviewer

This project is a VS Code extension that uses GitHub Copilot to review code and
documentation changes in a local Git repository. It shows how an AI assistant
can use focused instructions and repository tools to produce a structured,
useful review instead of a general chat response.

## The Project

The reviewer checks a branch against its base branch. It reads the diff and
relevant source, then reports issues and suggested fixes in Copilot Chat. It
supports common programming languages, documentation, and Cucumber tests.

This project brings together:

- A VS Code chat participant, `@reviewer`, and a Command Palette action.
- A shared TypeScript runner that sends review work to the Copilot model.
- A local agent adapter that loads the review instructions and tools.
- Small, focused review guides for code, documentation, and Cucumber tests.
- Tests for loading and using the review skills.

## How AI Fits In

Copilot is the reasoning model. The project gives it a clear review role,
step-by-step skill guides, and tools to inspect a local repository. The model
uses those tools to gather evidence, apply the review steps, and explain its
findings. The skill files keep the review process easier to follow and update.

## Scope

The demo is for local repositories. It does not connect to pull-request
services, store service credentials, or post review comments. The agent does
not advertise a file-edit tool and is instructed to return suggestions rather
than change the reviewed code. Its shell tool can run commands within the
configured review root, so use it with trusted repositories.

Set `reviewer.rootDir` to a directory that contains the repository you want to
review. The default is `~/workspace`.

## Try It

Build the extension by following [extension/README.md](extension/README.md),
then ask Copilot Chat:

```text
@reviewer review /path/to/repository on branch feature/example against main
```

To run the agent tests:

```bash
cd agent
npm ci
npm test
```

## Project Map

- `.github/agents/local-reviewer.agent.md` defines the review role.
- `.github/skills/` contains the review procedures and quality guides.
- `agent/src/local-adapter.ts` connects those instructions to local tools.
- `agent/src/runner.ts` runs the review with the selected language model.
- `extension/src/` provides the VS Code interface and Copilot model provider.
