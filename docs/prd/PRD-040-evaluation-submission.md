# PRD-040 — Evaluation and Submission

## Lane mission

Prove whether the structured workflow improves the result over a strong single-prompt baseline, identify which two high-value stages contribute, preserve raw evidence, support blind human grading, and generate the final competition artifacts reproducibly.

This lane may prepare templates against fixtures early, but it must not present synthetic, fixture, or hand-authored numbers as measured results.

## Non-goals

- Weakening the baseline to make the workflow look better.
- Changing product behavior to satisfy a metric without a lane 010 contract/prompt review.
- Building an eval SaaS or relying on a paid eval platform.
- Expanding beyond two development plus six held-out cases before the core benchmark can be graded honestly.
- Claiming expert review when graders are not domain experts.

## Owned paths

- `evals/**`
- `scripts/run-eval*`
- `scripts/export-workflow*`
- `docs/submission/**`
- `artifacts/submission/**`

Do not edit product code, shared schemas, prompt registry, or provider adapters. Request changes from lane 010.

## Benchmark design

### Cases

Use two development cases while prompts and schemas change. Keep them out of headline results. Then freeze six held-out cases across two or three non-medical, non-hazardous domains. Include:

- straightforward evidence;
- known conflicting evidence;
- insufficient/unresolved evidence;
- adversarial or misleading metadata/claim wording;
- an experiment-design case with an identifiable confound or inferential limitation.

Each case contains:

- original question and resolved scope;
- frozen source records and exact content chunks;
- source-packet hash;
- expected known contradictions or seeded failure labels used only for scoring;
- safety/domain notes;
- grader instructions.

Start with the two-case development set. Do not use live retrieval during measured baseline/workflow comparisons.

### Conditions

Run these conditions:

1. **Strong single-prompt baseline:** one comprehensive call with the same resolved scope, source packet, primary model, generation limits, required output fields, and safety constraints.
2. **Complete workflow:** all directed stages and heterogeneous experiment review.
3. **No verification ablation:** remove deterministic metadata/entailment-strength verification contributions while preserving other inputs.
4. **No adversarial-review ablation:** stop after the original experiment plan.

Two ablations are sufficient. Add decomposition ablation only if the full benchmark and human grading are complete.

Run three trials per eligible case/condition with fixed configuration and recorded seeds when the provider supports them. Report per-case failures and dispersion; do not select the best trial. If the pitch claims that cross-family review itself improves results, add a three-case same-family-versus-cross-family reviewer ablation. Otherwise describe heterogeneous review as a design safeguard, not a measured benefit.

Freeze prompt versions, model IDs, source hashes, deterministic identifier/metadata facts, generation settings, code version, and benchmark configuration before a measured run. The strong baseline receives those same normalized metadata facts. A fallback model, changed packet, changed prompt, or changed metadata snapshot invalidates pairwise comparison unless the entire paired condition is rerun.

## Metrics

### Deterministic or programmatic

- **Citation existence:** resolving cited source identifiers divided by cited identifiers.
- **Metadata match:** citations whose title/author/year/DOI pass the defined field rubric divided by checked citations.
- **Requirement coverage:** valid required fields divided by required fields.
- **Experimental completeness:** valid hypothesis, null, variables, controls, metrics, confounders, safety, feasibility, and failure/stopping fields divided by required experiment fields.
- **Contradiction recall:** known conflicting items surfaced divided by known conflicting items in the frozen case key.
- **Call count, latency, token usage, and estimated cost:** aggregated from execution records, with unavailable provider data labeled unavailable.
- **Schema/error rate:** invalid or failed outputs divided by attempted outputs.

### Human-graded

- **Claim-source entailment:** whether the cited chunk actually supports the associated claim.
- **Unsupported-claim rate:** factual claims without an adequate evidence link divided by factual claims.
- **Overclaiming rate:** conclusions stronger than the underlying evidence divided by reviewed conclusions.
- **Experiment validity:** whether fields are not merely present but appropriate to the stated hypothesis.
- **Correction effort:** count and optionally time substantive edits required to reach an acceptable output.
- **Blind preference:** paired preference with randomized condition labels plus a short reason.

