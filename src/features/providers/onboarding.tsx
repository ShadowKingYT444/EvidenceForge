"use client";

import { Check, KeyRound, LoaderCircle, LockKeyhole, Search, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { providerIds, providerMeta, type ProviderId } from "./catalog";

type Props = { ownerDemo: boolean; error?: string; onChanged: () => void };
type DiagnosticResponse = {
  ok?: boolean;
  error?: { message?: string };
  diagnostics?: Record<string, { ok?: boolean; code?: string | null; latencyMs?: number }>;
};

export function ProviderOnboarding({ ownerDemo, error: gateError, onChanged }: Props) {
  const [primaryProvider, setPrimaryProvider] = useState<ProviderId>("openai");
  const [primaryModel, setPrimaryModel] = useState(providerMeta.openai.model);
  const [primaryKey, setPrimaryKey] = useState("");
  const [separateReviewer, setSeparateReviewer] = useState(false);
  const [reviewerProvider, setReviewerProvider] = useState<ProviderId>("anthropic");
  const [reviewerModel, setReviewerModel] = useState(providerMeta.anthropic.model);
  const [reviewerKey, setReviewerKey] = useState("");
  const [openAlexKey, setOpenAlexKey] = useState("");
  const [firecrawlKey, setFirecrawlKey] = useState("");
  const [ownerSecret, setOwnerSecret] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "error">("idle");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticResponse["diagnostics"]>();

  function choosePrimary(provider: ProviderId) {
    setPrimaryProvider(provider);
    setPrimaryModel(providerMeta[provider].model);
  }
  function chooseReviewer(provider: ProviderId) {
    setReviewerProvider(provider);
    setReviewerModel(providerMeta[provider].model);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("checking");
    setMessage("");
    setDiagnostics(undefined);
    try {
      const response = await fetch("/api/session/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primary: { provider: primaryProvider, model: primaryModel.trim(), apiKey: primaryKey },
          ...(separateReviewer ? { reviewer: { provider: reviewerProvider, model: reviewerModel.trim(), apiKey: reviewerKey } } : {}),
          openAlexApiKey: openAlexKey,
          firecrawlApiKey: firecrawlKey,
        }),
      });
      const result = await response.json().catch(() => ({})) as DiagnosticResponse;
      setDiagnostics(result.diagnostics);
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? "The credential checks did not pass.");
      setPrimaryKey("");
      setReviewerKey("");
      setOpenAlexKey("");
      setFirecrawlKey("");
      onChanged();
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "The credential checks did not pass.");
    }
  }

  async function unlockOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/session/owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerSecret }) });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: { message?: string } };
    setOwnerSecret("");
    if (!response.ok || !result.ok) {
      setMessage(result.error?.message ?? "Owner access was not accepted.");
      setStatus("error");
      return;
    }
    onChanged();
  }

  return (
    <main className="provider-shell credential-gate">
      <header className="provider-header">
        <span className="provider-brand"><span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span>EvidenceForge</span>
        <span className="provider-header-note">Private session setup</span>
      </header>
      <section className="credential-hero">
        <div>
          <p className="provider-eyebrow">Bring your own research stack</p>
          <h1>Connect evidence to a model you trust.</h1>
          <p>Keys stay in server memory for this session. They are never written to the browser, logs, or repository.</p>
        </div>
        <div className="credential-security"><ShieldCheck size={17} /><strong>Server-only</strong><span>Process-local and automatically expires.</span></div>
      </section>
      <form className="credential-form" onSubmit={connect}>
        <section className="credential-section">
          <div className="credential-section-title"><KeyRound size={17} /><div><span>01</span><h2>Research model</h2><p>Choose any supported provider protocol and enter the exact model ID.</p></div></div>
          <div className="credential-fields">
            <label>Provider<select aria-label="Research provider" value={primaryProvider} onChange={(event) => choosePrimary(event.target.value as ProviderId)}>{providerIds.map((provider) => <option key={provider} value={provider}>{providerMeta[provider].short}</option>)}</select></label>
            <label>Model ID<input aria-label="Research model ID" value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} required spellCheck={false} /></label>
            <label className="credential-key-field">API key<input aria-label="Research provider API key" type="password" value={primaryKey} onChange={(event) => setPrimaryKey(event.target.value)} required autoComplete="off" /></label>
          </div>
          <label className="credential-toggle"><input type="checkbox" checked={separateReviewer} onChange={(event) => setSeparateReviewer(event.target.checked)} /> Use a separate model for independent review</label>
          {separateReviewer ? <div className="credential-fields credential-reviewer">
            <label>Reviewer provider<select aria-label="Reviewer provider" value={reviewerProvider} onChange={(event) => chooseReviewer(event.target.value as ProviderId)}>{providerIds.map((provider) => <option key={provider} value={provider}>{providerMeta[provider].short}</option>)}</select></label>
            <label>Reviewer model ID<input aria-label="Reviewer model ID" value={reviewerModel} onChange={(event) => setReviewerModel(event.target.value)} required spellCheck={false} /></label>
            <label className="credential-key-field">Reviewer API key<input aria-label="Reviewer provider API key" type="password" value={reviewerKey} onChange={(event) => setReviewerKey(event.target.value)} required autoComplete="off" /></label>
          </div> : null}
        </section>
        <section className="credential-section">
          <div className="credential-section-title"><Search size={17} /><div><span>02</span><h2>Evidence retrieval</h2><p>OpenAlex finds scholarly records; Firecrawl discovers and extracts licensed web evidence.</p></div></div>
          <div className="credential-fields credential-retrieval">
            <label>OpenAlex API key<input aria-label="OpenAlex API key" type="password" value={openAlexKey} onChange={(event) => setOpenAlexKey(event.target.value)} required autoComplete="off" /></label>
            <label>Firecrawl API key<input aria-label="Firecrawl API key" type="password" value={firecrawlKey} onChange={(event) => setFirecrawlKey(event.target.value)} required autoComplete="off" /></label>
          </div>
        </section>
        {gateError || message ? <p className="credential-error" role="alert">{message || gateError}</p> : null}
        {diagnostics ? <div className="credential-diagnostics" aria-label="Credential diagnostics">{Object.entries(diagnostics).map(([name, result]) => <span key={name} data-ok={result.ok}><Check size={12} />{name}{result.latencyMs !== undefined ? ` ${result.latencyMs} ms` : result.code ? ` ${result.code}` : ""}</span>)}</div> : null}
        <button className="credential-submit" type="submit" disabled={status === "checking"}>{status === "checking" ? <><LoaderCircle size={16} /> Checking four connections...</> : <>Verify and enter EvidenceForge</>}</button>
      </form>
      <aside className="owner-access">
        {ownerDemo ? <p><LockKeyhole size={14} /> Administrative access unlocked.</p> : <details><summary>Administrative access</summary><form onSubmit={unlockOwner}><label>Owner passphrase<input aria-label="Owner passphrase" type="password" value={ownerSecret} onChange={(event) => setOwnerSecret(event.target.value)} autoComplete="off" required /></label><button type="submit">Unlock</button></form></details>}
      </aside>
    </main>
  );
}
