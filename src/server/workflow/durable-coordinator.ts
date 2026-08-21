import { createHash } from "node:crypto";

import {
  HumanDecisionSchema,
  NodeExecutionSchema,
  ResearchIntakeSchema,
  ResearchRunSchema,
  freezePacket,
  type ResearchRun,
} from "../../contracts";
import {
  createFeatherlessAdapter,
  createFixtureAdapter,
  createGroqAdapter,
  createNvidiaAdapter,
  type StructuredGenerationAdapter,
} from "../models";
import { readRuntimeEnvironment } from "../environment";
import { createPromptRunNodeRequestBuilder } from "../prompts/render";
import {
  createRunToken,
  digestRunToken,
} from "../auth/run-token";
import {
  persistCollectedSources,
  advanceRun,
  appendExecutionAttempt,
  type HumanDecision,
  type ObjectionDispositionPlan,
} from "./state-machine";
import {
  AsyncWorkflowRunStoreAdapter,
  InMemoryWorkflowRunStore,
  RunNotFoundError,
  type WorkflowRunSnapshot,
  type WorkflowRunStore,
} from "./store";
import { materializeEvidenceNodeOutput, RunService } from "./run-api";
import { extractEvidenceSourcesInParallel, GenerationFailure } from "../research/live-extraction";
import { PacketDraftSchema } from "../sources/packet-draft";

export class RunAccessDeniedError extends Error {
  constructor() {
    super("This private investigation is unavailable or the access token is invalid.");
    this.name = "RunAccessDeniedError";
  }
}

type MutationResult<T> = {
  snapshot: WorkflowRunSnapshot;
  value: T;
};

function tokenSecret(): string {
  const configured = process.env.RUN_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.RENDER
  ) {
    throw new Error("RUN_TOKEN_SECRET is required in production");
  }
  return "evidenceforge-local-development-token-secret";
}

export function configuredResearchAdapters(): {
  primary: StructuredGenerationAdapter;
  reviewer: StructuredGenerationAdapter;
  evidenceMode: ResearchRun["evidenceMode"];
} {
  const environment = readRuntimeEnvironment();
  if (environment.evidenceMode === "fixture") {
    const unavailable = createFixtureAdapter({
      modelId: "provider-not-configured",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {},
    });
    return { primary: unavailable, reviewer: unavailable, evidenceMode: "fixture" };
  }
  const createAdapter = (provider: string, apiKey: string, modelId: string) => {
    if (provider === "groq") {
      return createGroqAdapter({
        apiKey,
        modelId,
        developerFamily: "openai",
        baseFamily: "gpt-oss",
        evidenceMode: "live",
      });
    }
    if (provider === "nvidia_nim") {
      return createNvidiaAdapter({
        apiKey,
        modelId,
        developerFamily: "meta",
        baseFamily: "llama",
        evidenceMode: "live",
      });
    }
    return createFeatherlessAdapter({
      apiKey,
      modelId,
      developerFamily: modelId.toLowerCase().includes("qwen") ? "qwen" : "mistral",
      baseFamily: modelId.toLowerCase().includes("qwen") ? "qwen" : "mistral",
      evidenceMode: "live",
    });
  };
  return {
    primary: createAdapter(
      environment.primary.provider,
      environment.primary.apiKey,
      environment.primary.model,
    ),
    reviewer: createAdapter(
      environment.reviewer.provider,
      environment.reviewer.apiKey,
      environment.reviewer.model,
    ),
    evidenceMode: "live",
  };
}

function timestampAfter(run: ResearchRun): string {
  const now = Date.now();
  const prior = Date.parse(run.updatedAt);
  return new Date(Math.max(now, Number.isFinite(prior) ? prior + 1 : now)).toISOString();
}

function createEphemeralService(store: InMemoryWorkflowRunStore): RunService {
  const adapters = configuredResearchAdapters();
  return new RunService({
    store,
    primaryAdapter: adapters.primary,
    reviewerAdapter: adapters.reviewer,
    evidenceMode: adapters.evidenceMode,
    requestBuilder: createPromptRunNodeRequestBuilder(),
    codeVersion: process.env.RENDER_GIT_COMMIT?.trim() || null,
  });
}

function digest(token: string): string {
  return digestRunToken(token, tokenSecret());
}

