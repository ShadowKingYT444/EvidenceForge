# Benchmark protocol v1

Protocol version: `1.0.0`

This document defines comparison eligibility. It contains no benchmark result,
score, or headline claim. The executable authority is
`evals/protocol/v1.ts`; a downstream implementation step owns runner and
artifact implementation.

## Case boundary

A case is an immutable, hashed record with:

- one original question and resolved bounded scope;
- a frozen source-packet fingerprint plus exact sorted source/chunk hashes;
- an independently identified and hashed metadata snapshot;
- scoring-only expected failure labels and grader instructions;
- a `development` or `heldout` role; and
- explicit non-medical, non-hazardous safety notes.

The eligible domains are `environmental_sustainability`,
`materials_engineering`, and `software_reliability`. Adding a domain requires a
new compatible protocol version or a full rerun under a new protocol.
Development cases are for prompt, schema, and smoke work only. They can never
enter headline results.

## Required conditions

| Condition | Frozen meaning |
|---|---|
| `strong_baseline` | One comprehensive call. It receives the same resolved scope, packet, normalized deterministic metadata, primary model, generation limits, required outputs, and safety constraints as the workflow. |
| `complete_workflow` | All directed workflow stages, deterministic verification contributions, heterogeneous adversarial review, and post-review revision. |
| `no_verification` | The complete workflow with deterministic metadata and entailment-strength verification contributions removed; other inputs remain fixed. |
| `no_adversarial_review` | The workflow stops after the original experiment plan; adversarial review and post-review revision are absent. |

These semantics are hashed as one condition matrix. Condition-specific prompts
are expected to differ. Fairness therefore freezes and hashes the complete
prompt manifest shared by the benchmark suite instead of pretending the
baseline prompt and workflow prompts are identical.

## Frozen comparison configuration

Every condition configuration records and hashes:

- protocol and condition-matrix versions;
- case, role, domain, resolved scope, packet membership, and metadata snapshot;
- exact primary and adversarial-reviewer provider/model/family identities;
- generation settings, limits, seed support, and structured-output mode;
- output schema, required-field, and safety-constraint hashes;
- every prompt ID, version, and canonical hash;
- benchmark Git commit;
- retry and structured-output-repair policy;
- forbidden or explicit-invalidating fallback policy;
- exactly three trial IDs with `report_all_no_best_of`; and
- the fixed exclusion and denominator policy.

`caseHash` protects the full case definition. `promptManifestHash` protects all
prompt resources. `pairingHash` protects every comparison-shared field while
allowing the deliberate condition difference. `configHash` additionally
protects the selected condition and its exact semantic hash.

The consumer edge also records contract `0.1`, packet fingerprint
`944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e`,
golden fixture hash
`f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7`,
and a hash derived directly from the frozen shared prompt registry. These are
references; this lane does not modify the shared contract, fixture, prompts,
providers, or baseline renderer.

## Visible invalidation

Pair assessment returns an ordered list of machine-readable reasons. A pair is
invalid when any shared item differs, including protocol/schema, case identity
or role, resolved scope, source packet or membership, metadata snapshot,
primary or reviewer model, generation configuration, output contract, prompt
manifest, benchmark code, retry policy, fallback policy, trial plan, exclusion
policy, or evidence mode.

Observed trial assessment additionally invalidates a pair for a stale
configuration reference, an unpaired trial ID, a model different from the
frozen primary model, any fallback use, or a pre-run exclusion. An attempted
trial cannot be excluded: failures remain in the denominator.

The only allowed pre-run exclusion reasons are a blocked safety gate, blocked
rights gate, provider unavailable before an attempt, or invalid configuration
detected before an attempt. Each remains visible beside the denominator; it is
not converted into a successful or empty result.

## Evidence and reporting

Only `live` evidence from a `heldout` case is structurally eligible for a
headline comparison. `fixture`, `mocked`, `simulated`, and `unverified`
protocol exercises are never headline data. Seeds are recorded when supported;
unsupported seeds remain explicitly `null`. All three trials are reported, and
the protocol has no best-trial selection.

Trial records in this issue contain configuration and audit metadata only.
They deliberately contain no metric, provider output, parsed run, annotation,
or result-table field. Later issues must keep raw outputs, parsed outputs,
metrics, and human annotations separate and preserve every failure.
