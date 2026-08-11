import type { WorkbenchModel } from "./workbench-state";
import styles from "./workbench-shell.module.css";

type ExecutionAuditRailProps = {
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

export function ExecutionAuditRail({ audit }: ExecutionAuditRailProps) {
  return (
    <details className={styles.auditRegion} id="audit" open>
      <summary>
        <span>
          <span className={styles.sectionIndex}>07 · Audit</span>
          <strong>Execution ledger</strong>
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
                <summary>
                  <span className={styles.attemptIndex} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.attemptIdentity}>
                    <strong>{humanize(execution.nodeId)}</strong>
                    <small>
                      Attempt {execution.attempt} · {execution.evidenceMode}
                    </small>
                    {execution.validation.issues[0] ? (
                      <span>{execution.validation.issues[0]}</span>
                    ) : null}
                  </span>
                  <span
                    className={styles.executionStatus}
                    data-running={execution.isRunning ? "true" : "false"}
                  >
                    {execution.statusLabel}
                  </span>
                </summary>

                <div className={styles.attemptBody}>
                  <section aria-labelledby={`${execution.id}-provider`}>
                    <h3 id={`${execution.id}-provider`}>Provider & model</h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field
                        label="Requested provider"
                        value={execution.provider.requested}
                      />
                      <Field
                        label="Returned provider"
                        value={execution.provider.returned}
                      />
                      <Field
                        label="Requested model"
                        value={execution.model.requested}
                      />
                      <Field
                        label="Returned model"
                        value={execution.model.returned}
                      />
                    </dl>
                  </section>

                  <section aria-labelledby={`${execution.id}-contract`}>
                    <h3 id={`${execution.id}-contract`}>Prompt contract</h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field label="Prompt ID" value={execution.prompt.id} />
                      <Field
                        label="Prompt version"
                        value={execution.prompt.version}
                      />
                      <Field
                        label="Prompt hash"
                        value={execution.prompt.hash}
                      />
                      <Field
                        label="Output schema"
                        value={execution.prompt.schemaVersion}
                      />
                      <Field
                        label="Evidence mode"
                        value={execution.evidenceMode}
                      />
                    </dl>
                    <p className={styles.promptBoundary}>
                      IDs, versions, and hashes only. Private prompt bodies are
                      not rendered.
                    </p>
                  </section>

                  <section aria-labelledby={`${execution.id}-validation`}>
                    <h3 id={`${execution.id}-validation`}>Validation</h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field label="Execution ID" value={execution.id} />
                      <Field
                        label="Validation"
                        value={execution.validation.label}
                      />
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
                      <p className={styles.noIssues}>
                        No validation issues recorded.
                      </p>
                    )}
                  </section>

                  <section aria-labelledby={`${execution.id}-timing`}>
                    <h3 id={`${execution.id}-timing`}>Timing</h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field
                        label="Client latency"
                        value={execution.latency.client}
                      />
                      <Field label="Queue" value={execution.latency.queue} />
                      <Field label="Prompt" value={execution.latency.prompt} />
                      <Field
                        label="Completion"
                        value={execution.latency.completion}
                      />
                      <Field
                        label="Provider total"
                        value={execution.latency.providerTotal}
                      />
                    </dl>
                  </section>

                  <section aria-labelledby={`${execution.id}-usage`}>
                    <h3 id={`${execution.id}-usage`}>Usage & cost</h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field
                        label="Input tokens"
                        value={execution.usage.input}
                      />
                      <Field
                        label="Output tokens"
                        value={execution.usage.output}
                      />
                      <Field
                        label="Total tokens"
                        value={execution.usage.total}
                      />
                      <Field
                        label="Cached input"
                        value={execution.usage.cachedInput}
                      />
                      <Field
                        label="Reasoning tokens"
                        value={execution.usage.reasoning}
                      />
                      <Field
                        label="Estimated cost"
                        value={execution.cost.estimated}
                      />
                      <Field
                        label="Input rate"
                        value={execution.cost.inputRate}
                      />
                      <Field
                        label="Output rate"
                        value={execution.cost.outputRate}
                      />
                      <Field
                        label="Pricing snapshot"
                        value={execution.cost.snapshotDate}
                      />
                    </dl>
                  </section>

                  <section aria-labelledby={`${execution.id}-recovery`}>
                    <h3 id={`${execution.id}-recovery`}>
                      Recovery & errors
                    </h3>
                    <dl className={styles.auditFieldGrid}>
                      <Field
                        label="Retry of"
                        value={execution.retryOfExecutionId}
                      />
                      <Field
                        label="Fallback from"
                        value={execution.fallbackFromExecutionId}
                      />
                      <Field label="Refusal" value={execution.refusal} />
                    </dl>
                    {execution.retryOfExecutionId !== "Unavailable" ? (
                      <p className={styles.retryLink}>
                        Retry of {execution.retryOfExecutionId}
                      </p>
                    ) : null}
                    {execution.errors.length ? (
                      <ol className={styles.errorList}>
                        {execution.errors.map((error) => (
                          <li key={error.id}>
                            <strong>{humanize(error.kind)}</strong>
                            <span>{error.message}</span>
                            <small>
                              Error {error.id} ·{" "}
                              {error.retryable
                                ? "Retry permitted"
                                : "Retry not permitted"}{" "}
                              · provider {error.providerCode} · HTTP{" "}
                              {error.httpStatus}
                            </small>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className={styles.noIssues}>No errors recorded.</p>
                    )}
                  </section>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
