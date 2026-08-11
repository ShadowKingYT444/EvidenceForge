import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalSha256, canonicalizeJson } from "../../src/contracts";
import { materializeStrongBaselineSmoke } from "../baseline/v1";
import { DEVELOPMENT_CASES } from "../cases/development-v1";
import {
  materializeDevelopmentComparisonFixtureSet,
  type ComparisonCandidate,
} from "../comparison/parity-v1";
import { createWorkflowDevelopmentMatrix } from "../conditions/workflow-v1";
import {
  BLIND_GRADING_RUBRIC,
  BlindAnnotationSchema,
  BlindPacketSchema,
  createBlindGradingPacket,
  importBlindAnnotation,
  summarizeBlindAnnotations,
  type BlindAnnotation,
  type BlindGradingSource,
  type ConfidentialBlindMapping,
} from "./v1";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "evidenceforge-blind-grading-"));
  temporaryRoots.push(root);
  return root;
}

const CONDITIONS = [
  "strong_baseline",
  "complete_workflow",
  "no_verification",
  "no_adversarial_review",
] as const;

function legacyCandidates() {
  return CONDITIONS.map((conditionId, index) => ({
    conditionId,
    caseId: "development-case",
    trialId: "trial-1",
    runId: `development-case-${index + 1}`,
    attemptId: `attempt-${index + 1}`,
    configHash: canonicalSha256({ conditionId, kind: "config" }),
    rawOutput: {
      answer: `Output ${index + 1}`,
      source: `Fixture source ${index + 1}`,
    },
    canonicalOutput: {
      claims: [{ text: `Claim ${index + 1}`, evidence: [`chunk-${index + 1}`] }],
    },
    gradingView: {
      items: [
        {
          itemId: `claim-${index + 1}`,
          claimText: `Claim ${index + 1}`,
          displayedEvidence: `Authored fixture excerpt ${index + 1}`,
        },
      ],
      experiment: { summary: `Bounded fixture experiment ${index + 1}` },
    },
    evidenceMode: "simulated",
  }));
}

const FIXTURE_SEED = "a".repeat(64);
const PACKET_NONCE = "1".repeat(64);

type TestBlindGradingSource = Omit<BlindGradingSource, "comparisonRecord"> & {
  comparisonRecord: ComparisonCandidate;
};

let acceptedSources: TestBlindGradingSource[];

beforeAll(async () => {
  const root = await temporaryRoot();
  const comparisonSet = await materializeDevelopmentComparisonFixtureSet({
    artifactRoot: join(root, "comparison"),
  });
  const developmentCase = DEVELOPMENT_CASES[0]!;
  const baseline = await materializeStrongBaselineSmoke({
    artifactRoot: join(root, "baseline-authority"),
    developmentCase,
    benchmarkCodeVersion: "348324361782ccbaaed9e959eec79fcf5bb262b6",
  });
  const workflowFixtures = createWorkflowDevelopmentMatrix();
  const caseId = developmentCase.benchmarkCase.id;
  acceptedSources = comparisonSet.pairs
    .filter(
      ({ candidate }) =>
        candidate.caseId === caseId && candidate.trialId === "trial-1",
    )
    .map(({ authority, candidate }) => {
      const workflowFixture = workflowFixtures.find(
        (fixture) =>
          fixture.developmentCase.benchmarkCase.id === caseId &&
          fixture.runConfig.trialId === "trial-1" &&
          fixture.condition.id === candidate.rightConditionId,
      );
      if (workflowFixture === undefined) {
        throw new TypeError("accepted workflow fixture was not found");
      }
      return {
        comparisonAuthority: authority,
        comparisonRecord: candidate,
        baselineParentAuthority: baseline.parentAuthority,
        baselineRerunAuthority: baseline.rerunAuthority,
        workflowFixture,
      };
    });
  if (acceptedSources.length !== 3) {
    throw new TypeError("accepted comparison source set is incomplete");
  }
});

function sources() {
  return acceptedSources.map((source) => ({
    ...source,
    comparisonRecord: clone(source.comparisonRecord),
  }));
}

function packet(
  fixtureSeed = FIXTURE_SEED,
  packetId = "packet-alpha",
  packetNonce = PACKET_NONCE,
) {
  return createBlindGradingPacket({
    packetId,
    fixtureSeed,
    packetNonce,
    sources: sources(),
  });
}

