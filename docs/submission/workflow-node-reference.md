# EvidenceForge workflow node reference

This reference documents the accepted fixture-demo workflow at repository commit `59803f1132017e0c3f4ae4ee63317c813bf2fba5`. Read it with the [executive summary](executive-summary.md), [fixture provenance ledger](golden-fixture-provenance-ledger.md), [run contract](../architecture/run-contract.md), and integrated [workflow image](../../artifacts/submission/workflow-v1.png).

## Reproducibility identities

| Identity | Accepted value | Meaning |
| --- | --- | --- |
| Current prompt-manifest SHA-256 | `f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2` | Binds the current prompt registry used by executable live configuration. |
| Current node-configuration SHA-256 | `aca24c0d26695e54a2d22986363e5ee7193366bc24fcd7a4432e02877de05b29` | Binds current per-node prompt/schema/generation/transport/timeout/retry/capability policies and current reviewer identity; the primary identity is bound elsewhere in the complete configuration. |
| Current configuration-authority SHA-256 | `0f284f3740446cb4b782be98b449cfdf4acbbc1d57d5eacb261bc91925123b87` | Binds fixture ID and canonical SHA, packet fingerprint, rights-approval SHA, ordered source/chunk IDs, and source/chunk content hashes—no prompt, model, or node-policy fields. |
| Fixture canonical SHA-256 | `f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7` | Canonical deterministic run identity. |
| Fixture packet fingerprint | `944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e` | Binds frozen source/chunk order and content hashes. |
| Fixture rights-approval SHA-256 | `9a0ffe668eb7562ee576d443a7c00c5d73cdf0727b09a661de460cbeb9efb8f5` | Binds the human-recorded packet rights approval. |
| Workflow source SHA-256 | `9d8ec3ddb64eeb59f7d20902e732f7bd34d5107313ee4f42265f505a9a9875cf` | Hash of `docs/architecture/workflow.mmd`. |
| Workflow PNG SHA-256 | `3440e08d00f403a323e2fd26a8e37e8cab8755d04cecbc2a54a3d37c236a3a5c` | Hash of the 2384 x 1130 integrated image. |

The current live configuration and the historical fixture execution metadata are intentionally different records. Current live requests use the models and prompt versions below. The immutable fixture records retain fixture model IDs and the prompt versions with which that deterministic history was frozen. A reader must not reinterpret historical fixture executions as outputs from the current models.

## Shared execution controls

Current model-facing requests use Featherless with primary model `mistralai/Mistral-Large-Instruct-2411` (`mistralai` / `mistral-large`) and heterogeneous reviewer `Qwen/Qwen2.5-72B-Instruct` (`qwen` / `qwen2.5`). They request JSON-object transport, append the prompt-guided schema, validate locally with strict schemas and cross-record invariants, and allow one repair at most. Each transport attempt has a 120,000 ms deadline; the finite two-attempt ceiling yields a maximum 240,000 ms transport budget plus bounded local retry work. Maximum model output is 2,048 tokens. There is no model fallback.

Model output contains bounded semantic fields only where compact schemas apply. The application materializes deterministic IDs, model identity, verification/audit fields, and human-review fields after a terminal successful attempt. Provider-supplied or forged application-owned fields are rejected or ignored at the strict boundary. Current requests contain no monetary cost basis; pricing, rate snapshots, and cost estimates remain null/absent, while exact token usage is recorded when returned.

## Node-by-node contract

### 1. Clarify and decompose

- **Node / prompt:** `clarify-and-decompose` / `clarify-decompose@1.0.0`.
- **Input:** the question, intended application, time horizon, constraints, available materials/budget, and unanswered clarifications.
- **Model responsibility:** propose concise, testable claims with operational success/failure definitions. It does not approve scope.
- **Human gate:** approve, edit, add, or remove claims. Only approved claims continue.
- **Output invariant:** the claim contract preserves dispositions and rationale separately from model-authored claim semantics.

### 2. Collect and freeze sources

- **Node / boundary:** `collect-sources` / `collect-bounded-source-packet@1.0.0`.
- **Input:** approved claims plus user-supplied DOIs and excerpts.
- **Application responsibility:** build a controlled packet; perform DOI syntax/resolution and metadata comparisons; record access scope, rights, source/chunk hashes, warnings, and integrity notices.
- **Human gate:** review packet contents and store/display/model-use rights, then approve and freeze.
- **Output invariant:** the packet fingerprint proves internal immutability only. Existence or a metadata match is not entailment, and denied rights block downstream model use.

### 3. Extract grounded evidence

