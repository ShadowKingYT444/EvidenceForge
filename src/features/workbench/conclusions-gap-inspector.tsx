import type { ConclusionsGapModel } from "./conclusions-gap-state";
import styles from "./conclusions-gap-inspector.module.css";

type ConclusionsGapInspectorProps = {
  model: ConclusionsGapModel;
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function evidenceHref(id: string) {
  return `/workbench?evidence=${encodeURIComponent(id)}#evidence-verification-drawer`;
}

export function ConclusionsGapInspector({
  model,
}: ConclusionsGapInspectorProps) {
  return (
    <section
      className={styles.surface}
      id="synthesis-gap"
      aria-label="Conclusions and selected research gap"
    >
      <header className={styles.header}>
        <div>
          <span className={styles.index}>04 · Synthesis</span>
          <h2>Conclusions & gaps</h2>
        </div>
        {model.state === "ready" ? (
          <span className={styles.count}>{model.conclusions.length}</span>
        ) : null}
      </header>

      {model.state === "error" ? (
        <div className={styles.error} role="alert">
          <strong>Conclusion record unavailable</strong>
          <span>{model.error?.message}</span>
          <code>{model.error?.code}</code>
        </div>
      ) : (
        <>
          <p className={styles.lead}>
            Strength is categorical. Each conclusion and gap links to the
            evidence-card record that supports the bounded assessment.
          </p>
          <ol className={styles.conclusionList}>
            {model.conclusions.map((conclusion, index) => (
              <li className={styles.conclusion} key={conclusion.claimId}>
                <header className={styles.cardHeader}>
                  <span>Claim {String(index + 1).padStart(2, "0")}</span>
                  <span
                    className={styles.strength}
                    data-strength={conclusion.strength}
                  >
                    {conclusion.strengthLabel}
                  </span>
                </header>
                <h3>{conclusion.claimStatement}</h3>
                {conclusion.isAbstention ? (
                  <p className={styles.abstention} role="status">
                    {conclusion.abstentionLabel}
                  </p>
                ) : null}
                <p className={styles.conclusionText}>
                  {conclusion.conclusion}
                </p>

                <div className={styles.traceGrid}>
                  <EvidenceLinks
                    title="Evidence for"
                    evidence={conclusion.supportingEvidence}
                  />
                  <EvidenceLinks
                    title="Evidence against"
                    evidence={conclusion.contradictingEvidence}
                  />
                </div>

                <dl className={styles.analysisGrid}>
                  <div>
                    <dt>Disagreement</dt>
                    <dd>
                      {conclusion.disagreementSummary ??
                        "No disagreement summary recorded."}
                    </dd>
                  </div>
                  <div>
                    <dt>Limitations</dt>
                    <dd>
                      <TextList
                        items={conclusion.limitations}
                        empty="No limitations recorded."
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>What would change this conclusion</dt>
                    <dd>
                      <TextList
                        items={conclusion.changeEvidence}
                        empty="No change condition recorded."
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Overclaiming boundary</dt>
                    <dd>
                      <TextList
                        items={conclusion.overclaimingWarnings}
                        empty="No overclaiming warning recorded."
                      />
                    </dd>
                  </div>
                </dl>
                <p className={styles.reviewState}>
                  Human review · {humanize(conclusion.humanReviewStatus)}
                </p>
              </li>
            ))}
          </ol>

          <section className={styles.gaps} aria-labelledby="gap-candidates-title">
            <header className={styles.subheader}>
              <div>
                <span>Ranked research gaps</span>
                <h3 id="gap-candidates-title">Gap candidates</h3>
              </div>
              <span>{model.gaps.length}</span>
            </header>
            {model.gaps.length === 0 ? (
              <p className={styles.empty}>No research-gap candidate is recorded.</p>
            ) : (
              <ol className={styles.gapList}>
                {model.gaps.map((gap) => (
                  <li className={styles.gap} key={gap.id}>
                    <header>
                      <span>
                        Gap {String(gap.rank).padStart(2, "0")} · {gap.selection}
                      </span>
                      <strong>{humanize(gap.type)}</strong>
                    </header>
                    <p>
                      <strong>Impact</strong>
                      {gap.impactRationale}
                    </p>
                    <p>
                      <strong>Tractability</strong>
                      {gap.tractabilityRationale}
                    </p>
                    <div>
                      <strong>Affected claims</strong>
                      <ul>
                        {gap.affectedClaims.map((claim) => (
                          <li key={claim.id}>{claim.statement}</li>
                        ))}
                      </ul>
                    </div>
                    <EvidenceLinks title="Gap evidence" evidence={gap.evidence} />
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section
            className={styles.selectionRecord}
            aria-labelledby="selection-record-title"
          >
            <span>Canonical run selection</span>
            <h3 id="selection-record-title">Human selection record</h3>
            {model.selectionDecision.state === "recorded" ? (
              <>
                <p className={styles.selectionState}>
                  Gap {String(
                    model.gaps.find(
                      ({ id }) => id === model.selectionDecision.selectedGapId,
                    )?.rank ?? 0,
                  ).padStart(2, "0")} · {model.selectionDecision.decision}
                </p>
                <dl>
                  <div>
                    <dt>Why this gap matters</dt>
                    <dd>{model.selectionDecision.impactRationale}</dd>
                  </div>
                  <div>
                    <dt>Why it is tractable</dt>
                    <dd>{model.selectionDecision.tractabilityRationale}</dd>
                  </div>
                </dl>
                <p className={styles.contractNote}>
                  The canonical run records the selected gap and its rationales.
                  Contract 0.1 does not provide a separate selection actor or
                  timestamp, so none is inferred here.
                </p>
              </>
            ) : (
              <p className={styles.empty}>
                No human gap selection is recorded; experiment planning remains
                ungrounded.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function EvidenceLinks({
  title,
  evidence,
}: {
  title: string;
  evidence: Array<{
    id: string;
    relationship: string;
  }>;
}) {
  return (
    <div className={styles.evidenceLinks}>
      <strong>{title}</strong>
      {evidence.length > 0 ? (
        <ul>
          {evidence.map((item) => (
            <li key={item.id}>
              <a
                href={evidenceHref(item.id)}
                aria-label={`Open evidence ${item.id}, ${humanize(item.relationship)}`}
              >
                <code>{item.id}</code>
                <span>{humanize(item.relationship)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <span>None recorded</span>
      )}
    </div>
  );
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  return items.length > 0 ? (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <span>{empty}</span>
  );
}
