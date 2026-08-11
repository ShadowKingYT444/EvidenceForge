import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CurrentWriterResearchRunSchema,
  HumanDecisionSchema,
  ResearchIntakeSchema,
  ResearchRunSchema,
  RunErrorSchema,
  canonicalSha256,
  type ResearchRun,
} from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import {
  createFixtureAdapter,
  createGroqAdapter,
  createNvidiaAdapter,
} from "../../src/server/models";
import type {
  AdapterRuntime,
  StructuredGenerationAdapter,
  StructuredGenerationRequest,
} from "../../src/server/models";
import {
  ApiProblemSchema,
  CheckpointRequestSchema,
  FixtureWorkbenchBootstrapResponseSchema,
  RunService,
  RunServiceBlockedError,
  ContinueRunResponseSchema,
  materializeEvidenceNodeOutput,
  materializeSynthesisNodeOutput,
  type RunNodeRequestBuilder,
  handleCheckpoint,
  handleBootstrapFixtureWorkbench,
  handleContinueRun,
  handleCreateRun,
  handleExportRun,
  handleGetRun,
} from "../../src/server/workflow/run-api";
import {
  InMemoryWorkflowRunStore,
  RevisionConflictError,
  RunNotFoundError,
  type WorkflowRunSnapshot,
} from "../../src/server/workflow";

const intake = ResearchIntakeSchema.parse({
  originalQuestion: "Can the bounded source packet support the claim?",
  intendedApplication: "Educational hackathon demonstration",
  populationOrGeography: "The supplied source packet",
  timeHorizon: "72 hours",
  availableMaterialsOrBudget: "Fixture-only materials",
  desiredDepth: "Auditable claim review",
  constraints: ["Do not use unrestricted web research."],
  unansweredClarifications: [],
});

const evidenceIdMap = new Map(
  goldenRunV01.evidenceCards.map((card) => [
    card.id,
    `evidence-${canonicalSha256({
      subclaimId: card.subclaimId,
      sourceChunkId: card.sourceChunkId,
      excerpt: card.excerpt,
    })}`,
  ]),
);

function currentEvidenceId(id: string) {
  return evidenceIdMap.get(id) ?? id;
}

function currentGapCandidate(
  gap: ResearchRun["researchGaps"][number],
) {
  return {
    affectedSubclaimIds: structuredClone(gap.affectedSubclaimIds),
    type: gap.type,
    impactRationale: gap.impactRationale,
    tractabilityRationale: gap.tractabilityRationale,
    evidenceCardIds: gap.evidenceCardIds.map(currentEvidenceId),
  };
}

function compactExperiment(
  experiment: NonNullable<ResearchRun["experiment"]>,
) {
  const semantic = structuredClone(experiment) as Omit<
    NonNullable<ResearchRun["experiment"]>,
    "selectedGapId" | "qualifiedReviewRequired"
  > &
    Partial<
      Pick<
        NonNullable<ResearchRun["experiment"]>,
        "selectedGapId" | "qualifiedReviewRequired"
      >
    >;
  delete semantic.selectedGapId;
  delete semantic.qualifiedReviewRequired;
  return semantic;
}

const nodeOutputs = {
  "clarify-and-decompose": {
    claims: structuredClone(goldenRunV01.claims),
  },
  "collect-sources": {
    sources: structuredClone(goldenRunV01.sources),
    chunks: structuredClone(goldenRunV01.chunks),
  },
  "extract-evidence": {
    evidenceCandidates: goldenRunV01.evidenceCards.map(
      ({
        subclaimId,
        sourceChunkId,
        excerpt,
        extractedResult,
        settingAndSample,
        studyType,
        limitation,
        extractionIssues,
      }) => ({
        subclaimId,
        sourceChunkId,
        excerpt,
        extractedResult,
        settingAndSample,
        studyType,
        limitation,
        extractionIssues,
      }),
    ),
  },
  "assess-entailment": {
    entailmentDeltas: goldenRunV01.evidenceCards.map(
      (card) => ({
        evidenceCardId: currentEvidenceId(card.id),
        relationship: card.relationship,
        entailment: card.modelAssessment.entailment,
        rationale: card.modelAssessment.rationale,
        conclusionStrengthWarning: card.conclusionStrengthWarning,
      }),
    ),
  },
  "synthesize-conclusions": {
    conclusions: goldenRunV01.conclusions.map(
      ({
        subclaimId,
        strength,
        conclusion,
        disagreementSummary,
        limitations,
        changeEvidence,
        overclaimingWarnings,
      }) => ({
        subclaimId,
        strength,
        conclusion,
        disagreementSummary,
        limitations: structuredClone(limitations),
        changeEvidence: structuredClone(changeEvidence),
        overclaimingWarnings: structuredClone(overclaimingWarnings),
      }),
    ),
    researchGaps: goldenRunV01.researchGaps.map(currentGapCandidate),
    selectedGapIndex: goldenRunV01.researchGaps.findIndex(
      ({ id }) => id === goldenRunV01.selectedGapId,
    ),
  },
  "plan-experiment": {
    disposition: "proposed",
    experiment: {
      ...compactExperiment(structuredClone(goldenRunV01.experiment!)),
      supportingEvidenceCardIds: currentGapCandidate(
        goldenRunV01.researchGaps.find(
          ({ id }) => id === goldenRunV01.selectedGapId,
        )!,
      ).evidenceCardIds,
    },
    abstention: null,
  },
  "review-experiment": {
    review: {
      ...structuredClone(goldenRunV01.review!),
      objections: goldenRunV01.review!.objections.map((objection) => ({
        ...structuredClone(objection),
        evidenceCardIds: objection.evidenceCardIds.map(currentEvidenceId),
      })),
    },
  },
  "revise-experiment": {
    revision: structuredClone(goldenRunV01.revision),
  },
} as const;

function runtime() {
  let tick = 0;
  let id = 0;
  return {
    now: () => {
      const date = new Date("2026-08-06T19:20:00.000Z");
      date.setSeconds(date.getSeconds() + tick);
      tick += 1;
      return date;
    },
    makeId: (prefix: string) => {
      id += 1;
      return `${prefix}-${id}`;
    },
  };
}

const testRequestBuilder: RunNodeRequestBuilder = ({
  nodeId,
  inputRefs,
}) => ({
  promptId: `test-${nodeId}`,
  promptVersion: "1",
  promptHash: "a".repeat(64),
  messages: [
    {
      role: "user",
      content: JSON.stringify({ nodeId, inputRefs }),
    },
  ],
  settings: {
    temperature: 0,
    maxOutputTokens: 4096,
    topP: null,
    seed: null,
    reasoningMode:
      nodeId === "review-experiment" ? "disabled" : "provider_default",
    reasoningBudgetTokens: null,
  },
  timeoutMs: 30_000,
  repairInvalidOutput: true,
  maximumAttempts: 2,
});

function fixtureService(
  overrides: Readonly<Record<string, unknown>> = {},
  retryableFirstFailure = false,
): RunService {
  const fixtures: Record<string, unknown> = {};
  for (const [nodeId, output] of Object.entries(nodeOutputs)) {
    fixtures[`run-1:${nodeId}:1`] = output;
  }
  Object.assign(fixtures, overrides);

  const fixtureAdapter = createFixtureAdapter({
    modelId: "fixture-model",
    developerFamily: "fixture",
    baseFamily: "fixture",
    fixtures,
  });
  const reviewerAdapter = createFixtureAdapter({
    modelId: "fixture-reviewer-model",
    developerFamily: "fixture-reviewer",
    baseFamily: "fixture-reviewer",
    fixtures,
  });
  let calls = 0;
  const adapter: StructuredGenerationAdapter = retryableFirstFailure
    ? {
        identity: fixtureAdapter.identity,
        async generate<Schema extends z.ZodType>(
          request: StructuredGenerationRequest<Schema>,
        ) {
          const result = await fixtureAdapter.generate(request);
          calls += 1;
          if (calls !== 1 || result.ok) {
            return result;
          }
          return {
            ...result,
            errors: result.errors.map((error) =>
              RunErrorSchema.parse({ ...error, retryable: true }),
            ),
          };
        },
      }
    : fixtureAdapter;
  return new RunService({
    store: new InMemoryWorkflowRunStore(),
    primaryAdapter: adapter,
    reviewerAdapter,
    evidenceMode: "fixture",
    requestBuilder: testRequestBuilder,
    runtime: runtime(),
  });
}

function fixtureBootstrapHarness() {
  const store = new InMemoryWorkflowRunStore();
  const baseAdapter = createFixtureAdapter({
    modelId: "fixture-bootstrap-model",
    developerFamily: "fixture",
    baseFamily: "fixture",
    fixtures: {},
  });
  let providerCalls = 0;
  const adapter: StructuredGenerationAdapter = {
    identity: baseAdapter.identity,
    async generate(request) {
      providerCalls += 1;
      return baseAdapter.generate(request);
    },
  };
  const service = new RunService({
    store,
    primaryAdapter: adapter,
    reviewerAdapter: adapter,
    evidenceMode: "fixture",
    requestBuilder: testRequestBuilder,
    runtime: runtime(),
  });
  return { service, store, providerCalls: () => providerCalls };
}

