# PRD-010 — Orchestration, Contracts, and Integration

## Lane mission

Create the smallest reliable foundation for the directed human/LLM workflow: the single application scaffold, executable shared schemas, prompt registry, provider adapters, state machine, canonical run record, human checkpoint API, golden fixture, and final integration.

This lane owns shared files and is the only lane allowed to change the contract, manifests, lockfile, build/test configuration, environment validation, and shared API surface.

## Non-goals

- Implementing scholarly retrieval or provenance internals.
- Designing the product workbench.
- Producing benchmark results or submission narratives.
- Introducing an agent framework, database, authentication, queue, or deployment platform.

## Owned paths

- Root application manifests, lockfile, shared configuration, CI, and environment validation.
- `src/contracts/**`
- `src/server/models/**`
- `src/server/prompts/**`
- `src/server/workflow/**`
- `src/app/api/runs/**`
- The complete golden-run fixture and shared contract tests.
- Integration changes that cross lanes.

## Required design

### Single application

Scaffold one Next.js App Router TypeScript app using pnpm. Keep server-only workflow code outside client bundles. Provide consistent commands for development, type checking, linting, unit tests, eval smoke tests, and browser tests once they exist.

### Executable contract v0

Convert `docs/architecture/run-contract.md` into Zod schemas with JSON-serializable types. Include:

- intake, claims, and human decisions;
- sources, chunks, evidence cards, and separate verification layers;
- conclusions, gaps, experiment, review, revision, and final decision;
- node executions, provider/model/prompt metadata, usage/cost, evidence mode, and errors;
- lifecycle status and allowed transitions;
- schema version and safe additive evolution rules.

Build one complete golden fixture before another lane codes against the contract. The fixture must include support, contradiction, unresolved evidence, a metadata mismatch or unavailable check, an experiment objection, an accepted revision, an unresolved objection, and every human decision checkpoint.

### Directed state machine

Implement explicit nodes rather than free-form agent conversation:

1. clarify and decompose;
2. pause for scope approval;
3. collect the source packet through a lane 020 interface;
4. pause for packet review, rights checks, and immutable freeze;
5. extract evidence cards;
6. assess entailment and overclaiming;
7. synthesize conclusions and rank gaps;
8. plan one experiment;
9. review with a different model family;
10. pause for human objection dispositions;
11. revise accepted objections only;
12. pause for final approval and export.

Each node accepts and returns validated data. Invalid input, invalid model JSON, provider failure, policy refusal, timeout, or missing human decision produces a typed failure. Retries append execution records.

### Prompt registry

Prompts are versioned resources, not inline strings scattered through routes. Each prompt definition declares:

- stable prompt ID and version;
- node and provider capability requirements;
- rendered input schema and expected output schema;
- grounding and no-invention constraints;
- safety constraints;
- generation settings;
- change notes useful to benchmark reproducibility.

The strong baseline prompt is a first-class prompt that receives the same resolved scope, frozen source packet, required outputs, safety constraints, primary model, and generation limits as the workflow.

### Provider adapters

Expose the smallest common interface for structured generation while retaining provider-specific usage and request IDs. Provider/model IDs are server-only environment configuration and are written into every execution record.

The selected live candidate uses Featherless with `mistralai/Mistral-Large-Instruct-2411` for primary workflow nodes and `Qwen/Qwen2.5-72B-Instruct` for adversarial review. The reviewer was selected from bounded official-source research and one authenticated representative structured-output probe; that evidence establishes neither live-golden quality nor fixed-plan entitlement. Freeze it only after authenticated current-plan availability and representative refusal, latency, quota, cost, and quality checks in the live gate.

Requirements:

- application-side Zod validation regardless of provider structured-output claims;
- use Featherless's documented `response_format: {"type":"json_object"}` plus the prompt-appended schema and application-side Zod/invariant validation for both Featherless model families; hosted strict-schema support is not assumed;
- send only documented OpenAI-compatible messages, `max_tokens`, JSON-object response format, and ordinary generation settings; do not send retired Groq/NVIDIA reasoning or strict-schema extensions;
- allow at most one explicit, logged repair attempt after invalid output;
- explicit timeout, bounded retry, and typed failure;
- no silent model fallback during evaluation;
- primary and reviewer family must differ when heterogeneous review is claimed;
- a fake/fixture adapter for deterministic tests, labeled `fixture` or `mocked`;
- exact input/output object references suitable for the audit trail without logging secrets.

Monetary pricing is outside the MVP live gate. The current live invocation has no cost-basis input or pricing preflight, and its artifact config records `costBasis: null`. Provider-returned usage remains exact, while per-token rates, pricing snapshot, and estimated monetary cost remain `null`; no missing price may be encoded as zero. Historical artifact readers retain their original numeric pricing representations without making them valid current writes.

The smoke tests prove simple transport and one-field schema behavior only. They do not prove nested-schema reliability, refusal handling, rate limits, cost, domain quality, or a benefit from cross-family review.

### Run API

Provide a minimal API that can:

- create a run from validated intake;
- read the canonical run;
- submit a scope decision;
- continue an eligible run;
- submit reviewer-objection dispositions and final decision;
- return progress/execution state;
- export the final canonical run JSON.

Do not invent a general REST platform. In-memory/browser-local persistence behind a storage interface is sufficient for the first slice.

## Integration responsibilities

- Land contract requests before consumers depend on them.
- Integrate lane 020 source/evidence interfaces without weakening provenance invariants.
- Keep lane 030 fixture transport operational while connecting the live run API.
- Expose frozen prompt/model/source hashes to lane 040.
- Resolve root/config conflicts and run final cross-lane checks.

## Acceptance criteria

Contract and lifecycle:

- The golden fixture validates and round-trips through JSON.
- Every invalid lifecycle transition is rejected by a focused test.
- Scope approval, packet freeze, objection dispositions, and final approval pause, persist, and resume.
- Missing evidence, model refusal, invalid JSON, timeout, and retry remain visible in the run.
- A retry cannot erase the failed attempt.

Auditability:

- Every model node records provider, exact model, prompt ID/version, schema version, evidence mode, generation settings, timing, request/usage data when available, and validation outcome.
- Every attempt distinguishes requested and returned model, developer/base family, client end-to-end latency and provider-reported timing, response/request IDs, finish reason, refusal, reasoning mode, cached/reasoning tokens when available, and pricing-snapshot date.
- Fixture/model/source records cannot be mistaken for live evidence.
- Silent fallback causes a test failure in benchmark mode.

Integration:

- UI can render the golden fixture without network access.
- Eval runner can invoke both the baseline and complete workflow through stable interfaces.
- One live smoke run is attempted only after credentials exist; a blocked key or quota remains a blocked check.

Engineering checks:

- Type check, lint, focused unit tests, and contract tests pass.
- Secret scanning or an equivalent repository check confirms `.env.local` is untracked and no key appears in client bundles.
- Final diff does not include unnecessary frameworks or infrastructure.

## Required handoff

Use the shared handoff template. Include contract version, golden fixture path, commands, evidence mode, known additive-change requests, and the exact commit or state consumers should start from.