function annotation(
  blindPacket = packet().packet,
  overrides: Partial<BlindAnnotation> = {},
): BlindAnnotation {
  const entryAnnotations = blindPacket.entries.map((entry, index) => ({
    label: entry.label,
    itemAnnotations: entry.output.items.map((item) => ({
      itemId: item.itemId,
      claimSourceEntailment:
        index === 0 ? ("full_support" as const) : ("insufficient" as const),
      unsupportedClaim: index === 0 ? (false as const) : (true as const),
      overclaiming: index === 0 ? (false as const) : ("abstain" as const),
      note: `Item assessment ${index + 1}`,
    })),
    experimentValidity:
      index === 0 ? ("valid" as const) : ("abstain" as const),
    correctionEffort: {
      substantiveEditCount: index,
      minutes: null,
      note: index === 0 ? "No substantive correction." : "Not timed.",
    },
    note: `Assessment ${index + 1}`,
  }));
  return {
    schemaVersion: "1.0.0",
    annotationId: "annotation-one",
    packetId: blindPacket.packetId,
    grader: {
      graderId: "grader-one",
      declaredExpertise: "Software reliability practitioner — self-declared",
    },
    submittedAt: "2026-08-08T00:00:00.000Z",
    entryAnnotations,
    pairedPreference: {
      preferredLabel: blindPacket.entries[0]!.label,
      reason: "More directly grounded in the displayed excerpt.",
    },
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function trapCountingProxy<T extends object>(target: T) {
  let traps = 0;
  const proxy = new Proxy(target, {
    get(proxied, property, receiver) {
      traps += 1;
      return Reflect.get(proxied, property, receiver);
    },
    getOwnPropertyDescriptor(proxied, property) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(proxied, property);
    },
    getPrototypeOf(proxied) {
      traps += 1;
      return Reflect.getPrototypeOf(proxied);
    },
    ownKeys(proxied) {
      traps += 1;
      return Reflect.ownKeys(proxied);
    },
  });
  return { proxy, trapCount: () => traps };
}

describe("blind grading rubric v1", () => {
  it("defines the required terms and every human-graded dimension without inventing scores", () => {
    expect(BLIND_GRADING_RUBRIC.definitions).toMatchObject({
      factual: expect.any(String),
      substantive: expect.any(String),
      adequate: expect.any(String),
      overclaimed: expect.any(String),
    });
    expect(Object.keys(BLIND_GRADING_RUBRIC.dimensions)).toEqual([
      "claimSourceEntailment",
      "unsupportedClaim",
      "overclaiming",
      "experimentValidity",
      "correctionEffort",
      "pairedPreference",
    ]);
    expect(canonicalizeJson(BLIND_GRADING_RUBRIC)).not.toMatch(
      /confidence|percentage|expert verified/i,
    );
  });
});

describe("deterministic confidential blinding", () => {
  it("rejects complete pre-issuance condition-binding swaps instead of blessing caller-assembled evidence", () => {
    const forged = sources();
    const left = forged[0]!.comparisonRecord;
    forged[0]!.comparisonRecord = forged[1]!.comparisonRecord;
    forged[1]!.comparisonRecord = left;

    expect(() =>
      createBlindGradingPacket({
        packetId: "packet-preissuance-binding-swap",
        fixtureSeed: FIXTURE_SEED,
        packetNonce: PACKET_NONCE,
        sources: forged,
      }),
    ).toThrow(/accepted|authority|source/i);
  });

  it("rejects grader views disconnected from their authorized raw and canonical outputs", () => {
    const forged = sources();
    const fixture = forged[0]!.workflowFixture;
    forged[0]!.workflowFixture = forged[1]!.workflowFixture;
    forged[1]!.workflowFixture = fixture;

    expect(() =>
      createBlindGradingPacket({
        packetId: "packet-preissuance-view-swap",
        fixtureSeed: FIXTURE_SEED,
        packetNonce: PACKET_NONCE,
        sources: forged,
      }),
    ).toThrow(/accepted|authority|derived|source/i);
  });

  it("rejects mixed caller evidence modes instead of relabeling them simulated", () => {
    const forged = legacyCandidates();
    forged[0]!.evidenceMode = "fixture";
    forged[1]!.evidenceMode = "mocked";

    expect(() =>
      createBlindGradingPacket({
        packetId: "packet-mixed-caller-modes",
        caseId: "development-case",
        trialId: "trial-1",
        fixtureSeed: FIXTURE_SEED,
        packetNonce: PACKET_NONCE,
        candidates: forged,
      }),
    ).toThrow(/evidence|mode|accepted|authority/i);
    expect(packet().packet.evidenceMode).toBe("mixed_fixture_simulated");
    expect(new Set(packet().mapping.entries.map(({ evidenceMode }) => evidenceMode))).toEqual(
      new Set(["fixture", "simulated"]),
    );
  });

  it("creates deterministic opaque labels while keeping condition and artifact identity out of grader bytes", () => {
    const first = packet();
    const second = packet();
    expect(first.packet).toEqual(second.packet);
    expect(first.mapping).toEqual(second.mapping);
    expect(first.authority).not.toBe(second.authority);
    expect(first.packet.entries.map(({ label }) => label).sort()).toEqual([
      "Condition A",
      "Condition B",
      "Condition C",
      "Condition D",
    ]);
    expect(first.mapping.entries.map(({ conditionId }) => conditionId).sort()).toEqual(
      [...CONDITIONS].sort(),
    );

    const graderBytes = canonicalizeJson(first.packet);
    for (const entry of first.mapping.entries) {
      expect(graderBytes).not.toContain(entry.conditionId);
      expect(graderBytes).not.toContain(entry.runId);
      expect(graderBytes).not.toContain(entry.attemptId);
      expect(graderBytes).not.toContain(entry.configHash);
      expect(graderBytes).not.toContain(entry.rawOutputHash);
      expect(graderBytes).not.toContain(entry.canonicalOutputHash);
      expect(graderBytes).not.toContain(entry.sourceChainHash);
      for (const binding of entry.comparisonBindings) {
        expect(graderBytes).not.toContain(binding.pairId);
        expect(graderBytes).not.toContain(binding.eligibilityHash);
      }
    }
    expect(graderBytes).not.toContain(FIXTURE_SEED);
    expect(graderBytes).not.toContain(PACKET_NONCE);
    expect(first.mapping.permutationCommitment).not.toBe(FIXTURE_SEED);
  });

  it("is independent of candidate input order and changes the confidential mapping for another secret", () => {
    const ordered = packet();
    const reversed = createBlindGradingPacket({
      packetId: "packet-alpha",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: sources().reverse(),
    });
    expect(reversed.packet).toEqual(ordered.packet);
    expect(reversed.mapping).toEqual(ordered.mapping);

    const other = packet("b".repeat(64));
    expect(other.mapping.permutationCommitment).not.toBe(
      ordered.mapping.permutationCommitment,
    );
    const changed = ["b", "c", "d", "e"]
      .map((value) => packet(value.repeat(64)))
      .find((candidate) =>
        canonicalizeJson(candidate.mapping.entries) !==
        canonicalizeJson(ordered.mapping.entries),
      );
    expect(changed).toBeDefined();
    expect(changed!.packet.entries).not.toEqual(ordered.packet.entries);
  });

  it("rejects missing, duplicate, cross-authority, rehashed, and metadata-leaking sources", () => {
    expect(() =>
      createBlindGradingPacket({
        packetId: "packet-alpha",
        fixtureSeed: FIXTURE_SEED,
        packetNonce: PACKET_NONCE,
        sources: sources().slice(0, 2),
      }),
    ).toThrow();

    const duplicate = sources();
    duplicate[2] = duplicate[1]!;
    expect(() => createBlindGradingPacket({
      packetId: "packet-duplicate-source",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: duplicate,
    })).toThrow(/condition|source/i);

    const crossAuthority = sources();
    crossAuthority[0]!.comparisonRecord = crossAuthority[1]!.comparisonRecord;
    expect(() => createBlindGradingPacket({
      packetId: "packet-cross-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: crossAuthority,
    })).toThrow(/eligible|authority/i);

    const rehashed = sources();
    rehashed[0]!.comparisonRecord.leftRunId = "forged-left-run";
    expect(() => createBlindGradingPacket({
      packetId: "packet-rehashed-source",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: rehashed,
    })).toThrow(/eligible|authority/i);

    expect(() => createBlindGradingPacket({
      packetId: "strong-baseline",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: sources(),
    })).toThrow(/leak/i);
  });

  it("deep-owns packet and mapping bytes against caller alias mutation", () => {
    const source = sources();
    const created = createBlindGradingPacket({
      packetId: "packet-alias-ownership",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: source,
    });
    const before = canonicalizeJson(created);
    source[0]!.comparisonRecord.pairId = "mutated-after-creation";
    source.reverse();
    expect(canonicalizeJson(created)).toBe(before);
    expect(Object.isFrozen(created.packet)).toBe(true);
    expect(Object.isFrozen(created.mapping)).toBe(true);
    expect(Object.isFrozen(created.authority)).toBe(true);
  });

  it("rejects accessors, proxies, exotic objects, and extra fields", () => {
    const accessor = sources();
    let getterRuns = 0;
    Object.defineProperty(accessor[0]!.comparisonRecord, "pairId", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return "accessor-pair";
      },
    });
    expect(() => createBlindGradingPacket({
      packetId: "packet-accessor-source",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: accessor,
    })).toThrow();
    expect(getterRuns).toBe(0);

    expect(() => createBlindGradingPacket({
      packetId: "packet-proxy-sources",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: new Proxy(sources(), {}),
    })).toThrow();
    const extra = sources();
    Object.assign(extra[0]!, { extra: "not accepted" });
    expect(() => createBlindGradingPacket({
      packetId: "packet-extra-source-field",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: extra,
    })).toThrow();
  });
});

