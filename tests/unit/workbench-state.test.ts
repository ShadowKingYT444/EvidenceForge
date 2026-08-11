import { describe, expect, it } from "vitest";

import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import type { ResearchRun } from "../../src/contracts";
import {
  buildWorkbenchModel,
  buildWorkbenchScenarioModel,
  resolveWorkbenchScenario,
  WORKBENCH_SCENARIOS,
} from "../../src/features/workbench/workbench-state";

describe("workbench state model", () => {
  it("maps the immutable golden fixture without inventing counts or decisions", () => {
    const model = buildWorkbenchModel(goldenRunV01);

    expect(model.run).toMatchObject({
      id: goldenRunV01.id,
      schemaVersion: "0.1",
      evidenceMode: "fixture",
      status: "approved",
    });
    expect(model.scope.question).toBe(goldenRunV01.intake.originalQuestion);
    expect(model.claims).toHaveLength(goldenRunV01.claims.length);
    expect(model.matrix).toEqual({
      sourceCount: goldenRunV01.sources.length,
      evidenceCount: goldenRunV01.evidenceCards.length,
      relationshipCounts: {
        supports: 4,
        contradicts: 1,
        unresolved: 2,
      },
      metadataMismatchCount: 1,
    });
    expect(model.experiment.selectedGapId).toBe(goldenRunV01.selectedGapId);
    expect(model.experiment.objective).toBe(goldenRunV01.experiment?.objective);
    expect(model.attention).toMatchObject({
      kind: "provider_failure",
      nodeId: "review-experiment",
    });
    expect(model.finalDecision).toMatchObject({
      state: "approved",
      decision: "approve",
      unresolvedObjectionCount: 1,
    });
  });

  it("keeps fixture, live, mocked, simulated, and unverified provenance explicit", () => {
    const expectations = {
      fixture: "Deterministic reviewed fixture",
      live: "Provider-backed run record",
      mocked: "Mocked dependency record",
      simulated: "Simulated state record",
      unverified: "Evidence provenance unverified",
    } as const;

    for (const [mode, description] of Object.entries(expectations)) {
      const model = buildWorkbenchModel({
        ...goldenRunV01,
        evidenceMode: mode as keyof typeof expectations,
      });
      expect(model.mode.description).toBe(description);
      expect(model.mode.key).toBe(mode);
    }
  });

  it("checks display rights before projecting evidence content", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    const firstCard = run.evidenceCards[0];
    const deniedChunk = run.chunks.find(
      (chunk) => chunk.id === firstCard.sourceChunkId,
    )!;
    const deniedSource = run.sources.find(
      (source) => source.id === deniedChunk.sourceId,
    )!;
    deniedSource.rights.mayDisplay = "denied";
    deniedChunk.displayPermission = "denied";

    const serialized = JSON.stringify(buildWorkbenchModel(run));

    expect(serialized).not.toContain(firstCard.excerpt);
    expect(serialized).not.toContain(deniedChunk.text);
  });

  it("defines every required lifecycle and recovery surface", () => {
    expect(WORKBENCH_SCENARIOS).toEqual([
      "awaiting",
      "collecting",
      "running",
      "partial",
      "fixture",
      "timeout",
      "refusal",
      "invalid-json",
      "invalid-schema",
      "invalid-output",
      "retry-exhausted",
      "retry",
      "source-mismatch",
      "missing-source",
      "reviewer-decision",
      "final-decision",
      "approved",
      "rejected",
      "failed",
      "stale-execution",
    ]);

    for (const scenario of WORKBENCH_SCENARIOS) {
      const presentation = resolveWorkbenchScenario(
        buildWorkbenchModel(goldenRunV01),
        scenario,
      );
      expect(presentation.scenario).toBe(scenario);
      expect(presentation.mode.key).toBe("fixture");
      expect(presentation.disclosure).toContain(
        "Fixture state preview—not a live provider result.",
      );
    }
  });

  it("distinguishes waiting, active work, partial evidence, and human decisions", () => {
    const base = buildWorkbenchModel(goldenRunV01);

    expect(resolveWorkbenchScenario(base, "awaiting").state).toMatchObject({
      status: "awaiting_scope_approval",
      label: "Awaiting scope approval",
      isRunning: false,
    });
    expect(resolveWorkbenchScenario(base, "collecting").state).toMatchObject({
      status: "collecting_sources",
      label: "Collecting approved sources",
      isRunning: true,
    });
    expect(resolveWorkbenchScenario(base, "running").state).toMatchObject({
      status: "verifying_evidence",
      label: "Verifying evidence",
      isRunning: true,
    });
    expect(resolveWorkbenchScenario(base, "partial").state).toMatchObject({
      label: "Partial evidence",
      isRunning: false,
    });
    expect(
      resolveWorkbenchScenario(base, "reviewer-decision").state,
    ).toMatchObject({
      status: "awaiting_objection_dispositions",
      label: "Reviewer decision required",
      isRunning: false,
    });
    expect(resolveWorkbenchScenario(base, "final-decision").state).toMatchObject({
      status: "awaiting_final_approval",
      label: "Final decision required",
      isRunning: false,
    });
  });

  it("renders timeout, refusal, invalid output, and retry as preserved evidence", () => {
    const base = buildWorkbenchModel(goldenRunV01);

    expect(resolveWorkbenchScenario(base, "timeout").attention).toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    expect(resolveWorkbenchScenario(base, "refusal").attention).toMatchObject({
      kind: "provider_refusal",
      retryable: false,
    });
    expect(
      resolveWorkbenchScenario(base, "invalid-output").attention,
    ).toMatchObject({
      kind: "invalid_model_output",
      retryable: true,
    });
    expect(resolveWorkbenchScenario(base, "retry").audit).toMatchObject({
      preservedFailureCount: 2,
      retryCount: 2,
    });
  });

  it("projects every integrated recovery contract with honest provenance and an allowed action", () => {
    const base = buildWorkbenchModel(goldenRunV01);
    const expected = [
      ["timeout", "timeout", "simulated", "Retry this node"],
      ["refusal", "provider_refusal", "simulated", "Revise the request"],
      ["invalid-json", "invalid_model_json", "simulated", "Retry with JSON repair"],
      ["invalid-schema", "invalid_model_output", "simulated", "Retry after schema validation"],
      ["retry-exhausted", "provider_failure", "simulated", "Review the input or provider configuration"],
      ["retry", "provider_failure", "fixture", "Continue from the successful linked retry"],
      ["source-mismatch", "metadata_mismatch", "fixture", "Review the field-level mismatch"],
      ["missing-source", "missing_source", "fixture", "Add or approve another bounded source"],
    ] as const;

    for (const [scenario, kind, evidenceMode, actionPrefix] of expected) {
      const model = resolveWorkbenchScenario(base, scenario);
      expect(model.recovery).toMatchObject({
        kind,
        evidenceMode,
        priorAttemptRetained: true,
      });
      expect(model.recovery?.allowedAction).toMatch(
        new RegExp(`^${actionPrefix}`),
      );
      expect(model.state.isRunning).toBe(false);
      expect(model.audit.activeCount).toBe(0);
    }

    expect(resolveWorkbenchScenario(base, "retry-exhausted").audit).toMatchObject({
      preservedFailureCount: 2,
      retryCount: 1,
    });
    expect(resolveWorkbenchScenario(base, "retry").audit).toMatchObject({
      preservedFailureCount: 2,
      retryCount: 2,
    });
    expect(
      resolveWorkbenchScenario(base, "missing-source").audit.executions[0],
    ).toMatchObject({
      id: "gf-execution-collect-1",
      evidenceMode: "fixture",
      errors: [
        {
          kind: "missing_source",
          providerCode: "DOI_NOT_FOUND",
          httpStatus: "404",
        },
      ],
    });
  });

  it("never promotes rejected or failed terminal states to success", () => {
    const base = buildWorkbenchModel(goldenRunV01);

    expect(resolveWorkbenchScenario(base, "approved").finalDecision.state).toBe(
      "approved",
    );
    expect(resolveWorkbenchScenario(base, "rejected").finalDecision.state).toBe(
      "rejected",
    );
    expect(resolveWorkbenchScenario(base, "failed").finalDecision.state).toBe(
      "failed",
    );
  });

  it("builds the stale-execution preview through the schema-valid run path", () => {
    const model = buildWorkbenchScenarioModel(
      goldenRunV01,
      "stale-execution",
    );

    expect(model.state).toMatchObject({
      status: "approved",
      isRunning: false,
    });
    expect(model.audit).toMatchObject({
      activeCount: 0,
      executions: [
        {
          status: "started",
          statusLabel: "Started (stale open record)",
          isRunning: false,
        },
      ],
    });
  });
});
