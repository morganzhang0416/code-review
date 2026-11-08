// Portable helpers for loading the local review instructions and skills.

/**
 * Agent sourcing — let an A2A agent BE its repo's canonical agent instead of a
 * hand-rolled clone. Reads the original agent definition (e.g. a
 * `.github/agents/*.agent.md`) and its skill playbooks (`.github/skills/<name>/
 * SKILL.md`) from disk so the host wires them in as the system prompt + an
 * on-demand `<x>_skill` tool. One source of truth: edit the repo's agent/skills
 * and every host picks them up on next start.
 *
 * `vscode`-free: plain fs/path, so it works in any host. The extension finds the
 * repo root and passes it here; new agents reuse this instead of re-reading
 * files by hand.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AgentEvidence, LlmTool } from "./runtime";

/** One sourced skill playbook (a SKILL.md), kept verbatim. */
export interface SkillDoc {
  name: string;
  text: string;
}

/** The original agent + skills, sourced from a repo. */
export interface AgentSource {
  /** The agent's instructions (frontmatter stripped), or undefined if unread. */
  agentPrompt?: string;
  skills: SkillDoc[];
  evidence?: AgentEvidence;
}

/** Strip a leading YAML frontmatter block (--- … ---) from markdown. */
export function stripFrontmatter(text: string): string {
  return text.startsWith("---")
    ? text.replace(/^---[\s\S]*?\n---\s*\n?/, "")
    : text;
}

/**
 * Walk up from each start dir until a directory contains `marker`; return it.
 * Lets a host locate the repo root regardless of the agent's cwd.
 */
export function findRepoRoot(
  marker: string,
  startDirs: string[],
): string | undefined {
  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

export interface LoadAgentSourceOptions {
  /** Repo root. Skipped lookups fall back to the built-in agent prompt. */
  root: string | undefined;
  /** Agent definition relative to root (or absolute), e.g. ".github/agents/wiki.agent.md". */
  agentFile?: string;
  /** Skills dir relative to root, e.g. ".github/skills". */
  skillsDir?: string;
  /** Skill names to source (each <skillsDir>/<name>/SKILL.md). */
  skillNames?: string[];
  log?: (message: string) => void;
}

/** Best-effort: source the agent definition + named skills from a repo. */
export function loadAgentSource(opts: LoadAgentSourceOptions): AgentSource {
  const { root, agentFile, skillsDir, skillNames = [], log } = opts;
  if (!root) {
    log?.("agent source: repo root not found; using fallback prompt");
    return { skills: [] };
  }
  let agentPrompt: string | undefined;
  if (agentFile) {
    try {
      // resolve (not join) so an absolute agentFile outside the repo also works.
      agentPrompt = stripFrontmatter(
        fs.readFileSync(path.resolve(root, agentFile), "utf8"),
      );
    } catch {
      log?.(`agent source: ${agentFile} unreadable; using fallback prompt`);
    }
  }
  const skills: SkillDoc[] = [];
  if (skillsDir) {
    for (const name of skillNames) {
      try {
        const text = fs.readFileSync(
          path.join(root, skillsDir, name, "SKILL.md"),
          "utf8",
        );
        skills.push({ name, text });
      } catch {
        /* skill absent — skip */
      }
    }
  }
  log?.(
    `agent source: prompt ${agentPrompt ? "ok" : "fallback"} + ${skills.length} skills`,
  );
  return {
    agentPrompt,
    skills,
    evidence: sourceEvidence(root, agentPrompt, skills),
  };
}

function sourceEvidence(
  root: string,
  agentPrompt: string | undefined,
  skills: SkillDoc[],
): AgentEvidence {
  const evidence: AgentEvidence = {};
  if (agentPrompt) evidence.personaHash = sha256(agentPrompt);
  if (skills.length > 0) {
    evidence.skillHash = sha256(
      JSON.stringify(
        skills.map((skill) => ({ name: skill.name, text: skill.text })),
      ),
    );
  }
  try {
    evidence.sourceRevision = execFileSync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    evidence.sourceDirty =
      execFileSync("git", ["-C", root, "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
  } catch {
    // Non-Git sources remain attributable by content hashes only.
  }
  return evidence;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Compose the live system prompt: sourced prompt (or fallback) + addendum. */
export function buildSystemPrompt(
  source: AgentSource | undefined,
  fallback: string,
  addendum?: string,
): string {
  const base = source?.agentPrompt?.trim() || fallback;
  return addendum ? `${base}\n\n${addendum}` : base;
}

/**
 * A standard `<id>_skill` tool: loads one sourced skill's text so the brain
 * follows the original procedure verbatim. Returns the tool plus a dispatch
 * handler an agent slots into its switch.
 *
 * GUARDRAIL: throws on an empty `skills` list. A skill loader that advertises
 * no skills is always a wiring bug — the classic mistake is building the tool
 * spec at module scope from `[]` while the handle is built later from the real
 * skills, so the model is told "Available: (none)." and can never name a skill.
 * CANONICAL PATTERN: build BOTH spec and handle from the SAME populated list,
 * inside `createRuntime`/`buildRuntime` where the sourced skills are in hand:
 *
 *   const { tool: skill, handle: loadSkill } = skillTool(skills, "wiki");
 *   const tools = [skill, ...otherTools];
 *
 * If an agent genuinely has no skills, don't add a skill tool at all.
 */
export function skillTool(
  skills: SkillDoc[],
  id = "load",
): { tool: LlmTool; handle: (name: string) => string } {
  if (skills.length === 0) {
    throw new Error(
      `skillTool("${id}") was given no skills. Build the tool from the real ` +
        "sourced skills inside createRuntime (not an empty list at module " +
        "scope); if the agent has no skills, omit the skill tool entirely.",
    );
  }
  const foldedNames = new Set<string>();
  for (const skill of skills) {
    const folded = skill.name.toLowerCase();
    if (foldedNames.has(folded)) {
      throw new Error(
        `skillTool("${id}") received duplicate case-insensitive skill name "${skill.name}".`,
      );
    }
    foldedNames.add(folded);
  }
  const tool: LlmTool = {
    name: `${id}_skill`,
    description:
      "Load an original skill procedure verbatim and follow it. Call this " +
      "FIRST before performing a skill-backed task; do not improvise. Returns " +
      "the SKILL.md text.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `Skill name. Available: ${skills.map((s) => s.name).join(", ")}.`,
        },
      },
      required: ["name"],
    },
  };
  const handle = (name: string): string => {
    const want = name.trim().toLowerCase();
    const found = skills.find((skill) => skill.name.toLowerCase() === want);
    if (found) return found.text;
    const have = skills.map((s) => s.name).join(", ") || "(none sourced)";
    return `No skill "${name}". Available: ${have}.`;
  };
  return { tool, handle };
}