describe("append-only annotation import", () => {
  it("binds annotation items to exact confidential config/raw/canonical hashes", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const result = await importBlindAnnotation({
      artifactRoot: root,
      authority: created.authority,
      sources: sources(),
      packet: created.packet,
      mapping: created.mapping,
      annotation: annotation(created.packet),
    });
    expect(result.status).toBe("created");
    const storedBytes = await readFile(result.path, "utf8");
    const stored = JSON.parse(storedBytes);
    expect(stored.status).toBe("simulated_annotation_only");
    expect(stored.headlineEligible).toBe(false);
    expect(stored.bindings).toEqual(created.mapping.entries);
    expect(stored.mappingId).toBe(created.mapping.mappingId);
    expect(storedBytes).not.toContain(FIXTURE_SEED);
    expect(storedBytes).not.toContain(PACKET_NONCE);
    expect(storedBytes).not.toContain("authority");
  });

  it("is idempotent for identical bytes and rejects conflicting reuse without overwriting", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const first = await importBlindAnnotation({
      artifactRoot: root,
      authority: created.authority,
      sources: sources(),
      packet: created.packet,
      mapping: created.mapping,
      annotation: annotation(created.packet),
    });
    const bytes = await readFile(first.path, "utf8");
    const second = await importBlindAnnotation({
      artifactRoot: root,
      authority: created.authority,
      sources: sources(),
      packet: created.packet,
      mapping: created.mapping,
      annotation: annotation(created.packet),
    });
    expect(second.status).toBe("already_present");
    expect(await readFile(first.path, "utf8")).toBe(bytes);

    const conflicting = annotation(created.packet);
    conflicting.entryAnnotations[0]!.note = "Conflicting replacement.";
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: created.mapping,
        annotation: conflicting,
      }),
    ).rejects.toThrow(/conflict|immutable|already/i);
    expect(await readFile(first.path, "utf8")).toBe(bytes);
  });

  it("never alters pre-existing raw, parsed, config, or manifest artifacts", async () => {
    const root = await temporaryRoot();
    const sentinelPaths = [
      "runs/1.0.0/run-one/raw/output.json",
      "runs/1.0.0/run-one/parsed/output.json",
      "runs/1.0.0/run-one/config.json",
      "runs/1.0.0/run-one/manifest.json",
    ];
    for (const path of sentinelPaths) {
      const absolute = join(root, ...path.split("/"));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, `sentinel:${path}`, "utf8");
    }
    const before = await Promise.all(
      sentinelPaths.map((path) => readFile(join(root, ...path.split("/")), "utf8")),
    );
    const created = packet();
    await importBlindAnnotation({
      artifactRoot: root,
      authority: created.authority,
      sources: sources(),
      packet: created.packet,
      mapping: created.mapping,
      annotation: annotation(created.packet),
    });
    const after = await Promise.all(
      sentinelPaths.map((path) => readFile(join(root, ...path.split("/")), "utf8")),
    );
    expect(after).toEqual(before);
  });

  it("rejects tampered packets, rehashed mappings, and cross-case/run/condition reuse", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const cases: Array<[unknown, unknown]> = [];

    const tamperedPacket = clone(created.packet) as { caseId: string };
    tamperedPacket.caseId = "different-case";
    cases.push([tamperedPacket, created.mapping]);

    const tamperedMapping = clone(created.mapping) as ConfidentialBlindMapping;
    tamperedMapping.entries[0]!.runId = "cross-run";
    cases.push([created.packet, tamperedMapping]);

    const rehashedRunMapping = clone(created.mapping) as ConfidentialBlindMapping;
    rehashedRunMapping.entries[0]!.runId = "cross-run";
    const rehashedRunWithoutHash = {
      ...rehashedRunMapping,
    } as Partial<ConfidentialBlindMapping>;
    delete rehashedRunWithoutHash.mappingHash;
    rehashedRunMapping.mappingHash = canonicalSha256(rehashedRunWithoutHash);
    cases.push([created.packet, rehashedRunMapping]);

    const crossCondition = clone(created.mapping) as ConfidentialBlindMapping;
    crossCondition.entries[0]!.conditionId = "complete_workflow";
    const withoutMappingHash = { ...crossCondition } as Partial<ConfidentialBlindMapping>;
    delete withoutMappingHash.mappingHash;
    crossCondition.mappingHash = canonicalSha256(withoutMappingHash);
    cases.push([created.packet, crossCondition]);

    for (const [blindPacket, mapping] of cases) {
      await expect(
        importBlindAnnotation({
          artifactRoot: root,
          authority: created.authority,
          sources: sources(),
          packet: blindPacket,
          mapping,
          annotation: annotation(created.packet),
        }),
      ).rejects.toThrow();
    }

    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: {} as typeof created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: created.mapping,
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow(/exact issued capability/i);
  });

  it("rejects partial, duplicate-label, malformed, spoofed, and extra-field annotation records", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const records: unknown[] = [];
    const partial = annotation(created.packet);
    partial.entryAnnotations.pop();
    records.push(partial);
    const duplicate = annotation(created.packet);
    duplicate.entryAnnotations[1]!.label = duplicate.entryAnnotations[0]!.label;
    records.push(duplicate);
    const crossItem = annotation(created.packet);
    crossItem.entryAnnotations[0]!.itemAnnotations[0]!.itemId = "foreign-item";
    records.push(crossItem);
    records.push({ ...annotation(created.packet), inventedExpertVerification: true });
    records.push({ ...annotation(created.packet), grader: { graderId: "grader-one", declaredExpertise: "" } });

    for (const record of records) {
      await expect(
        importBlindAnnotation({
          artifactRoot: root,
          authority: created.authority,
          sources: sources(),
          packet: created.packet,
          mapping: created.mapping,
          annotation: record,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects accessor/proxy import envelopes without invoking accessors", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const malicious = annotation(created.packet);
    let getterRuns = 0;
    Object.defineProperty(malicious.grader, "declaredExpertise", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return "invented";
      },
    });
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: created.mapping,
        annotation: malicious,
      }),
    ).rejects.toThrow();
    expect(getterRuns).toBe(0);

    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: new Proxy(created.mapping, {}),
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow();
  });
});

