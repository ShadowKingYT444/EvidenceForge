import { canonicalSha256, canonicalizeJson, ResearchRunSchema, type ResearchRun } from "../contracts";
import { type EpistemicNodeState } from "./contracts";
import { z } from "zod";

/**
 * The live lane is deliberately a separate versioned contract.  The fixture
 * lane has a fixed vocabulary and fixed IDs; a live run does not.
 */
export const LIVE_EPISTEMIC_CI_SCHEMA_VERSION = "epistemic-ci.live.v1" as const;

const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ScalarSchema = z.union([z.string(), z.boolean(), z.number()]);
const MetadataSchema = z.record(z.string(), ScalarSchema);
const NodeStateSchema = z.enum([
  "supported",
  "conflicting",
  "insufficient",
  "blocked",
  "resolved",
  "obsolete",
]);

export const LiveRightsSchema = z
  .object({
    mayStore: z.enum(["allowed", "denied", "unknown"]),
    mayDisplay: z.enum(["allowed", "denied", "unknown"]),
    maySendToModel: z.enum(["allowed", "denied", "unknown"]),
    sourceId: IdSchema.nullable(),
    chunkId: IdSchema.nullable(),
  })
  .strict();
export type LiveRights = z.infer<typeof LiveRightsSchema>;

export const LiveScopeSchema = z
  .object({
    runId: IdSchema,
    match: z.boolean(),
    intendedApplication: z.string().min(1),
    populationOrGeography: z.string().min(1),
    timeHorizon: z.string().min(1),
    claimConstraints: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    overridden: z.boolean(),
  })
  .strict();
export type LiveScope = z.infer<typeof LiveScopeSchema>;

export const LiveTrustSchema = z
  .object({
    provenance: z.literal("research-run"),
    evidenceMode: z.enum(["live", "fixture", "mocked", "simulated", "unverified"]),
    deterministicVerification: z.enum(["verified", "failed", "unavailable", "not_checked", "not_applicable"]),
    modelAssessment: z.enum(["full_support", "partial_support", "contradicts", "insufficient", "unclear", "not_applicable"]),
    humanReview: z.enum(["unreviewed", "confirmed", "overridden", "not_applicable"]),
    level: z.enum(["trusted", "reviewed", "unreviewed", "unverified"]),
  })
  .strict();
export type LiveTrust = z.infer<typeof LiveTrustSchema>;

export const LiveEpistemicNodeSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["passage", "scope", "assumption", "claim", "criterion", "gap", "experiment", "objection", "decision"]),
    label: z.string().min(1),
    state: NodeStateSchema,
    detail: z.string().min(1),
    sourceRef: IdSchema.nullable(),
    mutable: z.boolean(),
    metadata: MetadataSchema,
    rights: LiveRightsSchema,
    scope: LiveScopeSchema,
    trust: LiveTrustSchema,
  })
  .strict();
export type LiveEpistemicNode = z.infer<typeof LiveEpistemicNodeSchema>;

export const LiveEpistemicEdgeSchema = z
  .object({
    id: IdSchema,
    from: IdSchema,
    to: IdSchema,
    relation: z.enum(["supports", "contradicts", "depends_on", "qualifies", "tests", "blocks", "overrides"]),
  })
  .strict();
export type LiveEpistemicEdge = z.infer<typeof LiveEpistemicEdgeSchema>;

export const LiveEpistemicGraphSchema = z
  .object({
    schemaVersion: z.literal(LIVE_EPISTEMIC_CI_SCHEMA_VERSION),
    runId: IdSchema,
    runHash: HashSchema,
    nodes: z.array(LiveEpistemicNodeSchema),
    edges: z.array(LiveEpistemicEdgeSchema),
    graphHash: HashSchema,
  })
  .strict();
export type LiveEpistemicGraph = z.infer<typeof LiveEpistemicGraphSchema>;

const LiveEvidenceInputSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    detail: z.string().min(1),
    relationship: z.enum(["supports", "contradicts", "unresolved"]),
    sourceRef: IdSchema.nullable(),
    rights: LiveRightsSchema,
    scope: LiveScopeSchema,
    trust: LiveTrustSchema,
    metadata: MetadataSchema,
  })
  .strict();
export type LiveEvidenceInput = z.infer<typeof LiveEvidenceInputSchema>;

export const LiveBranchOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    id: IdSchema,
    kind: z.literal("invalidate_evidence"),
    targetNodeIds: z.array(IdSchema).min(1),
    reason: z.string().min(1),
  }).strict(),
  z.object({
    id: IdSchema,
    kind: z.literal("add_evidence"),
    targetNodeIds: z.array(IdSchema).min(1),
    evidence: LiveEvidenceInputSchema,
  }).strict(),
  z.object({
    id: IdSchema,
    kind: z.literal("scope_override"),
    targetNodeIds: z.array(IdSchema).min(1),
    scope: LiveScopeSchema,
    reason: z.string().min(1),
  }).strict(),
  z.object({
    id: IdSchema,
    kind: z.literal("assumption_decision"),
    targetNodeIds: z.array(IdSchema).min(1),
    decision: z.enum(["accept", "reject"]),
    reason: z.string().min(1),
  }).strict(),
]);
export type LiveBranchOperation = z.infer<typeof LiveBranchOperationSchema>;

