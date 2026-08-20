import { canonicalSha256 } from "../contracts";
import { goldenRunV02 } from "../fixtures/golden-run-v0.2";
import {
  EPISTEMIC_CI_SCHEMA_VERSION,
  EpistemicChangeSchema,
  EpistemicGraphSchema,
  type EpistemicChange,
  type EpistemicEdge,
  type EpistemicGraph,
  type EpistemicNode,
} from "./contracts";

const FIXTURE_ID = goldenRunV02.id;
const FIXTURE_HASH = canonicalSha256(goldenRunV02);

const passageDetails: Record<string, string> = {
  "gf-evidence-01": "Drying-limited paper-battery configuration; performance decreased after one hour.",
  "gf-evidence-02": "Unloaded voltage-retention result; no sensor duty cycle was tested.",
  "gf-evidence-03": "Configuration-specific 30 µW duration result in a physiological electrolyte.",
  "gf-evidence-04": "Biodegradable humidity-sensor component evidence, without battery integration.",
  "gf-evidence-05": "Bounded residual-ingestion hazard for spent button batteries.",
  "gf-evidence-06": "Biodegradable chipless sensor feasibility evidence, without power integration.",
  "gf-evidence-07": "Application-specific dissolution, electrical, and mechanical requirements remain unmeasured.",
};

function node(
  value: Omit<EpistemicNode, "metadata"> & {
    metadata?: EpistemicNode["metadata"];
  },
): EpistemicNode {
  return {
    ...value,
    metadata: value.metadata ?? {},
  };
}

