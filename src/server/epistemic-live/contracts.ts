import { z } from "zod";

import { DeclaredActorSchema, DecisionRationaleSchema } from "../../contracts";
import { LiveBranchOperationSchema } from "../../epistemic-ci/live";

export const EpistemicLiveSchemaVersion = "epistemic-live.v1" as const;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdSchema = z.string().trim().min(1).max(256);

/** A deliberately narrow branch vocabulary. Provider-specific fields stay behind the compiler adapter. */
const SimpleBranchOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invalidate_evidence"),
    targetNodeIds: z.array(IdSchema).min(1).max(256),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    kind: z.literal("add_evidence"),
    nodeId: IdSchema,
    label: z.string().trim().min(1).max(500),
    detail: z.string().trim().min(1).max(8_000),
    sourceRef: IdSchema.nullable().default(null),
  }).strict(),
]);
/** Accept the canonical live-lane operation contract plus the compact HTTP form. */
export const TypedBranchOperationSchema = z.union([LiveBranchOperationSchema, SimpleBranchOperationSchema]);
export type TypedBranchOperation = z.infer<typeof TypedBranchOperationSchema>;

export const EpistemicCompileRequestSchema = z.object({
  /** Existing fixture/compiler branches may identify changes this way. */
  appliedChangeIds: z.array(IdSchema).max(256).optional(),
  /** The live API uses typed operations; branchOperations is retained as a readable alias. */
  operations: z.array(TypedBranchOperationSchema).max(256).optional(),
  branchOperations: z.array(TypedBranchOperationSchema).max(256).optional(),
  expectedProjectionHash: HashSchema.optional(),
  /** Compatibility with graph-oriented Epistemic CI callers. */
  expectedGraphHash: HashSchema.optional(),
  parentBuildId: IdSchema.nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((input, context) => {
  const operationFields = [input.operations, input.branchOperations, input.appliedChangeIds]
    .filter((value) => value !== undefined);
  if (operationFields.length > 1) {
    context.addIssue({ code: "custom", path: [], message: "choose one branch operation representation" });
  }
});
export type EpistemicCompileRequest = z.infer<typeof EpistemicCompileRequestSchema>;

export const EpistemicReviewRequestSchema = z.object({
  appliedChangeIds: z.array(IdSchema).max(256).optional(),
  operations: z.array(TypedBranchOperationSchema).max(256).optional(),
  branchOperations: z.array(TypedBranchOperationSchema).max(256).optional(),
  expectedProjectionHash: HashSchema.optional(),
  expectedGraphHash: HashSchema.optional(),
  action: z.enum(["approve_evidence_update", "reject_evidence_update"]),
  declaredActor: DeclaredActorSchema,
  rationale: DecisionRationaleSchema,
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((input, context) => {
  const operationFields = [input.operations, input.branchOperations, input.appliedChangeIds]
    .filter((value) => value !== undefined);
  if (operationFields.length > 1) {
    context.addIssue({ code: "custom", path: [], message: "choose one branch operation representation" });
  }
  if (input.expectedProjectionHash === undefined && input.expectedGraphHash === undefined) {
    context.addIssue({ code: "custom", path: ["expectedProjectionHash"], message: "a stale-check hash is required" });
  }
});
export type EpistemicReviewRequest = z.infer<typeof EpistemicReviewRequestSchema>;

export const EpistemicProjectionEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1).max(100),
  runId: IdSchema,
  revision: IdSchema,
  projection: z.unknown(),
  projectionHash: HashSchema,
}).strict();
export type EpistemicProjectionEnvelope = z.infer<typeof EpistemicProjectionEnvelopeSchema>;

export const EpistemicReceiptSchema = z.object({
  schemaVersion: z.string().min(1).max(100),
  receiptVersion: z.literal("epistemic-live.receipt.v1"),
  runId: IdSchema,
  revision: IdSchema,
  action: z.enum(["approve_evidence_update", "reject_evidence_update"]),
  declaredActor: DeclaredActorSchema,
  rationale: DecisionRationaleSchema,
  idempotencyKey: z.string().min(1).max(200),
  projectionHash: HashSchema,
  buildHash: HashSchema,
  graphHash: HashSchema.nullable(),
  evidenceUpdateStatus: z.enum(["merged_with_blockers", "rejected"]),
  scientificDecisionApproved: z.literal(false),
  receiptHash: HashSchema,
}).strict();
export type EpistemicReceipt = z.infer<typeof EpistemicReceiptSchema>;
