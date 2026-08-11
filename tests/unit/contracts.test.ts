import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  CONTRACT_EVOLUTION_POLICY,
  CurrentResearchRunSchema,
  LEGACY_CONTRACT_VERSION,
  PREVIOUS_CONTRACT_VERSION,
  PRE_FREEZE_COMPATIBILITY_NOTES,
  DeterministicVerificationSchema,
  DoiResolutionSchema,
  EvidenceCardSchema,
  HumanDecisionSchema,
  MetadataVerificationSchema,
  NodeExecutionSchema,
  PacketFreezeSchema,
  ResearchRunSchema,
  RunErrorSchema,
  SourceChunkSchema,
  SourceRecordSchema,
  canonicalizeJson,
  freezePacket,
  freezeCurrentPacket,
  isAllowedContractVersionTransition,
  parseLegacyResearchRunV00,
  parsePreviousResearchRunV01,
} from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";

const timestamp = "2026-08-06T16:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function addPoisonKey(
  value: unknown,
  path: ReadonlyArray<number | string>,
): unknown {
  const clone = structuredClone(value);
  let target: unknown = clone;

  for (const segment of path) {
    if (typeof segment === "number" && Array.isArray(target)) {
      target = target[segment];
    } else if (
      typeof segment === "string" &&
      typeof target === "object" &&
      target !== null
    ) {
      target = (target as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Invalid test path segment: ${String(segment)}`);
    }
  }

  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new Error("Test poison target must be an object");
  }
  (target as Record<string, unknown>).unexpected = "must reject";
  return clone;
}

const humanDecision = HumanDecisionSchema.parse({
  id: "decision-1",
  checkpoint: "packet_freeze",
  optionsShown: ["approve", "reject"],
  decision: "approve",
  edits: [],
  decidedAt: timestamp,
  unresolvedObjections: [],
});

const source = SourceRecordSchema.parse({
  id: "source-1",
  originalInput: "doi:10.1000/example",
  canonicalDoi: "10.1000/example",
  canonicalUrl: "https://doi.org/10.1000/example",
  doiResolution: {
    syntax: "valid",
    resolution: "resolved",
    registrationAgency: "Crossref",
    checkedAt: timestamp,
  },
  bibliographicMetadata: {
    title: "Bounded fixture source",
    authors: ["A. Researcher"],
    year: 2025,
    venue: "Fixture Journal",
    studyType: "controlled_trial",
  },
  access: {
    origin: "curated_fixture",
    contentScope: "abstract",
    provider: "fixture",
    version: "v1",
    location: "fixture://source-1",
    retrievedAt: timestamp,
  },
  rights: {
    mayStore: "allowed",
    mayDisplay: "allowed",
    maySendToModel: "allowed",
    basis: "project-owned fixture",
    checkedAt: timestamp,
  },
  contentHash: hashA,
  metadataVerification: {
    status: "match",
    method: "fixture",
    checkedAt: timestamp,
    fieldDiffs: [],
  },
  integrityNotices: [],
  mergedSourceIds: [],
  warnings: [],
});

const execution = NodeExecutionSchema.parse({
  id: "execution-1",
  nodeId: "extract-evidence",
  attempt: 1,
  status: "succeeded",
  evidenceMode: "fixture",
  inputRefs: ["chunk-1"],
  outputRefs: ["evidence-1"],
  requestedProvider: "fixture",
  returnedProvider: "fixture",
  requestedModelId: "fixture-primary-v1",
  returnedModelId: "fixture-primary-v1",
  requestedDeveloperFamily: "fixture-family-a",
  returnedDeveloperFamily: "fixture-family-a",
  requestedBaseFamily: "fixture-family-a",
  returnedBaseFamily: "fixture-family-a",
  returnedReasoningMode: "disabled",
  promptId: "extract-evidence",
  promptVersion: "0.0",
  promptHash: hashA,
  structuredOutputSchemaVersion: CONTRACT_VERSION,
  generationSettings: {
    temperature: 0,
    maxOutputTokens: 500,
    topP: null,
    seed: 1,
    reasoningMode: "disabled",
    reasoningBudgetTokens: null,
  },
  startedAt: timestamp,
  endedAt: timestamp,
  clientLatencyMs: 5,
  providerTiming: {
    queueMs: null,
    promptMs: null,
    completionMs: null,
    totalMs: null,
  },
  requestIds: {
    clientRequestId: "client-request-1",
    providerRequestId: "fixture-request-1",
    responseId: "fixture-response-1",
  },
  finishReason: "stop",
  refusal: {
    refused: false,
    reason: null,
  },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: null,
    reasoningTokens: null,
  },
  pricing: {
    currency: "USD",
    inputPerMillionTokens: null,
    outputPerMillionTokens: null,
    estimatedCost: null,
    snapshotDate: null,
  },
  validation: {
    valid: true,
    issues: [],
  },
  errorIds: [],
  retryOfExecutionId: null,
  fallbackFromExecutionId: null,
  codeVersion: "test",
});

const evidenceCard = EvidenceCardSchema.parse({
  id: "evidence-1",
  subclaimId: "claim-1",
  sourceChunkId: "chunk-1",
  excerpt: "The bounded fixture reports a measured result.",
  extractedResult: "Measured result",
  settingAndSample: "Fixture setting",
  studyType: "controlled_trial",
  limitation: "Synthetic fixture only",
  relationship: "supports",
  deterministicVerification: {
    method: "literal_substring",
    status: "verified",
    checkedAt: timestamp,
    details: "Unique literal substring in chunk-1",
  },
  modelAssessment: {
    entailment: "full_support",
    rationale: "The excerpt directly states the bounded result.",
    provider: "fixture",
    requestedModelId: "fixture-primary-v1",
    returnedModelId: "fixture-primary-v1",
    promptId: "assess-entailment",
    promptVersion: "0.0",
    executionId: "execution-1",
  },
  conclusionStrengthWarning: null,
  humanReview: {
    status: "confirmed",
    reason: "Fixture review",
    reviewedAt: timestamp,
    reviewerId: "fixture-reviewer",
  },
  extractionIssues: [],
});

describe("contract v0", () => {
  it("validates one bounded run object spanning every issue-listed domain", () => {
    const packet = freezeCurrentPacket({
      sourceHashes: [hashB, hashA],
      chunkHashes: [hashC],
      frozenAt: timestamp,
      freezeDecision: humanDecision,
    });

    const run = {
      schemaVersion: CONTRACT_VERSION,
      id: "run-1",
      status: "approved",
      evidenceMode: "fixture",
      createdAt: timestamp,
      updatedAt: timestamp,
      intake: {
        originalQuestion: "Does the bounded fixture support the claim?",
        intendedApplication: "Hackathon demonstration",
        populationOrGeography: "Fixture population",
        timeHorizon: "One year",
        availableMaterialsOrBudget: "Provided source packet",
        desiredDepth: "bounded",
        constraints: ["Use approved sources only"],
        unansweredClarifications: [],
      },
      claims: [
        {
          id: "claim-1",
          statement: "The bounded fixture supports the claim.",
          operationalDefinition: "A displayable excerpt directly entails the claim.",
          category: "effect",
          parentClaimId: null,
          scopeConstraints: ["Fixture only"],
          disposition: "approved",
          rationale: "Required to answer the intake question.",
        },
      ],
      scopeDecision: {
        ...humanDecision,
        id: "decision-scope",
        checkpoint: "scope",
      },
      packet,
      sources: [source],
      chunks: [
        {
          id: "chunk-1",
          sourceId: "source-1",
          text: "The bounded fixture reports a measured result.",
          location: "abstract",
          contentHash: hashC,
          displayPermission: "allowed",
        },
      ],
      evidenceCards: [evidenceCard],
      conclusions: [
        {
          subclaimId: "claim-1",
          strength: "moderate",
          conclusion: "The fixture supports the bounded claim.",
          supportingEvidenceCardIds: ["evidence-1"],
          contradictingEvidenceCardIds: [],
          disagreementSummary: null,
          limitations: ["Synthetic fixture"],
          changeEvidence: ["Live rights-approved source packet"],
          overclaimingWarnings: [],
          humanReviewStatus: "confirmed",
        },
      ],
      researchGaps: [
        {
          id: "gap-1",
          affectedSubclaimIds: ["claim-1"],
          type: "other",
          impactRationale: "Fixture evidence is not live evidence.",
          tractabilityRationale: "A rights-approved packet can be evaluated later.",
          evidenceCardIds: ["evidence-1"],
          rank: 1,
          selection: "selected",
        },
      ],
      selectedGapId: "gap-1",
      experiment: {
        selectedGapId: "gap-1",
        objective: "Evaluate the bounded claim on an approved packet.",
        designType: "observational",
        hypothesis: "The approved packet supports the claim.",
        nullHypothesis: "The approved packet does not support the claim.",
        experimentalOrObservationalUnit: "Source",
        unitOfAnalysis: "Evidence card",
        interventionOrExposure: "Approved source packet",
        comparator: "No supporting passage",
        independentVariables: ["Source"],
        dependentVariables: ["Entailment category"],
        primaryOutcomes: ["Human-confirmed entailment"],
        secondaryOutcomes: [],
        controls: ["Frozen packet"],
        comparisonGroups: [],
        measurementValidity: "Literal-substring and human-review checks",
        allocation: {
          randomization: "not_applicable",
          blocking: "not_applicable",
          blinding: "Reviewer sees source text",
          rationale: "Bounded observational audit",
        },
        replicationPlan: "Repeat on each approved source.",
        repeatedMeasurementPlan: "No repeated measurements.",
        inclusionCriteria: ["Approved source"],
        exclusionCriteria: ["Rights denied"],
        attritionPlan: "Report unavailable sources.",
        missingDataPlan: "Keep missing evidence explicit.",
        procedure: ["Freeze packet", "Extract cards", "Review conclusions"],
        sampleSizeBasis: "All sources in the bounded packet.",
        missingPowerAssumptions: ["No effect-size estimate"],
        estimand: "Proportion of reviewed cards that entail the claim",
        metrics: ["Entailment category"],
        analysisPlan: "Categorical summary with traceable cards.",
        assumptionChecks: ["Rights state", "Quote reference"],
        confounders: ["Publication selection"],
        mitigations: ["Report packet boundary"],
        feasibility: "Fixture demonstration only",
        requiredResources: ["Approved source packet"],
        constraints: ["No unrestricted web research"],
        hazards: [],
        ethics: ["Qualified review before real-world use"],
        qualifiedReviewRequired: true,
        stoppingCriteria: ["Rights denial"],
        failureCriteria: ["No displayable evidence"],
        expectedOutcomeBranches: [
          {
            outcome: "support",
            establishes: "Bounded packet support",
            doesNotEstablish: "Universal truth",
          },
        ],
        externalValidityBoundary: "Approved packet only",
        supportingEvidenceCardIds: ["evidence-1"],
      },
      experimentAbstention: null,
      review: {
        protocolVersion: "0.0",
        reviewerExecutionId: "execution-1",
        objections: [
          {
            id: "objection-1",
            category: "inferential_overreach",
            severity: "medium",
            targetField: "externalValidityBoundary",
            rationale: "The conclusion must remain packet-bounded.",
            evidenceCardIds: ["evidence-1"],
          },
        ],
      },
      objectionDispositionDecision: {
        ...humanDecision,
        id: "decision-objections",
        checkpoint: "objection_dispositions",
      },
      revision: {
        protocolVersion: "0.0",
        decisions: [
          {
            objectionId: "objection-1",
            disposition: "accepted",
            basis: "Human packet-boundary decision",
            originalValue: "Broad applicability",
            revisedValue: "Approved packet only",
            residualRisk: "Fixture evidence remains synthetic",
          },
        ],
      },
      finalDecision: {
        ...humanDecision,
        id: "decision-final",
        checkpoint: "final",
        declaredActor: "Review lead",
        rationale: "Approve the bounded fixture outcome.",
      },
      executions: [execution],
      errors: [
        RunErrorSchema.parse({
          id: "error-1",
          kind: "missing_evidence",
          message: "A live packet was not supplied.",
          nodeId: "collect-sources",
          executionId: null,
          retryable: false,
          occurredAt: timestamp,
          details: {
            field: "packet",
            providerCode: null,
            httpStatus: null,
          },
        }),
      ],
    };

    expect(ResearchRunSchema.parse(run)).toEqual(run);
    expect(CurrentResearchRunSchema.parse(run)).toEqual(run);

    const missingCurrentPromptHash = structuredClone(run);
    delete (
      missingCurrentPromptHash.executions[0] as Record<string, unknown>
    ).promptHash;
    expect(
      ResearchRunSchema.safeParse(missingCurrentPromptHash).success,
    ).toBe(false);

    const missingCurrentAbstention = structuredClone(run) as Record<
      string,
      unknown
    >;
    delete missingCurrentAbstention.experimentAbstention;
    expect(
      ResearchRunSchema.safeParse(missingCurrentAbstention).success,
    ).toBe(false);

    const conflictingPlanning = structuredClone(run) as Record<
      string,
      unknown
    >;
    conflictingPlanning.experimentAbstention = {
      id: "abstention-1",
      reason: "Qualified review is missing.",
      safetyCategories: ["missing_qualified_review"],
      qualifiedReviewRequired: true,
      missingInputs: ["qualified reviewer"],
      allowedNextStep: "Obtain qualified human review.",
    };
    expect(
      ResearchRunSchema.safeParse(conflictingPlanning).success,
    ).toBe(false);

    const legacyRun = structuredClone(run) as Record<string, unknown>;
    legacyRun.schemaVersion = LEGACY_CONTRACT_VERSION;
    legacyRun.packet = null;
    delete legacyRun.experimentAbstention;
    delete (
      (legacyRun.executions as Array<Record<string, unknown>>)[0]
    ).promptHash;
    expect(parseLegacyResearchRunV00(legacyRun).schemaVersion).toBe(
      LEGACY_CONTRACT_VERSION,
    );
    expect(CurrentResearchRunSchema.safeParse(legacyRun).success).toBe(false);
    expect(() => parseLegacyResearchRunV00(run)).toThrow(
      /legacy reader accepts only/i,
    );

    const objectPaths: ReadonlyArray<ReadonlyArray<number | string>> = [
      [],
      ["intake"],
      ["claims", 0],
      ["scopeDecision"],
      ["packet"],
      ["packet", "freezeDecision"],
      ["sources", 0],
      ["sources", 0, "doiResolution"],
      ["sources", 0, "bibliographicMetadata"],
      ["sources", 0, "access"],
      ["sources", 0, "rights"],
      ["sources", 0, "metadataVerification"],
      ["chunks", 0],
      ["evidenceCards", 0],
      ["evidenceCards", 0, "deterministicVerification"],
      ["evidenceCards", 0, "modelAssessment"],
      ["evidenceCards", 0, "humanReview"],
      ["conclusions", 0],
      ["researchGaps", 0],
      ["experiment"],
      ["experiment", "allocation"],
      ["experiment", "expectedOutcomeBranches", 0],
      ["review"],
      ["review", "objections", 0],
      ["objectionDispositionDecision"],
      ["revision"],
      ["revision", "decisions", 0],
      ["finalDecision"],
      ["executions", 0],
      ["executions", 0, "generationSettings"],
      ["executions", 0, "providerTiming"],
      ["executions", 0, "requestIds"],
      ["executions", 0, "refusal"],
      ["executions", 0, "usage"],
      ["executions", 0, "pricing"],
      ["executions", 0, "validation"],
      ["errors", 0],
      ["errors", 0, "details"],
    ];

    for (const path of objectPaths) {
      expect(
        ResearchRunSchema.safeParse(addPoisonKey(run, path)).success,
        `object at ${path.join(".") || "<root>"} must reject unknown keys`,
      ).toBe(false);
    }

    expect(
      ResearchRunSchema.safeParse({
        ...run,
        finalDecision: {
          ...run.finalDecision,
          checkpoint: "scope",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps every object closed, including nested rights and verification layers", () => {
    expect(
      SourceRecordSchema.safeParse({
        ...source,
        rights: {
          ...source.rights,
          metadataVerification: source.metadataVerification,
        },
      }).success,
    ).toBe(false);

    expect(
      EvidenceCardSchema.safeParse({
        ...evidenceCard,
        deterministicVerification: {
          ...evidenceCard.deterministicVerification,
          humanReview: evidenceCard.humanReview,
        },
      }).success,
    ).toBe(false);

    expect(
      HumanDecisionSchema.safeParse({
        ...humanDecision,
        inventedConfidencePercentage: 97,
      }).success,
    ).toBe(false);

    const conflictingLayers = SourceRecordSchema.parse({
      ...source,
      rights: {
        ...source.rights,
        mayDisplay: "denied",
      },
      metadataVerification: {
        ...source.metadataVerification,
        status: "match",
      },
    });
    expect(conflictingLayers.rights.mayDisplay).toBe("denied");
    expect(conflictingLayers.metadataVerification.status).toBe("match");

    const independentlyLayeredCard = EvidenceCardSchema.parse({
      ...evidenceCard,
      deterministicVerification: {
        ...evidenceCard.deterministicVerification,
        status: "failed",
      },
      modelAssessment: {
        ...evidenceCard.modelAssessment,
        entailment: "full_support",
      },
      humanReview: {
        status: "overridden",
        reason: "Deterministic quote check failed.",
        reviewedAt: timestamp,
        reviewerId: "fixture-reviewer",
      },
    });
    expect(independentlyLayeredCard.deterministicVerification.status).toBe(
      "failed",
    );
    expect(independentlyLayeredCard.modelAssessment.entailment).toBe(
      "full_support",
    );
    expect(independentlyLayeredCard.humanReview.status).toBe("overridden");
  });

  it("rejects empty source passages and evidence excerpts", () => {
    expect(
      SourceChunkSchema.safeParse({
        id: "chunk-empty",
        sourceId: "source-1",
        text: "",
        location: "abstract",
        contentHash: hashC,
        displayPermission: "allowed",
      }).success,
    ).toBe(false);
    expect(
      SourceChunkSchema.safeParse({
        id: "chunk-whitespace",
        sourceId: "source-1",
        text: " \n\t ",
        location: "abstract",
        contentHash: hashC,
        displayPermission: "allowed",
      }).success,
    ).toBe(false);
    expect(
      EvidenceCardSchema.safeParse({
        ...evidenceCard,
        excerpt: "",
      }).success,
    ).toBe(false);
    expect(
      EvidenceCardSchema.safeParse({
        ...evidenceCard,
        excerpt: " \n\t ",
      }).success,
    ).toBe(false);
  });

  it("requires timestamps for performed deterministic verification states", () => {
    for (const status of ["verified", "failed", "unavailable"] as const) {
      expect(
        DeterministicVerificationSchema.safeParse({
          method: "literal_substring",
          status,
          checkedAt: null,
          details: "Explicit bounded result",
        }).success,
        `${status} must record when the verification was attempted`,
      ).toBe(false);
    }

    expect(
      DeterministicVerificationSchema.safeParse({
        method: "literal_substring",
        status: "not_checked",
        checkedAt: null,
        details: "Verification has not been attempted",
      }).success,
    ).toBe(true);
    expect(
      DeterministicVerificationSchema.safeParse({
        method: "literal_substring",
        status: "not_checked",
        checkedAt: timestamp,
        details: "Contradictory audit state",
      }).success,
    ).toBe(false);
  });

  it("requires timestamps for performed metadata verification states", () => {
    for (const status of ["match", "mismatch", "unavailable"] as const) {
      expect(
        MetadataVerificationSchema.safeParse({
          status,
          method: "fixture",
          checkedAt: null,
          fieldDiffs: [],
        }).success,
        `${status} must record when the metadata check was attempted`,
      ).toBe(false);
    }

    expect(
      MetadataVerificationSchema.safeParse({
        status: "not_checked",
        method: "fixture",
        checkedAt: null,
        fieldDiffs: [],
      }).success,
    ).toBe(true);
    expect(
      MetadataVerificationSchema.safeParse({
        status: "not_checked",
        method: "fixture",
        checkedAt: timestamp,
        fieldDiffs: [],
      }).success,
    ).toBe(false);
  });

  it("keeps adjacent DOI resolution status and timestamp coherent", () => {
    for (const resolution of [
      "resolved",
      "not_found",
      "unavailable",
    ] as const) {
      expect(
        DoiResolutionSchema.safeParse({
          syntax: "valid",
          resolution,
          registrationAgency: null,
          checkedAt: null,
        }).success,
        `${resolution} must record when DOI resolution was attempted`,
      ).toBe(false);
    }

    expect(
      DoiResolutionSchema.safeParse({
        syntax: "not_provided",
        resolution: "not_checked",
        registrationAgency: null,
        checkedAt: null,
      }).success,
    ).toBe(true);
    expect(
      DoiResolutionSchema.safeParse({
        syntax: "not_provided",
        resolution: "not_checked",
        registrationAgency: null,
        checkedAt: timestamp,
      }).success,
    ).toBe(false);
  });

  it("canonicalizes JSON using RFC 8785 property ordering and number serialization", () => {
    expect(
      canonicalizeJson({
        string: "€$\u000f\nA'B\"\\\\\"/",
        numbers: [
          333333333.33333329,
          1e30,
          4.5,
          2e-3,
          0.000000000000000000000000001,
        ],
        nested: { z: true, a: null },
      }),
    ).toBe(
      "{\"nested\":{\"a\":null,\"z\":true},\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
    );
  });

  it("applies recursive UTF-16 key ordering without reordering arrays or normalizing text", () => {
    const decomposed = "e\u0301";
    const canonical = canonicalizeJson({
      "\ufb33": "hebrew",
      "😀": "emoji",
      "€": "euro",
      ö: "latin",
      "\u0080": "control",
      "1": "digit",
      "\r": "carriage-return",
      nested: [{ z: decomposed, a: "first" }, "array-order"],
    });

    expect(canonical).toBe(
      `{"\\r":"carriage-return","1":"digit","nested":[{"a":"first","z":"${decomposed}"},"array-order"],"\u0080":"control","ö":"latin","€":"euro","😀":"emoji","\ufb33":"hebrew"}`,
    );
    expect(canonical).not.toContain("é");
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalizeJson(JSON.parse(canonical))).toBe(canonical);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["bigint", BigInt(1)],
    ["function", () => true],
    ["date", new Date(timestamp)],
    ["unpaired high surrogate", String.fromCharCode(0xd800)],
    ["unpaired low surrogate", String.fromCharCode(0xdc00)],
    ["sparse array", Array(1)],
  ])("rejects non-I-JSON input: %s", (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(TypeError);
  });

  it("sorts packet hashes and rejects a tampered RFC 8785 fingerprint", () => {
    const sourceHashes = [hashB, hashA];
    const chunkHashes = [hashC, hashA];
    const packet = freezePacket({
      sourceHashes,
      chunkHashes,
      frozenAt: timestamp,
      freezeDecision: humanDecision,
    });
    const reversedPacket = freezePacket({
      sourceHashes: [...sourceHashes].reverse(),
      chunkHashes: [...chunkHashes].reverse(),
      frozenAt: timestamp,
      freezeDecision: humanDecision,
    });

    expect(sourceHashes).toEqual([hashB, hashA]);
    expect(chunkHashes).toEqual([hashC, hashA]);
    expect(packet.sourceHashes).toEqual([hashA, hashB]);
    expect(packet.chunkHashes).toEqual([hashA, hashC]);
    expect(packet.packetVersion).toBe(1);
    expect(packet.frozenAt).toBe(timestamp);
    expect(packet.freezeDecision).toEqual(humanDecision);
    expect(packet.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reversedPacket).toEqual(packet);

    for (const tampered of [
      { ...packet, fingerprint: hashA },
      { ...packet, packetVersion: 2 },
      { ...packet, sourceHashes: [hashC] },
      { ...packet, chunkHashes: [hashB] },
      { ...packet, frozenAt: "2026-08-06T16:00:01.000Z" },
      {
        ...packet,
        freezeDecision: { ...humanDecision, edits: ["changed after freeze"] },
      },
    ]) {
      expect(PacketFreezeSchema.safeParse(tampered).success).toBe(false);
    }

    expect(
      PacketFreezeSchema.safeParse({
        ...packet,
        sourceHashes: [...packet.sourceHashes].reverse(),
      }).success,
    ).toBe(false);
    expect(
      PacketFreezeSchema.safeParse({
        ...packet,
        chunkHashes: [hashA, hashA],
      }).success,
    ).toBe(false);
    expect(() =>
      freezePacket({
        sourceHashes: [hashA],
        chunkHashes: [hashB],
        frozenAt: timestamp,
        freezeDecision: { ...humanDecision, decision: "reject" },
      }),
    ).toThrow();
  });

  it("requires explicit model, request, refusal, timing, usage, and pricing fields", () => {
    for (const field of [
      "evidenceMode",
      "requestedProvider",
      "returnedProvider",
      "requestedModelId",
      "returnedModelId",
      "requestedDeveloperFamily",
      "returnedDeveloperFamily",
      "requestedBaseFamily",
      "returnedBaseFamily",
      "returnedReasoningMode",
      "requestIds",
      "finishReason",
      "refusal",
      "generationSettings",
      "startedAt",
      "endedAt",
      "clientLatencyMs",
      "providerTiming",
      "usage",
      "pricing",
      "validation",
    ]) {
      const incomplete = { ...execution } as Record<string, unknown>;
      delete incomplete[field];
      expect(
        NodeExecutionSchema.safeParse(incomplete).success,
        `${field} must be explicit, using null when unavailable`,
      ).toBe(false);
    }

    expect(NodeExecutionSchema.parse(execution)).toEqual(execution);
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        promptHash: hashA,
      }).success,
    ).toBe(true);
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        promptHash: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        returnedProvider: null,
        returnedModelId: null,
        returnedDeveloperFamily: null,
        returnedBaseFamily: null,
        returnedReasoningMode: null,
        finishReason: null,
        endedAt: null,
        clientLatencyMs: null,
        requestIds: {
          clientRequestId: "client-request-2",
          providerRequestId: null,
          responseId: null,
        },
      }).success,
    ).toBe(true);
  });

  it("enforces coherent refusal, review, and pricing audit states", () => {
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        refusal: { refused: true, reason: null },
      }).success,
    ).toBe(false);
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        refusal: { refused: false, reason: "not actually refused" },
      }).success,
    ).toBe(false);
    expect(
      NodeExecutionSchema.safeParse({
        ...execution,
        pricing: {
          ...execution.pricing,
          estimatedCost: 0.001,
        },
      }).success,
    ).toBe(false);
    expect(
      EvidenceCardSchema.safeParse({
        ...evidenceCard,
        humanReview: {
          status: "unreviewed",
          reason: "partial audit metadata",
          reviewedAt: null,
          reviewerId: null,
        },
      }).success,
    ).toBe(false);
    expect(
      EvidenceCardSchema.safeParse({
        ...evidenceCard,
        humanReview: {
          status: "overridden",
          reason: null,
          reviewedAt: null,
          reviewerId: null,
        },
      }).success,
    ).toBe(false);
  });

  it("allows declared monotonic minor transitions without claiming structural proof", () => {
    expect(LEGACY_CONTRACT_VERSION).toBe("0.0");
    expect(PREVIOUS_CONTRACT_VERSION).toBe("0.1");
    expect(CONTRACT_VERSION).toBe("0.2");
    expect(CONTRACT_EVOLUTION_POLICY.compatibilityDirection).toBe(
      "new_reader_accepts_prior_minor",
    );
    expect(isAllowedContractVersionTransition("0.0", "0.1")).toBe(true);
    expect(isAllowedContractVersionTransition("0.1", "0.2")).toBe(true);
    expect(isAllowedContractVersionTransition("0.2", "0.2")).toBe(true);
    expect(isAllowedContractVersionTransition("0.2", "0.1")).toBe(false);
    expect(isAllowedContractVersionTransition("0.2", "1.0")).toBe(false);
    expect(isAllowedContractVersionTransition("invalid", "0.3")).toBe(false);
    expect(
      PRE_FREEZE_COMPATIBILITY_NOTES["NodeExecution.promptHash"],
    ).toContain("legacy 0.0");
    expect(
      PRE_FREEZE_COMPATIBILITY_NOTES[
        "ResearchRun.experimentAbstention"
      ],
    ).toContain("legacy 0.0");
    expect(PRE_FREEZE_COMPATIBILITY_NOTES.legacyMigration).toContain(
      "human-refreezing",
    );
    expect(parsePreviousResearchRunV01(goldenRunV01).schemaVersion).toBe(
      "0.1",
    );
    expect(CurrentResearchRunSchema.safeParse(goldenRunV01).success).toBe(true);
  });

  it("accepts paired bounded inert provenance on a final decision", () => {
    const parsed = HumanDecisionSchema.parse({
      ...humanDecision,
      checkpoint: "final",
      declaredActor: "Review lead",
      rationale: "The bounded fixture supports only the reviewed pilot.",
    });

    expect(parsed.declaredActor).toBe("Review lead");
    expect(parsed.rationale).toContain("reviewed pilot");
    expect(
      HumanDecisionSchema.safeParse({
        ...parsed,
        rationale: undefined,
      }).success,
    ).toBe(false);
    expect(
      HumanDecisionSchema.safeParse({
        ...parsed,
        declaredActor: "Review\u202elead",
      }).success,
    ).toBe(false);
    expect(
      HumanDecisionSchema.safeParse({
        ...parsed,
        declaredActor: "x".repeat(81),
      }).success,
    ).toBe(false);
    expect(
      HumanDecisionSchema.safeParse({
        ...parsed,
        rationale: "x".repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      ResearchRunSchema.safeParse({
        ...structuredClone(goldenRunV02),
        finalDecision: {
          ...structuredClone(goldenRunV02.finalDecision),
          declaredActor: undefined,
          rationale: undefined,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps typed errors visible and rejects unknown kinds or detail fields", () => {
    const error = RunErrorSchema.parse({
      id: "error-typed",
      kind: "missing_passage",
      message: "The approved source has no displayable passage.",
      nodeId: "extract-evidence",
      executionId: "execution-1",
      retryable: false,
      occurredAt: timestamp,
      details: {
        field: "sourceChunkId",
        providerCode: null,
        httpStatus: null,
      },
    });

    expect(error.kind).toBe("missing_passage");
    expect(
      RunErrorSchema.safeParse({ ...error, kind: "empty_success" }).success,
    ).toBe(false);
    expect(
      RunErrorSchema.safeParse({
        ...error,
        details: { ...error.details, swallowed: true },
      }).success,
    ).toBe(false);
  });
});
