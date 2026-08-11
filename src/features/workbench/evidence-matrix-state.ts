import { types as nodeTypes } from "node:util";

import { ResearchRunSchema, type ResearchRun } from "../../contracts";
import { validateExecutionHistory } from "../../server/workflow/state-machine";

export const EVIDENCE_MATRIX_SCENARIOS = [
  "loading",
  "empty",
  "error",
  "duplicate",
  "long-content",
  "failure",
  "missing-evidence",
] as const;

export type EvidenceMatrixScenario = (typeof EVIDENCE_MATRIX_SCENARIOS)[number];
type MatrixState = "ready" | "loading" | "empty" | "error";
type CellRelationship = ResearchRun["evidenceCards"][number]["relationship"] | "mixed" | "missing";
type WarningState = "none" | "warning" | "mismatch" | "failure";

export type MatrixEvidence =
  | {
      id: string;
      state: "hidden";
      reasonCode: MatrixHiddenReasonCode;
    }
  | {
      id: string;
      state: "available";
      excerpt: string;
      location: string;
      contentScope: ResearchRun["sources"][number]["access"]["contentScope"];
      extractedResult: string;
      settingAndSample: string;
      studyType: string;
      limitation: string;
      conclusionStrengthWarning: string | null;
      extractionIssues: string[];
      deterministicVerification: ResearchRun["evidenceCards"][number]["deterministicVerification"];
      modelAssessment: ResearchRun["evidenceCards"][number]["modelAssessment"];
      humanReview: ResearchRun["evidenceCards"][number]["humanReview"];
    };

export type MatrixSourceLedger =
  | {
      state: "hidden";
      sourceId: string;
      reasonCode: MatrixHiddenReasonCode;
    }
  | {
      state: "available";
      sourceId: string;
      title: string;
      identifier: {
        value: string;
        href: string | null;
      };
      contentScope: ResearchRun["sources"][number]["access"]["contentScope"];
      identifierResolution: ResearchRun["sources"][number]["doiResolution"];
      accessDetails: {
        state: "available";
        provider: string;
        version: string | null;
        location: string;
        retrievedAt: string;
      };
      metadataVerification: {
        status: ResearchRun["sources"][number]["metadataVerification"]["status"];
        details: {
          state: "available";
          method: string;
          checkedAt: string | null;
          fieldDiffs: ResearchRun["sources"][number]["metadataVerification"]["fieldDiffs"];
        };
      };
      integrityNotices: Array<{
        kind: ResearchRun["sources"][number]["integrityNotices"][number]["kind"];
        href: string | null;
        affectsSource: boolean;
        checkedAt: string;
      }>;
      sourceWarnings: string[];
    };

export type MatrixWarningCondition = {
  kind: WarningState;
  label: string;
  symbol: string;
};

export type MatrixCell = {
  id: string;
  rowIndex: number;
  columnIndex: number;
  claimId: string;
  sourceId: string;
  claimLabel: string;
  sourceLabel: string;
  claimStatement: string;
  sourceDisplay:
    | { state: "hidden"; reasonCode: MatrixHiddenReasonCode }
    | { state: "available"; title: string; identifier: string };
  relationship: CellRelationship;
  relationshipLabel: string;
  relationshipSymbol: string;
  evidenceCount: number;
  evidenceIds: string[];
  warningState: WarningState;
  warningLabel: string;
  warningConditions: MatrixWarningCondition[];
  warnings: string[];
  accessibleLabel: string;
  sourceLedger: MatrixSourceLedger;
  evidence: MatrixEvidence[];
};

export type EvidenceMatrixModel = {
  state: MatrixState;
  disclosure: string | null;
  error: { code: string; message: string } | null;
  sources: Array<
    | {
        id: string;
        label: string;
        state: "hidden";
        reasonCode: MatrixHiddenReasonCode;
      }
    | {
        id: string;
        label: string;
        state: "available";
        title: string;
        identifier: string;
        metadataStatus: ResearchRun["sources"][number]["metadataVerification"]["status"];
      }
  >;
  rows: Array<{
    claim: { id: string; label: string; statement: string };
    cells: MatrixCell[];
  }>;
  summary: {
    claimCount: number;
    sourceCount: number;
    evidenceCount: number;
    missingCount: number;
  };
};

export type MatrixDisplayOverrides = ReadonlyMap<
  string,
  | { state: "available" }
  | { state: "hidden"; reasonCode: "packet_display_hidden" }
>;

export type MatrixHiddenReasonCode =
  | "packet_display_hidden"
  | "source_display_denied"
  | "source_display_unknown"
  | "chunk_display_denied"
  | "chunk_display_unknown";

type NormalizedDisplayOverrides = ReadonlyMap<string, "available" | "hidden">;

const relationshipPresentation: Record<
  CellRelationship,
  { label: string; symbol: string }
> = {
  supports: { label: "Supports", symbol: "+" },
  contradicts: { label: "Contradicts", symbol: "×" },
  unresolved: { label: "Unresolved", symbol: "?" },
  mixed: { label: "Mixed relationships", symbol: "±" },
  missing: { label: "Missing evidence", symbol: "∅" },
};

class MatrixProjectionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readResearchRun(input: unknown): ResearchRun {
  const snapshot = passiveSnapshot(input, new Set<object>());
  const parsed = ResearchRunSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new MatrixProjectionFailure(
      "matrix_contract_invalid",
      "The evidence packet does not match the approved run contract.",
    );
  }
  return parsed.data;
}

