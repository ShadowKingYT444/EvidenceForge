"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { ResearchRun } from "../../contracts";
import {
  FINAL_ACTOR_AUTHORITY,
  FINAL_SESSION_RESET_NOTICE,
  inspectStoredTerminal,
  startFixtureWorkbenchSession,
  submitFinalDecision,
  type FinalDecisionChoice,
  type VerifiedTerminal,
} from "./final-decision-actions";
import styles from "./final-decision-panel.module.css";

export type FinalDecisionPanelModel =
  | { kind: "recorded"; run: ResearchRun }
  | { kind: "unavailable"; run: ResearchRun }
  | {
      kind: "process_local";
      run: ResearchRun;
      revision: string;
    };

type FinalDecisionPresentation = {
  state: string;
  decision: string | null;
};

type StatusMessage = {
  tone: "error" | "success" | "warning";
  heading: string;
  message: string;
};

function unresolvedRisks(run: ResearchRun) {
  const objections = new Map(
    (run.review?.objections ?? []).map((objection) => [objection.id, objection]),
  );
  return (run.revision?.decisions ?? [])
    .filter(({ disposition }) => disposition === "unresolved")
    .map((decision) => ({
      id: decision.objectionId,
      targetField: objections.get(decision.objectionId)?.targetField ?? "Unspecified field",
      rationale:
        objections.get(decision.objectionId)?.rationale ??
        "The reviewer rationale is unavailable.",
      residualRisk: decision.residualRisk,
    }));
}

function Receipt({ terminal }: { terminal: VerifiedTerminal }) {
  const { receipt, run } = terminal;
  return (
    <div className={styles.receipt} data-testid="final-decision-receipt">
      <div>
        <span>Canonical outcome</span>
        <strong>{receipt.decision === "approve" ? "Approved" : "Rejected"}</strong>
      </div>
      <div>
        <span>Declared actor · unverified</span>
        <strong>{receipt.declaredActor}</strong>
      </div>
      <div>
        <span>Server decision ID</span>
        <code>{receipt.id}</code>
      </div>
      <div>
        <span>Server timestamp</span>
        <time dateTime={receipt.decidedAt}>{receipt.decidedAt}</time>
      </div>
      <div className={styles.rationale}>
        <span>Human rationale</span>
        <p>{receipt.rationale}</p>
      </div>
      <a
        className={styles.export}
        href={`/api/runs/${encodeURIComponent(run.id)}/export`}
        download={`${run.id}.json`}
      >
        Download canonical JSON
      </a>
    </div>
  );
}