export const LiveCompilerErrorSchema = z
  .object({
    id: IdSchema,
    code: z.enum(["CONFLICTING_EVIDENCE", "INSUFFICIENT_SUPPORT", "SCOPE_MISMATCH", "BLOCKED_CRITERION", "OBSOLETE_EXPERIMENT", "INVALID_CHANGE"]),
    severity: z.enum(["error", "warning"]),
    nodeId: IdSchema,
    message: z.string().min(1),
    relatedNodeIds: z.array(IdSchema),
  })
  .strict();
export type LiveCompilerError = z.infer<typeof LiveCompilerErrorSchema>;

const LiveWitnessSchema = z.object({
  id: IdSchema,
  targetNodeId: IdSchema,
  nodeIds: z.array(IdSchema).min(1),
  edgeIds: z.array(IdSchema),
  explanation: z.string().min(1),
}).strict();
export type LiveSupportWitness = z.infer<typeof LiveWitnessSchema>;

const LiveBreakingSetSchema = z.object({
  id: IdSchema,
  targetNodeId: IdSchema,
  nodeIds: z.array(IdSchema).min(1),
  explanation: z.string().min(1),
}).strict();
export type LiveBreakingSet = z.infer<typeof LiveBreakingSetSchema>;

const LiveStateChangeSchema = z.object({
  nodeId: IdSchema,
  before: NodeStateSchema.nullable(),
  after: NodeStateSchema.nullable(),
  reason: z.string().min(1),
}).strict();
const LiveDiffSchema = z.object({
  addedNodeIds: z.array(IdSchema),
  removedNodeIds: z.array(IdSchema),
  changedNodes: z.array(LiveStateChangeSchema),
  impactedNodeIds: z.array(IdSchema),
  summary: z.string().min(1),
}).strict();
export type LiveSemanticDiff = z.infer<typeof LiveDiffSchema>;

const LiveDecisionSchema = z.object({
  status: z.enum(["passing", "failing"]),
  label: z.string().min(1),
  blockerNodeIds: z.array(IdSchema),
}).strict();
const LivePullRequestSchema = z.object({
  status: z.enum(["open", "mergeable", "blocked"]),
  title: z.string().min(1),
  changedNodeIds: z.array(IdSchema),
  impactedNodeIds: z.array(IdSchema),
  compilerTestSummary: z.string().min(1),
  unresolvedBlockers: z.array(IdSchema),
  authorizationRequired: z.boolean(),
}).strict();

export const LiveEpistemicBuildSchema = z.object({
  schemaVersion: z.literal(LIVE_EPISTEMIC_CI_SCHEMA_VERSION),
  buildId: IdSchema,
  parentBuildId: IdSchema.nullable(),
  runId: IdSchema,
  runHash: HashSchema,
  graphHash: HashSchema,
  appliedOperationIds: z.array(IdSchema),
  graph: LiveEpistemicGraphSchema,
  impactedNodeIds: z.array(IdSchema),
  recomputedNodeIds: z.array(IdSchema),
  errors: z.array(LiveCompilerErrorSchema),
  witnesses: z.array(LiveWitnessSchema),
  breakingSets: z.array(LiveBreakingSetSchema),
  diff: LiveDiffSchema,
  decision: LiveDecisionSchema,
  pullRequest: LivePullRequestSchema,
}).strict();
export type LiveEpistemicBuild = z.infer<typeof LiveEpistemicBuildSchema>;
export const LiveGraphSchema = LiveEpistemicGraphSchema;
export const EpistemicLiveGraphSchema = LiveEpistemicGraphSchema;
export const LiveBuildSchema = LiveEpistemicBuildSchema;
export const EpistemicLiveBuildSchema = LiveEpistemicBuildSchema;
export const LiveBranchSchema = LiveBranchOperationSchema;