function passiveSnapshot(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MatrixProjectionFailure("matrix_input_invalid", "Non-finite numbers are not accepted.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new MatrixProjectionFailure("matrix_input_invalid", "Only passive JSON data is accepted.");
  }
  if (nodeTypes.isProxy(value)) {
    throw new MatrixProjectionFailure("matrix_input_proxy", "Proxy-backed input is not accepted.");
  }
  if (ancestors.has(value)) {
    throw new MatrixProjectionFailure("matrix_input_cycle", "Cyclic input is not accepted.");
  }

  const nextAncestors = new Set(ancestors).add(value);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    throw new MatrixProjectionFailure("matrix_input_invalid", "Symbol properties are not accepted.");
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new MatrixProjectionFailure("matrix_input_invalid", "Only standard arrays are accepted.");
    }
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      throw new MatrixProjectionFailure("matrix_input_accessor", "Accessor-backed input is not accepted.");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MatrixProjectionFailure("matrix_input_invalid", "Invalid array length.");
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        throw new MatrixProjectionFailure("matrix_input_invalid", "Sparse arrays are not accepted.");
      }
      if (!("value" in descriptor)) {
        throw new MatrixProjectionFailure("matrix_input_accessor", "Accessor-backed input is not accepted.");
      }
      result.push(passiveSnapshot(descriptor.value, nextAncestors));
    }
    const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
      throw new MatrixProjectionFailure("matrix_input_invalid", "Array properties are not accepted.");
    }
    return result;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new MatrixProjectionFailure("matrix_input_invalid", "Only plain objects are accepted.");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new MatrixProjectionFailure("matrix_input_accessor", "Accessor-backed input is not accepted.");
    }
    if (!descriptor.enumerable || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MatrixProjectionFailure("matrix_input_invalid", "Unsafe object properties are not accepted.");
    }
    result[key] = passiveSnapshot(descriptor.value, nextAncestors);
  }
  return result;
}

type MatrixIdentityIndex = {
  sourceIds: Set<string>;
  chunkIds: Set<string>;
  claimIds: Set<string>;
  evidenceIds: Set<string>;
  gapIds: Set<string>;
  executionIds: Set<string>;
  errorIds: Set<string>;
  objectionIds: Set<string>;
  knownIds: Set<string>;
};

function validateMatrixIdentities(run: ResearchRun): MatrixIdentityIndex {
  const decisions = [
    run.scopeDecision,
    run.packet?.freezeDecision,
    run.objectionDispositionDecision,
    run.finalDecision,
  ].filter((value): value is NonNullable<typeof value> => value !== null && value !== undefined);
  const groups: Array<[string, ReadonlyArray<{ id: string }>]> = [
    ["run", [run]],
    ["claim", run.claims],
    ["source", run.sources],
    ["chunk", run.chunks],
    ["evidence card", run.evidenceCards],
    ["research gap", run.researchGaps],
    ["execution", run.executions],
    ["error", run.errors],
    ["objection", run.review?.objections ?? []],
    ["decision", decisions],
    ["experiment abstention", run.experimentAbstention ? [run.experimentAbstention] : []],
  ];
  const owners = new Map<string, string>();

  for (const [group, records] of groups) {
    const local = new Set<string>();
    for (const { id } of records) {
      if (local.has(id)) {
        throw new MatrixProjectionFailure(
          "matrix_identity_duplicate",
          `Duplicate ${group} ID ${id} is not accepted.`,
        );
      }
      local.add(id);
      const owner = owners.get(id);
      if (owner) {
        throw new MatrixProjectionFailure(
          "matrix_identity_collision",
          `ID ${id} is shared by ${owner} and ${group} records.`,
        );
      }
      owners.set(id, group);
    }
  }

  return {
    sourceIds: new Set(run.sources.map(({ id }) => id)),
    chunkIds: new Set(run.chunks.map(({ id }) => id)),
    claimIds: new Set(run.claims.map(({ id }) => id)),
    evidenceIds: new Set(run.evidenceCards.map(({ id }) => id)),
    gapIds: new Set(run.researchGaps.map(({ id }) => id)),
    executionIds: new Set(run.executions.map(({ id }) => id)),
    errorIds: new Set(run.errors.map(({ id }) => id)),
    objectionIds: new Set((run.review?.objections ?? []).map(({ id }) => id)),
    knownIds: new Set(owners.keys()),
  };
}