function scopeDecision(decidedAt: string) {
  return HumanDecisionSchema.parse({
    id: "scope-decision",
    checkpoint: "scope",
    optionsShown: ["approve", "reject"],
    decision: "approve",
    edits: [],
    decidedAt,
    unresolvedObjections: [],
  });
}

function snapshotFrom(
  result: Awaited<ReturnType<RunService["continue"]>>,
): WorkflowRunSnapshot {
  if (!result.advanced) {
    throw new Error(`expected successful continuation: ${JSON.stringify(result.failure)}`);
  }
  return {
    ...result.snapshot,
    objectionDispositions: null,
  };
}

async function advanceUntilNode(
  service: RunService,
  targetNode: string,
): Promise<{ run: ResearchRun; revision: string }> {
  let snapshot = service.create({ intake });
  while (service.progress(snapshot.run.id).currentNode !== targetNode) {
    const result = await service.continue({
      runId: snapshot.run.id,
      expectedRevision: snapshot.revision,
    });
    if (!result.advanced) {
      throw new Error("unexpected fixture failure before target node");
    }
    snapshot = result.snapshot;
    if (snapshot.run.status === "awaiting_scope_approval") {
      snapshot = service.approveScope({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        decision: scopeDecision("2026-08-06T19:30:00.000Z"),
      });
    } else if (snapshot.run.status === "awaiting_packet_approval") {
      snapshot = service.approvePacket({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        packet: goldenRunV01.packet!,
      });
    } else if (
      snapshot.run.status === "awaiting_objection_dispositions"
    ) {
      snapshot = service.submitObjections({
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        decision: goldenRunV01.objectionDispositionDecision!,
        dispositions: goldenRunV01.revision!.decisions.map(
          ({ objectionId, disposition, basis }) => ({
            objectionId,
            disposition,
            basis,
          }),
        ),
      });
    }
  }
  return snapshot;
}

function adapterRuntime(
  transport: AdapterRuntime["transport"],
  namespace = "adapter",
): AdapterRuntime {
  let id = 0;
  let clock = 0;
  return {
    transport,
    now: () =>
      new Date(`2026-08-06T20:00:${String(clock++).padStart(2, "0")}.000Z`),
    monotonicNow: () => clock++ * 10,
    makeId: (prefix) => `${namespace}-${prefix}-${++id}`,
    sleep: async () => {},
  };
}

