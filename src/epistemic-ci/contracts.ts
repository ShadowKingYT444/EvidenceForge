import { z } from "zod";

/** Versioned, deliberately small public contract for the Epistemic CI projection. */
export const EPISTEMIC_CI_SCHEMA_VERSION = "epistemic-ci.v1" as const;

const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ScalarSchema = z.union([z.string(), z.boolean(), z.number()]);
const MetadataSchema = z.record(z.string(), ScalarSchema);

export const EpistemicNodeKindSchema = z.enum([
  "passage",
  "scope",
  "assumption",
  "claim",
  "criterion",
  "gap",
  "experiment",
  "objection",
  "decision",
]);
export type EpistemicNodeKind = z.infer<typeof EpistemicNodeKindSchema>;

export const EpistemicNodeStateSchema = z.enum([
  "supported",
  "conflicting",
  "insufficient",
  "blocked",
  "resolved",
  "obsolete",
]);
export type EpistemicNodeState = z.infer<typeof EpistemicNodeStateSchema>;

export const EpistemicEdgeRelationSchema = z.enum([
  "supports",
  "contradicts",
  "depends_on",
  "qualifies",
  "tests",
  "blocks",
  "overrides",
]);
export type EpistemicEdgeRelation = z.infer<typeof EpistemicEdgeRelationSchema>;

export const EpistemicNodeSchema = z
  .object({
    id: IdSchema,
    kind: EpistemicNodeKindSchema,
    label: z.string().min(1),
    state: EpistemicNodeStateSchema,
    detail: z.string().min(1),
    sourceRef: IdSchema.nullable(),
    mutable: z.boolean(),
    metadata: MetadataSchema,
  })
  .strict();
export type EpistemicNode = z.infer<typeof EpistemicNodeSchema>;
export const NodeSchema = EpistemicNodeSchema;

export const EpistemicEdgeSchema = z
  .object({
    id: IdSchema,
    from: IdSchema,
    to: IdSchema,
    relation: EpistemicEdgeRelationSchema,
  })
  .strict();
export type EpistemicEdge = z.infer<typeof EpistemicEdgeSchema>;
export const EdgeSchema = EpistemicEdgeSchema;

export const EpistemicGraphSchema = z
  .object({
    schemaVersion: z.literal(EPISTEMIC_CI_SCHEMA_VERSION),
    fixtureId: IdSchema,
    fixtureHash: HashSchema,
    nodes: z.array(EpistemicNodeSchema),
    edges: z.array(EpistemicEdgeSchema),
    graphHash: HashSchema,
  })
  .strict();
export type EpistemicGraph = z.infer<typeof EpistemicGraphSchema>;
export const GraphSchema = EpistemicGraphSchema;

export const EpistemicChangeSchema = z
  .object({
    id: z.enum([
      "remove-drying-contradiction",
      "add-direct-loaded-72h",
    ]),
    kind: z.enum(["invalidate_evidence", "add_evidence"]),
    label: z.string().min(1),
    description: z.string().min(1),
    targetNodeIds: z.array(IdSchema).min(1),
    introducedNodeIds: z.array(IdSchema),
    requires: z.array(z.string().min(1)),
  })
  .strict();
export type EpistemicChange = z.infer<typeof EpistemicChangeSchema>;
export const ChangeSchema = EpistemicChangeSchema;

export const CompilerErrorSchema = z
  .object({
    id: IdSchema,
    code: z.enum([
      "CONFLICTING_EVIDENCE",
      "INSUFFICIENT_SUPPORT",
      "SCOPE_MISMATCH",
      "BLOCKED_CRITERION",
      "OBSOLETE_EXPERIMENT",
      "INVALID_CHANGE",
    ]),
    severity: z.enum(["error", "warning"]),
    nodeId: IdSchema,
    message: z.string().min(1),
    relatedNodeIds: z.array(IdSchema),
  })
  .strict();