function readDisplayOverrides(input: unknown): Map<string, "available" | "hidden"> {
  const normalized = new Map<string, "available" | "hidden">();
  if (input === undefined) return normalized;
  if (typeof input !== "object" || input === null) {
    throw new MatrixProjectionFailure(
      "matrix_display_override_invalid",
      "Display overrides must be a passive Map.",
    );
  }
  if (nodeTypes.isProxy(input)) {
    throw new MatrixProjectionFailure(
      "matrix_display_override_proxy",
      "Proxy-backed display overrides are not accepted.",
    );
  }
  if (Object.getPrototypeOf(input) !== Map.prototype) {
    throw new MatrixProjectionFailure(
      "matrix_display_override_invalid",
      "Display overrides must be a standard Map.",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) {
      throw new MatrixProjectionFailure(
        "matrix_display_override_accessor",
        "Accessor-backed display overrides are not accepted.",
      );
    }
  }
  if (Reflect.ownKeys(descriptors).length > 0) {
    throw new MatrixProjectionFailure(
      "matrix_display_override_invalid",
      "Display override container properties are not accepted.",
    );
  }

  for (const [sourceId, rawValue] of Map.prototype.entries.call(input) as MapIterator<[unknown, unknown]>) {
    if (typeof sourceId !== "string") {
      throw new MatrixProjectionFailure(
        "matrix_display_override_invalid",
        "Display override keys must be source IDs.",
      );
    }
    let snapshot: unknown;
    try {
      snapshot = passiveSnapshot(rawValue, new Set<object>());
    } catch (error) {
      if (error instanceof MatrixProjectionFailure) {
        const suffix = error.code.replace("matrix_input_", "");
        const mapped = suffix === "accessor" || suffix === "proxy" || suffix === "cycle"
          ? suffix
          : "invalid";
        throw new MatrixProjectionFailure(
          `matrix_display_override_${mapped}`,
          "The display override value is not passive data.",
        );
      }
      throw error;
    }
    if (typeof snapshot !== "object" || snapshot === null) {
      throw new MatrixProjectionFailure(
        "matrix_display_override_invalid",
        "Display overrides require an exact available or hidden shape.",
      );
    }
    const value = snapshot as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const available =
      keys.length === 1 && keys[0] === "state" && value.state === "available";
    const hidden =
      keys.length === 2 &&
      keys[0] === "reasonCode" &&
      keys[1] === "state" &&
      value.state === "hidden" &&
      value.reasonCode === "packet_display_hidden";
    if (!available && !hidden) {
      throw new MatrixProjectionFailure(
        "matrix_display_override_invalid",
        "Display overrides require an exact available or hidden shape.",
      );
    }
    normalized.set(sourceId, hidden ? "hidden" : "available");
  }
  return normalized;
}

type SemanticReferenceRule<T> = {
  label: string;
  references: readonly string[];
  targets: ReadonlyMap<string, T>;
  minimum?: number;
  accept?: (target: T) => boolean;
  unresolvedMessage?: string;
};

function validateSemanticReferenceRules(rules: readonly SemanticReferenceRule<unknown>[]) {
  for (const rule of rules) {
    if (rule.references.length < (rule.minimum ?? 0)) {
      crossLinkFailure(`${rule.label} requires more references.`);
    }
    if (new Set(rule.references).size !== rule.references.length) {
      crossLinkFailure(`${rule.label} repeats a reference.`);
    }
    for (const reference of rule.references) {
      const target = rule.targets.get(reference);
      if (target === undefined) {
        crossLinkFailure(
          rule.unresolvedMessage ?? `${rule.label} does not resolve.`,
        );
      }
      if (rule.accept && !rule.accept(target)) {
        crossLinkFailure(`${rule.label} is bound to the wrong semantic owner.`);
      }
    }
  }
}