export type CompileResearchRunInput = {
  run: ResearchRun;
  /** Inputs are normalized through the versioned operation schema at the branch boundary. */
  operations?: readonly unknown[];
  appliedOperations?: readonly unknown[];
  parentBuildId?: string | null;
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** A stable ID never depends on array order or a golden fixture vocabulary. */
export function stableLiveNodeId(runId: string, kind: LiveEpistemicNode["kind"], recordId: string): string {
  return `live-node:${canonicalSha256({ runId, kind, recordId }).slice(0, 48)}`;
}

export function stableLiveEdgeId(from: string, to: string, relation: LiveEpistemicEdge["relation"]): string {
  return `live-edge:${canonicalSha256({ from, to, relation }).slice(0, 48)}`;
}

function stateForStrength(strength: string | undefined): EpistemicNodeState {
  if (strength === "strong" || strength === "moderate") return "supported";
  if (strength === "conflicting") return "conflicting";
  return "insufficient";
}

function sourceRights(run: ResearchRun, cardId: string): LiveRights {
  const card = run.evidenceCards.find((item) => item.id === cardId);
  const chunk = card ? run.chunks.find((item) => item.id === card.sourceChunkId) : undefined;
  const source = chunk ? run.sources.find((item) => item.id === chunk.sourceId) : undefined;
  return {
    mayStore: source?.rights.mayStore ?? "unknown",
    mayDisplay: source?.rights.mayDisplay ?? "unknown",
    maySendToModel: source?.rights.maySendToModel ?? "unknown",
    sourceId: source?.id ?? null,
    chunkId: chunk?.id ?? null,
  };
}

function baseScope(run: ResearchRun, claimConstraints: readonly string[] = [], match = run.scopeDecision?.decision !== "reject", overridden = false): LiveScope {
  return {
    runId: run.id,
    match,
    intendedApplication: run.intake.intendedApplication,
    populationOrGeography: run.intake.populationOrGeography,
    timeHorizon: run.intake.timeHorizon,
    claimConstraints: [...claimConstraints],
    constraints: [...run.intake.constraints],
    overridden,
  };
}

function trustForCard(run: ResearchRun, cardId: string): LiveTrust {
  const card = run.evidenceCards.find((item) => item.id === cardId);
  const verification = card?.deterministicVerification.status ?? "not_checked";
  const human = card?.humanReview.status ?? "unreviewed";
  const model = card?.modelAssessment.entailment ?? "insufficient";
  return {
    provenance: "research-run",
    evidenceMode: run.evidenceMode,
    deterministicVerification: verification,
    modelAssessment: model,
    humanReview: human,
    level: human === "confirmed" && verification === "verified" ? "trusted" : human === "unreviewed" ? "unreviewed" : "reviewed",
  };
}

function genericTrust(run: ResearchRun): LiveTrust {
  return {
    provenance: "research-run",
    evidenceMode: run.evidenceMode,
    deterministicVerification: "not_applicable",
    modelAssessment: "not_applicable",
    humanReview: "not_applicable",
    level: run.evidenceMode === "unverified" ? "unverified" : "reviewed",
  };
}

function addNode(nodes: LiveEpistemicNode[], node: LiveEpistemicNode): void {
  if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
}

function makeEdge(from: string, to: string, relation: LiveEpistemicEdge["relation"]): LiveEpistemicEdge {
  return { id: stableLiveEdgeId(from, to, relation), from, to, relation };
}

/** Project an arbitrary validated ResearchRun into a detached live graph. */
export function projectResearchRun(input: ResearchRun): LiveEpistemicGraph {
  const run = ResearchRunSchema.parse(structuredClone(input));
  const runHash = canonicalSha256(run);
  const nodes: LiveEpistemicNode[] = [];
  const edges: LiveEpistemicEdge[] = [];
  const scopeId = stableLiveNodeId(run.id, "scope", "run-scope");
  const scopeMatch = run.scopeDecision?.decision !== "reject";
  addNode(nodes, {
    id: scopeId, kind: "scope", label: "Research scope", state: scopeMatch ? "supported" : "blocked",
    detail: `${run.intake.originalQuestion} (${run.intake.intendedApplication})`, sourceRef: null, mutable: true,
    metadata: { runId: run.id, active: true }, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null },
    scope: baseScope(run, [], scopeMatch), trust: genericTrust(run),
  });

  const claimIds = new Map<string, string>();
  for (const claim of [...run.claims].sort((a, b) => a.id.localeCompare(b.id))) {
    const conclusion = run.conclusions.find((item) => item.subclaimId === claim.id);
    const claimCards = run.evidenceCards.filter((card) => card.subclaimId === claim.id);
    const cardSupport = claimCards.some((card) => card.relationship === "supports");
    const cardContradiction = claimCards.some((card) => card.relationship === "contradicts");
    const inferredState: EpistemicNodeState = cardContradiction && cardSupport ? "conflicting" : cardSupport ? "supported" : cardContradiction ? "conflicting" : "insufficient";
    const id = stableLiveNodeId(run.id, "claim", claim.id);
    claimIds.set(claim.id, id);
    addNode(nodes, {
      id, kind: "claim", label: claim.statement, state: conclusion ? stateForStrength(conclusion.strength) : inferredState, detail: claim.operationalDefinition,
      sourceRef: claim.id, mutable: claim.disposition !== "removed", metadata: { claimId: claim.id, disposition: claim.disposition, active: claim.disposition !== "removed" },
      rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null },
      scope: baseScope(run, claim.scopeConstraints), trust: genericTrust(run),
    });
    edges.push(makeEdge(scopeId, id, "depends_on"));
    if (claim.parentClaimId !== null) {
      const parentId = claimIds.get(claim.parentClaimId) ?? stableLiveNodeId(run.id, "claim", claim.parentClaimId);
      edges.push(makeEdge(parentId, id, "qualifies"));
    }
    for (const [index, constraint] of claim.scopeConstraints.entries()) {
      const assumptionId = stableLiveNodeId(run.id, "assumption", `${claim.id}:${index}:${constraint}`);
      addNode(nodes, {
        id: assumptionId, kind: "assumption", label: constraint, state: "insufficient", detail: `Scope assumption for ${claim.statement}.`,
        sourceRef: claim.id, mutable: true, metadata: { claimId: claim.id, accepted: false, active: true },
        rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null },
        scope: baseScope(run, [constraint]), trust: genericTrust(run),
      });
      edges.push(makeEdge(assumptionId, id, "supports"));
    }
  }

  for (const card of [...run.evidenceCards].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = stableLiveNodeId(run.id, "passage", card.id);
    const target = claimIds.get(card.subclaimId);
    addNode(nodes, {
      id, kind: "passage", label: card.id, state: card.relationship === "supports" ? "supported" : card.relationship === "contradicts" ? "conflicting" : "insufficient",
      detail: card.excerpt, sourceRef: card.sourceChunkId, mutable: true,
      metadata: { evidenceCardId: card.id, subclaimId: card.subclaimId, relationship: card.relationship, active: true, rightsMayStore: sourceRights(run, card.id).mayStore, rightsMayDisplay: sourceRights(run, card.id).mayDisplay, rightsMaySendToModel: sourceRights(run, card.id).maySendToModel, scopeMatch: true, trustLevel: trustForCard(run, card.id).level },
      rights: sourceRights(run, card.id), scope: baseScope(run), trust: trustForCard(run, card.id),
    });
    if (target) edges.push(makeEdge(id, target, card.relationship === "contradicts" ? "contradicts" : card.relationship === "supports" ? "supports" : "qualifies"));
  }

  const gapIds = new Map<string, string>();
  for (const gap of [...run.researchGaps].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = stableLiveNodeId(run.id, "gap", gap.id);
    gapIds.set(gap.id, id);
    addNode(nodes, {
      id, kind: "gap", label: gap.id, state: gap.selection === "selected" ? "blocked" : gap.selection === "rejected" ? "obsolete" : "insufficient",
      detail: gap.impactRationale, sourceRef: gap.id, mutable: true, metadata: { gapId: gap.id, selection: gap.selection, active: true },
      rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null }, scope: baseScope(run), trust: genericTrust(run),
    });
    for (const claim of gap.affectedSubclaimIds) {
      const claimId = claimIds.get(claim);
      if (claimId) edges.push(makeEdge(claimId, id, "blocks"));
    }
  }
  if (run.experiment !== null) {
    const id = stableLiveNodeId(run.id, "experiment", run.experiment.selectedGapId);
    addNode(nodes, {
      id, kind: "experiment", label: run.experiment.objective, state: "blocked", detail: run.experiment.hypothesis, sourceRef: run.experiment.selectedGapId, mutable: true,
      metadata: { selectedGapId: run.experiment.selectedGapId, active: true }, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null }, scope: baseScope(run), trust: genericTrust(run),
    });
    const gapId = gapIds.get(run.experiment.selectedGapId);
    if (gapId) edges.push(makeEdge(gapId, id, "tests"));
  }

  if (run.review !== null) {
    for (const objection of [...run.review.objections].sort((a, b) => a.id.localeCompare(b.id))) {
      const id = stableLiveNodeId(run.id, "objection", objection.id);
      addNode(nodes, {
        id, kind: "objection", label: objection.category, state: "blocked", detail: objection.rationale, sourceRef: objection.id, mutable: true,
        metadata: { objectionId: objection.id, severity: objection.severity, active: true }, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null }, scope: baseScope(run), trust: genericTrust(run),
      });
      for (const evidenceId of objection.evidenceCardIds) {
        const passageId = stableLiveNodeId(run.id, "passage", evidenceId);
        if (nodes.some((node) => node.id === passageId)) edges.push(makeEdge(id, passageId, "qualifies"));
      }
    }
  }
  const decisionId = stableLiveNodeId(run.id, "decision", "final");
  const approved = run.finalDecision?.decision === "approve";
  addNode(nodes, {
    id: decisionId, kind: "decision", label: "Final research decision", state: approved ? "supported" : "blocked", detail: run.finalDecision?.rationale ?? "No final human decision has been recorded.", sourceRef: run.finalDecision?.id ?? null, mutable: false,
    metadata: { status: approved ? "passing" : "failing", active: true }, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", sourceId: null, chunkId: null }, scope: baseScope(run), trust: genericTrust(run),
  });
  for (const claimId of claimIds.values()) edges.push(makeEdge(claimId, decisionId, "depends_on"));

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const payload = { schemaVersion: LIVE_EPISTEMIC_CI_SCHEMA_VERSION, runId: run.id, runHash, nodes, edges };
  return LiveEpistemicGraphSchema.parse({ ...payload, graphHash: canonicalSha256(payload) });
}