describe("accepted upstream source authority", () => {
  it.each([
    ["case", (record: ReturnType<typeof sources>[number]["comparisonRecord"]) => {
      record.caseId = "cross-case";
    }],
    ["run", (record: ReturnType<typeof sources>[number]["comparisonRecord"]) => {
      record.rightRunId = "cross-run";
    }],
    ["condition", (record: ReturnType<typeof sources>[number]["comparisonRecord"]) => {
      record.rightConditionId =
        record.rightConditionId === "complete_workflow"
          ? "no_verification"
          : "complete_workflow";
    }],
    ["trial", (record: ReturnType<typeof sources>[number]["comparisonRecord"]) => {
      record.trialId = "trial-2";
      record.leftTrial.trialId = "trial-2";
      record.rightTrial.trialId = "trial-2";
    }],
  ])("rejects cross-%s comparison records before packet authority issuance", (_, mutate) => {
    const forged = sources();
    mutate(forged[0]!.comparisonRecord);
    expect(() => createBlindGradingPacket({
      packetId: "packet-cross-source",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: forged,
    })).toThrow(/eligible|authority|binding/i);
  });

  it("rejects whole-source edits even when every caller-visible evidence hash is recomputed", () => {
    const forged = sources();
    const record = forged[0]!.comparisonRecord;
    record.workflowEvidence.attempts = clone(forged[1]!.comparisonRecord.workflowEvidence.attempts);
    record.workflowEvidence.errors = clone(forged[1]!.comparisonRecord.workflowEvidence.errors);
    record.workflowEvidence.fixtureHash = canonicalSha256(record.workflowEvidence.attempts);
    record.workflowEvidence.conditionSpecHash = canonicalSha256({
      attempts: record.workflowEvidence.attempts,
      errors: record.workflowEvidence.errors,
    });
    expect(() => createBlindGradingPacket({
      packetId: "packet-whole-source-rehash",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: forged,
    })).toThrow(/eligible|authority|binding/i);
  });

  it("rejects fake, cloned, proxied, revoked, and cross-purpose upstream tokens without proxy traversal", () => {
    const fakePair = sources();
    const candidateProxy = trapCountingProxy(fakePair[0]!.comparisonRecord);
    fakePair[0]!.comparisonAuthority = {} as typeof fakePair[0]["comparisonAuthority"];
    fakePair[0]!.comparisonRecord = candidateProxy.proxy;
    expect(() => createBlindGradingPacket({
      packetId: "packet-fake-pair-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: fakePair,
    })).toThrow(/authority/i);
    expect(candidateProxy.trapCount()).toBe(0);

    const proxiedFixture = sources();
    const fixtureProxy = trapCountingProxy(proxiedFixture[0]!.workflowFixture);
    proxiedFixture[0]!.workflowFixture = fixtureProxy.proxy;
    expect(() => createBlindGradingPacket({
      packetId: "packet-proxy-workflow-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: proxiedFixture,
    })).toThrow(/accepted|authority|bundle/i);
    expect(fixtureProxy.trapCount()).toBe(0);

    const clonedFixture = sources();
    clonedFixture[0]!.workflowFixture = structuredClone(clonedFixture[0]!.workflowFixture);
    expect(() => createBlindGradingPacket({
      packetId: "packet-cloned-workflow-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: clonedFixture,
    })).toThrow(/accepted|authority|bundle/i);

    const revokedPair = sources();
    const revoked = Proxy.revocable(revokedPair[0]!.comparisonAuthority, {});
    revoked.revoke();
    revokedPair[0]!.comparisonAuthority = revoked.proxy;
    expect(() => createBlindGradingPacket({
      packetId: "packet-revoked-pair-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: revokedPair,
    })).toThrow(/authority/i);

    const crossPurpose = sources();
    crossPurpose[0]!.baselineParentAuthority = crossPurpose[0]!.baselineRerunAuthority;
    expect(() => createBlindGradingPacket({
      packetId: "packet-cross-purpose-baseline-authority",
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: crossPurpose,
    })).toThrow(/authority|attempt|authorized/i);
  });
});

