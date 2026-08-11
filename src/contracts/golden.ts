import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalizeJson } from "./canonical";
import { ResearchRunSchema, type ResearchRun } from "./v0";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function sameMembers(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function isSortedBy<T>(values: T[], select: (value: T) => string): boolean {
  return values.every(
    (value, index) =>
      index === 0 || select(values[index - 1]) < select(value),
  );
}

function addIssue(
  context: z.RefinementCtx,
  path: (number | string)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export const CompleteGoldenRunSchema = ResearchRunSchema.superRefine(
  (run, context) => {
    if (run.evidenceMode !== "fixture") {
      addIssue(context, ["evidenceMode"], "golden run evidence mode must be fixture");
    }
    if (run.status !== "approved") {
      addIssue(context, ["status"], "complete golden run must be approved");
    }
    if (run.experimentAbstention !== null) {
      addIssue(
        context,
        ["experimentAbstention"],
        "complete golden proposal run requires an explicit null abstention",
      );
    }
    for (const [field, values] of [
      ["claims", run.claims],
      ["sources", run.sources],
      ["chunks", run.chunks],
      ["evidenceCards", run.evidenceCards],
      ["conclusions", run.conclusions],
      ["researchGaps", run.researchGaps],
      ["executions", run.executions],
    ] as const) {
      if (values.length === 0) {
        addIssue(context, [field], `complete golden run requires ${field}`);
      }
    }

    for (const [field, checkpoint] of [
      ["scopeDecision", "scope"],
      ["objectionDispositionDecision", "objection_dispositions"],
      ["finalDecision", "final"],
    ] as const) {
      const decision = run[field];
      if (
        decision === null ||
        decision.checkpoint !== checkpoint ||
        decision.decision !== "approve"
      ) {
        addIssue(
          context,
          [field],
          `complete golden run requires an approving ${checkpoint} checkpoint`,
        );
      } else if (!decision.optionsShown.includes(decision.decision)) {
        addIssue(
          context,
          [field, "optionsShown"],
          "the recorded human decision must be one of the options shown",
        );
      }
    }

    if (run.packet === null) {
      addIssue(context, ["packet"], "complete golden run requires a frozen packet");
      return;
    }
    if (
      !run.packet.freezeDecision.optionsShown.includes(
        run.packet.freezeDecision.decision,
      )
    ) {
      addIssue(
        context,
        ["packet", "freezeDecision", "optionsShown"],
        "the packet-freeze decision must be one of the options shown",
      );
    }

    const ids = [
      run.id,
      ...run.claims.map(({ id }) => id),
      ...run.sources.map(({ id }) => id),
      ...run.chunks.map(({ id }) => id),
      ...run.evidenceCards.map(({ id }) => id),
      ...run.researchGaps.map(({ id }) => id),
      ...run.executions.map(({ id }) => id),
      ...run.errors.map(({ id }) => id),
      ...(run.review?.objections.map(({ id }) => id) ?? []),
      ...(run.scopeDecision === null ? [] : [run.scopeDecision.id]),
      ...(run.packet === null ? [] : [run.packet.freezeDecision.id]),
      ...(run.objectionDispositionDecision === null
        ? []
        : [run.objectionDispositionDecision.id]),
      ...(run.finalDecision === null ? [] : [run.finalDecision.id]),
    ];
    if (!unique(ids)) {
      addIssue(context, [], "golden run stable object IDs must be globally unique");
    }

    if (run.chunks.length < 5 || run.chunks.length > 8) {
      addIssue(context, ["chunks"], "golden run requires 5–8 approved excerpts");
    }
    if (run.sources.length !== run.chunks.length) {
      addIssue(
        context,
        ["sources"],
        "each golden source record must contain exactly one approved excerpt",
      );
    }
    for (const [field, values] of [
      ["sources", run.sources.map(({ id }) => id)],
      ["chunks", run.chunks.map(({ id }) => id)],
      ["evidenceCards", run.evidenceCards.map(({ id }) => id)],
      ["researchGaps", run.researchGaps.map(({ id }) => id)],
    ] as const) {
      if (!isSortedBy(values, (value) => value)) {
        addIssue(
          context,
          [field],
          `${field} must retain deterministic ID ordering`,
        );
      }
    }

    const sourceById = new Map(run.sources.map((source) => [source.id, source]));
    const chunkById = new Map(run.chunks.map((chunk) => [chunk.id, chunk]));
    const evidenceById = new Map(
      run.evidenceCards.map((card) => [card.id, card]),
    );
    const executionById = new Map(
      run.executions.map((execution) => [execution.id, execution]),
    );
    const objectionById = new Map(
      run.review?.objections.map((objection) => [objection.id, objection]) ?? [],
    );
    const knownObjectIds = new Set(ids);

    run.sources.forEach((source, index) => {
      if (source.access.origin !== "curated_fixture") {
        addIssue(
          context,
          ["sources", index, "access", "origin"],
          "golden sources must be curated fixtures",
        );
      }
      if (
        source.rights.mayStore !== "allowed" ||
        source.rights.mayDisplay !== "allowed" ||
        source.rights.maySendToModel !== "allowed"
      ) {
        addIssue(
          context,
          ["sources", index, "rights"],
          "golden excerpts must retain approved store/display/model-send rights",
        );
      }
      if (
        !source.rights.basis.includes("attribution") ||
        !source.rights.basis.includes(
          "https://creativecommons.org/licenses/by/4.0/",
        )
      ) {
        addIssue(
          context,
          ["sources", index, "rights", "basis"],
          "golden excerpts must retain the CC BY 4.0 link and attribution condition",
        );
      }
    });

    run.chunks.forEach((chunk, index) => {
      const source = sourceById.get(chunk.sourceId);
      if (source === undefined) {
        addIssue(
          context,
          ["chunks", index, "sourceId"],
          "chunk must reference an existing source",
        );
        return;
      }
      if (chunk.displayPermission !== "allowed") {
        addIssue(
          context,
          ["chunks", index, "displayPermission"],
          "golden excerpts must be approved for display",
        );
      }
      if (chunk.contentHash !== sha256Text(chunk.text)) {
        addIssue(
          context,
          ["chunks", index, "contentHash"],
          "chunk hash must match the exact UTF-8 excerpt",
        );
      }
      if (
        source.contentHash !== chunk.contentHash ||
        source.access.contentScope === "metadata_only"
      ) {
        addIssue(
          context,
          ["chunks", index],
          "source content hash must cover exactly one stored excerpt",
        );
      }
    });

    if (
      !run.sources.some(
        (source) =>
          source.metadataVerification.status === "mismatch" &&
          source.metadataVerification.fieldDiffs.length > 0,
      )
    ) {
      addIssue(
        context,
        ["sources"],
        "golden run requires a field-level metadata mismatch",
      );
    }
    if (
      !run.sources.some(
        ({ canonicalDoi, doiResolution }) =>
          canonicalDoi !== null &&
          doiResolution.syntax === "valid" &&
          doiResolution.resolution === "resolved" &&
          doiResolution.registrationAgency !== null &&
          doiResolution.registrationAgency.trim().toLowerCase() !== "crossref",
      )
    ) {
      addIssue(
        context,
        ["sources"],
        "golden run requires a resolved non-Crossref DOI registration-agency case",
      );
    }

    if (
      !sameMembers(
        run.packet.sourceHashes,
        run.sources.map(({ contentHash }) => contentHash),
      ) ||
      !sameMembers(
        run.packet.chunkHashes,
        run.chunks.map(({ contentHash }) => contentHash),
      )
    ) {
      addIssue(
        context,
        ["packet"],
        "frozen packet hashes must exactly cover the fixture sources and excerpts",
      );
    }

    run.evidenceCards.forEach((card, index) => {
      const chunk = chunkById.get(card.sourceChunkId);
      if (chunk === undefined) {
        addIssue(
          context,
          ["evidenceCards", index, "sourceChunkId"],
          "evidence card must reference an existing chunk",
        );
        return;
      }
      if (!chunk.text.includes(card.excerpt)) {
        addIssue(
          context,
          ["evidenceCards", index, "excerpt"],
          "evidence excerpt must be a literal substring of its immutable chunk",
        );
      }
      if (
        card.deterministicVerification.status !== "verified" ||
        card.humanReview.status !== "confirmed"
      ) {
        addIssue(
          context,
          ["evidenceCards", index],
          "golden evidence must retain deterministic and human review layers",
        );
      }
      if (!executionById.has(card.modelAssessment.executionId)) {
        addIssue(
          context,
          ["evidenceCards", index, "modelAssessment", "executionId"],
          "model assessment must reference an execution attempt",
        );
      } else {
        const execution = executionById.get(card.modelAssessment.executionId);
        if (
          execution?.requestedProvider !== card.modelAssessment.provider ||
          execution.requestedModelId !==
            card.modelAssessment.requestedModelId ||
          execution.returnedModelId !== card.modelAssessment.returnedModelId ||
          execution.promptId !== card.modelAssessment.promptId ||
          execution.promptVersion !== card.modelAssessment.promptVersion
        ) {
          addIssue(
            context,
            ["evidenceCards", index, "modelAssessment"],
            "model assessment metadata must match its execution attempt",
          );
        }
      }
      if (!run.claims.some(({ id }) => id === card.subclaimId)) {
        addIssue(
          context,
          ["evidenceCards", index, "subclaimId"],
          "evidence card must reference an existing claim",
        );
      }
    });

    const relationships = new Set(
      run.evidenceCards.map(({ relationship }) => relationship),
    );
    for (const relationship of ["supports", "contradicts", "unresolved"]) {
      if (!relationships.has(relationship as "supports")) {
        addIssue(
          context,
          ["evidenceCards"],
          `golden evidence must include ${relationship}`,
        );
      }
    }

    for (const [index, conclusion] of run.conclusions.entries()) {
      const referenced = [
        ...conclusion.supportingEvidenceCardIds,
        ...conclusion.contradictingEvidenceCardIds,
      ];
      if (
        referenced.length === 0 ||
        referenced.some((id) => !evidenceById.has(id))
      ) {
        addIssue(
          context,
          ["conclusions", index],
          "every conclusion must trace to existing evidence cards",
        );
      }
    }
    const conclusionCardIds = new Set(
      run.conclusions.flatMap((conclusion) => [
        ...conclusion.supportingEvidenceCardIds,
        ...conclusion.contradictingEvidenceCardIds,
      ]),
    );
    if (
      run.evidenceCards.some(({ id }) => !conclusionCardIds.has(id))
    ) {
      addIssue(
        context,
        ["conclusions"],
        "every evidence card must participate in a traceable conclusion",
      );
    }

    const selectedGaps = run.researchGaps.filter(
      ({ selection }) => selection === "selected",
    );
    if (
      run.selectedGapId === null ||
      selectedGaps.length !== 1 ||
      selectedGaps[0].id !== run.selectedGapId ||
      run.experiment === null ||
      run.experiment.selectedGapId !== run.selectedGapId
    ) {
      addIssue(
        context,
        ["selectedGapId"],
        "complete golden run requires one selected gap and its experiment",
      );
    }
    for (const [index, gap] of run.researchGaps.entries()) {
      if (
        gap.affectedSubclaimIds.some(
          (id) => !run.claims.some((claim) => claim.id === id),
        ) ||
        gap.evidenceCardIds.some((id) => !evidenceById.has(id))
      ) {
        addIssue(
          context,
          ["researchGaps", index],
          "research gaps must reference existing claims and evidence cards",
        );
      }
    }
    if (
      run.experiment !== null &&
      run.experiment.supportingEvidenceCardIds.some(
        (id) => !evidenceById.has(id),
      )
    ) {
      addIssue(
        context,
        ["experiment", "supportingEvidenceCardIds"],
        "experiment support references must resolve to evidence cards",
      );
    }

    if (run.review === null || run.revision === null) {
      addIssue(
        context,
        ["review"],
        "complete golden run requires experiment review and revision",
      );
    } else {
      if (!executionById.has(run.review.reviewerExecutionId)) {
        addIssue(
          context,
          ["review", "reviewerExecutionId"],
          "experiment review must reference its execution",
        );
      }
      const decisionIds = run.revision.decisions.map(
        ({ objectionId }) => objectionId,
      );
      if (
        !unique(decisionIds) ||
        !sameMembers(decisionIds, [...objectionById.keys()])
      ) {
        addIssue(
          context,
          ["revision", "decisions"],
          "every objection requires exactly one disposition",
        );
      }
      const accepted = run.revision.decisions.filter(
        ({ disposition }) => disposition === "accepted",
      );
      const unresolved = run.revision.decisions.filter(
        ({ disposition }) => disposition === "unresolved",
      );
      if (
        accepted.length === 0 ||
        accepted.some(({ revisedValue }) => revisedValue === null)
      ) {
        addIssue(
          context,
          ["revision", "decisions"],
          "golden revision requires an accepted objection with a revised value",
        );
      }
      if (
        unresolved.length === 0 ||
        unresolved.some(({ revisedValue }) => revisedValue !== null)
      ) {
        addIssue(
          context,
          ["revision", "decisions"],
          "golden revision requires an unresolved objection without a fabricated revision",
        );
      }
      const unresolvedIds = unresolved.map(({ objectionId }) => objectionId);
      if (
        run.objectionDispositionDecision === null ||
        !sameMembers(
          run.objectionDispositionDecision.unresolvedObjections,
          unresolvedIds,
        ) ||
        run.finalDecision === null ||
        !sameMembers(run.finalDecision.unresolvedObjections, unresolvedIds)
      ) {
        addIssue(
          context,
          ["objectionDispositionDecision", "unresolvedObjections"],
          "unresolved objections must remain visible through final approval",
        );
      }
    }

    const attemptsByNode = new Map<string, Set<number>>();
    for (const [index, execution] of run.executions.entries()) {
      if (execution.evidenceMode !== "fixture") {
        addIssue(
          context,
          ["executions", index, "evidenceMode"],
          "all golden execution attempts must be labeled fixture",
        );
      }
      const attempts = attemptsByNode.get(execution.nodeId) ?? new Set();
      if (attempts.has(execution.attempt)) {
        addIssue(
          context,
          ["executions", index, "attempt"],
          "node attempt numbers must be unique",
        );
      }
      attempts.add(execution.attempt);
      attemptsByNode.set(execution.nodeId, attempts);
      for (const reference of [...execution.inputRefs, ...execution.outputRefs]) {
        if (!knownObjectIds.has(reference)) {
          addIssue(
            context,
            ["executions", index],
            `execution reference ${reference} does not exist`,
          );
        }
      }
      if (
        execution.retryOfExecutionId !== null &&
        !executionById.has(execution.retryOfExecutionId)
      ) {
        addIssue(
          context,
          ["executions", index, "retryOfExecutionId"],
          "retry must reference the preserved prior attempt",
        );
      }
    }

    const failedExecutions = run.executions.filter(
      ({ status }) => status === "failed",
    );
    if (
      failedExecutions.length === 0 ||
      !run.executions.some(
        ({ status, retryOfExecutionId }) =>
          status === "succeeded" &&
          failedExecutions.some(({ id }) => id === retryOfExecutionId),
      )
    ) {
      addIssue(
        context,
        ["executions"],
        "golden run must preserve a failed attempt and its successful retry",
      );
    }
    if (
      !run.errors.some((error) => {
        if (
          error.kind !== "provider_failure" ||
          !error.retryable ||
          error.executionId === null
        ) {
          return false;
        }
        const failedAttempt = executionById.get(error.executionId);
        if (
          failedAttempt === undefined ||
          failedAttempt.status !== "failed" ||
          failedAttempt.nodeId !== error.nodeId ||
          failedAttempt.outputRefs.length !== 0 ||
          failedAttempt.validation.valid ||
          !failedAttempt.errorIds.includes(error.id)
        ) {
          return false;
        }
        return run.executions.some(
          ({
            nodeId,
            attempt,
            status,
            outputRefs,
            validation,
            errorIds,
            retryOfExecutionId,
            fallbackFromExecutionId,
          }) =>
            nodeId === failedAttempt.nodeId &&
            attempt === failedAttempt.attempt + 1 &&
            status === "succeeded" &&
            outputRefs.length > 0 &&
            validation.valid &&
            errorIds.length === 0 &&
            retryOfExecutionId === failedAttempt.id &&
            fallbackFromExecutionId === null,
        );
      })
    ) {
      addIssue(
        context,
        ["executions"],
        "golden run requires a provider failure and its preserved successful retry",
      );
    }
    for (const [index, error] of run.errors.entries()) {
      if (
        error.executionId === null ||
        !executionById.has(error.executionId) ||
        !executionById.get(error.executionId)?.errorIds.includes(error.id)
      ) {
        addIssue(
          context,
          ["errors", index],
          "run errors must be bidirectionally linked to an execution attempt",
        );
      }
    }
    const missingSourceErrors = run.errors.filter(
      (error) =>
        error.kind === "missing_source" &&
        error.details.providerCode === "DOI_NOT_FOUND" &&
        error.details.httpStatus === 404 &&
        error.message.includes("10.1002/open.209900999"),
    );
    if (
      missingSourceErrors.length !== 1 ||
      missingSourceErrors.some((error) => {
        const execution =
          error.executionId === null
            ? undefined
            : executionById.get(error.executionId);
        return (
          execution === undefined ||
          execution.status !== "failed" ||
          execution.nodeId !== "collect-sources" ||
          execution.outputRefs.length !== 0
        );
      })
    ) {
      addIssue(
        context,
        ["errors"],
        "golden run requires the exact failed DOI collection attempt with no fabricated source output",
      );
    }
  },
);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseCompleteGoldenRun(input: unknown): Readonly<ResearchRun> {
  return deepFreeze(CompleteGoldenRunSchema.parse(input));
}

export function exportCanonicalGoldenRun(run: unknown): string {
  return canonicalizeJson(CompleteGoldenRunSchema.parse(run));
}
