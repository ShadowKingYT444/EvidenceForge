# EvidenceForge

EvidenceForge is an independent ReverieHacks 2026 ML Prompt Engineering entry: an auditable claim-to-experiment workflow for bounded, user-approved source packets. It is not affiliated with Cisco Talos or any other project using the same name, and no trademark or exclusivity claim is made.

The project turns a scientific question and a frozen, user-approved source packet into:

- a human-approved set of testable subclaims;
- source-linked evidence cards with exact excerpts and limitations;
- separate metadata, entailment, and human-review states;
- a support/contradiction/unresolved evidence view;
- calibrated conclusions and a specific research gap;
- a falsifiable experiment, independent critique, revision trail, and final human approval.

The winning claim is not “AI searches all of science.” Existing products already cover search, evidence tables, quote tracing, citation graphs, gap analysis, and research agents. The claim to test is that a human-governed decision record can reduce unsupported claims and improve experimental completeness compared with a strong single-prompt baseline using the same model, scope, deterministic metadata facts, and frozen source packet.

## Readiness boundaries

Product implementation begins after the later published start boundary, August 3, 2026. Eligibility, team size, source rights, provider capabilities, and the intentional public baseline are reviewed before implementation. The official ML page still says four submission files while naming only workflow PNG, samples, and documentation; the unknown fourth artifact remains a final release blocker and is never guessed.

## Workspace map

- [Deep research and decision basis](docs/RESEARCH_BASIS.md)
- [Product PRD](docs/prd/PRD-000-product.md)
- [Orchestration and contracts PRD](docs/prd/PRD-010-orchestration-contracts.md)
- [Retrieval and provenance PRD](docs/prd/PRD-020-retrieval-provenance.md)
- [Evidence workbench PRD](docs/prd/PRD-030-evidence-workbench.md)
- [Evaluation and submission PRD](docs/prd/PRD-040-evaluation-submission.md)
- [Shared run contract](docs/architecture/run-contract.md)
- [Workflow diagram source](docs/architecture/workflow.mmd)

## Intended build order

1. Establish a reviewed public baseline after eligibility, naming-scope, source-rights, and provider gates.
2. Scaffold the single TypeScript app, freeze contract v0, and supply one complete golden fixture.
3. Build provenance, the workbench, and the evaluation harness in parallel against that fixture and contract.
4. Integrate and verify the live vertical slice without removing fixture mode.
5. Freeze retrieval results, run the fair baseline and ablations, and generate submission artifacts from real outputs.

No database, Docker install, autonomous crawler, global CLI, or paid literature platform is required for the first vertical slice.
