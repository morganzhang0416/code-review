import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentSource, skillTool } from "./core/agentSource";
import { createRepoToolset } from "./core/repoTools";
import type { AgentDefinition, AgentHealth, AgentRuntime, LlmToolCall } from "./core/runtime";

interface ReviewerContext {
  id: string;
  repoRoot?: string;
  options: Record<string, unknown>;
  getRegistryUrl: () => string;
  log: (message: string) => void;
}

const SKILL_NAMES = [
  "local-review",
  "general-code-quality",
  "cucumber-test-quality",
  "local-doc-review",
];

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  return filePath.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
}

function optionString(options: Record<string, unknown>, name: string): string {
  const value = options[name];
  return typeof value === "string" ? value.trim() : "";
}

export function createAgent(context: ReviewerContext): AgentDefinition {
  if (context.id !== "reviewer") {
    throw new Error(`reviewer adapter received unexpected id "${context.id}"`);
  }
  const wrapperRoot = context.repoRoot;
  if (!wrapperRoot) throw new Error("reviewer requires a repository root");

  const configuredRoot =
    optionString(context.options, "rootDir") ||
    optionString(context.options, "targetRoot");
  const rootDir = path.resolve(
    expandHome(configuredRoot || path.join(os.homedir(), "workspace")),
  );
  if (!fs.statSync(rootDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`reviewer rootDir is not a directory: ${rootDir}`);
  }

  const source = loadAgentSource({
    root: wrapperRoot,
    agentFile: ".github/agents/local-reviewer.agent.md",
    skillsDir: ".github/skills",
    skillNames: SKILL_NAMES,
    log: context.log,
  });
  const systemPrompt = source.agentPrompt?.trim();
  if (!systemPrompt) throw new Error("reviewer persona did not load");
  if (source.skills.length !== SKILL_NAMES.length) {
    throw new Error(
      `reviewer expected ${SKILL_NAMES.length} skills but loaded ${source.skills.length}`,
    );
  }

  const createRuntime = (): AgentRuntime => {
    const review = skillTool(source.skills, "review");
    const repo = createRepoToolset({
      root: rootDir,
      limits: {
        excludeDirs: [".git", ".worktrees", "target", "node_modules"],
      },
    });
    const readOnlyTools = repo.tools.filter((tool) => tool.name !== "edit");
    return {
      tools: [review.tool, ...readOnlyTools],
      dispatch: async (call: LlmToolCall, onProgress, signal): Promise<string> => {
        if (call.name === review.tool.name) {
          const input = (call.input ?? {}) as Record<string, unknown>;
          return review.handle(typeof input.name === "string" ? input.name : "");
        }
        if (call.name === "edit") {
          return "This agent is review-only and cannot write files. Return the review as your response.";
        }
        return (
          (await repo.dispatch(call, onProgress, signal)) ??
          `Unknown tool: ${call.name}`
        );
      },
      maxSteps: 0,
    };
  };

  const checkHealth = async (): Promise<AgentHealth> => {
    if (!fs.statSync(rootDir, { throwIfNoEntry: false })?.isDirectory()) {
      return { status: "degraded", detail: `Review root is not a directory: ${rootDir}` };
    }
    return { status: "ok" };
  };

  return {
    id: context.id,
    name: "Reviewer",
    description:
      "Reviews local repository changes and returns code or documentation findings. It never writes to the reviewed repository.",
    skill: {
      id: context.id,
      name: "Reviewer",
      description: "Read-only code and documentation review for local repositories.",
      tags: ["code-review", "documentation", "local-review"],
      examples: [
        "Review the current feature branch against develop.",
        "Review the documentation changes on this branch.",
      ],
    },
    systemPrompt,
    createRuntime,
    checkHealth,
  };
}
