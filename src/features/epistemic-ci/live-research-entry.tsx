"use client";

import { ArrowRight, Check, Clock3, LoaderCircle, LockKeyhole, Play, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import styles from "./workspace.module.css";

type CreatedRun = {
  run?: { id?: string };
  revision?: string;
  snapshot?: { run?: { id?: string }; revision?: string };
  error?: { message?: string };
};

export function LiveResearchEntry({ ownerDemo = false, onUseDemo }: { ownerDemo?: boolean; onUseDemo?: () => void }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [application, setApplication] = useState("");
  const [constraints, setConstraints] = useState("");
  const [state, setState] = useState<"idle" | "creating" | "decomposing" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || !application.trim()) return;
    setState("creating");
    setError("");
    try {
      const createdResponse = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: null,
          intake: {
            originalQuestion: question.trim(),
            intendedApplication: application.trim(),
            populationOrGeography: "Bounded technical or scientific context",
            timeHorizon: "Current available evidence",
            availableMaterialsOrBudget: "Automatic bounded scholarly search",
            desiredDepth: "Ten-source evidence packet with source-level provenance",
            constraints: [
              "Exclude clinical advice, hazardous procedures, and autonomous real-world action.",
              constraints.trim(),
            ].filter(Boolean),
            unansweredClarifications: [],
          },
        }),
      });
      const created = await createdResponse.json().catch(() => ({})) as CreatedRun;
      if (!createdResponse.ok) throw new Error(created.error?.message ?? "The live investigation could not be created.");
      const run = created.snapshot ?? created;
      const runId = run.run?.id;
      const revision = run.revision;
      if (!runId || !revision) throw new Error("The private run identity was missing.");
      setState("decomposing");
      const continued = await fetch(`/api/runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      if (!continued.ok) {
        const failure = await continued.json().catch(() => ({})) as CreatedRun;
        throw new Error(failure.error?.message ?? "Claim decomposition failed.");
      }
      router.push(`/runs/${encodeURIComponent(runId)}`);
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "The live investigation failed to start.");
    }
  }

  const busy = state === "creating" || state === "decomposing";
  const examples = [
    { label: "Retrieval vs. hallucination · guided walkthrough", question: "Does retrieval-augmented generation reduce factual hallucination compared with the same model without retrieval?", application: "Choose an evidence-grounding architecture for a research assistant.", demoHref: "/demo/rag" },
    { label: "Independent model review", question: "Does an independent evaluator reduce reward hacking in sparse-data model evaluation?", application: "Choose an evaluator architecture for model training." },
    { label: "Cold-weather storage", question: "Does sodium-ion storage improve cold-weather reliability for remote sensor deployments?", application: "Choose a storage chemistry for a remote monitoring system." },
  ];
  const visibleExamples = examples.filter((example) => ownerDemo || !("demoHref" in example));

  return (
    <main className={styles.workspace}>
      <section className={styles.liveEntry}>
        <header className={styles.liveEntryHeader}>
          <div className={styles.liveEntryBrand}>
            <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
            <div><strong>EvidenceForge</strong><span>Epistemic CI</span></div>
          </div>
          {ownerDemo && onUseDemo ? <button className={styles.demoLink} type="button" disabled={busy} onClick={onUseDemo}>
            <Play aria-hidden="true" size={13} /> Owner demo
          </button> : null}
        </header>

        <div className={styles.liveEntryGrid}>
          <div className={styles.liveEntryCopy}>
            <span className={styles.eyebrow}>Auditable research workflow</span>
            <h1>Test a claim against the evidence.</h1>
            <p>EvidenceForge searches scholarly literature, verifies exact passages, and records every model and human decision.</p>
            <ol className={styles.workflowPreview} aria-label="Investigation workflow">
              {["Scope", "Sources", "Evidence", "Review", "Decision"].map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
            </ol>
            <div className={styles.entryProof}>
              <span><ShieldCheck aria-hidden="true" size={14} /> Exact text and provenance retained</span>
              <span><Check aria-hidden="true" size={14} /> Independent review stays inspectable</span>
            </div>
          </div>

          <form className={styles.liveEntryForm} onSubmit={submit}>
            <div className={styles.formMeta}><span>New investigation</span><span>Research brief</span></div>
            <p className={styles.liveEntryNotice}>Runs are process-local and may expire or disappear when the server restarts. Export important results.</p>
            <div className={styles.examplePrompts} aria-label="Prompt examples">
              {visibleExamples.map((example) => <button key={example.label} type="button" disabled={busy} onClick={() => { if ("demoHref" in example && example.demoHref) { router.push(example.demoHref); return; } setQuestion(example.question); setApplication(example.application); }}>{example.label}</button>)}
            </div>
            <label className={styles.questionField}>
              Research question
              <textarea required rows={4} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Can retrieval prevent reward hacking in sparse-data evaluation?" />
            </label>
            <label>
              Decision this will inform
              <textarea required rows={2} value={application} onChange={(event) => setApplication(event.target.value)} placeholder="Choose an evaluation or system design" />
            </label>
            <details className={styles.boundaryDisclosure}>
              <summary>Add boundaries <span>Optional</span></summary>
              <label>
                Scope boundaries
                <input value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="Population, system, date range, exclusions…" />
              </label>
            </details>
            {state === "error" ? <p className={styles.liveEntryError} role="alert">{error}</p> : null}
            <button className={styles.primaryButton} type="submit" disabled={busy || !question.trim() || !application.trim()}>
              {busy ? <><LoaderCircle aria-hidden="true" size={16} /> {state === "creating" ? "Creating investigation..." : "Shaping claims..."}</> : <>Start investigation <ArrowRight aria-hidden="true" size={16} /></>}
            </button>
            <div className={styles.sessionTrust}>
              <span><LockKeyhole aria-hidden="true" size={13} /> Process-local session</span>
              <span><Clock3 aria-hidden="true" size={13} /> May expire when the server restarts</span>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
