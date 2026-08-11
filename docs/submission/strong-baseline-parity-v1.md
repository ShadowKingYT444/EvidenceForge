# Strong single-prompt baseline parity v1

This development-only condition prepares one comprehensive-call baseline without calling a model or provider. It reuses the accepted `strong-single-prompt-baseline` resource directly from the versioned prompt registry. The implementation does not copy, shorten, or replace the registry system message, output schema, grounding rules, or safety rules.

Each development case is mapped into the shared frozen-run contract with the case's exact source-hash and chunk-hash membership. The shared baseline request builder then emits the user payload. The stored context and the actual user-message bytes are that same payload after validation by `parsePromptInput("strong-baseline", ...)`; there is no lane-local runtime input schema or alternate model-visible representation.

## Honest evidence boundary

- Evidence mode: `fixture`.
- Reporting use: `development`.
- Headline eligibility: `false`.
- Provider calls, live responses, measured latency, token usage, cost, model quality, benchmark scores, and workflow-improvement claims: not produced.
- The preserved refusal and invalid-output bodies are clearly authored structural fixtures, not provider output.
- The canonical-output validator is exercised against the existing frozen golden fixture only to prove schema handling. That output is not attributed to either development case and is not materialized as a baseline result.

## Exact accepted prompt edge

- Prompt: `strong-single-prompt-baseline@1.0.0`
- Prompt hash: `278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f`
- Prompt-manifest hash: `4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e`
- Protocol schema hash: `caa468800f311a214cc71a360b4720f07e8fa77ada926ba2869e8f705bb08015`

The baseline and complete-workflow comparison configs share the exact case definition, resolved scope, source packet and chunk membership, deterministic metadata facts, primary fixture model identity, generation limits and settings, output schema and required fields, safety constraints, full prompt manifest, retry/fallback policy, trial plan, exclusion policy, evidence mode, and benchmark-code version. Protocol v1 therefore produces one equal pairing hash while retaining distinct condition config hashes. The version must be a lowercase 40-hex Git SHA. The table below records the frozen default; explicit alternate SHAs remain first-class versioned fixture identities rather than being collapsed back to that default.

The only declared differences are:

1. the condition identifier;
2. the baseline uses one comprehensive call; and
3. the workflow uses staged execution and adversarial review.

These differences are explicit and do not weaken the model-visible baseline context.

## Canonical development manifests

| Development case | Context hash | Pairing hash | Comparison-invalidating hash | Baseline config hash | Workflow config hash | Bundle hash |
|---|---|---|---|---|---|---|
| `library-lighting-schedule` | `4e86b1d2289e83c25797095ad9114f066319560df6b102dce0ef3481ad11f0a4` | `539f165b45cde428bb378cff42196ac0689d9618d4a5e5186c11e733c6d69b6f` | `fb28ecca73186950b0330daab95c1bd00f5d4a8d9acff096d200c72fa586ff1f` | `9bac4800fb55dbee1d8d78f0942dae95cb51919f88d76ba935a0c95a6415df20` | `83e5dc99a5fd4332b1bdeaa25b2ebce4b24c687cc6cde242f2f47dfd954cc9e1` | `7ed4377f32f65a1adcab1cf96e45d62315a1c7137009e69c6a4e0fba829b15ca` |
| `bounded-retry-reliability` | `eb7441610e6fd10877112a387be5d03ba5796eab77c298c95090a6d6b790998a` | `8cccb14d8fafb62df6e380db096bce713fc616ea707996a77da7eb7ab8c39981` | `b3ae5fe83911432c8fb5d03265efce92982fadd7324707fa9c5fe143fac57908` | `b56182d949c54cef63f2563d6b03acbaf117d2478f3dbe465d91162341bec45c` | `d1b826d142d8c3b9c35ac5c46f3f2e8453a20d2c24e96315153ed13bbccf562b` | `468c6965583202978703fc84cfdef1857b9d36def52ca15398abf4058efda9af` |

The comparison-invalidating hash binds the protocol/condition hashes, prompt-manifest hash, exact canonical context hash, every field-level parity hash, accepted baseline prompt descriptor, shared pairing hash, and the three declared differences. A missing or extra context field, changed context bytes, model, limits, schema, required-field set, safety policy, prompt, packet, metadata, protocol binding, or hash fails validation.

Bundle and manifest creation additionally require byte equality with one of the two privately owned accepted development-case snapshots. A caller may use an ordinary detached clone of either accepted case, but `createDevelopmentCase` cannot mint a third eligible case merely by producing a self-consistent case and recomputing every dependent hash.

The exported bundle validator applies the same authority independently of factory provenance: direct `parse` and `safeParse` compare the bundle case ID, both canonical benchmark-case bytes/hashes, and the canonical accepted model input with the private two-case authority. The raw structural Zod schema remains internal, so cloned, JSON-roundtripped, or fully rehashed caller bundles have no public structural-only validation path. Attempt and sequence structural schemas are also internal. Their public acceptance functions require a separately held process-local run authority; the output validator is response-schema-only and cannot confer case or run eligibility.

The accepted case set and benchmark-condition definitions are eagerly deep-owned and deep-frozen before any export or trusted hash calculation. Public case and condition views are detached from the private canonical sources. Nested alias mutation, first-use or post-use mutation, element replacement, and reordering therefore cannot change the accepted case authority, condition-matrix hash, condition-spec hash, or config hash.

