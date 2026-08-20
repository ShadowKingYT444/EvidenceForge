import { ArrowRight, Check, Download, FileDiff, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { EpistemicBuild, ReviewResponse } from "./contracts";
import { StateBadge, shortHash } from "./primitives";
import styles from "./workspace.module.css";

export function ReviewMode({
  build,
  review,
  busy,
  onAuthorize,
  onDownload,
}: {
  build: EpistemicBuild;
  review: ReviewResponse | null;
  busy: boolean;
  onAuthorize: (actor: string, rationale: string) => void;
  onDownload: () => void;
}) {
  const [actor, setActor] = useState("Demo research reviewer");
  const [rationale, setRationale] = useState("Authorize this evidence-branch update while preserving all unresolved replacement blockers.");
  const changedNodes = build.diff.changedNodes;
  const blockers = build.decision.blockerNodeIds.map((id) => build.graph.nodes.find((node) => node.id === id)).filter(Boolean);

  return (
    <section className={styles.modePanel} aria-labelledby="review-mode-title">
      <header className={styles.modeHeading}>
        <div><span className={styles.eyebrow}>Research PR</span><h1 id="review-mode-title">Review what changed before it enters the lineage.</h1></div>
        <StateBadge state={build.pullRequest.status} label={build.pullRequest.status} />
      </header>
      {review ? (
        <section className={styles.receipt} data-testid="research-pr-receipt">
          <header><ShieldCheck aria-hidden="true" size={22} /><div><span>Evidence update authorized</span><h2>Merge receipt</h2></div></header>
          <div className={styles.receiptGrid}>
            <dl>
              <div><dt>Declared actor</dt><dd>{review.receipt.declaredActor}</dd></div>
              <div><dt>Result</dt><dd>{review.evidenceUpdateStatus.replaceAll("_", " ")}</dd></div>
              <div><dt>Build</dt><dd><code>{review.receipt.buildId}</code></dd></div>
              <div><dt>Receipt hash</dt><dd><code>{shortHash(review.receipt.receiptHash)}</code></dd></div>
              <div><dt>Packet hash</dt><dd><code>{shortHash(review.build.fixtureHash)}</code></dd></div>
              <div><dt>Scientific decision</dt><dd>Not approved</dd></div>
            </dl>
            <div className={styles.authorizationText}><strong>Exact human authorization</strong><p>{review.receipt.rationale}</p><small>{review.receipt.decision.blockerNodeIds.length} unresolved blockers preserved</small></div>
          </div>
          <button className={styles.primaryButton} type="button" onClick={onDownload}><Download aria-hidden="true" size={16} /> Download Research PR receipt</button>
        </section>
      ) : (
        <div className={styles.reviewLayout}>
          <section className={styles.diffPanel} aria-labelledby="semantic-diff-title">
            <header><FileDiff aria-hidden="true" size={17} /><h2 id="semantic-diff-title">Semantic diff</h2><span>{build.diff.impactedNodeIds.length} affected</span></header>
            <p>{build.diff.summary}</p>
            <ol>
              {changedNodes.map((change) => (
                <li key={change.nodeId}><code>{change.nodeId}</code><div><StateBadge state={change.before ?? "missing"} /><ArrowRight aria-hidden="true" size={14} /><StateBadge state={change.after ?? "missing"} /></div><p>{change.reason}</p></li>
              ))}
              {build.diff.addedNodeIds.map((id) => <li key={id}><code>{id}</code><strong>Added on branch</strong></li>)}
            </ol>
          </section>
          <section className={styles.checkPanel} aria-labelledby="compiler-tests-title">
            <header><Check aria-hidden="true" size={17} /><h2 id="compiler-tests-title">Compiler tests</h2></header>
            <ul>
              <li data-state="passed"><Check aria-hidden="true" size={14} /> Exact passage IDs and hashes valid</li>
              <li data-state="passed"><Check aria-hidden="true" size={14} /> Duration scope directly matched</li>
              <li data-state="passed"><Check aria-hidden="true" size={14} /> Canonical packet unchanged</li>
              <li data-state="warning"><ShieldCheck aria-hidden="true" size={14} /> Final decision remains blocked</li>
            </ul>
            <h3>Unresolved blockers</h3>
            {blockers.map((node) => <article key={node!.id}><strong>{node!.label}</strong><p>{node!.detail}</p></article>)}
          </section>
          <form className={styles.authorizationPanel} onSubmit={(event) => { event.preventDefault(); onAuthorize(actor.trim(), rationale.trim()); }}>
            <span>Exact human checkpoint</span>
            <h2>Authorize evidence update</h2>
            <p>This authorizes the branch diff and build lineage. It does not approve the battery replacement decision.</p>
            <label>Declared actor<input value={actor} maxLength={200} required onChange={(event) => setActor(event.target.value)} /></label>
            <label>Authorization rationale<textarea value={rationale} maxLength={4000} required rows={4} onChange={(event) => setRationale(event.target.value)} /></label>
            <button className={styles.primaryButton} type="submit" disabled={busy || !actor.trim() || !rationale.trim()}>Authorize evidence update <ArrowRight aria-hidden="true" size={16} /></button>
          </form>
        </div>
      )}
    </section>
  );
}