export const projectLiveRun = projectResearchRun;

function nodeById(graph: LiveEpistemicGraph, id: string): LiveEpistemicNode | undefined { return graph.nodes.find((node) => node.id === id); }
function isActive(node: LiveEpistemicNode | undefined): boolean { return node !== undefined && node.metadata.active !== false && node.state !== "obsolete"; }

function evidenceEligible(node: LiveEpistemicNode): boolean {
  return isActive(node) &&
    node.kind === "passage" &&
    node.rights.mayStore === "allowed" &&
    node.rights.mayDisplay === "allowed" &&
    node.rights.maySendToModel === "allowed" &&
    node.scope.match &&
    node.trust.deterministicVerification === "verified" &&
    node.trust.humanReview === "confirmed";
}

function recompute(graph: LiveEpistemicGraph): void {
  for (const claim of graph.nodes.filter((node) => node.kind === "claim")) {
    const incoming = graph.edges.filter((edge) => edge.to === claim.id && (edge.relation === "supports" || edge.relation === "contradicts"));
    const support = incoming.some((edge) => {
      const source = nodeById(graph, edge.from);
      return edge.relation === "supports" && source !== undefined && (evidenceEligible(source) || (source.kind === "assumption" && source.metadata.accepted === true));
    });
    const contradiction = incoming.some((edge) => edge.relation === "contradicts" && nodeById(graph, edge.from) !== undefined && evidenceEligible(nodeById(graph, edge.from)!));
    const scopeMismatch = incoming.some((edge) => edge.relation === "supports" && isActive(nodeById(graph, edge.from)) && !nodeById(graph, edge.from)!.scope.match);
    const scopeDependency = graph.edges.some((edge) => edge.from === graph.nodes.find((node) => node.kind === "scope")?.id && edge.to === claim.id && edge.relation === "depends_on" && nodeById(graph, edge.from)?.scope.match === false);
    claim.state = (claim.scope.match === false || scopeMismatch || scopeDependency) && !support ? "blocked" : contradiction && support ? "conflicting" : support ? "supported" : "insufficient";
  }
  for (const gap of graph.nodes.filter((node) => node.kind === "gap")) {
    const blocked = graph.edges.some((edge) => edge.to === gap.id && edge.relation === "blocks" && nodeById(graph, edge.from)?.state !== "supported");
    gap.state = blocked ? "blocked" : "resolved";
  }
  const experiment = graph.nodes.find((node) => node.kind === "experiment");
  if (experiment) experiment.state = graph.nodes.some((node) => node.kind === "gap" && node.state === "blocked") ? "blocked" : "supported";
  const decision = graph.nodes.find((node) => node.kind === "decision");
  if (decision && graph.nodes.some((node) => node.kind === "claim" && node.state !== "supported")) { decision.state = "blocked"; decision.metadata = { ...decision.metadata, status: "failing" }; }
  const payload = { schemaVersion: graph.schemaVersion, runId: graph.runId, runHash: graph.runHash, nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)) };
  graph.nodes = payload.nodes; graph.edges = payload.edges; graph.graphHash = canonicalSha256(payload);
}

