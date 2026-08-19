import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "..");
const publicRoots = [
  resolve(workspaceRoot, "evals"),
  resolve(workspaceRoot, "docs", "submission"),
];
const publicEntryPointFiles = [
  resolve(workspaceRoot, "README.md"),
  resolve(workspaceRoot, "docs", "RESEARCH_BASIS.md"),
];

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    })
    .sort();
}

const trackerPrefix = ["E", "V", "F"].join("");
const privateControlFragments = [
  ["AGENTS", ".md"].join(""),
  ["AGENTS", ".override", ".md"].join(""),
  ["docs", "EXECPLAN.md"].join("/"),
  ["docs", "internal"].join("/"),
  ["agent", "workflow"].join("_"),
  [".worktree", "include"].join(""),
  ["HANDOFF", ".template.md"].join(""),
  ["WORKTREE", "_AGENTS.template.md"].join(""),
  ["C:", "Users"].join("\\"),
  ["/", "Users", "/"].join(""),
];
const internalCodenames = [["Evi", "Forge"].join("")];
const secretFragments = [
  ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
];
const signatures = [
  {
    label: "internal tracker key",
    pattern: new RegExp(`\\b${trackerPrefix}-\\d+\\b`, "g"),
  },
  {
    label: "personal email",
    pattern:
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    label: "assigned secret",
    pattern:
      /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/gi,
  },
  {
    label: "provider credential",
    pattern:
      /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  },
];