function sameUniqueReferences(left: readonly string[], right: readonly string[]) {
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length ||
    left.length !== right.length
  ) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function validateSemanticGraph(run: ResearchRun, ids: MatrixIdentityIndex) {
  const claimById = new Map(run.claims.map((claim) => [claim.id, claim]));
  const sourceById = new Map(run.sources.map((source) => [source.id, source]));
  const chunkById = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
  const evidenceById = new Map(run.evidenceCards.map((card) => [card.id, card]));
  const gapById = new Map(run.researchGaps.map((gap) => [gap.id, gap]));
  const executionById = new Map(run.executions.map((execution) => [execution.id, execution]));
  const errorById = new Map(run.errors.map((error) => [error.id, error]));
  const objectionById = new Map(
    (run.review?.objections ?? []).map((objection) => [objection.id, objection]),
  );
  const knownObjectById = new Map([...ids.knownIds].map((id) => [id, id]));
  const referenceRules: SemanticReferenceRule<unknown>[] = [];

  for (const claim of run.claims) {
    referenceRules.push({
      label: `claim ${claim.id} parent`,
      references: claim.parentClaimId === null ? [] : [claim.parentClaimId],
      targets: claimById,
    });
  }
  for (const source of run.sources) {
    referenceRules.push({
      label: `source ${source.id} merge aliases`,
      references: source.mergedSourceIds,
      targets: sourceById,
    });
  }
  for (const chunk of run.chunks) {
    referenceRules.push({
      label: `chunk ${chunk.id} source`,
      references: [chunk.sourceId],
      targets: sourceById,
    });
  }
  for (const card of run.evidenceCards) {
    referenceRules.push(
      {
        label: `evidence ${card.id} claim`,
        references: [card.subclaimId],
        targets: claimById,
      },
      {
        label: `evidence ${card.id} chunk`,
        references: [card.sourceChunkId],
        targets: chunkById,
        unresolvedMessage: `Evidence ${card.id} does not resolve to an approved source chunk.`,
      },
      {
        label: `evidence ${card.id} model execution`,
        references: [card.modelAssessment.executionId],
        targets: executionById,
        accept: (target) => {
          const execution = target as ResearchRun["executions"][number];
          return (
            execution.requestedProvider === card.modelAssessment.provider &&
            execution.requestedModelId === card.modelAssessment.requestedModelId &&
            execution.returnedModelId === card.modelAssessment.returnedModelId &&
            execution.promptId === card.modelAssessment.promptId &&
            execution.promptVersion === card.modelAssessment.promptVersion
          );
        },
      },
    );
  }

  const conclusionClaims = run.conclusions.map(({ subclaimId }) => subclaimId);
  if (new Set(conclusionClaims).size !== conclusionClaims.length) {
    crossLinkFailure("Each claim can own at most one conclusion.");
  }
  for (const conclusion of run.conclusions) {
    const allEvidence = [
      ...conclusion.supportingEvidenceCardIds,
      ...conclusion.contradictingEvidenceCardIds,
    ];
    if (new Set(allEvidence).size !== allEvidence.length) {
      crossLinkFailure("Conclusion evidence references must be unique across relationship groups.");
    }
    referenceRules.push(
      {
        label: `conclusion ${conclusion.subclaimId} claim`,
        references: [conclusion.subclaimId],
        targets: claimById,
      },
      {
        label: `conclusion ${conclusion.subclaimId} supporting evidence`,
        references: conclusion.supportingEvidenceCardIds,
        targets: evidenceById,
        accept: (target) => {
          const card = target as ResearchRun["evidenceCards"][number];
          return card.subclaimId === conclusion.subclaimId && card.relationship !== "contradicts";
        },
      },
      {
        label: `conclusion ${conclusion.subclaimId} contradicting evidence`,
        references: conclusion.contradictingEvidenceCardIds,
        targets: evidenceById,
        accept: (target) => {
          const card = target as ResearchRun["evidenceCards"][number];
          return card.subclaimId === conclusion.subclaimId && card.relationship === "contradicts";
        },
      },
      {
        label: `conclusion ${conclusion.subclaimId} trace`,
        references: allEvidence,
        targets: evidenceById,
        minimum: 1,
      },
    );
  }

  for (const gap of run.researchGaps) {
    const affectedClaims = new Set(gap.affectedSubclaimIds);
    referenceRules.push(
      {
        label: `gap ${gap.id} affected claims`,
        references: gap.affectedSubclaimIds,
        targets: claimById,
      },
      {
        label: `gap ${gap.id} evidence`,
        references: gap.evidenceCardIds,
        targets: evidenceById,
        accept: (target) =>
          affectedClaims.has((target as ResearchRun["evidenceCards"][number]).subclaimId),
      },
    );
  }

  const selectedGaps = run.researchGaps.filter(({ selection }) => selection === "selected");
  if (
    (run.selectedGapId === null && selectedGaps.length !== 0) ||
    (run.selectedGapId !== null &&
      (selectedGaps.length !== 1 || selectedGaps[0]?.id !== run.selectedGapId))
  ) {
    crossLinkFailure("Selected-gap ID and selection state disagree.");
  }
  referenceRules.push({
    label: "run selected gap",
    references: run.selectedGapId === null ? [] : [run.selectedGapId],
    targets: gapById,
  });

  const selectedGap = run.selectedGapId === null ? undefined : gapById.get(run.selectedGapId);
  const selectedClaimIds = new Set(selectedGap?.affectedSubclaimIds ?? []);
  if (run.experiment) {
    if (run.selectedGapId === null || run.experiment.selectedGapId !== run.selectedGapId) {
      crossLinkFailure("Experiment and run selected-gap IDs disagree.");
    }
    referenceRules.push(
      {
        label: "experiment selected gap",
        references: [run.experiment.selectedGapId],
        targets: gapById,
      },
      {
        label: "experiment supporting evidence",
        references: run.experiment.supportingEvidenceCardIds,
        targets: evidenceById,
        accept: (target) =>
          selectedClaimIds.has((target as ResearchRun["evidenceCards"][number]).subclaimId),
      },
    );
  }

  if (run.review) {
    referenceRules.push({
      label: "review execution",
      references: [run.review.reviewerExecutionId],
      targets: executionById,
      accept: (target) =>
        (target as ResearchRun["executions"][number]).nodeId === "review-experiment",
    });
    for (const objection of run.review.objections) {
      referenceRules.push({
        label: `objection ${objection.id} evidence`,
        references: objection.evidenceCardIds,
        targets: evidenceById,
        accept: (target) =>
          selectedClaimIds.has((target as ResearchRun["evidenceCards"][number]).subclaimId),
      });
    }
    const reviewerExecution = executionById.get(run.review.reviewerExecutionId);
    if (
      reviewerExecution &&
      !sameUniqueReferences(
        reviewerExecution.outputRefs,
        run.review.objections.map(({ id }) => id),
      )
    ) {
      crossLinkFailure("Review execution outputs must exactly identify its objections.");
    }
  }

  const unresolvedRevisionIds = run.revision?.decisions
    .filter(({ disposition }) => disposition === "unresolved")
    .map(({ objectionId }) => objectionId) ?? [];
  if (run.revision) {
    if (!run.review) crossLinkFailure("A revision requires its reviewed objections.");
    const revisionIds = run.revision.decisions.map(({ objectionId }) => objectionId);
    if (!sameUniqueReferences(revisionIds, [...objectionById.keys()])) {
      crossLinkFailure("A revision must disposition every objection exactly once.");
    }
    if (
      run.revision.decisions.some(({ disposition, revisedValue }) =>
        disposition === "accepted" ? revisedValue === null : revisedValue !== null,
      )
    ) {
      crossLinkFailure("Revision values must match their objection dispositions.");
    }
    referenceRules.push({
      label: "revision objections",
      references: revisionIds,
      targets: objectionById,
    });
  }

  for (const [label, decision] of [
    ["objection disposition", run.objectionDispositionDecision],
    ["final decision", run.finalDecision],
  ] as const) {
    if (!decision) continue;
    referenceRules.push({
      label: `${label} unresolved objections`,
      references: decision.unresolvedObjections,
      targets: objectionById,
    });
    if (run.revision && !sameUniqueReferences(decision.unresolvedObjections, unresolvedRevisionIds)) {
      crossLinkFailure(`${label} unresolved objections must match the revision.`);
    }
  }

  for (const execution of run.executions) {
    referenceRules.push(
      {
        label: `execution ${execution.id} inputs`,
        references: execution.inputRefs,
        targets: knownObjectById,
      },
      {
        label: `execution ${execution.id} outputs`,
        references: execution.outputRefs,
        targets: knownObjectById,
      },
      {
        label: `execution ${execution.id} errors`,
        references: execution.errorIds,
        targets: errorById,
        accept: (target) =>
          (target as ResearchRun["errors"][number]).executionId === execution.id,
      },
    );
    const linkedErrorIds = run.errors
      .filter(({ executionId }) => executionId === execution.id)
      .map(({ id }) => id);
    if (!sameUniqueReferences(execution.errorIds, linkedErrorIds)) {
      crossLinkFailure("Execution and error references must be exactly bidirectional.");
    }
  }
  for (const error of run.errors) {
    if (error.executionId === null) continue;
    referenceRules.push({
      label: `error ${error.id} execution`,
      references: [error.executionId],
      targets: executionById,
      accept: (target) => {
        const execution = target as ResearchRun["executions"][number];
        return execution.nodeId === error.nodeId && execution.errorIds.includes(error.id);
      },
    });
  }

  validateSemanticReferenceRules(referenceRules);

  try {
    validateExecutionHistory(run);
  } catch {
    crossLinkFailure("Execution history does not satisfy the shared workflow contract.");
  }

  validateAcyclic(
    run.claims.map(({ id, parentClaimId }) => [id, parentClaimId ? [parentClaimId] : []] as const),
  );
  validateAcyclic(
    run.sources.map(({ id, mergedSourceIds }) => [id, mergedSourceIds] as const),
  );
}

