# Comparison parity and invalidation v1

This boundary decides whether a baseline-to-workflow or baseline-to-ablation
pair is structurally eligible for later comparison. It does not compute a
quality metric, import a human preference, or create a measured result.

## Accepted sources

The development matrix is issued only from the accepted two-case baseline and
workflow fixture factories. Baseline attempts are revalidated with their
process-local run authority. Workflow fixtures are revalidated with their
process-local fixture identity. The comparison module then issues a separate,
opaque authority for each exact case, condition, trial, run identity, and code
version. A structural clone or self-consistent replacement cannot mint that
authority.

The deterministic development matrix contains:

- two approved development cases;
- the strong single-prompt baseline paired separately with the complete
  workflow, no-verification ablation, and no-adversarial-review ablation;
- three frozen trial identities for each pair.

## Invalidation

The assessment recomputes the protocol comparison and trial checks against the
separately authorized pair. Changes to prompts, models, source packet,
metadata snapshot, generation limits, benchmark code, retry or fallback
policy, trial identity, actual model, observed fallback, or pre-run exclusion
remain explicit invalidation reasons. Recomputing caller-controlled hashes does
not restore eligibility.

Malformed, extra-field, accessor-bearing, or unauthorized records fail before
they can become accepted comparison evidence. Original baseline failures,
retry records, workflow attempts, reviewer failure/retry history, and exclusion
fields remain attached to every structurally parsed assessment. A changed
evidence history invalidates the pair rather than being normalized away.

## Aggregate boundary

Only in-memory assessments issued by this module can enter an aggregate or
deterministic export. Invalid assessments always expose null preference and
metric payloads and are listed with their exact exclusion reasons. Cloned or
caller-authored aggregate rows are rejected. Empty and all-invalid tables are
valid, deterministic outputs with zero included preference and metric rows.

All current evidence is `fixture` or `simulated`, development-only, and
headline-ineligible. The three trial records are explicitly classified as
structural eligibility fixtures, not evidence that three provider trials ran.
The green checks prove parity and exclusion mechanics, not provider behavior,
workflow quality, human preference, or benchmark improvement.
