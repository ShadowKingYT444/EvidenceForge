import type { LucideIcon } from "lucide-react";
import { AlertCircle, Check, LoaderCircle } from "lucide-react";

export function StageRail({ stages, active = 0 }: { stages: string[]; active?: number }) {
  return <nav className="research-stage-rail" aria-label="Investigation stages">{stages.map((stage, index) => <div className={`research-stage ${index < active ? "is-complete" : ""} ${index === active ? "is-active" : ""}`} key={stage}><span className="research-stage-marker">{index < active ? <Check size={12} /> : index + 1}</span><span>{stage}</span>{index < stages.length - 1 && <i aria-hidden="true" />}</div>)}</nav>;
}

export function StatusBadge({ status, children }: { status: "ready" | "working" | "needs-review" | "blocked"; children: React.ReactNode }) {
  return <span className={`research-status research-status-${status}`}><span aria-hidden="true" />{children}</span>;
}

export function ResearchStateCard({ kind, title, children, icon: Icon }: { kind: "empty" | "error" | "loading"; title: string; children: React.ReactNode; icon?: LucideIcon }) {
  const Fallback = kind === "error" ? AlertCircle : kind === "loading" ? LoaderCircle : undefined;
  const Glyph = Icon ?? Fallback;
  return <section className={`research-state-card research-state-${kind}`} aria-live={kind === "loading" ? "polite" : undefined}>{Glyph && <Glyph className="research-state-icon" size={20} aria-hidden="true" />}<h3>{title}</h3><p>{children}</p></section>;
}

export function TimelineRow({ time, title, detail, status = "complete" }: { time: string; title: string; detail?: string; status?: "complete" | "active" | "pending" }) {
  return <div className={`research-timeline-row research-timeline-${status}`}><time>{time}</time><span className="research-timeline-marker" aria-hidden="true" /> <div><strong>{title}</strong>{detail && <p>{detail}</p>}</div></div>;
}