The rubric must define what counts as factual, substantive, adequate, and overclaimed. Report grader count and expertise honestly. Preserve disagreements rather than forcing consensus silently.

## Runner and artifacts

Implement a repo-local TypeScript runner that:

- validates every case and condition configuration;
- writes raw provider outputs and canonical parsed runs separately;
- records failed attempts and provider/request metadata;
- computes deterministic metrics from raw/canonical artifacts;
- creates anonymized/randomized human-grading packets;
- imports human annotations without overwriting raw output;
- produces machine-readable JSON/CSV and presentation-ready tables/charts;
- never mutates a frozen source packet in place.

Suggested artifact separation:

```text
evals/cases/             # versioned case inputs
evals/fixtures/          # smoke and golden fixture inputs
evals/runs/<run-id>/raw/ # immutable raw provider output
evals/runs/<run-id>/parsed/
evals/runs/<run-id>/metrics.json
evals/annotations/       # randomized grader packets and completed annotations
artifacts/submission/    # approved exports only
```

Generated results must identify evidence mode. Fixture and mocked smoke runs never populate the final measured-results table.

## Required submission artifacts

The current Devpost page says four ML files but lists only three categories. Until organizers clarify, prepare these reproducible artifacts and reserve a fourth slot:

1. **Workflow PNG:** generated from `docs/architecture/workflow.mmd`, naming human inputs/checkpoints, prompt IDs, exact frozen models, and node actions.
2. **Sample comparison:** document or video section showing identical test cases and packets for the strong baseline and workflow, with visible failure examples and measured metrics.
3. **Detailed documentation:** problem, scope, reason for every node, prompts/models, structured contracts, human control, verification boundaries, evaluation protocol, results, limitations, costs, and scalability.
4. **Organizer-confirmed artifact:** placeholder only until confirmed; do not guess.

Also prepare:

- a sub-five-minute demo script;
- a deterministic golden-run recording path;
- a one-page executive summary;
- a provenance/citation ledger for the demo case;
- a limitations and unresolved-risk section.

## Five-minute demo target

- **0:00–0:35:** unsupported claims and weak experiment design as the problem.
- **0:35–1:05:** show a real strong-baseline deficiency from preserved output.
- **1:05–2:00:** explain the claim contract, controlled packet, verification layers, human scope gate, and heterogeneous reviewer.
- **2:00–3:15:** inspect one claim-to-passage edge and one experiment objection/revision live or in honest fixture playback.
- **3:15–4:15:** present real benchmark and two ablations with cost/latency tradeoffs.
- **4:15–4:45:** bounded users, scalability, and limitations.
- **4:45–5:00:** close: the product does not replace scientists; it makes AI research planning inspectable, falsifiable, and accountable.

## Acceptance criteria

Protocol:

- Baseline parity is asserted by hashes/config and tested.
- Six held-out frozen cases cover the required evidence patterns, or the final report explicitly states the smaller completed count.
- Three trials per eligible case/condition are preserved and summarized without cherry-picking.
- Complete workflow and two ablations execute on the same eligible cases.
- Any changed model, prompt, packet, or fallback invalidates and visibly flags the comparison.

Evidence:

- Raw outputs, parsed outputs, computed deterministic metrics, and human annotations are separate.
- Failed/blocked cases remain in denominators or are reported with a documented exclusion reason.
- Fixture/simulated results cannot enter the live final-results table.
- Human graders see randomized condition labels.
- Metric definitions and grader count/expertise appear beside results.

Submission:

- Mermaid source exports to a readable PNG at submission resolution.
- The sample comparison uses the same test cases and clearly labels model, packet, and evidence mode.
- Documentation explains every node and why it exists.
- Demo script times under five minutes in at least two rehearsals.
- Organizer clarification on the fourth file and start date is recorded before final checklist freeze.
- No invented benchmark number, citation claim, or expert-review claim appears in any artifact.

## Required handoff

List benchmark/case versions, frozen hashes, model/prompt configuration, commands, raw-output paths, measured versus fixture evidence, grader status, failed/excluded cases, artifact paths, organizer blockers, and remaining claims that cannot yet be made.
