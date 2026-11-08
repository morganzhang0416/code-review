const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createAgent } = require("../dist/local-adapter.js");

test("cucumber test quality skill is advertised and loadable", async () => {
  const reviewerRoot = path.resolve(__dirname, "../..");
  const definition = createAgent({
    id: "reviewer",
    repoRoot: reviewerRoot,
    options: { rootDir: reviewerRoot },
    getRegistryUrl: () => "",
    log: () => {},
  });
  const runtime = definition.createRuntime();
  const reviewSkill = runtime.tools.find((tool) => tool.name === "review_skill");

  assert.ok(reviewSkill, "review_skill should be available");
  assert.match(
    reviewSkill.inputSchema.properties.name.description,
    /cucumber-test-quality/,
  );

  const content = await runtime.dispatch({
    name: "review_skill",
    input: { name: "cucumber-test-quality" },
  });
  assert.match(content, /# Cucumber Test Quality/);
  assert.match(content, /Scenario coverage/);
  assert.match(content, /Design patterns and repository conventions/);
  assert.match(content, /Reuse over copy and paste \(DRY\)/);
  assert.match(content, /Scenario-to-SUT contract/);
});