function edge(
  from: string,
  to: string,
  relation: EpistemicEdge["relation"],
): EpistemicEdge {
  return { id: `${from}--${relation}-->${to}`, from, to, relation };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function makeGraph(): EpistemicGraph {
  const nodes: EpistemicNode[] = [];
  for (const card of goldenRunV02.evidenceCards) {
    nodes.push(
      node({
        id: `passage:${card.id}`,
        kind: "passage",
        label: card.id,
        state:
          card.relationship === "contradicts"
            ? "conflicting"
            : card.relationship === "supports"
              ? "supported"
              : "insufficient",
        detail: card.excerpt,
        sourceRef: card.id,
        mutable: true,
        metadata: {
          relationship: card.relationship,
          scopeMatch: false,
          directForTarget: false,
          active: true,
        },
      }),
    );
  }

  nodes.push(
    node({
      id: "scope:target-sensor-load",
      kind: "scope",
      label: "Target application scope",
      state: "supported",
      detail: goldenRunV02.intake.intendedApplication,
      sourceRef: null,
      mutable: true,
      metadata: { load: "integrated sensor duty cycle", durationHours: 72 },
    }),
    node({
      id: "assumption:load-equivalence",
      kind: "assumption",
      label: "Unloaded-to-loaded equivalence",
      state: "insufficient",
      detail: "An unloaded voltage-retention result can stand in for loaded sensor operation.",
      sourceRef: "gf-evidence-02",
      mutable: true,
      metadata: { accepted: false, scopeMatch: false },
    }),
    node({
      id: "claim:loaded-duration",
      kind: "claim",
      label: "Loaded 72-hour operation",
      state: "conflicting",
      detail: goldenRunV02.conclusions.find((x) => x.subclaimId === "gf-claim-duration")!.conclusion,
      sourceRef: "gf-claim-duration",
      mutable: false,
      metadata: { subclaimId: "gf-claim-duration", target: "loaded-duration" },
    }),
    node({
      id: "claim:integration",
      kind: "claim",
      label: "Integrated biodegradable power system",
      state: "insufficient",
      detail: goldenRunV02.conclusions.find((x) => x.subclaimId === "gf-claim-integration")!.conclusion,
      sourceRef: "gf-claim-integration",
      mutable: false,
      metadata: { subclaimId: "gf-claim-integration" },
    }),
    node({
      id: "criterion:duration",
      kind: "criterion",
      label: "Duration criterion",
      state: "conflicting",
      detail: "Prototype completes the exact integrated sensor load for 72 hours.",
      sourceRef: null,
      mutable: false,
      metadata: { criterion: "duration", required: true },
    }),
    node({
      id: "criterion:comparator",
      kind: "criterion",
      label: "Comparator adequacy",
      state: "blocked",
      detail: "A preregistered comparison against a specified lithium coin cell is not yet measured.",
      sourceRef: "gf-objection-calibration",
      mutable: false,
      metadata: { criterion: "comparator", required: true },
    }),
    node({
      id: "criterion:degradation-safety",
      kind: "criterion",
      label: "Degradation-product safety",
      state: "blocked",
      detail: "Qualified degradation-product and disposal-environment review is unresolved.",
      sourceRef: "gf-objection-degradation",
      mutable: false,
      metadata: { criterion: "degradation_safety", required: true },
    }),
    node({
      id: "gap:loaded-duration",
      kind: "gap",
      label: "Missing loaded-duration evidence",
      state: "blocked",
      detail: goldenRunV02.researchGaps[0]?.impactRationale ?? "Loaded duration is unmeasured.",
      sourceRef: "gf-gap-loaded-duration",
      mutable: false,
      metadata: { gapId: "gf-gap-loaded-duration" },
    }),
    node({
      id: "experiment:loaded-comparison",
      kind: "experiment",
      label: "72-hour loaded comparison",
      state: "blocked",
      detail: goldenRunV02.experiment?.objective ?? "Run the preregistered loaded comparison.",
      sourceRef: "gf-gap-loaded-duration",
      mutable: false,
      metadata: { protocolId: "gf-gap-loaded-duration" },
    }),
    node({
      id: "objection:comparator",
      kind: "objection",
      label: "Independent load verification",
      state: "blocked",
      detail: "The programmed load requires independent verification.",
      sourceRef: "gf-objection-calibration",
      mutable: false,
      metadata: { severity: "high" },
    }),
    node({
      id: "objection:degradation-safety",
      kind: "objection",
      label: "Unknown degradation products",
      state: "blocked",
      detail: "No approved degradation-product or disposal-environment evidence exists.",
      sourceRef: "gf-objection-degradation",
      mutable: false,
      metadata: { severity: "critical" },
    }),
    node({
      id: "decision:replacement",
      kind: "decision",
      label: "Replace the lithium coin cell",
      state: "blocked",
      detail: "Overall replacement remains bounded and failing until duration, comparator, and safety criteria pass.",
      sourceRef: "gf-decision-final",
      mutable: false,
      metadata: { status: "failing", decision: "approve bounded educational pilot only" },
    }),
  );

  const edges: EpistemicEdge[] = [
    edge("passage:gf-evidence-01", "claim:loaded-duration", "contradicts"),
    edge("passage:gf-evidence-02", "claim:loaded-duration", "qualifies"),
    edge("passage:gf-evidence-03", "claim:loaded-duration", "supports"),
    edge("passage:gf-evidence-04", "claim:integration", "supports"),
    edge("passage:gf-evidence-06", "claim:integration", "supports"),
    edge("passage:gf-evidence-07", "claim:integration", "qualifies"),
    edge("passage:gf-evidence-07", "criterion:degradation-safety", "blocks"),
    edge("scope:target-sensor-load", "claim:loaded-duration", "depends_on"),
    edge("assumption:load-equivalence", "claim:loaded-duration", "supports"),
    edge("claim:loaded-duration", "criterion:duration", "tests"),
    edge("claim:integration", "criterion:duration", "qualifies"),
    edge("claim:loaded-duration", "gap:loaded-duration", "blocks"),
    edge("claim:integration", "gap:loaded-duration", "blocks"),
    edge("gap:loaded-duration", "experiment:loaded-comparison", "tests"),
    edge("experiment:loaded-comparison", "criterion:duration", "tests"),
    edge("objection:comparator", "criterion:comparator", "blocks"),
    edge("objection:degradation-safety", "criterion:degradation-safety", "blocks"),
    edge("criterion:duration", "decision:replacement", "depends_on"),
    edge("criterion:comparator", "decision:replacement", "blocks"),
    edge("criterion:degradation-safety", "decision:replacement", "blocks"),
  ];
  const payload = {
    schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
    fixtureId: FIXTURE_ID,
    fixtureHash: FIXTURE_HASH,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
  };
  return EpistemicGraphSchema.parse({ ...payload, graphHash: canonicalSha256(payload) });
}

export const CURATED_EPISTEMIC_CHANGES: readonly EpistemicChange[] = Object.freeze([
  EpistemicChangeSchema.parse({
    id: "remove-drying-contradiction",
    kind: "invalidate_evidence",
    label: "Remove drying contradiction",
    description: "Invalidate the drying-limited paper-battery passage in this branch.",
    targetNodeIds: ["passage:gf-evidence-01"],
    introducedNodeIds: [],
    requires: [],
  }),
  EpistemicChangeSchema.parse({
    id: "add-direct-loaded-72h",
    kind: "add_evidence",
    label: "Add direct loaded 72-hour result",
    description: "Add a fixture passage matching the integrated sensor load and 72-hour target.",
    targetNodeIds: ["claim:loaded-duration"],
    introducedNodeIds: ["passage:direct-loaded-72h"],
    requires: [],
  }),
]);

export const goldenEpistemicGraph: Readonly<EpistemicGraph> = deepFreeze(makeGraph());

export function getCuratedEpistemicChanges(): readonly EpistemicChange[] {
  return CURATED_EPISTEMIC_CHANGES.map((change) => structuredClone(change));
}

export function projectGoldenRun(run: unknown = goldenRunV02): EpistemicGraph {
  void run;
  return structuredClone(goldenEpistemicGraph);
}

export function getGoldenFixtureIdentity(): { id: string; hash: string } {
  return { id: FIXTURE_ID, hash: FIXTURE_HASH };
}

export { passageDetails };
