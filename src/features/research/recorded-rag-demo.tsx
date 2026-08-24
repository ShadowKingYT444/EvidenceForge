"use client";

import {
  Activity,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  FileCheck2,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ragDemoApplication,
  ragDemoClaims,
  ragDemoConclusion,
  ragDemoFingerprint,
  ragDemoObjections,
  ragDemoQuestion,
  ragDemoSources,
  type RagDemoSource,
} from "@/fixtures/rag-recorded-demo";

import styles from "./recorded-rag-demo.module.css";

const stages = ["Scope", "Sources", "Evidence", "Review", "Decision"] as const;
const replaySteps = [
  "Loading the prepared claim contract...",
  "Replaying 10 scholarly search queries...",
  "Screening 200 candidate records for relevance and rights...",
  "Importing 10 retained papers from the frozen source packet...",
  "Hashing 10 exact abstract passages and checking provenance...",
  "Applying the prepared primary model assessments...",
  "Replaying independent review and human dispositions...",
  "Evidence packet ready. All prepared artifacts are now inspectable.",
] as const;

const verificationLabels = [
  "Discover",
  "Screen",
  "Import",
  "Extract",
  "Primary verification",
  "Independent review",
  "Freeze",
] as const;

function relationshipTone(relationship: RagDemoSource["relationship"]) {
  return relationship === "supports" ? "support" : relationship === "challenges" ? "challenge" : "qualify";
}

