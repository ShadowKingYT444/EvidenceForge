"use client";

import { ArrowLeft, ArrowRight, CircleHelp, Plus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type FormState = { question: string; application: string; population: string; horizon: string; constraints: string; claims: string[] };
type ApiSnapshot = { run?: { id?: string }; id?: string; revision?: string; snapshot?: { run?: { id?: string }; revision?: string } };
type IntakeStep = "brief" | "claims";

const blankInitial: FormState = { question: "", application: "", population: "", horizon: "", constraints: "", claims: [""] };
const aiReliabilityInitial: FormState = {
  question: "Does retrieval-augmented generation reduce factual hallucination in knowledge-grounded language generation compared with the same model without retrieval?",
  application: "Choose an evidence-grounding architecture for a domain-specific research question-answering assistant.",
  population: "Knowledge-grounded language generation and question-answering systems",
  horizon: "2020–present",
  constraints: "Prioritize empirical comparisons and record limitations caused by retrieval quality, task differences, and evaluator design.",
  claims: ["Retrieval augmentation reduces unsupported factual claims compared with an otherwise comparable non-retrieval model."],
};

function responseRun(data: ApiSnapshot): { id: string; revision: string } | null {
  const source = data.snapshot ?? data;
  const id = source.run?.id ?? data.run?.id ?? data.id;
  const revision = source.revision ?? data.revision;
  return id && revision ? { id, revision } : null;
}

export function LiveIntake({ example = false }: { example?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<IntakeStep>("brief");
  const [form, setForm] = useState<FormState>(example ? aiReliabilityInitial : blankInitial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "starting" | "decomposing" | "error">("idle");
  const [error, setError] = useState("");

  const update = (key: keyof FormState, value: string | string[]) => setForm((current) => ({ ...current, [key]: value }));
  const updateClaim = (index: number, value: string) => update("claims", form.claims.map((claim, claimIndex) => claimIndex === index ? value : claim));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};

    if (!form.question.trim()) nextErrors.question = "Enter the question this investigation should answer.";
    if (!form.application.trim()) nextErrors.application = "Describe the decision that depends on the answer.";

    if (step === "brief") {
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) setStep("claims");
      return;
    }

    const claims = form.claims.map((claim) => claim.trim()).filter(Boolean);
    if (claims.length < 1) nextErrors.claims = "Add at least one claim to test.";
    if (claims.length > 3) nextErrors.claims = "Keep the first pass to three claims or fewer.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setState("starting");
    setError("");
    try {
      const intake = {
        originalQuestion: form.question.trim(),
        intendedApplication: form.application.trim(),
        populationOrGeography: form.population.trim() || "Not specified yet",
        timeHorizon: form.horizon.trim() || "Not specified yet",
        availableMaterialsOrBudget: "Not specified yet",
        desiredDepth: "Evidence packet with source-level provenance",
        constraints: [form.constraints.trim(), ...claims.map((claim) => `Seed claim: ${claim}`)].filter(Boolean),
        unansweredClarifications: [],
      };
      const created = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: null, intake }) });
      const data = await created.json().catch(() => ({})) as ApiSnapshot & { error?: { message?: string }; message?: string };
      if (!created.ok) throw new Error(data.error?.message ?? data.message ?? "We couldn't create the investigation.");
      const run = responseRun(data);
      if (!run) throw new Error("The investigation was created, but its run link was missing. Please try again.");
      setState("decomposing");
      const continued = await fetch(`/api/runs/${encodeURIComponent(run.id)}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: run.revision }) });
      if (!continued.ok) {
        const continuationError = await continued.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
        throw new Error(continuationError.error?.message ?? continuationError.message ?? "The claim analysis could not start.");
      }
      router.push(`/runs/${encodeURIComponent(run.id)}`);
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
    }
  }

  const busy = state === "starting" || state === "decomposing";

  return (
    <main className="research-intake">
      <header className="research-intake-header"><Link href="/" className="research-back"><ArrowLeft size={15} /> EvidenceForge</Link><span>Step {step === "brief" ? "1" : "2"} of 2</span></header>
      <div className="research-intake-wrap">
        <div className="research-intake-progress" aria-hidden="true"><i data-active="true" /><i data-active={step === "claims"} /></div>
        <div className="research-intake-heading">
          <p className="research-kicker"><Sparkles size={14} /> {step === "brief" ? "Research brief" : "Claim boundary"}</p>
          <h1>{step === "brief" ? "Frame the decision." : "Check the claims."}</h1>
          <p>{step === "brief" ? "Start with the question and the choice it should inform." : "Keep the first pass focused: one to three claims."}</p>
        </div>

        <form className="research-intake-form" onSubmit={submit} noValidate>
          {step === "brief" ? <>
            <div className="research-field research-field-wide"><label htmlFor="question">Research question</label><textarea id="question" rows={4} value={form.question} onChange={(event) => update("question", event.target.value)} placeholder="What do you need to find out?" aria-invalid={Boolean(errors.question)} />{errors.question ? <small className="research-field-error">{errors.question}</small> : null}</div>
            <div className="research-field research-field-wide"><label htmlFor="application">Decision this will inform</label><textarea id="application" rows={3} value={form.application} onChange={(event) => update("application", event.target.value)} placeholder="What will you choose, change, or build?" aria-invalid={Boolean(errors.application)} />{errors.application ? <small className="research-field-error">{errors.application}</small> : null}</div>
            <details className="research-intake-optional research-field-wide"><summary>Add scope boundaries <span>Optional</span></summary><div className="research-intake-optional-grid"><div className="research-field"><label htmlFor="population">Population or context</label><input id="population" value={form.population} onChange={(event) => update("population", event.target.value)} placeholder="Who or where?" /></div><div className="research-field"><label htmlFor="horizon">Time horizon</label><input id="horizon" value={form.horizon} onChange={(event) => update("horizon", event.target.value)} placeholder="For example, 2020–present" /></div><div className="research-field research-field-wide"><label htmlFor="constraints">Constraints</label><textarea id="constraints" rows={2} value={form.constraints} onChange={(event) => update("constraints", event.target.value)} placeholder="What should the investigation include or avoid?" /></div></div></details>
          </> : <>
            <div className="research-intake-question-summary research-field-wide"><span>Research question</span><p>{form.question}</p><button type="button" onClick={() => setStep("brief")}>Edit brief</button></div>
            <fieldset className="research-claims research-field-wide"><legend>Claims to test <span>1–3</span></legend>{form.claims.map((claim, index) => <div className="research-claim-row" key={index}><label htmlFor={`claim-${index}`} className="sr-only">Claim {index + 1}</label><input id={`claim-${index}`} value={claim} onChange={(event) => updateClaim(index, event.target.value)} placeholder={`Claim ${index + 1} — a statement that may be true`} />{form.claims.length > 1 ? <button type="button" aria-label={`Remove claim ${index + 1}`} className="research-icon-button" onClick={() => update("claims", form.claims.filter((_, claimIndex) => claimIndex !== index))}><Trash2 size={15} /></button> : null}</div>)}{form.claims.length < 3 ? <button type="button" className="research-add-claim" onClick={() => update("claims", [...form.claims, ""])}><Plus size={15} /> Add claim</button> : null}{errors.claims ? <small className="research-field-error">{errors.claims}</small> : null}</fieldset>
          </>}

          {state === "error" ? <div className="research-intake-error" role="alert"><CircleHelp size={18} /><div><strong>Investigation could not start.</strong><p>{error}</p><button type="button" onClick={() => setState("idle")}>Review and try again</button></div></div> : null}
          <div className="research-intake-submit">
            {step === "claims" ? <button type="button" className="research-button research-button-secondary" onClick={() => setStep("brief")}>Back</button> : <span />}
            <button className="research-button research-button-primary" disabled={busy}>{busy ? state === "starting" ? "Creating investigation…" : "Shaping claims…" : <>{step === "brief" ? "Continue" : "Begin investigation"} <ArrowRight size={17} /></>}</button>
          </div>
        </form>
      </div>
    </main>
  );
}
