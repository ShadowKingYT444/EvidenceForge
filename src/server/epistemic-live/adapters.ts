import { canonicalSha256 } from "../../contracts";
import type { ResearchRun } from "../../contracts";
import { compileResearchRun, projectResearchRun } from "../../epistemic-ci/live";
import type { WorkflowRunSnapshot } from "../workflow/store";
import {
  EpistemicLiveSchemaVersion,
  type EpistemicCompileRequest,
} from "./contracts";

export type EpistemicProjectionAdapter = (run: ResearchRun) => unknown | Promise<unknown>;
export type EpistemicCompileAdapter = (
  run: ResearchRun,
  input: EpistemicCompileRequest,
  projection: unknown,
) => unknown | Promise<unknown>;

export interface EpistemicCoordinatorAdapter {
  authorize(runId: string, accessToken: string): Promise<WorkflowRunSnapshot>;
}

type GenericExports = {
  projectLiveRun?: EpistemicProjectionAdapter;
  projectResearchRun?: EpistemicProjectionAdapter;
  projectRun?: EpistemicProjectionAdapter;
  compileLiveRun?: EpistemicCompileAdapter;
  compileResearchRun?: EpistemicCompileAdapter;
  compileRun?: EpistemicCompileAdapter;
  /** Existing CI names are accepted only as an integration fallback. */
  projectGoldenRun?: (run: unknown) => unknown;
  compileEpistemicBuild?: (input: unknown) => unknown;
};

function genericExports(): GenericExports {
  const host = globalThis as typeof globalThis & {
    __evidenceForgeEpistemicExports?: GenericExports;
  };
  return host.__evidenceForgeEpistemicExports ?? {};
}

/** Safe, run-derived projection used until a generic live projector is installed. */
export function projectRunFallback(run: ResearchRun): Record<string, unknown> {
  const nodes = [
    ...run.claims.map((claim) => ({
      id: `claim:${claim.id}`, kind: "claim", label: claim.statement, state: "insufficient",
      detail: claim.statement, sourceRef: null, mutable: false, metadata: { evidenceMode: run.evidenceMode },
    })),
    ...run.evidenceCards.map((card) => ({
      id: `evidence:${card.id}`, kind: "passage", label: card.excerpt.slice(0, 120), state: card.relationship === "supports" ? "supported" : card.relationship === "contradicts" ? "conflicting" : "insufficient",
      detail: card.excerpt, sourceRef: card.sourceChunkId, mutable: true, metadata: { evidenceMode: run.evidenceMode, relationship: card.relationship },
    })),
    ...run.researchGaps.map((gap) => ({
      id: `gap:${gap.id}`, kind: "gap", label: gap.type, state: gap.selection === "selected" ? "blocked" : "insufficient",
      detail: gap.impactRationale, sourceRef: null, mutable: true, metadata: { evidenceMode: run.evidenceMode },
    })),
  ];
  const edges = run.evidenceCards.map((card) => ({
    id: `evidence:${card.id}--${card.relationship}-->claim:${card.subclaimId}`,
    from: `evidence:${card.id}`, to: `claim:${card.subclaimId}`,
    relation: card.relationship === "supports" ? "supports" : card.relationship === "contradicts" ? "contradicts" : "qualifies",
  }));
  const payload = {
    schemaVersion: EpistemicLiveSchemaVersion,
    fixtureId: run.id,
    fixtureHash: canonicalSha256(run),
    evidenceMode: run.evidenceMode,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { ...payload, graphHash: canonicalSha256(payload) };
}

export function createDefaultProjectionAdapter(): EpistemicProjectionAdapter {
  return (run) => {
    const exports = genericExports();
    const projector = exports.projectLiveRun ?? exports.projectResearchRun ?? exports.projectRun ?? projectResearchRun;
    if (projector) return projector(run);
    if (run.evidenceMode === "fixture" && exports.projectGoldenRun) return exports.projectGoldenRun(run);
    return projectRunFallback(run);
  };
}
export const createLiveEpistemicProjectionAdapter = createDefaultProjectionAdapter;

export function createDefaultCompileAdapter(): EpistemicCompileAdapter {
  return (run, input, projection) => {
    const exports = genericExports();
    const compiler = exports.compileLiveRun ?? exports.compileResearchRun ?? exports.compileRun;
    if (compiler) return compiler(run, input, projection);
    if (run.evidenceMode !== "fixture" || input.operations !== undefined || input.branchOperations !== undefined) {
      const operations = input.operations ?? input.branchOperations ?? input.appliedChangeIds ?? [];
      return compileResearchRun(run, { operations, parentBuildId: input.parentBuildId }, projection);
    }
    if (run.evidenceMode === "fixture" && exports.compileEpistemicBuild && input.appliedChangeIds) {
      return exports.compileEpistemicBuild({
        appliedChangeIds: input.appliedChangeIds,
        parentBuildId: input.parentBuildId,
      });
    }
    const operations = input.operations ?? input.branchOperations ?? input.appliedChangeIds ?? [];
    return {
      schemaVersion: EpistemicLiveSchemaVersion,
      buildId: `live-build-${canonicalSha256({ runId: run.id, projection, operations }).slice(0, 16)}`,
      parentBuildId: input.parentBuildId ?? null,
      runId: run.id,
      graphHash: typeof projection === "object" && projection !== null && "graphHash" in projection && typeof projection.graphHash === "string"
        ? projection.graphHash : canonicalSha256(projection),
      appliedOperations: operations,
      projection,
      decision: { status: "failing", label: "Scientific decision requires human review", blockerNodeIds: [] },
      scientificDecisionApproved: false,
    };
  };
}
export const createLiveEpistemicCompileAdapter = createDefaultCompileAdapter;

export function snapshotRun(snapshot: WorkflowRunSnapshot): ResearchRun {
  return structuredClone(snapshot.run);
}
