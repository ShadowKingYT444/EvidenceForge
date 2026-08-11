# EvidenceForge: executive summary

EvidenceForge is a Next.js/React/TypeScript software application whose core moat is a human-governed, auditable LLM claim-to-experiment workflow for turning a bounded, user-approved source packet into a reviewable package. The system decomposes a question into testable claims, checks an approved packet, extracts literal evidence, assesses entailment, identifies research gaps, proposes an educational experiment, obtains heterogeneous model critique, applies only human-accepted objections, and asks a person for the final decision. It is not an autonomous scientist, a systematic-review service, or a tool that executes experiments.

## The demonstration

The deterministic fixture asks whether a biodegradable battery could replace a coin cell in a single-use humidity sensor that must operate for 72 hours. Seven attributed excerpts form the frozen packet. They deliberately include conflicting runtime observations, application-fit uncertainty, a bounded ingestion hazard, a supplied-title metadata mismatch, and a nonexistent DOI. The workflow keeps source existence, metadata verification, literal passage verification, model-assisted entailment, and human review as separate facts.

The fixture reaches an honest result: the available packet does not establish loaded 72-hour operation or complete sensor integration. It selects the loaded-duration gap and proposes a randomized, blocked bench comparison for qualified review. The reviewer raises load-verification and degradation-safety objections. A human accepts the calibration objection, leaves degradation safety unresolved, and permits only a bounded educational pilot. The fixture is deterministic playback, not evidence that a live model produced these results.

Current live configuration uses `mistralai/Mistral-Large-Instruct-2411` as the primary model and `Qwen/Qwen2.5-72B-Instruct` as the reviewer through Featherless. Structured JSON, local schema validation, a maximum of one repair, no silent fallback, per-attempt deadlines, and append-only execution records bound model behavior. The exact current configuration identities are recorded in the [node reference](workflow-node-reference.md).

## Evidence boundary

The complete path shown in the demo is `fixture`. A separately preserved bounded `live` attempt is useful failure evidence, but it is not an end-to-end success: extraction and entailment succeeded, synthesis succeeded after one repair, and both experiment-planning attempts failed application-schema validation. It produced no experiment, review, revision, or final human decision. The demo therefore uses the complete fixture path and labels it at every presentation boundary.

The planned measured benchmark, private blind grade, ablation study, and measured monetary-cost study were canceled and not completed; no successful live end-to-end run exists. The project makes no superiority, percentage-improvement, cost-savings, latency, or win-rate claim. Token usage is retained when a provider returns it, while current monetary pricing and cost estimates are intentionally absent rather than reported as zero.

## Why the workflow is auditable

- A human approves scope before source collection and approves packet contents and rights before the packet is frozen.
- Immutable source and chunk hashes bind every evidence card to an exact excerpt. A hash proves packet consistency, not source authenticity or legal clearance.
- Deterministic checks verify DOI syntax/resolution metadata and literal excerpts; the model performs categorical entailment assessment; a human records the decision. None substitutes for another.
- Every model attempt records requested and returned provider/model identity, prompt and schema identity, generation settings, timing, exact usage when available, validation outcome, refusal state, retry linkage, evidence mode, and error linkage.
- A retry appends a new attempt. It never overwrites the failed attempt, and the workflow permits at most one repair.
- The reviewer cannot silently edit the experiment. A human disposes each objection, and revision may apply only accepted objections. Unresolved objections remain visible at the final checkpoint and in export.
- Canonical export is schema-validated and byte-stable for the same accepted run.

## Safety, rights, and non-goals

Experiment plans are educational proposals requiring qualified review. The workflow does not diagnose, prescribe, generate hazardous wet-lab instructions, or take autonomous real-world action. It audits only a bounded packet; it does not browse for unrestricted evidence or infer that a metadata match entails a claim.

All seven fixture excerpts carry a human-recorded CC BY 4.0 store/display/model-use decision with attribution and provenance retained. That fixture decision is not legal advice or general permission for other material. New, private, paywalled, or restricted packets require a new rights decision and packet freeze. See the [provenance ledger](golden-fixture-provenance-ledger.md) for the exact boundaries.

## Submission readiness

These documents were derived from the accepted repository state at `59803f1132017e0c3f4ae4ee63317c813bf2fba5`; their containing integration SHA belongs to post-merge evidence and is not asserted here. The integrated [workflow image](../../artifacts/submission/workflow-v1.png) already present in that accepted state is reproducible from its recorded source, renderer, and hashes. Repository publication requires an independent public allowlist/secret/restricted-content/name review and explicit user authorization. The verifier-only private scoring pack is unavailable and supplies no audit pass; it is optional private audit evidence, not a prerequisite for publishing the verified code. Organizer resolution of the required-asset count and completion in the official Devpost interface are later external submission tasks, not code-publication prerequisites. No repository push, organizer acceptance, or submission is implied by this document.