export class DurableRunCoordinator {
  constructor(
    readonly store: WorkflowRunStore,
    private readonly researchAdapterFactory: typeof configuredResearchAdapters = configuredResearchAdapters,
  ) {}

  async create(intakeInput: unknown) {
    const accessToken = createRunToken();
    const memory = new InMemoryWorkflowRunStore();
    const service = createEphemeralService(memory);
    const created = service.create({
      intake: ResearchIntakeSchema.parse(intakeInput),
    });
    const snapshot = await this.store.create(created.run, {
      accessTokenDigest: digest(accessToken),
    });
    return { snapshot, accessToken };
  }

  async importSnapshot(snapshotInput: WorkflowRunSnapshot) {
    if (!this.store.importSnapshot) throw new Error("Recovery import is unavailable.");
    const accessToken = createRunToken();
    const sourceRunId = snapshotInput.run.id;
    const runId = `recovered-${crypto.randomUUID()}`;
    const run = ResearchRunSchema.parse({
      ...structuredClone(snapshotInput.run),
      id: runId,
      executions: snapshotInput.run.executions.map((execution) => ({
        ...execution,
        inputRefs: execution.inputRefs.map((reference) => reference === sourceRunId ? runId : reference),
        outputRefs: execution.outputRefs.map((reference) => reference === sourceRunId ? runId : reference),
      })),
    });
    const snapshot = await this.store.importSnapshot({
      run,
      revision: `recovery-${crypto.randomUUID()}`,
      objectionDispositions: structuredClone(snapshotInput.objectionDispositions),
    }, { accessTokenDigest: digest(accessToken) });
    return { snapshot, accessToken, recoveryUrl: `/runs/${encodeURIComponent(runId)}/access?token=${encodeURIComponent(accessToken)}` };
  }

  async authorize(runId: string, accessToken: string) {
    if (!this.store.authorize) throw new RunAccessDeniedError();
    const snapshot = await this.store.authorize(runId, digest(accessToken));
    if (!snapshot) throw new RunAccessDeniedError();
    return snapshot;
  }

  async progress(runId: string, accessToken: string) {
    const snapshot = await this.authorize(runId, accessToken);
    const memory = new InMemoryWorkflowRunStore();
    memory.hydrate(snapshot);
    return createEphemeralService(memory).progress(runId);
  }

  async continue(runId: string, expectedRevision: string, accessToken: string) {
    const prior = await this.authorizedRevision(runId, expectedRevision, accessToken);
    if (prior.run.evidenceMode === "live" && prior.run.status === "extracting_evidence") {
      const draft = PacketDraftSchema.safeParse(await this.store.getPacketDraft?.(runId));
      if (draft.success && draft.data.verification?.status === "ready") {
        return this.continueVerifiedPassages(prior, draft.data);
      }
    }
    if (prior.run.evidenceMode === "live" && prior.run.status === "extracting_evidence" && prior.run.sources.length > 1) {
      return this.continueParallelExtraction(prior);
    }
    return this.mutate(runId, expectedRevision, accessToken, async (service) => {
      return service.continue({ runId, expectedRevision });
    });
  }

