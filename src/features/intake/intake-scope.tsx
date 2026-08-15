"use client";

import Link from "next/link";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useFocusBoundary } from "../use-focus-boundary";
import {
  createEmptyIntake,
  hasValidationErrors,
  type IntakeClaim,
  type IntakeDraft,
  type IntakeValidation,
  validateIntake,
} from "./intake-state";
import styles from "./intake-scope.module.css";

type IntakeScopeProps = {
  goldenDraft: IntakeDraft;
  startWithGolden?: boolean;
};

const emptyValidation: IntakeValidation = {
  claimFields: {},
};

export function IntakeScope({
  goldenDraft,
  startWithGolden = false,
}: IntakeScopeProps) {
  const [draft, setDraft] = useState<IntakeDraft>(() =>
    startWithGolden ? structuredClone(goldenDraft) : createEmptyIntake(),
  );
  const [validation, setValidation] =
    useState<IntakeValidation>(emptyValidation);
  const [approved, setApproved] = useState(false);
  const [isFixtureCopy, setIsFixtureCopy] = useState(startWithGolden);
  const [editOpen, setEditOpen] = useState(false);
  const addClaimButton = useRef<HTMLButtonElement>(null);
  const addClarificationButton = useRef<HTMLButtonElement>(null);
  const continuationLink = useRef<HTMLAnchorElement>(null);
  const editDialog = useRef<HTMLElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const researchQuestion = useRef<HTMLTextAreaElement>(null);
  const pendingClarificationFocus = useRef<number | "add" | null>(null);
  const claimSequence = useRef(0);
  const instanceId = useId().replaceAll(":", "");

  useEffect(() => {
    const target = pendingClarificationFocus.current;
    if (target === null) {
      return;
    }
    pendingClarificationFocus.current = null;
    if (target === "add") {
      addClarificationButton.current?.focus();
      return;
    }
    document
      .getElementById(`clarification-${instanceId}-${target}`)
      ?.focus();
  }, [draft.clarifications, instanceId]);

  useEffect(() => {
    if (approved) {
      continuationLink.current?.focus();
    }
  }, [approved]);

  function updateField<Key extends keyof IntakeDraft>(
    key: Key,
    value: IntakeDraft[Key],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidation(emptyValidation);
  }

  function addClaim() {
    claimSequence.current += 1;
    const id = `draft-claim-${instanceId}-${claimSequence.current}`;
    setDraft((current) => ({
      ...current,
      claims: [
        ...current.claims,
        { id, statement: "", operationalDefinition: "" },
      ],
    }));
    setValidation(emptyValidation);
    window.requestAnimationFrame(() => {
      document.getElementById(`${id}-statement`)?.focus();
    });
  }

  function updateClaim(id: string, patch: Partial<IntakeClaim>) {
    setDraft((current) => ({
      ...current,
      claims: current.claims.map((claim) =>
        claim.id === id ? { ...claim, ...patch } : claim,
      ),
    }));
    setValidation(emptyValidation);
  }

  function removeClaim(id: string) {
    setDraft((current) => ({
      ...current,
      claims: current.claims.filter((claim) => claim.id !== id),
    }));
    setValidation(emptyValidation);
    window.requestAnimationFrame(() => addClaimButton.current?.focus());
  }

  function addClarification() {
    if (draft.clarifications.length >= 3) {
      return;
    }
    const nextIndex = draft.clarifications.length;
    pendingClarificationFocus.current = nextIndex;
    updateField("clarifications", [...draft.clarifications, ""]);
  }

  function updateClarification(index: number, value: string) {
    updateField(
      "clarifications",
      draft.clarifications.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    );
  }

  function removeClarification(index: number) {
    const nextFocusIndex =
      index < draft.clarifications.length - 1 ? index : index - 1;
    pendingClarificationFocus.current =
      nextFocusIndex >= 0 ? nextFocusIndex : "add";
    updateField(
      "clarifications",
      draft.clarifications.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  function approveScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextValidation = validateIntake(draft);
    setValidation(nextValidation);
    if (hasValidationErrors(nextValidation)) {
      setApproved(false);
      return;
    }
    setApproved(true);
  }

  function loadGoldenScope() {
    setDraft(structuredClone(goldenDraft));
    setValidation(emptyValidation);
    setApproved(false);
    setIsFixtureCopy(true);
    claimSequence.current = goldenDraft.claims.length;
  }

  function reviseScope() {
    setApproved(false);
    setValidation(emptyValidation);
  }

  function closeEditor() {
    setEditOpen(false);
    requestAnimationFrame(() => editTrigger.current?.focus());
  }

  useFocusBoundary({
    active: startWithGolden && editOpen,
    boundaryRef: editDialog,
    initialFocusRef: researchQuestion,
    onDismiss: closeEditor,
  });

  const statusText = approved ? "Scope approved" : "Awaiting scope approval";

  if (startWithGolden && !editOpen) {
    return (
      <GoldenScopePreview
        draft={draft}
        editButtonRef={editTrigger}
        onEdit={() => setEditOpen(true)}
      />
    );
  }

  return (
    <main
      ref={editDialog}
      className={styles.page}
      role={startWithGolden ? "dialog" : undefined}
      aria-modal={startWithGolden ? true : undefined}
      aria-label={startWithGolden ? "Edit scope" : undefined}
    >
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <div className={styles.brand}>
            <strong>EvidenceForge</strong>
            <span>Bounded evidence workspace</span>
          </div>
          <span className={styles.modeBadge}>
            {isFixtureCopy
              ? "Recorded demo · editable fixture copy"
              : "Draft intake"}
          </span>
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.intro} aria-labelledby="intake-title">
          <div>
            <p className={styles.eyebrow}>Scope checkpoint · 01</p>
            <h1 id="intake-title">Define the claim contract</h1>
            <p className={styles.lede}>
              Turn one research question into testable claims before any source
              collection or model-assisted assessment can begin.
            </p>
          </div>
          <div
            className={`${styles.gate} ${approved ? styles.gateApproved : ""}`}
            role="status"
            aria-live="polite"
          >
            <strong>
              {approved
                ? "Source and model work may begin"
                : "Source and model work blocked"}
            </strong>
            <span>
              {approved
                ? "The approved scope is now read-only until you choose to revise it."
                : "Approval is a required human checkpoint. Nothing downstream runs from this screen."}
            </span>
          </div>
        </section>

        <form onSubmit={approveScope} noValidate>
          <div className={styles.layout}>
            <section className={styles.panel} aria-labelledby="question-heading">
              <header className={styles.panelHeader}>
                <div>
                  <span className={styles.stepLabel}>Question & constraints</span>
                  <h2 id="question-heading">Research boundary</h2>
                </div>
                <div className={styles.fixtureAction}>
                  <span className={styles.demoCue}>Recommended demo path</span>
                  <button
                    className={styles.buttonSecondary}
                    type="button"
                    onClick={loadGoldenScope}
                    disabled={approved}
                  >
                    Load golden fixture
                  </button>
                </div>
              </header>
              <div className={styles.panelBody}>
                {isFixtureCopy ? (
                  <p className={styles.fixtureNote}>
                    Deterministic fixture data—not a live provider result.
                    Review and approve this copy.
                  </p>
                ) : null}

                <div className={styles.formGrid}>
                  <div className={styles.fieldWide}>
                    <label htmlFor="research-question">Research question</label>
                    <textarea
                      ref={researchQuestion}
                      id="research-question"
                      value={draft.originalQuestion}
                      onChange={(event) =>
                        updateField("originalQuestion", event.target.value)
                      }
                      disabled={approved}
                      aria-invalid={
                        validation.originalQuestion !== undefined
                      }
                      aria-describedby={
                        validation.originalQuestion
                          ? "research-question-error"
                          : undefined
                      }
                    />
                    {validation.originalQuestion ? (
                      <p
                        className={styles.error}
                        id="research-question-error"
                        role="alert"
                      >
                        {validation.originalQuestion}
                      </p>
                    ) : null}
                  </div>

                  <div className={styles.fieldWide}>
                    <label htmlFor="intended-application">
                      Intended application
                    </label>
                    <input
                      id="intended-application"
                      value={draft.intendedApplication}
                      onChange={(event) =>
                        updateField("intendedApplication", event.target.value)
                      }
                      disabled={approved}
                      aria-invalid={
                        validation.intendedApplication !== undefined
                      }
                      aria-describedby={
                        validation.intendedApplication
                          ? "intended-application-error"
                          : undefined
                      }
                    />
                    {validation.intendedApplication ? (
                      <p
                        className={styles.error}
                        id="intended-application-error"
                        role="alert"
                      >
                        {validation.intendedApplication}
                      </p>
                    ) : null}
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="population">
                      Population or geography{" "}
                      <span className={styles.optional}>(optional)</span>
                    </label>
                    <input
                      id="population"
                      value={draft.populationOrGeography}
                      onChange={(event) =>
                        updateField(
                          "populationOrGeography",
                          event.target.value,
                        )
                      }
                      disabled={approved}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="time-horizon">
                      Time horizon{" "}
                      <span className={styles.optional}>(optional)</span>
                    </label>
                    <input
                      id="time-horizon"
                      value={draft.timeHorizon}
                      onChange={(event) =>
                        updateField("timeHorizon", event.target.value)
                      }
                      disabled={approved}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="materials-budget">
                      Materials or budget{" "}
                      <span className={styles.optional}>(optional)</span>
                    </label>
                    <textarea
                      id="materials-budget"
                      value={draft.availableMaterialsOrBudget}
                      onChange={(event) =>
                        updateField(
                          "availableMaterialsOrBudget",
                          event.target.value,
                        )
                      }
                      disabled={approved}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="desired-depth">
                      Desired depth{" "}
                      <span className={styles.optional}>(optional)</span>
                    </label>
                    <textarea
                      id="desired-depth"
                      value={draft.desiredDepth}
                      onChange={(event) =>
                        updateField("desiredDepth", event.target.value)
                      }
                      disabled={approved}
                    />
                  </div>

                  <div className={styles.fieldWide}>
                    <label htmlFor="constraints">
                      Explicit constraints{" "}
                      <span className={styles.optional}>
                        (one per line, optional)
                      </span>
                    </label>
                    <textarea
                      id="constraints"
                      value={draft.constraints}
                      onChange={(event) =>
                        updateField("constraints", event.target.value)
                      }
                      disabled={approved}
                    />
                  </div>
                </div>

                <div
                  className={styles.clarifications}
                  aria-labelledby="clarifications-heading"
                >
                  <div className={styles.panelHeader}>
                    <div>
                      <span className={styles.stepLabel}>
                        Up to three questions
                      </span>
                      <h2 id="clarifications-heading">Clarifications</h2>
                    </div>
                    <button
                      ref={addClarificationButton}
                      className={styles.buttonSecondary}
                      type="button"
                      onClick={addClarification}
                      disabled={approved || draft.clarifications.length >= 3}
                    >
                      Add clarification
                    </button>
                  </div>
                  {draft.clarifications.map((clarification, index) => (
                    <div
                      className={styles.clarificationRow}
                      key={`clarification-${index}`}
                    >
                      <div className={styles.field}>
                        <label htmlFor={`clarification-${instanceId}-${index}`}>
                          Clarification {index + 1}
                        </label>
                        <input
                          id={`clarification-${instanceId}-${index}`}
                          value={clarification}
                          onChange={(event) =>
                            updateClarification(index, event.target.value)
                          }
                          disabled={approved}
                        />
                      </div>
                      <button
                        className={styles.buttonDanger}
                        type="button"
                        onClick={() => removeClarification(index)}
                        disabled={approved}
                        aria-label={`Remove clarification ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section
              className={`${styles.panel} ${styles.claimsPanel}`}
              aria-labelledby="claims-heading"
            >
              <header className={styles.panelHeader}>
                <div>
                  <span className={styles.ledgerRule}>Claim contract</span>
                  <h2 id="claims-heading">Testable claim ledger</h2>
                </div>
                <div className={styles.headerButtons}>
                  <button
                    ref={addClaimButton}
                    className={styles.buttonSecondary}
                    type="button"
                    onClick={addClaim}
                    disabled={approved}
                  >
                    Add claim
                  </button>
                  {startWithGolden ? (
                    <button
                      className={styles.button}
                      type="submit"
                      disabled={approved}
                    >
                      Approve scope and open recorded demo
                    </button>
                  ) : null}
                </div>
              </header>
              <div className={styles.panelBody}>
                {draft.claims.length === 0 ? (
                  <div className={styles.empty}>
                    <strong>No claims yet</strong>
                    <span>
                      Add the smallest set of claims needed to answer the
                      question. Each requires an observable success or failure
                      condition.
                    </span>
                  </div>
                ) : (
                  <ol className={styles.claimList}>
                    {draft.claims.map((claim, index) => {
                      const claimErrors = validation.claimFields[claim.id];
                      return (
                        <li className={styles.claim} key={claim.id}>
                          <div className={styles.claimHeader}>
                            <span className={styles.claimIndex}>
                              Proposed claim
                            </span>
                            <button
                              className={styles.buttonDanger}
                              type="button"
                              onClick={() => removeClaim(claim.id)}
                              disabled={approved}
                              aria-label={`Remove claim ${index + 1}`}
                            >
                              Remove
                            </button>
                          </div>
                          <div className={styles.claimBody}>
                            <div className={styles.claimField}>
                              <label htmlFor={`${claim.id}-statement`}>
                                Claim {index + 1} statement
                              </label>
                              <textarea
                                id={`${claim.id}-statement`}
                                value={claim.statement}
                                onChange={(event) =>
                                  updateClaim(claim.id, {
                                    statement: event.target.value,
                                  })
                                }
                                disabled={approved}
                                aria-invalid={
                                  claimErrors?.statement !== undefined
                                }
                                aria-describedby={
                                  claimErrors?.statement
                                    ? `${claim.id}-statement-error`
                                    : undefined
                                }
                              />
                              {claimErrors?.statement ? (
                                <p
                                  className={styles.error}
                                  id={`${claim.id}-statement-error`}
                                  role="alert"
                                >
                                  {claimErrors.statement}
                                </p>
                              ) : null}
                            </div>

                            <div className={styles.claimField}>
                              <label htmlFor={`${claim.id}-definition`}>
                                Claim {index + 1} operational definition
                              </label>
                              <textarea
                                id={`${claim.id}-definition`}
                                value={claim.operationalDefinition}
                                onChange={(event) =>
                                  updateClaim(claim.id, {
                                    operationalDefinition: event.target.value,
                                  })
                                }
                                disabled={approved}
                                aria-invalid={
                                  claimErrors?.operationalDefinition !==
                                  undefined
                                }
                                aria-describedby={
                                  claimErrors?.operationalDefinition
                                    ? `${claim.id}-definition-error`
                                    : undefined
                                }
                              />
                              {claimErrors?.operationalDefinition ? (
                                <p
                                  className={styles.error}
                                  id={`${claim.id}-definition-error`}
                                  role="alert"
                                >
                                  {claimErrors.operationalDefinition}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {validation.claims ? (
                  <p className={styles.error} role="alert">
                    {validation.claims}
                  </p>
                ) : null}

                <p
                  className={`${styles.approvalStatus} ${
                    approved ? styles.approvalStatusApproved : ""
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  {statusText}
                </p>

                <div className={styles.actions}>
                  <span className={styles.stepLabel}>
                    Human checkpoint required
                  </span>
                  <div className={styles.approvalGroup}>
                    {approved ? (
                      <>
                        <button
                          className={styles.buttonSecondary}
                          type="button"
                          onClick={reviseScope}
                        >
                          Revise scope
                        </button>
                        <Link
                          ref={continuationLink}
                          className={`${styles.button} ${styles.continueLink}`}
                          href="/workbench#evidence"
                        >
                          {startWithGolden
                            ? "Open recorded demo"
                            : "Continue to recorded fixture workbench"}
                        </Link>
                      </>
                    ) : null}
                    {!startWithGolden ? (
                      <button
                        className={styles.button}
                        type="submit"
                        disabled={approved}
                      >
                        Approve claim scope
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </form>
      </div>
    </main>
  );
}

function GoldenScopePreview({
  draft,
  editButtonRef,
  onEdit,
}: {
  draft: IntakeDraft;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
}) {
  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <div className={styles.brand}><strong>EvidenceForge</strong><span>Recorded demo</span></div>
          <span className={styles.modeBadge}>Fixture</span>
        </div>
      </header>
      <section className={styles.preview} aria-labelledby="recorded-scope-title">
        <header>
          <p>Recorded demo · editable fixture copy</p>
          <h1 id="recorded-scope-title">Review the scope.</h1>
          <span>{draft.originalQuestion}</span>
        </header>
        <ol aria-label="Recorded claim summaries">
          {draft.claims.slice(0, 3).map((claim, index) => (
            <li key={claim.id}><b>{String(index + 1).padStart(2, "0")}</b><span>{claim.statement}</span></li>
          ))}
        </ol>
        <div className={styles.previewActions}>
          <Link className={styles.button} href="/workbench#evidence">Open recorded demo</Link>
          <button ref={editButtonRef} className={styles.buttonSecondary} type="button" onClick={onEdit}>Edit scope</button>
        </div>
      </section>
    </main>
  );
}
