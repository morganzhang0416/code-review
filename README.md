# AI Project Demos

This folder contains three independent projects that show different ways to build with AI tools:

- [Local AI Code Reviewer](code-reviewer/README.md): a VS Code extension that uses Copilot to review local code and documentation changes.
- [A2A Chat Agent](a2a-chat-agent/README.md): a small language-model agent and client that communicate through the Agent2Agent protocol.
- [Copilot Session Review](copilot-session-review/README.md): a local analytics tool that turns Copilot activity history into a structured report.

Each project has its own setup notes. The Copilot session tool reads personal local history and can create private reports. Do not share generated reports. No project connects to company services.

When sharing these demos, include the source and project guides only. Leave out `.git` history, `node_modules`, generated build folders, environment files, and generated reports. The A2A demo needs a GitHub Models token at run time; keep it in the terminal environment and never upload it.
