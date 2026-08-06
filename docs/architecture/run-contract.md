# Research Run Contract

This is the conceptual contract that lets implementation lanes work independently. Lane 010 will convert it into executable Zod schemas and versioned JSON fixtures before parallel work. Executable schemas then become authoritative.

## Invariants

1. Every conclusion traces to one or more evidence-card IDs, and every evidence card traces to one immutable source-chunk ID.
2. A source’s existence, bibliographic metadata, claim entailment, and human review are distinct facts.
3. A missing source, missing passage, provider failure, invalid model output, or skipped human decision remains explicit. It never becomes an empty success object.
4. Every LLM output records provider, exact model ID, prompt ID/version, generation settings, timestamps, latency, token/usage data when available, cost estimate when defined, and evidence mode.
5. Human checkpoints record the options shown, decision, edits, timestamp, and unresolved objections.
6. Categorical evidence strength uses a documented rubric; the contract has no arbitrary confidence percentage.
7. Every persisted run declares whether each node is `live`, `fixture`, `mocked`, `simulated`, or `unverified`.
8. Every experiment is a proposal requiring qualified human review, not an instruction that the system can execute.
9. A packet must be explicitly frozen before evidence extraction; its fingerprint proves internal immutability, not source authenticity.
10. Source text is untrusted input. A model cannot grant itself tools, change the workflow, or create a valid quote reference.

## Lifecycle

```text
draft
  -> decomposing
  -> awaiting_scope_approval
  -> collecting_sources
  -> awaiting_packet_approval
  -> extracting_evidence
  -> verifying_evidence
  -> synthesizing
  -> planning_experiment
  -> reviewing_experiment
  -> awaiting_objection_dispositions
  -> revising_experiment
  -> awaiting_final_approval
  -> approved | rejected | failed
```

Only declared transitions are valid. A retry creates a new node-execution record linked to the failed attempt; it does not overwrite history.

## Top-level shape

```ts
type ResearchRun = {
  schemaVersion: string;
  id: string;
  status: RunStatus;
  evidenceMode: EvidenceMode;
  createdAt: string;
  updatedAt: string;
  intake: ResearchIntake;
  claims: Claim[];
  scopeDecision?: HumanDecision;
  sources: SourceRecord[];
  chunks: SourceChunk[];
  evidenceCards: EvidenceCard[];
  conclusions: SubclaimConclusion[];
  researchGaps: ResearchGap[];
  selectedGapId?: string;
  experiment?: ExperimentProtocol;
  review?: ExperimentReview;
  revision?: ExperimentRevision;
  finalDecision?: HumanDecision;
  executions: NodeExecution[];
  errors: RunError[];
};
```

## Intake and claim contract

`ResearchIntake` contains:

- original question;
- intended application;
- population or geography;
- time horizon;
- available materials or budget;
- desired depth;
- explicit constraints and unanswered clarification questions.

Each `Claim` contains:

- stable ID;
- concise testable statement;
- operational definition of success/failure;
- claim category;
- parent claim ID when nested;
- scope constraints;
- human disposition: proposed, approved, edited, removed, or added;
- rationale for why it is necessary to answer the research question.

The scope checkpoint is meaningful: the workflow cannot collect or synthesize evidence until the user approves or edits the claim contract.

## Source and provenance contract

Each `SourceRecord` contains:

- stable internal ID;
- original input, canonical DOI and URL when available, DOI syntax/resolution state, and Registration Agency;
- title, authors, year, venue, study type, and open-access/license metadata;
- origin: user import, curated fixture, or live discovery;
- content scope: `metadata_only`, `abstract`, `user_excerpt`, or `full_text`;
- provider-specific content access, exact version/location, and retrieval timestamp;
- separate `mayStore`, `mayDisplay`, and `maySendToModel` rights states;
- immutable content hash;
- deterministic DOI-resolution result;
- provider-specific metadata-check result with field-level diffs;
- integrity-notice checks that distinguish a notice from the affected work;
- duplicate/merged source references;
- warnings for retraction/update information when available.

Each `SourceChunk` contains:

- stable chunk ID and source ID;
- exact text used by a model or shown to a grader;
- location descriptor such as abstract, page, section, paragraph, or user excerpt label;
- content hash;
- license/display permission state.

Do not store or render text the project is not permitted to reproduce.

