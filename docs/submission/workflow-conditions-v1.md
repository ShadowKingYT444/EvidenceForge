# Workflow and Ablation Conditions v1

This module implements the complete structured workflow and two high-value ablations for deterministic development-fixture checks. It creates no benchmark score, improvement claim, live-provider output, or headline result.

## Shared comparison boundary

Every condition receives the same grader-safe projection of a development case selected through the internally owned frozen two-case registry:

- original question and resolved scope;
- frozen source and chunk packet;
- normalized metadata snapshot;
- approved claims, rights, and safety notes; and
- no private scoring key, expected relationship, grader instruction, or expected abstention rationale.

The benchmark protocol hashes that input together with the same primary model, heterogeneous reviewer model, generation settings, output contract, prompt manifest, code base, retry/fallback policy, three stable trial identities, and exclusion policy. Only the condition identifier and its hashed condition specification differ. Pairwise comparison validation therefore accepts the deliberate condition difference and rejects context or configuration drift.

Structural consistency is not case authority. The public creator accepts only opaque case identities issued by the frozen registry, and the matrix accepts only its opaque two-case set identity. Cloned, forged, proxied, or self-consistent third-party cases are not eligible. Internally produced fixture identities are likewise required before validation or materialization. These identity gates reject unissued objects without reflectively inspecting them; they do not claim general JavaScript proxy detection.

All artifacts produced here are `simulated`, `development`, `smoke_only`, and `headlineEligible=false`. The fixture model identities do not represent hosted-provider calls.

## Conditions

| Condition | Directed stages | Precisely removed contributions |
|---|---|---|
| Complete workflow | clarify and decompose; frozen packet boundary; evidence extraction; entailment assessment; synthesis; experiment plan; heterogeneous adversarial review; selective revision | none |
| No verification | clarify and decompose; frozen packet boundary; evidence extraction; synthesis; experiment plan; heterogeneous adversarial review; selective revision | deterministic metadata verification and entailment-strength verification |
| No adversarial review | clarify and decompose; frozen packet boundary; evidence extraction; entailment assessment; synthesis; original experiment plan | adversarial experiment review and post-review selective revision |

The no-verification condition still receives the same source metadata and chunks. It records metadata and literal-membership checks as `not_checked`, omits the entailment-assessment stage, and keeps downstream synthesis, planning, reviewer failure/retry provenance, and revision structure visible. It does not turn missing verification into a successful verification result.

The no-adversarial-review condition ends after the original experiment plan. Its review, objection-disposition, and revision fields are null, and it records no reviewer call.

## Execution and artifact evidence

All three conditions use the same accepted local artifact runner. Raw condition envelopes and canonical parsed research runs are separate immutable files. Each envelope records:

- condition and condition-spec hashes;
- case, trial, model-input, and benchmark-config hashes;
- the exact ordered stage plan and removed contributions;
- primary and reviewer call counts;
- deterministic-boundary execution count;
- failed-call count and total simulated latency; and
- token usage and estimated-cost availability derived from execution records.

The generated simulated fixtures record usage and cost as unavailable. Validation also permits coherent partial telemetry when an execution record actually contains it, including on the preserved failed reviewer, but rejects any raw-summary contradiction.

Conditions with adversarial review preserve a deterministic simulated reviewer transport failure followed by a linked retry. This verifies failure visibility and retry linkage; it is not evidence about a real provider's reliability. No silent fallback is configured or observed.

The development matrix contains exactly two approved development cases, three conditions, and three frozen trial identities: 18 non-headline fixture runs. Creation order is canonical, internally owned case snapshots isolate caller aliases, condition/context tampering is rejected, and rerunning an existing run identifier cannot overwrite any prior byte.

No same-family-versus-cross-family condition is present. The heterogeneous reviewer remains a fixed design safeguard; no measured reviewer-family benefit is claimed.
