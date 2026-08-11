# Deterministic metrics v1

Evidence mode: `fixture` / `mocked` / `simulated` development evidence only. These exports are never headline-eligible and do not claim provider quality or workflow improvement.

`evals/metrics/v1.ts` compiles only source records issued by its accepted upstream adapters into one canonical, SHA-256-bound metrics artifact. Every comparative record also requires the exact process-local comparison-pair authority, the structural candidate assessed under that authority, and the exact issued assessment identity. A workflow record is re-derived from the exact accepted workflow-fixture identity and bound to the pair's case, condition, trial, run, fixture hash, attempts, and errors. A strong-baseline record requires the matching process-local strong-baseline run authority; its pair evidence and persisted attempt evidence are both revalidated against that authority before latency, usage, cost, or failure state is accepted. Canonical JSON, RFC 4180 CSV, and chart data are projections of the resulting artifact; none accepts hand-entered result values.

## Denominators and availability

Every metric records its exact integer numerator and denominator, six-decimal half-up quotient when complete, availability, retained failed-run count, pre-run exclusion count, and denominator policy. A zero denominator is `unavailable`, never zero. Partial token, cost, or metadata coverage is `partial` and has no quotient, preventing an incomplete subtotal from appearing complete. Observed zero usage or cost remains distinct from unavailable telemetry.

All attempted runs, failed raw attempts, invalid parses, and comparison-invalid runs remain in the all-attempted operational metrics. Only these protocol-defined conditions may be omitted before any attempt:

- `safety_gate_blocked`
- `rights_gate_blocked`
- `provider_unavailable_before_attempt`
- `configuration_invalid_before_attempt`

Every such omission is emitted with case, condition, trial, reason, and detail. Comparison-invalid attempts remain in operational totals and error rates, appear with their invalidation reasons, and are excluded only from the per-condition comparison series.

## Metric definitions

| Metric | Numerator | Denominator |
|---|---|---|
| Citation existence | Evidence-card references resolving through an existing chunk to an existing frozen source | Evidence-card source references |
| Metadata match | Checked cited sources with `match` | Cited sources checked as `match` or `mismatch`; availability coverage still includes unchecked citations |
| Requirement coverage | Present valid canonical output sections | Eleven versioned required output sections per attempted output |
| Experiment completeness | Present hypothesis, null, variables, controls, metrics, confounders, safety, feasibility, failure, and stopping components | Ten required experiment components per attempted output |
| Contradiction recall | Frozen known contradictions surfaced through a contradicting evidence card/conclusion link | Frozen known contradictions per attempted output |
| Schema/error rate | Failed raw attempts or non-valid parses | Attempted outputs |
| Calls | Model executions plus attempted outputs that could not produce a canonical execution graph | Attempted runs |
| Latency | Recorded outer-attempt milliseconds | Attempted runs |
| Token usage | Reported total tokens | Attempted runs, available only when every expected model call reports total tokens |
| Estimated cost | Reported estimated USD rounded to the nearest micro-USD | Attempted runs, available only when every expected model call reports an estimate |

The comparison chart series is grouped by frozen condition ID and uses only comparison-eligible attempts. The artifact retains the all-attempted metric set separately so exclusion from pairwise comparison cannot erase operational failures.

## Export safety

JSON uses RFC 8785 canonicalization. CSV uses CRLF records, RFC 4180 quoting, doubled embedded quotes, and an apostrophe prefix for cells that could be interpreted as spreadsheet formulas. Chart values carry an integer, scale, and unit instead of relying on locale-dependent formatted numbers.

The public run-record and artifact schemas are authority checks, not raw structural parsers. Each accepted adapter issues an opaque, revocable process-local metric-source authority and returns a deeply frozen record identity. The comparison binding rejects missing, fake, cloned, spread, JSON, proxied, cross-pair, altered, or locally revoked pair authorities and rejects any assessment not issued by the accepted comparison-parity module for the exact supplied candidate. Authority/case/condition/trial/run/evidence/classification mismatches cannot become reported invalidity; they fail record issuance. Protocol comparison invalidations instead become the complete machine-issued reason set on the record. Those runs stay in operational metrics and are excluded only from comparative condition series. The sole structural record builder is explicitly test-only and rejects outside `NODE_ENV=test`, so authored failure and partial-telemetry cases do not weaken the production compiler boundary.

A compiler-created artifact receives a second opaque process-local authority bound to the privately retained source-authority chain, comparison-pair authority and assessment, and exclusions. Every public parse or export revalidates the comparison assessment plus the upstream workflow fixture or strong-baseline attempt authority, rebuilds each metric record, and then recomputes the artifact before producing JSON, CSV, or chart data. The internal structural schemas additionally enforce count reconciliation, zero-denominator algebra, ratio bounds, metric availability, and quotient derivation.

Persisted JSON is not independently trusted merely because its hash recomputes. Rehydration requires the exact retained artifact authority, every still-valid upstream source authority, exact canonical bytes, and a fresh source-derived recomputation. Restarting the process or losing/revoking any authority in that chain means the JSON must be rebuilt from independently trusted upstream runner or workflow records; there is intentionally no bearer token serialized into the artifact.
