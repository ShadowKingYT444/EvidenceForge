import { canonicalSha256, canonicalizeJson } from "../contracts";
import {
  CURATED_EPISTEMIC_CHANGES,
  getGoldenFixtureIdentity,
  passageDetails,
  projectGoldenRun,
} from "./fixture";
import {
  CompileInputSchema,
  EPISTEMIC_CI_SCHEMA_VERSION,
  EpistemicBuildSchema,
  type BreakingSet,
  type CompilerError,
  type CompileInput,
  type EpistemicBuild,
  type EpistemicChange,
  type EpistemicEdge,
  type EpistemicGraph,
  type EpistemicNode,
  type SupportWitness,
} from "./contracts";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function nodeById(graph: EpistemicGraph, id: string): EpistemicNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function incomingEdges(graph: EpistemicGraph, nodeId: string): EpistemicEdge[] {
  return graph.edges.filter((edge) => edge.to === nodeId);
}

function isActive(node: EpistemicNode | undefined): boolean {
  return node !== undefined && node.metadata.active !== false && node.state !== "obsolete";
}

function copyGraph(graph: EpistemicGraph): EpistemicGraph {
  return structuredClone(graph);
}

function updateNode(
  graph: EpistemicGraph,
  id: string,
  update: Partial<Pick<EpistemicNode, "state" | "detail" | "metadata">>,
): void {
  const current = nodeById(graph, id);
  if (!current) return;
  Object.assign(current, update);
}

function directLoadedNode(): EpistemicNode {
  return {
    id: "passage:direct-loaded-72h",
    kind: "passage",
    label: "direct-loaded-72h",
    state: "supported",
    detail:
      "Fixture result: the integrated humidity-sensor load completed 72 hours without preregistered failure.",
    sourceRef: "direct-loaded-72h",
    mutable: true,
    metadata: {
      relationship: "supports",
      scopeMatch: true,
      directForTarget: true,
      active: true,
      evidenceMode: "fixture",
    },
  };
}

function applyChange(graph: EpistemicGraph, change: EpistemicChange): string[] {
  const changedIds = [...change.targetNodeIds, ...change.introducedNodeIds];
  if (change.id === "remove-drying-contradiction") {
    for (const id of change.targetNodeIds) {
      const target = nodeById(graph, id);
      if (target) {
        target.state = "obsolete";
        target.metadata = { ...target.metadata, active: false };
      }
    }
  } else if (change.id === "add-direct-loaded-72h") {
    if (!nodeById(graph, "passage:direct-loaded-72h")) {
      graph.nodes.push(directLoadedNode());
      graph.edges.push({
        id: "passage:direct-loaded-72h--supports-->claim:loaded-duration",
        from: "passage:direct-loaded-72h",
        to: "claim:loaded-duration",
        relation: "supports",
      });
    }
  }
  return changedIds;
}

function recomputeDerivedStates(graph: EpistemicGraph): void {
  const contradiction = isActive(nodeById(graph, "passage:gf-evidence-01"));
  const directLoaded = isActive(nodeById(graph, "passage:direct-loaded-72h"));
  const durationState: EpistemicNode["state"] = contradiction
    ? "conflicting"
    : directLoaded
      ? "supported"
      : "insufficient";
  updateNode(graph, "claim:loaded-duration", { state: durationState });
  updateNode(graph, "criterion:duration", { state: durationState });
  updateNode(graph, "gap:loaded-duration", {
    state: durationState === "supported" ? "resolved" : "blocked",
  });
  updateNode(graph, "experiment:loaded-comparison", {
    state: durationState === "supported" ? "obsolete" : "blocked",
  });
  updateNode(graph, "decision:replacement", {
    state: "blocked",
    metadata: {
      ...(nodeById(graph, "decision:replacement")?.metadata ?? {}),
      status: "failing",
    },
  });
  const payload = {
    schemaVersion: graph.schemaVersion,
    fixtureId: graph.fixtureId,
    fixtureHash: graph.fixtureHash,
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  };
  graph.nodes = payload.nodes;
  graph.edges = payload.edges;
  graph.graphHash = canonicalSha256(payload);
}

