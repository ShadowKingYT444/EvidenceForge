import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import { buildEvidenceMatrixModel } from "../../src/features/workbench/evidence-matrix-state";
import {
  buildObjectionDispositionModel,
  buildObjectionDispositionScenarioModel,
} from "../../src/features/workbench/objection-disposition-state";

describe("objection disposition and selective revision state", () => {
  it("projects only accepted decisions as before-to-after changes and keeps their cause adjacent", () => {
    const model = buildObjectionDispositionModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
    );

    expect(model).toMatchObject({
      state: "recorded",
      evidenceMode: "fixture",
      persistence: {
        state: "recorded_fixture",
        label: "Recorded fixture · read-only",
      },
    });
    expect(model.state === "recorded" && model.objections[0]).toMatchObject({
      id: "gf-objection-calibration",
      severity: "high",
      targetField: "measurementValidity",
      rationale: goldenRunV01.review!.objections[0]!.rationale,
      decision: {
        disposition: "accepted",
        basis: goldenRunV01.revision!.decisions[0]!.basis,
        originalValue: goldenRunV01.revision!.decisions[0]!.originalValue,
        revisedValue: goldenRunV01.revision!.decisions[0]!.revisedValue,
        residualRisk: goldenRunV01.revision!.decisions[0]!.residualRisk,
        showsChange: true,
      },
    });
    expect(
      model.state === "recorded" &&
        model.objections.filter(({ decision }) => decision?.showsChange).map(({ id }) => id),
    ).toEqual(["gf-objection-calibration"]);
  });

  it("does not imply changes for rejected or unresolved decisions", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.revision!.decisions[0]!.disposition = "rejected";
    run.revision!.decisions[0]!.revisedValue = null;
    const model = buildObjectionDispositionModel(
      run,
      buildEvidenceMatrixModel(run),
    );

    expect(model.state === "recorded" && model.objections[0]!.decision).toMatchObject({
      disposition: "rejected",
      revisedValue: null,
      showsChange: false,
    });
    expect(model.state === "recorded" && model.objections[1]!.decision).toMatchObject({
      disposition: "unresolved",
      revisedValue: null,
      showsChange: false,
    });
  });

  it("keeps an unresolved objection visibly bound through final approval", () => {
    const model = buildObjectionDispositionModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
    );
    const unresolved =
      model.state === "recorded"
        ? model.objections.find(({ id }) => id === "gf-objection-degradation")
        : null;

    expect(unresolved).toMatchObject({
      severity: "critical",
      decision: {
        disposition: "unresolved",
        showsChange: false,
      },
      remainsUnresolvedAtFinal: true,
      finalDecision: "approve",
    });
  });

  it("builds an honest process-local awaiting state without reusing terminal decisions", () => {
    const model = buildObjectionDispositionScenarioModel(
      goldenRunV01,
      buildEvidenceMatrixModel(goldenRunV01),
      {
        runId: "run-1",
        expectedRevision: "revision-7",
      },
    );

    expect(model).toMatchObject({
      state: "awaiting",
      evidenceMode: "simulated",
      persistence: {
        state: "process_local",
        label: "Process-local checkpoint",
        runId: "run-1",
        expectedRevision: "revision-7",
      },
    });
    expect(model.state === "awaiting" && model.objections.every(({ decision }) => decision === null)).toBe(true);
  });

  it("fails closed when an objection cites display-denied evidence", () => {
    const matrix = buildEvidenceMatrixModel(
      goldenRunV01,
      new Map([
        [
          "gf-source-01",
          { state: "hidden" as const, reasonCode: "packet_display_hidden" as const },
        ],
      ]),
    );

    expect(buildObjectionDispositionModel(goldenRunV01, matrix)).toEqual({
      state: "error",
      evidenceMode: "fixture",
      error: {
        code: "objection_evidence_hidden",
        message:
          "An objection cites evidence that is not permitted for display, so dispositions are unavailable.",
      },
      objections: [],
    });
  });

  it("keeps reviewer-authored markup as labeled plain text without an HTML channel", () => {
    const run = structuredClone(goldenRunV01) as ResearchRun;
    run.review!.objections[0]!.rationale =
      '<img src="x" onerror="private-sentinel">';

    const model = buildObjectionDispositionModel(
      run,
      buildEvidenceMatrixModel(run),
    );
    const objection = model.state === "recorded" ? model.objections[0] : null;

    expect(objection).toMatchObject({
      rationale: '<img src="x" onerror="private-sentinel">',
      rationaleTrustLabel: "Untrusted reviewer text · rendered as plain text",
    });
    expect(objection && "html" in objection).toBe(false);
  });
});
