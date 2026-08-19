# EvidenceForge

EvidenceForge is the **ReverieHacks 2026 Software Development** entry: a Next.js/React/TypeScript research workbench for testing claims against a bounded, verifiable evidence packet.

The hosted app guides a researcher from a question to a source packet, exact passage checks, model synthesis, adversarial review, a human decision, and a canonical export. It makes AI-assisted research inspectable rather than replacing a researcher.

## Why EvidenceForge

The product moat is the evidence boundary and its audit trail:

- **Bounded scholarly collection:** discover OpenAlex works, import permitted open-access PDFs, or paste researcher-authorized text.
- **Exact passage provenance:** evidence cards resolve to immutable source chunks and literal excerpts.
- **Separate judgment layers:** deterministic verification, model assessment, and human review remain distinct facts.
- **Research timeline:** retrieval attempts, packet edits, model runs, objections, decisions, retries, and failures stay linked.
- **Human checkpoints:** researchers approve scope, select and freeze the packet, dispose objections, and make the final decision.
- **Decision-changing gaps:** the workflow identifies missing evidence instead of producing generic “future work.”

The app does not claim measured superiority over a single-prompt workflow. The experiment stage proposes a bounded protocol; it does not execute a benchmark for the researcher.

## How the workflow works

1. **Start an investigation.** Describe the question, intended use, population, time horizon, constraints, and desired depth.
2. **Review claims.** The workflow turns the question into a claim contract that the researcher can edit and approve.
3. **Collect sources.** Search OpenAlex, inspect OA/license metadata, import a safe PDF or paste authorized text, and review ranked passages.
4. **Freeze the packet.** Confirm sources, rights, and selected chunks. The server records hashes and makes the packet immutable.
5. **Analyze evidence.** Extract candidate evidence, verify exact excerpts, assess entailment, and synthesize categorical conclusions.
6. **Inspect gaps and experiment.** Select a decision-changing gap and review a proposed, bounded experiment with explicit limits.
7. **Adversarial review.** Inspect typed objections and choose which revisions to accept.
8. **Decide and export.** Record the human disposition and download canonical JSON with provenance and failure history.

## Verified capabilities

- OpenAlex scholarly search and work metadata normalization;
- bounded trusted-origin HTTPS PDF download and `unpdf` text extraction;
- researcher-authorized pasted excerpts;
- deterministic claim-aware chunk ranking with packet limits;
- private process-local run caching with high-entropy access tokens and automatic expiry;
- immutable source/chunk hashes and exact literal-substring validation;
- separate store, display, and model-use rights;
- human scope, packet, objection, and final-decision checkpoints;
- categorical synthesis, selected research gaps, and canonical export.

Automated tests cover these contracts and mocked provider paths. A successful live end-to-end rehearsal is not claimed until it has been run against the deployed service with configured providers.

## Architecture and stack

| Layer | Implementation |
| --- | --- |
| Application | Next.js 16 App Router, React 19, TypeScript 6 |
| Contracts | Strict Zod schemas, cross-record invariants, versioned readers, canonical JSON |
| Workflow | Explicit server-side orchestration with typed failures and human checkpoints |
| Session state | Private in-memory cache, optimistic revisions, HttpOnly run tokens, inactivity expiry |
| Scholarly sources | OpenAlex metadata/search, OA PDF locations, optional Unpaywall DOI fallback, researcher paste |
| Model boundary | Featherless primary/reviewer adapters; model output is untrusted input |
| Evidence | Frozen packet hashes, rights decisions, exact passage references, categorical assessments |
| Verification | Vitest unit/evaluation contracts and Playwright browser journeys |

## Quick start

Prerequisites: Node.js 20.9 or newer and pnpm 11.16.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and choose **Start an investigation**. For local live mode, copy [.env.example](.env.example), set `EVIDENCE_MODE=live`, provide `RUN_TOKEN_SECRET`, `FEATHERLESS_API_KEY`, and optionally `OPENALEX_API_KEY`. Never expose credentials through `NEXT_PUBLIC_*` variables or commit them.

Hackathon sessions are intentionally ephemeral: they expire after two hours of inactivity by default, and completed runs are removed shortly after the final decision. A server restart also clears the cache.

## Verification

```bash
pnpm unit
pnpm exec vitest run --config evals/vitest.config.mts
pnpm lint
pnpm typecheck
pnpm build
pnpm exec playwright test --project=chromium --workers=1
```

The repository includes broad unit, evaluation, and browser coverage. The current verification record is automated-test coverage; no performance benchmark or successful hosted live rehearsal is reported here until the team records one. See [docs/demo/live-demo-script.md](docs/demo/live-demo-script.md) for the rehearsal procedure.

## Repository guide

- [Shared research-run contract](docs/architecture/run-contract.md) — lifecycle, invariants, provenance, and human checkpoints.
- [Workflow node reference](docs/submission/workflow-node-reference.md) — node inputs, outputs, and failure boundaries.
- [Research and product basis](docs/RESEARCH_BASIS.md) — dated competitive and design rationale.
- [Live demo script](docs/demo/live-demo-script.md) — four-minute judge walkthrough and screenshot checklist.

## Evidence boundary and current status

| Area | Honest status |
| --- | --- |
| Product experience | Live researcher workflow is implemented and hosted configuration is defined in `render.yaml`. |
| Source collection | OpenAlex metadata, trusted OA PDF ingestion, and authorized paste are implemented; availability depends on provider responses and rights. |
| Session lifetime | Private token-gated runs are cached in one process, expire after inactivity, and do not survive a server restart. |
| Live end-to-end result | Not claimed until a fresh hosted run completes all stages within one ephemeral session. |
| Comparative evaluation | No completed benchmark or superiority conclusion is claimed. |
| Experiment | Proposed and reviewable only; not executed by EvidenceForge. |
| Actor identity | Human decisions are labeled in the record, but actor labels are not authenticated accounts. |
| Devpost/organizer status | No organizer acceptance or submission completion is claimed by this repository. |

Render configuration provisions a Node web service, generated `RUN_TOKEN_SECRET`, a two-hour session cache, live evidence mode, and server-only provider variables. Deployments should check `/api/health` and complete a fresh investigation before being described as rehearsed.

## Safety, rights, and governance

- EvidenceForge is not a systematic-review service, autonomous scientist, or unrestricted web-research agent.
- It does not crawl arbitrary URLs, bypass paywalls, or infer permission from a DOI or metadata match.
- Open-access and license signals are evidence for review, not legal clearance. Store, display, and model-use rights are independent gates.
- PDF fetching is limited to HTTPS trusted-provider origins with redirect, private-address, size, and content-type safeguards.
- Hashes prove internal consistency, not source authenticity, completeness, continuing availability, or legal clearance.
- Experiment output is educational and reviewable. It does not authorize diagnosis, hazardous wet-lab work, deployment, or autonomous real-world action.
- Final approval is a human decision recorded for the run; actor labels are not authenticated identity proof.

EvidenceForge helps researchers test claims with inspectable evidence packets and explicit uncertainty.