describe("honest grader reporting", () => {
  it("preserves every disagreement and abstention, reports expertise verbatim, and blocks on missing graders", () => {
    const created = packet();
    const first = annotation(created.packet);
    const second = annotation(created.packet, {
      annotationId: "annotation-two",
      grader: {
        graderId: "grader-two",
        declaredExpertise: "Ingénieure fiabilité — 自己申告 / self-declared",
      },
    });
    second.entryAnnotations[0]!.itemAnnotations[0]!.claimSourceEntailment = "contradicts";
    second.entryAnnotations[0]!.itemAnnotations[0]!.unsupportedClaim = "abstain";
    second.pairedPreference = {
      preferredLabel: "abstain",
      reason: "The displayed evidence is insufficient for preference.",
    };

    const report = summarizeBlindAnnotations({
      packet: created.packet,
      mapping: created.mapping,
      authority: created.authority,
      sources: sources(),
      expectedGraderIds: ["grader-one", "grader-two", "grader-three"],
      annotations: [first, second],
    });
    expect(report.graderCount).toBe(2);
    expect(report.graders).toEqual([
      first.grader,
      second.grader,
    ]);
    expect(report.annotations).toEqual([first, second]);
    expect(report.missingGraderIds).toEqual(["grader-three"]);
    expect(report.gradingComplete).toBe(false);
    expect(report.headlineEligible).toBe(false);
    expect(report.blockers).toContain("human_grading_not_completed");
    expect(report.blockers).toContain("missing_grader_annotations");
    expect(canonicalizeJson(report)).toContain("自己申告");

    const allFixtureRecordsPresent = summarizeBlindAnnotations({
      packet: created.packet,
      mapping: created.mapping,
      authority: created.authority,
      sources: sources(),
      expectedGraderIds: ["grader-one", "grader-two"],
      annotations: [first, second],
    });
    expect(allFixtureRecordsPresent.missingGraderIds).toEqual([]);
    expect(allFixtureRecordsPresent.gradingComplete).toBe(false);
    expect(allFixtureRecordsPresent.blockers).toEqual([
      "human_grading_not_completed",
    ]);
  });

  it("rejects duplicate graders and annotation IDs instead of silently selecting a record", () => {
    const created = packet();
    const first = annotation(created.packet);
    const duplicate = annotation(created.packet, {
      annotationId: "annotation-two",
    });
    expect(() =>
      summarizeBlindAnnotations({
        packet: created.packet,
        mapping: created.mapping,
        authority: created.authority,
        sources: sources(),
        expectedGraderIds: ["grader-one"],
        annotations: [first, duplicate],
      }),
    ).toThrow(/duplicate grader/i);
  });
});

