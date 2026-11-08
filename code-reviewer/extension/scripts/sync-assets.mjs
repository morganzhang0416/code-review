import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(extensionDir, "..");
const outputDir = path.join(extensionDir, ".github");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(path.join(outputDir, "agents"), { recursive: true });
mkdirSync(path.join(outputDir, "skills"), { recursive: true });
cpSync(
  path.join(sourceDir, ".github", "agents", "local-reviewer.agent.md"),
  path.join(outputDir, "agents", "local-reviewer.agent.md"),
);

for (const skill of [
  "local-review",
  "local-doc-review",
  "general-code-quality",
  "cucumber-test-quality",
]) {
  cpSync(
    path.join(sourceDir, ".github", "skills", skill),
    path.join(outputDir, "skills", skill),
    { recursive: true },
  );
}
