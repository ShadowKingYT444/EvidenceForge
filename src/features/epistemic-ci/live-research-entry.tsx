"use client";

import { ArrowRight, LoaderCircle, Play, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ProviderOnboarding } from "../providers/onboarding";
import styles from "./workspace.module.css";

type CreatedRun = {
  run?: { id?: string };
  revision?: string;
  snapshot?: { run?: { id?: string }; revision?: string };
  error?: { message?: string };
};

type HealthState = {
  evidenceMode?: "fixture" | "live" | "invalid";
  liveInvestigationsReady?: boolean;
  reasonCodes?: string[];
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
      const healthResponse = await fetch("/api/health", { cache: "no-store" });
      const health = await healthResponse.json().catch(() => ({})) as HealthState;
      if (!healthResponse.ok || health.evidenceMode !== "live" || !health.liveInvestigationsReady) {
        if (health.evidenceMode === "fixture") {
          throw new Error("Fixture/demo mode is active. Live investigations are unavailable; use Try the demo.");
        }
        if (health.reasonCodes?.includes("openalex_key_missing")) {
          throw new Error("Live scholarly search is not configured.");
        }
        throw new Error("Live model providers are not configured.");
      }
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
          <div className={styles.liveEntryBrand}>
            <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
            <div><strong>EvidenceForge</strong><span>Epistemic CI</span></div>
          </div>
          <button className={styles.demoLink} type="button" disabled={busy} onClick={onUseDemo}>
            <Play aria-hidden="true" size={13} /> Try the demo
          </button>
        </header>

        <div className={styles.liveEntryGrid}>
          <div className={styles.liveEntryCopy}>
            <span className={styles.eyebrow}><Sparkles aria-hidden="true" size={13} /> Evidence, compiled</span>
            <h1>What should we test?</h1>
            <p>Turn a real question into an evidence-bound decision.</p>
          </div>

          <form className={styles.liveEntryForm} onSubmit={submit}>
            <div className={styles.formMeta}><span>New investigation</span><span><i /> Private session</span></div>
            <p className={styles.liveEntryNotice}>Runs are process-local and may expire or disappear when the server restarts. Export important results.</p>
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
              {busy ? <><LoaderCircle aria-hidden="true" size={16} /> {state === "creating" ? "Creating private run…" : "Shaping claims…"}</> : <>Start research <ArrowRight aria-hidden="true" size={16} /></>}
            </button>
          </form>
          <div className={styles.liveEntrySignal} aria-hidden="true"><i /><i /><i /><span /></div>
        </div>
      </section>
      <ProviderOnboarding />
    </main>
  );
}