function validateAcyclic(entries: ReadonlyArray<readonly [string, readonly string[]]>) {
  const edges = new Map(entries);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string) {
    if (visiting.has(id)) crossLinkFailure("A reference cycle is not accepted.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of edges.keys()) visit(id);
}

function crossLinkFailure(message: string): never {
  throw new MatrixProjectionFailure("matrix_cross_link_invalid", message);
}

export function buildEvidenceMatrixModel(
  input: unknown,
  displayOverrides?: unknown,
): EvidenceMatrixModel {
  try {
    const normalizedOverrides = readDisplayOverrides(displayOverrides);
    const run = readResearchRun(input);
    const identities = validateMatrixIdentities(run);
    validateSemanticGraph(run, identities);
    validateSemanticReferenceRules([{
      label: "display override sources",
      references: [...normalizedOverrides.keys()],
      targets: new Map(run.sources.map((source) => [source.id, source])),
    }]);
    return projectEvidenceMatrix(run, normalizedOverrides);
  } catch (error) {
    if (error instanceof MatrixProjectionFailure) {
      return matrixError(error.code, error.message);
    }
    return matrixError(
      "matrix_projection_failed",
      "The evidence packet could not be projected safely.",
    );
  }
}

function projectEvidenceMatrix(
  run: ResearchRun,
  displayOverrides: NormalizedDisplayOverrides,
): EvidenceMatrixModel {
  const sourceById = new Map(run.sources.map((source) => [source.id, source]));
  const chunkById = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));

  const sources = [...run.sources]
    .sort((left, right) => stableCompare(left.id, right.id))
    .map((source, index) => {
      const hiddenReasonCode = sourceLedgerHiddenReasonCode(
        source,
        run.chunks.filter(({ sourceId }) => sourceId === source.id),
        displayOverrides.get(source.id),
      );
      if (hiddenReasonCode) {
        return {
          id: source.id,
          label: `Source ${index + 1}`,
          state: "hidden" as const,
          reasonCode: hiddenReasonCode,
        };
      }
      const safeCanonicalUrl = safeExternalHref(source.canonicalUrl);
      return {
        id: source.id,
        label: `Source ${index + 1}`,
        state: "available" as const,
        title: source.bibliographicMetadata.title,
        identifier: source.canonicalDoi ?? safeCanonicalUrl ?? source.id,
        metadataStatus: source.metadataVerification.status,
      };
    });

  const rows = [...run.claims]
    .sort((left, right) => stableCompare(left.id, right.id))
    .map((claim, rowIndex) => {
    const claimLabel = `Claim ${rowIndex + 1}`;
    return {
      claim: { id: claim.id, label: claimLabel, statement: claim.statement },
      cells: sources.map((sourceView, columnIndex) => {
        const source = sourceById.get(sourceView.id)!;
        const cards = run.evidenceCards
          .filter((card) => {
            const chunk = chunkById.get(card.sourceChunkId)!;
            return card.subclaimId === claim.id && chunk.sourceId === source.id;
          })
          .sort((left, right) => stableCompare(left.id, right.id));
        return buildCell({
          claim,
          claimLabel,
          source,
          sourceView,
          cards,
          chunkById,
          displayOverrides,
          rowIndex,
          columnIndex,
        });
      }),
    };
    });

  const cells = rows.flatMap(({ cells }) => cells);
  return {
    state: rows.length === 0 || sources.length === 0 ? "empty" : "ready",
    disclosure: null,
    error: null,
    sources,
    rows,
    summary: {
      claimCount: rows.length,
      sourceCount: sources.length,
      evidenceCount: run.evidenceCards.length,
      missingCount: cells.filter(({ relationship }) => relationship === "missing").length,
    },
  };
}

