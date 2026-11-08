/**
 * A2A client — the "consumer" side of the spike.
 *
 * It does the full round-trip that any A2A-speaking agent (including a GitHub
 * Copilot agent) would do:
 *   1. Discover the remote agent by fetching its agent card.
 *   2. Send a user message and STREAM the task lifecycle back.
 *   3. Print the agent's final result.
 *
 * Run a few example prompts, or pass your own:
 *   npm run client -- "reverse: hello from copilot"
 */
import { v4 as uuidv4 } from "uuid";
import type { Message, MessageSendParams } from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { BASE_URL, textOf } from "../shared/config.js";

function userMessage(text: string): Message {
  return {
    kind: "message",
    role: "user",
    messageId: uuidv4(),
    parts: [{ kind: "text", text }],
  };
}

async function runPrompt(client: Client, prompt: string): Promise<void> {
  console.log(`\n>>> ${prompt}`);

  const params: MessageSendParams = { message: userMessage(prompt) };
  const stream = client.sendMessageStream(params);

  for await (const event of stream) {
    switch (event.kind) {
      case "task":
        console.log(`    [task ${event.id.slice(0, 8)}] ${event.status.state}`);
        break;
      case "status-update": {
        const suffix = event.final ? " (final)" : "";
        console.log(`    [status] ${event.status.state}${suffix}`);
        if (event.status.message) {
          console.log(`    <<< ${textOf(event.status.message)}`);
        }
        break;
      }
      case "message":
        console.log(`    <<< ${textOf(event)}`);
        break;
      default:
        console.log(`    [${event.kind}]`);
    }
  }
}

// 1. Discovery: fetch the agent card from the well-known URL and build a client.
// This client is a GENERIC A2A consumer — it hosts nothing. By default it
// targets the local spike server (src/agent/server.ts). Point it at ANY other
// A2A agent with A2A_AGENT_URL, e.g.:
//   A2A_AGENT_URL=http://localhost:41241/agents/<id> npm run client -- "..."
// The card resolver joins ".well-known/agent-card.json" RELATIVE to this URL,
// so a path-style agent URL needs a trailing slash or the last segment
// gets stripped during resolution.
const rawAgentUrl = process.env.A2A_AGENT_URL ?? BASE_URL;
const agentUrl = rawAgentUrl.endsWith("/") ? rawAgentUrl : `${rawAgentUrl}/`;
const factory = new ClientFactory();
const client = await factory.createFromUrl(agentUrl);
const card = await client.getAgentCard();
console.log(`[client] Connected to "${card.name}" v${card.version} @ ${agentUrl}`);
console.log(`[client] ${card.description}`);
console.log(`[client] streaming=${card.capabilities.streaming ?? false}`);

// 2. Send prompts (CLI args override the defaults).
const cliPrompt = process.argv.slice(2).join(" ").trim();
const prompts = cliPrompt
  ? [cliPrompt]
  : [
      "reverse: hello from copilot",
      "upper: a2a interop works",
      "count: how many words are in this sentence",
      "just echo me back",
    ];

for (const prompt of prompts) {
  await runPrompt(client, prompt);
}

console.log("\n[client] Done.");
