# Deep Research Basis

This document records the product and engineering rationale behind the PRDs. It is a dated research snapshot, not a progress log.

Research date: July 17, 2026.

## Decision

Proceed conditionally with a deliberately narrow product:

> A human-governed decision record that turns one frozen, approved source packet into a falsifiable next experiment while preserving every claim-to-passage link, verification layer, objection, human disposition, revision, failure, and workflow ablation.

The bounded ReverieHacks repository/demo uses **EvidenceForge: an Auditable Claim-to-Experiment Workflow** after an explicit human decision to accept documented exact-name collision risk. This is not trademark/legal clearance, exclusivity, registrability, or affiliation with another EvidenceForge project. The product is evidence-literacy and experiment-design support for student researchers. It is not a search engine, systematic-review service, citation graph, citation validator, or autonomous scientist.

## Evidence labels used here

- `confirmed`: supported by current primary documentation or a live endpoint check.
- `likely`: a reasoned implication that still needs product testing.
- `untested`: not exercised or not measured yet.
- `rejected`: tested or researched and deliberately excluded.

## Product and competitive research

Current products already cover most broad literature-assistant claims:

| Product | Confirmed documented capability | Consequence for this product |
|---|---|---|
| [Elicit](https://elicit.com/solutions/reports) | Search, screening, extraction, reports, exact supporting quotes, human control, auditability, and factored workflow blocks | Auditability and workflow decomposition alone are not novel. |
| [Consensus](https://help.consensus.app/en/articles/9922673-how-consensus-works) | Collection-scoped analysis, claims/evidence tables, gap analysis, citation graphs, and research-agent modes | Do not compete on synthesis, gaps, or graphs alone. |
| [scite](https://scite.ai/) | Citation-context search and support/contrast/mention classifications | A citation context is not proof that a selected passage entails a user's claim. |
| [ResearchRabbit](https://www.researchrabbit.ai/features) | Graph-based discovery, collections, recommendations, and paper/author maps | A graph is familiar and should be an optional index, not the product's source of truth. |
| [Undermind](https://www.undermind.ai/) | Recursive search, citation trails, reports, inline traceability, novelty and gap analysis | Do not claim search completeness or gap discovery as the wedge. |
| [FutureHouse](https://www.futurehouse.org/research-announcements/launching-futurehouse-platform-ai-agents) | Literature agents, contradiction and novelty questions, experiment planning, and end-to-end scientific workflows | Avoid the “AI scientist” frame; lead with bounded inputs, human governance, and measured workflow effects. |

The differentiating combination is:

1. a human-approved claim contract;
2. a bounded and frozen source packet;
3. deterministic identifier/metadata checks separated from model entailment and human review;
4. one safe experiment linked to the chosen evidence gap;
5. objection-by-objection human dispositions and selective before/after revisions;
6. a fair baseline and node ablations that test whether the workflow actually helps.

Competitor behavior behind paid accounts is `untested`; only owner-published documentation was reviewed.

## Product surface

Build two routes, not a dashboard suite:

### 1. Intake and scope

- question, intended application, budget/materials, time horizon, population/geography, and explicit constraints;
- no more than three high-value clarifying questions;
- editable claim contract with add, remove, and operational-definition controls;
- blocking human approval before source processing.

### 2. Run workbench

- header with resolved scope, lifecycle state, packet hash, and evidence-mode label;
- claim tree at left;
- evidence matrix as the P0 center view, with claims as rows, sources as columns, and labeled relationship cells;
- evidence drawer with exact passage, location, content scope, limitations, and separate verification layers;
- gap, experiment, objection disposition, selective revision diff, and residual risk at right;
- expandable audit rail showing real node attempts, failures, retries, prompt/model identifiers, validation, latency, and usage;
- sticky human decision bar for objection dispositions and final approval.

An evidence graph is P1. If built, it shares selection state with the matrix and every edge resolves to an evidence-card ID. This follows current [WCAG 2.2](https://www.w3.org/TR/WCAG22/) requirements for keyboard access, visible focus, and meaning beyond color; the matrix/list remains the accessible source of truth.

## Retrieval, provenance, and rights

The bounded packet model is `confirmed` as feasible. The first slice uses five to eight user-approved titles, abstracts, or excerpts and does not fetch arbitrary publisher pages or PDFs.

### Provider responsibilities

| Provider/input | Responsibility | Never claim |
|---|---|---|
| [DOI Foundation](https://doi.org/help.html) | Canonicalize a DOI, identify its Registration Agency, and test resolver behavior | That the work is accurate, accessible, or supports a claim |
| [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/) | Depositor metadata for Crossref DOIs plus update/correction/retraction relations | That every DOI is a Crossref DOI or that linked text is reusable |
| [OpenAlex](https://developers.openalex.org/api-reference/authentication) | Discovery and user selection plus secondary OA/location/integrity signals | Authoritative metadata, display rights, or entailment |
| User excerpt | Exact text, location, and rights attestation supplied by the user | Independent legal validation |
| Model | Passage-level support/contradiction/insufficiency assessment | Deterministic truth or completed human review |

A live probe confirmed the key Registration Agency boundary: `10.5281/zenodo.19695957` resolves through DOI.org and is a DataCite DOI, while Crossref returns 404 and OpenAlex finds it. Therefore a Crossref 404 means `record_not_found` for that provider, never “DOI does not exist.” The MVP returns `unsupported_agency` for non-Crossref metadata until a deliberate DataCite adapter exists.

The source contract must keep these states separate:

- DOI syntax and resolution;
- Registration Agency;
- provider-specific metadata result and field-level diffs;
- integrity notice result, including the difference between a notice and the affected work;
- content scope and access state;
- exact version/location license;
- `mayStore`, `mayDisplay`, and `maySendToModel` rights;
- model assessment;
- human confirmation or override.

Crossref links can require subscriptions or TDM agreements. OpenAlex metadata is CC0, but discovered or cached PDFs keep their original copyright. OA labels, null licenses, and link presence do not establish redistribution or model-use permission. See [Crossref TDM guidance](https://www.crossref.org/documentation/retrieve-metadata/rest-api/text-and-data-mining/) and [OpenAlex's full-text warning](https://developers.openalex.org/download/full-text-pdfs).

Golden-run content is manually supplied and displayable. Hash exact UTF-8 chunks with SHA-256 and derive the packet fingerprint from sorted source/chunk hashes using [RFC 8785 canonical JSON](https://www.rfc-editor.org/rfc/rfc8785.html). The fingerprint proves internal immutability, not source authenticity.

Source text is untrusted input. Delimit it, give it no tools or authority, validate structured output, and derive visible quotes only after deterministic chunk-ID and literal-substring validation. Arbitrary server-side URL fetching is rejected for the MVP because it introduces SSRF and content-rights risk. See [OWASP prompt-injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

## Workflow and model research

Use explicit typed functions and blocking human decisions for scope, packet freeze, objection dispositions, and final approval. Do not use a conversational agent swarm, open-ended loops, or a workflow framework.

Provisional live pairing:

| Role | Provider/model | Current evidence |
|---|---|---|
| Primary | Featherless `mistralai/Mistral-Large-Instruct-2411` | `unverified` for application traffic and current-plan access; Featherless's public model page reported the exact model warm on 2026-08-11 |
| Reviewer | Featherless `Qwen/Qwen2.5-72B-Instruct` | authenticated representative structured-output probe passed on 2026-08-11; application live-golden quality and fixed-plan entitlement remain `unverified` |

The current executable live path uses Featherless's OpenAI-compatible chat-completions endpoint with one server-only credential and distinct Mistral and Qwen model families. It sends ordinary messages, `max_tokens`, and Featherless's documented `response_format: {"type":"json_object"}` while retaining the exact prompt-appended schema and local Zod/workflow-invariant validation with at most one logged repair attempt. The versioned transport policy claims JSON-object mode, not hosted strict JSON Schema. Its live-only output-limit policy reserves 2,048 completion tokens for both primary and reviewer calls while timeout policy 2.0 gives each transport attempt its own 120-second hard deadline. The attempt ceiling remains two, so transport time is bounded to 240 seconds plus at most one existing one-second retry backoff; no repair, retry, fallback, or concurrent path can create a third attempt. The shared prompt registry, fixture path, and benchmark defaults remain at 4,096. Monetary pricing is not evaluated by the MVP live writer: it accepts no cost-basis input, records `costBasis: null`, preserves exact returned token usage, and leaves rates, pricing snapshot, and estimated cost `null` rather than synthesizing zero. It does not claim current-plan availability, refusal semantics, nested-schema reliability, live-golden quality, quota, latency, cost, or fixed-plan entitlement. The preserved bounded live attempt was not an end-to-end success: extraction and entailment succeeded, synthesis succeeded after one repair, and both experiment-planning attempts failed application-schema validation. The exact DeepSeek r11 predecessor, Mistral a2cdf/134710 shared-deadline predecessor, immediate GPT-OSS predecessor under the same compact prompt manifest, earlier GPT-OSS 4,096-token timeout, and three Qwen primary timeouts remain readable historical Featherless evidence under their original pricing representations, and historical Groq/NVIDIA artifacts remain readable under their original provider/model identity; none is relabeled as current evidence.

The older `nvidia/llama-3.3-nemotron-super-49b-v1.5` pairing is `rejected` for now: the live test returned no content before a 128-token reasoning limit, while Nemotron 3 Super completed the same small task with thinking explicitly disabled.

These smoke calls prove only basic transport and simple schema behavior. Nested-schema reliability, refusals, rate/quota behavior, cost, domain quality, and whether cross-family review improves experiments remain `untested`. Freeze exact IDs only after representative prompt spikes.

## Evaluation design

Use two development cases while prompts and schemas change, then freeze six held-out benchmark cases across two or three safe domains. Run three trials per eligible condition to reveal stochastic failure rather than reporting one lucky output.

Core conditions:

1. strong single-prompt baseline;
2. full workflow;
3. no-verification ablation;
4. no-adversarial-review ablation.

The baseline receives the same resolved scope, normalized/frozen packet, deterministic metadata facts, primary model, generation limits, output requirements, and safety rules. A changed prompt, model, packet, fallback, or code version invalidates a pair unless all paired conditions are rerun.

Programmatic measures cover identifier/metadata checks, requirement coverage, experiment-field completeness, contradiction recall against a frozen key, schema/error rates, latency, calls, tokens, and estimated cost when available. Human graders assess entailment, unsupported claims, overclaiming, experiment validity, correction effort, and blind preference. Raw outputs, parsed runs, computed metrics, and human annotations remain separate.

If the pitch claims that cross-family review itself adds value, add a small same-family-versus-cross-family reviewer ablation on three cases. Otherwise describe heterogeneity as a design safeguard, not a measured result.

## Competition and operational constraints

Current official pages conflict: the [Devpost overview](https://reverie-hacks-2026.devpost.com/) and [event site](https://www.reveriehacks.org/) say August 2–17, while the [rules](https://reverie-hacks-2026.devpost.com/rules) say August 3–17. The project conservatively uses August 3 as its implementation boundary, and repository provenance records no product implementation before August 6. The captured official submission requirements say four files but list only workflow PNG, samples, and documentation. Resolving the four-versus-three ambiguity is an external Devpost submission task, not a blocker to publishing independently verified software. No unnamed fourth file is inferred.

The event judges innovation, problem solving, sustainability/scalability, UX/design, and exceptionality. The judge-facing proof should therefore show one preserved baseline failure, one traceable contradiction, separate verification states, one objection-driven revision, real repeated results, and a readable workflow artifact.

## Installation and external-service conclusion

No global software is required by the design. Project setup verifies Git, Node.js, pnpm, FFmpeg, and required server-only provider credentials without publishing local credential state. Docker, a database, Python packages, a global Mermaid install, LangChain/LangGraph, paid research tools, and competitor APIs are unnecessary.

Later project-local development dependencies should include Next.js/React/TypeScript, Zod, one OpenAI-compatible client, Vitest, Playwright, an accessibility scanner, and Mermaid CLI. `@xyflow/react` remains optional until the matrix works. NVDA is an optional Windows install for a screen-reader smoke test.
