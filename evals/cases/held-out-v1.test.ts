import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/contracts";
import { BENCHMARK_PROTOCOL_VERSION } from "../protocol/v1";
import * as heldOutModule from "./held-out-v1";
import {
  HELD_OUT_CASE_MODEL_INPUTS,
  HELD_OUT_CASE_SET_MANIFEST,
  getHeldOutCaseModelInput,
  materializeHeldOutCaseSmoke,
} from "./held-out-v1";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function byteSnapshot(root: string) {
  const files = new Map<string, string>();
  async function walk(directory: string) {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      if ((await stat(path)).isDirectory()) await walk(path);
      else {
        files.set(
          relative(root, path).replaceAll("\\", "/"),
          await readFile(path, "utf8"),
        );
      }
    }
  }
  await walk(root);
  return files;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("held-out public case freeze v1", () => {
  it("freezes exactly six unmeasured public cases across three safe domains", () => {
    expect(HELD_OUT_CASE_SET_MANIFEST).toMatchObject({
      schemaVersion: "1.0.0",
      setVersion: "1.0.0",
      caseCount: 6,
      evidenceMode: "fixture",
      measurementStatus: "unmeasured",
      headlineEligible: false,
      headlineBlockers: [
        "human_grading_incomplete",
        "measured_runs_absent",
      ],
    });
    expect(HELD_OUT_CASE_MODEL_INPUTS).toHaveLength(6);
    expect(HELD_OUT_CASE_SET_MANIFEST.cases).toHaveLength(6);
    expect(
      new Set(HELD_OUT_CASE_SET_MANIFEST.cases.map(({ caseId }) => caseId)).size,
    ).toBe(6);

    const domainCounts = new Map<string, number>();
    for (const input of HELD_OUT_CASE_MODEL_INPUTS) {
      expect(input.benchmarkCase.role).toBe("heldout");
      expect(input.classification).toEqual({
        evidenceMode: "fixture",
        reportingUse: "heldout_freeze",
        resultClass: "heldout_case",
        measurementStatus: "unmeasured",
        headlineEligible: false,
      });
      domainCounts.set(
        input.benchmarkCase.domain,
        (domainCounts.get(input.benchmarkCase.domain) ?? 0) + 1,
      );
    }
    expect([...domainCounts.entries()].sort()).toEqual([
      ["environmental_sustainability", 2],
      ["materials_engineering", 2],
      ["software_reliability", 2],
    ]);
  });

  it("binds rights-cleared source, chunk, packet, model, case, and set bytes", () => {
    for (const manifest of HELD_OUT_CASE_SET_MANIFEST.cases) {
      const modelInput = getHeldOutCaseModelInput(manifest.caseId);
      const sourceHashes = modelInput.sources.map((source) => {
        expect(source).toMatchObject({
          origin: "project_authored_fixture",
          externalCitation: null,
          externalAuthorityClaimed: false,
          trustBoundary: "untrusted_source_content",
          rights: {
            state: "approved",
            licenseId: "CC0-1.0",
            mayStore: true,
            mayDisplay: true,
            maySendToModel: true,
            externalLicenseVerificationRequired: false,
          },
        });
        const { sourceHash, ...withoutSourceHash } = source;
        const { rightsDecisionHash, ...rights } = source.rights;
        expect(rightsDecisionHash).toBe(
          canonicalSha256({
            schemaVersion: "1.0.0",
            sourceId: source.id,
            rights,
          }),
        );
        expect(sourceHash).toBe(canonicalSha256(withoutSourceHash));
        return sourceHash;
      });
      const chunkHashes = modelInput.chunks.map((chunk) => {
        const { chunkHash, ...withoutChunkHash } = chunk;
        expect(chunkHash).toBe(canonicalSha256(withoutChunkHash));
        return chunkHash;
      });
      const rightsDecisionHashes = modelInput.sources.map(
        ({ rights }) => rights.rightsDecisionHash,
      );
      expect(manifest.packetFingerprint).toBe(
        canonicalSha256({
          schemaVersion: "1.0.0",
          protocolVersion: modelInput.protocolBinding.protocolVersion,
          caseId: manifest.caseId,
          caseVersion: manifest.caseVersion,
          sourceHashes,
          chunkHashes,
          rightsDecisionHashes,
        }),
      );
      const { approvalHash, ...rightsApproval } = modelInput.rightsApproval;
      expect(approvalHash).toBe(canonicalSha256(rightsApproval));
      expect(approvalHash).toBe(manifest.rightsApprovalHash);
      expect(canonicalSha256(modelInput)).toBe(manifest.modelInputHash);
      const { caseHash, ...publicCase } = modelInput.benchmarkCase;
      expect(caseHash).toBe(
        canonicalSha256({
          protocolVersion: BENCHMARK_PROTOCOL_VERSION,
          ...publicCase,
        }),
      );
      expect(caseHash).toBe(manifest.caseHash);
      expect(modelInput.benchmarkCase.packet).toEqual({
        fingerprint: manifest.packetFingerprint,
        sourceHashes,
        chunkHashes,
      });
    }
    const { setHash, ...setWithoutHash } = HELD_OUT_CASE_SET_MANIFEST;
    expect(setHash).toBe(canonicalSha256(setWithoutHash));
  });

  it("exposes only the rights-cleared public case and model-input shape", () => {
    expect(Object.keys(HELD_OUT_CASE_SET_MANIFEST).sort()).toEqual([
      "caseCount",
      "cases",
      "evidenceMode",
      "headlineBlockers",
      "headlineEligible",
      "measurementStatus",
      "schemaVersion",
      "setHash",
      "setVersion",
    ]);
    for (const manifest of HELD_OUT_CASE_SET_MANIFEST.cases) {
      expect(Object.keys(manifest).sort()).toEqual([
        "caseHash",
        "caseId",
        "caseVersion",
        "domain",
        "evidenceMode",
        "headlineEligible",
        "measurementStatus",
        "modelInputHash",
        "packetFingerprint",
        "rightsApprovalHash",
        "role",
      ]);
      const modelInput = getHeldOutCaseModelInput(manifest.caseId);
      expect(Object.keys(modelInput).sort()).toEqual([
        "benchmarkCase",
        "chunks",
        "claims",
        "classification",
        "permissionNotes",
        "protocolBinding",
        "rightsApproval",
        "schemaVersion",
        "sources",
      ]);
      expect(Object.keys(modelInput.benchmarkCase).sort()).toEqual([
        "caseHash",
        "domain",
        "id",
        "metadataSnapshot",
        "originalQuestion",
        "packet",
        "resolvedScope",
        "resolvedScopeHash",
        "role",
        "safety",
        "version",
      ]);
    }
  });

  it("keeps the public module API limited to public projections and smoke materialization", () => {
    expect(Object.keys(heldOutModule).sort()).toEqual([
      "HELD_OUT_CASE_MODEL_INPUTS",
      "HELD_OUT_CASE_SET_MANIFEST",
      "getHeldOutCaseModelInput",
      "materializeHeldOutCaseSmoke",
    ]);
  });

  it("returns detached frozen projections and detects byte or identity tampering", () => {
    const manifest = HELD_OUT_CASE_SET_MANIFEST.cases[0]!;
    const first = getHeldOutCaseModelInput(manifest.caseId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(() => {
      (first.sources[0] as { title: string }).title = "tampered";
    }).toThrow();
    expect(getHeldOutCaseModelInput(manifest.caseId)).toEqual(first);

    const tampered = structuredClone(first);
    tampered.chunks[0]!.text += " changed";
    expect(canonicalSha256(tampered)).not.toBe(manifest.modelInputHash);
    expect(() => getHeldOutCaseModelInput("unregistered-public-case")).toThrow(
      /unknown held-out case/,
    );
    expect(() => getHeldOutCaseModelInput("../escape")).toThrow();
  });

  it("materializes all six public cases deterministically and refuses overwrite", async () => {
    const leftRoot = await temporaryRoot("evidenceforge-heldout-left-");
    const rightRoot = await temporaryRoot("evidenceforge-heldout-right-");
    for (const { caseId } of HELD_OUT_CASE_SET_MANIFEST.cases) {
      const left = await materializeHeldOutCaseSmoke(leftRoot, caseId);
      const right = await materializeHeldOutCaseSmoke(rightRoot, caseId);
      const leftManifest = JSON.parse(await readFile(left.manifestPath, "utf8"));
      const rightManifest = JSON.parse(await readFile(right.manifestPath, "utf8"));
      const frozenCase = JSON.parse(await readFile(left.casePath, "utf8"));
      expect(leftManifest).toEqual(rightManifest);
      expect(leftManifest).toMatchObject({
        evidenceMode: "fixture",
        reportingUse: "development",
        resultClass: "smoke_only",
        headlineEligible: false,
      });
      expect(frozenCase).toEqual(getHeldOutCaseModelInput(caseId).benchmarkCase);
      const leftMetrics = JSON.parse(
        await readFile(join(left.runPath, "metrics", "smoke.json"), "utf8"),
      );
      expect(leftMetrics.counts).toMatchObject({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        parsedValid: 0,
      });
    }
    const before = await byteSnapshot(leftRoot);
    await expect(
      materializeHeldOutCaseSmoke(
        leftRoot,
        HELD_OUT_CASE_SET_MANIFEST.cases[0]!.caseId,
      ),
    ).rejects.toThrow(/already exists/i);
    expect(await byteSnapshot(leftRoot)).toEqual(before);
    expect(await byteSnapshot(rightRoot)).toEqual(before);
  });
});
