"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  submitObjectionDispositions,
  type DispositionDraft,
  type DispositionSubmissionResult,
} from "./objection-disposition-actions";
import type { ObjectionDispositionModel } from "./objection-disposition-state";
import styles from "./objection-disposition-panel.module.css";

type ObjectionDispositionPanelProps = {
  model: ObjectionDispositionModel;
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function evidenceHref(id: string) {
  return `/workbench?evidence=${encodeURIComponent(id)}#evidence-verification-drawer`;
}

export function ObjectionDispositionPanel({
  model,
}: ObjectionDispositionPanelProps) {
  const initialDrafts = useMemo(
    () =>
      model.state === "awaiting"
        ? Object.fromEntries(
            model.objections.map(({ id }) => [
              id,
              {
                objectionId: id,
                disposition: "unresolved" as const,
                basis: "",
              },
            ]),
          )
        : {},
    [model],
  );
  const [drafts, setDrafts] = useState<Record<string, DispositionDraft>>(
    initialDrafts,
  );
  const [basisErrors, setBasisErrors] = useState<string[]>([]);
  const [submission, setSubmission] = useState<
    DispositionSubmissionResult | { ok: null; submitting: boolean }
  >({ ok: null, submitting: false });
  const basisRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const submissionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      submission.ok === true ||
      (submission.ok === false && submission.code !== "basis_required")
    ) {
      submissionRef.current?.focus();
    }
  }, [submission]);

  function updateDraft(
    objectionId: string,
    update: Partial<DispositionDraft>,
  ) {
    setDrafts((current) => ({
      ...current,
      [objectionId]: { ...current[objectionId]!, ...update },
    }));
  }

  async function saveDispositions() {
    if (model.state !== "awaiting" || submission.ok === true) return;
    const ordered = model.objections.map(({ id }) => drafts[id]!);
    const missing = ordered
      .filter(({ basis }) => !basis.trim())
      .map(({ objectionId }) => objectionId);
    setBasisErrors(missing);
    if (missing.length > 0) {
      setSubmission({
        ok: false,
        code: "basis_required",
        message: "A human basis is required for every objection.",
      });
      basisRefs.current[missing[0]!]?.focus();
      return;
    }
    setSubmission({ ok: null, submitting: true });
    const result = await submitObjectionDispositions({
      runId: model.persistence.runId,
      expectedRevision: model.persistence.expectedRevision,
      decidedAt: new Date().toISOString(),
      dispositions: ordered,
    });
    setSubmission(result);
  }

  const isSubmitting = submission.ok === null && submission.submitting;

  return (
    <section
      className={styles.surface}
      id="review-revision"
      aria-label="Objection dispositions and selective revision"
      aria-busy={isSubmitting}
      data-state={model.state}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.index}>06 · Review & revision</span>
          <h2>Objections & selective changes</h2>
        </div>
        <span className={styles.mode}>{model.evidenceMode}</span>
      </header>

      {model.state === "error" ? (
        <div className={styles.error} role="alert">
          <strong>Disposition controls unavailable</strong>
          <p>{model.error.message}</p>
          <code>{model.error.code}</code>
        </div>
      ) : model.state === "pending" ? (
        <p className={styles.pending}>{model.message}</p>
      ) : (
        <div className={styles.body}>
          <div className={styles.persistence} data-persistence={model.persistence.state}>
            <strong>{model.persistence.label}</strong>
            <span>
              {model.state === "recorded"
                ? "This terminal fixture record predates this page view. It is not a newly persisted decision."
                : "Saving uses the existing checkpoint API. State is process-local and can reset on restart or redeploy."}
            </span>
          </div>

          <ol className={styles.objections}>
            {model.objections.map((objection, index) => {
              const draft = drafts[objection.id];
              const decision = objection.decision;
              return (
                <li
                  className={styles.objection}
                  data-testid={`objection-${objection.id}`}
                  data-severity={objection.severity}
                  key={objection.id}
                >
                  <header className={styles.objectionHeader}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{humanize(objection.category)}</strong>
                      <code>{objection.targetField}</code>
                    </div>
                    <span className={styles.severity}>{humanize(objection.severity)}</span>
                  </header>

                  <div className={styles.cause}>
                    <span>Causal objection</span>
                    <p>{objection.rationale}</p>
                    <small>{objection.rationaleTrustLabel}</small>
                    <ul>
                      {objection.evidence.map((evidence) => (
                        <li key={evidence.id}>
                          <a href={evidenceHref(evidence.id)}>
                            {evidence.id} · {humanize(evidence.relationship)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {model.state === "awaiting" && draft ? (
                    <fieldset
                      className={styles.dispositionControls}
                      disabled={submission.ok === true || isSubmitting}
                    >
                      <legend>Human disposition</legend>
                      <div className={styles.radios}>
                        {(["accepted", "rejected", "unresolved"] as const).map(
                          (disposition) => (
                            <label key={disposition}>
                              <input
                                type="radio"
                                name={`disposition-${objection.id}`}
                                value={disposition}
                                checked={draft.disposition === disposition}
                                onChange={() =>
                                  updateDraft(objection.id, { disposition })
                                }
                                aria-label={`${disposition === "accepted" ? "Accept" : disposition === "rejected" ? "Reject" : "Leave unresolved"} objection`}
                              />
                              <span>{humanize(disposition)}</span>
                            </label>
                          ),
                        )}
                      </div>
                      <label className={styles.basis}>
                        <span>Human basis</span>
                        <textarea
                          ref={(node) => {
                            basisRefs.current[objection.id] = node;
                          }}
                          value={draft.basis}
                          aria-invalid={basisErrors.includes(objection.id)}
                          aria-describedby={
                            basisErrors.includes(objection.id)
                              ? `basis-error-${objection.id}`
                              : undefined
                          }
                          onChange={(event) => {
                            updateDraft(objection.id, {
                              basis: event.currentTarget.value,
                            });
                            setBasisErrors((current) =>
                              current.filter((id) => id !== objection.id),
                            );
                          }}
                        />
                        {basisErrors.includes(objection.id) ? (
                          <small id={`basis-error-${objection.id}`}>
                            Basis is required.
                          </small>
                        ) : null}
                      </label>
                      <div className={styles.original}>
                        <span>Current field value</span>
                        <p>{objection.originalValue}</p>
                      </div>
                    </fieldset>
                  ) : decision ? (
                    <div className={styles.recordedDecision}>
                      <header>
                        <span data-disposition={decision.disposition}>
                          {humanize(decision.disposition).replace(/^./, (letter) =>
                            letter.toUpperCase(),
                          )}
                        </span>
                        <code>{objection.targetField}</code>
                      </header>
                      <div className={styles.basisRecord}>
                        <strong>Human or policy basis</strong>
                        <p>{decision.basis}</p>
                      </div>
                      {decision.showsChange && decision.revisedValue ? (
                        <div className={styles.diff} aria-label={`Selective change for ${objection.targetField}`}>
                          <div><span>Before</span><p>{decision.originalValue}</p></div>
                          <span aria-hidden="true">→</span>
                          <div><span>After</span><p>{decision.revisedValue}</p></div>
                        </div>
                      ) : (
                        <div className={styles.noChange}>
                          <strong>No field change</strong>
                          <p>{decision.originalValue}</p>
                        </div>
                      )}
                      <div className={styles.residualRisk}>
                        <strong>Residual risk</strong>
                        <p>{decision.residualRisk}</p>
                      </div>
                      {objection.remainsUnresolvedAtFinal ? (
                        <p className={styles.finalRisk} role="status">
                          Remains unresolved at final approval · final decision {objection.finalDecision}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>

          {model.state === "awaiting" ? (
            <div className={styles.submitArea}>
              <button
                type="button"
                disabled={submission.ok === true || isSubmitting}
                onClick={() => void saveDispositions()}
              >
                {isSubmitting
                  ? "Saving dispositions…"
                  : "Save dispositions"}
              </button>
              {isSubmitting ? (
                <p className={styles.pending} role="status" aria-live="polite">
                  Saving dispositions. Objection controls are temporarily locked.
                </p>
              ) : submission.ok === false ? (
                <div
                  className={styles.error}
                  role="alert"
                  ref={submissionRef}
                  tabIndex={-1}
                >
                  <strong>Checkpoint not saved</strong>
                  <p>{submission.message}</p>
                  <code>{submission.code}</code>
                </div>
              ) : submission.ok === true ? (
                <div
                  className={styles.success}
                  role="status"
                  ref={submissionRef}
                  tabIndex={-1}
                >
                  <strong>Human dispositions persisted</strong>
                  <p>{submission.message}</p>
                  <small>Revision {submission.revision}</small>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
