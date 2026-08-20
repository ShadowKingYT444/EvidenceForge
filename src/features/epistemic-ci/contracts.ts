import { z } from "zod";

export const changeIdSchema = z.enum([
  "remove-drying-contradiction",
  "add-direct-loaded-72h",
]);

const idSchema = z.string().min(1).max(256);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const metadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()]),
);

export const nodeStateSchema = z.enum([
  "supported",
  "conflicting",
  "insufficient",
  "blocked",
  "resolved",
  "obsolete",
]);

export const epistemicNodeSchema = z
  .object({
    id: idSchema,
    kind: z.enum([
      "passage",
      "scope",
      "assumption",
      "claim",
      "criterion",
      "gap",
      "experiment",
      "objection",
      "decision",
    ]),
    label: z.string().min(1),
    state: nodeStateSchema,
    detail: z.string().min(1),
    sourceRef: idSchema.nullable(),
    mutable: z.boolean(),
    metadata: metadataSchema,
  })
  .strict();

export const epistemicEdgeSchema = z
  .object({
    id: idSchema,
    from: idSchema,
    to: idSchema,
    relation: z.enum([
      "supports",
      "contradicts",
      "depends_on",
      "qualifies",
      "tests",
      "blocks",
      "overrides",
    ]),
  })
  .strict();

const epistemicGraphSchema = z
  .object({
    schemaVersion: z.literal("epistemic-ci.v1"),
    fixtureId: idSchema,
    fixtureHash: hashSchema,
    nodes: z.array(epistemicNodeSchema),
    edges: z.array(epistemicEdgeSchema),
    graphHash: hashSchema,
  })
  .strict();

export const epistemicChangeSchema = z
  .object({
    id: changeIdSchema,
    kind: z.enum(["invalidate_evidence", "add_evidence"]),
    label: z.string().min(1),
    description: z.string().min(1),
    targetNodeIds: z.array(idSchema).min(1),
    introducedNodeIds: z.array(idSchema),
    requires: z.array(z.string().min(1)),
  })
  .strict();

const compilerErrorSchema = z
  .object({
    id: idSchema,
    code: z.enum([
      "CONFLICTING_EVIDENCE",
      "INSUFFICIENT_SUPPORT",
      "SCOPE_MISMATCH",
      "BLOCKED_CRITERION",
      "OBSOLETE_EXPERIMENT",
      "INVALID_CHANGE",
    ]),
    severity: z.enum(["error", "warning"]),
    nodeId: idSchema,
    message: z.string().min(1),
    relatedNodeIds: z.array(idSchema),
  })
  .strict();

const supportWitnessSchema = z
  .object({
    id: idSchema,
    targetNodeId: idSchema,
    nodeIds: z.array(idSchema).min(1),
    edgeIds: z.array(idSchema),
    explanation: z.string().min(1),
  })
  .strict();

const breakingSetSchema = z
  .object({
    id: idSchema,
    targetNodeId: idSchema,
    nodeIds: z.array(idSchema).min(1),
    explanation: z.string().min(1),
  })
  .strict();

const semanticDiffSchema = z
  .object({
    addedNodeIds: z.array(idSchema),
    removedNodeIds: z.array(idSchema),
    changedNodes: z.array(
      z
        .object({
          nodeId: idSchema,
          before: nodeStateSchema.nullable(),
          after: nodeStateSchema.nullable(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    impactedNodeIds: z.array(idSchema),
    summary: z.string().min(1),
  })
  .strict();

const pullRequestSchema = z
  .object({
    status: z.enum(["open", "mergeable", "blocked"]),
    title: z.string().min(1),
    changedNodeIds: z.array(idSchema),
    impactedNodeIds: z.array(idSchema),
    compilerTestSummary: z.string().min(1),
    unresolvedBlockers: z.array(idSchema),
    authorizationRequired: z.boolean(),
  })
  .strict();

export const epistemicBuildSchema = z
  .object({
    schemaVersion: z.literal("epistemic-ci.v1"),
    buildId: idSchema,
    parentBuildId: idSchema.nullable(),
    fixtureId: idSchema,
    fixtureHash: hashSchema,
    graphHash: hashSchema,
    appliedChangeIds: z.array(changeIdSchema),
    graph: epistemicGraphSchema,
    impactedNodeIds: z.array(idSchema),
    recomputedNodeIds: z.array(idSchema),
    errors: z.array(compilerErrorSchema),
    witnesses: z.array(supportWitnessSchema),
    breakingSets: z.array(breakingSetSchema),
    diff: semanticDiffSchema,
    decision: z
      .object({
        status: z.enum(["passing", "failing"]),
        label: z.string().min(1),
        blockerNodeIds: z.array(idSchema),
      })
      .strict(),
    pullRequest: pullRequestSchema,
  })
  .strict();

export const demoResponseSchema = z
  .object({
    schemaVersion: z.literal("epistemic-ci.v1"),
    mode: z.literal("fixture"),
    disclosure: z.string().min(1),
    fixture: z
      .object({
        id: idSchema,
        hash: hashSchema,
      })
      .strict(),
    baseBuild: epistemicBuildSchema,
    changes: z.array(epistemicChangeSchema).length(2),
  })
  .strict();

export const compileResponseSchema = epistemicBuildSchema;

export const reviewResponseSchema = z
  .object({
    build: epistemicBuildSchema,
    receipt: z
      .object({
        schemaVersion: z.literal("epistemic-ci.v1"),
        receiptVersion: z.literal("epistemic-ci.receipt.v1"),
        action: z.enum(["approve_evidence_update", "reject_evidence_update"]),
        declaredActor: z.string().min(1),
        rationale: z.string().min(1),
        buildId: idSchema,
        buildHash: hashSchema,
        graphHash: hashSchema,
        appliedChangeIds: z.array(changeIdSchema),
        evidenceUpdateStatus: z.enum(["merged_with_blockers", "rejected"]),
        scientificDecisionApproved: z.literal(false),
        decision: z
          .object({
            status: z.enum(["passing", "failing"]),
            label: z.string().min(1),
            blockerNodeIds: z.array(idSchema),
          })
          .strict(),
        receiptHash: hashSchema,
      })
      .strict(),
    canonicalExport: z.string().min(2),
    evidenceUpdateStatus: z.enum(["merged_with_blockers", "rejected"]),
    scientificDecisionApproved: z.literal(false),
  })
  .strict();

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        recoverable: z.boolean().optional(),
        resetRecommended: z.boolean().optional(),
        expectedGraphHash: hashSchema.optional(),
        actualGraphHash: hashSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type ChangeId = z.infer<typeof changeIdSchema>;
export type EpistemicNode = z.infer<typeof epistemicNodeSchema>;
export type EpistemicEdge = z.infer<typeof epistemicEdgeSchema>;
export type EpistemicBuild = z.infer<typeof epistemicBuildSchema>;
export type EpistemicChange = z.infer<typeof epistemicChangeSchema>;
export type DemoResponse = z.infer<typeof demoResponseSchema>;
export type CompileResponse = z.infer<typeof compileResponseSchema>;
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;
