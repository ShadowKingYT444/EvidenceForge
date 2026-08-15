"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type {
  EvidenceMatrixModel,
  MatrixCell,
  MatrixHiddenReasonCode,
} from "./evidence-matrix-state";
import styles from "./evidence-matrix.module.css";

type EvidenceMatrixProps = {
  model: EvidenceMatrixModel;
  initialEvidenceId?: string | null;
};

export function EvidenceMatrix({
  model,
  initialEvidenceId = null,
}: EvidenceMatrixProps) {
  const allCells = model.rows.flatMap(({ cells }) => cells);
  const initialSelectedId =
    allCells.find(({ evidenceIds }) =>
      initialEvidenceId ? evidenceIds.includes(initialEvidenceId) : false,
    )?.id ?? null;
  const [activeId, setActiveId] = useState(allCells[0]?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const selected = allCells.find(({ id }) => id === selectedId) ?? null;

  useEffect(() => {
    if (selected) detailHeading.current?.focus();
  }, [selected]);

  function move(cell: MatrixCell, rowDelta: number, columnDelta: number) {
    const target = model.rows[cell.rowIndex + rowDelta]?.cells[cell.columnIndex + columnDelta];
    if (!target) return;
    setActiveId(target.id);
    buttons.current.get(target.id)?.focus();
  }

  function handleCellKeyDown(event: KeyboardEvent<HTMLButtonElement>, cell: MatrixCell) {
    if (event.key === "Enter" || event.key === " " || event.key === "Space") {
      event.preventDefault();
      selectCell(cell);
      return;
    }
    const directions: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    move(cell, direction[0], direction[1]);
  }

  function selectCell(cell: MatrixCell) {
    setActiveId(cell.id);
    setSelectedId(cell.id);
  }

  function closeDetail() {
    const returnId = selectedId;
    setSelectedId(null);
    requestAnimationFrame(() => {
      if (returnId) buttons.current.get(returnId)?.focus();
    });
  }

  return (
    <section
      className={styles.surface}
      id="evidence-matrix"
      aria-label="Claim by source evidence matrix"
    >
      <header className={styles.header}>
        <div>
          <span className={styles.index}>03 · Evidence</span>
          <h2>Claim × source matrix</h2>
        </div>
        <span className={styles.sourceOfTruth}>Screen-reader source of truth</span>
      </header>
      <p className={styles.lead}>
        Read across each claim, then open a relationship cell for its exact evidence.
        Metadata checks, model assessment, and human review remain separate.
      </p>
      {model.disclosure ? (
        <p className={styles.disclosure}>{model.disclosure}</p>
      ) : null}
      {model.state === "loading" ? (
        <div className={styles.state} role="status" aria-live="polite">
          <strong>Loading evidence matrix</strong>
          <span>No relationship is treated as available until projection completes.</span>
        </div>
      ) : model.state === "empty" ? (
        <div className={styles.state}>
          <strong>No claim or source relationships</strong>
          <span>The absence is explicit and is not counted as successful evidence.</span>
        </div>
      ) : model.state === "error" ? (
        <div className={styles.state} role="alert">
          <strong>Evidence matrix unavailable</strong>
          <span>{model.error?.message}</span>
          <code>{model.error?.code}</code>
        </div>
      ) : (
        <>
          <div className={styles.summary} aria-label="Matrix summary">
            <span>{model.summary.claimCount} claim rows</span>
            <span>{model.summary.sourceCount} source columns</span>
            <span>{model.summary.evidenceCount} traceable cards</span>
            <span>{model.summary.missingCount} missing relationships</span>
          </div>
          <div className={styles.legend} aria-label="Relationship legend">
            <Legend symbol="+" label="Supports" relationship="supports" />
            <Legend symbol="×" label="Contradicts" relationship="contradicts" />
            <Legend symbol="?" label="Unresolved" relationship="unresolved" />
            <Legend symbol="≠" label="Metadata mismatch" relationship="mismatch" />
            <Legend symbol="!" label="Verification failure" relationship="failure" />
            <Legend symbol="∅" label="Missing evidence" relationship="missing" />
          </div>
          <div
            className={styles.tableScroll}
            role="region"
            tabIndex={0}
            aria-label="Scrollable evidence matrix"
          >
            <table className={styles.table}>
              <caption>Claim by source evidence relationships</caption>
              <thead>
                <tr>
                  <th scope="col">Claim</th>
                  {model.sources.map((source) => (
                    <th scope="col" key={source.id}>
                      <span>{source.label}</span>
                      {source.state === "available" ? (
                        <>
                          <strong>{source.title}</strong>
                          <small>{source.identifier}</small>
                        </>
                      ) : (
                        <strong>Source details hidden</strong>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.claim.id}>
                    <th scope="row">
                      <span>{row.claim.label}</span>
                      <strong>{row.claim.statement}</strong>
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.id}>
                        <button
                          id={`matrix-cell-${cell.id}`}
                          ref={(element) => {
                            if (element) buttons.current.set(cell.id, element);
                            else buttons.current.delete(cell.id);
                          }}
                          type="button"
                          className={styles.cell}
                          data-relationship={cell.relationship}
                          data-warning={cell.warningState}
                          aria-label={cell.accessibleLabel}
                          aria-expanded={selectedId === cell.id}
                          aria-controls="evidence-verification-drawer"
                          tabIndex={activeId === cell.id ? 0 : -1}
                          onFocus={() => setActiveId(cell.id)}
                          onKeyDown={(event) => handleCellKeyDown(event, cell)}
                          onClick={() => selectCell(cell)}
                        >
                          <span className={styles.cellTop}>
                            <span className={styles.relationshipSymbol} aria-hidden="true">
                              {cell.relationshipSymbol}
                            </span>
                            <strong>{cell.relationshipLabel}</strong>
                          </span>
                          <span className={styles.evidenceCount}>
                            {cell.evidenceCount} {cell.evidenceCount === 1 ? "evidence" : "evidence"}
                          </span>
                          <span className={styles.warningGroup}>
                            {cell.warningConditions.map((condition) => (
                              <span
                                className={styles.warningFlag}
                                data-warning={condition.kind}
                                key={condition.kind}
                              >
                                <span aria-hidden="true">{condition.symbol}</span>
                                {condition.label}
                              </span>
                            ))}
                          </span>
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selected ? (
        <EvidenceVerificationDrawer
          cell={selected}
          headingRef={detailHeading}
          onClose={closeDetail}
        />
      ) : (
        <p className={styles.selectionHint}>
          Select a labeled matrix cell to inspect exact evidence. Arrow keys move between cells.
        </p>
      )}
    </section>
  );
}

function Legend({
  symbol,
  label,
  relationship,
}: {
  symbol: string;
  label: string;
  relationship: string;
}) {
  return (
    <span className={styles.legendItem} data-relationship={relationship}>
      <span aria-hidden="true">{symbol}</span>
      {label}
    </span>
  );
}

function EvidenceVerificationDrawer({
  cell,
  headingRef,
  onClose,
}: {
  cell: MatrixCell;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  return (
    <aside
      id="evidence-verification-drawer"
      className={styles.detail}
      role="dialog"
      aria-modal="false"
      aria-labelledby="evidence-verification-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className={styles.detailHeader}>
        <div>
          <span>03 · Source ledger · {cell.relationshipLabel} · {cell.warningLabel}</span>
          <h3 id="evidence-verification-title" ref={headingRef} tabIndex={-1}>
            Evidence verification · {cell.claimLabel} × {cell.sourceLabel}
          </h3>
        </div>
        <button type="button" onClick={onClose}>Close evidence drawer</button>
      </header>
      <div className={styles.detailContext}>
        <p><strong>Claim</strong>{cell.claimStatement}</p>
        <p>
          <strong>Source</strong>
          {cell.sourceDisplay.state === "available" ? (
            <>{cell.sourceDisplay.title}<small>{cell.sourceDisplay.identifier}</small></>
          ) : "Source details hidden"}
        </p>
      </div>
      <SourceLedger ledger={cell.sourceLedger} />
      {cell.warnings.length > 0 ? (
        <div className={styles.detailWarnings} data-warning={cell.warningState}>
          <strong>{cell.warningLabel}</strong>
          <ul>{cell.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}
      {cell.evidence.length === 0 ? (
        <p className={styles.missingDetail}>
          Missing evidence · zero approved evidence cards link this claim and source.
        </p>
      ) : (
        <div className={styles.evidenceList}>
          {cell.evidence.map((evidence) => (
            <article key={evidence.id} className={styles.evidenceCard}>
              <header>
                <span>Evidence record</span>
                <strong>{evidence.id}</strong>
              </header>
              {evidence.state === "hidden" ? (
                <p className={styles.hiddenExcerpt}>{hiddenReasonText(evidence.reasonCode)}</p>
              ) : (
                <>
                  <h4 className={styles.recordHeading}>Permitted source excerpt</h4>
                  <blockquote>{evidence.excerpt}</blockquote>
                  <p className={styles.location}>
                    {evidence.location} · {humanize(evidence.contentScope)}
                  </p>
                  <div className={styles.verificationLayers}>
                    <section>
                      <h4>Deterministic passage check</h4>
                      <p>Status: {humanize(evidence.deterministicVerification.status)}</p>
                      <dl>
                        <div><dt>Method</dt><dd>{evidence.deterministicVerification.method}</dd></div>
                        <div><dt>Details</dt><dd>{evidence.deterministicVerification.details}</dd></div>
                        <div><dt>Checked at</dt><dd>{recorded(evidence.deterministicVerification.checkedAt)}</dd></div>
                      </dl>
                    </section>
                    <section>
                      <h4>Model entailment</h4>
                      <p>Assessment: {humanize(evidence.modelAssessment.entailment)}</p>
                      <dl>
                        <div><dt>Rationale</dt><dd>{evidence.modelAssessment.rationale}</dd></div>
                        <div><dt>Provider / requested model</dt><dd>{evidence.modelAssessment.provider} · {evidence.modelAssessment.requestedModelId}</dd></div>
                        <div><dt>Returned model</dt><dd>{recorded(evidence.modelAssessment.returnedModelId)}</dd></div>
                        <div><dt>Prompt</dt><dd>{evidence.modelAssessment.promptId} · {evidence.modelAssessment.promptVersion}</dd></div>
                      </dl>
                    </section>
                    <section>
                      <h4>Human review</h4>
                      <p>Status: {humanize(evidence.humanReview.status)}</p>
                      <dl>
                        <div><dt>Reason</dt><dd>{recorded(evidence.humanReview.reason)}</dd></div>
                        <div><dt>Reviewer</dt><dd>{recorded(evidence.humanReview.reviewerId)}</dd></div>
                        <div><dt>Reviewed at</dt><dd>{recorded(evidence.humanReview.reviewedAt)}</dd></div>
                      </dl>
                    </section>
                  </div>
                  <div className={styles.analysis}>
                    <p><strong>Extracted result</strong>{evidence.extractedResult}</p>
                    <p><strong>Setting and sample</strong>{evidence.settingAndSample}</p>
                    <p><strong>Study type</strong>{evidence.studyType}</p>
                    <p><strong>Limitation</strong>{evidence.limitation}</p>
                    <p>
                      <strong>Overclaiming warning</strong>
                      {evidence.conclusionStrengthWarning ?? "No overclaim warning recorded for this evidence card."}
                    </p>
                    <div>
                      <strong>Extraction issues</strong>
                      {evidence.extractionIssues.length > 0 ? (
                        <ul>{evidence.extractionIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
                      ) : (
                        <p>No extraction issues recorded.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}

function SourceLedger({ ledger }: { ledger: MatrixCell["sourceLedger"] }) {
  if (ledger.state === "hidden") {
    return (
      <section className={styles.sourceLedger} aria-labelledby="source-ledger-title">
        <header>
          <div>
            <span>Deterministic source record</span>
            <h4 id="source-ledger-title">Source ledger</h4>
          </div>
          <code>{ledger.sourceId}</code>
        </header>
        <p className={styles.ledgerHidden}>
          Source ledger details are hidden by the same display-rights boundary.
        </p>
      </section>
    );
  }
  const metadataLabel = {
    match: "Metadata match",
    mismatch: "Metadata mismatch",
    unavailable: "Metadata unavailable",
    not_checked: "Metadata not checked",
  }[ledger.metadataVerification.status];

  return (
    <section className={styles.sourceLedger} aria-labelledby="source-ledger-title">
      <header>
        <div>
          <span>Deterministic source record</span>
          <h4 id="source-ledger-title">Source ledger</h4>
        </div>
        <code>{ledger.sourceId}</code>
      </header>
      <dl className={styles.ledgerGrid}>
        <div>
          <dt>Identifier</dt>
          <dd>
            {ledger.identifier.href ? (
              <a href={ledger.identifier.href} target="_blank" rel="noreferrer noopener">
                {ledger.identifier.value}
              </a>
            ) : ledger.identifier.value}
          </dd>
        </div>
        <div>
          <dt>Identifier resolution</dt>
          <dd>Status: {humanize(ledger.identifierResolution.resolution)} · Syntax: {humanize(ledger.identifierResolution.syntax)}</dd>
        </div>
        <div>
          <dt>Registration Agency</dt>
          <dd>{recorded(ledger.identifierResolution.registrationAgency)}</dd>
        </div>
        <div>
          <dt>Resolution checked at</dt>
          <dd>{recorded(ledger.identifierResolution.checkedAt)}</dd>
        </div>
        <div>
          <dt>Content scope</dt>
          <dd>{humanize(ledger.contentScope)}</dd>
        </div>
      </dl>
      <dl className={styles.ledgerGrid}>
        <div><dt>Access provider</dt><dd>{ledger.accessDetails.provider}</dd></div>
        <div><dt>Version</dt><dd>{recorded(ledger.accessDetails.version)}</dd></div>
        <div><dt>Source location</dt><dd>{ledger.accessDetails.location}</dd></div>
        <div><dt>Retrieved at</dt><dd>{ledger.accessDetails.retrievedAt}</dd></div>
      </dl>
      <div className={styles.ledgerSections}>
        <section>
          <h5>Metadata comparison</h5>
          <strong>{metadataLabel}</strong>
          <p>{ledger.metadataVerification.details.method}</p>
          <p>Checked at: {recorded(ledger.metadataVerification.details.checkedAt)}</p>
          {ledger.metadataVerification.details.fieldDiffs.length > 0 ? (
            <ul>
              {ledger.metadataVerification.details.fieldDiffs.map(({ field, expected, observed }) => (
                <li key={`${field}:${expected}:${observed}`}>
                  <strong>{field}</strong> Canonical: {recorded(expected)} · Supplied: {recorded(observed)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No field-level metadata differences recorded.</p>
          )}
        </section>
        <section>
          <h5>Integrity notices</h5>
          {ledger.integrityNotices.length > 0 ? (
            <ul>
              {ledger.integrityNotices.map((notice) => (
                <li key={`${notice.kind}:${notice.checkedAt}:${notice.href ?? "unlinked"}:${notice.affectsSource}`}>
                  <strong>{humanize(notice.kind)}</strong> · {notice.affectsSource ? "Affects this source" : "Does not affect this source"} · checked {notice.checkedAt}
                  {notice.href ? (
                    <> · <a href={notice.href} target="_blank" rel="noreferrer noopener">Open notice</a></>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No integrity notice records in this packet.</p>
          )}
        </section>
        {ledger.sourceWarnings.length > 0 ? (
          <section>
            <h5>Source limitations</h5>
            <ul>{ledger.sourceWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function recorded(value: string | null) {
  return value ?? "Not recorded";
}

function hiddenReasonText(code: MatrixHiddenReasonCode) {
  const reasons: Record<MatrixHiddenReasonCode, string> = {
    packet_display_hidden: "Display permission is denied; source text is not rendered.",
    source_display_denied: "Display permission is denied; source text is not rendered.",
    source_display_unknown: "Display permission is unknown; source text is not rendered.",
    chunk_display_denied: "Chunk display permission is denied; source text is not rendered.",
    chunk_display_unknown: "Chunk display permission is unknown; source text is not rendered.",
  };
  return reasons[code];
}
