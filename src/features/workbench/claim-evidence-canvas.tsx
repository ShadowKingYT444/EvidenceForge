"use client";

import { AlertTriangle, Check, CircleHelp, X, XCircle } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useFocusBoundary } from "../use-focus-boundary";
import type { EvidenceMatrixModel, MatrixCell } from "./evidence-matrix-state";
import type { PacketReviewSource } from "./packet-review-state";
import styles from "./claim-evidence-canvas.module.css";

type ClaimEvidenceCanvasProps = {
  active?: boolean;
  model: EvidenceMatrixModel;
  packetSources: PacketReviewSource[];
  initialEvidenceId?: string | null;
  relationshipFilter?: "all" | "contradicts";
  onClearFilter?: () => void;
};

const relationshipIcons = {
  supports: Check,
  contradicts: XCircle,
  unresolved: CircleHelp,
  mixed: AlertTriangle,
  missing: X,
} as const;

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function recorded(value: string | null) {
  return value ?? "Not recorded";
}

export function ClaimEvidenceCanvas({
  active = true,
  model,
  packetSources,
  initialEvidenceId = null,
  relationshipFilter = "all",
  onClearFilter,
}: ClaimEvidenceCanvasProps) {
  const allCells = useMemo(
    () => model.rows.flatMap(({ cells }) => cells),
    [model.rows],
  );
  const initialCell = useMemo(
    () => allCells.find((cell) =>
      initialEvidenceId ? cell.evidenceIds.includes(initialEvidenceId) : false,
    ) ?? null,
    [allCells, initialEvidenceId],
  );
  const [selected, setSelected] = useState<MatrixCell | null>(initialCell);
  const [activeClaimIndex, setActiveClaimIndex] = useState(0);
  const sourceById = useMemo(
    () => new Map(packetSources.map((source) => [source.id, source])),
    [packetSources],
  );
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const inspectorDialog = useRef<HTMLElement | null>(null);
  const inspectorClose = useRef<HTMLButtonElement | null>(null);

  function openInspector(cell: MatrixCell, target: HTMLButtonElement) {
    returnTarget.current = target;
    setSelected(cell);
  }

  function closeInspector() {
    setSelected(null);
    requestAnimationFrame(() => returnTarget.current?.focus());
  }

  useFocusBoundary({
    active: active && selected !== null,
    boundaryRef: inspectorDialog,
    initialFocusRef: inspectorClose,
    onDismiss: closeInspector,
  });

  return (
    <div className={styles.layout}>
      <section className={styles.canvas} id="evidence-canvas" aria-label="Evidence">
        <header className={styles.header}>
          <label className={styles.claimSelector}>
            <span>Select claim</span>
            <select
              aria-label="Select claim"
              value={activeClaimIndex}
              onChange={(event) => setActiveClaimIndex(Number(event.target.value))}
            >
              {model.rows.map((row, index) => (
                <option key={row.claim.id} value={index}>{row.claim.label}</option>
              ))}
            </select>
          </label>
          <div className={styles.totals} aria-label="Evidence relationship summary">
            <span>{model.summary.evidenceCount} traceable cards</span>
            <span>{model.summary.missingCount} missing links</span>
          </div>
        </header>
        {relationshipFilter === "contradicts" ? (
          <div className={styles.filterNotice} role="status">
            <span>Filtered to contradictions</span>
            <button type="button" onClick={onClearFilter}>Show all relationships</button>
          </div>
        ) : null}

        {model.state !== "ready" ? (
          <div className={styles.empty} role={model.state === "error" ? "alert" : "status"}>
            <strong>{model.state === "error" ? "Evidence unavailable" : "Evidence " + model.state}</strong>
            <span>{model.error?.message ?? "No relationship is treated as available yet."}</span>
          </div>
        ) : (
          <FocusedClaim
            row={model.rows[activeClaimIndex] ?? model.rows[0]}
            relationshipFilter={relationshipFilter}
            selected={selected}
            onOpenInspector={openInspector}
          />
        )}
      </section>

      {active && selected ? (
        <EvidenceInspector
          cell={selected}
          source={sourceById.get(selected.sourceId) ?? null}
          dialogRef={inspectorDialog}
          closeRef={inspectorClose}
          onClose={closeInspector}
        />
      ) : null}
    </div>
  );
}

