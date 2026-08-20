import { z } from "zod";

import { canonicalSha256, type ResearchRun } from "../../contracts";
import type { StructuredGenerationAdapter, StructuredGenerationResult } from "../models";
import { EvidenceExtractionModelOutputSchema } from "../prompts/registry";
import { providerJsonSchema } from "../workflow/run-api";
import { runResearchWorkerPool } from "./worker-pool";
import type { ResearchConfig } from "./config";

type ExtractionResult = StructuredGenerationResult<typeof EvidenceExtractionModelOutputSchema>;

export type SourceExtractionWorkerValue = {
  sourceId: string;
  generations: ExtractionResult[];
};

export class GenerationFailure extends Error {
  constructor(readonly generation: ExtractionResult, readonly status: number | undefined) {
    super(generation.errors.at(-1)?.message ?? "Source evidence extraction failed");
    this.name = "GenerationFailure";
  }
}

async function generateForSource(input: {
  run: ResearchRun;
  sourceId: string;
  adapter: StructuredGenerationAdapter;
  signal: AbortSignal;
}): Promise<ExtractionResult> {
  const source = input.run.sources.find(({ id }) => id === input.sourceId);
  if (!source || !input.run.packet) throw new Error("Source-scoped extraction requires a frozen source packet");
  const chunks = input.run.chunks.filter(({ sourceId }) => sourceId === input.sourceId);
  if (chunks.length === 0) throw new Error("Source-scoped extraction requires permitted chunks");
  const payload = {
    resolvedScope: { intake: input.run.intake, claims: input.run.claims, scopeDecision: input.run.scopeDecision },
    packetFingerprint: input.run.packet.fingerprint,
    source,
    chunks,
  };
  const messages = [
    {
      role: "system" as const,
      content: "You are one bounded EvidenceForge evidence-extraction worker. Use only the supplied source chunks and approved claims. Return literal candidate excerpts with existing claim and chunk IDs. Do not assess entailment, synthesize conclusions, or invent citations. Return only JSON matching the schema.",
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  const generated = await input.adapter.generate({
    nodeId: `extract-evidence:${input.sourceId}`,
    inputRefs: [input.run.packet.fingerprint, input.sourceId, ...chunks.map(({ id }) => id)],
    outputRefs: [],
    promptId: "source-scoped-evidence-extraction",
    promptVersion: "1.0.0",
    promptHash: canonicalSha256(messages),
    schemaVersion: "source-scoped-evidence-extraction.v1",
    schemaName: "source-scoped-evidence-extraction-output",
    outputSchema: EvidenceExtractionModelOutputSchema,
    outputJsonSchema: providerJsonSchema(z.toJSONSchema(EvidenceExtractionModelOutputSchema)),
    messages,
    settings: { temperature: 0, maxOutputTokens: 1_200, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null },
    timeoutMs: 20_000,
    measured: false,
    repairInvalidOutput: true,
    maximumAttempts: 2,
    codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
    signal: input.signal,
  });
  if (!generated.ok) {
    const error = generated.errors.at(-1);
    throw new GenerationFailure(generated, error?.details.httpStatus ?? (error?.retryable ? 503 : undefined));
  }
  return generated;
}

export async function extractEvidenceSourcesInParallel(input: {
  run: ResearchRun;
  primary: StructuredGenerationAdapter;
  fallback: StructuredGenerationAdapter;
  config?: Partial<ResearchConfig>;
  signal?: AbortSignal;
}) {
  const sources = [...input.run.sources]
    .filter((source) => input.run.chunks.some(({ sourceId }) => sourceId === source.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (sources.length === 0) throw new Error("Parallel extraction requires at least one source with permitted chunks");
  return runResearchWorkerPool(sources.map((source) => ({ id: source.id, query: source.id })), {
    config: { ...input.config, target: sources.length, minimum: 1, candidateCap: Math.max(1, Math.min(30, sources.length)), maxConcurrency: Math.min(6, sources.length || 1), perItemTimeoutMs: 20_000 },
    signal: input.signal,
    worker: async (item, context) => ({ sourceId: item.id, generations: [await generateForSource({ run: input.run, sourceId: item.id, adapter: input.primary, signal: context.signal })] }),
    fallback: async (item, error, context) => {
      const prior = error instanceof GenerationFailure ? [error.generation] : [];
      return { sourceId: item.id, generations: [...prior, await generateForSource({ run: input.run, sourceId: item.id, adapter: input.fallback, signal: context.signal })] };
    },
  });
}
