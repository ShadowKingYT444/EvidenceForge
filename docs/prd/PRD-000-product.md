# PRD-000 — Product

## Public name

**EvidenceForge**, used only for this independent ReverieHacks repository and demo. The name has known exact-name software collisions and is not presented as unique, exclusive, legally cleared, registrable, or affiliated with any third party.

## Product thesis

General-purpose LLMs can produce polished research briefs that hide unsupported claims, missed contradictions, citation mismatches, and experiments incapable of testing their conclusions. Existing products already offer literature search, evidence tables, exact quote tracing, citation graphs, gap analysis, and research agents. This project differentiates itself by preserving a human-governed decision record for a bounded question-to-experiment transformation and by measuring which prompt stages reduce failure.

The product takes a scientific question plus a controlled, user-approved source packet and produces a claim ledger, evidence view, calibrated synthesis, selected research gap, falsifiable experiment, adversarial review, revision trail, and final human decision.

## Target users

Primary demo user:

- a student or early-stage researcher who needs to turn a broad technical question into an evidence-bounded research plan and understand exactly where the plan is weak.

Plausible later users:

- science-fair teams;
- R&D and grant-planning teams;
- technical policy analysts;
- educators teaching evidence literacy and experimental design.

The MVP does not claim professional scientific, clinical, legal, or safety review.

## Positioning guardrails

Lead with “EvidenceForge: an auditable claim-to-experiment workflow” and identify it as an independent ReverieHacks entry. Do not claim name exclusivity, better search, comprehensive coverage, systematic review, citation validation, or autonomous science. The value is the combination of a frozen packet, explicit human gates, separate verification layers, objection-specific revision diffs, and fair node ablations.

## Job to be done

> When I have a broad scientific question and a limited set of sources, help me decide what those sources actually establish, where they disagree or fall short, and what safe, falsifiable next study would reduce the most important uncertainty—without hiding how the answer was produced.

## Core user journey

1. The user enters a question, intended application, scope constraints, time horizon, budget/material limits, and desired depth on the intake/scope route.
2. The system asks at most three high-value clarifying questions and proposes testable subclaims.
3. The user approves, edits, adds, or removes subclaims.
4. The user imports or approves a bounded source packet. Every source declares whether the system has only an abstract, a user excerpt, or full text.
5. The workflow creates evidence cards tied to exact passages and separately shows DOI existence, metadata match, model entailment, and human review.
6. The workbench shows support, contradiction, and unresolved evidence for each subclaim, then produces categorical conclusions and ranks specific research gaps.
7. The system proposes a falsifiable experiment for one selected gap.
8. A different model family critiques the experiment. Accepted objections are revised; rejected/unresolved objections remain visible.
9. The user approves or rejects the final package and exports the evidence ledger, experiment, and audit trail from the run workbench.

## Product surface

Build only two routes for the MVP; drawers and phase states handle detail without creating a dashboard suite.

### Intake and scope route

- structured research brief and no more than three clarifications;
- editable claim contract with operational definitions;
- blocking human scope decision;
- option to open the clearly labeled golden fixture.

### Run workbench route

- header with resolved scope, lifecycle state, packet hash, and evidence-mode label;
- claim tree;
- evidence matrix as the P0 center view;
- passage/verification drawer;
- selected gap, experiment fields, objections, dispositions, revision diff, and residual risk;
- expandable node audit rail;
- sticky final-decision and export controls.

An evidence graph is P1 and must share selection state with the matrix. There is no dashboard, account area, settings route, or generic chat surface in the MVP.

## MVP functional requirements

### Intake and scope

- Collect all scope fields without forcing irrelevant ones.
- Ask no more than three clarification questions.
- Produce individually testable claims with operational definitions.
- Block source work until a human scope decision exists.

### Controlled evidence

- Accept and explicitly freeze one curated packet of five to eight sources for the first vertical slice.
- Support DOI/URL plus abstract or user-approved excerpt; full PDF parsing is out of scope for the first slice.
- Preserve exact source and chunk identifiers through extraction, synthesis, experiment design, and export.
- Record identifier resolution, Registration Agency, provider metadata, content access/version/rights, model assessment, and human review separately.
- Represent unavailable or insufficient evidence as unresolved without collapsing provider failures.

