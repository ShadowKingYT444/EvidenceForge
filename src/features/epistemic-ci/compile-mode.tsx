import { ArrowRight, Braces, CircleAlert, GitCommitHorizontal } from "lucide-react";

import type { EpistemicBuild } from "./contracts";
import { StateBadge, shortHash } from "./primitives";
import styles from "./workspace.module.css";

export function CompileMode({
  build,
  compiled,
  busy,
  onCompile,
  onContinue,
}: {
  build: EpistemicBuild;
  compiled: boolean;
  busy: boolean;
  onCompile: () => void;
  onContinue: () => void;
}) {
  const activeErrors = build.errors.filter((error) => error.severity === "error").slice(0, 3);
  const durationWitness = build.witnesses.find((witness) => witness.targetNodeId === "claim:loaded-duration");
  return (
    <section className={styles.modePanel} aria-labelledby="compile-mode-title">
      <div className={styles.heroDecision}>
        <div>
          <span className={styles.eyebrow}>Target decision</span>
          <h1 id="compile-mode-title">Can a biodegradable battery replace the coin cell?</h1>
          <p>Loaded 72-hour humidity sensor · bounded fixture decision</p>
        </div>
        <div className={styles.decisionStatus}>
          <StateBadge state={build.decision.status} label={compiled ? build.decision.label : "Ready to compile"} />
          <code>{shortHash(build.graphHash)}</code>
        </div>
      </div>

      {!compiled ? (
        <div className={styles.compilePrompt}>
          <Braces aria-hidden="true" size={22} />
          <div>
            <strong>Compile the persuasive conclusion against its dependencies</strong>
            <p>EvidenceForge will check exact passages, scope compatibility, support witnesses, and decision blockers.</p>
          </div>
          <button className={styles.primaryButton} type="button" disabled={busy} onClick={onCompile}>
            Compile conclusion <ArrowRight aria-hidden="true" size={16} />
          </button>
        </div>
      ) : (
        <div className={styles.buildResults}>
          <section className={styles.failureList} aria-labelledby="compiler-errors-title">
            <header>
              <div><CircleAlert aria-hidden="true" size={17} /><h2 id="compiler-errors-title">Typed build failures</h2></div>
              <span>{activeErrors.length} blocking</span>
            </header>
            {activeErrors.map((error) => (
              <article key={error.id} data-severity={error.severity}>
                <code>{error.code}</code>
                <strong>{error.message}</strong>
                <p>{error.nodeId.replaceAll(":", " · ")}</p>
              </article>
            ))}
          </section>
          <section className={styles.witnessCard} aria-label="Minimal support witness">
            <GitCommitHorizontal aria-hidden="true" size={18} />
            <span>Minimal loaded-duration witness</span>
            <strong>{durationWitness ? `${durationWitness.nodeIds.length} source node` : "None"}</strong>
            <p>{durationWitness?.explanation ?? "Suggestive evidence does not satisfy the integrated-load scope."}</p>
          </section>
          <button className={styles.primaryButton} type="button" onClick={onContinue}>
            Test evidence changes <ArrowRight aria-hidden="true" size={16} />
          </button>
        </div>
      )}
    </section>
  );
}
