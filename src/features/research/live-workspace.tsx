"use client";

/* API payloads are validated on the server; this view defensively narrows JSON. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Download,
  FileText,
  Info,
  LoaderCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { LiveEpistemicPanel } from "./live-epistemic-panel";
import { WorkspaceStageNav, StatusBadge, TimelineRow } from "./primitives";
import { ResearchDrawer } from "./research-drawer";

type JsonRecord = Record<string, any>;
type WorkspaceState = {
  run: JsonRecord | null;
  revision: string;
  progress: JsonRecord | null;
  draft: JsonRecord | null;
  timeline: JsonRecord[];
  candidates: JsonRecord[];
  loading: boolean;
  error: string;
};
type WorkspaceDrawer = "context" | "add-source" | "activity" | "evidence-detail" | null;
type SourceMode = "search" | "paste" | "upload";

const empty: WorkspaceState = { run: null, revision: "", progress: null, draft: null, timeline: [], candidates: [], loading: true, error: "" };
const stages = ["Scope", "Sources", "Evidence", "Review", "Decision"];
const stageIds = ["scope", "sources", "evidence", "review", "decision"];
const modelStatuses = new Set(["draft", "decomposing", "extracting_evidence", "verifying_evidence", "synthesizing", "planning_experiment", "reviewing_experiment", "revising_experiment"]);

function stageIndex(status: string): number {
  if (["draft", "decomposing", "awaiting_scope_approval"].includes(status)) return 0;
  if (["collecting_sources", "awaiting_packet_approval"].includes(status)) return 1;
  if (["extracting_evidence", "verifying_evidence", "synthesizing", "planning_experiment"].includes(status)) return 2;
  if (["reviewing_experiment", "awaiting_objection_dispositions", "revising_experiment"].includes(status)) return 3;
  return 4;
}

function stageLabel(status: string): string {
  const labels: Record<string, string> = {
    decomposing: "Shaping testable claims",
    extracting_evidence: "Extracting exact passages",
    verifying_evidence: "Assessing claim entailment",
    synthesizing: "Synthesizing bounded findings",
    planning_experiment: "Drafting a bounded experiment",
    reviewing_experiment: "Running adversarial review",
    revising_experiment: "Applying accepted objections",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

export function LiveWorkspace({ runId }: { runId: string }) {
  const [data, setData] = useState<WorkspaceState>({ ...empty });
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState({ title: "", text: "", permissionBasis: "" });
  const [decision, setDecision] = useState({ choice: "approve", rationale: "", actor: "" });
  const [collection, setCollection] = useState<JsonRecord | null>(null);
  const [selectedStage, setSelectedStage] = useState(0);
  const [drawer, setDrawer] = useState<WorkspaceDrawer>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("search");
  const [selectedEvidence, setSelectedEvidence] = useState<JsonRecord | null>(null);
  const drawerReturnTarget = useRef<HTMLElement | null>(null);
  const previousActiveStage = useRef(0);
  const initializedStage = useRef(false);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}${path}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? "The workspace request failed.");
    return body;
  }, [runId]);

  const load = useCallback(async () => {
    try {
      const [run, progress, draft, timeline] = await Promise.all([request(""), request("/progress"), request("/sources"), request("/timeline")]);
      setData((current) => ({
        ...current,
        run: run.run ?? run.snapshot?.run ?? run,
        revision: run.revision ?? run.snapshot?.revision ?? progress.revision ?? current.revision,
        progress,
        draft: draft.draft ?? draft,
        timeline: timeline.events ?? [],
        loading: false,
        error: "",
      }));
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Unable to load this investigation." }));
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  const run = data.run ?? {};
  const status = String(run.status ?? data.progress?.status ?? "draft");
  const activeStage = stageIndex(status);
  const claims: JsonRecord[] = run.claims ?? [];
  const draftEntries: JsonRecord[] = data.draft?.sources ?? [];
  const packetVerification: JsonRecord | null = data.draft?.verification ?? null;
  const verifiedPassages: JsonRecord[] = packetVerification?.passages ?? [];
  const pendingPassages: JsonRecord[] = packetVerification?.pendingPassages ?? [];
  const evidence: JsonRecord[] = run.evidenceCards ?? [];
  const usableDraftSources = draftEntries.filter((entry) => (entry.chunks?.length ?? 0) > 0);
  const verifiedPassageCount = verifiedPassages.length;
  const targetPassages = Number(packetVerification?.targetPassages ?? collection?.targetPassages ?? 10);
  const packetReady = packetVerification?.status === "ready" && verifiedPassageCount === targetPassages && (packetVerification?.claimsMissing?.length ?? 0) === 0;
  const providerUnavailable = packetVerification?.status === "provider_unavailable";
  const evidenceShortfall = packetVerification?.status === "evidence_shortfall";
  const ledgerPassages = providerUnavailable ? pendingPassages : verifiedPassages;
  const packetAudit = packetVerification ?? collection;

  useEffect(() => {
    if (data.loading || initializedStage.current) return;
    const requested = stageIds.indexOf(window.location.hash.slice(1));
    setSelectedStage(requested >= 0 && requested <= activeStage ? requested : activeStage);
    previousActiveStage.current = activeStage;
    initializedStage.current = true;
  }, [activeStage, data.loading]);

  useEffect(() => {
    if (!initializedStage.current) return;
    const previous = previousActiveStage.current;
    setSelectedStage((current) => activeStage !== previous && current === previous ? activeStage : Math.min(current, activeStage));
    previousActiveStage.current = activeStage;
  }, [activeStage]);

  function chooseStage(index: number) {
    setSelectedStage(index);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${stageIds[index]}`);
  }

  function openDrawer(next: Exclude<WorkspaceDrawer, null>, target: HTMLElement, evidenceCard?: JsonRecord) {
    drawerReturnTarget.current = target;
    if (evidenceCard) setSelectedEvidence(evidenceCard);
    setDrawer(next);
  }

  function closeDrawer() {
    const returnTarget = drawerReturnTarget.current;
    setDrawer(null);
    window.requestAnimationFrame(() => returnTarget?.focus());
  }

  async function post(path: string, body: JsonRecord, message: string) {
    setNotice(message);
    try {
      await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await load();
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That action failed.");
    }
  }

  async function runModelStages() {
    let revision = data.revision;
    let nextStatus = status;
    setNotice(stageLabel(nextStatus));
    try {
      for (let step = 0; step < 8 && modelStatuses.has(nextStatus); step += 1) {
        const result = await request("/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision }) });
        const snapshot = result.snapshot;
        if (!snapshot?.run || !snapshot?.revision) throw new Error("The workflow returned an incomplete snapshot.");
        revision = snapshot.revision;
        nextStatus = snapshot.run.status;
        setData((current) => ({ ...current, run: snapshot.run, revision }));
        if (result.failure) throw new Error(result.failure.details ?? "The model stage failed and remains visible in the audit trail.");
        setNotice(stageLabel(nextStatus));
      }
      await load();
      setNotice("");
    } catch (error) {
      await load();
      setNotice(error instanceof Error ? error.message : "Analysis stopped before the next checkpoint.");
    }
  }

  async function autoCollect(expectedRevision = data.revision, mode: "initial" | "deeper" | "retry_verification" = "initial") {
    setNotice(mode === "retry_verification" ? "Retrying model verification on saved passages…" : mode === "deeper" ? "Searching deeper for missing verified passages…" : "Finding and dual-verifying 10 exact passages…");
    try {
      const result = await request("/sources/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision,
          mode,
        }),
      });
      setCollection(result.collection ?? null);
      await load();
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Automatic source collection failed.");
    }
  }

  async function approveScopeAndCollect() {
    setNotice("Approving scope…");
    try {
      const approved = await request("/checkpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkpoint: "scope", expectedRevision: data.revision, decision: { declaredActor: "Researcher", rationale: "Approved this bounded technical research scope for automatic evidence collection." } }),
      });
      setData((current) => ({ ...current, run: approved.run ?? approved, revision: approved.revision ?? current.revision }));
      await autoCollect(String(approved.revision ?? data.revision), "initial");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Scope approval failed.");
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setNotice("Searching OpenAlex…");
    try {
      const body = await request(`/sources/search?query=${encodeURIComponent(query)}`);
      setData((current) => ({ ...current, candidates: body.candidates ?? [] }));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Search failed.");
    }
  }

  async function addPaste(event: FormEvent) {
    event.preventDefault();
    await post("/sources/paste", {
      ...paste,
      id: `paste-${Date.now()}`,
      authors: [],
      year: null,
      venue: null,
      originalInput: "researcher paste",
      expectedRevision: data.revision,
      rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: paste.permissionBasis, checkedAt: new Date().toISOString() },
    }, "Adding authorized excerpt…");
    setPaste({ title: "", text: "", permissionBasis: "" });
  }

  async function upload(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.set("file", file);
    body.set("expectedRevision", data.revision);
    body.set("permissionBasis", "Researcher confirmed authorization to store, display, and analyze this upload.");
    body.set("title", file.name);
    setNotice("Extracting and ranking PDF passages…");
    try {
      await request("/sources/upload", { method: "POST", body });
      await load();
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
    }
  }

  async function checkpoint(kind: "scope" | "objection_dispositions" | "final") {
    if (kind === "final") {
      await post("/checkpoints", { checkpoint: "final", expectedRevision: data.revision, decision: { choice: decision.choice, declaredActor: decision.actor || "Researcher", rationale: decision.rationale || "Decision recorded after reviewing the bounded evidence packet." } }, "Recording final decision…");
      return;
    }
    const body: JsonRecord = { checkpoint: kind, expectedRevision: data.revision, decision: { declaredActor: decision.actor || "Researcher", rationale: decision.rationale || "Reviewed the available evidence and workflow boundary." } };
    if (kind === "objection_dispositions") body.dispositions = (run.review?.objections ?? []).map((objection: JsonRecord) => ({ objectionId: objection.id, disposition: "unresolved", basis: "Preserved as unresolved pending additional evidence." }));
    await post("/checkpoints", body, "Saving human checkpoint…");
  }

  if (data.loading) return <main className="research-workspace"><div className="research-loading"><LoaderCircle size={22} /><p>Opening investigation…</p></div></main>;
  if (data.error) return <main className="research-workspace"><div className="research-state-card research-state-error"><AlertTriangle size={20} /><h1>Investigation unavailable</h1><p>{data.error}</p><button type="button" className="research-button research-button-primary" onClick={() => { setData({ ...empty }); void load(); }}><RefreshCw size={15} /> Try again</button></div></main>;

  const passageProgress = Math.min(100, Math.round((verifiedPassageCount / targetPassages) * 100));

  return (
    <main className="research-workspace">
      <header className="research-workspace-header">
        <Link href="/" className="research-back"><ArrowLeft size={15} /> EvidenceForge</Link>
        <div className="research-workspace-tools">
          <button type="button" onClick={(event) => openDrawer("context", event.currentTarget)}><PanelRightOpen size={15} /> Context</button>
          <button type="button" onClick={(event) => openDrawer("activity", event.currentTarget)}><Activity size={15} /> Activity</button>
          <StatusBadge status={run.evidenceMode === "live" ? "working" : "needs-review"}>{run.evidenceMode === "live" ? "Live" : "Setup needed"}</StatusBadge>
        </div>
      </header>

      <div className="research-workspace-shell">
        <WorkspaceStageNav stages={stages} active={activeStage} selected={selectedStage} onSelect={chooseStage} />

        <section className="research-workspace-main" aria-label={`${stages[selectedStage]} stage`}>
          <header className="research-workspace-title">
            <div>
              <p className="research-kicker">{String(selectedStage + 1).padStart(2, "0")} / {stages.length} · {stages[selectedStage]}</p>
              <h1>{run.intake?.originalQuestion ?? "Untitled investigation"}</h1>
            </div>
            <span className={`research-workspace-status status-${status}`}>{status.replaceAll("_", " ")}</span>
          </header>

          {notice ? <div className="research-notice" role="status"><LoaderCircle size={15} /> {notice}</div> : null}

          {selectedStage === 0 ? <ScopePanel status={status} claims={claims} onApprove={approveScopeAndCollect} onRun={runModelStages} /> : null}

          {selectedStage === 1 ? (
            <section className="research-panel research-focused-panel">
              <PanelHeading icon={<BookOpen size={18} />} kicker="Evidence packet" title="Collect the signal" />
              <div className="research-source-progress">
                <div><span>Verified passages</span><strong>{verifiedPassageCount}<small> / {targetPassages}</small></strong></div>
                <div className="research-progress-track" role="progressbar" aria-label="Dual-model verified passages" aria-valuemin={0} aria-valuemax={targetPassages} aria-valuenow={verifiedPassageCount}><i style={{ width: `${passageProgress}%` }} /></div>
                <p>{packetReady ? "Ten literal passages passed deterministic checks and both model judges." : providerUnavailable ? `${pendingPassages.length} passage${pendingPassages.length === 1 ? " is" : "s are"} saved and awaiting model verification. Retrieval will not be repeated.` : evidenceShortfall ? `${verifiedPassageCount} of ${targetPassages} passages passed both model judges. Search deeper or add a trusted source; weak matches were not padded into the packet.` : "EvidenceForge will reject generic, cross-domain, and unverifiable matches."}</p>
                {packetAudit?.rejectionCounts ? <p className="research-muted">Rejected: {packetAudit.rejectionCounts.offTopic ?? 0} off-topic · {packetAudit.rejectionCounts.rightsIneligible ?? 0} rights · {packetAudit.rejectionCounts.primaryRejected ?? 0} primary · {packetAudit.rejectionCounts.reviewerRejected ?? 0} reviewer</p> : null}
                {providerUnavailable ? <p className="research-muted">Provider unavailable: {(packetVerification?.providerFailures ?? []).map((failure: JsonRecord) => `${failure.provider} ${String(failure.code).replaceAll("_", " ")} (${failure.affectedPassages} awaiting)`).join(" · ")}</p> : null}
              </div>
              <div className="research-panel-actions research-source-actions">
                <button type="button" className="research-button research-button-primary" onClick={() => void autoCollect(data.revision, providerUnavailable ? "retry_verification" : evidenceShortfall ? "deeper" : "initial")} disabled={notice.includes("passages")}><Sparkles size={15} /> {providerUnavailable ? "Retry verification" : evidenceShortfall ? "Search deeper" : "Build 10 verified passages"}</button>
                <button type="button" className="research-button research-button-secondary" onClick={(event) => openDrawer("add-source", event.currentTarget)}><Plus size={15} /> Add a source</button>
              </div>
              <SourceLedger entries={draftEntries} passages={ledgerPassages} claims={claims} pending={providerUnavailable} onRemove={async (id) => {
                try {
                  await request(`/sources/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: data.revision }) });
                  await load();
                } catch (error) {
                  setNotice(error instanceof Error ? error.message : "Could not remove source.");
                }
              }} />
              {packetReady ? <div className="research-sticky-action"><span><ShieldCheck size={15} /> Human packet checkpoint</span><button type="button" className="research-button research-button-primary" onClick={() => post("/packet", { expectedRevision: data.revision, declaredActor: "Researcher", rationale: "Reviewed ten dual-model verified literal passages, their source permissions, and claim coverage." }, "Freezing verified passages and hashes…")}>Freeze 10 verified passages <ArrowRight size={16} /></button></div> : null}
            </section>
          ) : null}

          {selectedStage === 2 ? (
            <section className="research-panel research-focused-panel">
              <PanelHeading icon={<ShieldCheck size={18} />} kicker="Evidence" title="What the packet establishes" />
              <div className="research-finding-summary">
                <span>Current conclusion</span>
                <strong>{run.conclusions?.[0]?.conclusion ?? "No conclusion has been committed yet."}</strong>
                <small>{run.researchGaps?.length ? `${run.researchGaps.length} decision-changing gaps remain.` : "No recorded decision-changing gap."}</small>
              </div>
              {evidence.length > 0 ? <div className="research-evidence-list">{evidence.map((card, index) => <button type="button" key={card.id ?? index} onClick={(event) => openDrawer("evidence-detail", event.currentTarget, card)}><StatusBadge status={card.relationship === "supports" ? "ready" : "needs-review"}>{card.relationship ?? "Candidate"}</StatusBadge><strong>{card.excerpt ?? "Open the recorded evidence passage."}</strong><span>{card.sourceChunkId ?? "Source passage"} <ArrowRight size={14} /></span></button>)}</div> : <div className="research-state-card"><FileText size={19} /><h3>Evidence analysis is ready</h3><p>Continue the workflow to extract and assess exact passages.</p></div>}
              {run.experiment ? <ExperimentSummary experiment={run.experiment} /> : null}
              {run.experimentAbstention ? <div className="research-state-card research-state-error"><AlertTriangle size={18} /><h3>Experiment planning abstained</h3><p>{run.experimentAbstention.reason}</p></div> : null}
              {modelStatuses.has(status) ? <button type="button" className="research-button research-button-primary" onClick={runModelStages}>{stageLabel(status)} <ArrowRight size={16} /></button> : null}
            </section>
          ) : null}

          {selectedStage === 3 ? (
            <section className="research-panel research-focused-panel">
              <PanelHeading icon={<AlertTriangle size={18} />} kicker="Adversarial review" title="Challenge the conclusion" />
              {run.review?.objections?.length ? <div className="research-objection-list">{run.review.objections.map((objection: JsonRecord, index: number) => <details className="research-objection" key={objection.id ?? index}><summary><span><strong>{objection.category ?? `Objection ${index + 1}`}</strong><small>{objection.targetField}</small></span><StatusBadge status="needs-review">{objection.severity}</StatusBadge></summary><p>{objection.rationale}</p></details>)}</div> : <div className="research-state-card"><ShieldCheck size={19} /><h3>Review has not started</h3><p>Complete evidence analysis before running an independent challenge.</p></div>}
              {status === "awaiting_objection_dispositions" ? <button type="button" className="research-button research-button-primary" onClick={() => checkpoint("objection_dispositions")}>Preserve objections and continue <ArrowRight size={16} /></button> : null}
              {status === "revising_experiment" ? <button type="button" className="research-button research-button-primary" onClick={runModelStages}>Apply dispositions <ArrowRight size={16} /></button> : null}
            </section>
          ) : null}

          {selectedStage === 4 ? <DecisionPanel status={status} run={run} decision={decision} setDecision={setDecision} onSave={() => checkpoint("final")} runId={runId} /> : null}
        </section>

        <ContextInspector run={run} runId={runId} status={status} sourceCount={usableDraftSources.length} />
      </div>

      <ResearchDrawer open={drawer === "add-source"} title="Add a source" kicker="Evidence packet" onClose={closeDrawer}>
        <div className="research-drawer-tabs" role="tablist" aria-label="Source input method">
          {(["search", "paste", "upload"] as SourceMode[]).map((mode) => <button key={mode} type="button" role="tab" aria-selected={sourceMode === mode} onClick={() => setSourceMode(mode)}>{mode}</button>)}
        </div>
        {sourceMode === "search" ? <><form className="research-source-search" onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search scholarly works…" aria-label="Search scholarly works" /><button className="research-button research-button-primary"><Search size={15} /> Search</button></form>{data.candidates.length > 0 ? <div className="research-candidate-list">{data.candidates.map((candidate, index) => <article className="research-candidate" key={candidate.openAlexId ?? index}><div><strong>{candidate.title ?? "Untitled work"}</strong><p>{candidate.authors?.join(", ") || "Scholarly work"} · {candidate.publicationYear ?? "n.d."} · {candidate.isOpenAccess ? "Open access" : "Metadata only"}</p></div><button type="button" className="research-button research-button-secondary" disabled={!candidate.isOpenAccess} onClick={() => post("/sources/openalex", { openAlexId: candidate.openAlexId, expectedRevision: data.revision, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: candidate.license ? `Open-access license: ${candidate.license}` : "Researcher reviewed OpenAlex open-access location", checkedAt: new Date().toISOString() } }, "Importing and ranking source passages…")}><Plus size={15} /> Add</button></article>)}</div> : <p className="research-muted">Search OpenAlex for an open scholarly source.</p>}</> : null}
        {sourceMode === "paste" ? <form className="research-paste-form" onSubmit={addPaste}><label>Source title<input required value={paste.title} onChange={(event) => setPaste({ ...paste, title: event.target.value })} /></label><label>Relevant excerpt<textarea required value={paste.text} onChange={(event) => setPaste({ ...paste, text: event.target.value })} rows={6} /></label><label>Permission basis<input required value={paste.permissionBasis} onChange={(event) => setPaste({ ...paste, permissionBasis: event.target.value })} placeholder="CC BY, author-provided…" /></label><button className="research-button research-button-primary"><FileText size={15} /> Add excerpt</button></form> : null}
        {sourceMode === "upload" ? <div className="research-upload-panel"><Upload size={22} /><strong>Upload an authorized PDF</strong><p>EvidenceForge extracts and ranks relevant passages without changing the original file.</p><label className="research-upload">Choose PDF<input type="file" accept="application/pdf" onChange={upload} /></label></div> : null}
      </ResearchDrawer>

      <ResearchDrawer open={drawer === "activity"} title="Activity and provenance" kicker="Run ledger" onClose={closeDrawer}>
        {data.timeline.length > 0 ? data.timeline.map((event, index) => <TimelineRow key={event.id ?? index} time={event.at ?? "—"} title={event.label ?? "Workflow event"} detail={event.stage} status={index === data.timeline.length - 1 ? "active" : "complete"} />) : <p className="research-muted">Timeline events will appear as the investigation progresses.</p>}
        {activeStage >= 2 ? <LiveEpistemicPanel runId={runId} /> : null}
      </ResearchDrawer>

      <ResearchDrawer open={drawer === "context"} title="Investigation context" kicker="Current boundary" onClose={closeDrawer}>
        <ContextSummary run={run} runId={runId} status={status} sourceCount={usableDraftSources.length} />
      </ResearchDrawer>

      <ResearchDrawer open={drawer === "evidence-detail"} title="Evidence passage" kicker={selectedEvidence?.relationship ?? "Verification"} onClose={closeDrawer}>
        {selectedEvidence ? <div className="research-evidence-detail"><blockquote>“{selectedEvidence.excerpt}”</blockquote><dl><div><dt>Source passage</dt><dd>{selectedEvidence.sourceChunkId ?? "Not recorded"}</dd></div><div><dt>Claim</dt><dd>{selectedEvidence.subclaimId ?? "Not recorded"}</dd></div><div><dt>Passage check</dt><dd>{selectedEvidence.deterministicVerification?.excerptExists ? "Verified" : "Failed"}</dd></div><div><dt>Model assessment</dt><dd>{selectedEvidence.modelAssessment?.entailment ?? "Pending"}</dd></div><div><dt>Human review</dt><dd>{selectedEvidence.humanReview?.status ?? "Unreviewed"}</dd></div></dl></div> : null}
      </ResearchDrawer>
    </main>
  );
}

function PanelHeading({ icon, kicker, title }: { icon: React.ReactNode; kicker: string; title: string }) {
  return <div className="research-panel-heading"><span>{icon}</span><div><p>{kicker}</p><h2>{title}</h2></div></div>;
}

function ScopePanel({ status, claims, onApprove, onRun }: { status: string; claims: JsonRecord[]; onApprove: () => void; onRun: () => void }) {
  return <section className="research-panel research-focused-panel"><PanelHeading icon={<ShieldCheck size={18} />} kicker="Human checkpoint" title="Approve the claim boundary" /><div className="research-claim-list">{claims.map((claim, index) => <details className="research-claim-card" key={claim.id ?? index}><summary><span>Claim {String(index + 1).padStart(2, "0")}</span><h3>{claim.statement}</h3></summary><p>{claim.operationalDefinition}</p><StatusBadge status="needs-review">Needs review</StatusBadge></details>)}</div>{claims.length === 0 ? <div className="research-state-card"><FileText size={19} /><h3>No claims yet</h3><p>Shape the question into a testable contract.</p></div> : null}<div className="research-panel-actions">{status === "awaiting_scope_approval" ? <button type="button" className="research-button research-button-primary" onClick={onApprove}>Approve and collect sources <ArrowRight size={16} /></button> : <button type="button" className="research-button research-button-primary" onClick={onRun}>Shape claims <ArrowRight size={16} /></button>}</div></section>;
}

function SourceLedger({ entries, passages, claims, pending, onRemove }: { entries: JsonRecord[]; passages: JsonRecord[]; claims: JsonRecord[]; pending: boolean; onRemove: (id: string) => Promise<void> }) {
  const claimNumber = new Map(claims.map((claim, index) => [claim.id, index + 1]));
  return <div className="research-source-ledger"><div className="research-ledger-header"><h3>Packet ledger</h3><span>{entries.length} sources · {passages.length} {pending ? "awaiting verification" : "verified"}</span></div>{entries.length > 0 ? entries.map((entry, index) => { const source = entry.source ?? {}; const sourcePassages = passages.filter((passage) => passage.sourceId === source.id); const preview = sourcePassages[0]?.excerpt; const claimLabels = [...new Set(sourcePassages.map((passage) => claimNumber.get(passage.subclaimId ?? passage.claimId)).filter(Boolean))].map((number) => `Claim ${number}`).join(", "); return <div className="research-source-row" key={source.id ?? index}><span className="research-source-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{source.bibliographicMetadata?.title ?? "Untitled source"}</strong><p>{sourcePassages.length} {pending ? "awaiting verification" : "dual-verified"} · {claimLabels || "Claim pending"}{preview ? ` · “${String(preview).slice(0, 110)}${String(preview).length > 110 ? "…" : ""}”` : ""}</p></div><button type="button" className="research-icon-button" aria-label={`Remove ${source.bibliographicMetadata?.title ?? "source"}`} onClick={() => void onRemove(source.id)}><Trash2 size={15} /></button></div>; }) : <div className="research-ledger-empty"><BookOpen size={18} /><p>No verified passages yet. Build the packet automatically.</p></div>}</div>;
}

function ContextSummary({ run, runId, status, sourceCount }: { run: JsonRecord; runId: string; status: string; sourceCount: number }) {
  const constraints: string[] = run.intake?.constraints ?? [];
  return <div className="research-context-summary"><section><span>Decision</span><p>{run.intake?.intendedApplication ?? "Not specified"}</p></section><section><span>Boundaries</span>{constraints.length ? <ul>{constraints.slice(0, 3).map((constraint) => <li key={constraint}>{constraint}</li>)}</ul> : <p>No additional boundaries.</p>}</section><dl><div><dt>Status</dt><dd>{status.replaceAll("_", " ")}</dd></div><div><dt>Sources</dt><dd>{sourceCount} usable</dd></div><div><dt>Mode</dt><dd>{run.evidenceMode ?? "pending"}</dd></div><div><dt>Run</dt><dd>{run.id ?? runId}</dd></div></dl></div>;
}

function ContextInspector({ run, runId, status, sourceCount }: { run: JsonRecord; runId: string; status: string; sourceCount: number }) {
  return <aside className="research-context-inspector" aria-label="Investigation context"><div className="research-context-heading"><Info size={15} /><span>Context</span></div><ContextSummary run={run} runId={runId} status={status} sourceCount={sourceCount} /></aside>;
}

function ExperimentSummary({ experiment }: { experiment: JsonRecord }) {
  return <details className="research-experiment-summary"><summary><span>Bounded experiment</span><strong>{experiment.objective}</strong></summary><dl><div><dt>Design</dt><dd>{experiment.designType}</dd></div><div><dt>Comparator</dt><dd>{experiment.comparator}</dd></div><div><dt>Validity boundary</dt><dd>{experiment.externalValidityBoundary}</dd></div></dl></details>;
}

function DecisionPanel({ status, run, decision, setDecision, onSave, runId }: { status: string; run: JsonRecord; decision: { choice: string; rationale: string; actor: string }; setDecision: (value: { choice: string; rationale: string; actor: string }) => void; onSave: () => void; runId: string }) {
  const terminal = ["approved", "rejected"].includes(status);
  return <section className="research-panel research-focused-panel"><PanelHeading icon={<Check size={18} />} kicker="Accountable researcher" title="Make the call" />{!terminal ? <><div className="research-decision-options"><label><input type="radio" name="decision" checked={decision.choice === "approve"} onChange={() => setDecision({ ...decision, choice: "approve" })} /><span><strong>Approve</strong><small>Accept this bounded conclusion</small></span></label><label><input type="radio" name="decision" checked={decision.choice === "reject"} onChange={() => setDecision({ ...decision, choice: "reject" })} /><span><strong>Reject</strong><small>Do not accept this conclusion</small></span></label></div><label className="research-decision-field">Accountable researcher<input className="research-decision-input" value={decision.actor} onChange={(event) => setDecision({ ...decision, actor: event.target.value })} placeholder="Name or research role" /></label><label className="research-decision-field">Decision rationale<textarea className="research-decision-input" value={decision.rationale} onChange={(event) => setDecision({ ...decision, rationale: event.target.value })} placeholder="Why does the packet justify this decision?" rows={4} /></label><button type="button" className="research-button research-button-primary" onClick={onSave}>Record decision <Check size={16} /></button></> : <><div className="research-state-card"><Check size={18} /><h3>Decision recorded: {status}</h3><p>{run.finalDecision?.rationale}</p></div><a className="research-button research-button-secondary" href={`/api/runs/${encodeURIComponent(runId)}/export`}><Download size={15} /> Export canonical record</a></>}</section>;
}