export function computeLiveImpactClosure(graph: LiveEpistemicGraph, changedNodeIds: readonly string[]): string[] {
  const seen = new Set(changedNodeIds); const queue = [...changedNodeIds];
  while (queue.length) { const current = queue.shift()!; for (const edge of graph.edges) if (edge.from === current && !seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); } }
  return sortedUnique([...seen]);
}
export const computeResearchRunImpactClosure = computeLiveImpactClosure;

function supportWitnesses(graph: LiveEpistemicGraph, targetId: string): LiveSupportWitness[] {
  const target = nodeById(graph, targetId); if (!target || target.state !== "supported") return [];
  const incoming = graph.edges.filter((edge) => edge.to === targetId && edge.relation === "supports");
  const witnesses = incoming.filter((edge) => { const node = nodeById(graph, edge.from); return node !== undefined && (evidenceEligible(node) || (node.kind === "assumption" && node.metadata.accepted === true)); }).map((edge) => ({ id: `live-witness:${canonicalSha256({ targetId, nodeId: edge.from }).slice(0, 48)}`, targetNodeId: targetId, nodeIds: [edge.from], edgeIds: [edge.id], explanation: `The target is supported by ${edge.from}.` }));
  return witnesses.sort((a, b) => a.id.localeCompare(b.id));
}
export const computeLiveSupportWitnesses = supportWitnesses;
export const computeResearchRunSupportWitnesses = supportWitnesses;

export function computeLiveBreakingSets(graph: LiveEpistemicGraph, targetNodeId: string, maxSize = 3): LiveBreakingSet[] {
  const witnesses = supportWitnesses(graph, targetNodeId); if (!witnesses.length) return [];
  const candidates = sortedUnique(witnesses.flatMap((witness) => witness.nodeIds.filter((id) => nodeById(graph, id)?.mutable)));
  const sets: string[][] = [];
  const combinations = (start: number, picked: string[]): void => {
    if (picked.length > 0) {
      if (witnesses.every((witness) => witness.nodeIds.some((id) => picked.includes(id)))) sets.push([...picked]);
      if (picked.length === maxSize) return;
    }
    for (let index = start; index < candidates.length; index += 1) combinations(index + 1, [...picked, candidates[index]!]);
  };
  combinations(0, []);
  const minimal = sets.filter((candidate) => !sets.some((prior) => prior.length < candidate.length && prior.every((id) => candidate.includes(id))));
  return minimal.sort((a, b) => a.length - b.length || a.join("|").localeCompare(b.join("|"))).map((nodeIds) => ({ id: `live-breaking:${canonicalSha256({ targetNodeId, nodeIds }).slice(0, 48)}`, targetNodeId, nodeIds, explanation: `Removing ${nodeIds.join(", ")} removes every minimal support witness.` }));
}
export const computeResearchRunBreakingSets = computeLiveBreakingSets;

