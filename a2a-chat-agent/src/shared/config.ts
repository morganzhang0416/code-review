/**
 * Shared config + small helpers for the A2A spike.
 */
import type { Message, Part, TextPart } from "@a2a-js/sdk";

export const HOST = process.env.A2A_HOST ?? "localhost";
export const PORT = Number(process.env.A2A_PORT ?? 41241);
export const BASE_URL = `http://${HOST}:${PORT}`;

/** Standard well-known path the A2A SDK serves the agent card from. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const AGENT_CARD_URL = `${BASE_URL}${AGENT_CARD_PATH}`;

/** Pull all text content out of a Message's parts. */
export function textOf(message: Message): string {
  return message.parts
    .filter((p: Part): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("");
}
