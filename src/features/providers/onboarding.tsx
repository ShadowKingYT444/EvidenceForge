"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";

import { providerIds, providerMeta, providerProtocol, type ProviderId } from "./catalog";

type Result =
  | { ok: true; provider: ProviderId; model: string; latencyMs: number; evidenceMode: "live" }
  | { ok: false; error?: { code?: string; message?: string } };

export function ProviderOnboarding() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !selected || dialog.open) return;
    dialog.showModal();
    window.requestAnimationFrame(() => keyRef.current?.focus());
  }, [selected]);

  function closeDialog() {
    dialogRef.current?.close();
  }

  function openProvider(provider: ProviderId, event: MouseEvent<HTMLButtonElement>) {
    triggerRef.current = event.currentTarget;
    setSelected(provider);
    setModel(providerMeta[provider].model);
    setApiKey("");
    setReveal(false);
    setStatus("idle");
    setMessage("");
  }

  function handleClose() {
    setSelected(null);
    setApiKey("");
    setModel("");
    setReveal(false);
    setStatus("idle");
    setMessage("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || status === "loading") return;
    setStatus("loading");
    setMessage("");
    try {
      const response = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: selected, model, apiKey }),
      });
      const result = (await response.json()) as Result;
      if (result.ok) {
        setApiKey("");
        setStatus("success");
        setMessage(`Connection verified · ${result.latencyMs} ms`);
      } else {
        setStatus("error");
        setMessage(result.error?.message ?? "The provider connection could not be completed.");
      }
    } catch {
      setStatus("error");
      setMessage("The provider connection could not be completed.");
    }
  }

  return (
    <main className="provider-shell">
      <header className="provider-header">
        <Link className="provider-brand" href="/" aria-label="EvidenceForge home">
          <span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span>
          <span>EvidenceForge</span>
        </Link>
        <span className="provider-header-note">Session setup</span>
      </header>

      <section className="provider-hero" aria-labelledby="connect-title">
        <div className="provider-hero-copy">
          <p className="provider-eyebrow">Model workspace</p>
          <h1 id="connect-title">Connect a model provider</h1>
          <p className="provider-lede">Choose a provider to power this session.</p>
        </div>
        <div className="provider-security-note" aria-label="Credential handling">
          <span className="security-dot" aria-hidden="true" />
          <span>Keys are used once and never saved.</span>
        </div>
      </section>

      <section className="provider-grid" aria-label="Model providers">
        {providerIds.map((provider) => {
          const meta = providerMeta[provider];
          return (
            <button
              className="provider-card"
              data-provider={provider}
              key={provider}
              onClick={(event) => openProvider(provider, event)}
              type="button"
            >
              <span className={`provider-mark provider-mark-${provider}`} aria-hidden="true">{meta.mark}</span>
              <span className="provider-card-copy">
                <strong>{meta.short}</strong>
                <small>{providerProtocol[provider]}</small>
              </span>
              <span className="provider-arrow" aria-hidden="true">↗</span>
            </button>
          );
        })}
      </section>

      <footer className="provider-footer">
        <Link className="fixture-link" href="/intake?demo=golden">
          <span className="fixture-icon" aria-hidden="true">✦</span>
          Use recorded fixture
        </Link>
        <span className="fixture-caption">No credentials needed</span>
      </footer>
      <dialog
        className="provider-dialog"
        ref={dialogRef}
        aria-labelledby="provider-dialog-title"
        onClose={handleClose}
      >
        {selected ? (
          <form onSubmit={verify}>
            <div className="dialog-topline">
              <div className="dialog-provider-heading">
                <span className={`provider-mark provider-mark-${selected}`} aria-hidden="true">{providerMeta[selected].mark}</span>
                <div><p className="dialog-kicker">Connect</p><h2 id="provider-dialog-title">{providerMeta[selected].short}</h2></div>
              </div>
              <button className="dialog-close" type="button" onClick={closeDialog} aria-label="Close provider dialog">×</button>
            </div>
            <div className="dialog-fields">
              <label htmlFor="provider-model">Model ID</label>
              <input id="provider-model" value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} required />
              <label htmlFor="provider-key">API key</label>
              <div className="key-field">
                <input ref={keyRef} id="provider-key" type={reveal ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} required aria-describedby="provider-key-note" />
                <button type="button" className="reveal-key" onClick={() => setReveal((value) => !value)} aria-pressed={reveal}>{reveal ? "Hide" : "Show"}</button>
              </div>
              <p id="provider-key-note" className="dialog-note">Used for one connection check, then cleared.</p>
            </div>
            <div className="dialog-actions">
              <button className="dialog-secondary" type="button" onClick={closeDialog}>Cancel</button>
              <button className="dialog-primary" type="submit" disabled={status === "loading"}>{status === "loading" ? "Checking…" : "Verify key"}</button>
            </div>
            <div className={`connection-status status-${status}`} role={status === "error" ? "alert" : "status"} aria-live="polite">
              {status === "success" ? <><span aria-hidden="true">✓</span> {message}</> : status === "error" ? <><span aria-hidden="true">!</span> {message}</> : status === "loading" ? "Sending one bounded check…" : ""}
            </div>
          </form>
        ) : null}
      </dialog>
    </main>
  );
}
