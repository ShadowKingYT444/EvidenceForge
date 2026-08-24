# EvidenceForge recorded RAG demo script

## Setup

Open the EvidenceForge home page. Say:

> Live research is unpredictable in a stage demo because scholarly APIs and model quotas can fail. This example is a transparent recorded run: the source packet, exact passages, model judgments, and human decision were compiled in advance. The interface and audit model are the same, but no provider call happens during the presentation.

Click **Retrieval vs. hallucination · recorded demo**.

## During the replay

Let the replay run for several seconds.

> EvidenceForge is not a chatbot. It is a workflow for turning a research question into an inspectable decision record. The replay starts with a bounded claim contract, then shows discovery, screening, import, exact-passage extraction, primary verification, independent review, and packet freeze.

> In a live run these are real network and model operations. Here they are deterministic events backed by a frozen packet, which makes the demo reliable while preserving the same artifact model.

Optional: click **Narrate replay** to have the browser speak each operation.

## Scope

Open **Scope**.

> The question is not “Does RAG solve hallucination?” That is too broad. We decompose it into three falsifiable claims: whether RAG improves factuality, whether the benefit depends on retrieval quality, and whether a production system needs evidence-level evaluation and provenance.

> This claim contract prevents the model from quietly changing the question after seeing the evidence.

## Sources

Open **Sources** or return to it and click **Skip replay**.

> We screened a recorded set of 200 candidate records and retained ten primary scholarly sources. Four directly support a factuality benefit, three define evaluation and provenance requirements, and three expose failure modes.

Select **Retrieval Augmentation Reduces Hallucination in Conversation**.

> This is the strongest direct source for the claim. Human evaluators found substantial reduction in knowledge hallucination in knowledge-grounded dialogue.

Select **When Not to Trust Language Models**.

> This paper gives us the conditional result: retrieval helps significantly on long-tail facts, but can hurt on popular facts when retrieved context is misleading.

Select **Toward Robust RALMs**.

> This is challenge evidence. Unanswerable, adversarial, or conflicting document sets can make a retrieval-augmented model hallucinate. EvidenceForge keeps this beside the supporting evidence instead of hiding it.

## Evidence

Open **Evidence**.

> Every row exposes the exact passage immediately. The four checks on the right are deliberately separate: deterministic text and provenance validation, a primary model assessment, an independent model review, and a recorded human status.

> The moat is not “we call two models.” The moat is the evidence graph and its audit contract. Claims point to exact passages; passages point to immutable source records; judgments retain provider and execution identity; objections and human dispositions remain in the final record.

> That structure makes the system useful in regulated research, diligence, safety reviews, policy analysis, and any decision where “the AI said so” is not acceptable.

## Review

Open **Review**.

> Independent review produces objections, not a second polished answer. We accepted the task-generalization and bad-retrieval objections into the conclusion. We leave automated-judge calibration unresolved because a model judge is still not ground truth.

> EvidenceForge never erases the losing side of the argument. The unresolved issue travels into the final decision packet.

## Decision

Open **Decision**.

> The bounded decision is to adopt RAG for a pilot with evidence-quality gates. The evidence supports improved factuality on knowledge-intensive and long-tail questions, but not a universal hallucination fix.

> The operational requirements are retrieval relevance, answer faithfulness against exact passages, provenance, abstention when evidence is weak, and human review for consequential use.

> The packet fingerprint makes the reviewed evidence set addressable. If a source, passage, or judgment changes, the record changes. That is the GitHub pull-request analogy: you can see what changed, why it changed, and who accepted it.

## Technical architecture and moat

Use this concise explanation if judges ask how it works:

> The runtime is a typed state machine. Each transition requires the expected revision, so stale actions fail closed. Source adapters normalize OpenAlex and licensed web retrieval into the same source and chunk contracts. Exact text is hashed before model review. Primary and reviewer models must be independent providers. The packet freezes only when passage count, claim coverage, rights, literal matching, and review requirements all pass.

> The durable advantage is accumulated verified structure: reusable source records, exact passage lineage, deterministic checks, independent judgments, failure history, objections, and human decisions. A generic RAG app returns an answer. EvidenceForge returns an auditable object that can be reviewed, challenged, exported, and compared over time.

## Honest demo disclosure

If asked whether the run is live:

> This specific route is prerecorded and labeled that way because the demo must not depend on third-party quotas. EvidenceForge also supports live runs; the recorded route uses the same conceptual workflow and evidence artifacts without claiming that prerecorded events are live.
