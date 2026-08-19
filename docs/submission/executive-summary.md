# EvidenceForge executive summary

EvidenceForge is a live researcher workflow for testing a claim against a bounded, researcher-approved packet. It combines scholarly discovery, exact source passages, deterministic integrity checks, model assessment, human checkpoints, adversarial review, and canonical export without collapsing those layers into one opaque answer.

## Product path

1. A researcher defines a question and intended use.
2. A hosted model proposes a testable claim contract; the researcher approves it.
3. The researcher discovers OpenAlex works, imports permitted open-access PDFs, uploads an authorized PDF, or pastes an authorized excerpt.
4. The server ranks passages, records separate store/display/model-use rights, and freezes source and chunk hashes.
5. Live workflow nodes extract evidence, assess entailment, synthesize categorical findings, identify a decision-changing gap, and propose a bounded experiment.
6. A heterogeneous reviewer raises typed objections. Human dispositions control which revisions may be applied.
7. The researcher records a final decision and exports the canonical run.

## What is implemented

- Next.js/React/TypeScript software application with a live researcher workflow.
- Private process-local run caching with optimistic revisions and automatic inactivity expiry.
- Private high-entropy run tokens stored as HMAC digests and delivered through HttpOnly cookies.
- OpenAlex search, bounded OA PDF retrieval, PDF text extraction, authorized paste/upload paths, and claim-aware chunk ranking.
- Exact excerpt validation, immutable packet fingerprints, visible execution failures, timeline projection, and canonical JSON export.
- Responsive warm research-studio interface with reduced-motion support.

## Honest boundary

No successful hosted rehearsal is claimed until the deployed Render service completes the documented live demo. Cached runs intentionally do not survive a restart and expire after inactivity. Model outputs remain untrusted input. OA metadata is not legal clearance or proof of entailment. Experiment output is a proposed protocol, not an executed measurement. Human actor labels are declared rather than authenticated accounts. EvidenceForge is not a systematic-review service, paywall bypass, arbitrary crawler, or autonomous scientist.

The judge rehearsal procedure is documented in [the live demo script](../demo/live-demo-script.md).