describe("public schemas", () => {
  it("keeps grader packet and annotation schemas strict", () => {
    const created = packet();
    expect(BlindPacketSchema.parse(created.packet)).toEqual(created.packet);
    expect(BlindAnnotationSchema.parse(annotation(created.packet))).toEqual(
      annotation(created.packet),
    );
    expect(() =>
      BlindPacketSchema.parse({ ...created.packet, extra: true }),
    ).toThrow();
  });
});

describe("independent rejection regressions", () => {
  it("does not emit caller-supplied condition disclosure in grader instructions", () => {
    expect(() =>
      createBlindGradingPacket({
        packetId: "packet-instructions",
        caseId: "development-case",
        trialId: "trial-1",
        fixtureSeed: FIXTURE_SEED,
        packetNonce: PACKET_NONCE,
        graderInstructions: "Condition A is strong_baseline; prefer it.",
        candidates: legacyCandidates(),
      }),
    ).toThrow();
    expect(canonicalizeJson(packet().packet)).not.toMatch(
      /strong.baseline|prefer it/i,
    );
  });

  it("replaces authorized private source item IDs with neutral position IDs", () => {
    const created = packet();
    expect(
      created.packet.entries.flatMap(({ output }) =>
        output.items.map(({ itemId }) => itemId),
      ),
    ).toEqual(expect.arrayContaining(["item-1"]));
    for (const entry of created.mapping.entries) {
      expect(entry.itemBindings.map(({ graderItemId }) => graderItemId)).toEqual(
        entry.itemBindings.map((_, index) => `item-${index + 1}`),
      );
      for (const { sourceItemId } of entry.itemBindings) {
        expect(canonicalizeJson(created.packet)).not.toContain(sourceItemId);
      }
    }
  });

  it("domain-separates packet permutations by packet identity", () => {
    const input = {
      fixtureSeed: FIXTURE_SEED,
      packetNonce: PACKET_NONCE,
      sources: sources(),
    };
    const first = createBlindGradingPacket({ ...input, packetId: "packet-one" });
    const second = createBlindGradingPacket({ ...input, packetId: "packet-two" });
    expect(first.packet.entries.map(({ output }) => output)).not.toEqual(
      second.packet.entries.map(({ output }) => output),
    );
  });

  it("rejects a caller-re-HMACed complete mapping swap", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const forged = clone(created.mapping) as ConfidentialBlindMapping;
    const leftLabel = forged.entries[0]!.label;
    const rightLabel = forged.entries[1]!.label;
    const left = forged.entries[0]!;
    const right = forged.entries[1]!;
    forged.entries[0] = { ...right, label: leftLabel };
    forged.entries[1] = { ...left, label: rightLabel };
    const withoutHash = { ...forged } as Partial<ConfidentialBlindMapping>;
    delete withoutHash.mappingHash;
    forged.mappingHash = canonicalSha256(withoutHash);

    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: forged,
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow();
  });

  it("rejects unpaired surrogates at the public annotation boundary", () => {
    const malformed = annotation();
    malformed.grader.declaredExpertise = "bad-\ud800-value";
    expect(BlindAnnotationSchema.safeParse(malformed).success).toBe(false);
  });

  it("preserves valid NFC and NFD expertise strings without normalization", () => {
    const nfc = annotation();
    nfc.grader.declaredExpertise = "Café — self-declared";
    const nfd = annotation();
    nfd.grader.declaredExpertise = "Cafe\u0301 — self-declared";
    expect(BlindAnnotationSchema.parse(nfc).grader.declaredExpertise).toBe(
      nfc.grader.declaredExpertise,
    );
    expect(BlindAnnotationSchema.parse(nfd).grader.declaredExpertise).toBe(
      nfd.grader.declaredExpertise,
    );
    expect(nfc.grader.declaredExpertise).not.toBe(nfd.grader.declaredExpertise);
  });

  it("uses one equal-length label per canonical position without grader-visible hashes", () => {
    const created = packet();
    const labels = created.packet.entries.map(({ label }) => label);
    expect(labels).toEqual([
      "Condition A",
      "Condition B",
      "Condition C",
      "Condition D",
    ]);
    expect(new Set(labels).size).toBe(4);
    expect(new Set(labels.map((label) => label.length)).size).toBe(1);
    expect(created.packet.entries.map(({ entryId }) => entryId)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
    expect(
      created.packet.entries.flatMap(({ output }) =>
        output.items.map(({ itemId }) => itemId),
      ),
    ).toEqual(["item-1", "item-1", "item-1", "item-1"]);
    expect(canonicalizeJson(created.packet)).not.toMatch(/[a-f0-9]{64}/u);
  });

  it("is reproducible for an explicit fixture seed/nonce and separates packet and nonce domains", () => {
    const first = packet(FIXTURE_SEED, "packet-repro", PACKET_NONCE);
    const replay = packet(FIXTURE_SEED, "packet-repro", PACKET_NONCE);
    expect(replay.packet).toEqual(first.packet);
    expect(replay.mapping).toEqual(first.mapping);
    expect(replay.authority).not.toBe(first.authority);

    const otherPacket = packet(FIXTURE_SEED, "packet-other", PACKET_NONCE);
    expect(otherPacket.packet).not.toEqual(first.packet);
    expect(otherPacket.mapping.mappingId).not.toBe(first.mapping.mappingId);
    expect(otherPacket.mapping.permutationCommitment).not.toBe(
      first.mapping.permutationCommitment,
    );

    const otherNonce = packet(FIXTURE_SEED, "packet-repro", "2".repeat(64));
    expect(otherNonce.mapping.mappingId).not.toBe(first.mapping.mappingId);
    expect(otherNonce.mapping.permutationCommitment).not.toBe(
      first.mapping.permutationCommitment,
    );
    for (const result of [first, replay, otherPacket, otherNonce]) {
      expect(new Set(result.packet.entries.map(({ label }) => label)).size).toBe(4);
    }
  });

  it("requires the exact process-local authority before traversing mapping data", async () => {
    const root = await temporaryRoot();
    const created = packet();
    const serializedPacket = JSON.parse(JSON.stringify(created.packet));
    const serializedMapping = JSON.parse(JSON.stringify(created.mapping));
    const serializedAnnotation = JSON.parse(
      JSON.stringify(annotation(created.packet)),
    );
    const accepted = await importBlindAnnotation({
      artifactRoot: root,
      authority: created.authority,
      sources: sources(),
      packet: serializedPacket,
      mapping: serializedMapping,
      annotation: serializedAnnotation,
    });
    expect(accepted.status).toBe("created");

    const lostUpstream = sources();
    const upstreamRecordProxy = trapCountingProxy(
      lostUpstream[0]!.comparisonRecord,
    );
    lostUpstream[0]!.comparisonAuthority =
      {} as typeof lostUpstream[0]["comparisonAuthority"];
    lostUpstream[0]!.comparisonRecord = upstreamRecordProxy.proxy;
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: lostUpstream,
        packet: serializedPacket,
        mapping: serializedMapping,
        annotation: serializedAnnotation,
      }),
    ).rejects.toThrow(/upstream|authority/i);
    expect(upstreamRecordProxy.trapCount()).toBe(0);

    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: created.authority,
        sources: JSON.parse(JSON.stringify(sources())),
        packet: serializedPacket,
        mapping: serializedMapping,
        annotation: serializedAnnotation,
      }),
    ).rejects.toThrow(/upstream|authority/i);

    const fakeAuthorities = [
      {},
      structuredClone(created.authority),
      JSON.parse(JSON.stringify(created.authority)),
    ];
    for (const fakeAuthority of fakeAuthorities) {
      await expect(
        importBlindAnnotation({
          artifactRoot: root,
          authority: fakeAuthority as typeof created.authority,
          sources: sources(),
          packet: created.packet,
          mapping: created.mapping,
          annotation: annotation(created.packet),
        }),
      ).rejects.toThrow(/exact issued capability/i);
    }

    const proxied = trapCountingProxy(created.authority);
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: proxied.proxy,
        sources: sources(),
        packet: created.packet,
        mapping: created.mapping,
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow(/exact issued capability/i);
    expect(proxied.trapCount()).toBe(0);

    const revoked = Proxy.revocable(created.authority, {});
    revoked.revoke();
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: revoked.proxy,
        sources: sources(),
        packet: created.packet,
        mapping: created.mapping,
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow(/exact issued capability/i);

    const untrustedMapping = trapCountingProxy(created.mapping);
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: {} as typeof created.authority,
        sources: sources(),
        packet: created.packet,
        mapping: untrustedMapping.proxy,
        annotation: annotation(created.packet),
      }),
    ).rejects.toThrow(/exact issued capability/i);
    expect(untrustedMapping.trapCount()).toBe(0);

    let authorityGetterRuns = 0;
    const accessorEnvelope = {
      artifactRoot: root,
      packet: created.packet,
      mapping: created.mapping,
      annotation: annotation(created.packet),
      sources: sources(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, "authority", {
      enumerable: true,
      get() {
        authorityGetterRuns += 1;
        return created.authority;
      },
    });
    await expect(
      importBlindAnnotation(
        accessorEnvelope as Parameters<typeof importBlindAnnotation>[0],
      ),
    ).rejects.toThrow(/passive data properties/i);
    expect(authorityGetterRuns).toBe(0);
  });

  it("rejects cross-packet authority replay and remains usable after rejection", async () => {
    const root = await temporaryRoot();
    const first = packet(FIXTURE_SEED, "packet-first", PACKET_NONCE);
    const second = packet(FIXTURE_SEED, "packet-second", "2".repeat(64));
    const otherSeed = packet("b".repeat(64), "packet-first", PACKET_NONCE);

    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: first.authority,
        sources: sources(),
        packet: second.packet,
        mapping: second.mapping,
        annotation: annotation(second.packet),
      }),
    ).rejects.toThrow(/issued authority/i);
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: first.authority,
        sources: sources(),
        packet: otherSeed.packet,
        mapping: otherSeed.mapping,
        annotation: annotation(otherSeed.packet),
      }),
    ).rejects.toThrow(/issued authority/i);
    await expect(
      importBlindAnnotation({
        artifactRoot: root,
        authority: second.authority,
        sources: sources(),
        packet: first.packet,
        mapping: first.mapping,
        annotation: annotation(first.packet),
      }),
    ).rejects.toThrow(/issued authority/i);

    const valid = await importBlindAnnotation({
      artifactRoot: root,
      authority: first.authority,
      sources: sources(),
      packet: first.packet,
      mapping: first.mapping,
      annotation: annotation(first.packet),
    });
    expect(valid.status).toBe("created");
  });

  it("keeps the confidential structural mapping validator internal", async () => {
    const gradingModule = await import("./v1");
    expect("ConfidentialBlindMappingSchema" in gradingModule).toBe(false);
    expect("BlindPacketCandidateSchema" in gradingModule).toBe(false);
    expect("resolveAuthorizedSources" in gradingModule).toBe(false);
    expect(createBlindGradingPacket.length).toBe(1);
  });

  it("rejects control and bidi-spoofing characters while retaining scalar Unicode", () => {
    for (const value of ["bad\u0000value", "bad\u202evalue", "bad\u0085value"]) {
      const malformed = annotation();
      malformed.grader.declaredExpertise = value;
      expect(BlindAnnotationSchema.safeParse(malformed).success).toBe(false);
    }
  });
});
