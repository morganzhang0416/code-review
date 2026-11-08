#!/usr/bin/env node
// Thin-boundary guard: the extension layer must stay glue-only. It may import
// ONLY the shared runner, its own vendored provider, node builtins, and vscode
// — never the review internals (fleet-adapter's tools, skills, persona, or the
// remote-service logic). This keeps review behaviour in the adapter and skills.
// CI fails on violation. Referenced by docs/standalone-design.md.
//
// It catches static `import`, dynamic `import(...)`, AND `require(...)` so the
// boundary cannot be bypassed at runtime, and it recurses through src/ so a new
// subfolder cannot escape the policy. Limitation: only LITERAL specifiers are
// checked — a computed/template specifier (e.g. import(`../${n}`)) is out of
// scope for static scanning. Comments are stripped before matching so a
// documentation comment mentioning a path can't false-fail CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Per-file (relative to src/) allowlist of import-specifier prefixes.
const ALLOW = {
  "extension.ts": ["node:", "vscode", "./copilotProvider", "../../agent/src/runner"],
  "copilotProvider.ts": ["node:", "vscode", "./modelAttempt", "./modelSelection", "../../agent/src/core/runtime"],
  "modelAttempt.ts": ["node:", "./modelFailure"],
  "modelFailure.ts": ["node:"],
  "modelSelection.ts": ["node:", "vscode"],
};

// Static `import`/`export ... from "x"`, a bare `import "x"`, a multi-line
// `} from "x"` line, dynamic `import("x")`, and `require("x")`. Static forms
// need `from` (or a bare import) so a string constant such as
// `export const A = "A"` is not mistaken for a module specifier.
const specRe =
  /(?:^\s*(?:import|export)[^"'\n]*\bfrom\s*["']([^"']+)["'])|(?:^\s*import\s*["']([^"']+)["'])|(?:^\s*\}\s*from\s*["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["'])|(?:\brequire\s*\(\s*["']([^"']+)["'])/gm;

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const violations = [];
for (const full of tsFiles(SRC)) {
  const rel = relative(SRC, full);
  const allow = ALLOW[rel];
  if (!allow) {
    violations.push(`${rel}: unexpected extension file (no import policy — add it to ALLOW)`);
    continue;
  }
  const text = readFileSync(full, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/^\s*\/\/.*$/gm, ""); // strip line comments
  for (const m of text.matchAll(specRe)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!spec) continue;
    if (!allow.some((p) => spec === p || spec.startsWith(p))) {
      violations.push(`${rel}: forbidden import "${spec}" (allowed: ${allow.join(", ")})`);
    }
  }
}

if (violations.length) {
  console.error("Thin-boundary check FAILED:\n  " + violations.join("\n  "));
  process.exit(1);
}
console.log("Thin-boundary check passed.");
