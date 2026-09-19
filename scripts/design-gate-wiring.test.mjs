import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DESIGN_APPROVED_LABEL, TRIVIAL_LABEL } from "./design-gate.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/design-gate.yml");
const advisory = read(".github/workflows/harness-coverage-check.yml");

test("workflow secrets are the existing CI App secrets or built-in token", () => {
  const ci = read(".github/workflows/ci.yml");
  const allowed = new Set(["CK_CI_APP_ID", "CK_CI_APP_PRIVATE_KEY", "GITHUB_TOKEN"]);
  for (const text of [workflow, advisory]) {
    const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    assert.ok(secrets.includes("CK_CI_APP_ID"));
    assert.ok(secrets.includes("CK_CI_APP_PRIVATE_KEY"));
    for (const secret of secrets) {
      assert.ok(allowed.has(secret), `unexpected secret ${secret}`);
      if (secret !== "GITHUB_TOKEN") assert.ok(ci.includes(`secrets.${secret}`));
    }
  }
});

test("workflow approval label and contributor labels match gate constants", () => {
  assert.equal(workflow.match(/github\.event\.label\.name == '([^']+)'/)[1], DESIGN_APPROVED_LABEL);
  const contributing = read("CONTRIBUTING.md");
  for (const label of [DESIGN_APPROVED_LABEL, TRIVIAL_LABEL]) {
    assert.ok(contributing.includes(`\`${label}\``));
  }
});

test("advisory executes only trusted base code with the App token", () => {
  assert.match(advisory, /pull_request_target:/);
  assert.match(advisory, /uses: actions\/checkout@/);
  assert.doesNotMatch(advisory, /\bref:|\brepository:|pull_request\.head|\bpull_request:/);
  assert.match(advisory, /run: node scripts\/harness-coverage-check\.mjs/);
  assert.match(advisory, /GITHUB_TOKEN: \$\{\{ steps\.app_token\.outputs\.token \}\}/);
});