  private async continueVerifiedPassages(
    prior: WorkflowRunSnapshot,
    draft: ReturnType<typeof PacketDraftSchema.parse>,
  ): Promise<MutationResult<{ advanced: boolean; failure: null }>> {
    const verification = draft.verification;
    if (!verification || verification.status !== "ready" || verification.passages.length !== 10 || !prior.run.packet) {
      throw new Error("Verified passage continuation requires one ready frozen ten-passage packet.");
    }
    const primaryAttempts = new Map(verification.primaryAttempts.map((attempt) => [attempt.id, attempt]));
    const cards = verification.passages.flatMap((passage) => {
      const attempt = primaryAttempts.get(passage.primary.executionId);
      if (!attempt) throw new Error("Verified passage primary execution is missing from the packet audit.");
      return materializeEvidenceNodeOutput(prior.run, "extract-evidence", {
        evidenceCandidates: [{
          subclaimId: passage.subclaimId,
          sourceChunkId: passage.sourceChunkId,
          excerpt: passage.excerpt,
          extractedResult: passage.extractedResult,
          settingAndSample: passage.settingAndSample,
          studyType: passage.studyType,
          limitation: passage.limitation,
          extractionIssues: passage.extractionIssues,
        }],
      }, attempt).evidenceCards;
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (cards.length !== 10 || new Set(cards.map(({ id }) => id)).size !== cards.length) {
      throw new Error("Verified passage materialization did not produce ten unique evidence cards.");
    }

    const outputRefsByExecution = new Map<string, string[]>();
    for (const card of cards) {
      const refs = outputRefsByExecution.get(card.modelAssessment.executionId) ?? [];
      refs.push(card.id);
      outputRefsByExecution.set(card.modelAssessment.executionId, refs);
    }
    for (const passage of verification.passages) {
      const refs = outputRefsByExecution.get(passage.reviewer.executionId) ?? [];
      refs.push(passage.id);
      outputRefsByExecution.set(passage.reviewer.executionId, refs);
    }

    const errors = [...verification.primaryErrors, ...verification.reviewerErrors];
    const attempts = [...verification.primaryAttempts, ...verification.reviewerAttempts];
    let snapshot = prior;
    for (const [index, rawAttempt] of attempts.entries()) {
      const attempt = NodeExecutionSchema.parse({
        ...rawAttempt,
        outputRefs: rawAttempt.status === "succeeded" ? [...new Set(outputRefsByExecution.get(rawAttempt.id) ?? [])].sort() : [],
      });
      const attemptErrors = errors.filter((error) => error.executionId === attempt.id);
      let candidate = appendExecutionAttempt(
        snapshot.run,
        attempt,
        attemptErrors,
        timestampAfter(snapshot.run),
        snapshot.objectionDispositions,
      );
      if (index === attempts.length - 1) candidate = ResearchRunSchema.parse({ ...candidate, evidenceCards: cards });
      snapshot = await this.store.save(candidate, snapshot.revision, snapshot.objectionDispositions);
    }
    if (attempts.length === 0) throw new Error("Verified passage packet has no model audit attempts.");
    const advanced = advanceRun(snapshot.run, "verifying_evidence", timestampAfter(snapshot.run), snapshot.objectionDispositions);
    snapshot = await this.store.save(advanced, snapshot.revision, snapshot.objectionDispositions);
    return { snapshot, value: { advanced: true, failure: null } };
  }

  private async continueParallelExtraction(prior: WorkflowRunSnapshot): Promise<MutationResult<{ advanced: boolean; failure: null | { code: string; details: string } }>> {
    const adapters = this.researchAdapterFactory();
    if (adapters.evidenceMode !== "live") throw new Error("Parallel extraction requires configured live providers.");
    const pooled = await extractEvidenceSourcesInParallel({
      run: prior.run,
      primary: adapters.primary,
      fallback: adapters.reviewer,
      config: { target: prior.run.sources.length, minimum: 1, candidateCap: Math.min(30, prior.run.sources.length), sourceDeadlineMs: 180_000, deadlineMs: 300_000, perItemTimeoutMs: 20_000, maxConcurrency: Math.min(6, prior.run.sources.length) },
    });
    const workerGenerations = pooled.results.flatMap((audit) => {
      if (audit.value) return [{ sourceId: audit.itemId, generations: audit.value.generations }];
      if (audit.error instanceof GenerationFailure) return [{ sourceId: audit.itemId, generations: [audit.error.generation] }];
      return [];
    });
    const cardsBySource = new Map<string, ReturnType<typeof materializeEvidenceNodeOutput>["evidenceCards"]>();
    for (const worker of workerGenerations) {
      for (const generation of worker.generations) {
        if (!generation.ok) continue;
        const terminal = generation.attempts.at(-1);
        if (!terminal) continue;
        try {
          const output = materializeEvidenceNodeOutput(prior.run, "extract-evidence", generation.value, terminal);
          cardsBySource.set(worker.sourceId, output.evidenceCards);
        } catch {
          // Provider-schema success is not application evidence success. A
          // source worker that invents IDs or changes a literal excerpt is
          // excluded; other independently valid workers may still advance.
        }
      }
    }
    const evidenceCards = [...cardsBySource.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, cards]) => cards)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(evidenceCards.map(({ id }) => id)).size !== evidenceCards.length) {
      throw new Error("Parallel extraction produced duplicate evidence identities.");
    }
    let snapshot = prior;
    const attempts = workerGenerations.flatMap((worker) => {
      let previousId: string | null = null;
      let attemptNumber = 0;
      return worker.generations.flatMap((generation) => {
        if (generation.ok && !cardsBySource.has(worker.sourceId)) return [];
        return generation.attempts.map((rawAttempt, index) => {
        attemptNumber += 1;
        const finalSuccess = generation.ok && index === generation.attempts.length - 1;
        const cards = cardsBySource.get(worker.sourceId) ?? [];
        const normalized = NodeExecutionSchema.parse({
          ...rawAttempt,
          attempt: attemptNumber,
          retryOfExecutionId: previousId,
          outputRefs: finalSuccess ? cards.map(({ id }) => id) : [],
        });
        previousId = normalized.id;
        return { attempt: normalized, errors: generation.errors.filter((error) => error.executionId === rawAttempt.id) };
        });
      });
    });
    for (const [index, entry] of attempts.entries()) {
      let candidate = appendExecutionAttempt(
        snapshot.run,
        entry.attempt,
        entry.errors,
        timestampAfter(snapshot.run),
        snapshot.objectionDispositions,
      );
      if (index === attempts.length - 1 && evidenceCards.length > 0) {
        candidate = ResearchRunSchema.parse({ ...candidate, evidenceCards });
      }
      snapshot = await this.store.save(candidate, snapshot.revision, snapshot.objectionDispositions);
    }
    if (evidenceCards.length === 0 || attempts.length === 0) {
      return { snapshot, value: { advanced: false, failure: { code: "parallel_extraction_failed", details: "No source worker produced a valid literal evidence card." } } };
    }
    const advanced = advanceRun(snapshot.run, "verifying_evidence", timestampAfter(snapshot.run), snapshot.objectionDispositions);
    snapshot = await this.store.save(advanced, snapshot.revision, snapshot.objectionDispositions);
    return { snapshot, value: { advanced: true, failure: null } };
  }

  async approveScope(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    input: { declaredActor?: string; rationale?: string },
  ) {
    void input;
    return this.mutate(runId, expectedRevision, accessToken, (service) => {
      const now = new Date().toISOString();
      const decision = HumanDecisionSchema.parse({
        id: `scope-decision-${crypto.randomUUID()}`,
        checkpoint: "scope",
        optionsShown: ["approve", "edit"],
        decision: "approve",
        edits: [],
        decidedAt: now,
        unresolvedObjections: [],
      });
      service.approveScope({ runId, expectedRevision, decision });
    });
  }

  async collectSources(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    sources: ResearchRun["sources"],
    chunks: ResearchRun["chunks"],
  ) {
    const prior = await this.authorizedRevision(runId, expectedRevision, accessToken);
    const candidate = persistCollectedSources(
      prior.run,
      sources,
      chunks,
      timestampAfter(prior.run),
    );
    return this.store.save(candidate, prior.revision, prior.objectionDispositions);
  }

  async freezePacket(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    input: { declaredActor?: string; rationale?: string },
  ) {
    void input;
    return this.mutate(runId, expectedRevision, accessToken, (service, prior) => {
      const decidedAt = timestampAfter(prior.run);
      const decision = HumanDecisionSchema.parse({
        id: `packet-decision-${crypto.randomUUID()}`,
        checkpoint: "packet_freeze",
        optionsShown: ["approve", "reject"],
        decision: "approve",
        edits: [],
        decidedAt,
        unresolvedObjections: [],
      });
      const packet = freezePacket({
        sourceHashes: prior.run.sources.map(({ contentHash }) => contentHash),
        chunkHashes: prior.run.chunks.map(({ contentHash }) => contentHash),
        frozenAt: decidedAt,
        freezeDecision: decision,
      });
      service.approvePacket({ runId, expectedRevision, packet });
    });
  }

  async submitObjections(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    decision: HumanDecision,
    dispositions: ObjectionDispositionPlan,
  ) {
    return this.mutate(runId, expectedRevision, accessToken, (service) => {
      service.submitObjections({ runId, expectedRevision, decision, dispositions });
    });
  }

  async decideFinal(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    decision: { choice: "approve" | "reject"; declaredActor: string; rationale: string },
  ) {
    const result = await this.mutate(runId, expectedRevision, accessToken, (service) => {
      service.decideFinal({ runId, expectedRevision, decision });
    });
    const retentionMinutes = Number(process.env.FINAL_RUN_RETENTION_MINUTES ?? 15);
    this.store.scheduleExpiry?.(
      runId,
      Math.max(1, retentionMinutes) * 60 * 1_000,
    );
    return result;
  }

  async export(runId: string, accessToken: string) {
    const snapshot = await this.authorize(runId, accessToken);
    const memory = new InMemoryWorkflowRunStore();
    memory.hydrate(snapshot);
    return createEphemeralService(memory).export(runId);
  }

  async delete(runId: string, expectedRevision: string, accessToken: string) {
    if (!this.store.delete) throw new RunNotFoundError(runId);
    await this.authorizedRevision(runId, expectedRevision, accessToken);
    await this.store.delete(runId, expectedRevision, digest(accessToken));
  }

  async getPacketDraft(runId: string, accessToken: string) {
    await this.authorize(runId, accessToken);
    return (await this.store.getPacketDraft?.(runId)) ?? { sources: [] };
  }

  async savePacketDraft(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    draft: unknown,
  ) {
    await this.authorizedRevision(runId, expectedRevision, accessToken);
    if (!this.store.savePacketDraft) throw new Error("Packet drafts are unavailable");
    return this.store.savePacketDraft(runId, expectedRevision, draft);
  }

  async timeline(runId: string, accessToken: string) {
    const [snapshot, draft] = await Promise.all([
      this.authorize(runId, accessToken),
      this.getPacketDraft(runId, accessToken),
    ]);
    const events = [
      {
        id: `${runId}-created`,
        at: snapshot.run.createdAt,
        stage: "scope",
        actor: "researcher",
        status: "complete",
        label: "Investigation created",
      },
      ...snapshot.run.executions.map((execution) => ({
        id: execution.id,
        at: execution.endedAt ?? execution.startedAt,
        stage: execution.nodeId,
        actor: "model",
        status: execution.status,
        label: execution.status === "succeeded" ? `${execution.nodeId} completed` : `${execution.nodeId} recorded ${execution.status}`,
      })),
    ];
    if (snapshot.run.scopeDecision) events.push({ id: snapshot.run.scopeDecision.id, at: snapshot.run.scopeDecision.decidedAt, stage: "scope", actor: "researcher", status: "complete", label: "Claim scope approved" });
    if (snapshot.run.packet) events.push({ id: snapshot.run.packet.fingerprint, at: snapshot.run.packet.frozenAt, stage: "packet", actor: "researcher", status: "complete", label: `Packet frozen with ${snapshot.run.sources.length} sources` });
    return { runId, revision: snapshot.revision, draft, events: events.sort((a, b) => a.at.localeCompare(b.at)) };
  }

  private async authorizedRevision(
    runId: string,
    expectedRevision: string,
    accessToken: string,
  ) {
    const snapshot = await this.authorize(runId, accessToken);
    if (snapshot.revision !== expectedRevision) {
      throw new Error("The investigation changed in another request. Refresh and retry.");
    }
    return snapshot;
  }

  private async mutate<T>(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    operation: (service: RunService, prior: WorkflowRunSnapshot) => T | Promise<T>,
  ): Promise<MutationResult<T>> {
    const prior = await this.authorizedRevision(runId, expectedRevision, accessToken);
    const memory = new InMemoryWorkflowRunStore();
    memory.hydrate(prior);
    const service = createEphemeralService(memory);
    const value = await operation(service, prior);
    const latest = memory.load(runId);
    if (!latest) throw new RunNotFoundError(runId);
    const save = this.store.saveComposite?.bind(this.store) ?? this.store.save.bind(this.store);
    const snapshot = await save(
      latest.run,
      prior.revision,
      latest.objectionDispositions,
    );
    return { snapshot, value };
  }
}

type CoordinatorGlobal = typeof globalThis & {
  __evidenceForgeCoordinator?: DurableRunCoordinator;
};

export function getDurableRunCoordinator(): DurableRunCoordinator {
  const host = globalThis as CoordinatorGlobal;
  if (!host.__evidenceForgeCoordinator) {
    const ttlMinutes = Number(process.env.RUN_CACHE_TTL_MINUTES ?? 120);
    const store: WorkflowRunStore = new AsyncWorkflowRunStoreAdapter(
      new InMemoryWorkflowRunStore(),
      { ttlMs: Math.max(5, ttlMinutes) * 60 * 1_000 },
    );
    host.__evidenceForgeCoordinator = new DurableRunCoordinator(store);
  }
  return host.__evidenceForgeCoordinator;
}

export function hashPacketDraft(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
