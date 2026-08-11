"use client";

import { useEffect, useRef, useState } from "react";

import { submitPacketReviewDecision } from "./packet-review-actions";
import type {
  PacketDecisionError,
  PacketReviewModel,
} from "./packet-review-state";
import styles from "./packet-review.module.css";

type PacketReviewProps = {
  model: PacketReviewModel;
};

type LocalDecision =
  | "pending"
  | "confirming_rejection"
  | "submitting"
  | "accepted"
  | "rejected";

const permissionLabels = {
  allowed: "Allowed",
  denied: "Denied",
  unknown: "Unknown",
} as const;

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

export function PacketReview({ model }: PacketReviewProps) {
  const [decision, setDecision] = useState<LocalDecision>("pending");
  const [decisionError, setDecisionError] = useState<PacketDecisionError | null>(null);
  const decisionStatusRef = useRef<HTMLDivElement>(null);
  const decisionErrorRef = useRef<HTMLDivElement>(null);
  const rejectionTitleRef = useRef<HTMLHeadingElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRejectFocusRef = useRef(false);
  const visibleDecisionError = decisionError ?? model.decisionSessionError;

  useEffect(() => {
    if (decision === "accepted" || decision === "rejected") {
      decisionStatusRef.current?.focus();
    } else if (decision === "confirming_rejection") {
      rejectionTitleRef.current?.focus();
    } else if (decision === "pending" && restoreRejectFocusRef.current) {
      restoreRejectFocusRef.current = false;
      rejectButtonRef.current?.focus();
    }
  }, [decision]);

  useEffect(() => {
    if (visibleDecisionError) decisionErrorRef.current?.focus();
  }, [visibleDecisionError]);

  async function recordDecision(nextDecision: "accept" | "reject") {
    if (!model.decisionSessionId) return;
    setDecisionError(null);
    setDecision("submitting");
    const result = await submitPacketReviewDecision(
      model.decisionSessionId,
      nextDecision,
    );
    if (!result.ok) {
      setDecision("pending");
      setDecisionError(result.error);
      return;
    }
    setDecision(nextDecision === "accept" ? "accepted" : "rejected");
  }

  const sourceLabel = `${model.sources.length} ${model.sources.length === 1 ? "source" : "sources"}`;
  const chunkCount = model.sources.reduce(
    (count, source) =>
      count + (source.display.state === "available" ? source.display.chunks.length : 0),
    0,
  );
  return (
    <section
      className={styles.packet}
      id="packet"
      aria-label="Source packet checkpoint"
      data-packet-state={model.state}
    >
      {model.scenario !== "frozen" ? (
        <aside className={styles.previewDisclosure}>
          <strong>Fixture packet state preview</strong>
          <span>
            This is not a live or persisted checkpoint. The recorded golden packet remains unchanged.
          </span>
        </aside>
      ) : null}
      <header className={styles.header}>
        <div>
          <span className={styles.index}>01 · Packet checkpoint</span>
          <h2>Review the bounded source packet</h2>
          <p>
            Confirm provenance, reproduction scope, and three independent rights
            before evidence extraction. A fingerprint proves packet immutability,
            not source authenticity.
          </p>
        </div>
        <div className={styles.stateBlock} data-state={model.state}>
          <span>{model.stateLabel}</span>
          <small>{model.stateDescription}</small>
        </div>
      </header>

      {model.state === "loading" ? (
        <div className={styles.loading} role="status" aria-live="polite">
          <strong>Loading packet review</strong>
          <span>No source or rights decision is implied while this projection loads.</span>
        </div>
      ) : (
        <>
          <div
            className={styles.receipt}
            role="group"
            aria-label="Packet freeze receipt"
          >
            <div className={styles.receiptPrimary}>
              <span>Freeze receipt</span>
              {model.packet ? (
                <code>{model.packet.fingerprint}</code>
              ) : (
                <strong>Not frozen</strong>
              )}
            </div>
            <dl>
              <div>
                <dt>Packet</dt>
                <dd>{model.packet ? `v${model.packet.version}` : "Draft"}</dd>
              </div>
              <div>
                <dt>Sources</dt>
                <dd>{sourceLabel}</dd>
              </div>
              <div>
                <dt>Chunks</dt>
                <dd>
                  {model.packet
                    ? `${model.packet.chunkHashCount} chunks`
                    : `${chunkCount} visible chunks`}
                </dd>
              </div>
              <div>
                <dt>Evidence mode</dt>
                <dd>{humanize(model.evidenceMode)}</dd>
              </div>
              <div>
                <dt>Frozen</dt>
                <dd>
                  {model.packet ? (
                    <time dateTime={model.packet.frozenAt}>
                      {new Date(model.packet.frozenAt).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "UTC",
                      })} UTC
                    </time>
                  ) : (
                    "Pending"
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {model.mutationError ? (
            <div className={styles.mutationError} role="alert">
              <div>
                <span>Preserved typed failure</span>
                <strong>Post-freeze mutation rejected</strong>
              </div>
              <code>
                {model.mutationError.name} · {model.mutationError.code} ·{" "}
                {model.mutationError.operation}
              </code>
              <p>{model.mutationError.message}</p>
            </div>
          ) : null}

          {model.boundaryError ? (
            <div
              className={styles.mutationError}
              role="alert"
              aria-live="assertive"
            >
              <div>
                <span>Typed boundary failure</span>
                <strong>Packet validation failed closed</strong>
              </div>
              <code>
                {model.boundaryError.name} · {model.boundaryError.code} ·{" "}
                {model.boundaryError.path}
              </code>
              <p>{model.boundaryError.message}</p>
            </div>
          ) : null}

          <div className={styles.body}>
            <section className={styles.blockers} aria-labelledby="packet-blockers-title">
              <header>
                <div>
                  <span className={styles.index}>Review gate</span>
                  <h3 id="packet-blockers-title">Packet blockers</h3>
                </div>
                <span>{model.blockers.length}</span>
              </header>
              {model.blockers.length === 0 ? (
                <p className={styles.clearState}>No packet blockers</p>
              ) : (
                <ul>
                  {model.blockers.map((blocker, index) => (
                    <li data-severity={blocker.severity} key={`${blocker.code}-${index}`}>
                      <strong>{humanize(blocker.code)}</strong>
                      <span>{blocker.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.ledger} aria-labelledby="packet-sources-title">
              <header>
                <div>
                  <span className={styles.index}>Source ledger</span>
                  <h3 id="packet-sources-title">Included source records</h3>
                </div>
                <span>{sourceLabel}</span>
              </header>

              {model.sources.length === 0 ? (
                <div className={styles.empty}>
                  <strong>No approved sources in this packet</strong>
                  <span>Add or approve a bounded source before attempting freeze.</span>
                </div>
              ) : (
                <ol className={styles.sourceList}>
                  {model.sources.map((source, index) => (
                    <li data-packet-source key={source.id}>
                      <details open={index === 0}>
                        <summary>
                          <span className={styles.sourceNumber}>
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className={styles.sourceIdentity}>
                            <strong>{source.title}</strong>
                            <small>
                              {source.canonicalDoi ?? source.canonicalUrl ?? "No canonical identifier"}
                            </small>
                          </span>
                          <span className={styles.sourceScope}>
                            {humanize(source.contentScope)}
                          </span>
                        </summary>

                        <div className={styles.sourceBody}>
                          <dl className={styles.provenanceGrid}>
                            <div>
                              <dt>Origin</dt>
                              <dd>{humanize(source.origin)}</dd>
                            </div>
                            <div>
                              <dt>Registration agency</dt>
                              <dd>{source.registrationAgency ?? "Not available"}</dd>
                            </div>
                            <div>
                              <dt>DOI resolution</dt>
                              <dd>
                                {humanize(source.doiSyntax)} · {humanize(source.doiResolution)}
                              </dd>
                            </div>
                            <div>
                              <dt>Provider / version</dt>
                              <dd>
                                {source.provider} · {source.version ?? "Version unavailable"}
                              </dd>
                            </div>
                            <div>
                              <dt>Exact location</dt>
                              <dd>{source.location}</dd>
                            </div>
                            <div>
                              <dt>Content hash</dt>
                              <dd><code>{source.contentHash}</code></dd>
                            </div>
                          </dl>

                          <div className={styles.rightsPanel}>
                            <div>
                              <span>Independent rights</span>
                              <dl>
                                <Permission label="Store" value={source.rights.mayStore} />
                                <Permission label="Display" value={source.rights.mayDisplay} />
                                <Permission label="Send to model" value={source.rights.maySendToModel} />
                              </dl>
                            </div>
                            <p>
                              <strong>Permission basis</strong>
                              <span>{source.permissionBasis}</span>
                            </p>
                          </div>

                          <div className={styles.contentBoundary}>
                            <div>
                              <span>Display projection</span>
                              {source.display.state === "available" ? (
                                source.display.chunks.map((chunk) => (
                                  <figure key={chunk.id}>
                                    <blockquote>{chunk.text}</blockquote>
                                    <figcaption>
                                      {chunk.location} · <code>{chunk.contentHash}</code>
                                    </figcaption>
                                  </figure>
                                ))
                              ) : (
                                <p className={styles.hiddenContent}>{source.display.reason}</p>
                              )}
                            </div>
                            <p className={styles.modelBoundary} data-model-access={source.modelAccess.state}>
                              <strong>
                                Model projection · {source.modelAccess.state}
                              </strong>
                              <span>{source.modelAccess.reason}</span>
                            </p>
                          </div>

                          {source.mergedSourceIds.length > 0 ? (
                            <div className={styles.duplicateWarning}>
                              <strong>Duplicate alias merged</strong>
                              <span>{source.mergedSourceIds.join(" · ")}</span>
                            </div>
                          ) : null}

                          {source.warnings.length > 0 ? (
                            <ul className={styles.warnings} aria-label={`Warnings for ${source.title}`}>
                              {source.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <div className={styles.decision}>
            <div>
              <span className={styles.index}>Human checkpoint</span>
              <h3>Packet freeze decision</h3>
              <p>
                Accept only the reviewed source set. Rejecting keeps evidence extraction blocked.
              </p>
            </div>

            {model.state === "frozen" && decision === "pending" ? (
              <div className={styles.recordedDecision}>
                <strong>Approved and frozen in fixture</strong>
                <span>The recorded fixture decision is read-only on this route.</span>
              </div>
            ) : model.state === "rejected" && decision === "pending" ? (
              <div className={styles.recordedDecision} data-tone="danger">
                <strong>Packet rejected</strong>
                <span>No freeze or downstream extraction is implied.</span>
              </div>
            ) : decision === "confirming_rejection" ? (
              <div className={styles.confirmation}>
                <h4 ref={rejectionTitleRef} tabIndex={-1}>Confirm packet rejection</h4>
                <p>This fixture preview will remain blocked from evidence extraction.</p>
                <div>
                  <button type="button" onClick={() => void recordDecision("reject")}>
                    Confirm rejection
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      restoreRejectFocusRef.current = true;
                      setDecision("pending");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : decision === "accepted" || decision === "rejected" ? (
              <div
                className={styles.decisionStatus}
                data-tone={decision === "rejected" ? "danger" : "success"}
                role="status"
                aria-live="polite"
                ref={decisionStatusRef}
                tabIndex={-1}
              >
                <strong>
                  {decision === "accepted"
                    ? "Packet accepted in this fixture preview"
                    : "Packet rejected in this fixture preview"}
                </strong>
                <span>
                  Process-local fixture decision recorded; the canonical run and packet remain unchanged.
                </span>
              </div>
            ) : decision === "submitting" ? (
              <div className={styles.decisionStatus} role="status" aria-live="polite">
                <strong>Recording fixture decision</strong>
                <span>The validated one-use decision capability is being checked.</span>
              </div>
            ) : model.canAccept || model.canReject ? (
              <div className={styles.actions}>
                <button
                  className={styles.primaryAction}
                  type="button"
                  disabled={!model.canAccept}
                  onClick={() => void recordDecision("accept")}
                >
                  Accept and freeze packet
                </button>
                <button
                  type="button"
                  ref={rejectButtonRef}
                  onClick={() => setDecision("confirming_rejection")}
                >
                  Reject packet
                </button>
                {!model.canAccept ? (
                  <span>Acceptance is disabled while a blocking packet issue remains.</span>
                ) : null}
              </div>
            ) : (
              <p className={styles.unavailableDecision}>
                Decision controls are unavailable in this state.
              </p>
            )}

            {visibleDecisionError ? (
              <div
                className={styles.mutationError}
                role="alert"
                aria-live="assertive"
                ref={decisionErrorRef}
                tabIndex={-1}
              >
                <div>
                  <span>Typed decision failure</span>
                  <strong>Packet decision rejected</strong>
                </div>
                <code>
                  {visibleDecisionError.name} · {visibleDecisionError.code}
                </code>
                <p>{visibleDecisionError.message}</p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function Permission({ label, value }: { label: string; value: keyof typeof permissionLabels }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-permission={value}>{permissionLabels[value]}</dd>
    </div>
  );
}
