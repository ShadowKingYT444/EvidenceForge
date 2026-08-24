export const ragDemoQuestion =
  "Does retrieval-augmented generation reduce factual hallucination in knowledge-grounded language generation compared with the same model without retrieval?";

export const ragDemoApplication =
  "Choose an evidence-grounding architecture for a domain-specific research assistant.";

export const ragDemoClaims = [
  {
    id: "rag-claim-1",
    statement: "Retrieval augmentation can improve factuality and reduce knowledge hallucination on knowledge-intensive tasks.",
    operationalDefinition: "A retrieval-augmented system outperforms a comparable retrieval-free model on factuality, hallucination, or knowledge-intensive task outcomes.",
  },
  {
    id: "rag-claim-2",
    statement: "The benefit is conditional on retrieving relevant, trustworthy context.",
    operationalDefinition: "Irrelevant, conflicting, adversarial, or misleading retrieved documents can erase or reverse the factuality benefit.",
  },
  {
    id: "rag-claim-3",
    statement: "A production RAG system requires evidence-level evaluation and provenance.",
    operationalDefinition: "The system separately measures retrieval relevance, answer faithfulness, answer relevance, and source provenance.",
  },
] as const;

export type RagDemoSource = {
  id: string;
  title: string;
  authors: string;
  venue: string;
  year: number;
  url: string;
  doi: string | null;
  claimId: (typeof ragDemoClaims)[number]["id"];
  relationship: "supports" | "challenges" | "qualifies";
  excerpt: string;
  finding: string;
  limitation: string;
};

