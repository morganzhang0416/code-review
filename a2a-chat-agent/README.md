# A2A Chat Agent

A small TypeScript demo of an AI agent that uses the Agent2Agent (A2A) protocol. The server exposes an agent card and streams task updates. A separate client discovers the agent and sends a prompt. The agent gets its response from GitHub Models.

## Run

Requirements: Node.js 20 or later and a GitHub token with access to GitHub Models.

1. Install dependencies with `npm ci`.
2. Set `GITHUB_TOKEN` in your terminal. Do not put a real token in a file or commit it.
3. In one terminal, run `npm run agent`.
4. In another terminal, run `npm run client -- "Explain A2A in one sentence"`.

The server listens on `127.0.0.1`. Prompts are sent to the configured GitHub Models endpoint. Do not send private or work data in demo prompts.

## What It Shows

- Agent-card discovery through the standard well-known route.
- A JSON-RPC request and streamed task lifecycle.
- A clean boundary between the model-backed server and a reusable client.
- A configurable model name and endpoint, with the token read from an environment variable.

No real token, company endpoint, or user data is included in this project.
