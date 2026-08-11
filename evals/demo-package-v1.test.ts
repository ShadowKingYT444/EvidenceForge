import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(root, "artifacts", "submission", "demo-v1");
const persistentLabel = "FIXTURE PLAYBACK — NOT LIVE OR MEASURED";

type DemoManifest = {
  schemaVersion: string;
  acceptedBaseSha: string;
  evidenceMode: string;
  persistentLabel: string;
  viewport: { width: number; height: number };
  captureCommand: string;
  buildCommand: string;
  targetDurationSeconds: number;
  narrationTimeline: Array<{
    frameId: string;
    startSecond: number;
    endSecond: number;
  }>;
  screenshots: Array<{
    id: string;
    file: string;
    route: string;
    width: number;
    height: number;
    sha256: string;
  }>;
  canonicalExport: {
    file: string;
    sha256: string;
    evidenceMode: string;
    schemaVersion: string;
    status: string;
    declaredActor: string;
  };
  captureNormalizations: string[];
  truthBoundary: {
    completeDemoPath: string;
    finalBoundedLiveAttempt: string;
    measuredBenchmarkComplete: boolean;
    ablationsComplete: boolean;
    measuredCostClaim: boolean;
    superiorityClaim: boolean;
  };
};

type RehearsalRecord = {
  schemaVersion: string;
  optionalCount: number;
  targetUnderSeconds: number;
  status: string;
  instructions: string;
  rehearsals: Array<{
    sequence: number;
    evidenceMode: string;
    durationSeconds: number | null;
    recordedAt: string | null;
    recordedBy: string | null;
  }>;
};

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("deterministic fixture demo package", () => {
  it("freezes seven labeled 1440x900 frames, exact routes, hashes, and a 4:50 narration", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(artifactRoot, "manifest.json"), "utf8"),
    ) as DemoManifest;

    expect(manifest).toMatchObject({
      schemaVersion: "1.0.0",
      acceptedBaseSha: "a1ba19c32edce9184aaa731473a89563ffca4994",
      evidenceMode: "fixture",
      persistentLabel,
      viewport: { width: 1440, height: 900 },
      buildCommand: "pnpm build",
      captureCommand:
        "pnpm exec playwright test --config evals/demo/playwright.config.ts --project=chromium --workers=1",
      targetDurationSeconds: 290,
    });
    expect(manifest.screenshots).toHaveLength(7);
    expect(new Set(manifest.screenshots.map(({ id }) => id)).size).toBe(7);
    expect(manifest.screenshots.map(({ route }) => route)).toEqual([
      "/intake",
      "/intake",
      "/workbench?evidence=gf-evidence-02#evidence-verification-drawer",
      "/workbench#synthesis-gap",
      "/workbench#experiment",
      "/workbench#review-revision",
      "/workbench?runId={process-local-fixture-session}#final-decision",
    ]);

    for (const screenshot of manifest.screenshots) {
      const bytes = readFileSync(resolve(artifactRoot, screenshot.file));
      expect(pngDimensions(bytes)).toEqual({ width: 1440, height: 900 });
      expect(screenshot).toMatchObject({ width: 1440, height: 900 });
      expect(sha256(bytes)).toBe(screenshot.sha256);
    }

    expect(manifest.narrationTimeline).toHaveLength(7);
    expect(manifest.narrationTimeline[0]?.startSecond).toBe(0);
    for (let index = 1; index < manifest.narrationTimeline.length; index += 1) {
      expect(manifest.narrationTimeline[index]?.startSecond).toBe(
        manifest.narrationTimeline[index - 1]?.endSecond,
      );
    }
    expect(manifest.narrationTimeline.at(-1)?.endSecond).toBe(290);
    expect(
      manifest.narrationTimeline.every(
        ({ startSecond, endSecond }) => endSecond > startSecond,
      ),
    ).toBe(true);
    expect(manifest.captureNormalizations).toContain(
      "Frames 04-07 use capture-only focus layouts cloned from the rendered accepted fixture DOM; no record content is changed and the product UI is not modified.",
    );
    expect(manifest.truthBoundary).toEqual({
      completeDemoPath: "fixture",
      finalBoundedLiveAttempt:
        "failed at experiment planning after extraction and entailment succeeded and synthesis repaired once",
      measuredBenchmarkComplete: false,
      ablationsComplete: false,
      measuredCostClaim: false,
      superiorityClaim: false,
    });
  });

  it("binds the canonical fixture export to the declared demo reviewer", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(artifactRoot, "manifest.json"), "utf8"),
    ) as DemoManifest;
    const exportBytes = readFileSync(
      resolve(artifactRoot, manifest.canonicalExport.file),
    );
    const exported = JSON.parse(exportBytes.toString("utf8")) as {
      schemaVersion: string;
      evidenceMode: string;
      status: string;
      finalDecision: { declaredActor: string; rationale: string };
    };

    expect(sha256(exportBytes)).toBe(manifest.canonicalExport.sha256);
    expect(manifest.canonicalExport).toMatchObject({
      evidenceMode: "fixture",
      schemaVersion: "0.2",
      status: "approved",
      declaredActor: "Demo reviewer",
    });
    expect(exported).toMatchObject({
      schemaVersion: "0.2",
      evidenceMode: "fixture",
      status: "approved",
      finalDecision: {
        declaredActor: "Demo reviewer",
        rationale: "Approve only this bounded fixture demonstration.",
      },
    });
  });

  it("keeps human rehearsal timings optional, explicitly unverified, and public claims bounded", () => {
    const rehearsals = JSON.parse(
      readFileSync(resolve(artifactRoot, "rehearsals.json"), "utf8"),
    ) as RehearsalRecord;
    const script = readFileSync(
      resolve(root, "docs", "submission", "fixture-demo-script-v1.md"),
      "utf8",
    );

    expect(rehearsals).toMatchObject({
      schemaVersion: "1.1.0",
      optionalCount: 2,
      targetUnderSeconds: 300,
      status: "optional_unverified",
    });
    expect(rehearsals).not.toHaveProperty("requiredCount");
    expect(rehearsals.instructions).toContain(
      "Optional presentation evidence only",
    );
    expect(rehearsals.rehearsals).toEqual([
      {
        sequence: 1,
        evidenceMode: "unverified",
        durationSeconds: null,
        recordedAt: null,
        recordedBy: null,
      },
      {
        sequence: 2,
        evidenceMode: "unverified",
        durationSeconds: null,
        recordedAt: null,
        recordedBy: null,
      },
    ]);
    expect(script).toContain(persistentLabel);
    expect(script).toContain("Target narration: **4:50 (290 seconds)**");
    expect(script).toContain("final bounded live attempt failed at experiment planning");
    expect(script).toContain(
      "comparative benchmark and ablations were canceled and not completed",
    );
    expect(script).toContain(
      "Optional human rehearsal evidence: **unverified**.",
    );
    expect(script).not.toMatch(/\b(?:proved|demonstrated) superiority\b/i);
    expect(script).not.toMatch(/\$0|zero[- ]cost|live end-to-end success/i);
  });
});