The run also records the sorted source/chunk hash set, RFC 8785 packet fingerprint, freeze timestamp, and human freeze decision. A corrected source produces a new packet version and fingerprint.

## Evidence-card contract

Each `EvidenceCard` contains:

- stable ID;
- subclaim ID and source-chunk ID;
- exact quoted or displayable excerpt;
- extracted result, study setting/sample, study type, and limitation;
- relationship: `supports`, `contradicts`, or `unresolved`;
- deterministic metadata check by method and timestamp;
- model-assisted entailment assessment with `full_support`, `partial_support`, `contradicts`, `insufficient`, or `unclear`, rationale, provider/model, and prompt version;
- conclusion-strength warning when the proposed wording exceeds the evidence;
- human review: unreviewed, confirmed, or overridden, with reason;
- extraction failure/warning fields.

Relationship labels do not imply certainty. `unresolved` includes missing text, irrelevant text, ambiguity, and evidence that does not distinguish the claim.

The model returns an existing chunk ID and a literal substring. Application code derives the visible quote and rejects nonexistent, ambiguous, or invented text. Model assessment and human review never overwrite one another.

## Conclusion and gap contract

Each `SubclaimConclusion` contains:

- subclaim ID;
- categorical strength: `strong`, `moderate`, `weak`, `conflicting`, or `insufficient`;
- current conclusion;
- evidence-card IDs for and against;
- disagreement summary;
- important limitations;
- the evidence that would change the conclusion;
- overclaiming warnings and human-review state.

Each `ResearchGap` contains:

- stable ID and affected subclaim IDs;
- gap type: insufficient data, conflicting methodology, missing population, short duration, absent control, scale-up uncertainty, measurement inconsistency, or other;
- impact and tractability rationale;
- evidence-card IDs that demonstrate the gap;
- rank and selection state.

## Experiment and review contract

`ExperimentProtocol` contains:

- selected gap ID;
- objective, design type, hypothesis, and null hypothesis;
- experimental or observational unit and unit of analysis;
- intervention/exposure, comparator, independent/dependent variables, primary/secondary outcomes, controls, and comparison groups;
- measurement validity/calibration;
- randomization, blocking, blinding, or an explicit rationale when they do not apply;
- replication versus repeated-measurement plan;
- inclusion/exclusion, attrition, and missing-data plan;
- procedure at a non-hazardous, reviewable level;
- sample-size basis and missing effect/variance assumptions without pretending a power analysis occurred when inputs are absent;
- pre-specified estimand, metrics, analysis plan, and assumption checks;
- confounders and mitigations;
- feasibility, required resources, and constraints;
- hazards, ethics, qualified-review requirement, stopping/failure criteria;
- expected outcome branches and what each would or would not establish;
- external-validity boundary;
- supporting evidence-card IDs.

The protocol may abstain or require a pilot, domain statistician, or qualified reviewer when necessary inputs are missing. It never invents a power calculation.

`ExperimentReview` contains structured objections for confounds, circular reasoning, equipment feasibility, metrics, unsupported assumptions, ethics/safety, and inferential overreach. Each objection records severity, target field, evidence/rationale, and reviewer model metadata.

`ExperimentRevision` records, for every objection:

- accepted, rejected, or unresolved decision;
- human or policy basis for the decision;
- original value;
- revised value when accepted;
- residual risk.

The final human checkpoint displays the original protocol, each objection, each decision, the revision, and unresolved risk.

## Node-execution contract

Every `NodeExecution` contains:

- stable execution ID, node ID, attempt number, and status;
- evidence mode;
- input and output object references, not duplicated full run state;
- provider, exact model, prompt ID/version, and structured-output schema version;
- generation settings;
- start/end time and latency;
- provider usage and normalized cost estimate when available;
- validation results;
- errors, retries, and fallback decisions;
- code/version identifier when available.

Silent model fallback is forbidden during evaluation. A configured fallback creates a visible execution record and marks the run incomparable unless the benchmark protocol explicitly permits it.

## Benchmark fairness contract

For a measured baseline/workflow pair, freeze and hash:

- original question and resolved scope;
- selected source packet and exact chunks;
- primary provider/model and generation limits;
- required output fields and safety constraints;
- prompt versions;
- benchmark code version.

The baseline is one comprehensive call and receives the same resolved scope, source packet, required outputs, and primary model. The workflow may use its heterogeneous reviewer but must report extra calls, cost, latency, and human effort. Human graders receive randomized condition labels.
