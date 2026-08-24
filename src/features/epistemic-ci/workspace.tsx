"use client";

import { Activity, GitPullRequest, Hammer, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  authorizeReview,
  compileChanges,
  downloadCanonicalReceipt,
  EpistemicApiError,
  loadDemo,
} from "./api-client";
import { CompileMode } from "./compile-mode";
import type {
  ChangeId,
  DemoResponse,
  EpistemicBuild,
  ReviewResponse,
} from "./contracts";
import { DependencyGraph } from "./dependency-graph";
import { PerturbMode } from "./perturb-mode";
import { BusyState, FailureState, shortHash } from "./primitives";
import { ReviewMode } from "./review-mode";
import { LiveResearchEntry } from "./live-research-entry";
import styles from "./workspace.module.css";

type WorkspaceMode = "compile" | "perturb" | "review";
type RetryRequest =
  | { type: "demo" }
  | { type: "compile"; changeIds: ChangeId[]; label: string }
  | { type: "review"; actor: string; rationale: string }
  | { type: "export" };

const modeLabels: Array<{ id: WorkspaceMode; label: string; icon: typeof Hammer }> = [
  { id: "compile", label: "Compile", icon: Hammer },
  { id: "perturb", label: "Perturb", icon: Activity },
  { id: "review", label: "Review", icon: GitPullRequest },
];

function errorMessage(error: unknown): { title: string; message: string; stale: boolean } {
  if (error instanceof EpistemicApiError) {
    return {
      title: error.status === 409 ? "Build is stale" : error.code === "INVALID_PROJECTION" ? "Invalid server projection" : "Build request failed",
      message: error.message,
      stale: error.status === 409,
    };
  }
  return { title: "Unexpected workspace error", message: "The deterministic demo could not continue.", stale: false };
}

