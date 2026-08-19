# EvidenceForge live demo script

This is a four-minute rehearsal script for the hosted app. It is a procedure, not evidence that the flow has already completed successfully. Do not invent counts, latency, provider success, or conclusions while presenting it.

## Exact claim

> For knowledge-grounded language generation, retrieval augmentation reduces factual hallucination compared with the same generation setup without retrieval, under a bounded evaluation protocol.

Frame this as a testable claim, not a conclusion. The packet and model outputs determine whether the result is supporting, limiting, conflicting, or insufficient.

## Candidate papers

Search OpenAlex for candidates such as:

- Shuster et al., *Retrieval Augmentation Reduces Hallucination in Conversation*.
- Saad-Falcon et al., *RAGTruth: A Hallucination Corpus for Developing Trustworthy Retrieval-Augmented Language Models*.
- A paper addressing retrieval noise, evidence quality, or failure modes in retrieval-augmented generation.

These are candidate searches, not pre-approved evidence. Confirm the returned OpenAlex record, OA location, license signal, exact title, and passages in the UI.

## Four-minute walkthrough

### 0:00–0:35 — Start and scope

1. Open the hosted landing page.
2. Click **Start an investigation**.
3. Enter the exact claim above and intended use: “Assess whether retrieval improves factual reliability in a bounded model evaluation.”
4. Approve or edit the generated claim contract.

Truth label: claim decomposition is model-assisted and researcher-approved; it is not evidence.

### 0:35–1:35 — Build the packet

1. Open **Sources** and search OpenAlex.
2. Select candidate records with a visible OA location.
3. Import permitted PDFs or paste a researcher-authorized excerpt.
4. Open each source card and show title, DOI/OpenAlex ID, OA/license signal, retrieval location, and rights controls.
5. Select passages that bear on the claim, including a limitation or counterpoint when available.
6. Click **Review packet**, then **Freeze packet**.

Truth label: OA metadata does not establish authority, completeness, entailment, or legal clearance. Freezing records the bounded packet; it does not make sources universally true.

### 1:35–2:35 — Trace the evidence

1. Click **Analyze packet** and let stages advance.
2. Open one supporting evidence card and show its exact excerpt, source chunk ID, location, content hash, and verification status.
3. Open one limiting or unresolved card.
4. Expand the timeline to show retrieval, packet freeze, model attempts, and any retry/failure event.
5. Show the categorical conclusion and selected decision-changing gap.

Truth label: deterministic checks verify identity and exact text; model assessment is untrusted input; human review remains separate.

### 2:35–3:20 — Review and decide

1. Open the proposed experiment and point out that it is a protocol, not a completed measurement.
2. Open adversarial review.
3. Accept one objection and leave another unresolved, if present.
4. Record the final human decision and rationale.

Truth label: no performance number is presented unless it was measured outside this run and explicitly sourced.

### 3:20–4:00 — Export and session boundary

1. Export canonical JSON and show the packet fingerprint, source/chunk hashes, decisions, objections, and execution history.
2. Point out the private session badge and two-hour inactivity limit.
3. Explain that completed runs are discarded shortly after the final decision and a service restart clears all cached research data.

Truth label: the cache is a hackathon convenience, not durable research storage or authenticated identity.

## Recovery branch

If a provider is unavailable or an OA PDF cannot be safely fetched:

1. Keep the source metadata-only or use a researcher-authorized paste.
2. Show the visible warning and timeline failure/retry event.
3. Continue only with sources whose rights and text are actually available.
4. State: “EvidenceForge fails closed and preserves the limitation; it does not fabricate a passage.”

If the run cannot complete live, switch to recorded automated-test evidence and say so explicitly. Do not call a fixture or mocked result a live conclusion.

## Rehearsal checklist

- [ ] Render service is on the intended commit and `/api/health` is healthy.
- [ ] OpenAlex and model-provider variables are configured server-side.
- [ ] Run token is private, HttpOnly, Secure, and absent from clean URLs.
- [ ] Health reports the intended process-local cache TTL and restart boundary.
- [ ] A fresh run starts without preloaded battery or fixture content.
- [ ] At least two source candidates can be reviewed with visible provenance and rights state.
- [ ] A PDF, or authorized paste fallback, produces exact inspectable passages.
- [ ] Freeze makes the packet immutable and displays its fingerprint.
- [ ] Timeline records stages, retries, and failures honestly.
- [ ] Experiment is described as proposed, not executed.
- [ ] Human decision is recorded with its actor-label caveat.
- [ ] Canonical export downloads and parses as JSON.
- [ ] A completed run expires on the documented short retention schedule.

## Screenshot shot list

1. Welcoming landing page with **Start an investigation** CTA.
2. Approved claim contract with scope and intended use.
3. OpenAlex results showing OA/license metadata.
4. Source card with exact passage, location, and rights state.
5. Packet review before freeze.
6. Frozen packet fingerprint and source/chunk counts.
7. Evidence matrix with one supporting and one limiting passage.
8. Expanded provenance timeline.
9. Proposed experiment with inferential limits.
10. Adversarial objection disposition and final human decision.
11. Canonical export confirmation.
12. Ephemeral-session badge and expiry disclosure.