## Private scoring boundary

Model input is constructed only through the accepted shared baseline request builder from the mapped frozen run. Grader instructions, chunk expectations, coverage labels, known-contradiction keys, expected-abstention keys and rationales, experiment-limitation keys, and other scoring-only fields are structurally absent from the mapped run, canonical context, and prompt messages. Tests check both private property names and private values for leakage.

## Preserved attempt fixtures

For each development case, the accepted runner materializes one addressable parent smoke run and one explicit rerun. Across those two runs it preserves four failed attempts in order:

1. timeout;
2. refusal;
3. invalid structured output; and
4. provider transport failure.

Every raw attempt contains a strict baseline evidence envelope with the requested model, returned-model availability, raw provider output or explicit `null`, canonical output or explicit `null`, schema/validation status, usage availability, cost availability, fixture latency, attempt number, retry parent, retry reason, and retry decision. Success and `valid` status require the exact raw body to pass the shared strong-baseline output schema, match the canonical output and recomputed hash, and bind the accepted registry output-schema ID, version, and hash; caller labels and hashes cannot promote arbitrary content. Refusal and invalid-output fixtures require their preserved authored raw bodies, while timeout and provider-transport no-response fixtures require `null`. Returned-model identity must equal the requested model whenever available, and the unavailable reason is explicit.

A retry sequence is one immutable chain: every member has the same run ID, parity/config binding, requested model, and validation-schema binding; numbering is contiguous; each retry points to the exact preceding attempt ID; and the reason is derived from that preceding failure. A retryable first timeout, invalid output, or provider-transport failure must continue to attempt two. Success and refusal stop immediately, and attempt two is always terminal. Independently addressable parent and rerun attempts cannot be spliced into a new accepted chain.

Those identities are not trusted merely because every caller-supplied attempt agrees. During materialization, the implementation issues distinct opaque parent and rerun authorities from the already private-authorized bundle and exact runner configuration. Each authority is mapped out of band to detached expected identity bytes covering the accepted case, exact benchmark-code SHA, deterministic run ID, registry prompt/output schema, protocol pairing, parity bundle/config hashes, and configured primary model. Public attempt and sequence validation resolves that authority before traversing the evidence and compares every record to its external expected identity. The record's own code SHA can never select its trusted comparison target. Replacing every asserted hash, model field, run/attempt label, or code SHA consistently still rejects under the original authority, as does splicing attempts, retries, parents, or reruns across versions, cases, or runs.

The authority is an immutable process-local bearer capability, not a serializable credential or artifact field. The same in-memory reference may be deliberately shared with a trusted validator, but clones, spreads, JSON forms, structural fakes, and proxy wrappers have no authority. Persisted attempt JSON remains structurally auditable and can be accepted in the issuing process when the matching authority is retained separately. JSON alone cannot recreate acceptance in a fresh process; that process must independently re-establish the trusted run configuration through an authorized materialization step. This is an explicit process-local limit, not a claim of portable cryptographic provenance.

The smoke fixtures structurally require zero milliseconds as an authored deterministic value with `measured=false`. Usage and cost are structurally unavailable with explicit fixture reasons, and returned-model metadata is unavailable for the authored failure fixtures. Available provider telemetry cannot be fabricated inside this fixture-only evidence envelope. These values must not enter a measured or headline result table.

## Passive-data boundary

Public creators, bundle validators, output validators, authority-bound attempt validators, and the smoke materializer take a detached descriptor snapshot before cloning or schema traversal. Attempt validators first resolve the process-local authority, so a fake, clone, JSON form, spread, or proxy wrapper rejects without traversing even an accessor-bearing evidence value. Accepted evidence inputs contain only finite JSON primitives, ordinary arrays, and ordinary or null-prototype objects with enumerable data properties. Accessors, custom prototypes, symbol keys, sparse/extended arrays, cycles, functions, and other active values reject without invoking an ordinary getter. Frozen and null-prototype passive objects remain valid, and later caller mutation or shared evidence aliases cannot change returned canonical evidence.

This is an ordinary-object descriptor boundary, not a claim that arbitrary JavaScript `Proxy` evidence objects can be detected without executing proxy traps. Same-process callers must not pass proxies as evidence data; the data assurance claim covers ordinary objects and property descriptors only. The narrower authority check is identity-based: a proxy wrapper is a different object, so it rejects without inspecting or invoking the wrapper.

## Determinism and containment

The implementation and tests prove:

- canonical object ordering and byte-identical materialization in independent temporary roots;
- exact context-byte equality between baseline and workflow;
- packet, context, parity, config, comparison, request, and bundle hash tamper rejection;
- strict output validation for valid and invalid fixture values;
- default and multiple alternate 40-hex code versions for both accepted cases, with cross-version substitution rejection;
- explicit parent/rerun addressing with the same frozen comparison config;
- no-overwrite behavior that leaves every prior artifact byte unchanged;
- traversal rejection before artifact-root creation; and
- fixture/development/non-headline classification that cannot be relabeled live.

Artifact roots remain trusted local single-writer workspaces under the documented runner threat model. This condition does not expand that runner into a same-account hostile-filesystem security boundary.
