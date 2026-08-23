import { AlertTriangle, Check } from "lucide-react";

export type WorkflowStep = {
  label: string;
  state: "complete" | "active" | "warning" | "not-started";
  value?: string;
};

export function WorkflowProgress({ steps }: { steps: WorkflowStep[] }) {
  const active = steps.find((step) => step.state === "active" || step.state === "warning");
  return (
    <section className="research-pipeline" aria-label="Evidence collection pipeline" aria-live="polite">
      <header><span>Research pipeline</span><strong>{active ? `${active.label}: ${active.value ?? "In progress"}` : "Pipeline state recorded"}</strong></header>
      <ol>
        {steps.map((step, index) => (
          <li key={step.label} data-state={step.state}>
            <span className="research-pipeline-marker" aria-hidden="true">{step.state === "complete" ? <Check size={12} /> : step.state === "warning" ? <AlertTriangle size={12} /> : index + 1}</span>
            <div><strong>{step.label}</strong><small>{step.value ?? (step.state === "not-started" ? "Not started" : step.state)}</small></div>
          </li>
        ))}
      </ol>
    </section>
  );
}