export type CompilerError = z.infer<typeof CompilerErrorSchema>;

export const SupportWitnessSchema = z
  .object({
    id: IdSchema,
    targetNodeId: IdSchema,
    nodeIds: z.array(IdSchema).min(1),
    edgeIds: z.array(IdSchema),
    explanation: z.string().min(1),
  })
  .strict();
export type SupportWitness = z.infer<typeof SupportWitnessSchema>;
export const WitnessSchema = SupportWitnessSchema;

export const BreakingSetSchema = z
  .object({
    id: IdSchema,
    targetNodeId: IdSchema,
    nodeIds: z.array(IdSchema).min(1),
    explanation: z.string().min(1),
  })
  .strict();
export type BreakingSet = z.infer<typeof BreakingSetSchema>;
export const MinimalBreakingSetSchema = BreakingSetSchema;

export const NodeStateChangeSchema = z
  .object({
    nodeId: IdSchema,
    before: EpistemicNodeStateSchema.nullable(),
    after: EpistemicNodeStateSchema.nullable(),
    reason: z.string().min(1),
  })
  .strict();
export type NodeStateChange = z.infer<typeof NodeStateChangeSchema>;

export const SemanticDiffSchema = z
  .object({
    addedNodeIds: z.array(IdSchema),
    removedNodeIds: z.array(IdSchema),
    changedNodes: z.array(NodeStateChangeSchema),
    impactedNodeIds: z.array(IdSchema),
    summary: z.string().min(1),
  })
  .strict();
export type SemanticDiff = z.infer<typeof SemanticDiffSchema>;
export const SemanticBuildDiffSchema = SemanticDiffSchema;

export const CompilerDecisionSchema = z
  .object({
    status: z.enum(["passing", "failing"]),
    label: z.string().min(1),
    blockerNodeIds: z.array(IdSchema),
  })
  .strict();
export type CompilerDecision = z.infer<typeof CompilerDecisionSchema>;

export const ResearchPullRequestSchema = z
  .object({
    status: z.enum(["open", "mergeable", "blocked"]),
    title: z.string().min(1),
    changedNodeIds: z.array(IdSchema),
    impactedNodeIds: z.array(IdSchema),
    compilerTestSummary: z.string().min(1),
    unresolvedBlockers: z.array(IdSchema),
    authorizationRequired: z.boolean(),
  })
  .strict();
export type ResearchPullRequest = z.infer<typeof ResearchPullRequestSchema>;
export const ResearchPullRequestPreviewSchema = ResearchPullRequestSchema;

export const EpistemicBuildSchema = z
  .object({
    schemaVersion: z.literal(EPISTEMIC_CI_SCHEMA_VERSION),
    buildId: z.string().min(1),
    parentBuildId: z.string().min(1).nullable(),
    fixtureId: IdSchema,
    fixtureHash: HashSchema,
    graphHash: HashSchema,
    appliedChangeIds: z.array(EpistemicChangeSchema.shape.id),
    graph: EpistemicGraphSchema,
    impactedNodeIds: z.array(IdSchema),
    recomputedNodeIds: z.array(IdSchema),
    errors: z.array(CompilerErrorSchema),
    witnesses: z.array(SupportWitnessSchema),
    breakingSets: z.array(BreakingSetSchema),
    diff: SemanticDiffSchema,
    decision: CompilerDecisionSchema,
    pullRequest: ResearchPullRequestSchema,
  })
  .strict();
export type EpistemicBuild = z.infer<typeof EpistemicBuildSchema>;
export const BuildSchema = EpistemicBuildSchema;

export const CompileInputSchema = z
  .object({
    appliedChangeIds: z.array(EpistemicChangeSchema.shape.id),
    parentBuildId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type CompileInput = z.infer<typeof CompileInputSchema>;

export type EpistemicCiContracts = {
  node: EpistemicNode;
  edge: EpistemicEdge;
  graph: EpistemicGraph;
  build: EpistemicBuild;
};
