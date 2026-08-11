# Blind grading and annotation import v1

Version: `1.0.0`

This contract prepares deterministic **simulated development packets only**. It
does not record a human grade, verify grader expertise, create a measured
benchmark result, or make any artifact headline-eligible. Human grading remains
a later external gate.

## Rubric

- **Factual:** an externally checkable statement about a source, result,
  population, mechanism, or proposed experiment. Clearly marked questions and
  value judgments are excluded.
- **Substantive:** an edit that changes a factual claim, evidence link,
  conclusion strength, hypothesis, variable, control, metric, confounder,
  safety boundary, feasibility claim, or interpretation. Spelling and formatting
  alone are not substantive.
- **Adequate:** a displayed source passage directly supports the claim at its
  stated scope and strength. Identifier existence or metadata alone is not
  adequate entailment.
- **Overclaimed:** certainty, causal language, population, duration, generality,
  or practical implication exceeds what the displayed evidence establishes.

Each grader records claim-source entailment, unsupported-claim state,
overclaiming, experiment validity, substantive correction count with optional
elapsed time, and an opaque-label paired preference with a reason. Every
dimension permits the relevant unavailable, not-applicable, unclear, or
abstention state. The import and summary paths preserve individual records;
they do not silently force consensus.

## Confidential blinding boundary

`createBlindGradingPacket` does not accept caller-assembled condition candidates,
grader views, raw/canonical bindings, or evidence modes. It requires the exact
three accepted development comparison pairs for one case/trial. Each
source carries its process-local comparison-pair authority, authority-bound
record, retained baseline parent/rerun run authorities, and exact internally
issued workflow fixture bearer. The creator obtains an issued
eligibility result itself and rejects unauthorized, invalid, ineligible,
excluded, duplicated, or cross-case/trial/condition/run/config sources.

The four grading entries are derived internally. The baseline entry binds the
complete preserved parent/rerun attempt sequences. Each workflow entry binds
the accepted fixture's raw attempt and canonical run; displayed claim/evidence
items and experiment data are projected only from that canonical run. A
baseline fixture with no valid canonical output receives a neutral explicit
unavailable view rather than invented content. The packet truthfully declares
`mixed_fixture_simulated`; the confidential mapping retains `fixture` for the
baseline and `simulated` for workflow entries. No caller mode is discarded or
promoted.

An explicit fixture seed makes a smoke packet reproducible; it is only
permutation input and grants no authority to accept a mapping. Permutation
derivation is domain-separated by packet ID, packet nonce, case, trial, and
condition. A repeated four-way permutation remains a legitimate 1-in-24 random
collision, not proof that separation failed.

The grader packet uses fixed project instructions and contains only `Condition
A` through `Condition D`, canonical position-only entry/item IDs, displayable
claims and passages, the rubric, and neutral packet/case/trial identity. Caller
instructions are not accepted. Caller item IDs are replaced and retained only
inside the confidential mapping. Condition aliases, run/attempt IDs, config
hashes, raw/canonical hashes, private item IDs, and 64-hex values are rejected
if they occur anywhere in the complete grader-visible packet. Labels occur once
in fixed A-D order and have equal length. The seed, nonce, mapping, and authority
are never grader-visible.

The separately held confidential mapping binds each opaque label to the exact:

- condition, run, and attempt;
- benchmark configuration hash;
- canonical SHA-256 hash of the raw output; and
- canonical SHA-256 hash of the parsed output; and
- evidence mode, full internally derived source-chain hash, every source
  run/attempt identity, and issued comparison eligibility hash; and
- each neutral grader item ID's private source-item binding.

The builder issues a frozen, process-local opaque mapping authority and stores
the exact canonical packet, mapping, derived source-chain bytes, and upstream
authority identities outside the returned data. The
mapping hash is structural integrity only; it is deliberately not a public
acceptance or signing schema. Import and summary require both the exact issued
mapping authority and all exact retained upstream authorities before traversing
serialized source records, packet, mapping, or annotation data. Cloned,
spread, JSON-round-tripped, fake, proxied, revoked, lost, cross-purpose, or
cross-packet authorities fail. An exact serialized source record,
packet/mapping, and annotation remain usable with their original authorities,
but swapping or rewriting whole sources and recomputing every caller-visible
hash does not. A failed use does not revoke a legitimate authority.

Do not send the mapping, fixture seed, nonce, or any authority to graders. The
authorities are nonserializable and intentionally limited to one process; later
measured orchestration must regenerate them from independently verified
immutable runner/comparison inputs. Opaque labeling cannot remove stylistic or
availability clues inherent in the authorized output under review.

## Append-only import

Completed annotations bind an opaque packet ID, not a caller-supplied signature.
Import validates the exact retained upstream authorities and source chain,
mapping authority, packet, confidential mapping, all labels and item IDs, and
strict grader record before writing a derived record under:

```text
<artifact-root>/annotation-imports/1.0.0/<packet-id>/<grader-id>/<annotation-id>.json
```

The derived record includes opaque packet/mapping IDs, immutable
config/raw/canonical/evidence-mode/source-chain/comparison bindings, and an
importer-derived `importHash`. An
annotation cannot self-sign or relabel those bindings. Creation uses no-replace
semantics. Re-importing byte-identical content is idempotent; conflicting reuse
of the same path fails. The importer never writes beneath `runs/**`, so raw
outputs, parsed outputs, configs, and run manifests remain untouched.

Grader expertise is stored and reported verbatim as **declared expertise**. The
software does not promote it to verified expertise. Summaries report the exact
unique grader count, preserve every annotation and abstention, and list missing
expected grader IDs. Missing graders keep `gradingComplete` false and emit the
`missing_grader_annotations` blocker. Because this issue creates only authored
fixture annotations, `gradingComplete` also remains false and
`human_grading_not_completed` remains blocking even when every expected fixture
record is present. All v1 summaries remain simulated, authored-fixture, and
non-headline evidence.

## Input and workspace boundary

Schemas are strict. Creator source envelopes are descriptor-inspected before
authority resolution; fake comparison authority rejects without traversing its
record, and fake/proxied/revoked workflow bearers reject before proxy traps.
Authority-bound upstream validators own source parsing. Creator, validator,
import, and summary data boundaries reject accessors, proxies, cycles, exotic
prototypes, symbol properties, non-finite numbers, extra fields, duplicate
labels, duplicate graders, and identity collisions. Every grader-visible and
annotation string/key must contain valid Unicode scalar values. NUL/C0,
DEL/C1, and bidirectional override/isolate controls are rejected. Valid NFC and
NFD strings are preserved byte-for-byte; normalization is used only on a
temporary copy for leakage comparison. Public identifiers are path-safe.

As with the evaluation runner, the artifact root must be a trusted local
single-writer workspace. The importer rejects redirected annotation
subdirectories exposed as symbolic links and verifies their canonical descent,
but it is not a sandbox against a hostile same-account process racing filesystem
operations.

There is no CSV export in this issue. A later annotation export must neutralize
spreadsheet formula prefixes before emitting CSV.