export const ragDemoSources: readonly RagDemoSource[] = [
  {
    id: "rag-source-lewis-2020",
    title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    authors: "Lewis et al.",
    venue: "NeurIPS",
    year: 2020,
    url: "https://papers.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html",
    doi: null,
    claimId: "rag-claim-1",
    relationship: "supports",
    excerpt: "RAG models generate more specific, diverse and factual language than a state-of-the-art parametric-only seq2seq baseline.",
    finding: "The original RAG paper reports gains over a parametric-only baseline on factual language generation.",
    limitation: "The experiments cover selected knowledge-intensive benchmarks, not every domain or deployment setting.",
  },
  {
    id: "rag-source-shuster-2021",
    title: "Retrieval Augmentation Reduces Hallucination in Conversation",
    authors: "Shuster et al.",
    venue: "Findings of EMNLP",
    year: 2021,
    url: "https://aclanthology.org/2021.findings-emnlp.320/",
    doi: "10.18653/v1/2021.findings-emnlp.320",
    claimId: "rag-claim-1",
    relationship: "supports",
    excerpt: "As verified by human evaluations, substantially reduce the well-known problem of knowledge hallucination in state-of-the-art chatbots.",
    finding: "Human evaluation found substantial hallucination reduction in knowledge-grounded dialogue.",
    limitation: "Dialogue results do not establish the same effect for every generative task.",
  },
  {
    id: "rag-source-mallen-2023",
    title: "When Not to Trust Language Models",
    authors: "Mallen et al.",
    venue: "ACL",
    year: 2023,
    url: "https://aclanthology.org/2023.acl-long.546/",
    doi: "10.18653/v1/2023.acl-long.546",
    claimId: "rag-claim-1",
    relationship: "supports",
    excerpt: "LMs struggle with less popular factual knowledge, and retrieval augmentation helps significantly in these cases.",
    finding: "Retrieval is especially useful for long-tail facts that parametric models do not memorize well.",
    limitation: "The same paper finds retrieval can hurt on popular entities when context is misleading.",
  },
  {
    id: "rag-source-self-rag-2024",
    title: "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection",
    authors: "Asai et al.",
    venue: "ICLR",
    year: 2024,
    url: "https://openreview.net/forum?id=hSyW5go0v8",
    doi: null,
    claimId: "rag-claim-1",
    relationship: "supports",
    excerpt: "Enhances the quality and factuality of an LLM through retrieval and self-reflection, without sacrificing the LLM's original creativity.",
    finding: "Selective retrieval plus self-critique can improve factuality without always retrieving.",
    limitation: "The method requires specialized training and reflection tokens rather than a drop-in prompt alone.",
  },
  {
    id: "rag-source-crag-2024",
    title: "Corrective Retrieval Augmented Generation",
    authors: "Yan et al.",
    venue: "arXiv",
    year: 2024,
    url: "https://arxiv.org/abs/2401.15884",
    doi: null,
    claimId: "rag-claim-2",
    relationship: "qualifies",
    excerpt: "It relies heavily on the relevance of retrieved documents, raising concerns about how the model behaves if retrieval goes wrong.",
    finding: "Retrieval quality needs an explicit correction gate before generation.",
    limitation: "CRAG demonstrates a mitigation strategy, not proof that all retrieval errors can be detected.",
  },
  {
    id: "rag-source-li-2024",
    title: "Unraveling and Mitigating Retriever Inconsistencies in Retrieval-Augmented Large Language Models",
    authors: "Li et al.",
    venue: "Findings of ACL",
    year: 2024,
    url: "https://aclanthology.org/2024.findings-acl.288/",
    doi: "10.18653/v1/2024.findings-acl.288",
    claimId: "rag-claim-2",
    relationship: "challenges",
    excerpt: "They do not consistently outperform the original retrieval-free Language Models.",
    finding: "RAG benefits vary by example and retriever; retrieval can cause degeneration.",
    limitation: "The finding is inconsistency, not evidence that retrieval is generally ineffective.",
  },
  {
    id: "rag-source-park-2024",
    title: "Toward Robust RALMs: Revealing the Impact of Imperfect Retrieval",
    authors: "Park and Lee",
    venue: "TACL",
    year: 2024,
    url: "https://aclanthology.org/2024.tacl-1.91/",
    doi: "10.1162/tacl_a_00724",
    claimId: "rag-claim-2",
    relationship: "challenges",
    excerpt: "RALMs often fail to identify the unanswerability or contradiction of a document set, which frequently leads to hallucinations.",
    finding: "Unanswerable, adversarial, and conflicting retrieval can actively induce hallucination.",
    limitation: "Adversarial robustness tests stress failure cases and do not estimate ordinary production prevalence.",
  },
  {
    id: "rag-source-ragas-2024",
    title: "RAGAs: Automated Evaluation of Retrieval Augmented Generation",
    authors: "Es et al.",
    venue: "EACL System Demonstrations",
    year: 2024,
    url: "https://aclanthology.org/2024.eacl-demo.16/",
    doi: "10.18653/v1/2024.eacl-demo.16",
    claimId: "rag-claim-3",
    relationship: "qualifies",
    excerpt: "Evaluating RAG architectures is challenging due to several dimensions to consider.",
    finding: "Evaluation must separate retrieval quality, faithful use of context, and generation quality.",
    limitation: "Reference-free automated metrics remain model-dependent proxies rather than human ground truth.",
  },
  {
    id: "rag-source-ares-2024",
    title: "ARES: An Automated Evaluation Framework for Retrieval-Augmented Generation Systems",
    authors: "Saad-Falcon et al.",
    venue: "NAACL",
    year: 2024,
    url: "https://aclanthology.org/2024.naacl-long.20/",
    doi: "10.18653/v1/2024.naacl-long.20",
    claimId: "rag-claim-3",
    relationship: "qualifies",
    excerpt: "Evaluating RAG systems along the dimensions of context relevance, answer faithfulness, and answer relevance.",
    finding: "Independent component-level judging gives a more diagnostic evaluation than answer accuracy alone.",
    limitation: "ARES still uses learned judges and a small human validation set to correct prediction error.",
  },
  {
    id: "rag-source-kilt-2021",
    title: "KILT: a Benchmark for Knowledge Intensive Language Tasks",
    authors: "Petroni et al.",
    venue: "NAACL",
    year: 2021,
    url: "https://aclanthology.org/2021.naacl-main.200/",
    doi: "10.18653/v1/2021.naacl-main.200",
    claimId: "rag-claim-3",
    relationship: "qualifies",
    excerpt: "Evaluating downstream performance in addition to the ability of the models to provide provenance.",
    finding: "Knowledge-intensive evaluation should score both task performance and evidence provenance.",
    limitation: "KILT uses a fixed Wikipedia snapshot and does not represent every private or rapidly changing corpus.",
  },
] as const;

export const ragDemoObjections = [
  {
    id: "rag-objection-scope",
    severity: "material",
    title: "Task-generalization risk",
    rationale: "Direct hallucination reduction is strongest in knowledge-grounded dialogue and long-tail QA; it should not be generalized to every generation task.",
    disposition: "accepted",
  },
  {
    id: "rag-objection-retrieval",
    severity: "high",
    title: "Bad retrieval can reverse the benefit",
    rationale: "Irrelevant, contradictory, or adversarial context can make a retrieval-augmented model less reliable than the retrieval-free baseline.",
    disposition: "accepted",
  },
  {
    id: "rag-objection-metrics",
    severity: "material",
    title: "Automated judges are not ground truth",
    rationale: "Faithfulness and relevance judges require calibration and retained human review for consequential decisions.",
    disposition: "unresolved",
  },
] as const;

export const ragDemoConclusion =
  "Retrieval augmentation can reduce hallucination and improve factuality, especially on knowledge-intensive and long-tail questions, but the benefit is not universal. Production use should gate on retrieval quality, verify answer faithfulness against exact passages, retain provenance, and preserve human review.";

export const ragDemoFingerprint =
  "4f6c31ef674e21a8cbf9abfc79940331c1a4e05cb0d9f146e91a8ab28e0d9e72";