function buildCell({
  claim,
  claimLabel,
  source,
  sourceView,
  cards,
  chunkById,
  displayOverrides,
  rowIndex,
  columnIndex,
}: {
  claim: ResearchRun["claims"][number];
  claimLabel: string;
  source: ResearchRun["sources"][number];
  sourceView: EvidenceMatrixModel["sources"][number];
  cards: ResearchRun["evidenceCards"];
  chunkById: Map<string, ResearchRun["chunks"][number]>;
  displayOverrides: NormalizedDisplayOverrides;
  rowIndex: number;
  columnIndex: number;
}): MatrixCell {
  const relationships = new Set(cards.map(({ relationship }) => relationship));
  const relationship: CellRelationship =
    relationships.size === 0
      ? "missing"
      : relationships.size === 1
        ? [...relationships][0]!
        : "mixed";
  const presentation = relationshipPresentation[relationship];
  const ledgerHiddenReasonCode = sourceView.state === "hidden"
    ? sourceView.reasonCode
    : null;
  const evidence = cards.map((card) => {
    const chunk = chunkById.get(card.sourceChunkId)!;
    const hiddenReasonCode = sourceHiddenReasonCode(
      source,
      chunk,
      displayOverrides.get(source.id),
    );
    if (hiddenReasonCode) {
      return {
        id: card.id,
        state: "hidden",
        reasonCode: hiddenReasonCode,
      } satisfies MatrixEvidence;
    }
    return {
      id: card.id,
      state: "available",
      excerpt: card.excerpt,
      location: chunk.location,
      contentScope: source.access.contentScope,
      extractedResult: card.extractedResult,
      settingAndSample: card.settingAndSample,
      studyType: card.studyType,
      limitation: card.limitation,
      conclusionStrengthWarning: card.conclusionStrengthWarning,
      extractionIssues: [...card.extractionIssues],
      deterministicVerification: { ...card.deterministicVerification },
      modelAssessment: { ...card.modelAssessment },
      humanReview: { ...card.humanReview },
    } satisfies MatrixEvidence;
  });
  const visibleCardIds = new Set(
    evidence.filter(({ state }) => state === "available").map(({ id }) => id),
  );
  const sourceDisplayAllowed = ledgerHiddenReasonCode === null;
  const warning = warningPresentation(source, cards, visibleCardIds, sourceDisplayAllowed);
  const countLabel = `${cards.length} ${cards.length === 1 ? "evidence" : "evidence"}`;

  return {
    id: `${claim.id}::${source.id}`,
    rowIndex,
    columnIndex,
    claimId: claim.id,
    sourceId: source.id,
    claimLabel,
    sourceLabel: sourceView.label,
    claimStatement: claim.statement,
    sourceDisplay: sourceView.state === "hidden"
      ? { state: "hidden", reasonCode: sourceView.reasonCode }
      : {
          state: "available",
          title: sourceView.title,
          identifier: sourceView.identifier,
        },
    relationship,
    relationshipLabel: presentation.label,
    relationshipSymbol: presentation.symbol,
    evidenceCount: cards.length,
    evidenceIds: evidence.map(({ id }) => id),
    warningState: warning.state,
    warningLabel: warning.label,
    warningConditions: warning.conditions,
    warnings: warning.messages,
    accessibleLabel: `${claimLabel}, ${sourceView.label}, ${presentation.label}, ${countLabel}, ${warning.label}`,
    sourceLedger: buildSourceLedger(source, ledgerHiddenReasonCode),
    evidence,
  };
}

function buildSourceLedger(
  source: ResearchRun["sources"][number],
  hiddenReasonCode: MatrixHiddenReasonCode | null,
): MatrixSourceLedger {
  if (hiddenReasonCode) {
    return {
      state: "hidden",
      sourceId: source.id,
      reasonCode: hiddenReasonCode,
    };
  }
  const href = safeExternalHref(source.canonicalUrl);
  const identifier = source.canonicalDoi ?? href ?? source.id;
  const integrityNoticesByKey = new Map<string, {
    kind: ResearchRun["sources"][number]["integrityNotices"][number]["kind"];
    href: string | null;
    affectsSource: boolean;
    checkedAt: string;
  }>();
  for (const notice of source.integrityNotices) {
    const projected = {
      kind: notice.kind,
      href: safeExternalHref(notice.noticeUrl),
      affectsSource: notice.affectsSource,
      checkedAt: notice.checkedAt,
    };
    const key = JSON.stringify([
      projected.kind,
      projected.checkedAt,
      projected.href,
      projected.affectsSource,
    ]);
    integrityNoticesByKey.set(key, projected);
  }
  const integrityNotices = [...integrityNoticesByKey]
    .sort(([left], [right]) => stableCompare(left, right))
    .map(([, notice]) => notice);

  return {
    state: "available",
    sourceId: source.id,
    title: source.bibliographicMetadata.title,
    identifier: { value: identifier, href },
    contentScope: source.access.contentScope,
    identifierResolution: { ...source.doiResolution },
    accessDetails: {
      state: "available",
      provider: source.access.provider,
      version: source.access.version,
      location: source.access.location,
      retrievedAt: source.access.retrievedAt,
    },
    metadataVerification: {
      status: source.metadataVerification.status,
      details: {
        state: "available",
        method: source.metadataVerification.method,
        checkedAt: source.metadataVerification.checkedAt,
        fieldDiffs: source.metadataVerification.fieldDiffs
          .map((fieldDiff) => ({ ...fieldDiff }))
          .sort((left, right) => stableCompare(
            `${left.field}\u0000${left.expected ?? ""}\u0000${left.observed ?? ""}`,
            `${right.field}\u0000${right.expected ?? ""}\u0000${right.observed ?? ""}`,
          )),
      },
    },
    integrityNotices,
    sourceWarnings: [...source.warnings].sort(stableCompare),
  };
}

