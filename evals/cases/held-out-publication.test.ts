import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const aggregatePublicFiles = [
  "evals/cases/held-out-v1.ts",
  "evals/cases/held-out-v1.test.ts",
  "evals/runner/v1.ts",
  "evals/runner/v1.test.ts",
  "docs/submission/held-out-cases-v1.md",
] as const;

const forbiddenProductionStructures = [
  ["private", "canary"].join("-"),
  ["DEVELOPMENT", "CASES"].join("_"),
  ["development", "Exclusion"].join(""),
  ["chunk", "Expectations"].join(""),
  ["known", "Contradictions"].join(""),
  ["expected", "Abstentions"].join(""),
  ["experiment", "Limitations"].join(""),
  ["adversarial", "Treatments"].join(""),
] as const;

function normalized(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

describe("held-out aggregate publication boundary", () => {
  it("keeps production scoring structures and development identities out of aggregate public blobs", () => {
    const findings: string[] = [];
    for (const relativePath of aggregatePublicFiles) {
      const bytes = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      const searchable = normalized(bytes);
      for (const token of forbiddenProductionStructures) {
        if (searchable.includes(normalized(token))) {
          findings.push(`${relativePath}: ${token}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
