"use client";

/* API payloads are validated on the server; this view defensively narrows JSON. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { type FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Check, Download, FileText, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { StageRail, StatusBadge, TimelineRow } from "./primitives";

type JsonRecord = Record<string, any>;
type WorkspaceState = { run: JsonRecord | null; revision: string; progress: JsonRecord | null; draft: JsonRecord | null; timeline: JsonRecord[]; candidates: JsonRecord[]; loading: boolean; error: string };
const empty: WorkspaceState = { run: null, revision: "", progress: null, draft: null, timeline: [], candidates: [], loading: true, error: "" };
const stages = ["Scope", "Sources", "Evidence", "Review", "Decision"];
const modelStatuses = new Set(["draft", "decomposing", "extracting_evidence", "verifying_evidence", "synthesizing", "planning_experiment", "reviewing_experiment", "revising_experiment"]);

function stageIndex(status: string): number {
  if (["draft", "decomposing", "awaiting_scope_approval"].includes(status)) return 0;
  if (["collecting_sources", "awaiting_packet_approval"].includes(status)) return 1;
  if (["extracting_evidence", "verifying_evidence", "synthesizing", "planning_experiment"].includes(status)) return 2;
  if (["reviewing_experiment", "awaiting_objection_dispositions", "revising_experiment"].includes(status)) return 3;
  return 4;
}

function stageLabel(status: string): string {
  const labels: Record<string, string> = { decomposing: "Shaping testable claims", extracting_evidence: "Extracting exact passages", verifying_evidence: "Assessing claim entailment", synthesizing: "Synthesizing bounded findings", planning_experiment: "Drafting a bounded experiment", reviewing_experiment: "Running adversarial review", revising_experiment: "Applying accepted objections" };
  return labels[status] ?? status.replaceAll("_", " ");
}

export function LiveWorkspace({ runId }: { runId: string }) {
  const [data, setData] = useState<WorkspaceState>({ ...empty });
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState({ title: "", text: "", permissionBasis: "" });
  const [decision, setDecision] = useState({ choice: "approve", rationale: "", actor: "" });

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}${path}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? "The workspace request failed.");
    return body;
  }, [runId]);

  const load = useCallback(async () => {
    try {
      const [run, progress, draft, timeline] = await Promise.all([request(""), request("/progress"), request("/sources"), request("/timeline")]);
      setData((current) => ({ ...current, run: run.run ?? run.snapshot?.run ?? run, revision: run.revision ?? run.snapshot?.revision ?? progress.revision ?? current.revision, progress, draft: draft.draft ?? draft, timeline: timeline.events ?? [], loading: false, error: "" }));
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Unable to load this investigation." }));
    }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  const run = data.run ?? {};
  const status = String(run.status ?? data.progress?.status ?? "draft");
  const claims: JsonRecord[] = run.claims ?? [];
  const draftEntries: JsonRecord[] = data.draft?.sources ?? [];
  const evidence: JsonRecord[] = run.evidenceCards ?? [];
  const usableDraftSources = draftEntries.filter((entry) => (entry.chunks?.length ?? 0) > 0);

  async function post(path: string, body: JsonRecord, message: string) {
    setNotice(message);
    try {
      await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await load(); setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "That action failed."); }
  }

  async function runModelStages() {
    let revision = data.revision; let nextStatus = status; setNotice(stageLabel(nextStatus));
    try {
      for (let step = 0; step < 8 && modelStatuses.has(nextStatus); step += 1) {
        const result = await request("/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision }) });
        const snapshot = result.snapshot;
        if (!snapshot?.run || !snapshot?.revision) throw new Error("The workflow returned an incomplete snapshot.");
        revision = snapshot.revision; nextStatus = snapshot.run.status;
        setData((current) => ({ ...current, run: snapshot.run, revision }));
        if (result.failure) throw new Error(result.failure.details ?? "The model stage failed and remains visible in the audit trail.");
        setNotice(stageLabel(nextStatus));
      }
      await load(); setNotice("");
    } catch (error) { await load(); setNotice(error instanceof Error ? error.message : "Analysis stopped before the next checkpoint."); }
  }

  async function search(event: FormEvent) {
    event.preventDefault(); if (!query.trim()) return; setNotice("Searching OpenAlex");
    try { const body = await request(`/sources/search?query=${encodeURIComponent(query)}`); setData((current) => ({ ...current, candidates: body.candidates ?? [] })); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Search failed."); }
  }

  async function addPaste(event: FormEvent) {
    event.preventDefault();
    await post("/sources/paste", { ...paste, id: `paste-${Date.now()}`, authors: [], year: null, venue: null, originalInput: "researcher paste", expectedRevision: data.revision, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: paste.permissionBasis, checkedAt: new Date().toISOString() } }, "Adding authorized excerpt");
    setPaste({ title: "", text: "", permissionBasis: "" });
  }

  async function upload(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; if (!file) return;
    const body = new FormData(); body.set("file", file); body.set("expectedRevision", data.revision); body.set("permissionBasis", "Researcher confirmed authorization to store, display, and analyze this upload."); body.set("title", file.name);
    setNotice("Extracting and ranking PDF passages");
    try { await request("/sources/upload", { method: "POST", body }); await load(); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Upload failed."); }
  }

  async function checkpoint(kind: "scope" | "objection_dispositions" | "final") {
    if (kind === "final") {
      await post("/checkpoints", { checkpoint: "final", expectedRevision: data.revision, decision: { choice: decision.choice, declaredActor: decision.actor || "Researcher", rationale: decision.rationale || "Decision recorded after reviewing the bounded evidence packet." } }, "Recording final decision"); return;
    }
    const body: JsonRecord = { checkpoint: kind, expectedRevision: data.revision, decision: { declaredActor: decision.actor || "Researcher", rationale: decision.rationale || "Reviewed the available evidence and workflow boundary." } };
    if (kind === "objection_dispositions") body.dispositions = (run.review?.objections ?? []).map((objection: JsonRecord) => ({ objectionId: objection.id, disposition: "unresolved", basis: "Preserved as unresolved pending additional evidence." }));
    await post("/checkpoints", body, "Saving human checkpoint");
  }

  if (data.loading) return <main className="research-workspace"><div className="research-loading"><LoaderCircle size={22} /><p>Opening your investigation...</p></div></main>;
  if (data.error) return <main className="research-workspace"><div className="research-state-card research-state-error"><AlertTriangle size={20} /><h1>Investigation unavailable</h1><p>{data.error}</p><button type="button" className="research-button research-button-primary" onClick={() => { setData({ ...empty }); void load(); }}><RefreshCw size={15} /> Try again</button></div></main>;

  return <main className="research-workspace"><header className="research-workspace-header"><Link href="/" className="research-back"><ArrowLeft size={15} /> EvidenceForge</Link><div><StatusBadge status="ready">Private run</StatusBadge><StatusBadge status="ready">Durable</StatusBadge><StatusBadge status={run.evidenceMode === "live" ? "working" : "needs-review"}>{run.evidenceMode === "live" ? "Live analysis" : "Provider setup required"}</StatusBadge></div></header><div className="research-workspace-wrap">
    <StageRail stages={stages} active={stageIndex(status)} />
    <div className="research-workspace-title"><div><p className="research-kicker">Investigation / {run.id ?? runId}</p><h1>{run.intake?.originalQuestion ?? "Untitled investigation"}</h1><p className="research-workspace-meta">{run.intake?.intendedApplication ?? "Research workspace"}</p></div><span className={`research-workspace-status status-${status}`}>{status.replaceAll("_", " ")}</span></div>
    {notice && <div className="research-notice" role="status"><LoaderCircle size={15} /> {notice}</div>}

    {stageIndex(status) === 0 && <ScopePanel status={status} claims={claims} onApprove={() => checkpoint("scope")} onRun={runModelStages} />}
    {stageIndex(status) === 1 && <section className="research-panel"><PanelHeading icon={<BookOpen size={18} />} title="Build the evidence packet" copy="Find open scholarship, inspect selected passages, and freeze an immutable packet." />
      <form className="research-source-search" onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search scholarly works..." aria-label="Search scholarly works" /><button className="research-button research-button-primary"><Search size={15} /> Search</button></form>
      {data.candidates.length > 0 && <div className="research-candidate-list">{data.candidates.map((candidate, index) => <article className="research-candidate" key={candidate.openAlexId ?? index}><div><strong>{candidate.title ?? "Untitled work"}</strong><p>{candidate.authors?.join(", ") || "Scholarly work"} · {candidate.publicationYear ?? "n.d."} · {candidate.isOpenAccess ? "Open access" : "Metadata only"}</p></div><button type="button" className="research-button research-button-secondary" disabled={!candidate.isOpenAccess} onClick={() => post("/sources/openalex", { openAlexId: candidate.openAlexId, expectedRevision: data.revision, rights: { mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed", permissionBasis: candidate.license ? `Open-access license: ${candidate.license}` : "Researcher reviewed OpenAlex open-access location", checkedAt: new Date().toISOString() } }, "Importing and ranking source passages")}><Plus size={15} /> Add</button></article>)}</div>}
      <form className="research-paste-form" onSubmit={addPaste}><h3>Bring a source you already trust</h3><input required value={paste.title} onChange={(event) => setPaste({ ...paste, title: event.target.value })} placeholder="Source title" /><textarea required value={paste.text} onChange={(event) => setPaste({ ...paste, text: event.target.value })} placeholder="Paste an abstract or relevant excerpt..." rows={4} /><input required value={paste.permissionBasis} onChange={(event) => setPaste({ ...paste, permissionBasis: event.target.value })} placeholder="Permission basis (for example, CC BY or author-provided)" /><button className="research-button research-button-secondary"><FileText size={15} /> Add excerpt</button></form>
      <label className="research-upload"><Upload size={16} /> Upload an authorized PDF<input type="file" accept="application/pdf" onChange={upload} /></label>
      <SourceLedger entries={draftEntries} onRemove={async (id) => { try { await request(`/sources/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: data.revision }) }); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not remove source."); } }} />
      <div className="research-panel-actions"><button type="button" className="research-button research-button-primary" disabled={usableDraftSources.length < 2} onClick={() => post("/packet", { expectedRevision: data.revision, declaredActor: "Researcher", rationale: "Reviewed source permissions and selected exact passages." }, "Freezing packet and verifying hashes")}>Freeze packet <ShieldCheck size={16} /></button></div>
    </section>}

    {stageIndex(status) >= 2 && <section className="research-panel"><PanelHeading icon={<ShieldCheck size={18} />} title="Evidence and findings" copy="Every finding remains anchored to a literal passage and separate verification layers." />
      {evidence.length > 0 ? <div className="research-evidence-grid">{evidence.map((card, index) => <article className="research-evidence-card" key={card.id ?? index}><StatusBadge status={card.relationship === "supports" ? "ready" : "needs-review"}>{card.relationship ?? "Evidence candidate"}</StatusBadge><blockquote>“{card.excerpt}”</blockquote><p>{card.sourceChunkId} · {card.subclaimId}</p><div><span>Passage: {card.deterministicVerification?.excerptExists ? "verified" : "failed"}</span><span>Model: {card.modelAssessment?.entailment ?? "pending"}</span><span>Human: {card.humanReview?.status ?? "unreviewed"}</span></div></article>)}</div> : <div className="research-state-card"><FileText size={19} /><h3>Evidence analysis is ready</h3><p>The live workflow will extract exact candidate passages before assessing what they mean.</p></div>}
      <div className="research-findings"><h3>Findings and open gaps</h3><p>{run.conclusions?.[0]?.conclusion ?? "No conclusion has been committed yet."}</p><p className="research-muted">{run.researchGaps?.length ? `${run.researchGaps.length} decision-changing gaps remain open.` : "Open questions will appear as the packet is analyzed."}</p></div>
      {run.experiment && <ExperimentSummary experiment={run.experiment} />}{run.experimentAbstention && <div className="research-state-card research-state-error"><AlertTriangle size={18} /><h3>Experiment planning abstained</h3><p>{run.experimentAbstention.reason}</p></div>}
      {modelStatuses.has(status) && <button type="button" className="research-button research-button-primary" onClick={runModelStages}>{stageLabel(status)} <ArrowRight size={16} /></button>}
    </section>}

    {stageIndex(status) >= 3 && run.review && <section className="research-panel"><PanelHeading icon={<AlertTriangle size={18} />} title="Adversarial review" copy="Objections cannot silently rewrite the experiment; unresolved risks remain visible." />
      {run.review.objections.map((objection: JsonRecord, index: number) => <div className="research-objection" key={objection.id ?? index}><strong>{objection.category ?? `Objection ${index + 1}`} · {objection.targetField}</strong><p>{objection.rationale}</p><StatusBadge status="needs-review">{objection.severity}</StatusBadge></div>)}
      {status === "awaiting_objection_dispositions" && <button type="button" className="research-button research-button-primary" onClick={() => checkpoint("objection_dispositions")}>Preserve objections and continue <ArrowRight size={16} /></button>}{status === "revising_experiment" && <button type="button" className="research-button research-button-primary" onClick={runModelStages}>Apply dispositions <ArrowRight size={16} /></button>}
    </section>}

    {stageIndex(status) >= 4 && <DecisionPanel status={status} run={run} decision={decision} setDecision={setDecision} onSave={() => checkpoint("final")} runId={runId} />}
    <section className="research-panel research-timeline-panel"><PanelHeading icon={<RefreshCw size={18} />} title="Provenance timeline" copy="A durable record of model work, human checkpoints, failures, and retries." />{data.timeline.length > 0 ? data.timeline.map((event, index) => <TimelineRow key={event.id ?? index} time={event.at ?? "—"} title={event.label ?? "Workflow event"} detail={event.stage} status={index === data.timeline.length - 1 ? "active" : "complete"} />) : <p className="research-muted">Timeline events will appear as the investigation progresses.</p>}</section>
  </div></main>;
}

function PanelHeading({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) { return <div className="research-panel-heading"><span>{icon}</span><div><h2>{title}</h2><p>{copy}</p></div></div>; }
function ScopePanel({ status, claims, onApprove, onRun }: { status: string; claims: JsonRecord[]; onApprove: () => void; onRun: () => void }) { return <section className="research-panel"><PanelHeading icon={<ShieldCheck size={18} />} title="Scope the claim" copy="Review the generated claim contract before any sources are gathered." /><div className="research-claim-list">{claims.map((claim, index) => <article className="research-claim-card" key={claim.id ?? index}><span>Claim {index + 1}</span><h3>{claim.statement}</h3><p>{claim.operationalDefinition}</p><StatusBadge status="needs-review">Needs your review</StatusBadge></article>)}</div>{claims.length === 0 && <div className="research-state-card"><FileText size={19} /><h3>Claims have not been shaped yet</h3><p>Run the first live stage to turn your question into a testable contract.</p></div>}<div className="research-panel-actions">{status === "awaiting_scope_approval" ? <button type="button" className="research-button research-button-primary" onClick={onApprove}>Approve scope <ArrowRight size={16} /></button> : <button type="button" className="research-button research-button-primary" onClick={onRun}>Shape claims <ArrowRight size={16} /></button>}</div></section>; }
function SourceLedger({ entries, onRemove }: { entries: JsonRecord[]; onRemove: (id: string) => void }) { const passages = entries.reduce((total, entry) => total + (entry.chunks?.length ?? 0), 0); return <div className="research-source-ledger"><div className="research-ledger-header"><h3>Packet ledger</h3><span>{entries.length} sources · {passages} passages</span></div>{entries.length > 0 ? entries.map((entry, index) => { const source = entry.source ?? {}; return <div className="research-source-row" key={source.id ?? index}><div><strong>{source.bibliographicMetadata?.title ?? "Untitled source"}</strong><p>{source.access?.provider ?? "Research source"} · {(entry.chunks?.length ?? 0) > 0 ? `${entry.chunks.length} passages ready` : "Metadata only"}</p></div><button type="button" className="research-icon-button" aria-label={`Remove ${source.bibliographicMetadata?.title ?? "source"}`} onClick={() => onRemove(source.id)}><Trash2 size={15} /></button></div>; }) : <p className="research-muted">Your selected sources will appear here.</p>}</div>; }
function ExperimentSummary({ experiment }: { experiment: JsonRecord }) { return <div className="research-experiment-summary"><h3>Bounded experiment proposal</h3><p>{experiment.objective}</p><dl><div><dt>Design</dt><dd>{experiment.designType}</dd></div><div><dt>Comparator</dt><dd>{experiment.comparator}</dd></div><div><dt>Validity boundary</dt><dd>{experiment.externalValidityBoundary}</dd></div></dl><div className="research-experiment-lists"><div><strong>Controls</strong><ul>{(experiment.controls ?? []).map((item: string) => <li key={item}>{item}</li>)}</ul></div><div><strong>Stopping criteria</strong><ul>{(experiment.stoppingCriteria ?? []).map((item: string) => <li key={item}>{item}</li>)}</ul></div></div></div>; }
function DecisionPanel({ status, run, decision, setDecision, onSave, runId }: { status: string; run: JsonRecord; decision: { choice: string; rationale: string; actor: string }; setDecision: (value: { choice: string; rationale: string; actor: string }) => void; onSave: () => void; runId: string }) { const terminal = ["approved", "rejected"].includes(status); return <section className="research-panel"><PanelHeading icon={<Check size={18} />} title="Your decision" copy="The packet informs the decision. You remain the accountable researcher." />{!terminal && <><div className="research-decision-options"><label><input type="radio" name="decision" checked={decision.choice === "approve"} onChange={() => setDecision({ ...decision, choice: "approve" })} /> Approve this bounded conclusion</label><label><input type="radio" name="decision" checked={decision.choice === "reject"} onChange={() => setDecision({ ...decision, choice: "reject" })} /> Reject this bounded conclusion</label></div><input className="research-decision-input" value={decision.actor} onChange={(event) => setDecision({ ...decision, actor: event.target.value })} placeholder="Your name or research role" /><textarea className="research-decision-input" value={decision.rationale} onChange={(event) => setDecision({ ...decision, rationale: event.target.value })} placeholder="Decision rationale" rows={3} /><button type="button" className="research-button research-button-primary" onClick={onSave}>Record final decision <Check size={16} /></button></>}{terminal && <><div className="research-state-card"><Check size={18} /><h3>Decision recorded: {status}</h3><p>{run.finalDecision?.rationale}</p></div><a className="research-button research-button-secondary" href={`/api/runs/${encodeURIComponent(runId)}/export`}><Download size={15} /> Export canonical record</a></>}</section>; }
