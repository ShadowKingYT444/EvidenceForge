"use client";

import {
  Activity,
  Beaker,
  BookOpenCheck,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Command,
  FlaskConical,
  Gavel,
  ListFilter,
  Microscope,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";

import { useFocusBoundary } from "../use-focus-boundary";
import { ClaimEvidenceCanvas } from "./claim-evidence-canvas";
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
  allowSimulatedStates?: boolean;
  initialStage?: WorkbenchStageId;
};

const stages = [
  { id: "scope", label: "Scope", icon: ListFilter },
  { id: "packet", label: "Packet", icon: Boxes },
  { id: "evidence", label: "Evidence", icon: Microscope },
  { id: "findings", label: "Findings", icon: BookOpenCheck },
  { id: "experiment", label: "Experiment", icon: FlaskConical },
  { id: "review", label: "Review", icon: ShieldCheck },
  { id: "audit", label: "Audit", icon: Activity },
  { id: "decision", label: "Decision", icon: Gavel },
] as const;

export type WorkbenchStageId = (typeof stages)[number]["id"];
type StageId = WorkbenchStageId;
type EvidenceView = "canvas" | "matrix";

const stageAliases: Record<string, StageId> = {
  scope: "scope",
  claims: "scope",
  packet: "packet",
  evidence: "evidence",
  findings: "findings",
  "synthesis-gap": "findings",
  experiment: "experiment",
  review: "review",
  "review-revision": "review",
  audit: "audit",
  decision: "decision",
  "final-decision": "decision",
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function RunInspector({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <aside className={styles.contextInspector} aria-label={`${title} inspector`}>
      <header>
        <span>Context inspector</span>
        <h2>{title}</h2>
      </header>
      <div>{children}</div>
    </aside>
  );
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
  allowSimulatedStates = true,
  initialStage = "evidence",
}: WorkbenchShellProps) {
  const [activeStage, setActiveStage] = useState<StageId>(initialStage);
  const [evidenceView, setEvidenceView] = useState<EvidenceView>("canvas");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [demoStatesOpen, setDemoStatesOpen] = useState(false);
  const [commandEvidenceId, setCommandEvidenceId] = useState<string | null>(null);
  const [evidenceFilter, setEvidenceFilter] = useState<"all" | "contradicts">("all");
  const [glossary, setGlossary] = useState<string | null>(null);
  const paletteInput = useRef<HTMLInputElement | null>(null);
  const paletteDialog = useRef<HTMLElement | null>(null);
  const paletteReturnTarget = useRef<HTMLElement | null>(null);
  const viewMenu = useRef<HTMLDivElement | null>(null);
  const viewButton = useRef<HTMLButtonElement | null>(null);
  const firstViewItem = useRef<HTMLButtonElement | null>(null);
  const lastViewItem = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    function readHash() {
      const next = stageAliases[window.location.hash.slice(1)];
      if (next) {
        setActiveStage(next);
        requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
      }
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    window.addEventListener("popstate", readHash);
    return () => {
      window.removeEventListener("hashchange", readHash);
      window.removeEventListener("popstate", readHash);
    };
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!paletteOpen) {
          paletteReturnTarget.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : document.getElementById("open-workbench-command-palette");
          setPaletteOpen(true);
        }
      }
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        event.preventDefault();
        if (!paletteOpen) {
          paletteReturnTarget.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : document.getElementById("open-workbench-command-palette");
          setPaletteOpen(true);
        }
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [paletteOpen]);

  useFocusBoundary({
    active: paletteOpen,
    boundaryRef: paletteDialog,
    initialFocusRef: paletteInput,
    onDismiss: closePalette,
  });

  useEffect(() => {
    if (!viewMenuOpen) return;
    const focusFrame = requestAnimationFrame(() => firstViewItem.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [viewMenuOpen]);

  const commands = [
      ...stages.map((stage) => ({
        id: `stage-${stage.id}`,
        label: `Go to ${stage.label}`,
        hint: `Open the ${stage.label.toLowerCase()} stage`,
        run: () => goToStage(stage.id),
      })),
      {
        id: "view-canvas",
        label: "Show evidence canvas",
        hint: "Switch to the judge-friendly claim view",
        run: () => { setEvidenceView("canvas"); goToStage("evidence"); },
      },
      {
        id: "view-matrix",
        label: "Show evidence matrix",
        hint: "Open the accessible claim × source map",
        run: () => { setEvidenceView("matrix"); goToStage("evidence"); },
      },
      {
        id: "explain-entailment",
        label: "Explain model assessment",
        hint: "Inspect why model entailment is separate from mechanical and human review",
        run: () => {
          setGlossary("Model assessment is a recorded entailment judgment. It never replaces the mechanical passage check or the human review state.");
          goToStage("evidence");
        },
      },
      {
        id: "select-contradiction",
        label: "Select contradictory evidence",
        hint: "Open the first recorded contradiction in the evidence inspector",
        run: () => {
          const evidenceId = evidenceMatrix?.rows
            .flatMap(({ cells }) => cells)
            .find(({ relationship, evidenceIds }) => relationship === "contradicts" && evidenceIds.length > 0)
            ?.evidenceIds[0] ?? null;
          setCommandEvidenceId(evidenceId);
          setEvidenceView("canvas");
          setEvidenceFilter("all");
          goToStage("evidence");
        },
      },
      {
        id: "filter-contradictions",
        label: "Filter evidence to contradictions",
        hint: "Show only claim relationships that contradict the approved claim",
        run: () => {
          setEvidenceFilter("contradicts");
          setEvidenceView("canvas");
          goToStage("evidence");
        },
      },
      {
        id: "open-demo-states",
        label: "Open Demo States",
        hint: "Choose an honest simulated failure, packet, protocol, or decision state",
        run: () => {
          setDemoStatesOpen(true);
          dismissPalette();
        },
      },
    ];
  const visibleCommands = commands.filter((command) =>
    `${command.label} ${command.hint}`.toLowerCase().includes(commandQuery.toLowerCase()),
  );

  function goToStage(stage: StageId) {
    setActiveStage(stage);
    const nextUrl = `${window.location.pathname}${window.location.search}#${stage}`;
    window.history.pushState(null, "", nextUrl);
    dismissPalette();
  }

  function dismissPalette() {
    setPaletteOpen(false);
    setCommandQuery("");
  }

  function closePalette() {
    const returnTarget = paletteReturnTarget.current;
    dismissPalette();
    requestAnimationFrame(() => returnTarget?.focus());
  }

  function closeViewMenu(restoreFocus = true) {
    setViewMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => viewButton.current?.focus());
  }

  function moveFocusPastViewMenu(backward: boolean) {
    const trigger = viewButton.current;
    const menu = viewMenu.current;
    if (!trigger) return closeViewMenu(false);

    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.closest("[inert]") &&
        !menu?.contains(element),
    );
    const triggerIndex = focusable.indexOf(trigger);
    const target = focusable[triggerIndex + (backward ? -1 : 1)] ?? trigger;
    closeViewMenu(false);
    requestAnimationFrame(() => target.focus());
  }

  function handleViewMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [firstViewItem.current, lastViewItem.current].filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    const focusedIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      moveFocusPastViewMenu(event.shiftKey);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeViewMenu();
      return;
    }
    if (items.length === 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (focusedIndex + 1 + items.length) % items.length;
    if (event.key === "ArrowUp") nextIndex = (focusedIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  }

  if (!model) {
    return (
      <main className={styles.page}>
        <header className={styles.workstationHeader}>
          <Link className={styles.productBrand} href="/">EvidenceForge</Link>
          <span className={styles.modeBadge} data-mode="unverified">Unverified · packet validation failed</span>
        </header>
        <section className={styles.closedState} role="alert">
          <ShieldCheck aria-hidden="true" size={22} />
          <span>Packet boundary · fail closed</span>
          <h1>Packet validation failed closed</h1>
          <p>Source content and downstream projections remain unavailable.</p>
          <PacketReview model={packetReview} />
        </section>
      </main>
    );
  }

  const finalDecisionActionable =
    finalDecision.kind === "process_local" &&
    finalDecision.run.status === "awaiting_final_approval" &&
    model.finalDecision.state === "awaiting_final_approval";

  return (
    <main className={styles.page} data-workstation-stage={activeStage}>
      <header className={styles.workstationHeader}>
        <div className={styles.brandCluster}>
          <Link className={styles.productBrand} href="/">EvidenceForge</Link>
          <span className={styles.divider} aria-hidden="true" />
          <div>
            <span className={styles.runLabel}>Recorded research run</span>
            <strong>Run {model.run.id} · contract {model.run.schemaVersion}</strong>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span
            className={styles.modeBadge}
            data-mode={model.mode.key}
            aria-label={`Evidence mode: ${model.mode.label}. ${model.mode.description}.`}
          >
            <CircleDot aria-hidden="true" size={12} />
            {model.mode.label}
          </span>
          <DemoStates
            allowSimulatedStates={allowSimulatedStates}
            open={demoStatesOpen}
            onOpenChange={setDemoStatesOpen}
          />
          <button
            className={styles.commandTrigger}
            type="button"
            id="open-workbench-command-palette"
            onClick={(event) => {
              paletteReturnTarget.current = event.currentTarget;
              setPaletteOpen(true);
            }}
            aria-label="Open command palette"
          >
            <Search aria-hidden="true" size={14} />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>
      </header>

      <div className={styles.workstation}>
        <aside className={styles.stageRail}>
          <div className={styles.runSummary}>
            <span>{model.state.phase}</span>
            <strong>Current: {model.state.label}</strong>
            <small>{model.state.nextStep}</small>
          </div>
          <nav aria-label="Research workflow stages">
            <ol>
              {stages.map((stage, index) => {
                const Icon = stage.icon;
                const active = stage.id === activeStage;
                return (
                  <li key={stage.id}>
                    <a
                      href={`#${stage.id}`}
                      aria-label={`${String(index + 1).padStart(2, "0")} ${stage.label}`}
                      aria-current={active ? "step" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        goToStage(stage.id);
                      }}
                    >
                      <span className={styles.stageIndex}>{String(index + 1).padStart(2, "0")}</span>
                      <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
                      <span>{stage.label}</span>
                      {index < 2 || stage.id === "evidence" ? (
                        <CheckCircle2 className={styles.completeIcon} aria-label="Complete" size={13} />
                      ) : stage.id === "decision" ? (
                        <CircleDot className={styles.attentionIcon} aria-label="Human checkpoint" size={13} />
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className={styles.traceChain} aria-label="Inspectable provenance chain">
            <span>Inspectable chain</span>
            <div><b>Q</b><i /><b>P</b><i /><b>E</b><i /><b>H</b></div>
            <small>Question → packet → evidence → human</small>
          </div>
        </aside>

        <section className={styles.workSurface} aria-label="Current research stage">
          {model.disclosure ? (
            <div className={styles.simulatedDisclosure} role="status">
              <Activity aria-hidden="true" size={14} />
              <strong>Simulated demo state</strong>
              <span>{model.disclosure}</span>
            </div>
          ) : null}
          {glossary ? (
            <aside className={styles.glossary} role="status" aria-label="Workbench glossary explanation">
              <BookOpenCheck aria-hidden="true" size={14} />
              <span>{glossary}</span>
              <button type="button" onClick={() => setGlossary(null)} aria-label="Close glossary explanation"><X aria-hidden="true" size={14} /></button>
            </aside>
          ) : null}

          <header className={styles.stageHeader}>
            <div>
              <span>{String(stages.findIndex(({ id }) => id === activeStage) + 1).padStart(2, "0")} · {stages.find(({ id }) => id === activeStage)?.label}</span>
              <h1>{stages.find(({ id }) => id === activeStage)?.label}</h1>
            </div>
            <details className={styles.runDetails}>
              <summary>Run details</summary>
              <p>{model.scope.question}</p>
            </details>
            <div className={styles.stageStatus} data-tone={model.state.tone}>
              <span>{model.state.phase}</span>
              <strong>{model.state.label}</strong>
              <small>{model.state.description}</small>
            </div>
          </header>

          <section data-stage-panel="scope" hidden={activeStage !== "scope"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              <section className={styles.scopeCanvas} id="claims" aria-labelledby="scope-canvas-title">
                <header className={styles.panelTitle}>
                  <div><span>01 · Human checkpoint</span><h2 id="scope-canvas-title">Resolved claim contract</h2></div>
                  <span className={styles.recordedBadge}>Recorded approval</span>
                </header>
                <dl className={styles.scopeLedger} aria-label="Resolved scope">
                  <div><dt>Application</dt><dd>{model.scope.application}</dd></div>
                  <div><dt>Population / setting</dt><dd>{model.scope.population || "Not specified"}</dd></div>
                  <div><dt>Time horizon</dt><dd>{model.scope.timeHorizon || "Not specified"}</dd></div>
                  <div><dt>Evidence record</dt><dd>{model.mode.description}</dd></div>
                </dl>
                <ol className={styles.claimList}>
                  {model.claims.map((claim, index) => (
                    <li className={styles.claimItem} key={claim.id}>
                      <div className={styles.claimMeta}><span>Claim {index + 1}</span><span>{humanize(claim.strength)}</span></div>
                      <strong>{claim.statement}</strong>
                      <span className={styles.claimDefinition}>{claim.operationalDefinition}</span>
                      <div className={styles.claimFoot}><span>{claim.evidenceCount} evidence cards</span><span>{humanize(claim.disposition)}</span></div>
                    </li>
                  ))}
                </ol>
              </section>
              <RunInspector title="Scope">
                <p>The approved question and claims form the boundary for every later record.</p>
                <dl><div><dt>Checkpoint</dt><dd>Human approved</dd></div><div><dt>Downstream state</dt><dd>Packet frozen</dd></div></dl>
              </RunInspector>
            </div>
          </section>

          <section data-stage-panel="packet" hidden={activeStage !== "packet"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              <PacketReview key={`${packetReview.scenario}-${packetReview.decisionSessionId ?? "none"}`} model={packetReview} />
              <RunInspector title="Packet boundary">
                <p>Source existence and metadata do not prove claim entailment.</p>
                <dl><div><dt>Approved sources</dt><dd>{packetReview.sources.length}</dd></div><div><dt>Packet state</dt><dd>{packetReview.stateLabel}</dd></div><div><dt>Mode</dt><dd>{packetReview.evidenceMode}</dd></div></dl>
              </RunInspector>
            </div>
          </section>

          <section data-stage-panel="evidence" hidden={activeStage !== "evidence"} className={styles.stagePanel}>
            <div className={styles.viewToolbar} role="group" aria-label="Evidence view">
              <div className={styles.viewMenu}>
                <button ref={viewButton} type="button" aria-label="View" aria-haspopup="menu" aria-expanded={viewMenuOpen} onClick={() => viewMenuOpen ? closeViewMenu() : setViewMenuOpen(true)}>View</button>
                {viewMenuOpen ? <div ref={viewMenu} role="menu" aria-label="Evidence view menu" onKeyDown={handleViewMenuKeyDown}>
                  <button ref={firstViewItem} type="button" role="menuitem" onClick={() => { setEvidenceView("canvas"); closeViewMenu(); }}>Ledger</button>
                  <button ref={lastViewItem} type="button" role="menuitem" onClick={() => { setEvidenceView("matrix"); closeViewMenu(); }}>Matrix</button>
                </div> : null}
              </div>
              <button type="button" aria-pressed={evidenceView === "canvas"} onClick={() => setEvidenceView("canvas")}><Microscope aria-hidden="true" size={14} />Canvas view</button>
              <button type="button" aria-pressed={evidenceView === "matrix"} onClick={() => setEvidenceView("matrix")}><Boxes aria-hidden="true" size={14} />Matrix view</button>
              <span>Canvas is the guided view · Matrix is the accessible expert map</span>
            </div>
            {evidenceMatrix ? evidenceView === "canvas" ? (
              <ClaimEvidenceCanvas
                key={`${commandEvidenceId ?? initialEvidenceId ?? "none"}-${evidenceFilter}-${activeStage}`}
                active={activeStage === "evidence"}
                model={evidenceMatrix}
                packetSources={packetReview.sources}
                initialEvidenceId={commandEvidenceId ?? initialEvidenceId}
                relationshipFilter={evidenceFilter}
                onClearFilter={() => setEvidenceFilter("all")}
              />
            ) : (
              <div className={styles.matrixStage}><EvidenceMatrix key={initialEvidenceId ?? "no-initial-evidence"} model={evidenceMatrix} initialEvidenceId={initialEvidenceId} /></div>
            ) : <p className={styles.unavailable}>Evidence projection is unavailable.</p>}
          </section>

          <section data-stage-panel="findings" hidden={activeStage !== "findings"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              {conclusionsGap ? <ConclusionsGapInspector model={conclusionsGap} /> : <p className={styles.unavailable}>Findings are unavailable.</p>}
              <RunInspector title="Findings and gap"><p>Categorical strength, disagreement, limitations, and the evidence that would change the conclusion remain explicit.</p><p>The selected gap is a proposal target, not proof of novelty.</p></RunInspector>
            </div>
          </section>

          <section data-stage-panel="experiment" hidden={activeStage !== "experiment"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              {experimentProtocol ? <ExperimentProtocolInspector model={experimentProtocol} reviewStats={model.experiment} /> : <p className={styles.unavailable}>Experiment proposal is unavailable.</p>}
              <RunInspector title="Experiment boundary"><p>This is an educational, reviewable proposal. It does not execute a real-world experiment.</p><p>Qualified review, stopping conditions, and limits remain part of the record.</p></RunInspector>
            </div>
          </section>

          <section data-stage-panel="review" hidden={activeStage !== "review"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              {objectionDisposition ? <ObjectionDispositionPanel model={objectionDisposition} /> : <p className={styles.unavailable}>Review records are unavailable.</p>}
              <RunInspector title="Adversarial review"><p>Objections are never silently resolved. Human decisions remain separate from model criticism.</p><p>Accepted revisions preserve their original values and residual risks.</p></RunInspector>
            </div>
          </section>

          <section data-stage-panel="audit" hidden={activeStage !== "audit"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              <div className={styles.auditCanvas}>
                {model.attention ? <section className={styles.attention} role={model.state.tone === "danger" ? "alert" : undefined}><div><span className={styles.sectionIndex}>Preserved attempt</span><h2>{humanize(model.attention.kind)}</h2></div><p>{model.attention.message}</p></section> : null}
                {model.recovery ? <section className={styles.recoveryBanner} aria-label="Recovery contract" data-evidence-mode={model.recovery.evidenceMode}><div><span className={styles.sectionIndex}>Typed recovery</span><h2>Recovery</h2><p>{model.recovery.allowedAction}</p></div><details className={styles.recoveryDetails}><summary>View recovery record</summary><dl className={styles.scopeLedger}><div><dt>Typed condition</dt><dd>{humanize(model.recovery.kind)}</dd></div><div><dt>Evidence mode</dt><dd>{model.recovery.evidenceMode}</dd></div><div><dt>Contract projection</dt><dd>{model.recovery.contractSource}</dd></div><div><dt>History</dt><dd>{model.recovery.priorAttemptRetained ? "Prior attempt retained" : "History unavailable"}</dd></div></dl></details></section> : null}
                <ExecutionAuditRail key={`audit-${activeStage}`} active={activeStage === "audit"} audit={model.audit} />
              </div>
              <RunInspector title="Execution history"><p>Failures and retries are grouped but never overwritten. Provider, model, prompt version, validation, timing, and evidence mode remain inspectable.</p></RunInspector>
            </div>
          </section>

          <section data-stage-panel="decision" hidden={activeStage !== "decision"} className={styles.stagePanel}>
            <div className={styles.stageColumns}>
              <section className={styles.finalBar} id="final-decision" data-decision-state={model.finalDecision.state} data-decision-actionable={finalDecisionActionable} aria-labelledby="final-decision-title">
                <FinalDecisionPanel key={`${finalDecision.kind}-${finalDecision.run.id}-${finalDecision.kind === "process_local" ? finalDecision.revision : "recorded"}`} model={finalDecision} presentation={model.finalDecision} />
              </section>
              <RunInspector title="Human decision"><p>The final record preserves boundaries and unresolved objections. Fixture approval is recorded evidence, not a replayed action.</p><p>Temporary review sessions are process-local and disappear on server restart.</p></RunInspector>
            </div>
          </section>
        </section>
      </div>

      {paletteOpen ? (
        <div className={styles.paletteBackdrop} onMouseDown={() => closePalette()}>
          <section ref={paletteDialog} className={styles.palette} role="dialog" aria-modal="true" aria-label="Workbench command palette" onMouseDown={(event) => event.stopPropagation()}>
            <header><Command aria-hidden="true" size={16} /><input ref={paletteInput} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search records or run a command" aria-label="Search records or run a command" /><button type="button" onClick={() => closePalette()} aria-label="Close command palette"><X aria-hidden="true" size={16} /></button></header>
            <div className={styles.commandResults}>
              {visibleCommands.map((command) => <button key={command.id} type="button" onClick={command.run}><span><strong>{command.label}</strong><small>{command.hint}</small></span><ChevronRight aria-hidden="true" size={14} /></button>)}
              {visibleCommands.length === 0 ? <p>No deterministic command matches this search.</p> : null}
            </div>
            <footer>No model calls · no changes are persisted from this surface</footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function DemoStates({
  allowSimulatedStates,
  open,
  onOpenChange,
}: {
  allowSimulatedStates: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details
      className={styles.demoStates}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary><Beaker aria-hidden="true" size={14} />Demo states</summary>
      <div>
        <strong>Simulated demo state</strong>
        {allowSimulatedStates ? (
          <>
            <span>Run states</span>
            <Link href="/workbench?scenario=timeout#audit">Provider timeout</Link>
            <Link href="/workbench?scenario=retry#audit">Failure + retry</Link>
            <span>Packet states</span>
            <Link href="/workbench?packet=denied#packet">Restricted display</Link>
            <span>Protocol</span>
            <Link href="/workbench?protocol=abstention#experiment">Typed abstention</Link>
            <span>Final decision</span>
            <Link href="/workbench?scenario=rejected#decision">Rejected fixture</Link>
          </>
        ) : <p>Synthetic overrides are disabled for a process-local run.</p>}
      </div>
    </details>
  );
}