/** Return the roots and every directed descendant reachable from them. */
export function computeImpactClosure(
  graph: EpistemicGraph,
  changedNodeIds: readonly string[],
): string[] {
  const seen = new Set(changedNodeIds);
  const queue = [...changedNodeIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return sortedUnique([...seen]);
}

export const getImpactedDescendants = computeImpactClosure;
export const impactedDescendantClosure = computeImpactClosure;

type Path = { nodeIds: string[]; edgeIds: string[] };

function sourceCanSupport(graph: EpistemicGraph, node: EpistemicNode, target: EpistemicNode): boolean {
  if (!isActive(node) || node.state !== "supported") return false;
  if (target.id === "claim:loaded-duration" && node.metadata.directForTarget !== true) {
    return false;
  }
  return true;
}

function supportPaths(graph: EpistemicGraph, targetId: string, trail = new Set<string>()): Path[] {
  const target = nodeById(graph, targetId);
  if (!target || !isActive(target) || target.state !== "supported" || trail.has(targetId)) {
    return [];
  }
  const nextTrail = new Set(trail).add(targetId);
  const paths: Path[] = [];
  for (const relation of incomingEdges(graph, targetId).filter((item) => item.relation === "supports")) {
    const source = nodeById(graph, relation.from);
    if (!source) continue;
    if (sourceCanSupport(graph, source, target)) {
      paths.push({ nodeIds: [source.id], edgeIds: [relation.id] });
    }
    for (const path of supportPaths(graph, source.id, nextTrail)) {
      paths.push({
        nodeIds: [...path.nodeIds, source.id],
        edgeIds: [...path.edgeIds, relation.id],
      });
    }
  }
  const unique = new Map<string, Path>();
  for (const path of paths) {
    const key = sortedUnique(path.nodeIds).join("|");
    unique.set(key, path);
  }
  return [...unique.values()].sort((a, b) => {
    const length = a.nodeIds.length - b.nodeIds.length;
    return length || a.nodeIds.join("|").localeCompare(b.nodeIds.join("|"));
  });
}

/** Exact minimal support witnesses for the currently compiled graph. */
export function computeMinimalSupportWitnesses(
  graph: EpistemicGraph,
  targetNodeId: string,
): SupportWitness[] {
  const paths = supportPaths(graph, targetNodeId);
  const shortest = paths.length === 0 ? [] : paths.filter((path) => path.nodeIds.length === paths[0]!.nodeIds.length);
  return shortest.map((path) => ({
    id: `witness:${targetNodeId}:${sortedUnique(path.nodeIds).join("+")}`,
    targetNodeId,
    nodeIds: sortedUnique(path.nodeIds),
    edgeIds: sortedUnique(path.edgeIds),
    explanation: `The target is supported by ${sortedUnique(path.nodeIds).join(", ")}.`,
  }));
}

export const computeSupportWitnesses = computeMinimalSupportWitnesses;
export const minimalSupportWitnesses = computeMinimalSupportWitnesses;

function combinations(values: string[], size: number): string[][] {
  const results: string[][] = [];
  const walk = (start: number, picked: string[]): void => {
    if (picked.length === size) {
      results.push([...picked]);
      return;
    }
    for (let index = start; index <= values.length - (size - picked.length); index += 1) {
      walk(index + 1, [...picked, values[index]!]);
    }
  };
  walk(0, []);
  return results;
}

/** Enumerate exact minimal mutable-node cut sets, bounded to size three. */
export function computeMinimalBreakingSets(
  graph: EpistemicGraph,
  targetNodeId: string,
  maxSize = 3,
): BreakingSet[] {
  const baseWitnesses = computeMinimalSupportWitnesses(graph, targetNodeId);
  if (baseWitnesses.length === 0) return [];
  const candidates = sortedUnique(
    baseWitnesses.flatMap((witness) => witness.nodeIds.filter((id) => nodeById(graph, id)?.mutable)),
  );
  const found: string[][] = [];
  for (let size = 1; size <= Math.min(maxSize, candidates.length); size += 1) {
    for (const subset of combinations(candidates, size)) {
      if (found.some((prior) => prior.every((id) => subset.includes(id)))) continue;
      const remaining = baseWitnesses.filter((witness) => !witness.nodeIds.some((id) => subset.includes(id)));
      if (remaining.length === 0) found.push(subset);
    }
  }
  return found
    .sort((a, b) => a.length - b.length || a.join("|").localeCompare(b.join("|")))
    .map((nodeIds) => ({
      id: `breaking-set:${targetNodeId}:${nodeIds.join("+")}`,
      targetNodeId,
      nodeIds,
      explanation: `Removing ${nodeIds.join(", ")} removes every minimal support witness.`,
    }));
}

export const computeBreakingSets = computeMinimalBreakingSets;

function compilerErrors(graph: EpistemicGraph): CompilerError[] {
  const errors: CompilerError[] = [];
  const duration = nodeById(graph, "claim:loaded-duration");
  if (duration?.state === "conflicting") {
    errors.push({
      id: "error:loaded-duration-conflict",
      code: "CONFLICTING_EVIDENCE",
      severity: "error",
      nodeId: duration.id,
      message: "Loaded 72-hour operation has both support and a drying-limited contradiction.",
      relatedNodeIds: ["passage:gf-evidence-01", "passage:gf-evidence-02", "passage:gf-evidence-03"],
    });
  } else if (duration?.state === "insufficient") {
    errors.push({
      id: "error:loaded-duration-insufficient",
      code: "INSUFFICIENT_SUPPORT",
      severity: "error",
      nodeId: duration.id,
      message: "Removing negative evidence did not create a loaded 72-hour support witness.",
      relatedNodeIds: ["scope:target-sensor-load", "gap:loaded-duration"],
    });
  }
  errors.push(
    {
      id: "error:comparator-blocked",
      code: "BLOCKED_CRITERION",
      severity: "error",
      nodeId: "criterion:comparator",
      message: "Comparator adequacy remains blocked pending independent loaded comparison.",
      relatedNodeIds: ["objection:comparator", "experiment:loaded-comparison"],
    },
    {
      id: "error:degradation-safety-blocked",
      code: "BLOCKED_CRITERION",
      severity: "error",
      nodeId: "criterion:degradation-safety",
      message: "Degradation-product safety remains unresolved and blocks replacement.",
      relatedNodeIds: ["objection:degradation-safety", "passage:gf-evidence-07"],
    },
  );
  if (nodeById(graph, "experiment:loaded-comparison")?.state === "obsolete") {
    errors.push({
      id: "warning:experiment-obsolete",
      code: "OBSOLETE_EXPERIMENT",
      severity: "warning",
      nodeId: "experiment:loaded-comparison",
      message: "The loaded-duration experiment is obsolete because direct loaded 72-hour evidence exists.",
      relatedNodeIds: ["passage:direct-loaded-72h", "gap:loaded-duration"],
    });
  }
  return errors;
}

function semanticDiff(before: EpistemicGraph, after: EpistemicGraph, impactedNodeIds: string[]) {
  const beforeIds = new Set(before.nodes.map((node) => node.id));
  const afterIds = new Set(after.nodes.map((node) => node.id));
  const addedNodeIds = sortedUnique(after.nodes.filter((node) => !beforeIds.has(node.id)).map((node) => node.id));
  const removedNodeIds = sortedUnique(before.nodes.filter((node) => !afterIds.has(node.id)).map((node) => node.id));
  const changedNodes = before.nodes
    .map((oldNode) => {
      const newNode = nodeById(after, oldNode.id);
      if (!newNode || newNode.state === oldNode.state) return null;
      let reason = `${oldNode.label} changed from ${oldNode.state} to ${newNode.state}.`;
      if (oldNode.id === "claim:loaded-duration" && newNode.state === "insufficient") {
        reason = "The contradiction was removed, but no direct loaded-operation warrant was added.";
      } else if (oldNode.id === "claim:loaded-duration" && newNode.state === "supported") {
        reason = "A direct result matches the integrated sensor load and 72-hour target.";
      }
      return { nodeId: oldNode.id, before: oldNode.state, after: newNode.state, reason };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const summary = changedNodes.length === 0 && addedNodeIds.length === 0 && removedNodeIds.length === 0
    ? "No epistemic nodes changed."
    : changedNodes.map((change) => change.reason).join(" ");
  return {
    addedNodeIds,
    removedNodeIds,
    changedNodes,
    impactedNodeIds: sortedUnique(impactedNodeIds),
    summary,
  };
}

function normalizeInput(input: CompileInput | ReadonlyArray<EpistemicChange["id"]>): CompileInput {
  const candidate = Array.isArray(input) ? { appliedChangeIds: [...input] } : input;
  const parsed = CompileInputSchema.parse(candidate);
  if (new Set(parsed.appliedChangeIds).size !== parsed.appliedChangeIds.length) {
    throw new Error("duplicate epistemic change IDs are not allowed");
  }
  return parsed;
}

export function compileEpistemicBuild(input: CompileInput | ReadonlyArray<EpistemicChange["id"]> = { appliedChangeIds: [] }): EpistemicBuild {
  const normalized = normalizeInput(input);
  const before = projectGoldenRun();
  const graph = copyGraph(before);
  const changedIds: string[] = [];
  for (const changeId of normalized.appliedChangeIds) {
    const change = CURATED_EPISTEMIC_CHANGES.find((item) => item.id === changeId);
    if (!change) throw new Error(`unknown epistemic change: ${changeId}`);
    changedIds.push(...applyChange(graph, change));
  }
  recomputeDerivedStates(graph);
  const impactedNodeIds = computeImpactClosure(graph, changedIds);
  const errors = compilerErrors(graph);
  const witnesses = ["claim:loaded-duration", "claim:integration", "claim:loaded-duration"]
    .flatMap((id) => computeMinimalSupportWitnesses(graph, id))
    .filter((witness, index, all) => all.findIndex((item) => item.id === witness.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id));
  const breakingSets = computeMinimalBreakingSets(graph, "claim:loaded-duration");
  const diff = semanticDiff(before, graph, impactedNodeIds);
  const decision = {
    status: "failing" as const,
    label: "Replacement decision blocked",
    blockerNodeIds: ["criterion:comparator", "criterion:degradation-safety"],
  };
  const pullRequest = {
    status: "blocked" as const,
    title: normalized.appliedChangeIds.length === 0 ? "Base evidence build" : "Research PR: recompile evidence change",
    changedNodeIds: sortedUnique(changedIds),
    impactedNodeIds,
    compilerTestSummary: errors.filter((error) => error.severity === "error").length === 0
      ? "All compiler checks pass."
      : `${errors.filter((error) => error.severity === "error").length} blocking compiler checks remain.`,
    unresolvedBlockers: decision.blockerNodeIds,
    authorizationRequired: true,
  };
  const payload = {
    schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
    parentBuildId: normalized.parentBuildId ?? null,
    fixtureId: graph.fixtureId,
    fixtureHash: graph.fixtureHash,
    graphHash: graph.graphHash,
    appliedChangeIds: normalized.appliedChangeIds,
    graph,
    impactedNodeIds,
    recomputedNodeIds: impactedNodeIds,
    errors,
    witnesses,
    breakingSets,
    diff,
    decision,
    pullRequest,
  };
  const buildHash = canonicalSha256(payload);
  return EpistemicBuildSchema.parse({
    ...payload,
    buildId: `epistemic-build-${buildHash.slice(0, 12)}`,
  });
}

export const compileBuild = compileEpistemicBuild;
export const compile = compileEpistemicBuild;

export function exportEpistemicBuild(build: EpistemicBuild): string {
  return canonicalizeJson(EpistemicBuildSchema.parse(build));
}

export function canonicalBuildHash(build: EpistemicBuild): string {
  return canonicalSha256(EpistemicBuildSchema.parse(build));
}

export function getEpistemicDemo(): {
  fixture: { id: string; hash: string };
  changes: readonly EpistemicChange[];
  baseBuild: EpistemicBuild;
} {
  return {
    fixture: getGoldenFixtureIdentity(),
    changes: CURATED_EPISTEMIC_CHANGES.map((change) => structuredClone(change)),
    baseBuild: compileEpistemicBuild({ appliedChangeIds: [] }),
  };
}

export { passageDetails };
