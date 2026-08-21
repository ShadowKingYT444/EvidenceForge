import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpenCheck, CircleAlert, FlaskConical } from "lucide-react";

const papers = [
  "Retrieval Augmentation Reduces Hallucination in Conversation",
  "RAGTruth: A Hallucination Corpus for Retrieval-Augmented Models",
  "Pandora's Box or Aladdin's Lamp: The Role of Retrieval Noise",
];

export default function ExamplePage() {
  return (
    <main className="research-example">
      <header className="research-intake-header">
        <Link href="/" className="research-back"><ArrowLeft size={15} /> EvidenceForge</Link>
        <span>Rehearsed live case</span>
      </header>
      <section className="research-example-hero">
        <p className="research-kicker"><FlaskConical size={14} /> Rehearsed live case</p>
        <h1>Does retrieval reduce factual hallucination?</h1>
        <div className="research-example-notice"><CircleAlert size={17} /><span>The workflow is real. The result is not prewritten.</span></div>
        <div className="research-example-actions"><Link className="research-button research-button-primary" href="/intake?example=ai-reliability">Run the case <ArrowRight size={17} /></Link><span>3 candidate papers · live verification</span></div>
      </section>
      <details className="research-example-packet">
        <summary><span><BookOpenCheck size={15} /> Candidate packet</span><strong>View 3 sources</strong></summary>
        <ol>{papers.map((paper) => <li key={paper}>{paper}</li>)}</ol>
      </details>
    </main>
  );
}
