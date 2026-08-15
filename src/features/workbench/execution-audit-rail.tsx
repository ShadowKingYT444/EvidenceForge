"use client";

import { useRef, useState } from "react";

import { useFocusBoundary } from "../use-focus-boundary";
import type { WorkbenchModel } from "./workbench-state";
import styles from "./workbench-shell.module.css";

type Execution = WorkbenchModel["audit"]["executions"][number];

type ExecutionAuditRailProps = {
  active?: boolean;
  audit: WorkbenchModel["audit"];
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ExecutionAuditRail({ active = true, audit }: ExecutionAuditRailProps) {
  const [selected, setSelected] = useState<Execution | null>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const dialogClose = useRef<HTMLButtonElement | null>(null);

  function openAttempt(execution: Execution, target: HTMLElement) {
    returnTarget.current = target;
    setSelected(execution);
  }

  function closeAttempt() {
    setSelected(null);
    requestAnimationFrame(() => returnTarget.current?.focus());
  }

  useFocusBoundary({
    active: active && selected !== null,
    boundaryRef: dialog,
    initialFocusRef: dialogClose,
    onDismiss: closeAttempt,
  });

  return (
    <>
      <details className={styles.auditRegion} id="audit" open>
        <summary>
          <span>
            <span className={styles.sectionIndex}>07 · Audit</span>
            <strong>Execution timeline</strong>
          </span>
          <span>{audit.executionCount} attempts</span>
        </summary>
        <div className={styles.auditSummary}>
          <span>{audit.preservedFailureCount} preserved failures</span>
          <span>{audit.retryCount} linked retries</span>
          <span>{audit.activeCount} running now</span>
        </div>
        <p className={styles.auditLedgerLabel}>{audit.label}</p>
        {audit.executions.length === 0 ? (
          <p className={styles.auditEmpty}>
            <strong>No execution attempts recorded</strong>
            <span>
              The workflow has no node-attempt evidence for this state. Nothing is
              inferred as running or successful.
            </span>
          </p>
        ) : (
          <ol
            className={styles.executionList}
            aria-label="Chronological node execution attempts"
          >
            {audit.executions.map((execution, index) => (
              <li
                data-audit-attempt=""
                data-execution-status={execution.status}
                data-node-id={execution.nodeId}
                data-running={execution.isRunning ? "true" : "false"}
                key={execution.id}
              >
                <details className={styles.attemptDetails}>
                  <summary
                    aria-expanded={selected?.id === execution.id}
                    aria-controls="execution-attempt-details"
                    onClick={(event) => openAttempt(execution, event.currentTarget)}
                  >
                    <span className={styles.attemptIndex} aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className={styles.attemptIdentity}>
                      <strong>{humanize(execution.nodeId)}</strong>
                      <small>
                        Attempt {execution.attempt}
                        {execution.retryOfExecutionId !== "Unavailable"
                          ? " · retry"
                          : ""}
                      </small>
                    </span>
                    <span
                      className={styles.executionStatus}
                      data-running={execution.isRunning ? "true" : "false"}
                    >
                      {execution.statusLabel}
                    </span>
                  </summary>
                </details>
              </li>
            ))}
          </ol>
        )}
      </details>

      {active && selected ? (
        <ExecutionAttemptDialog
          execution={selected}
          dialogRef={dialog}
          closeRef={dialogClose}
          onClose={closeAttempt}
        />
      ) : null}
    </>
  );
}

function ExecutionAttemptDialog({
  execution,
  dialogRef,
  closeRef,
  onClose,
}: {
  execution: Execution;
  dialogRef: React.RefObject<HTMLElement | null>;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return (
    <div className={styles.auditBackdrop} onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={styles.auditDialog}
        id="execution-attempt-details"
        role="dialog"
        aria-modal="true"
        aria-label="Execution attempt details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.auditDialogHeader}>
          <div>
            <span>Attempt {execution.attempt}</span>
            <h2>
              {humanize(execution.nodeId)}
            </h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close execution attempt details">
            Close
          </button>
        </header>

        <div className={styles.attemptBody}>
          <section aria-labelledby="attempt-provider">
            <h3 id="attempt-provider">Provider & model</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Requested provider" value={execution.provider.requested} />
              <Field label="Returned provider" value={execution.provider.returned} />
              <Field label="Requested model" value={execution.model.requested} />
              <Field label="Returned model" value={execution.model.returned} />
            </dl>
          </section>

          <section aria-labelledby="attempt-contract">
            <h3 id="attempt-contract">Prompt contract</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Prompt ID" value={execution.prompt.id} />
              <Field label="Prompt version" value={execution.prompt.version} />
              <Field label="Prompt hash" value={execution.prompt.hash} />
              <Field label="Output schema" value={execution.prompt.schemaVersion} />
              <Field label="Evidence mode" value={execution.evidenceMode} />
            </dl>
            <p className={styles.promptBoundary}>
              IDs, versions, and hashes only. Private prompt bodies are not rendered.
            </p>
          </section>

          <section aria-labelledby="attempt-validation">
            <h3 id="attempt-validation">Validation</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Execution ID" value={execution.id} />
              <Field label="Validation" value={execution.validation.label} />
              <Field label="Started" value={execution.startedAt} />
              <Field label="Ended" value={execution.endedAt} />
            </dl>
            {execution.validation.issues.length ? (
              <ul className={styles.validationIssues}>
                {execution.validation.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.noIssues}>No validation issues recorded.</p>
            )}
          </section>

          <section aria-labelledby="attempt-timing">
            <h3 id="attempt-timing">Timing</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Client latency" value={execution.latency.client} />
              <Field label="Queue" value={execution.latency.queue} />
              <Field label="Prompt" value={execution.latency.prompt} />
              <Field label="Completion" value={execution.latency.completion} />
              <Field label="Provider total" value={execution.latency.providerTotal} />
            </dl>
          </section>

          <section aria-labelledby="attempt-usage">
            <h3 id="attempt-usage">Usage & cost</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Input tokens" value={execution.usage.input} />
              <Field label="Output tokens" value={execution.usage.output} />
              <Field label="Total tokens" value={execution.usage.total} />
              <Field label="Cached input" value={execution.usage.cachedInput} />
              <Field label="Reasoning tokens" value={execution.usage.reasoning} />
              <Field label="Estimated cost" value={execution.cost.estimated} />
              <Field label="Input rate" value={execution.cost.inputRate} />
              <Field label="Output rate" value={execution.cost.outputRate} />
              <Field label="Pricing snapshot" value={execution.cost.snapshotDate} />
            </dl>
          </section>

          <section aria-labelledby="attempt-recovery">
            <h3 id="attempt-recovery">Recovery & errors</h3>
            <dl className={styles.auditFieldGrid}>
              <Field label="Retry of" value={execution.retryOfExecutionId} />
              <Field label="Fallback from" value={execution.fallbackFromExecutionId} />
              <Field label="Refusal" value={execution.refusal} />
            </dl>
            {execution.retryOfExecutionId !== "Unavailable" ? (
              <p className={styles.retryLink}>Retry of {execution.retryOfExecutionId}</p>
            ) : null}
            {execution.errors.length ? (
              <ol className={styles.errorList}>
                {execution.errors.map((error) => (
                  <li key={error.id}>
                    <strong>{humanize(error.kind)}</strong>
                    <span>{error.message}</span>
                    <small>
                      Error {error.id} · {error.retryable ? "Retry permitted" : "Retry not permitted"} · provider {error.providerCode} · HTTP {error.httpStatus}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.noIssues}>No errors recorded.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
