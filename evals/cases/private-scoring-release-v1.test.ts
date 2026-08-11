import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertPrivateScoringPackActive,
  loadFrozenPublicCorpusAuthority,
  loadPrivateScoringPack,
  revokePrivateScoringPack,
  scanPublicBlobsForPrivateValues,
} from "./private-scoring-pack-v1";
import { HELD_OUT_CASE_SET_MANIFEST } from "./held-out-v1";

const privatePackPath = process.env.PRIVATE_SCORING_PACK_PATH;
const privatePackSha256 = process.env.PRIVATE_SCORING_PACK_SHA256;
const publicationBase = process.env.PUBLICATION_BASE_SHA;
const publicationCandidate = process.env.PUBLICATION_CANDIDATE_SHA;
const publicationScanMode = process.env.PRIVATE_PUBLICATION_SCAN_MODE;
const temporaryRoots: string[] = [];

// Full candidate-tree/history scans take about 18 seconds on the current
// Windows verifier. Keep a hard 60-second ceiling for cold disks and loaded CI
// while leaving every scanner-internal resource and fail-closed limit intact.
const COMPLETE_PRIVATE_AUDIT_TIMEOUT_MS = 60_000;

afterAll(() => {
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true }));
});

function gitText(args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function assertAncestor(ancestor: string, descendant: string) {
  execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
}

function requireExactCandidateSha(candidate: string | undefined) {
  if (!candidate || !/^[0-9a-f]{40}$/i.test(candidate)) {
    throw new Error(
      "optional trusted private scoring audit requires an exact candidate SHA",
    );
  }
  return candidate;
}

function aggregatePublicBlobs(base: string, candidate: string) {
  const root = mkdtempSync(join(tmpdir(), "evidenceforge-publication-tree-"));
  temporaryRoots.push(root);
  return gitText(["diff", "--name-only", base, candidate, "--"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((path) => {
      const materializedPath = join(root, path);
      mkdirSync(dirname(materializedPath), { recursive: true });
      writeFileSync(
        materializedPath,
        execFileSync("git", ["show", `${candidate}:${path}`]),
        { flag: "wx" },
      );
      return materializedPath;
    })
    .sort();
}

function trustedPrivateAuditAvailability() {
  const missing = [
    publicationScanMode === "trusted"
      ? null
      : "PRIVATE_PUBLICATION_SCAN_MODE=trusted",
    privatePackPath ? null : "PRIVATE_SCORING_PACK_PATH",
    privatePackSha256 ? null : "PRIVATE_SCORING_PACK_SHA256",
    publicationBase ? null : "PUBLICATION_BASE_SHA",
    publicationCandidate && /^[0-9a-f]{40}$/i.test(publicationCandidate)
      ? null
      : "PUBLICATION_CANDIDATE_SHA",
  ].filter((value): value is string => value !== null);
  return missing.length === 0
    ? ({ status: "available" } as const)
    : ({ status: "unavailable", missing } as const);
}

function requireTrustedPrivateAuditInputs() {
  const availability = trustedPrivateAuditAvailability();
  if (availability.status === "unavailable") {
    throw new Error(
      `optional trusted private scoring audit unavailable: ${availability.missing.join(", ")}`,
    );
  }
  return {
    privatePackPath: privatePackPath!,
    privatePackSha256: privatePackSha256!,
    publicationBase: publicationBase!,
    publicationCandidate: requireExactCandidateSha(publicationCandidate),
  };
}

describe("optional trusted private scoring audit availability", () => {
  it("reports missing verifier-only inputs as unavailable without granting an audit pass", () => {
    const availability = trustedPrivateAuditAvailability();
    if (availability.status === "available") {
      expect(availability).toEqual({ status: "available" });
      return;
    }
    expect(availability.status).toBe("unavailable");
    expect(availability.missing.length).toBeGreaterThan(0);
  });
});

describe.runIf(publicationScanMode === "trusted")(
  "optional trusted private scoring audit",
  () => {
    it("refuses missing or malformed exact candidate identities", () => {
      [undefined, "", "   ", "not-a-sha"].forEach((candidate) => {
        expect(() => requireExactCandidateSha(candidate)).toThrow(
          /candidate SHA/i,
        );
      });
    });

    it(
      "validates the ignored pack and finds zero private values in aggregate public blobs",
      () => {
        const trusted = requireTrustedPrivateAuditInputs();
        assertAncestor(trusted.publicationBase, trusted.publicationCandidate);
        const publicSet = {
          setHash: HELD_OUT_CASE_SET_MANIFEST.setHash,
          cases: HELD_OUT_CASE_SET_MANIFEST.cases.map(
            ({ caseId: id, caseVersion: version }) => ({ id, version }),
          ),
        };
        const handle = loadPrivateScoringPack(
          trusted.privatePackPath,
          publicSet,
          trusted.privatePackSha256,
        );
        expect(() =>
          assertPrivateScoringPackActive(
            handle,
            publicSet,
            trusted.privatePackSha256,
          ),
        ).not.toThrow();
        const publicCorpusAuthority = loadFrozenPublicCorpusAuthority(
          process.cwd(),
          trusted.publicationBase,
        );
        expect(
          scanPublicBlobsForPrivateValues(
            trusted.privatePackPath,
            publicSet,
            trusted.privatePackSha256,
            aggregatePublicBlobs(
              trusted.publicationBase,
              trusted.publicationCandidate,
            ),
            publicCorpusAuthority,
            process.cwd(),
          ),
        ).toEqual([]);
        revokePrivateScoringPack(handle);
      },
      COMPLETE_PRIVATE_AUDIT_TIMEOUT_MS,
    );
  },
);