function applyOperation(graph: LiveEpistemicGraph, operation: LiveBranchOperation): string[] {
  const changed = [...operation.targetNodeIds];
  if (operation.kind === "invalidate_evidence") {
    for (const id of operation.targetNodeIds) { const node = nodeById(graph, id); if (!node || node.kind !== "passage") throw new Error(`invalid evidence target: ${id}`); node.state = "obsolete"; node.metadata = { ...node.metadata, active: false, invalidatedBy: operation.id }; }
  } else if (operation.kind === "add_evidence") {
    const evidenceId = stableLiveNodeId(graph.runId, "passage", operation.evidence.id);
    if (!nodeById(graph, evidenceId)) graph.nodes.push({ id: evidenceId, kind: "passage", label: operation.evidence.label, state: operation.evidence.relationship === "supports" ? "supported" : operation.evidence.relationship === "contradicts" ? "conflicting" : "insufficient", detail: operation.evidence.detail, sourceRef: operation.evidence.sourceRef, mutable: true, metadata: { ...operation.evidence.metadata, active: true, branchOperationId: operation.id }, rights: operation.evidence.rights, scope: operation.evidence.scope, trust: operation.evidence.trust });
    for (const target of operation.targetNodeIds) { if (!nodeById(graph, target)) throw new Error(`invalid evidence target: ${target}`); const edge = makeEdge(evidenceId, target, operation.evidence.relationship === "contradicts" ? "contradicts" : operation.evidence.relationship === "supports" ? "supports" : "qualifies"); if (!graph.edges.some((candidate) => candidate.id === edge.id)) graph.edges.push(edge); }
    changed.push(evidenceId);
  } else if (operation.kind === "scope_override") {
    for (const id of operation.targetNodeIds) { const node = nodeById(graph, id); if (!node) throw new Error(`invalid scope target: ${id}`); node.scope = { ...operation.scope, runId: graph.runId, overridden: true }; }
  } else {
    for (const id of operation.targetNodeIds) { const node = nodeById(graph, id); if (!node || node.kind !== "assumption") throw new Error(`invalid assumption target: ${id}`); node.metadata = { ...node.metadata, accepted: operation.decision === "accept", decisionOperationId: operation.id }; node.state = operation.decision === "accept" ? "supported" : "obsolete"; }
  }
  return changed;
}
export function applyLiveBranchOperation(graph: LiveEpistemicGraph, operation: LiveBranchOperation | unknown): string[] {
  const normalized = LiveBranchOperationSchema.safeParse(operation);
  return applyOperation(graph, normalized.success ? normalized.data : normalizeBranchOperation(operation, graph));
}
export const applyResearchRunOperation = applyLiveBranchOperation;

function compilerErrors(graph: LiveEpistemicGraph): LiveCompilerError[] {
  const errors: LiveCompilerError[] = [];
  for (const claim of graph.nodes.filter((node) => node.kind === "claim")) {
    if (claim.state === "conflicting") errors.push({ id: `live-error:${canonicalSha256({ code: "conflict", node: claim.id }).slice(0, 48)}`, code: "CONFLICTING_EVIDENCE", severity: "error", nodeId: claim.id, message: `${claim.label} has conflicting active evidence.`, relatedNodeIds: graph.edges.filter((edge) => edge.to === claim.id && edge.relation === "contradicts").map((edge) => edge.from).sort() });
    if (claim.state === "insufficient") errors.push({ id: `live-error:${canonicalSha256({ code: "insufficient", node: claim.id }).slice(0, 48)}`, code: "INSUFFICIENT_SUPPORT", severity: "error", nodeId: claim.id, message: `${claim.label} has no eligible support witness.`, relatedNodeIds: [] });
    if (claim.state === "blocked") errors.push({ id: `live-error:${canonicalSha256({ code: "scope", node: claim.id }).slice(0, 48)}`, code: "SCOPE_MISMATCH", severity: "error", nodeId: claim.id, message: `${claim.label} is blocked by a scope mismatch.`, relatedNodeIds: [] });
  }
  const decision = graph.nodes.find((node) => node.kind === "decision");
  if (decision?.state === "blocked") {
    errors.push({
      id: `live-error:${canonicalSha256({ code: "decision", node: decision.id }).slice(0, 48)}`,
      code: "BLOCKED_CRITERION",
      severity: "error",
      nodeId: decision.id,
      message: "The scientific decision remains blocked until the separate human decision checkpoint is approved.",
      relatedNodeIds: graph.nodes.filter((node) => node.kind === "claim" && node.state !== "supported").map((node) => node.id).sort(),
    });
  }
  return errors.sort((a, b) => a.id.localeCompare(b.id));
}