### Verification and synthesis

- Check DOI existence and bibliographic metadata deterministically where services permit.
- Label entailment and conclusion-strength assessment as model-assisted, with a human-review state.
- Display categorical evidence strength: strong, moderate, weak, conflicting, or insufficient.
- Identify a specific gap type and cite the evidence that demonstrates it.

### Experiment and critique

- Include hypothesis, null hypothesis, variables, controls, procedure, sample-size rationale, metrics, confounders, feasibility, safety/ethics, outcomes, and failure/stopping criteria.
- State what the experiment can and cannot establish.
- Use a genuinely different model family for structured adversarial review and validate every provider response locally.
- Revise only accepted objections and preserve every original/revised value.
- Require final human approval.

### Auditability

- Show model, prompt version, input/output references, time, usage/cost when available, evidence mode, validation, retries, and failure for every node.
- Distinguish live, fixture, mocked, simulated, and unverified content.
- Export a canonical run record that conforms to the versioned contract.

## First demo case

Question: “For a single-use 72-hour environmental sensor, can a biodegradable battery replace a lithium coin cell?”

The scope checkpoint must force the user to choose an application rather than produce one universal verdict. Candidate subclaims include energy density, cycle life, degradation conditions, manufacturing cost, toxicity, supply availability, and application fit.

The first fixture uses five to eight curated, legally displayable source excerpts with at least one contradictory or unresolved relationship.

Secondary benchmark domains may include adolescent screen exposure and sleep, and recycled-plastic concrete in low-rise construction. Avoid clinical recommendations and hazardous experiment detail.

## UX principles

- One run workbench plus one intake/scope route, not a dashboard or collection of chat transcripts.
- The evidence matrix/list is the source of truth; a graph is an optional visual index.
- Claims and conclusions are readable in seconds; exact evidence is one interaction away.
- Color is never the only way to distinguish support, contradiction, unresolved, failure, or human override.
- Running animation reflects actual node state; fixture and simulated states are labeled.
- The graph is an index into evidence, not decoration.
- The experiment panel keeps objections and revisions adjacent so improvement is visible.

## Success measures

Product acceptance:

- A user can complete the golden case from intake through final approval without editing JSON.
- Every displayed claim/evidence relationship resolves to the exact source excerpt and verification states.
- The app remains usable offline in golden-fixture mode.
- A failed provider or source lookup is understandable and recoverable.
- The five-minute demo can show baseline failure, workflow transformation, evidence trace, experiment critique, and real evaluation results.

Evaluation targets are directional until measured. Do not place invented target percentages in the UI or pitch. The measured comparison will report citation existence, claim-source entailment, unsupported-claim rate, contradiction recall, experiment completeness, overclaiming, correction effort, blind preference, latency, calls, tokens, and estimated cost.

## Competition alignment

- **Innovation:** inspectable claim-to-experiment transformation and ablation evidence, not generic literature search.
- **Problem solving:** addresses unsupported research claims and weak experiment design.
- **Feasibility:** controlled source packets, one application, explicit workflow, no database.
- **Sustainability/scalability:** versioned contracts and replaceable providers, while clearly bounding content rights and provider cost.
- **UX/design:** interactive evidence trace and revision audit instead of prose-only output.
- **Exceptionality:** fair baseline, preserved raw outputs, human grading, and proof of which nodes contribute.

## Non-functional and safety requirements

- Server-only secrets and no sensitive source content in logs.
- Public/licensed benchmark content only.
- Deterministic fixture path for recording and judging.
- Keyboard-accessible core journey and readable desktop/laptop layout.
- No medical diagnosis, high-risk biological/chemical procedures, autonomous execution, or claims that qualified review occurred.

## Explicitly out of scope

- Systematic-review/PRISMA claims;
- universal web crawling or Google Scholar scraping;
- paywall bypass and unrestricted PDF storage;
- accounts, teams, cloud database, billing, or background jobs;
- graph/vector database;
- autonomous tool-using researcher;
- more benchmark cases or ablations than can be honestly graded;
- domain registration or broader commercial/organizational use of the hackathon name.
