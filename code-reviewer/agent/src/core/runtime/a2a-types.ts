// Local, dependency-free shim for the one A2A type the runtime references.
// The full type comes from a protocol SDK; this project only needs
// the fields the Reviewer's `AgentDefinition.skill` actually uses, so we avoid
// pulling the A2A SDK into the extension bundle. `sync-core` repoints the
// vendored `agent.ts` import here.
//
// This mirrors the protocol SDK's `AgentSkill` shape.
// If a re-sync (npm run sync-core) surfaces a NEW required field the Reviewer
// populates, add it here too.

/** Minimal A2A-compatible skill descriptor. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}