function diff(before: LiveEpistemicGraph, after: LiveEpistemicGraph, impactedNodeIds: readonly string[]): LiveSemanticDiff {
  const beforeIds = new Set(before.nodes.map((node) => node.id)); const afterIds = new Set(after.nodes.map((node) => node.id));
  const addedNodeIds = sortedUnique(after.nodes.filter((node) => !beforeIds.has(node.id)).map((node) => node.id));
  const removedNodeIds = sortedUnique(before.nodes.filter((node) => !afterIds.has(node.id)).map((node) => node.id));
  const changedNodes = before.nodes.map((oldNode) => { const next = nodeById(after, oldNode.id); if (!next || (next.state === oldNode.state && canonicalizeJson(next.metadata) === canonicalizeJson(oldNode.metadata) && canonicalizeJson(next.scope) === canonicalizeJson(oldNode.scope))) return null; return { nodeId: oldNode.id, before: oldNode.state, after: next.state, reason: `${oldNode.label} changed from ${oldNode.state} to ${next.state}.` }; }).filter((value): value is NonNullable<typeof value> => value !== null).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const summary = addedNodeIds.length || removedNodeIds.length || changedNodes.length ? [...changedNodes.map((item) => item.reason), ...addedNodeIds.map((id) => `${id} was added.`), ...removedNodeIds.map((id) => `${id} was removed.`)].join(" ") : "No epistemic nodes changed.";
  return { addedNodeIds, removedNodeIds, changedNodes, impactedNodeIds: sortedUnique(impactedNodeIds), summary };
}

function normalizeBranchOperation(raw: unknown, graph: LiveEpistemicGraph): LiveBranchOperation {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = value.kind ?? value.type;
  const id = typeof value.id === "string" && value.id.length > 0
    ? value.id
    : `live-operation:${canonicalSha256({ kind, targetNodeIds: value.targetNodeIds ?? value.targetNodeId ?? null, reason: value.reason ?? null, evidence: value.evidence ?? value.evidenceCard ?? null }).slice(0, 48)}`;
  const targets = Array.isArray(value.targetNodeIds)
    ? value.targetNodeIds.filter((item): item is string => typeof item === "string")
    : typeof value.targetNodeId === "string" ? [value.targetNodeId]
      : typeof value.targetClaimId === "string" ? [value.targetClaimId]
        : [];
  const resolveTarget = (target: string): string => {
    if (nodeById(graph, target)) return target;
    const bySource = graph.nodes.find((node) => node.sourceRef === target);
    return bySource?.id ?? target;
  };
  if (kind === "invalidate_evidence") {
    return LiveBranchOperationSchema.parse({ id, kind, targetNodeIds: targets.map(resolveTarget), reason: typeof value.reason === "string" ? value.reason : "Evidence invalidated in this branch." });
  }
  if (kind === "add_evidence") {
    const supplied = (value.evidence ?? value.evidenceCard ?? value) as Record<string, unknown>;
    const evidenceId = typeof supplied.id === "string" ? supplied.id : typeof value.nodeId === "string" ? value.nodeId : id;
    const targetCandidates = targets.length > 0
      ? targets
      : typeof supplied.subclaimId === "string" ? [supplied.subclaimId]
        : graph.nodes.filter((node) => node.kind === "claim").map((node) => node.id);
    const targetNodeIds = targetCandidates.map(resolveTarget).filter((target) => nodeById(graph, target));
    const scope = graph.nodes.find((node) => node.kind === "scope")?.scope ?? {
      runId: graph.runId, match: true, intendedApplication: "Live research run", populationOrGeography: "unspecified", timeHorizon: "unspecified", claimConstraints: [], constraints: [], overridden: false,
    };
    const rights = supplied.rights && typeof supplied.rights === "object" ? supplied.rights : { mayStore: "unknown", mayDisplay: "unknown", maySendToModel: "unknown", sourceId: null, chunkId: null };
    const trust = supplied.trust && typeof supplied.trust === "object" ? supplied.trust : { provenance: "research-run", evidenceMode: "unverified", deterministicVerification: "not_checked", modelAssessment: "insufficient", humanReview: "unreviewed", level: "unverified" };
    return LiveBranchOperationSchema.parse({ id, kind, targetNodeIds, evidence: { id: evidenceId, label: typeof supplied.label === "string" ? supplied.label : "Branch evidence", detail: typeof supplied.detail === "string" ? supplied.detail : typeof supplied.excerpt === "string" ? supplied.excerpt : "Evidence added in this branch.", relationship: supplied.relationship === "contradicts" || supplied.relationship === "unresolved" ? supplied.relationship : "supports", sourceRef: typeof supplied.sourceRef === "string" ? supplied.sourceRef : null, rights, scope, trust, metadata: supplied.metadata && typeof supplied.metadata === "object" ? supplied.metadata : {} } });
  }
  if (kind === "scope_override" || kind === "override_scope") {
    const scopeValue = (value.scope ?? value.scopeOverride) as Record<string, unknown> | undefined;
    const current = graph.nodes.find((node) => node.kind === "scope")?.scope;
    return LiveBranchOperationSchema.parse({ id, kind, targetNodeIds: targets.map(resolveTarget).filter((target) => nodeById(graph, target)), reason: typeof value.reason === "string" ? value.reason : "Scope overridden in this branch.", scope: { ...(current ?? { runId: graph.runId, match: false, intendedApplication: "Live research run", populationOrGeography: "unspecified", timeHorizon: "unspecified", claimConstraints: [], constraints: [], overridden: false }), ...(scopeValue ?? {}), runId: graph.runId, overridden: true } });
  }
  if (kind === "assumption_decision" || kind === "decide_assumption") {
    const decision = value.decision === "reject" || value.decision === "rejected" ? "reject" : "accept";
    return LiveBranchOperationSchema.parse({ id, kind, targetNodeIds: targets.map(resolveTarget), decision, reason: typeof value.reason === "string" ? value.reason : "Assumption decision recorded in this branch." });
  }
  throw new Error(`unknown live branch operation: ${String(kind)}`);
}