function FocusedClaim({
  row,
  relationshipFilter,
  selected,
  onOpenInspector,
}: {
  row: EvidenceMatrixModel["rows"][number];
  relationshipFilter: "all" | "contradicts";
  selected: MatrixCell | null;
  onOpenInspector: (cell: MatrixCell, target: HTMLButtonElement) => void;
}) {
  const visibleCells = relationshipFilter === "contradicts"
    ? row.cells.filter((cell) => cell.relationship === "contradicts")
    : row.cells.filter((cell) => cell.relationship !== "missing");
  const unlinkedCells = row.cells.filter((cell) => cell.relationship === "missing");
  const counts = row.cells.reduce(
    (result, cell) => {
      result[cell.relationship] += cell.evidenceCount;
      return result;
    },
    { supports: 0, contradicts: 0, unresolved: 0, mixed: 0, missing: 0 },
  );

  return (
    <article className={styles.claim} data-active-claim={row.claim.id}>
      <header className={styles.claimHeader}>
        <div>
          <span>{row.claim.label}</span>
          <h2>{row.claim.statement}</h2>
        </div>
        <dl className={styles.counts} aria-label="Relationship summary">
          <div data-relationship="supports"><dt>Support</dt><dd>{counts.supports}</dd></div>
          <div data-relationship="contradicts"><dt>Conflict</dt><dd>{counts.contradicts}</dd></div>
          <div data-relationship="unresolved"><dt>Unresolved</dt><dd>{counts.unresolved}</dd></div>
        </dl>
      </header>
      {visibleCells.length ? (
        <div className={styles.relationships}>
          {visibleCells.map((cell) => {
            const Icon = relationshipIcons[cell.relationship];
            return (
              <button
                className={styles.relationship}
                data-relationship={cell.relationship}
                data-warning={cell.warningState}
                key={cell.id}
                type="button"
                aria-expanded={selected?.id === cell.id}
                aria-controls="scientific-evidence-inspector"
                aria-label={"Inspect " + cell.relationshipLabel + " relationship between " + cell.claimLabel + " and " + cell.sourceLabel + ". " + cell.warningLabel}
                onClick={(event) => onOpenInspector(cell, event.currentTarget)}
              >
                <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
                <span>
                  <strong>{cell.sourceLabel} · {cell.relationshipLabel}</strong>
                  <small>{cell.evidenceCount} evidence · {cell.warningLabel}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className={styles.empty}>No matching relationships are recorded for this claim.</p>
      )}
      {relationshipFilter === "all" && unlinkedCells.length > 0 ? (
        <details className={styles.unlinkedSources}>
          <summary>{unlinkedCells.length} unlinked sources</summary>
          <div className={styles.relationships}>
            {unlinkedCells.map((cell) => {
              const Icon = relationshipIcons[cell.relationship];
              return (
                <button
                  className={styles.relationship}
                  data-relationship={cell.relationship}
                  key={cell.id}
                  type="button"
                  aria-label={"Inspect " + cell.relationshipLabel + " relationship between " + cell.claimLabel + " and " + cell.sourceLabel + ". " + cell.warningLabel}
                  onClick={(event) => onOpenInspector(cell, event.currentTarget)}
                >
                  <Icon aria-hidden="true" size={15} />
                  <span><strong>{cell.sourceLabel} · {cell.relationshipLabel}</strong><small>{cell.warningLabel}</small></span>
                </button>
              );
            })}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function EvidenceInspector({
  cell,
  source,
  dialogRef,
  closeRef,
  onClose,
}: {
  cell: MatrixCell;
  source: PacketReviewSource | null;
  dialogRef: React.RefObject<HTMLElement | null>;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"evidence" | "review" | "audit">("evidence");
  const evidence = cell.evidence.find((item) => item.state === "available") ?? null;

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={styles.inspector}
        id="scientific-evidence-inspector"
        role="dialog"
        aria-modal="true"
        aria-label="Evidence details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.inspectorHeader}>
          <div>
            <span>Context inspector</span>
            <h2>{cell.claimLabel + " × " + cell.sourceLabel}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close evidence details">
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <div className={styles.inspectorTabs} role="tablist" aria-label="Evidence detail sections">
          <button type="button" role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button>
          <button type="button" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>Review</button>
          <button type="button" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>Audit</button>
        </div>
        {tab === "evidence" ? (
          <div className={styles.inspectorBody}>
            <InspectorSection title="Summary">
              <p><strong>{cell.relationshipLabel}</strong> · {cell.evidenceCount} linked evidence card(s)</p>
              <p>{cell.claimStatement}</p>
              {cell.warnings.length > 0 ? <ul>{cell.warnings.map((item) => <li key={item}>{item}</li>)}</ul> : null}
            </InspectorSection>
            <InspectorSection title="Passage">
              {evidence && evidence.state === "available" ? (
                <>
                  <blockquote>{evidence.excerpt}</blockquote>
                  <p>{evidence.location} · {humanize(evidence.contentScope)}</p>
                  <p><strong>Limitation:</strong> {evidence.limitation}</p>
                </>
              ) : <p>No permitted passage is available for this relationship.</p>}
            </InspectorSection>
            <InspectorSection title="Mechanical checks">
              {evidence && evidence.state === "available" ? (
                <dl>
                  <div><dt>Status</dt><dd>{humanize(evidence.deterministicVerification.status)}</dd></div>
                  <div><dt>Method</dt><dd>{evidence.deterministicVerification.method}</dd></div>
                  <div><dt>Details</dt><dd>{evidence.deterministicVerification.details}</dd></div>
                </dl>
              ) : <p>Not available.</p>}
            </InspectorSection>
          </div>
        ) : tab === "review" ? (
          <div className={styles.inspectorBody}>
            <InspectorSection title="Model assessment">
              {evidence && evidence.state === "available" ? (
                <dl>
                  <div><dt>Entailment</dt><dd>{humanize(evidence.modelAssessment.entailment)}</dd></div>
                  <div><dt>Rationale</dt><dd>{evidence.modelAssessment.rationale}</dd></div>
                  <div><dt>Provider / model</dt><dd>{evidence.modelAssessment.provider} · {evidence.modelAssessment.requestedModelId}</dd></div>
                </dl>
              ) : <p>Not available.</p>}
            </InspectorSection>
            <InspectorSection title="Human review">
              {evidence && evidence.state === "available" ? (
                <dl>
                  <div><dt>Status</dt><dd>{humanize(evidence.humanReview.status)}</dd></div>
                  <div><dt>Reason</dt><dd>{recorded(evidence.humanReview.reason)}</dd></div>
                  <div><dt>Reviewer</dt><dd>{recorded(evidence.humanReview.reviewerId)}</dd></div>
                </dl>
              ) : <p>Not available.</p>}
            </InspectorSection>
            <InspectorSection title="Source and rights">
              {source ? (
                <dl>
                  <div><dt>Source</dt><dd>{source.title}</dd></div>
                  <div><dt>Store</dt><dd>{humanize(source.rights.mayStore)}</dd></div>
                  <div><dt>Display</dt><dd>{humanize(source.rights.mayDisplay)}</dd></div>
                  <div><dt>Send to model</dt><dd>{humanize(source.rights.maySendToModel)}</dd></div>
                  <div><dt>Scope</dt><dd>{humanize(source.contentScope)}</dd></div>
                </dl>
              ) : <p>Source details are hidden by the packet boundary.</p>}
            </InspectorSection>
          </div>
        ) : (
          <div className={styles.inspectorBody}>
            <InspectorSection title="Audit">
              <p>Evidence record IDs: {cell.evidenceIds.join(", ") || "None"}</p>
              <p>Open the Audit stage for provider attempts, validation, failures, and retries.</p>
            </InspectorSection>
          </div>
        )}
      </section>
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.inspectorSection}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
