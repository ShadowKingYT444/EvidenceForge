"use client";

/* API projections are strictly validated by the server; this view narrows display-only JSON. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Activity, Check, GitBranch, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";

type JsonRecord = Record<string, any>;

export function LiveEpistemicPanel({ runId }: { runId: string }) {
  const [projection, setProjection] = useState<JsonRecord | null>(null);
  const [projectionHash, setProjectionHash] = useState("");
  const [build, setBuild] = useState<JsonRecord | null>(null);
  const [operations, setOperations] = useState<JsonRecord[]>([]);
  const [receipt, setReceipt] = useState<JsonRecord | null>(null);
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");

  async function request(path: string, body?: JsonRecord) {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/epistemic${path}`, body ? {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    } : undefined);
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) throw new Error(payload.error?.message ?? "The live epistemic request failed.");
    return payload;
  }

  async function project() {
    setState("working"); setMessage("Projecting the current run into a dependency graph…");
    try {
      const result = await request("");
      setProjection(result.projection);
      setProjectionHash(result.projectionHash);
      setBuild(null); setOperations([]); setReceipt(null); setState("idle"); setMessage("");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Projection failed."); }
  }

  async function compile(nextOperations = operations) {
    if (!projectionHash) return;
    setState("working"); setMessage("Compiling affected descendants…");
    try {
      const result = await request("/compile", { expectedProjectionHash: projectionHash, operations: nextOperations, parentBuildId: build?.buildId ?? null, idempotencyKey: `compile-${nextOperations.length}` });
      setBuild(result.build); setOperations(nextOperations); setReceipt(null); setState("idle"); setMessage("");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Compilation failed."); }
  }

  async function review() {
    if (!build?.graphHash) return;
    setState("working"); setMessage("Sealing the Research PR receipt…");
    try {
      const result = await request("/review", {
        expectedGraphHash: build.graphHash,
        operations,
        action: "approve_evidence_update",
        declaredActor: "Researcher",
        rationale: "Authorize this branch-only evidence update while preserving every unresolved scientific blocker.",
        idempotencyKey: `review-${build.buildId}`,
      });
      setReceipt(result.receipt); setState("idle"); setMessage("");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Review failed."); }
  }

  const nodes: JsonRecord[] = projection?.nodes ?? projection?.graph?.nodes ?? [];
  const passages = nodes.filter((node) => node.kind === "passage" && node.state !== "obsolete").slice(0, 6);
  const assumptions = nodes.filter((node) => node.kind === "assumption").slice(0, 4);
  const errors: JsonRecord[] = build?.errors ?? [];

  return <section className="research-panel live-epistemic-panel" aria-label="Live Epistemic CI compiler">
    <div className="research-panel-heading"><span><Activity size={18} /></span><div><h2>Epistemic CI build</h2><p>Compile the current live run, then test evidence or assumptions without mutating the frozen packet.</p></div></div>
    {message && <div className={state === "error" ? "research-intake-error" : "research-notice"} role={state === "error" ? "alert" : "status"}>{state === "working" ? <LoaderCircle size={15} /> : <XCircle size={15} />} {message}</div>}
    {!projection ? <button type="button" className="research-button research-button-primary" disabled={state === "working"} onClick={() => void project()}>Project live dependency graph <GitBranch size={16} /></button> : !build ? <button type="button" className="research-button research-button-primary" disabled={state === "working"} onClick={() => void compile([])}>Compile live run <Activity size={16} /></button> : <>
      <div className="live-epistemic-summary"><strong>{build.decision?.label ?? "Live build"}</strong><span>{nodes.length} nodes · {build.impactedNodeIds?.length ?? 0} impacted · {errors.length} compiler findings</span></div>
      {errors.length > 0 && <ul className="live-epistemic-errors">{errors.slice(0, 4).map((error) => <li key={error.id}><code>{error.code}</code><span>{error.message}</span></li>)}</ul>}
      <div className="live-epistemic-actions">
        {passages.map((node) => <button type="button" key={node.id} disabled={state === "working" || operations.some((operation) => operation.targetNodeIds?.includes(node.id))} onClick={() => void compile([...operations, { kind: "invalidate_evidence", targetNodeIds: [node.id], reason: "Researcher sensitivity branch." }])}><XCircle size={13} /> Remove {node.label}</button>)}
        {assumptions.map((node) => <button type="button" key={node.id} disabled={state === "working" || operations.some((operation) => operation.targetNodeIds?.includes(node.id))} onClick={() => void compile([...operations, { id: `assumption-${node.id}`, kind: "assumption_decision", targetNodeIds: [node.id], decision: "reject", reason: "Researcher rejected this bridge assumption." }])}><GitBranch size={13} /> Reject {node.label}</button>)}
      </div>
      {!receipt ? <button type="button" className="research-button research-button-primary" disabled={state === "working"} onClick={() => void review()}>Authorize Research PR <ShieldCheck size={16} /></button> : <div className="research-state-card"><Check size={18} /><h3>Research PR receipt sealed</h3><p>{receipt.evidenceUpdateStatus?.replaceAll("_", " ")} · scientific decision approved: no</p><code>{receipt.receiptHash}</code></div>}
    </>}
  </section>;
}
