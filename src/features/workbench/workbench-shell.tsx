import Link from "next/link";

import { ConclusionsGapInspector } from "./conclusions-gap-inspector";
import type { ConclusionsGapModel } from "./conclusions-gap-state";
import { ExperimentProtocolInspector } from "./experiment-protocol-inspector";
import type { ExperimentProtocolModel } from "./experiment-protocol-state";
import { ObjectionDispositionPanel } from "./objection-disposition-panel";
import type { ObjectionDispositionModel } from "./objection-disposition-state";
import { EvidenceMatrix } from "./evidence-matrix";
import type { EvidenceMatrixModel } from "./evidence-matrix-state";
import { ExecutionAuditRail } from "./execution-audit-rail";
import {
  FinalDecisionPanel,
  type FinalDecisionPanelModel,
} from "./final-decision-panel";
import { PacketReview } from "./packet-review";
import type { PacketReviewModel } from "./packet-review-state";
import type { WorkbenchModel } from "./workbench-state";
import styles from "./workbench-shell.module.css";

type WorkbenchShellProps = {
  model: WorkbenchModel | null;
  packetReview: PacketReviewModel;
  evidenceMatrix: EvidenceMatrixModel | null;
  conclusionsGap: ConclusionsGapModel | null;
  experimentProtocol: ExperimentProtocolModel | null;
  objectionDisposition: ObjectionDispositionModel | null;
  finalDecision: FinalDecisionPanelModel;
  initialEvidenceId?: string | null;
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

export function WorkbenchShell({
  model,
  packetReview,
  evidenceMatrix,
  conclusionsGap,
  experimentProtocol,
  objectionDisposition,
  finalDecision,
  initialEvidenceId = null,
}: WorkbenchShellProps) {
  if (!model) {
    return (
      <main className={styles.page}>
        <header className={styles.masthead}>
          <div className={styles.mastheadInner}>
            <div className={styles.brandBlock}>
              <Link className={styles.brand} href="/intake">
                EvidenceForge
              </Link>
              <span>Research run workbench</span>
            </div>
            <div className={styles.mastheadMeta}>
              <span className={styles.runReference}>Run unavailable · validation failed</span>
              <span
                className={styles.modeBadge}
                data-mode="unverified"
                aria-label="Evidence mode: Unverified. Packet validation failed closed."
              >
                <span aria-hidden="true">◆</span>
                Unverified
              </span>
            </div>
          </div>
        </header>
        <div className={styles.workspace}>
          <section className={styles.runHeader} aria-labelledby="workbench-title">
            <div>
              <p className={styles.eyebrow}>Packet boundary · no projection</p>
              <h1 id="workbench-title">Packet validation failed closed</h1>
              <p className={styles.application}>
                Source content and downstream workbench projections remain unavailable.
              </p>
            </div>
            <div
              className={styles.statePanel}
              data-tone="danger"
              role="alert"
            >
              <span className={styles.statePhase}>Packet review</span>
              <strong>Validation error</strong>
              <span>Reload a complete, untampered canonical packet.</span>
              <small>No decision action is available.</small>
            </div>
          </section>
          <PacketReview
            key={`${packetReview.scenario}-${packetReview.decisionSessionId ?? "none"}`}
            model={packetReview}
          />
        </div>
      </main>
    );
  }

  const finalDecisionActionable =
    finalDecision.kind === "process_local" &&
    finalDecision.run.status === "awaiting_final_approval" &&
    model.finalDecision.state === "awaiting_final_approval";

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <div className={styles.brandBlock}>
            <Link className={styles.brand} href="/intake">
              EvidenceForge
            </Link>
            <span>Research run workbench</span>
          </div>
          <div className={styles.mastheadMeta}>
            <span className={styles.runReference}>
              Run {model.run.id} · contract {model.run.schemaVersion}
            </span>
            <span
              className={styles.modeBadge}
              data-mode={model.mode.key}
              aria-label={`Evidence mode: ${model.mode.label}. ${model.mode.description}.`}
            >
              <span aria-hidden="true">{model.mode.key === "live" ? "●" : "◆"}</span>
              {model.mode.label}
            </span>
          </div>
        </div>
      </header>

      <div className={styles.workspace}>
        {model.disclosure ? (
          <aside className={styles.disclosure} aria-label="State preview disclosure">
            <strong>State preview</strong>
            <span>{model.disclosure}</span>
          </aside>
        ) : null}

        <section className={styles.runHeader} aria-labelledby="workbench-title">
          <div>
            <p className={styles.eyebrow}>Resolved research scope · Run record</p>
            <h1 id="workbench-title">{model.scope.question}</h1>
            <p className={styles.application}>{model.scope.application}</p>
          </div>
          <div
            className={styles.statePanel}
            data-tone={model.state.tone}
            role="status"
            aria-live="polite"
          >
            <span className={styles.statePhase}>{model.state.phase}</span>
            <strong>{model.state.label}</strong>
            <span>{model.state.description}</span>
            <small>{model.state.nextStep}</small>
          </div>
        </section>

        <dl className={styles.scopeLedger} aria-label="Resolved scope">
          <div>
            <dt>Application</dt>
            <dd>{model.scope.application}</dd>
          </div>
          <div>
            <dt>Population / setting</dt>
            <dd>{model.scope.population || "Not specified"}</dd>
          </div>
          <div>
            <dt>Time horizon</dt>
            <dd>{model.scope.timeHorizon || "Not specified"}</dd>
          </div>
          <div>
            <dt>Evidence record</dt>
            <dd>
              {model.mode.description}; updated{" "}
              <time dateTime={model.run.updatedAt}>
                {new Date(model.run.updatedAt).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "UTC",
                })}{" "}
                UTC
              </time>
            </dd>
          </div>
        </dl>

        <nav className={styles.runContents} aria-labelledby="run-contents-title">
          <span className={styles.runContentsTitle} id="run-contents-title">
            Run contents
          </span>
          <ol>
            <li><a href="#packet"><span>01</span>Packet</a></li>
            <li><a href="#claims"><span>02</span>Claims</a></li>
            {evidenceMatrix ? <li><a href="#evidence"><span>03</span>Evidence</a></li> : null}
            {conclusionsGap ? <li><a href="#synthesis-gap"><span>04</span>Synthesis &amp; gap</a></li> : null}
            {experimentProtocol ? <li><a href="#experiment"><span>05</span>Experiment</a></li> : null}
            {objectionDisposition ? <li><a href="#review-revision"><span>06</span>Review &amp; revision</a></li> : null}
            <li><a href="#audit"><span>07</span>Audit</a></li>
            <li><a href="#final-decision"><span>08</span>Final decision</a></li>
          </ol>
        </nav>

        {model.attention ? (
          <section
            className={styles.attention}
            aria-labelledby="attention-title"
            role={model.state.tone === "danger" ? "alert" : undefined}
          >
            <div>
              <span className={styles.sectionIndex}>Preserved attempt</span>
              <h2 id="attention-title">{humanize(model.attention.kind)}</h2>
            </div>
            <p>{model.attention.message}</p>
            <span className={styles.retryLabel}>
              {model.attention.retryable
                ? "Retry permitted · prior attempt remains"
                : "Retry not permitted"}
            </span>
          </section>
        ) : null}

        {model.recovery ? (
          <section
            className={styles.attention}
            aria-label="Recovery contract"
            data-evidence-mode={model.recovery.evidenceMode}
          >
            <div>
              <span className={styles.sectionIndex}>Typed recovery</span>
              <h2>Recovery contract</h2>
            </div>
            <dl className={styles.scopeLedger}>
              <div>
                <dt>Typed condition</dt>
                <dd>{humanize(model.recovery.kind)}</dd>
              </div>
              <div>
                <dt>Evidence mode</dt>
                <dd>{model.recovery.evidenceMode}</dd>
              </div>
              <div>
                <dt>Contract projection</dt>
                <dd>{model.recovery.contractSource}</dd>
              </div>
              <div>
                <dt>History</dt>
                <dd>
                  {model.recovery.priorAttemptRetained
                    ? "Prior attempt retained"
                    : "History unavailable"}
                </dd>
              </div>
            </dl>
            <p>{model.recovery.allowedAction}</p>
          </section>
        ) : null}

        <PacketReview
          key={`${packetReview.scenario}-${packetReview.decisionSessionId ?? "none"}`}
          model={packetReview}
        />

        <div className={styles.primaryGrid}>
          <aside
            className={styles.claimRail}
            id="claims"
            aria-labelledby="claims-title"
          >
            <header className={styles.regionHeader}>
              <div>
                <span className={styles.sectionIndex}>02 · Claims</span>
                <h2 id="claims-title">Claim ledger</h2>
              </div>
              <span className={styles.count}>{model.claims.length}</span>
            </header>
            <ol className={styles.claimList}>
              {model.claims.map((claim, index) => (
                <li className={styles.claimItem} key={claim.id}>
                  <div className={styles.claimMeta}>
                    <span>Claim {String(index + 1).padStart(2, "0")}</span>
                    <span>{humanize(claim.strength)}</span>
                  </div>
                  <strong>{claim.statement}</strong>
                  <span className={styles.claimDefinition}>
                    {claim.operationalDefinition}
                  </span>
                  <div className={styles.claimFoot}>
                    <span>{claim.evidenceCount} evidence cards</span>
                    <span>{humanize(claim.disposition)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </aside>

          <div className={styles.centerColumn}>
            {evidenceMatrix ? (
              <EvidenceMatrix
                key={initialEvidenceId ?? "no-initial-evidence"}
                model={evidenceMatrix}
                initialEvidenceId={initialEvidenceId}
              />
            ) : null}
          </div>

          <aside className={styles.rightRail} aria-label="Experiment and audit">
            {conclusionsGap ? (
              <ConclusionsGapInspector model={conclusionsGap} />
            ) : null}
            {experimentProtocol ? (
              <ExperimentProtocolInspector
                model={experimentProtocol}
                reviewStats={model.experiment}
              />
            ) : null}
            {objectionDisposition ? (
              <ObjectionDispositionPanel model={objectionDisposition} />
            ) : null}

            <ExecutionAuditRail audit={model.audit} />
          </aside>
        </div>
      </div>

      <section
        className={styles.finalBar}
        id="final-decision"
        data-decision-state={model.finalDecision.state}
        data-decision-actionable={finalDecisionActionable}
        aria-labelledby="final-decision-title"
      >
        <FinalDecisionPanel
          key={`${finalDecision.kind}-${finalDecision.run.id}-${finalDecision.kind === "process_local" ? finalDecision.revision : "recorded"}`}
          model={finalDecision}
          presentation={model.finalDecision}
        />
      </section>
    </main>
  );
}