export function FinalDecisionPanel({
  model,
  presentation,
}: {
  model: FinalDecisionPanelModel;
  presentation: FinalDecisionPresentation;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [choice, setChoice] = useState<FinalDecisionChoice | null>(null);
  const [declaredActor, setDeclaredActor] = useState("");
  const [rationale, setRationale] = useState("");
  const [activeRun, setActiveRun] = useState(model.run);
  const [activeRevision, setActiveRevision] = useState(
    model.kind === "process_local" ? model.revision : "",
  );
  const [terminal, setTerminal] = useState<VerifiedTerminal | null>(() =>
    model.kind === "process_local"
      ? inspectStoredTerminal(model.run, model.revision)
      : null,
  );
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const choiceRef = useRef<HTMLInputElement>(null);
  const actorRef = useRef<HTMLInputElement>(null);
  const rationaleRef = useRef<HTMLTextAreaElement>(null);
  const focusTargetRef = useRef<
    "choice" | "declaredActor" | "rationale" | null
  >(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const startStatusRef = useRef<HTMLDivElement>(null);
  const risks = useMemo(() => unresolvedRisks(activeRun), [activeRun]);

  useEffect(() => {
    const focusTarget = focusTargetRef.current;
    if (submitting || focusTarget === null) return;
    focusTargetRef.current = null;
    const fieldRef =
      focusTarget === "choice"
        ? choiceRef
        : focusTarget === "declaredActor"
          ? actorRef
          : rationaleRef;
    fieldRef.current?.focus();
  }, [submitting]);

  async function startSession() {
    setStarting(true);
    setStatus(null);
    const result = await startFixtureWorkbenchSession();
    setStarting(false);
    if (result.ok) {
      router.push(`/workbench?runId=${encodeURIComponent(result.session.runId)}`);
      return;
    }
    setStatus({
      tone: "error",
      heading: "Session not started",
      message: result.message,
    });
    queueMicrotask(() => startStatusRef.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    setSubmitting(true);
    const result = await submitFinalDecision({
      runId: activeRun.id,
      expectedRevision: activeRevision,
      priorSnapshot: activeRun,
      choice,
      declaredActor,
      rationale,
    });
    setSubmitting(false);

    if (result.ok) {
      setTerminal({
        run: result.run,
        revision: result.revision,
        receipt: result.receipt,
      });
      setActiveRun(result.run);
      setActiveRevision(result.revision);
      setStatus({
        tone: "success",
        heading: "Final decision persisted",
        message: result.message,
      });
      queueMicrotask(() => statusRef.current?.focus());
      router.refresh();
      return;
    }

    if (result.code === "input_required" && result.fields?.length) {
      focusTargetRef.current = result.fields[0];
    }
    if (result.latest) {
      setActiveRun(result.latest.run);
      setActiveRevision(result.latest.revision);
    }
    if (result.terminal) {
      setTerminal(result.terminal);
      setActiveRun(result.terminal.run);
      setActiveRevision(result.terminal.revision);
    }
    setStatus({
      tone: result.code === "already_decided" ? "warning" : "error",
      heading:
        result.code === "already_decided"
          ? "A decision was already recorded"
          : result.code === "session_reset"
            ? "Session reset"
            : "Final decision not persisted",
      message: result.message,
    });
    if (result.code !== "input_required") {
      requestAnimationFrame(() => statusRef.current?.focus());
    }
    if (result.terminal) router.refresh();
  }

  const isRecorded = model.kind === "recorded";
  const isUnavailable = model.kind === "unavailable";
  const recordedHeading =
    presentation.state === "approved" || presentation.state === "rejected"
      ? `Decision recorded · ${presentation.decision}`
      : presentation.state === "failed"
        ? "No final approval recorded"
        : "Final decision pending";
  const modeLabel = isRecorded
    ? "Fixture · recorded read-only"
    : isUnavailable
      ? "Fixture · session reset"
      : "Fixture · process-local";

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <div>
          <span className={styles.index}>08 · Final decision</span>
          <h2 id="final-decision-title">
            {terminal
              ? `Decision recorded · ${terminal.receipt.decision}`
              : isUnavailable
                ? "Process-local session unavailable"
                : isRecorded
                  ? recordedHeading
                  : "Final decision required"}
          </h2>
        </div>
        <span className={styles.mode}>{modeLabel}</span>
      </div>

      <div className={styles.risks} aria-labelledby="unresolved-risk-title">
        <strong id="unresolved-risk-title">
          {risks.length} unresolved {risks.length === 1 ? "risk" : "risks"}
        </strong>
        {risks.length ? (
          <ul>
            {risks.map((risk) => (
              <li key={risk.id}>
                <span>{risk.targetField}</span>
                <p>{risk.rationale}</p>
                <small>Residual risk · {risk.residualRisk}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No unresolved objection is recorded for this run.</p>
        )}
      </div>

      {isRecorded || isUnavailable ? (
        <div className={styles.start}>
          <p>
            {isUnavailable
              ? FINAL_SESSION_RESET_NOTICE
              : "This shell displays the recorded decision; it does not replay or fabricate approval. Start a new isolated session to make a truthful final decision."}
          </p>
          <button type="button" disabled={starting} onClick={() => void startSession()}>
            {starting ? "Starting isolated session…" : "Start isolated final review"}
          </button>
        </div>
      ) : terminal ? (
        <Receipt terminal={terminal} />
      ) : (
        <form
          className={styles.form}
          aria-busy={submitting}
          onSubmit={(event) => void submit(event)}
        >
          <fieldset disabled={submitting}>
            <legend>Choose the final outcome</legend>
            <label>
              <input
                ref={choiceRef}
                type="radio"
                name="final-choice"
                value="approve"
                checked={choice === "approve"}
                onChange={() => setChoice("approve")}
              />
              <span>
                <strong>Approve</strong>
                <small>Approve only this bounded, reviewable proposal.</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="final-choice"
                value="reject"
                checked={choice === "reject"}
                onChange={() => setChoice("reject")}
              />
              <span>
                <strong>Reject</strong>
                <small>Reject without implying downstream success.</small>
              </span>
            </label>
          </fieldset>
          <label className={styles.field}>
            <span>Declared actor</span>
            <input
              ref={actorRef}
              value={declaredActor}
              maxLength={80}
              disabled={submitting}
              aria-describedby="declared-actor-note"
              onChange={(event) => setDeclaredActor(event.target.value)}
            />
            <small id="declared-actor-note">Declared and unverified · 80 characters maximum</small>
          </label>
          <label className={styles.field}>
            <span>Decision rationale</span>
            <textarea
              ref={rationaleRef}
              value={rationale}
              maxLength={2_000}
              rows={3}
              disabled={submitting}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <button className={styles.submit} type="submit" disabled={submitting}>
            {submitting ? "Persisting decision…" : "Persist final decision"}
          </button>
          {submitting ? (
            <span className={styles.revision} role="status" aria-live="polite">
              Persisting final decision. Form controls are temporarily locked.
            </span>
          ) : (
            <small className={styles.revision}>Current revision · {activeRevision}</small>
          )}
        </form>
      )}

      <div className={styles.disclosure}>
        <span>{FINAL_ACTOR_AUTHORITY}</span>
        <span>{FINAL_SESSION_RESET_NOTICE}</span>
      </div>

      {status ? (
        <div
          className={styles.status}
          data-tone={status.tone}
          role={status.tone === "success" ? "status" : "alert"}
          ref={isRecorded || isUnavailable ? startStatusRef : statusRef}
          tabIndex={-1}
        >
          <strong>{status.heading}</strong>
          <p>{status.message}</p>
        </div>
      ) : null}
    </div>
  );
}