function normalizeOperations(input: CompileResearchRunInput, graph: LiveEpistemicGraph, external?: unknown): LiveBranchOperation[] {
  const operations = external ?? input.operations ?? input.appliedOperations ?? [];
  if (!Array.isArray(operations)) throw new Error("live branch operations must be an array");
  return operations.map((operation) => typeof operation === "string"
    ? normalizeBranchOperation({ id: operation, kind: "invalidate_evidence", targetNodeIds: [operation], reason: "Evidence invalidated in this branch." }, graph)
    : normalizeBranchOperation(operation, graph));
}

/** Compile a detached branch of a live run; the canonical ResearchRun is never mutated. */
export function compileResearchRun(input: CompileResearchRunInput): LiveEpistemicBuild;
export function compileResearchRun(run: ResearchRun, request?: { operations?: readonly unknown[]; branchOperations?: readonly unknown[]; appliedChangeIds?: readonly unknown[]; parentBuildId?: string | null }, _projection?: unknown): LiveEpistemicBuild;
export function compileResearchRun(inputOrRun: CompileResearchRunInput | ResearchRun, request?: { operations?: readonly unknown[]; branchOperations?: readonly unknown[]; appliedChangeIds?: readonly unknown[]; parentBuildId?: string | null }, _projection?: unknown): LiveEpistemicBuild {
  const input: CompileResearchRunInput = "run" in inputOrRun
    ? inputOrRun
    : { run: inputOrRun, parentBuildId: request?.parentBuildId };
  const run = ResearchRunSchema.parse(structuredClone(input.run));
  const before = _projection === undefined
    ? projectResearchRun(run)
    : LiveEpistemicGraphSchema.parse(structuredClone(_projection));
  const graph = structuredClone(before) as LiveEpistemicGraph;
  const externalOperations = "run" in inputOrRun ? undefined : request?.operations ?? request?.branchOperations ?? request?.appliedChangeIds;
  const operations = normalizeOperations(input, graph, externalOperations); const changed: string[] = [];
  for (const operation of operations) changed.push(...applyOperation(graph, operation));
  recompute(graph);
  const impactedNodeIds = computeLiveImpactClosure(graph, changed); const errors = compilerErrors(graph);
  const claimIds = graph.nodes.filter((node) => node.kind === "claim").map((node) => node.id); const witnesses = claimIds.flatMap((id) => supportWitnesses(graph, id));
  const breakingSets = claimIds.flatMap((id) => computeLiveBreakingSets(graph, id));
  const uniqueWitnesses = witnesses.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index).sort((a, b) => a.id.localeCompare(b.id));
  const uniqueBreakingSets = breakingSets.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index).sort((a, b) => a.id.localeCompare(b.id));
  const semanticDiff = diff(before, graph, impactedNodeIds); const blockers = errors.filter((error) => error.severity === "error").map((error) => error.nodeId).sort();
  const decision = { status: blockers.length ? "failing" as const : "passing" as const, label: blockers.length ? "Live research branch blocked" : "Live research branch passes compiler checks", blockerNodeIds: sortedUnique(blockers) };
  const payload = { schemaVersion: LIVE_EPISTEMIC_CI_SCHEMA_VERSION, parentBuildId: input.parentBuildId ?? null, runId: graph.runId, runHash: graph.runHash, graphHash: graph.graphHash, appliedOperationIds: operations.map((operation) => operation.id), graph, impactedNodeIds, recomputedNodeIds: impactedNodeIds, errors, witnesses: uniqueWitnesses, breakingSets: uniqueBreakingSets, diff: semanticDiff, decision, pullRequest: { status: blockers.length ? "blocked" as const : "mergeable" as const, title: operations.length ? "Research PR: recompile live evidence branch" : "Live research evidence build", changedNodeIds: sortedUnique(changed), impactedNodeIds, compilerTestSummary: blockers.length ? `${blockers.length} blocking compiler checks remain.` : "All compiler checks pass.", unresolvedBlockers: sortedUnique(blockers), authorizationRequired: true } };
  const buildHash = canonicalSha256(payload);
  return LiveEpistemicBuildSchema.parse({ ...payload, buildId: `live-epistemic-build-${buildHash.slice(0, 12)}` });
}

export const compileLiveEpistemicBuild = compileResearchRun;
export const compileResearchRunBranch = compileResearchRun;
export const compileLiveBuild = compileResearchRun;

export function canonicalLiveBuildHash(build: LiveEpistemicBuild): string { return canonicalSha256(LiveEpistemicBuildSchema.parse(build)); }

/** Helpers for callers constructing operations without hand-writing IDs. */
export function createLiveOperationId(operation: Omit<LiveBranchOperation, "id">): string { return `live-operation:${canonicalSha256(operation).slice(0, 48)}`; }
