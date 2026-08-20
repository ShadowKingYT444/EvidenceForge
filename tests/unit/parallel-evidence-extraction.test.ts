import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import type { StructuredGenerationAdapter } from "../../src/server/models";
import { extractEvidenceSourcesInParallel } from "../../src/server/research/live-extraction";
import { assertNodeMayStart } from "../../src/server/workflow/state-machine";
import { materializeEvidenceNodeOutput } from "../../src/server/workflow/run-api";
import { DurableRunCoordinator } from "../../src/server/workflow/durable-coordinator";
import { AsyncWorkflowRunStoreAdapter, InMemoryWorkflowRunStore } from "../../src/server/workflow/store";

function extractionRun(): ResearchRun {
  return { ...structuredClone(goldenRunV02), evidenceMode: "live", status: "extracting_evidence", evidenceCards: [] } as ResearchRun;
}

describe("parallel source evidence extraction", () => {
  it("runs one source-scoped worker per frozen source with stable ordering", async () => {
    const run = extractionRun();
    const adapter = {
      identity: { provider: "groq", modelId: "test-model", developerFamily: "test", baseFamily: "test" },
      generate: async (request: { nodeId: string }) => {
        const sourceId = request.nodeId.replace("extract-evidence:", "");
        const chunk = run.chunks.find((item) => item.sourceId === sourceId)!;
        return {
          ok: true as const,
          value: { evidenceCandidates: [{
            subclaimId: run.claims[0]!.id,
            sourceChunkId: chunk.id,
            excerpt: chunk.text,
            extractedResult: "Source-scoped result",
            settingAndSample: "Bounded source worker",
            studyType: "experimental",
            limitation: "Worker test limitation",
            extractionIssues: [],
          }] },
          attempts: [],
          errors: [],
        };
      },
    } as unknown as StructuredGenerationAdapter;
    const result = await extractEvidenceSourcesInParallel({ run, primary: adapter, fallback: adapter });
    expect(result.results.map(({ itemId }) => itemId)).toEqual([...new Set(run.chunks.map(({ sourceId }) => sourceId))].sort());
    expect(result.results.every(({ status }) => status === "completed")).toBe(true);
  });

  it("accepts source-scoped execution IDs at the extraction lifecycle boundary", () => {
    const run = extractionRun();
    expect(() => assertNodeMayStart(run, `extract-evidence:${run.sources[0]!.id}`)).not.toThrow();
    const card = goldenRunV02.evidenceCards[0]!;
    const attempt = structuredClone(goldenRunV02.executions.find(({ nodeId, status }) => nodeId === "extract-evidence" && status === "succeeded")!);
    const output = materializeEvidenceNodeOutput(run, "extract-evidence", { evidenceCandidates: [{
      subclaimId: card.subclaimId,
      sourceChunkId: card.sourceChunkId,
      excerpt: card.excerpt,
      extractedResult: card.extractedResult,
      settingAndSample: card.settingAndSample,
      studyType: card.studyType,
      limitation: card.limitation,
      extractionIssues: card.extractionIssues,
    }] }, { ...attempt, nodeId: `extract-evidence:${run.sources[0]!.id}` });
    expect(output.evidenceCards).toHaveLength(1);
    expect(output.evidenceCards[0]?.deterministicVerification.status).toBe("verified");
  });

  it("persists source workers and advances the authoritative live run", async () => {
    const run = extractionRun();
    run.conclusions = [];
    run.researchGaps = [];
    run.selectedGapId = null;
    run.experiment = null;
    run.experimentAbstention = null;
    run.review = null;
    run.objectionDispositionDecision = null;
    run.revision = null;
    run.finalDecision = null;
    run.executions = run.executions.filter(({ nodeId }) => nodeId === "clarify-and-decompose");
    run.errors = run.errors.filter(({ nodeId }) => nodeId === "clarify-and-decompose");
    const template = structuredClone(goldenRunV02.executions.find(({ nodeId, status }) => nodeId === "extract-evidence" && status === "succeeded")!);
    const adapter = {
      identity: { provider: "groq", modelId: "test-model", developerFamily: "test", baseFamily: "test" },
      generate: async (request: any) => {
        const sourceId = String(request.nodeId).replace("extract-evidence:", "");
        const chunk = run.chunks.find((item) => item.sourceId === sourceId)!;
        return {
          ok: true as const,
          value: { evidenceCandidates: [{
            subclaimId: run.claims[0]!.id,
            sourceChunkId: chunk.id,
            excerpt: chunk.text,
            extractedResult: "Source-scoped result",
            settingAndSample: "Coordinator worker test",
            studyType: "experimental",
            limitation: "Coordinator test limitation",
            extractionIssues: [],
          }] },
          attempts: [{
            ...template,
            id: `execution-${sourceId}`,
            nodeId: request.nodeId,
            attempt: 1,
            retryOfExecutionId: null,
            inputRefs: request.inputRefs,
            outputRefs: [],
            promptId: request.promptId,
            promptVersion: request.promptVersion,
            promptHash: request.promptHash,
            structuredOutputSchemaVersion: request.schemaVersion,
            generationSettings: request.settings,
            requestedProvider: "groq",
            requestedModelId: "test-model",
            returnedProvider: "groq",
            returnedModelId: "test-model",
            requestedDeveloperFamily: "test",
            returnedDeveloperFamily: "test",
            requestedBaseFamily: "test",
            returnedBaseFamily: "test",
            evidenceMode: "live",
            validation: { valid: true, issues: [] },
            errorIds: [],
          }],
          errors: [],
        };
      },
    } as unknown as StructuredGenerationAdapter;
    const coordinator = new DurableRunCoordinator(
      new AsyncWorkflowRunStoreAdapter(new InMemoryWorkflowRunStore()),
      () => ({ primary: adapter, reviewer: adapter, evidenceMode: "live" }),
    );
    const imported = await coordinator.importSnapshot({ run, revision: "parallel-base", objectionDispositions: null });
    const result = await coordinator.continue(imported.snapshot.run.id, imported.snapshot.revision, imported.accessToken);
    expect(result.value.advanced).toBe(true);
    expect(result.snapshot.run.status).toBe("verifying_evidence");
    expect(result.snapshot.run.evidenceCards).toHaveLength(run.sources.length);
    expect(result.snapshot.run.executions.filter(({ nodeId }) => nodeId.startsWith("extract-evidence:"))).toHaveLength(run.sources.length);
  });
});
