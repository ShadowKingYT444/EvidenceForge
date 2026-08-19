import { createHash } from "node:crypto";

import {
  HumanDecisionSchema,
  ResearchIntakeSchema,
  freezePacket,
  type ResearchRun,
} from "../../contracts";
import {
  createFeatherlessAdapter,
  createFixtureAdapter,
  type StructuredGenerationAdapter,
} from "../models";
import { createPromptRunNodeRequestBuilder } from "../prompts/render";
import {
  createRunToken,
  digestRunToken,
} from "../auth/run-token";
import {
  persistCollectedSources,
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
import { RunService } from "./run-api";

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

function liveAdapters(): {
  primary: StructuredGenerationAdapter;
  reviewer: StructuredGenerationAdapter;
  evidenceMode: ResearchRun["evidenceMode"];
} {
  const apiKey = process.env.FEATHERLESS_API_KEY?.trim();
  if (!apiKey) {
    const unavailable = createFixtureAdapter({
      modelId: "provider-not-configured",
      developerFamily: "fixture",
      baseFamily: "fixture",
      fixtures: {},
    });
    return { primary: unavailable, reviewer: unavailable, evidenceMode: "fixture" };
  }
  return {
    primary: createFeatherlessAdapter({
      apiKey,
      modelId:
        process.env.PRIMARY_MODEL?.trim() ||
        "mistralai/Mistral-Large-Instruct-2411",
      developerFamily: "mistral",
      baseFamily: "mistral",
      evidenceMode: "live",
    }),
    reviewer: createFeatherlessAdapter({
      apiKey,
      modelId:
        process.env.REVIEW_MODEL?.trim() || "Qwen/Qwen2.5-72B-Instruct",
      developerFamily: "qwen",
      baseFamily: "qwen",
      evidenceMode: "live",
    }),
    evidenceMode: "live",
  };
}

function timestampAfter(run: ResearchRun): string {
  const now = Date.now();
  const prior = Date.parse(run.updatedAt);
  return new Date(Math.max(now, Number.isFinite(prior) ? prior + 1 : now)).toISOString();
}

function createEphemeralService(store: InMemoryWorkflowRunStore): RunService {
  const adapters = liveAdapters();
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
  constructor(readonly store: WorkflowRunStore) {}

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
    return this.mutate(runId, expectedRevision, accessToken, async (service) => {
      return service.continue({ runId, expectedRevision });
    });
  }

  async approveScope(
    runId: string,
    expectedRevision: string,
    accessToken: string,
    input: { declaredActor?: string; rationale?: string },
  ) {
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
        declaredActor: input.declaredActor?.trim() || "Researcher",
        rationale: input.rationale?.trim() || "Approved for bounded evidence collection.",
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
        declaredActor: input.declaredActor?.trim() || "Researcher",
        rationale: input.rationale?.trim() || "Approved this bounded source packet for analysis.",
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