export function EpistemicCiWorkspace({ ownerDemo = false }: { ownerDemo?: boolean }) {
  const [demo, setDemo] = useState<DemoResponse | null>(null);
  const [build, setBuild] = useState<EpistemicBuild | null>(null);
  const [appliedChangeIds, setAppliedChangeIds] = useState<ChangeId[]>([]);
  const [mode, setMode] = useState<WorkspaceMode>("compile");
  const [compiled, setCompiled] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message: string; stale: boolean } | null>(null);
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const resetDemo = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setBusyLabel("Loading immutable fixture build…");
    setError(null);
    setRetryRequest(null);
    setReview(null);
    setMode("compile");
    setCompiled(false);
    setAppliedChangeIds([]);
    try {
      const next = await loadDemo(controller.signal);
      setDemo(next);
      setBuild(next.baseBuild);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(errorMessage(caught));
      setRetryRequest({ type: "demo" });
    } finally {
      if (!controller.signal.aborted) setBusyLabel(null);
    }
  }, []);

  async function compile(nextIds: ChangeId[], label: string) {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setBusyLabel(label);
    setError(null);
    setRetryRequest(null);
    setReview(null);
    try {
      const nextBuild = await compileChanges(nextIds, controller.signal);
      setBuild(nextBuild);
      setAppliedChangeIds(nextIds);
      setCompiled(true);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(errorMessage(caught));
      setRetryRequest({ type: "compile", changeIds: nextIds, label });
    } finally {
      if (!controller.signal.aborted) setBusyLabel(null);
    }
  }

  async function authorize(actor: string, rationale: string) {
    if (!build) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setBusyLabel("Recompiling and sealing the Research PR receipt…");
    setError(null);
    setRetryRequest(null);
    try {
      const result = await authorizeReview({
        appliedChangeIds,
        expectedGraphHash: build.graphHash,
        declaredActor: actor,
        rationale,
        signal: controller.signal,
      });
      setReview(result);
      setBuild(result.build);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(errorMessage(caught));
      setRetryRequest({ type: "review", actor, rationale });
    } finally {
      if (!controller.signal.aborted) setBusyLabel(null);
    }
  }

  const changes = useMemo(() => demo?.changes ?? [], [demo]);

  function retryLastRequest() {
    if (!retryRequest || retryRequest.type === "demo") {
      void resetDemo();
    } else if (retryRequest.type === "compile") {
      void compile(retryRequest.changeIds, retryRequest.label);
    } else if (retryRequest.type === "review") {
      void authorize(retryRequest.actor, retryRequest.rationale);
    } else if (review) {
      downloadReceipt();
    }
  }

  function downloadReceipt() {
    try {
      if (!review) throw new Error("receipt unavailable");
      downloadCanonicalReceipt(review);
      setError(null);
      setRetryRequest(null);
    } catch {
      setError({ title: "Export failed", message: "The receipt is preserved. Try downloading it again.", stale: false });
      setRetryRequest({ type: "export" });
    }
  }

  if (!demo || !build) {
    if (!busyLabel && !error) return <LiveResearchEntry ownerDemo={ownerDemo} onUseDemo={ownerDemo ? () => void resetDemo() : undefined} />;
    return (
      <main className={styles.workspace}>
        <div className={styles.centerState}>
          {error ? <FailureState title={error.title} message={error.message} onRetry={() => void resetDemo()} /> : <BusyState>{busyLabel ?? "Loading Epistemic CI…"}</BusyState>}
        </div>
      </main>
    );
  }

  const canPerturb = compiled;
  const canReview = appliedChangeIds.length === changes.length;
  return (
    <main className={styles.workspace}>
      <a className={styles.skipLink} href="#workspace-mode-content">Skip to workspace</a>
      <header className={styles.workspaceHeader}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <div><strong>EvidenceForge</strong><span>Epistemic CI</span></div>
        </div>
        <div className={styles.headerMeta}>
          <span><i /> Deterministic fixture</span>
          <span>Software Development</span>
          <code>{shortHash(build.fixtureHash)}</code>
        </div>
      </header>
      <div className={styles.workspaceBody}>
        <section className={styles.workspaceIntro}>
          <div><span className={styles.eyebrow}>Continuous integration for evidence-backed decisions</span><h1>When evidence changes, conclusions should fail their build.</h1></div>
          <p>{demo.disclosure} The canonical packet remains immutable; every change below is a branch proposal.</p>
        </section>
        <nav className={styles.modeNav} aria-label="Epistemic CI workspace modes">
          {modeLabels.map(({ id, label, icon: Icon }, index) => {
            const disabled = id === "perturb" ? !canPerturb : id === "review" ? !canReview : false;
            return (
              <button
                key={id}
                type="button"
                aria-current={mode === id ? "step" : undefined}
                disabled={disabled}
                aria-label={disabled ? `${label} mode locked until the prior build step is complete` : `${label} mode`}
                onClick={() => setMode(id)}
              >
                <span>{index + 1}</span><Icon aria-hidden="true" size={15} /><strong>{label}</strong>
              </button>
            );
          })}
          <button className={styles.resetButton} type="button" onClick={() => void resetDemo()}><RotateCcw aria-hidden="true" size={14} /> Reset demo</button>
        </nav>
        {busyLabel ? <BusyState>{busyLabel}</BusyState> : null}
        {error ? <FailureState title={error.title} message={error.message} retryLabel={error.stale ? "Reload immutable base" : "Retry request"} onRetry={error.stale ? () => void resetDemo() : retryLastRequest} /> : null}
        <div id="workspace-mode-content" tabIndex={-1}>
          {mode === "compile" ? (
            <CompileMode build={build} compiled={compiled} busy={Boolean(busyLabel)} onCompile={() => void compile([], "Compiling stable dependencies…")} onContinue={() => setMode("perturb")} />
          ) : mode === "perturb" ? (
            <PerturbMode
              build={build}
              changes={changes}
              appliedChangeIds={appliedChangeIds}
              busy={Boolean(busyLabel)}
              onApply={(id) => void compile([...appliedChangeIds, id], `Applying ${id.replaceAll("-", " ")}…`)}
              onReset={() => void compile([], "Resetting branch to the base build…")}
              onReview={() => setMode("review")}
            />
          ) : (
            <ReviewMode build={build} review={review} busy={Boolean(busyLabel)} onAuthorize={(actor, rationale) => void authorize(actor, rationale)} onDownload={downloadReceipt} />
          )}
        </div>
        <DependencyGraph build={build} />
      </div>
      <footer className={styles.workspaceFooter}><span>Session-scoped hashed build lineage</span><span>Refresh returns to immutable base</span><span>No database · no live provider</span></footer>
    </main>
  );
}