function sourceLedgerHiddenReasonCode(
  source: ResearchRun["sources"][number],
  chunks: ResearchRun["chunks"],
  override?: "available" | "hidden",
): MatrixHiddenReasonCode | null {
  if (override === "hidden") return "packet_display_hidden";
  if (source.rights.mayDisplay === "denied") return "source_display_denied";
  if (source.rights.mayDisplay === "unknown") return "source_display_unknown";
  if (chunks.some(({ displayPermission }) => displayPermission === "denied")) {
    return "chunk_display_denied";
  }
  if (chunks.some(({ displayPermission }) => displayPermission === "unknown")) {
    return "chunk_display_unknown";
  }
  return null;
}

function safeExternalHref(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sourceHiddenReasonCode(
  source: ResearchRun["sources"][number],
  chunk: ResearchRun["chunks"][number],
  override?: "available" | "hidden",
): MatrixHiddenReasonCode | null {
  if (override === "hidden") {
    return "packet_display_hidden";
  }
  if (source.rights.mayDisplay === "denied") {
    return "source_display_denied";
  }
  if (source.rights.mayDisplay === "unknown") {
    return "source_display_unknown";
  }
  if (chunk.displayPermission === "denied") {
    return "chunk_display_denied";
  }
  if (chunk.displayPermission === "unknown") {
    return "chunk_display_unknown";
  }
  return null;
}

function warningPresentation(
  source: ResearchRun["sources"][number],
  cards: ResearchRun["evidenceCards"],
  visibleCardIds: Set<string>,
  sourceDisplayAllowed: boolean,
): {
  state: WarningState;
  label: string;
  conditions: MatrixWarningCondition[];
  messages: string[];
} {
  const visibleCards = cards.filter(({ id }) => visibleCardIds.has(id));
  const extractionIssues = visibleCards.flatMap(({ extractionIssues }) => extractionIssues);
  const failedChecks = cards.filter(
    ({ deterministicVerification }) => deterministicVerification.status !== "verified",
  );
  const conditions: MatrixWarningCondition[] = [];
  const messages: string[] = [];

  if (failedChecks.length > 0 || cards.some(({ extractionIssues: issues }) => issues.length > 0)) {
    conditions.push({ kind: "failure", label: "Verification failure", symbol: "!" });
    messages.push(
      ...failedChecks.map((card) =>
        visibleCardIds.has(card.id)
          ? `${card.id}: deterministic verification is ${card.deterministicVerification.status}.`
          : "A deterministic verification failure is recorded for hidden evidence.",
      ),
      ...extractionIssues,
    );
    if (messages.length === 0) {
      messages.push("An extraction issue is recorded for hidden evidence.");
    }
  }
  if (source.metadataVerification.status === "mismatch") {
    conditions.push({ kind: "mismatch", label: "Metadata mismatch", symbol: "≠" });
    const allVisible = sourceDisplayAllowed && cards.every(({ id }) => visibleCardIds.has(id));
    messages.push(
      ...(allVisible
        ? source.metadataVerification.fieldDiffs.map(
            ({ field, expected, observed }) =>
              `${field}: canonical “${expected}”; supplied “${observed}”.`,
          )
        : ["A metadata mismatch is recorded for evidence whose source text is hidden."]),
    );
  }
  if (cards.length > 1) {
    conditions.push({ kind: "warning", label: "Multiple evidence records", symbol: "△" });
    messages.push("Multiple evidence records share this claim-source relationship.");
  }
  const strengthWarnings = visibleCards.flatMap(({ conclusionStrengthWarning }) =>
    conclusionStrengthWarning ? [conclusionStrengthWarning] : [],
  );
  if (strengthWarnings.length > 0) {
    if (conditions.length === 0) {
      conditions.push({ kind: "warning", label: "Warning", symbol: "△" });
    }
    messages.push(...strengthWarnings);
  }
  if (conditions.length === 0) {
    conditions.push({ kind: "none", label: "No warnings", symbol: "—" });
  }
  const state = conditions[0]!.kind;
  return {
    state,
    label: conditions.map(({ label }) => label).join(" · "),
    conditions,
    messages,
  };
}

export function buildEvidenceMatrixScenarioModel(
  run: ResearchRun,
  scenario: EvidenceMatrixScenario,
  displayOverrides?: MatrixDisplayOverrides,
): EvidenceMatrixModel {
  const base = buildEvidenceMatrixModel(run, displayOverrides);
  const disclosure = "Fixture matrix state preview—not a live provider result.";

  if (scenario === "loading") {
    return { ...emptyMatrix("loading"), disclosure };
  }
  if (scenario === "empty") {
    return { ...emptyMatrix("empty"), disclosure };
  }
  if (scenario === "error") {
    return {
      ...matrixError(
        "matrix_projection_failed",
        "The fixture preview could not project a complete claim-source matrix.",
      ),
      disclosure,
    };
  }
  if (base.state !== "ready") return { ...base, disclosure };

  const model = structuredClone(base);
  model.disclosure = disclosure;
  const firstPopulated = model.rows
    .flatMap(({ cells }) => cells)
    .find(({ evidenceCount }) => evidenceCount > 0);

  if (scenario === "duplicate" && firstPopulated) {
    const duplicate = structuredClone(firstPopulated.evidence[0]!);
    duplicate.id = `${duplicate.id}-duplicate-preview`;
    firstPopulated.evidence.unshift(duplicate);
    firstPopulated.evidenceIds = firstPopulated.evidence.map(({ id }) => id).sort(stableCompare);
    firstPopulated.evidenceCount = firstPopulated.evidence.length;
    firstPopulated.warningState = "warning";
    firstPopulated.warningLabel = "Multiple evidence records";
    firstPopulated.warningConditions = [
      { kind: "warning", label: "Multiple evidence records", symbol: "△" },
    ];
    firstPopulated.warnings = ["This fixture preview places two evidence records in one relationship cell."];
    firstPopulated.accessibleLabel = replaceCountAndWarning(firstPopulated);
    model.summary.evidenceCount += 1;
    model.disclosure = "Fixture duplicate preview—two evidence records share one claim-source cell.";
  }
  if (scenario === "long-content") {
    const repeated = "Long fixture content remains readable without clipping essential controls. ".repeat(6).trim();
    const untrusted = '</script><img data-evf-untrusted src="x" onerror="alert(1)">';
    const firstRow = model.rows[0];
    if (firstRow) {
      firstRow.claim.statement = repeated;
      firstRow.cells.forEach((cell) => {
        cell.claimStatement = repeated;
      });
    }
    const firstSource = model.sources[0];
    if (firstSource?.state === "available") {
      firstSource.title = `${firstSource.title} — ${repeated}`;
      for (const row of model.rows) {
        const cell = row.cells.find(({ sourceId }) => sourceId === firstSource.id);
        if (!cell) continue;
        if (cell.sourceDisplay.state === "available") {
          cell.sourceDisplay.title = firstSource.title;
        }
        if (cell.sourceLedger.state === "available") {
          cell.sourceLedger.title = firstSource.title;
        }
      }
    }
    if (firstPopulated?.evidence[0]?.state === "available") {
      firstPopulated.evidence[0].excerpt = repeated;
      firstPopulated.evidence[0].limitation = untrusted;
    }
    model.disclosure = "Long-content matrix preview";
  }
  if (scenario === "failure" && firstPopulated) {
    firstPopulated.warningState = "failure";
    const mismatch = firstPopulated.warningConditions.find(({ kind }) => kind === "mismatch");
    firstPopulated.warningConditions = [
      { kind: "failure", label: "Verification failure", symbol: "!" },
      ...(mismatch ? [mismatch] : []),
    ];
    firstPopulated.warningLabel = firstPopulated.warningConditions
      .map(({ label }) => label)
      .join(" · ");
    firstPopulated.warnings = ["The exact passage verification failed in this fixture preview."];
    firstPopulated.accessibleLabel = replaceCountAndWarning(firstPopulated);
    const evidence = firstPopulated.evidence[0];
    if (evidence?.state === "available") {
      evidence.deterministicVerification.status = "failed";
      evidence.extractionIssues = ["The exact passage verification failed in this fixture preview."];
    }
    if (firstPopulated.sourceLedger.state === "available") {
      firstPopulated.sourceLedger.integrityNotices = [{
        kind: "update",
        href: "https://example.test/integrity-update",
        affectsSource: true,
        checkedAt: "2026-08-08T00:00:00.000Z",
      }];
    }
  }
  if (scenario === "missing-evidence") {
    model.disclosure = "Missing-evidence matrix preview—absence remains an explicit zero-card relationship.";
  }
  return model;
}

function replaceCountAndWarning(cell: MatrixCell) {
  return `${cell.claimLabel}, ${cell.sourceLabel}, ${cell.relationshipLabel}, ${cell.evidenceCount} evidence, ${cell.warningLabel}`;
}

function emptyMatrix(state: "loading" | "empty"): EvidenceMatrixModel {
  return {
    state,
    disclosure: null,
    error: null,
    sources: [],
    rows: [],
    summary: { claimCount: 0, sourceCount: 0, evidenceCount: 0, missingCount: 0 },
  };
}

function matrixError(code: string, message: string): EvidenceMatrixModel {
  return {
    state: "error",
    disclosure: null,
    error: { code, message },
    sources: [],
    rows: [],
    summary: { claimCount: 0, sourceCount: 0, evidenceCount: 0, missingCount: 0 },
  };
}

function stableCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isEvidenceMatrixScenario(
  value: string | undefined,
): value is EvidenceMatrixScenario {
  return EVIDENCE_MATRIX_SCENARIOS.includes(value as EvidenceMatrixScenario);
}