describe("public evaluation and submission artifacts", () => {
  it("presents a complete, link-valid judge-facing README", () => {
    const readmePath = resolve(workspaceRoot, "README.md");
    const readme = readFileSync(readmePath, "utf8");

    for (const requiredSection of [
      "## Why EvidenceForge",
      "## How the workflow works",
      "## Verified capabilities",
      "## Architecture and stack",
      "## Quick start",
      "## Verification",
      "## Evidence boundary and current status",
      "## Safety, rights, and governance",
    ]) {
      expect(readme).toContain(requiredSection);
    }

    for (const requiredTruth of [
      "ReverieHacks 2026 Software Development",
      "Exact passage provenance",
      "deterministic verification, model assessment, and human review",
      "Postgres-backed run durability",
      "A successful live end-to-end rehearsal is not claimed",
      "does not crawl arbitrary URLs, bypass paywalls",
    ]) {
      expect(readme).toContain(requiredTruth);
    }

    expect(readme).not.toMatch(
      /!\[[^\]]*(?:build|coverage|license|deploy)[^\]]*\]\([^)]*(?:badge|shields\.io)/i,
    );

    const relativeTargets = [
      ...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g),
    ]
      .map((match) => match[1]!.trim())
      .filter((target) => !/^(?:https?:|mailto:|#)/i.test(target))
      .map((target) => target.split("#", 1)[0]!);

    expect(relativeTargets.length).toBeGreaterThan(0);
    for (const target of relativeTargets) {
      expect(existsSync(resolve(workspaceRoot, target)), target).toBe(true);
    }

    expect(readme).not.toContain("Load golden fixture");
    expect(readme).not.toContain("Continue to recorded fixture workbench");
  });

  it("exclude internal tracking, control-plane, identity, codename, and secret material", () => {
    const findings: string[] = [];
    const fragments = [
      ...privateControlFragments.map((value) => ({
        label: "control-plane fragment",
        value,
      })),
      ...internalCodenames.map((value) => ({
        label: "internal codename",
        value,
      })),
      ...secretFragments.map((value) => ({
        label: "secret material",
        value,
      })),
    ];

    const publicFiles = [
      ...new Set([...publicRoots.flatMap(filesBelow), ...publicEntryPointFiles]),
    ];

    for (const file of publicFiles) {
      const displayPath = relative(workspaceRoot, file).replaceAll("\\", "/");
      const content = readFileSync(file, "utf8");
      const searchable = `${displayPath}\n${content}`;

      for (const { label, value } of fragments) {
        if (searchable.includes(value)) {
          findings.push(`${displayPath}: ${label}`);
        }
      }
      for (const { label, pattern } of signatures) {
        pattern.lastIndex = 0;
        if (pattern.test(searchable)) {
          findings.push(`${displayPath}: ${label}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("states exact documentation provenance and hash boundaries", () => {
    const nodeReference = readFileSync(
      resolve(workspaceRoot, "docs", "submission", "workflow-node-reference.md"),
      "utf8",
    );
    const executiveSummary = readFileSync(
      resolve(workspaceRoot, "docs", "submission", "executive-summary.md"),
      "utf8",
    );

    expect(nodeReference).toContain(
      "Binds current per-node prompt/schema/generation/transport/timeout/retry/capability policies and current reviewer identity; the primary identity is bound elsewhere in the complete configuration.",
    );
    expect(nodeReference).toContain(
      "Binds fixture ID and canonical SHA, packet fingerprint, rights-approval SHA, ordered source/chunk IDs, and source/chunk content hashes—no prompt, model, or node-policy fields.",
    );
    expect(nodeReference).not.toContain(
      "Binds current model identities and live transport/validation policies.",
    );
    expect(nodeReference).not.toContain(
      "Binds fixture, packet, rights, prompt, model, and node authority inputs.",
    );
    expect(executiveSummary).toContain("bounded, researcher-approved packet");
    expect(executiveSummary).toContain("No successful hosted rehearsal is claimed");
  });

  it("frames current public entry points as a Software Development application", () => {
    const readme = readFileSync(resolve(workspaceRoot, "README.md"), "utf8");
    const researchBasis = readFileSync(
      resolve(workspaceRoot, "docs", "RESEARCH_BASIS.md"),
      "utf8",
    );
    const executiveSummary = readFileSync(
      resolve(workspaceRoot, "docs", "submission", "executive-summary.md"),
      "utf8",
    );
    const publicEntryPoints = [readme, researchBasis, executiveSummary].join(
      "\n",
    );

    expect(readme).toContain("ReverieHacks 2026 Software Development");
    expect(readme).toContain("Next.js/React/TypeScript research workbench");
    expect(executiveSummary).toContain(
      "Next.js/React/TypeScript software application",
    );
    expect(publicEntryPoints).toContain(
      "The product moat is the evidence boundary and its audit trail",
    );
    for (const staleFraming of [
      "ML Prompt Engineering entry",
      "prompt-engineering demonstration",
      "official ML page",
      "The ML track",
    ]) {
      expect(publicEntryPoints).not.toContain(staleFraming);
    }

    expect(executiveSummary).toContain("live researcher workflow");
    expect(executiveSummary).toContain("actor labels are declared rather than authenticated");
    expect(researchBasis).toContain(
      "The preserved bounded live attempt was not an end-to-end success: extraction and entailment succeeded, synthesis succeeded after one repair, and both experiment-planning attempts failed application-schema validation.",
    );
    expect(executiveSummary).toContain("No successful hosted rehearsal is claimed");
  });

  it("keeps publication boundaries optional and public test filenames semantic", () => {
    const publicTestPaths = [
      ...filesBelow(resolve(workspaceRoot, "evals")),
      ...filesBelow(resolve(workspaceRoot, "tests")),
    ].map((file) => relative(workspaceRoot, file).replaceAll("\\", "/"));
    expect(
      publicTestPaths.filter((path) =>
        /(?:^|\/)(?:evf|issue)[-_]?\d+/i.test(path),
      ),
    ).toEqual([]);

    const readme = readFileSync(resolve(workspaceRoot, "README.md"), "utf8");
    const researchBasis = readFileSync(
      resolve(workspaceRoot, "docs", "RESEARCH_BASIS.md"),
      "utf8",
    );
    const executiveSummary = readFileSync(
      resolve(workspaceRoot, "docs", "submission", "executive-summary.md"),
      "utf8",
    );
    const demoScript = readFileSync(
      resolve(workspaceRoot, "docs", "demo", "live-demo-script.md"),
      "utf8",
    );
    const privateAuditTest = readFileSync(
      resolve(
        workspaceRoot,
        "evals",
        "cases",
        "private-scoring-release-v1.test.ts",
      ),
      "utf8",
    );
    const publicationBoundary = [
      readme,
      researchBasis,
      executiveSummary,
      demoScript,
      privateAuditTest,
    ].join("\n");

    expect(readme).toContain("No organizer acceptance or submission completion is claimed");
    expect(researchBasis).toContain("Resolving the four-versus-three ambiguity");
    expect(executiveSummary).toContain("No successful hosted rehearsal is claimed");
    expect(demoScript).toContain("procedure, not evidence");
    expect(privateAuditTest).toContain(
      'describe.runIf(publicationScanMode === "trusted")(',
    );
    expect(privateAuditTest).toContain(
      'describe("optional trusted private scoring audit availability"',
    );

    for (const staleBlocker of [
      "final release blocker",
      "Publication still requires",
      "Human rehearsal gate: **blocked**",
      "blocked_human_timing_required",
      "private scoring publication gate",
    ]) {
      expect(publicationBoundary).not.toContain(staleBlocker);
    }
  });
});
