import { ArrowRight, Check, GitCompareArrows, RotateCcw, Sparkles } from "lucide-react";

import type { ChangeId, EpistemicBuild, EpistemicChange } from "./contracts";
import { StateBadge } from "./primitives";
import styles from "./workspace.module.css";

export function PerturbMode({
  build,
  changes,
  appliedChangeIds,
  busy,
  onApply,
  onReset,
  onReview,
}: {
  build: EpistemicBuild;
  changes: EpistemicChange[];
  appliedChangeIds: ChangeId[];
  busy: boolean;
  onApply: (id: ChangeId) => void;
  onReset: () => void;
  onReview: () => void;
}) {
  const duration = build.graph.nodes.find((node) => node.id === "claim:loaded-duration");
  const experiment = build.graph.nodes.find((node) => node.id === "experiment:loaded-comparison");
  const nextChange = changes[appliedChangeIds.length] ?? null;
  const before = appliedChangeIds.length === 0 ? "conflicting" : appliedChangeIds.length === 1 ? "conflicting" : "insufficient";
  const after = duration?.state ?? "conflicting";
  return (
    <section className={styles.modePanel} aria-labelledby="perturb-mode-title">
      <header className={styles.modeHeading}>
        <div><span className={styles.eyebrow}>Perturbation lab</span><h1 id="perturb-mode-title">Change the evidence. Recompile the consequences.</h1></div>
        <button className={styles.textButton} type="button" disabled={busy || appliedChangeIds.length === 0} onClick={onReset}>
          <RotateCcw aria-hidden="true" size={14} /> Reset branch
        </button>
      </header>
      <div className={styles.perturbLayout}>
        <ol className={styles.changeList}>
          {changes.map((change, index) => {
            const applied = appliedChangeIds.includes(change.id);
            const active = index === appliedChangeIds.length;
            return (
              <li key={change.id} data-applied={applied} data-active={active}>
                <span>{applied ? <Check aria-hidden="true" size={14} /> : index + 1}</span>
                <div><strong>{change.label}</strong><p>{change.description}</p>{change.id === "add-direct-loaded-72h" ? <small>Hypothetical fixture passage</small> : null}</div>
              </li>
            );
          })}
        </ol>
        <section className={styles.verdictTransition} aria-live="polite" aria-atomic="true">
          <span>Loaded-duration state</span>
          {appliedChangeIds.length === 0 ? (
            <StateBadge state={after} />
          ) : (
            <div><StateBadge state={before} /><GitCompareArrows aria-hidden="true" size={18} /><StateBadge state={after} /></div>
          )}
          <strong>{appliedChangeIds.length === 1
            ? "Deleting negative evidence did not create positive evidence."
            : appliedChangeIds.length === 2
              ? "Direct loaded evidence resolves duration—not the replacement decision."
              : "The base packet contains a contradiction and no direct loaded witness."}</strong>
          <p>{build.diff.summary}</p>
        </section>
        <section className={styles.impactCard} aria-label="Downstream impact">
          <span>Incremental rebuild</span>
          <dl>
            <div><dt>Impacted</dt><dd>{build.impactedNodeIds.length}</dd></div>
            <div><dt>Recomputed</dt><dd>{build.recomputedNodeIds.length}</dd></div>
            <div><dt>Decision</dt><dd>{build.decision.status}</dd></div>
          </dl>
          {experiment?.state === "obsolete" ? <p><Sparkles aria-hidden="true" size={14} /> Loaded-duration experiment is now obsolete.</p> : null}
          <ul>{build.errors.filter((error) => error.severity === "error").slice(0, 2).map((error) => <li key={error.id}>{error.message}</li>)}</ul>
        </section>
      </div>
      <div className={styles.modeActions}>
        {nextChange ? (
          <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => onApply(nextChange.id)}>
            {nextChange.label} <ArrowRight aria-hidden="true" size={16} />
          </button>
        ) : (
          <button className={styles.primaryButton} type="button" onClick={onReview}>
            Open Research PR <ArrowRight aria-hidden="true" size={16} />
          </button>
        )}
      </div>
    </section>
  );
}