- **Node / prompt:** `extract-evidence` / `extract-grounded-evidence@2.0.0`.
- **Input:** approved claim semantics and only permitted source chunks from the frozen packet.
- **Model responsibility:** return compact candidates that point to exact claim/source/chunk references and literal excerpts.
- **Application responsibility:** materialize deterministic evidence IDs and all audit/verification/model-identity fields from the actual terminal attempt.
- **Output invariants:** every excerpt must be a non-empty literal substring of its referenced chunk; source/chunk/claim references and rights must exist; duplicate extraction and deterministic-ID collisions fail closed.

### 4. Assess entailment

- **Node / prompt:** `assess-entailment` / `assess-evidence-entailment@2.0.0`.
- **Input:** byte-preserved application-owned evidence plus approved claim semantics.
- **Model responsibility:** assign categorical relationship and strength, summarize reasoning, and flag overclaiming. It does not modify excerpts or verification/human fields.
- **Application responsibility:** preserve the extraction record byte-for-byte, attach the actual terminal model identity, and validate references.
- **Output invariants:** one assessment per evidence card; no missing or duplicate evidence references; categorical results only, with no invented confidence percentage.

### 5. Synthesize conclusions and gaps

- **Node / prompt:** `synthesize-conclusions` / `synthesize-conclusions-gaps@2.0.0`.
- **Input:** claims, immutable evidence references, and categorical assessments.
- **Model responsibility:** return one compact conclusion per actual claim plus one to three ranked gap candidates when supported.
- **Application responsibility:** derive complete evidence/governance lists, deterministic gap IDs, rank, and selected-gap linkage from the actual run.
- **Output invariants:** the runtime provider schema is built from actual claim/evidence IDs and exact claim count; references, duplicates, ranks, indexes, and list bounds are validated before full-output materialization and full-schema reparse.

### 6. Plan a reviewable experiment

- **Node / prompt:** `plan-experiment` / `design-reviewable-experiment@2.0.0`.
- **Input:** only the selected gap and claims/evidence/conclusions relevant to it, with human disposition metadata excluded.
- **Model responsibility:** return bounded protocol semantics or a typed abstention. It does not author deterministic proposal/abstention IDs, audit/model identity, human-review, or safety-governance fields.
- **Application responsibility:** hydrate those fields from the actual terminal successful attempt and current run, validate dynamic references and one-to-one deltas, then reparse the complete run.
- **Output invariants:** a proposal is educational and reviewable, not executable authority. An abstention skips critique/revision and goes to the final human checkpoint. An invalid response remains an explicit failed attempt.

### 7. Adversarial experiment review

- **Node / prompt:** `review-experiment` / `adversarial-experiment-review@1.0.0`.
- **Input:** the materialized proposal and its evidence/governance context.
- **Reviewer responsibility:** return typed objections with severity, rationale, and requested change. It cannot silently rewrite the proposal.
- **Human gate:** accept, reject, or leave each objection unresolved.
- **Output invariants:** objection references must exist; dispositions are human-owned; unresolved objections remain visible.

### 8. Selective experiment revision

- **Node / prompt:** `revise-experiment` / `selective-experiment-revision@1.0.0`.
- **Input:** original proposal, reviewer objections, and human dispositions.
- **Primary responsibility:** apply accepted objections only and describe one-to-one deltas.
- **Application responsibility:** verify each delta against an accepted objection and preserve rejected/unresolved items without silently treating them as resolved.
- **Human gate:** inspect protocol or abstention, evidence, objections, and diff; then approve or reject. The declared actor is not authenticated because the demonstration has no authentication.

## Failure, retry, and export semantics

A provider failure, timeout, refusal, invalid JSON, schema mismatch, missing reference, or invariant failure produces a typed error and terminal attempt record. One repair may create a second execution linked through `retryOfExecutionId`; the first attempt remains immutable. External cancellation aborts the active transport, settles exactly once, consumes late work, and leaves no fallback or extra attempt.

Successful nodes store output references to the application-materialized full output, not the compact provider payload. Continuation/replay validates persisted full schemas, while the provider boundary validates compact schemas. Canonical export reparses the complete run and produces stable bytes for the same accepted state.

The fixture audit demonstrates both success and failure history: a nonexistent DOI creates no evidence, an invalid first planning payload is retained before a successful fixture repair, and a reviewer provider failure is retained before a successful fixture retry. These are fixture events, not live-provider performance evidence.

## Demonstration truth boundary

The complete workflow shown in the UI and image is deterministic `fixture` playback. The preserved bounded `live` attempt reached extraction and entailment, repaired synthesis once, then failed both planning attempts during application-schema validation. It stopped in `planning_experiment` with six attempts and three errors, four evidence cards, three conclusions, three research gaps, and no experiment, review, revision, or final decision. It is failure evidence only.

The planned benchmark measurement, private blind grading, ablations, and measured monetary-cost work were canceled and not completed; live end-to-end completion is also unavailable. No comparative quality or performance conclusion may be inferred from the fixture or partial live attempt.
