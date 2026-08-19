import Link from "next/link";
import { ArrowRight, BookOpenCheck, Check, ChevronRight, CircleDot, FileSearch, GitBranch, LockKeyhole, Sparkles } from "lucide-react";

const steps = [
  { number: "01", icon: FileSearch, title: "Shape the claim", text: "Turn a hunch into a precise, testable claim with explicit boundaries." },
  { number: "02", icon: BookOpenCheck, title: "Build the packet", text: "Gather primary sources and pin the exact passages that can support or challenge it." },
  { number: "03", icon: GitBranch, title: "Make the call", text: "Trace the reasoning, pressure-test the gaps, and leave a decision others can audit." },
];

export default function Home() {
  return (
    <main className="research-landing">
      <header className="research-nav" aria-label="Main navigation">
        <Link href="/" className="research-wordmark"><span className="research-mark" aria-hidden="true"><i /><i /><i /></span>EvidenceForge</Link>
        <div className="research-nav-right"><span className="research-nav-note"><span className="research-live-dot" /> Research workspace</span><Link href="/example" className="research-nav-link">See an example <ArrowRight size={14} /></Link></div>
      </header>

      <section className="research-hero" aria-labelledby="hero-title">
        <div className="research-hero-copy">
          <p className="research-kicker"><Sparkles size={14} /> Evidence, with a trail</p>
          <h1 id="hero-title">Make claims you can <em>stand behind.</em></h1>
          <p className="research-lede">EvidenceForge is a research studio for turning uncertain ideas into verifiable evidence packets, transparent timelines, and decisions that hold up under scrutiny.</p>
          <div className="research-actions">
            <Link href="/intake" className="research-button research-button-primary">Start an investigation <ArrowRight size={17} /></Link>
            <Link href="/example" className="research-button research-button-secondary">Explore the live demo case <ChevronRight size={16} /></Link>
          </div>
          <div className="research-trust-row" aria-label="Trust and provenance details">
            <span><LockKeyhole size={14} /> Private by default</span><span><CircleDot size={14} /> Source-level provenance</span><span><Check size={14} /> Human decision stays yours</span>
          </div>
        </div>
        <div className="research-hero-art" aria-label="Illustration of an evidence packet timeline">
          <div className="research-art-glow" />
          <div className="research-art-card research-art-card-main"><div className="research-art-label">INVESTIGATION / 001</div><div className="research-art-title">Does retrieval improve factuality?</div><div className="research-art-line"><span className="research-art-pulse" /> Claim under review <span>Packet ready</span></div><div className="research-art-progress"><i /></div><div className="research-art-footer"><span>4 sources pinned</span><span>2 open questions</span></div></div>
          <div className="research-art-card research-art-card-float"><BookOpenCheck size={16} /><span>Evidence packet frozen</span><Check size={14} /></div>
          <div className="research-art-timeline"><span /><span /><span /><span /></div>
        </div>
      </section>

      <section className="research-how" aria-labelledby="how-title"><div className="research-section-heading"><p className="research-kicker">A calmer way to investigate</p><h2 id="how-title">From question to confidence.</h2><p>Every step leaves a visible trail, so you can focus on the thinking—not the bookkeeping.</p></div><div className="research-step-grid">{steps.map(({ number, icon: Icon, title, text }) => <article className="research-step" key={number}><div className="research-step-top"><span>{number}</span><Icon size={19} strokeWidth={1.7} /></div><h3>{title}</h3><p>{text}</p><span className="research-step-arrow"><ArrowRight size={15} /></span></article>)}</div></section>

      <section className="research-bottom-note"><div><p className="research-kicker">Built for the moment before you commit</p><h2>Good research leaves room for doubt.</h2></div><p>See which sources support your claim, which ones push back, and exactly where the uncertainty still lives.</p><Link href="/intake" className="research-text-link">Begin with a question <ArrowRight size={15} /></Link></section>
      <footer className="research-footer"><span>EvidenceForge</span><span>Research studio / v0.1</span><span>Source-aware by design</span></footer>
    </main>
  );
}