export function RecordedRagDemo() {
  const [selectedStage, setSelectedStage] = useState(1);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replaying, setReplaying] = useState(true);
  const [narration, setNarration] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState(ragDemoSources[0].id);
  const complete = replayIndex === replaySteps.length - 1;
  const selectedSource = ragDemoSources.find(({ id }) => id === selectedSourceId) ?? ragDemoSources[0];
  const revealedSourceCount = complete ? ragDemoSources.length : Math.min(ragDemoSources.length, Math.max(0, (replayIndex - 1) * 2));
  const visibleSources = ragDemoSources.slice(0, revealedSourceCount);

  useEffect(() => {
    if (!replaying || complete) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(replayIndex + 1, replaySteps.length - 1);
      setReplayIndex(next);
      if (next === replaySteps.length - 1) setReplaying(false);
    }, replayIndex < 2 ? 900 : 700);
    return () => window.clearTimeout(timer);
  }, [complete, replayIndex, replaying]);

  useEffect(() => {
    if (!narration || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(replaySteps[replayIndex]);
    utterance.rate = 1.02;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [narration, replayIndex]);

  const claimCounts = useMemo(
    () => new Map(ragDemoClaims.map((claim) => [claim.id, ragDemoSources.filter((source) => source.claimId === claim.id).length])),
    [],
  );

  function replay() {
    setSelectedStage(1);
    setReplayIndex(0);
    setReplaying(true);
  }

  function skipReplay() {
    setReplayIndex(replaySteps.length - 1);
    setReplaying(false);
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}><ArrowLeft size={15} /> EvidenceForge</Link>
        <div className={styles.topActions}>
          <span className={styles.recordedBadge}><Activity size={13} /> Guided walkthrough</span>
          <button type="button" onClick={() => setNarration((value) => !value)} aria-pressed={narration}>
            {narration ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {narration ? "Narration on" : "Narrate replay"}
          </button>
          <button type="button" onClick={replay}><RotateCcw size={14} /> Replay run</button>
        </div>
      </header>

      <div className={styles.shell}>
        <nav className={styles.stageRail} aria-label="Guided investigation stages">
          <span>Prepared investigation</span>
          <ol>
            {stages.map((stage, index) => {
              const locked = index > 1 && !complete;
              return <li key={stage} data-state={selectedStage === index ? "current" : index < selectedStage || complete ? "available" : "pending"}>
                <button type="button" disabled={locked} aria-current={selectedStage === index ? "step" : undefined} onClick={() => setSelectedStage(index)}>
                  <i>{index < selectedStage || complete ? <Check size={12} /> : index + 1}</i>
                  <strong>{stage}</strong>
                  <small>{locked ? "Replaying" : selectedStage === index ? "Current" : "Open"}</small>
                </button>
              </li>;
            })}
          </ol>
          <div className={styles.disclosure}>
            <ShieldCheck size={14} />
            <p><strong>Prepared evidence packet</strong>Provider calls are not made during this walkthrough. Sources and judgments are frozen for consistency.</p>
          </div>
        </nav>

        <section className={styles.workspace} aria-label={stages[selectedStage] + " stage"}>
          <header className={styles.workspaceHeader}>
            <div>
              <span>{String(selectedStage + 1).padStart(2, "0")} / 05 · {stages[selectedStage]}</span>
              <h1>{ragDemoQuestion}</h1>
            </div>
            <span className={styles.status}>{complete ? "Packet ready" : "Replay in progress"}</span>
          </header>

          {selectedStage === 1 ? (
            <section className={styles.replayPanel} aria-label="Guided workflow replay">
              <div className={styles.replayHeading}>
                <span className={styles.replayIcon}>{replaying ? <Activity size={17} /> : <FileCheck2 size={17} />}</span>
                <div>
                  <span>Workflow replay</span>
                  <strong role="status" aria-live="polite">{replaySteps[replayIndex]}</strong>
                </div>
                {!complete ? <button type="button" onClick={skipReplay}><Pause size={14} /> Skip replay</button> : <button type="button" onClick={replay}><Play size={14} /> Replay</button>}
              </div>
              <div className={styles.replayTrack} aria-hidden="true"><i style={{ width: String(((replayIndex + 1) / replaySteps.length) * 100) + "%" }} /></div>
              <ol className={styles.pipeline} aria-label="Prepared evidence pipeline">
                {verificationLabels.map((label, index) => {
                  const state = complete || replayIndex > index ? "complete" : replayIndex === index ? "active" : "pending";
                  return <li key={label} data-state={state}><i>{state === "complete" ? <Check size={11} /> : index + 1}</i><span><strong>{label}</strong><small>{state === "complete" ? "Complete" : state === "active" ? "Replaying" : "Pending"}</small></span></li>;
                })}
              </ol>
            </section>
          ) : null}

          {selectedStage === 0 ? (
            <section className={styles.stageContent}>
              <div className={styles.sectionHeading}><span>Claim contract</span><h2>What this investigation can establish</h2><p>Decision this will inform: {ragDemoApplication}</p></div>
              <ol className={styles.claimList}>
                {ragDemoClaims.map((claim, index) => <li key={claim.id}><span>C{index + 1}</span><div><strong>{claim.statement}</strong><p>{claim.operationalDefinition}</p></div><small>{claimCounts.get(claim.id)} passages</small></li>)}
              </ol>
              <div className={styles.recordedCheckpoint}><Check size={14} /><span><strong>Scope approved</strong>Source search was bounded to empirical factuality evidence, retrieval failure modes, and evaluation methodology.</span></div>
            </section>
          ) : null}

          {selectedStage === 1 ? (
            <section className={styles.stageContent}>
              <div className={styles.metricGrid}>
                <div><span>Queries replayed</span><strong>{complete ? 10 : Math.min(10, replayIndex * 2)}</strong></div>
                <div><span>Candidates screened</span><strong>{replayIndex >= 2 ? 200 : "—"}</strong></div>
                <div><span>Sources retained</span><strong>{revealedSourceCount}</strong></div>
                <div><span>Exact passages</span><strong>{complete ? 10 : Math.max(0, revealedSourceCount - 2)}</strong></div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.sourceTable}>
                  <caption>Frozen scholarly source packet</caption>
                  <thead><tr><th scope="col">Source</th><th scope="col">Year</th><th scope="col">Claim</th><th scope="col">Bearing</th><th scope="col">Verification</th></tr></thead>
                  <tbody>
                    {visibleSources.map((source, index) => <tr key={source.id} style={{ animationDelay: String(index * 45) + "ms" }}>
                      <th scope="row"><button type="button" onClick={() => setSelectedSourceId(source.id)}><span>{source.title}</span><ChevronRight size={13} /></button></th>
                      <td>{source.year}</td><td>C{ragDemoClaims.findIndex(({ id }) => id === source.claimId) + 1}</td><td><span data-tone={relationshipTone(source.relationship)}>{source.relationship}</span></td><td><span className={styles.verified}><Check size={11} /> Stored</span></td>
                    </tr>)}
                    {!visibleSources.length ? Array.from({ length: 4 }, (_, index) => <tr className={styles.skeleton} key={index}><td colSpan={5}><i /></td></tr>) : null}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {selectedStage === 2 ? (
            <section className={styles.stageContent}>
              <div className={styles.sectionHeading}><span>Evidence ledger</span><h2>Exact passages with distinct verification layers</h2><p>Support and challenge evidence remain visible together; no colored badge substitutes for the underlying text.</p></div>
              <div className={styles.evidenceLedger}>
                {ragDemoSources.map((source, index) => <button type="button" key={source.id} onClick={() => setSelectedSourceId(source.id)} style={{ animationDelay: String(index * 45) + "ms" }}>
                  <span data-tone={relationshipTone(source.relationship)}>{source.relationship}</span>
                  <span><strong>“{source.excerpt}”</strong><small>{source.authors} · {source.venue} {source.year}</small></span>
                  <span className={styles.verificationStack}><small><Check size={10} /> Text + provenance</small><small><Check size={10} /> Primary assessment</small><small><Check size={10} /> Independent review</small><small><Check size={10} /> Human review</small></span>
                </button>)}
              </div>
            </section>
          ) : null}

          {selectedStage === 3 ? (
            <section className={styles.stageContent}>
              <div className={styles.sectionHeading}><span>Adversarial review</span><h2>What could change the conclusion</h2><p>Objections are preserved as first-class review issues, including one deliberately unresolved evaluation risk.</p></div>
              <div className={styles.objections}>
                {ragDemoObjections.map((objection) => <article key={objection.id} data-disposition={objection.disposition}>
                  <div><span>{objection.severity}</span><strong>{objection.title}</strong></div>
                  <p>{objection.rationale}</p>
                  <small>{objection.disposition === "accepted" ? "Accepted into bounded conclusion" : "Unresolved · retained in decision record"}</small>
                </article>)}
              </div>
            </section>
          ) : null}

          {selectedStage === 4 ? (
            <section className={styles.stageContent}>
              <div className={styles.sectionHeading}><span>Decision record</span><h2>Adopt RAG with evidence-quality gates</h2><p>The decision is narrower than “RAG solves hallucination.”</p></div>
              <blockquote className={styles.conclusion}>{ragDemoConclusion}</blockquote>
              <dl className={styles.decisionGrid}>
                <div><dt>Supporting passages</dt><dd>4</dd></div>
                <div><dt>Qualifying passages</dt><dd>4</dd></div>
                <div><dt>Challenging passages</dt><dd>2</dd></div>
                <div><dt>Unresolved objections</dt><dd>1</dd></div>
                <div className={styles.fingerprint}><dt>Packet fingerprint</dt><dd>{ragDemoFingerprint}</dd></div>
              </dl>
              <div className={styles.recordedCheckpoint}><ShieldCheck size={14} /><span><strong>Human decision</strong>Use RAG for the pilot only with relevance, faithfulness, provenance, and abstention controls.</span></div>
            </section>
          ) : null}
        </section>

        <aside className={styles.inspector} aria-label="Evidence source inspector">
          <header><BookOpen size={15} /><span>Source inspector</span></header>
          <div className={styles.inspectorBody}>
            <span data-tone={relationshipTone(selectedSource.relationship)}>{selectedSource.relationship}</span>
            <h2>{selectedSource.title}</h2>
            <p>{selectedSource.authors} · {selectedSource.venue} · {selectedSource.year}</p>
            <blockquote>“{selectedSource.excerpt}”</blockquote>
            <section><span>Finding</span><p>{selectedSource.finding}</p></section>
            <section><span>Limitation</span><p>{selectedSource.limitation}</p></section>
            <dl>
              <div><dt>Claim</dt><dd>C{ragDemoClaims.findIndex(({ id }) => id === selectedSource.claimId) + 1}</dd></div>
              <div><dt>DOI</dt><dd>{selectedSource.doi ?? "Not assigned"}</dd></div>
              <div><dt>Rights</dt><dd>Abstract excerpt · source linked</dd></div>
              <div><dt>Checks</dt><dd>Literal text, citation, model split, human record</dd></div>
            </dl>
            <a href={selectedSource.url} target="_blank" rel="noreferrer">Open scholarly source <ChevronRight size={13} /></a>
          </div>
          <footer><Gauge size={13} /> This inspector exposes the evidence behind every summary.</footer>
        </aside>
      </div>
    </main>
  );
}
