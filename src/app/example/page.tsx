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
        <p className="research-kicker"><FlaskConical size={14} /> Judge demo investigation</p>
        <h1>Does retrieval augmentation reduce factual hallucination?</h1>
        <p>This is the case we use to demonstrate EvidenceForge. The question and candidate papers are rehearsed; source ingestion, passage verification, model assessment, and human decisions run through the real workflow.</p>
        <div className="research-example-notice"><CircleAlert size={18} /><span>No result is prewritten. The app may conclude that the packet supports, conflicts with, or cannot resolve the claim.</span></div>
        <Link className="research-button research-button-primary" href="/intake?example=ai-reliability">Run this investigation live <ArrowRight size={17} /></Link>
      </section>
      <section className="research-example-packet" aria-labelledby="example-packet-title">
        <div><p className="research-kicker"><BookOpenCheck size={14} /> Candidate packet</p><h2 id="example-packet-title">Designed to include support and limitations.</h2></div>
        <ol>{papers.map((paper) => <li key={paper}>{paper}</li>)}</ol>
      </section>
    </main>
  );
}
