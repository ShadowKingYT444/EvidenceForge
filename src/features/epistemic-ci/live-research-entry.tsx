"use client";

import { ArrowRight, FlaskConical, LoaderCircle, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import styles from "./workspace.module.css";

type CreatedRun = {
  run?: { id?: string };
  revision?: string;
  snapshot?: { run?: { id?: string }; revision?: string };
  error?: { message?: string };
};

export function LiveResearchEntry({ onUseDemo }: { onUseDemo: () => void }) {
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
  return (
    <main className={styles.workspace}>
      <section className={styles.liveEntry}>
        <header className={styles.liveEntryHeader}>
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <div><strong>EvidenceForge</strong><span>Live Epistemic CI</span></div>
        </header>
        <div className={styles.liveEntryGrid}>
          <div className={styles.liveEntryCopy}>
            <span className={styles.eyebrow}>Continuous integration for evidence-backed decisions</span>
            <h1>Research a real question. Then test what its conclusion depends on.</h1>
            <p>EvidenceForge decomposes the question, automatically triages open scholarship, builds an immutable packet, and compiles every downstream dependency.</p>
            <ul>
              <li><FlaskConical aria-hidden="true" size={15} /> Target 10 usable sources in three minutes</li>
              <li><ShieldCheck aria-hidden="true" size={15} /> One human packet-freeze checkpoint</li>
              <li><ArrowRight aria-hidden="true" size={15} /> Generic evidence, scope, and assumption branches</li>
            </ul>
          </div>
          <form className={styles.liveEntryForm} onSubmit={submit}>
            <label>Research question<textarea required rows={4} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What technical or scientific hypothesis should we test?" /></label>
            <label>Decision this will inform<textarea required rows={2} value={application} onChange={(event) => setApplication(event.target.value)} placeholder="What product, design, or research decision depends on the answer?" /></label>
            <label>Optional boundaries<input value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="Population, system, date range, exclusions…" /></label>
            {state === "error" ? <p className={styles.liveEntryError} role="alert">{error}</p> : null}
            <button className={styles.primaryButton} type="submit" disabled={busy || !question.trim() || !application.trim()}>
              {busy ? <><LoaderCircle aria-hidden="true" size={16} /> {state === "creating" ? "Creating private run…" : "Decomposing claims…"}</> : <>Start live research <ArrowRight aria-hidden="true" size={16} /></>}
            </button>
            <button className={styles.textButton} type="button" disabled={busy} onClick={onUseDemo}>Use deterministic battery demo instead</button>
          </form>
        </div>
      </section>
    </main>
  );
}