function providerResponse(model: string, output: unknown): Response {
  return new Response(
    JSON.stringify({
      id: `response-${model}`,
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(output),
            refusal: null,
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function jsonRequest(
  url: string,
  method: "POST" | "GET",
  body?: unknown,
  headers?: HeadersInit,
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("RunService", () => {
  it("accepts only a strict human intent for the final checkpoint", () => {
    const intent = {
      checkpoint: "final",
      expectedRevision: "memory-revision-1",
      decision: {
        choice: "approve",
        declaredActor: "Review lead",
        rationale: "Approve the bounded educational pilot only.",
      },
    };

    expect(CheckpointRequestSchema.safeParse(intent).success).toBe(true);
    expect(
      CheckpointRequestSchema.safeParse({
        ...intent,
        decision: { ...intent.decision, decidedAt: "spoofed" },
      }).success,
    ).toBe(false);
  });

  it("bootstraps a new isolated stored awaiting-final fixture session", () => {
    const service = fixtureService();
    const bootstrap = service.bootstrapFixtureWorkbench();

    expect(bootstrap.snapshot).toMatchObject({
      id: bootstrap.runId,
      schemaVersion: "0.2",
      evidenceMode: "fixture",
      status: "awaiting_final_approval",
      finalDecision: null,
    });
    expect(service.get(bootstrap.runId)).toMatchObject({
      revision: bootstrap.revision,
      run: bootstrap.snapshot,
    });
    expect(CurrentWriterResearchRunSchema.parse(bootstrap.snapshot)).toEqual(
      bootstrap.snapshot,
    );
  });

  it("authors immutable approve and reject receipts without provider effects", () => {
    const { service, store, providerCalls } = fixtureBootstrapHarness();
    const first = service.bootstrapFixtureWorkbench();
    const second = service.bootstrapFixtureWorkbench();

    expect(first.runId).not.toBe(second.runId);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(() => service.export(first.runId)).toThrow(RunServiceBlockedError);

    const intent = {
      choice: "approve" as const,
      declaredActor: "Review lead",
      rationale: "Approve the bounded educational pilot only.",
    };
    const approved = service.decideFinal({
      runId: first.runId,
      expectedRevision: first.revision,
      decision: intent,
    });
    intent.declaredActor = "mutated after submission";
    approved.run.finalDecision!.declaredActor = "mutated response";

    const persistedApproved = service.get(first.runId);
    expect(persistedApproved.run).toMatchObject({
      status: "approved",
      finalDecision: {
        id: "final-decision-3",
        checkpoint: "final",
        optionsShown: ["approve", "reject"],
        decision: "approve",
        edits: [],
        declaredActor: "Review lead",
        rationale: "Approve the bounded educational pilot only.",
        unresolvedObjections: ["gf-objection-degradation"],
      },
    });
    expect(persistedApproved.run.finalDecision!.decidedAt).not.toBe(
      goldenRunV02.finalDecision!.decidedAt,
    );
    expect(service.get(second.runId).run.finalDecision).toBeNull();

    const rejected = service.decideFinal({
      runId: second.runId,
      expectedRevision: second.revision,
      decision: {
        choice: "reject",
        declaredActor: "Independent reviewer",
        rationale: "Reject until the unresolved degradation risk is addressed.",
      },
    });
    expect(rejected.run).toMatchObject({
      status: "rejected",
      finalDecision: { decision: "reject" },
    });

    const firstExport = service.export(first.runId);
    expect(service.export(first.runId)).toBe(firstExport);
    const exported = ResearchRunSchema.parse(JSON.parse(firstExport));
    expect(exported.packet?.fingerprint).toBe(
      goldenRunV02.packet?.fingerprint,
    );
    expect(exported.executions.map(({ id }) => id)).toEqual(
      goldenRunV02.executions.map(({ id }) => id),
    );
    expect(exported.errors.map(({ id }) => id)).toEqual(
      goldenRunV02.errors.map(({ id }) => id),
    );
    expect(
      exported.executions.every(({ evidenceMode }) => evidenceMode === "fixture"),
    ).toBe(true);
    expect(providerCalls()).toBe(0);

    store.reset();
    expect(() => service.get(first.runId)).toThrow(RunNotFoundError);
    expect(() => service.get(second.runId)).toThrow(RunNotFoundError);
  });

  it("rejects accessor and stale or duplicate final intents without state changes", () => {
    const { service } = fixtureBootstrapHarness();
    const bootstrap = service.bootstrapFixtureWorkbench();
    let accessorRead = false;
    const accessorIntent = {
      get choice() {
        accessorRead = true;
        return "approve" as const;
      },
      declaredActor: "Review lead",
      rationale: "Approve the bounded educational pilot only.",
    };

    expect(() =>
      service.decideFinal({
        runId: bootstrap.runId,
        expectedRevision: bootstrap.revision,
        decision: accessorIntent,
      }),
    ).toThrow(/inert plain data object/i);
    expect(accessorRead).toBe(false);
    expect(service.get(bootstrap.runId)).toMatchObject({
      revision: bootstrap.revision,
      run: { status: "awaiting_final_approval", finalDecision: null },
    });

    expect(() =>
      service.decideFinal({
        runId: bootstrap.runId,
        expectedRevision: "memory-revision-stale",
        decision: {
          choice: "approve",
          declaredActor: "Review lead",
          rationale: "Approve the bounded educational pilot only.",
        },
      }),
    ).toThrow(RevisionConflictError);
    const terminal = service.decideFinal({
      runId: bootstrap.runId,
      expectedRevision: bootstrap.revision,
      decision: {
        choice: "approve",
        declaredActor: "Review lead",
        rationale: "Approve the bounded educational pilot only.",
      },
    });
    expect(() =>
      service.decideFinal({
        runId: bootstrap.runId,
        expectedRevision: terminal.revision,
        decision: {
          choice: "reject",
          declaredActor: "Second reviewer",
          rationale: "Attempt to replace the persisted receipt.",
        },
      }),
    ).toThrow();
    expect(service.get(bootstrap.runId)).toEqual(terminal);
  });
  it("creates a history-free draft, returns isolated reads, and reports progress", () => {
    const service = fixtureService();
    const created = service.create({ intake });

    expect(created.run).toMatchObject({
      id: "run-1",
      schemaVersion: "0.1",
      status: "draft",
      evidenceMode: "fixture",
      intake,
      executions: [],
      errors: [],
    });
    expect(created.revision).toBe("memory-revision-1");
    expect(CurrentWriterResearchRunSchema.safeParse(created.run).success).toBe(
      false,
    );

    created.run.intake.originalQuestion = "mutated outside the store";
    const loaded = service.get("run-1");
    expect(loaded.run.intake.originalQuestion).toBe(
      intake.originalQuestion,
    );
    expect(service.progress("run-1")).toEqual({
      runId: "run-1",
      revision: "memory-revision-1",
      status: "draft",
      nextAction: "continue",
      currentNode: "clarify-and-decompose",
      canContinue: true,
      checkpoint: null,
      terminal: false,
      executionCount: 0,
      errorCount: 0,
      lastExecution: null,
      persistence: {
        scope: "process_local",
        survivesCallsWithinProcess: true,
        survivesProcessRestart: false,
        diskDurable: false,
        multiProcessSafe: false,
      },
    });
  });

  it("persists typed node output and advances only after a successful attempt", async () => {
    const service = fixtureService();
    let snapshot = service.create({ intake });

    const continued = await service.continue({
      runId: snapshot.run.id,
      expectedRevision: snapshot.revision,
    });
    expect(continued.advanced).toBe(true);
    if (!continued.advanced) {
      throw new Error("expected a successful continuation");
    }
    snapshot = continued.snapshot;
    expect(snapshot.run.status).toBe("awaiting_scope_approval");
    expect(snapshot.run.claims).toEqual(goldenRunV01.claims);
    expect(snapshot.run.executions).toHaveLength(1);
    expect(snapshot.run.executions[0]).toMatchObject({
      nodeId: "clarify-and-decompose",
      attempt: 1,
      status: "succeeded",
      evidenceMode: "fixture",
      inputRefs: ["intake:run-1"],
      outputRefs: goldenRunV01.claims.map(({ id }) => id),
    });

    const scoped = service.approveScope({
      runId: snapshot.run.id,
      expectedRevision: snapshot.revision,
      decision: scopeDecision("2026-08-06T19:30:00.000Z"),
    });
    expect(scoped.run.status).toBe("collecting_sources");
    expect(scoped.run.scopeDecision).toEqual(
      scopeDecision("2026-08-06T19:30:00.000Z"),
    );
  });

  it("preserves a failed provider attempt, retries contiguously, and rejects stale CAS", async () => {
    const service = fixtureService(
      {
        "run-1:clarify-and-decompose:1": {},
        "run-1:clarify-and-decompose:2":
          nodeOutputs["clarify-and-decompose"],
      },
      true,
    );
    const created = service.create({ intake });

    const failed = await service.continue({
      runId: created.run.id,
      expectedRevision: created.revision,
    });
    expect(failed.advanced).toBe(false);
    if (failed.advanced) {
      throw new Error("expected a failed continuation");
    }
    expect(failed.snapshot.run.status).toBe("decomposing");
    expect(failed.snapshot.run.executions).toHaveLength(1);
    expect(failed.snapshot.run.errors).toHaveLength(1);
    expect(failed.failure).toMatchObject({
      kind: "invalid_model_output",
      retryable: true,
    });
    expect(service.progress(failed.snapshot.run.id)).toMatchObject({
      nextAction: "continue",
      canContinue: true,
      currentNode: "clarify-and-decompose",
    });

    await expect(
      service.continue({
        runId: created.run.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ name: "RevisionConflictError" });

    const retried = await service.continue({
      runId: failed.snapshot.run.id,
      expectedRevision: failed.snapshot.revision,
    });
    expect(retried.advanced).toBe(true);
    if (!retried.advanced) {
      throw new Error("expected retry success");
    }
    expect(retried.snapshot.run.executions).toHaveLength(2);
    expect(retried.snapshot.run.executions[1]).toMatchObject({
      attempt: 2,
      retryOfExecutionId:
        retried.snapshot.run.executions[0].id,
      status: "succeeded",
    });
    expect(
      retried.snapshot.run.executions.map(
        ({ promptId, promptVersion, promptHash }) => ({
          promptId,
          promptVersion,
          promptHash,
        }),
      ),
    ).toEqual([
      {
        promptId: "test-clarify-and-decompose",
        promptVersion: "1",
        promptHash: "a".repeat(64),
      },
      {
        promptId: "test-clarify-and-decompose",
        promptVersion: "1",
        promptHash: "a".repeat(64),
      },
    ]);
    expect(retried.snapshot.run.status).toBe(
      "awaiting_scope_approval",
    );
  });

  it("blocks checkpoint-only and final-export states without mutating the run", async () => {
    const service = fixtureService();
    const created = service.create({ intake });
    const continued = await service.continue({
      runId: created.run.id,
      expectedRevision: created.revision,
    });
    if (!continued.advanced) {
      throw new Error("expected success");
    }

    await expect(
      service.continue({
        runId: continued.snapshot.run.id,
        expectedRevision: continued.snapshot.revision,
      }),
    ).rejects.toBeInstanceOf(RunServiceBlockedError);
    expect(() => service.export("run-1")).toThrow(
      RunServiceBlockedError,
    );
    expect(service.get("run-1").revision).toBe(
      continued.snapshot.revision,
    );
  });

  it("round-trips every checkpoint and exports a byte-stable terminal canonical run", async () => {
    const service = fixtureService();
    let publicSnapshot = service.create({ intake });
    publicSnapshot = snapshotFrom(
      await service.continue({
        runId: publicSnapshot.run.id,
        expectedRevision: publicSnapshot.revision,
      }),
    );
    publicSnapshot = service.approveScope({
      runId: publicSnapshot.run.id,
      expectedRevision: publicSnapshot.revision,
      decision: scopeDecision("2026-08-06T19:30:00.000Z"),
    });
    publicSnapshot = snapshotFrom(
      await service.continue({
        runId: publicSnapshot.run.id,
        expectedRevision: publicSnapshot.revision,
      }),
    );
    publicSnapshot = service.approvePacket({
      runId: publicSnapshot.run.id,
      expectedRevision: publicSnapshot.revision,
      packet: goldenRunV01.packet!,
    });

    for (let index = 0; index < 5; index += 1) {
      publicSnapshot = snapshotFrom(
        await service.continue({
          runId: publicSnapshot.run.id,
          expectedRevision: publicSnapshot.revision,
        }),
      );
    }
    expect(publicSnapshot.run.status).toBe(
      "awaiting_objection_dispositions",
    );

    const dispositions = goldenRunV01.revision!.decisions.map(
      ({ objectionId, disposition, basis }) => ({
        objectionId,
        disposition,
        basis,
      }),
    );
    publicSnapshot = service.submitObjections({
      runId: publicSnapshot.run.id,
      expectedRevision: publicSnapshot.revision,
      decision: goldenRunV01.objectionDispositionDecision!,
      dispositions,
    });
    publicSnapshot = snapshotFrom(
      await service.continue({
        runId: publicSnapshot.run.id,
        expectedRevision: publicSnapshot.revision,
      }),
    );
    publicSnapshot = service.decideFinal({
      runId: publicSnapshot.run.id,
      expectedRevision: publicSnapshot.revision,
      decision: {
        choice: "approve",
        declaredActor: "Review lead",
        rationale: "Approve the bounded educational pilot only.",
      },
    });

    expect(publicSnapshot.run.status).toBe("approved");
    const first = service.export(publicSnapshot.run.id);
    const second = service.export(publicSnapshot.run.id);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(false);
    expect(ResearchRunSchema.parse(JSON.parse(first))).toEqual(
      publicSnapshot.run,
    );
  });

  it("persists typed safety abstention and routes directly to human final review", async () => {
    const service = fixtureService({
      "run-1:plan-experiment:1": {
        disposition: "abstained",
        experiment: null,
        abstention: {
          reason:
            "The requested procedure requires hazardous execution and qualified domain review.",
          safetyCategories: ["hazardous", "missing_qualified_review"],
          missingInputs: ["qualified safety review"],
          allowedNextStep:
            "A qualified reviewer may reformulate a non-hazardous educational study.",
        },
      },
    });
    const before = await advanceUntilNode(service, "plan-experiment");
    const planned = await service.continue({
      runId: before.run.id,
      expectedRevision: before.revision,
    });
    expect(planned.advanced).toBe(true);
    if (!planned.advanced) {
      throw new Error("expected typed abstention to persist");
    }
    expect(planned.snapshot.run).toMatchObject({
      status: "awaiting_final_approval",
      experiment: null,
      experimentAbstention: {
        id: expect.stringMatching(/^experiment-abstention-[a-f0-9]{64}$/),
        qualifiedReviewRequired: true,
      },
      review: null,
      revision: null,
    });
    const abstentionId = planned.snapshot.run.experimentAbstention!.id;
    const replayService = fixtureService({
      "run-1:plan-experiment:1": {
        disposition: "abstained",
        experiment: null,
        abstention: {
          reason:
            "The requested procedure requires hazardous execution and qualified domain review.",
          safetyCategories: ["hazardous", "missing_qualified_review"],
          missingInputs: ["qualified safety review"],
          allowedNextStep:
            "A qualified reviewer may reformulate a non-hazardous educational study.",
        },
      },
    });
    const replayBefore = await advanceUntilNode(
      replayService,
      "plan-experiment",
    );
    const replay = await replayService.continue({
      runId: replayBefore.run.id,
      expectedRevision: replayBefore.revision,
    });
    expect(replay.advanced).toBe(true);
    if (!replay.advanced) {
      throw new Error("expected deterministic abstention replay");
    }
    expect(replay.snapshot.run.experimentAbstention?.id).toBe(abstentionId);

    const collisionFixtures = Object.fromEntries(
      Object.entries(nodeOutputs).map(([nodeId, output]) => [
        `run-1:${nodeId}:1`,
        nodeId === "plan-experiment"
          ? {
              disposition: "abstained",
              experiment: null,
              abstention: {
                reason:
                  "The requested procedure requires hazardous execution and qualified domain review.",
                safetyCategories: ["hazardous", "missing_qualified_review"],
                missingInputs: ["qualified safety review"],
                allowedNextStep:
                  "A qualified reviewer may reformulate a non-hazardous educational study.",
              },
            }
          : output,
      ]),
    );
    const collisionBaseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: collisionFixtures,
    });
    const collisionAdapter: StructuredGenerationAdapter = {
      identity: collisionBaseAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        const result = await collisionBaseAdapter.generate(request);
        return request.nodeId === "clarify-and-decompose"
          ? {
              ...result,
              attempts: result.attempts.map((attempt) => ({
                ...attempt,
                id: abstentionId,
              })),
            }
          : result;
      },
    };
    const collisionService = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: collisionAdapter,
      reviewerAdapter: collisionAdapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const collisionBefore = await advanceUntilNode(
      collisionService,
      "plan-experiment",
    );
    await expect(
      collisionService.continue({
        runId: collisionBefore.run.id,
        expectedRevision: collisionBefore.revision,
      }),
    ).rejects.toThrow("experiment abstention identifier collision");
    const terminal = service.decideFinal({
      runId: planned.snapshot.run.id,
      expectedRevision: planned.snapshot.revision,
      decision: {
        choice: "approve",
        declaredActor: "Safety review lead",
        rationale: "Approve the abstention, not the hazardous procedure.",
      },
    });
    expect(terminal.run.status).toBe("approved");
  });

  it("rejects forged planning authority and duplicate or unknown selected-gap evidence", async () => {
    const valid = structuredClone(nodeOutputs["plan-experiment"]);
    const selectedEvidence = valid.experiment.supportingEvidenceCardIds[0]!;
    for (const experiment of [
      { ...valid.experiment, selectedGapId: "forged-gap" },
      { ...valid.experiment, supportingEvidenceCardIds: ["unknown-evidence"] },
      {
        ...valid.experiment,
        supportingEvidenceCardIds: [selectedEvidence, selectedEvidence],
      },
    ]) {
      const service = fixtureService({
        "run-1:plan-experiment:1": {
          disposition: "proposed",
          experiment,
          abstention: null,
        },
      });
      const before = await advanceUntilNode(service, "plan-experiment");
      const result = await service.continue({
        runId: before.run.id,
        expectedRevision: before.revision,
      });
      expect(result).toMatchObject({
        advanced: false,
        failure: { kind: "invalid_model_output" },
      });
    }
  });

  it("blocks same-family adversarial review before any reviewer provider effect", async () => {
    const fixtures = Object.fromEntries(
      Object.entries(nodeOutputs).map(([nodeId, output]) => [
        `run-1:${nodeId}:1`,
        output,
      ]),
    );
    const base = createFixtureAdapter({
      modelId: "same-family-model",
      developerFamily: "same-developer",
      baseFamily: "same-base",
      fixtures,
    });
    let calls = 0;
    const adapter: StructuredGenerationAdapter = {
      identity: base.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        calls += 1;
        return base.generate(request);
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const before = await advanceUntilNode(service, "review-experiment");
    const callsBeforeReview = calls;

    await expect(
      service.continue({
        runId: before.run.id,
        expectedRevision: before.revision,
      }),
    ).rejects.toBeInstanceOf(RunServiceBlockedError);
    expect(calls).toBe(callsBeforeReview);
    expect(service.get(before.run.id)).toEqual(before);
  });

  it("recovers a persisted success by advancing without invoking the adapter twice", async () => {
    class TransitionConflictOnceStore extends InMemoryWorkflowRunStore {
      conflictPending = true;

      override save(
        run: ResearchRun,
        expectedRevision: string,
        dispositions?: Parameters<InMemoryWorkflowRunStore["save"]>[2],
      ) {
        const stored = this.load(run.id);
        if (
          this.conflictPending &&
          stored?.run.status === "decomposing" &&
          run.status === "awaiting_scope_approval" &&
          stored.run.executions.at(-1)?.status === "succeeded"
        ) {
          this.conflictPending = false;
          throw new RevisionConflictError(run.id);
        }
        return super.save(run, expectedRevision, dispositions);
      }
    }

    const store = new TransitionConflictOnceStore();
    const baseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {
        "run-1:clarify-and-decompose:1":
          nodeOutputs["clarify-and-decompose"],
      },
    });
    let calls = 0;
    const adapter: StructuredGenerationAdapter = {
      identity: baseAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        calls += 1;
        return baseAdapter.generate(request);
      },
    };
    const service = new RunService({
      store,
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const created = service.create({ intake });

    await expect(
      service.continue({
        runId: created.run.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const stranded = service.get(created.run.id);
    expect(stranded.run.status).toBe("decomposing");
    expect(stranded.run.executions.at(-1)?.status).toBe("succeeded");
    expect(calls).toBe(1);

    const recovered = await service.continue({
      runId: stranded.run.id,
      expectedRevision: stranded.revision,
    });
    expect(recovered.advanced).toBe(true);
    expect(recovered.snapshot.run.status).toBe(
      "awaiting_scope_approval",
    );
    expect(calls).toBe(1);
  });

  it("serializes same-revision continuation so only one provider effect can run", async () => {
    const baseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {
        "run-1:clarify-and-decompose:1": {},
        "run-1:clarify-and-decompose:2":
          nodeOutputs["clarify-and-decompose"],
      },
    });
    let calls = 0;
    const adapter: StructuredGenerationAdapter = {
      identity: baseAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        calls += 1;
        const result = await baseAdapter.generate(request);
        if (calls !== 1 || result.ok) {
          return result;
        }
        return {
          ...result,
          errors: result.errors.map((error) =>
            RunErrorSchema.parse({ ...error, retryable: true }),
          ),
        };
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const created = service.create({ intake });
    const failed = await service.continue({
      runId: created.run.id,
      expectedRevision: created.revision,
    });
    if (failed.advanced) {
      throw new Error("expected retryable fixture failure");
    }

    const concurrent = await Promise.allSettled([
      service.continue({
        runId: failed.snapshot.run.id,
        expectedRevision: failed.snapshot.revision,
      }),
      service.continue({
        runId: failed.snapshot.run.id,
        expectedRevision: failed.snapshot.revision,
      }),
    ]);
    expect(calls).toBe(2);
    expect(
      concurrent.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = concurrent.find(
      ({ status }) => status === "rejected",
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { name: "RevisionConflictError" },
    });
  });

  it.each([
    [
      "clarify-and-decompose",
      { claims: [] },
    ],
    [
      "collect-sources",
      { sources: [], chunks: [] },
    ],
    [
      "extract-evidence",
      { evidenceCards: [] },
    ],
    [
      "assess-entailment",
      { evidenceCards: [] },
    ],
    [
      "synthesize-conclusions",
      {
        conclusions: [],
        researchGaps: [],
        selectedGapIndex: 0,
      },
    ],
  ] as const)(
    "persists empty %s output as a typed failure without phase advancement",
    async (nodeId, invalidOutput) => {
      const service = fixtureService({
        [`run-1:${nodeId}:1`]: invalidOutput,
      });
      const before = await advanceUntilNode(service, nodeId);
      const result = await service.continue({
        runId: before.run.id,
        expectedRevision: before.revision,
      });

      expect(result.advanced).toBe(false);
      if (result.advanced) {
        throw new Error("expected semantic validation failure");
      }
      expect(result.failure.kind).toBe("invalid_model_output");
      expect(result.snapshot.run.status).toBe(
        before.run.status === "draft" ? "decomposing" : before.run.status,
      );
      expect(result.snapshot.run.executions.at(-1)).toMatchObject({
        nodeId,
        status: "failed",
        validation: { valid: false },
      });
    },
  );

  it("preflights an incoherent multi-attempt chain without partial persistence", async () => {
    const failedAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: { failed: {} },
    });
    const successAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {
        succeeded: nodeOutputs["clarify-and-decompose"],
      },
    });
    const adapter: StructuredGenerationAdapter = {
      identity: failedAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        const failed = await failedAdapter.generate({
          ...request,
          fixtureKey: "failed",
        });
        const succeeded = await successAdapter.generate({
          ...request,
          fixtureKey: "succeeded",
        });
        if (failed.ok || !succeeded.ok) {
          throw new Error("invalid test adapter setup");
        }
        return {
          ok: true,
          value: succeeded.value,
          attempts: [...failed.attempts, ...succeeded.attempts],
          errors: failed.errors,
        };
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const created = service.create({ intake });

    await expect(
      service.continue({
        runId: created.run.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ name: "InvalidExecutionAttemptError" });
    expect(service.get(created.run.id)).toEqual(created);
  });

  it("rejects a successful adapter payload with invalid run cross-references atomically", async () => {
    const fixtures = Object.fromEntries(
      Object.entries(nodeOutputs).map(([nodeId, output]) => [
        `run-1:${nodeId}:1`,
        output,
      ]),
    );
    const baseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures,
    });
    const adapter: StructuredGenerationAdapter = {
      identity: baseAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        const result = await baseAdapter.generate(request);
        if (!result.ok || request.nodeId !== "extract-evidence") {
          return result;
        }
        const value = result.value as {
          evidenceCandidates: readonly Record<string, unknown>[];
        };
        return {
          ...result,
          value: {
            evidenceCandidates: value.evidenceCandidates.map(
              (card: Record<string, unknown>) => ({
                ...card,
                sourceChunkId: "missing-chunk",
              }),
            ),
          } as z.output<Schema>,
        };
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const before = await advanceUntilNode(service, "extract-evidence");

    await expect(
      service.continue({
        runId: before.run.id,
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ name: "InvalidExecutionAttemptError" });
    expect(service.get(before.run.id)).toEqual(before);
  });

  it("rejects forged planning prompt/model/provider identity before hydration", async () => {
    const fixtures = Object.fromEntries(
      Object.entries(nodeOutputs).map(([nodeId, output]) => [
        `run-1:${nodeId}:1`,
        output,
      ]),
    );
    const baseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures,
    });
    const adapter: StructuredGenerationAdapter = {
      identity: baseAdapter.identity,
      async generate<Schema extends z.ZodType>(
        request: StructuredGenerationRequest<Schema>,
      ) {
        const result = await baseAdapter.generate(request);
        if (!result.ok || request.nodeId !== "plan-experiment") {
          return result;
        }
        return {
          ...result,
          attempts: result.attempts.map((attempt) => ({
            ...attempt,
            promptHash: "b".repeat(64),
            requestedModelId: "forged-model",
            returnedProvider: "nvidia_nim" as const,
          })),
        };
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const before = await advanceUntilNode(service, "plan-experiment");

    await expect(
      service.continue({
        runId: before.run.id,
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow("terminal attempt identity does not match");
    expect(service.get(before.run.id)).toEqual(before);
  });

  it("hydrates compact evidence outputs from the actual terminal attempts before refs and persistence", async () => {
    const service = fixtureService();
    const beforeExtraction = await advanceUntilNode(service, "extract-evidence");
    const extracted = snapshotFrom(
      await service.continue({
        runId: beforeExtraction.run.id,
        expectedRevision: beforeExtraction.revision,
      }),
    );
    const extractionAttempt = extracted.run.executions.at(-1)!;
    const extractedCards = structuredClone(extracted.run.evidenceCards);

    expect(extractionAttempt.outputRefs).toEqual(
      extractedCards.map(({ id }) => id),
    );
    for (const [index, card] of extractedCards.entries()) {
      const fixtureCard = goldenRunV01.evidenceCards[index];
      expect(card.id).toBe(currentEvidenceId(fixtureCard.id));
      expect(card.relationship).toBe("unresolved");
      expect(card.conclusionStrengthWarning).toBeNull();
      expect(card.deterministicVerification.checkedAt).toBe(
        extractionAttempt.endedAt,
      );
      expect(card.modelAssessment).toMatchObject({
        entailment: "unclear",
        rationale:
          "No entailment assessment has occurred; this is an extraction-only sentinel.",
        provider: extractionAttempt.requestedProvider,
        requestedModelId: extractionAttempt.requestedModelId,
        returnedModelId: extractionAttempt.returnedModelId,
        promptId: extractionAttempt.promptId,
        promptVersion: extractionAttempt.promptVersion,
        executionId: extractionAttempt.id,
      });
      expect(card.humanReview).toEqual({
        status: "unreviewed",
        reason: null,
        reviewedAt: null,
        reviewerId: null,
      });
    }

    const assessed = snapshotFrom(
      await service.continue({
        runId: extracted.run.id,
        expectedRevision: extracted.revision,
      }),
    );
    const assessmentAttempt = assessed.run.executions.at(-1)!;
    for (const [index, card] of assessed.run.evidenceCards.entries()) {
      const applicationOwnedFields = (value: typeof card) =>
        Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              ![
                "relationship",
                "modelAssessment",
                "conclusionStrengthWarning",
              ].includes(key),
          ),
        );
      const priorApplicationOwnedFields = applicationOwnedFields(
        extractedCards[index],
      );
      const nextApplicationOwnedFields = applicationOwnedFields(card);
      expect(nextApplicationOwnedFields).toEqual(priorApplicationOwnedFields);
      expect(card.relationship).toBe(goldenRunV01.evidenceCards[index].relationship);
      expect(card.modelAssessment).toMatchObject({
        entailment: goldenRunV01.evidenceCards[index].modelAssessment.entailment,
        rationale: goldenRunV01.evidenceCards[index].modelAssessment.rationale,
        provider: assessmentAttempt.requestedProvider,
        executionId: assessmentAttempt.id,
      });
      expect(card.modelAssessment.rationale).not.toContain(
        "No entailment assessment has occurred",
      );
    }
    expect(ResearchRunSchema.parse(assessed.run)).toEqual(assessed.run);
  });

  it("derives stable evidence IDs on deterministic replay", () => {
    const attempt = goldenRunV01.executions.find(
      ({ nodeId }) => nodeId === "extract-evidence",
    )!;
    const output = nodeOutputs["extract-evidence"];

    const first = materializeEvidenceNodeOutput(
      goldenRunV01,
      "extract-evidence",
      output,
      attempt,
    );
    const replay = materializeEvidenceNodeOutput(
      goldenRunV01,
      "extract-evidence",
      structuredClone(output),
      structuredClone(attempt),
    );

    expect(replay.evidenceCards.map(({ id }) => id)).toEqual(
      first.evidenceCards.map(({ id }) => id),
    );
    expect(first.evidenceCards.map(({ id }) => id)).toEqual(
      goldenRunV01.evidenceCards.map(({ id }) => currentEvidenceId(id)),
    );
  });

  it("rejects non-literal excerpts and duplicate extraction candidates", () => {
    const attempt = goldenRunV01.executions.find(
      ({ nodeId }) => nodeId === "extract-evidence",
    )!;
    const candidate = nodeOutputs["extract-evidence"].evidenceCandidates[0];

    expect(() =>
      materializeEvidenceNodeOutput(
        goldenRunV01,
        "extract-evidence",
        {
          evidenceCandidates: [
            { ...candidate, excerpt: "not a literal source passage" },
          ],
        },
        attempt,
      ),
    ).toThrow("literal-passage validation");
    expect(() =>
      materializeEvidenceNodeOutput(
        goldenRunV01,
        "extract-evidence",
        { evidenceCandidates: [candidate, structuredClone(candidate)] },
        attempt,
      ),
    ).toThrow("duplicate evidence candidate");
  });

  it("materializes compact synthesis semantics into deterministic evidence and gap governance", () => {
    const run: ResearchRun = structuredClone(goldenRunV01);
    run.evidenceCards = run.evidenceCards.map((card) => ({
      ...card,
      id: currentEvidenceId(card.id),
    }));
    const attempt = goldenRunV01.executions.find(
      ({ nodeId }) => nodeId === "synthesize-conclusions",
    )!;
    const compact = structuredClone(nodeOutputs["synthesize-conclusions"]);

    const first = materializeSynthesisNodeOutput(run, compact, attempt);
    const replay = materializeSynthesisNodeOutput(
      structuredClone(run),
      structuredClone(compact),
      structuredClone(attempt),
    );

    expect(replay).toEqual(first);
    expect(first.conclusions).toHaveLength(run.claims.length);
    for (const [index, conclusion] of first.conclusions.entries()) {
      expect(conclusion).toMatchObject(compact.conclusions[index]!);
      expect(conclusion.supportingEvidenceCardIds).toEqual(
        run.evidenceCards
          .filter(
            (card) =>
              card.subclaimId === conclusion.subclaimId &&
              card.relationship === "supports",
          )
          .map(({ id }) => id),
      );
      expect(conclusion.contradictingEvidenceCardIds).toEqual(
        run.evidenceCards
          .filter(
            (card) =>
              card.subclaimId === conclusion.subclaimId &&
              card.relationship === "contradicts",
          )
          .map(({ id }) => id),
      );
      expect(conclusion.humanReviewStatus).toBe("unreviewed");
    }
    const unresolvedId = run.evidenceCards.find(
      ({ relationship }) => relationship === "unresolved",
    )?.id;
    expect(
      first.conclusions.flatMap(
        ({ supportingEvidenceCardIds, contradictingEvidenceCardIds }) => [
          ...supportingEvidenceCardIds,
          ...contradictingEvidenceCardIds,
        ],
      ),
    ).not.toContain(unresolvedId);
    expect(first.researchGaps).toEqual(
      compact.researchGaps.map((gap, index) => ({
        ...gap,
        id: `gap-${canonicalSha256(gap)}`,
        rank: index + 1,
        selection:
          index === compact.selectedGapIndex ? "selected" : "unselected",
      })),
    );
    expect(first.selectedGapId).toBe(
      first.researchGaps[compact.selectedGapIndex]!.id,
    );
    expect(
      ResearchRunSchema.parse({
        ...run,
        conclusions: first.conclusions,
        researchGaps: first.researchGaps,
        selectedGapId: first.selectedGapId,
      }),
    ).toBeTruthy();
  });

  it("sends only the compact bounded synthesis schema to the provider", async () => {
    const fixtures: Record<string, unknown> = {};
    for (const [nodeId, output] of Object.entries(nodeOutputs)) {
      fixtures[`run-1:${nodeId}:1`] = output;
    }
    const baseAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures,
    });
    let synthesisSchema: Readonly<Record<string, unknown>> | null = null;
    const adapter: StructuredGenerationAdapter = {
      identity: baseAdapter.identity,
      async generate(request) {
        if (request.nodeId === "synthesize-conclusions") {
          synthesisSchema = structuredClone(request.outputJsonSchema);
        }
        return baseAdapter.generate(request);
      },
    };
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: adapter,
      reviewerAdapter: adapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const before = await advanceUntilNode(service, "synthesize-conclusions");
    const result = await service.continue({
      runId: before.run.id,
      expectedRevision: before.revision,
    });

    expect(result.advanced).toBe(true);
    expect(synthesisSchema).not.toBeNull();
    const properties = (
      synthesisSchema as unknown as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.keys(properties).sort()).toEqual([
      "conclusions",
      "researchGaps",
      "selectedGapIndex",
    ]);
    const providerShape = synthesisSchema as unknown as {
      properties: {
        conclusions: {
          minItems: number;
          maxItems: number;
          items: { properties: { subclaimId: { enum: string[] } } };
        };
        researchGaps: {
          items: {
            properties: {
              affectedSubclaimIds: {
                maxItems: number;
                items: { enum: string[] };
              };
              evidenceCardIds: {
                maxItems: number;
                items: { enum: string[] };
              };
            };
          };
        };
      };
    };
    expect(providerShape.properties.conclusions).toMatchObject({
      minItems: goldenRunV01.claims.length,
      maxItems: goldenRunV01.claims.length,
    });
    expect(
      providerShape.properties.conclusions.items.properties.subclaimId
        .enum,
    ).toEqual(goldenRunV01.claims.map(({ id }) => id));
    expect(
      providerShape.properties.researchGaps.items.properties
        .affectedSubclaimIds.items.enum,
    ).toEqual(goldenRunV01.claims.map(({ id }) => id));
    expect(
      providerShape.properties.researchGaps.items.properties
        .affectedSubclaimIds,
    ).toMatchObject({ maxItems: goldenRunV01.claims.length });
    expect(
      providerShape.properties.researchGaps.items.properties
        .evidenceCardIds.items.enum,
    ).toEqual(goldenRunV01.evidenceCards.map(({ id }) => currentEvidenceId(id)));
    expect(
      providerShape.properties.researchGaps.items.properties
        .evidenceCardIds,
    ).toMatchObject({ maxItems: goldenRunV01.evidenceCards.length });
    const serialized = JSON.stringify(synthesisSchema);
    expect(serialized).toContain('"pattern"');
    expect(serialized).not.toContain("supportingEvidenceCardIds");
    expect(serialized).not.toContain("contradictingEvidenceCardIds");
    expect(serialized).not.toContain("humanReviewStatus");
    expect(serialized).not.toContain("selectedGapId");
    expect(serialized).not.toContain('"rank"');
    expect(serialized).not.toContain('"selection"');

    const approvedRunForSynthesis: ResearchRun = structuredClone(
      goldenRunV01,
    );
    approvedRunForSynthesis.evidenceCards =
      approvedRunForSynthesis.evidenceCards.map((card) => ({
        ...card,
        id: currentEvidenceId(card.id),
      }));
    const maxConclusion = {
      subclaimId: "",
      strength: "insufficient" as const,
      conclusion: "~".repeat(180),
      disagreementSummary: "~".repeat(120),
      limitations: ["~".repeat(100), "~".repeat(100)],
      changeEvidence: ["~".repeat(100), "~".repeat(100)],
      overclaimingWarnings: ["~".repeat(100), "~".repeat(100)],
    };
    const maxValidApprovedLiveResponse = {
      conclusions: approvedRunForSynthesis.claims.map(({ id }) => ({
        ...maxConclusion,
        subclaimId: id,
      })),
      researchGaps: Array.from({ length: 3 }, (_, index) => ({
        affectedSubclaimIds: approvedRunForSynthesis.claims.map(
          ({ id }) => id,
        ),
        type: "measurement_inconsistency" as const,
        impactRationale: String.fromCharCode(120 + index).repeat(160),
        tractabilityRationale: String.fromCharCode(65 + index).repeat(160),
        evidenceCardIds: approvedRunForSynthesis.evidenceCards.map(
          ({ id }) => id,
        ),
      })),
      selectedGapIndex: 2,
    };
    expect(
      z.fromJSONSchema(synthesisSchema!).parse(
        maxValidApprovedLiveResponse,
      ),
    ).toEqual(maxValidApprovedLiveResponse);
    for (const expandingCharacter of ["\u0000", '"', "\\", "\ud800"]) {
      expect(() =>
        z.fromJSONSchema(synthesisSchema!).parse({
          ...maxValidApprovedLiveResponse,
          conclusions: maxValidApprovedLiveResponse.conclusions.map(
            (conclusion, index) =>
              index === 0
                ? {
                    ...conclusion,
                    conclusion: `unsafe${expandingCharacter}text`,
                  }
                : conclusion,
          ),
        }),
      ).toThrow();
    }
    const synthesisAttempt = approvedRunForSynthesis.executions.find(
      ({ nodeId }) => nodeId === "synthesize-conclusions",
    )!;
    expect(
      materializeSynthesisNodeOutput(
        approvedRunForSynthesis,
        maxValidApprovedLiveResponse,
        synthesisAttempt,
      ).researchGaps,
    ).toHaveLength(3);
    const serializedMaximum = JSON.stringify(
      maxValidApprovedLiveResponse,
    );
    // This ceiling is proven only for the approved live golden run. The
    // dynamic schema intentionally supports other contract-valid run sizes.
    expect(serializedMaximum.length).toBe(6_422);
    expect(serializedMaximum).not.toContain("\\");
    expect(serializedMaximum.length).toBeLessThanOrEqual(7_200);
    expect(Math.ceil(serializedMaximum.length / 4)).toBe(1_606);
    expect(Math.ceil(serializedMaximum.length / 4)).toBeLessThan(2_048);
  });

  it("builds synthesis validation from every contract-valid run ID and claim count", () => {
    const run: ResearchRun = structuredClone(goldenRunV01);
    const longClaimId = `claim-${"x".repeat(256)}`;
    const longEvidenceId = `evidence-${"y".repeat(256)}`;
    run.claims = [
      ...run.claims,
      { ...run.claims[0]!, id: "claim-four" },
      { ...run.claims[0]!, id: longClaimId },
    ];
    run.evidenceCards = [
      ...run.evidenceCards,
      {
        ...run.evidenceCards[0]!,
        id: longEvidenceId,
        subclaimId: longClaimId,
      },
    ];
    const compact = {
      conclusions: run.claims.map(({ id }) => ({
        subclaimId: id,
        strength: "insufficient" as const,
        conclusion: "Bounded conclusion.",
        disagreementSummary: null,
        limitations: [],
        changeEvidence: [],
        overclaimingWarnings: [],
      })),
      researchGaps: [
        {
          affectedSubclaimIds: [longClaimId],
          type: "absent_control" as const,
          impactRationale: "The control is required.",
          tractabilityRationale: "The control is feasible.",
          evidenceCardIds: [longEvidenceId],
        },
      ],
      selectedGapIndex: 0,
    };
    const attempt = run.executions.find(
      ({ nodeId }) => nodeId === "synthesize-conclusions",
    )!;

    expect(
      materializeSynthesisNodeOutput(run, compact, attempt).conclusions,
    ).toHaveLength(5);
  });

  it("rejects incomplete, duplicate, unknown, forged, or out-of-bounds synthesis output", () => {
    const run: ResearchRun = structuredClone(goldenRunV01);
    run.evidenceCards = run.evidenceCards.map((card) => ({
      ...card,
      id: currentEvidenceId(card.id),
    }));
    const attempt = goldenRunV01.executions.find(
      ({ nodeId }) => nodeId === "synthesize-conclusions",
    )!;
    const compact = structuredClone(nodeOutputs["synthesize-conclusions"]);
    const invalidOutputs: unknown[] = [
      { ...compact, conclusions: compact.conclusions.slice(1) },
      {
        ...compact,
        conclusions: [compact.conclusions[0], compact.conclusions[0]],
      },
      {
        ...compact,
        conclusions: [
          { ...compact.conclusions[0], subclaimId: "unknown-claim" },
          ...compact.conclusions.slice(1),
        ],
      },
      {
        ...compact,
        researchGaps: [
          {
            ...compact.researchGaps[0],
            evidenceCardIds: ["unknown-evidence"],
          },
        ],
      },
      {
        ...compact,
        researchGaps: [
          {
            ...compact.researchGaps[0],
            affectedSubclaimIds: [
              compact.researchGaps[0].affectedSubclaimIds[0],
              compact.researchGaps[0].affectedSubclaimIds[0],
            ],
          },
        ],
      },
      {
        ...compact,
        researchGaps: [
          {
            ...compact.researchGaps[0],
            evidenceCardIds: [
              compact.researchGaps[0].evidenceCardIds[0],
              compact.researchGaps[0].evidenceCardIds[0],
            ],
          },
        ],
      },
      {
        ...compact,
        researchGaps: [compact.researchGaps[0], compact.researchGaps[0]],
      },
      { ...compact, selectedGapIndex: compact.researchGaps.length },
      {
        ...compact,
        conclusions: [
          {
            ...compact.conclusions[0],
            humanReviewStatus: "confirmed",
          },
        ],
      },
      {
        ...compact,
        researchGaps: [
          { ...compact.researchGaps[0], id: "forged-gap", rank: 1 },
        ],
      },
    ];

    for (const invalid of invalidOutputs) {
      expect(() =>
        materializeSynthesisNodeOutput(run, invalid, attempt),
      ).toThrow();
    }
  });

  it.each(["source", "chunk"] as const)(
    "rejects denied %s rights during application materialization",
    (boundary) => {
      const run = structuredClone(goldenRunV01);
      if (boundary === "source") {
        run.sources[0].rights.maySendToModel = "denied";
      } else {
        run.chunks[0].displayPermission = "denied";
      }
      const attempt = goldenRunV01.executions.find(
        ({ nodeId }) => nodeId === "extract-evidence",
      )!;

      expect(() =>
        materializeEvidenceNodeOutput(
          run,
          "extract-evidence",
          {
            evidenceCandidates: [
              nodeOutputs["extract-evidence"].evidenceCandidates[0],
            ],
          },
          attempt,
        ),
      ).toThrow("packet, rights, or literal-passage validation");
    },
  );

  it("rejects duplicate or missing entailment deltas without changing materialized evidence", async () => {
    const invalidDeltas = structuredClone(
      nodeOutputs["assess-entailment"].entailmentDeltas,
    );
    invalidDeltas[1] = structuredClone(invalidDeltas[0]);
    const service = fixtureService({
      "run-1:assess-entailment:1": { entailmentDeltas: invalidDeltas },
    });
    const before = await advanceUntilNode(service, "assess-entailment");
    const result = await service.continue({
      runId: before.run.id,
      expectedRevision: before.revision,
    });

    expect(result.advanced).toBe(false);
    expect(result.failure).toMatchObject({
      kind: "invalid_model_output",
      nodeId: "assess-entailment",
    });
    expect(result.snapshot.run.evidenceCards).toEqual(
      before.run.evidenceCards,
    );
    expect(result.snapshot.run.status).toBe("verifying_evidence");
  });

  it("rejects adapter evidence-mode mismatches before changing canonical state", async () => {
    const fixtureAdapter = createFixtureAdapter({
      modelId: "fixture-model",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {
        "run-1:clarify-and-decompose:1":
          nodeOutputs["clarify-and-decompose"],
      },
    });
    const liveRun = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: fixtureAdapter,
      reviewerAdapter: fixtureAdapter,
      evidenceMode: "live",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const created = liveRun.create({ intake });

    await expect(
      liveRun.continue({
        runId: created.run.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ name: "InvalidExecutionAttemptError" });
    expect(liveRun.get(created.run.id)).toEqual(created);

    const liveAdapter = createGroqAdapter(
      {
        apiKey: ["mocked", "credential"].join("-"),
        modelId: "openai/gpt-oss-120b",
        developerFamily: "openai",
        baseFamily: "gpt-oss",
        evidenceMode: "live",
      },
      adapterRuntime(async () =>
        providerResponse(
          "openai/gpt-oss-120b",
          nodeOutputs["clarify-and-decompose"],
        ),
      ),
    );
    const fixtureRun = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: liveAdapter,
      reviewerAdapter: liveAdapter,
      evidenceMode: "fixture",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });
    const fixtureCreated = fixtureRun.create({ intake });
    await expect(
      fixtureRun.continue({
        runId: fixtureCreated.run.id,
        expectedRevision: fixtureCreated.revision,
      }),
    ).rejects.toMatchObject({ name: "InvalidExecutionAttemptError" });
    expect(fixtureRun.get(fixtureCreated.run.id)).toEqual(
      fixtureCreated,
    );
  });

  it("uses the same contract through real Groq and NVIDIA adapters with mocked transport", async () => {
    const credential = ["mocked", "provider", "credential"].join("-");
    const groqTransport: AdapterRuntime["transport"] = async (
      _url,
      init,
    ) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(body.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(credential);
      const envelope = JSON.parse(body.messages.at(-1)!.content) as {
        nodeId: keyof typeof nodeOutputs;
      };
      return providerResponse(
        "openai/gpt-oss-120b",
        nodeOutputs[envelope.nodeId],
      );
    };
    const nvidiaTransport: AdapterRuntime["transport"] = async (
      _url,
      init,
    ) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(body.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(credential);
      return providerResponse(
        "nvidia/nemotron-3-super-120b-a12b",
        nodeOutputs["review-experiment"],
      );
    };
    const primary = createGroqAdapter(
      {
        apiKey: credential,
        modelId: "openai/gpt-oss-120b",
        developerFamily: "openai",
        baseFamily: "gpt-oss",
        evidenceMode: "mocked",
      },
      adapterRuntime(groqTransport, "groq"),
    );
    const reviewer = createNvidiaAdapter(
      {
        apiKey: credential,
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        developerFamily: "nvidia",
        baseFamily: "nemotron-3",
        evidenceMode: "mocked",
      },
      adapterRuntime(nvidiaTransport, "nvidia"),
    );
    const service = new RunService({
      store: new InMemoryWorkflowRunStore(),
      primaryAdapter: primary,
      reviewerAdapter: reviewer,
      evidenceMode: "mocked",
      requestBuilder: testRequestBuilder,
      runtime: runtime(),
    });

    let snapshot = await advanceUntilNode(
      service,
      "review-experiment",
    );
    const reviewed = await service.continue({
      runId: snapshot.run.id,
      expectedRevision: snapshot.revision,
    });
    expect(reviewed.advanced).toBe(true);
    if (!reviewed.advanced) {
      throw new Error("expected mocked NVIDIA success");
    }
    snapshot = reviewed.snapshot;
    expect(snapshot.run.status).toBe(
      "awaiting_objection_dispositions",
    );
    expect(
      new Set(
        snapshot.run.executions.map(({ evidenceMode }) => evidenceMode),
      ),
    ).toEqual(new Set(["mocked"]));
    expect(
      snapshot.run.executions.map(({ requestedProvider }) =>
        requestedProvider,
      ),
    ).toContain("groq");
    expect(snapshot.run.executions.at(-1)?.requestedProvider).toBe(
      "nvidia_nim",
    );
    expect(ResearchRunSchema.parse(snapshot.run)).toEqual(snapshot.run);
  });
});

describe("run Route Handlers", () => {
  it("applies JSON media and body-size limits to fixture bootstrap", async () => {
    const { service } = fixtureBootstrapHarness();
    const unsupported = await handleBootstrapFixtureWorkbench(
      new Request("http://localhost/api/runs/fixture-workbench", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      service,
    );
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );

    const oversized = await handleBootstrapFixtureWorkbench(
      jsonRequest(
        "http://localhost/api/runs/fixture-workbench",
        "POST",
        {},
        { "content-length": String(300 * 1024) },
      ),
      service,
    );
    expect(oversized.status).toBe(413);
    expect(service.bootstrapFixtureWorkbench().runId).toBe(
      "fixture-workbench-1",
    );
  });

  it("serves a strict private fixture bootstrap and server-authored final receipt", async () => {
    const { service, providerCalls } = fixtureBootstrapHarness();
    const rejectedExtra = await handleBootstrapFixtureWorkbench(
      jsonRequest("http://localhost/api/runs/fixture-workbench", "POST", {
        run: goldenRunV02,
      }),
      service,
    );
    expect(rejectedExtra.status).toBe(422);
    expect(rejectedExtra.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );

    const response = await handleBootstrapFixtureWorkbench(
      jsonRequest("http://localhost/api/runs/fixture-workbench", "POST", {}),
      service,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const bootstrap = FixtureWorkbenchBootstrapResponseSchema.parse(
      await response.json(),
    );
    expect(response.headers.get("location")).toBe(
      `/api/runs/${bootstrap.runId}`,
    );
    expect(bootstrap.disclosure).toMatchObject({
      evidenceMode: "fixture",
      sourceFixtureId: "golden-biodegradable-sensor-72h-v0.2",
      persistence: {
        scope: "process_local",
        survivesProcessRestart: false,
        multiProcessSafe: false,
      },
    });
    const read = await handleGetRun(
      new Request(`http://localhost/api/runs/${bootstrap.runId}`),
      { params: Promise.resolve({ runId: bootstrap.runId }) },
      service,
    );
    expect(await read.json()).toEqual({
      run: bootstrap.snapshot,
      revision: bootstrap.revision,
    });

    const spoof = await handleCheckpoint(
      jsonRequest(
        `http://localhost/api/runs/${bootstrap.runId}/checkpoints`,
        "POST",
        {
          checkpoint: "final",
          expectedRevision: bootstrap.revision,
          decision: {
            choice: "approve",
            declaredActor: "Review lead",
            rationale: "Approve the bounded educational pilot only.",
            id: "client-authored-id",
          },
        },
      ),
      { params: Promise.resolve({ runId: bootstrap.runId }) },
      service,
    );
    expect(spoof.status).toBe(422);
    expect(JSON.stringify(await spoof.json())).not.toContain("Review lead");
    expect(service.get(bootstrap.runId).revision).toBe(bootstrap.revision);

    const stale = await handleCheckpoint(
      jsonRequest(
        `http://localhost/api/runs/${bootstrap.runId}/checkpoints`,
        "POST",
        {
          checkpoint: "final",
          expectedRevision: "memory-revision-stale",
          decision: {
            choice: "approve",
            declaredActor: "Review lead",
            rationale: "Approve the bounded educational pilot only.",
          },
        },
      ),
      { params: Promise.resolve({ runId: bootstrap.runId }) },
      service,
    );
    expect(stale.status).toBe(409);
    expect(service.get(bootstrap.runId).revision).toBe(bootstrap.revision);

    const final = await handleCheckpoint(
      jsonRequest(
        `http://localhost/api/runs/${bootstrap.runId}/checkpoints`,
        "POST",
        {
          checkpoint: "final",
          expectedRevision: bootstrap.revision,
          decision: {
            choice: "approve",
            declaredActor: "Review lead",
            rationale: "Approve the bounded educational pilot only.",
          },
        },
      ),
      { params: Promise.resolve({ runId: bootstrap.runId }) },
      service,
    );
    expect(final.status).toBe(200);
    expect(final.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect((await final.json()).run.finalDecision).toMatchObject({
      id: "final-decision-2",
      decidedAt: expect.any(String),
      declaredActor: "Review lead",
      rationale: "Approve the bounded educational pilot only.",
      unresolvedObjections: ["gf-objection-degradation"],
    });
    expect(providerCalls()).toBe(0);
  });

  it("rejects malformed, unknown-key, and oversized bodies with stable typed envelopes", async () => {
    const service = fixtureService();

    const unsupported = await handleCreateRun(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      service,
    );
    expect(unsupported.status).toBe(415);
    expect(
      ApiProblemSchema.parse(await unsupported.json()).error.code,
    ).toBe("unsupported_media_type");

    const malformed = await handleCreateRun(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      service,
    );
    expect(malformed.status).toBe(400);
    expect(ApiProblemSchema.parse(await malformed.json()).error.code).toBe(
      "invalid_json",
    );

    const unknown = await handleCreateRun(
      jsonRequest("http://localhost/api/runs", "POST", {
        expectedRevision: null,
        intake,
        unexpected: true,
      }),
      service,
    );
    expect(unknown.status).toBe(422);
    expect(ApiProblemSchema.parse(await unknown.json()).error.code).toBe(
      "invalid_request",
    );

    const oversized = await handleCreateRun(
      jsonRequest(
        "http://localhost/api/runs",
        "POST",
        { intake },
        { "content-length": String(300 * 1024) },
      ),
      service,
    );
    expect(oversized.status).toBe(413);
    expect(
      ApiProblemSchema.parse(await oversized.json()).error.code,
    ).toBe("request_too_large");

    let canceled = false;
    const declaredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        canceled = true;
      },
    });
    const declaredOversized = await handleCreateRun(
      new Request(
        "http://localhost/api/runs",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(300 * 1024),
          },
          body: declaredStream,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      ),
      service,
    );
    expect(declaredOversized.status).toBe(413);
    expect(canceled).toBe(true);

    const actualOversized = await handleCreateRun(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(300 * 1024) }),
      }),
      service,
    );
    expect(actualOversized.status).toBe(413);

    const controller = new AbortController();
    controller.abort();
    const aborted = await handleCreateRun(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }),
      service,
    );
    expect(aborted.status).toBe(400);
  });

  it("awaits Next 16 params and applies no-store to canonical reads", async () => {
    const service = fixtureService();
    const createdResponse = await handleCreateRun(
      jsonRequest("http://localhost/api/runs", "POST", {
        expectedRevision: null,
        intake,
      }),
      service,
    );
    const created = (await createdResponse.json()) as {
      run: ResearchRun;
      revision: string;
    };

    let paramsAwaited = false;
    const params = Promise.resolve({ runId: created.run.id }).then(
      (value) => {
        paramsAwaited = true;
        return value;
      },
    );
    const read = await handleGetRun(
      new Request(`http://localhost/api/runs/${created.run.id}`),
      { params },
      service,
    );
    expect(paramsAwaited).toBe(true);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect((await read.json()).run.id).toBe(created.run.id);

    const invalidId = await handleGetRun(
      new Request("http://localhost/api/runs/not-valid"),
      { params: Promise.resolve({ runId: "../private" }) },
      service,
    );
    expect(invalidId.status).toBe(400);
    expect(ApiProblemSchema.parse(await invalidId.json()).error.code).toBe(
      "invalid_run_id",
    );
  });

  it("maps preserved provider failures and stale conflicts without raw thrown messages", async () => {
    const service = fixtureService({
      "run-1:clarify-and-decompose:1": {},
    });
    const created = service.create({ intake });
    const context = { params: Promise.resolve({ runId: created.run.id }) };

    const failed = await handleContinueRun(
      jsonRequest(
        `http://localhost/api/runs/${created.run.id}/continue`,
        "POST",
        { expectedRevision: created.revision },
      ),
      context,
      service,
    );
    expect(failed.status).toBe(200);
    const failureBody = ContinueRunResponseSchema.parse(
      await failed.json(),
    );
    expect(failureBody).toMatchObject({
      advanced: false,
      snapshot: { run: { id: "run-1", status: "decomposing" } },
      failure: {
        kind: "invalid_model_output",
        retryable: false,
      },
    });
    expect(JSON.stringify(failureBody)).not.toContain("private-sentinel");
    expect(service.progress(created.run.id)).toMatchObject({
      nextAction: "blocked",
      canContinue: false,
    });

    const conflict = await handleCheckpoint(
      jsonRequest(
        `http://localhost/api/runs/${created.run.id}/checkpoints`,
        "POST",
        {
          checkpoint: "scope",
          expectedRevision: created.revision,
          decision: scopeDecision("2026-08-06T19:31:00.000Z"),
        },
      ),
      context,
      service,
    );
    expect(conflict.status).toBe(409);
    expect(ApiProblemSchema.parse(await conflict.json()).error.code).toBe(
      "revision_conflict",
    );
  });

  it("serves deterministic canonical JSON exports with explicit cache and content type", async () => {
    const fakeService = {
      export: () => JSON.stringify(goldenRunV01),
    } as Pick<RunService, "export">;
    const response = await handleExportRun(
      new Request("http://localhost/api/runs/golden/export"),
      { params: Promise.resolve({ runId: "golden" }) },
      fakeService,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.text()).toBe(JSON.stringify(goldenRunV01));
  });
});
