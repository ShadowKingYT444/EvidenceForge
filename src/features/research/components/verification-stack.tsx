import { Check, Circle, TriangleAlert } from "lucide-react";

type VerificationState = "verified" | "pending" | "failed" | "unavailable";

export function VerificationStack({ deterministic, primary, independent, human }: { deterministic: VerificationState; primary: VerificationState; independent: VerificationState; human: VerificationState }) {
  const rows = [["Text / rights", deterministic], ["Primary model", primary], ["Independent review", independent], ["Human review", human]] as const;
  return <span className="research-verification-stack" aria-label="Verification layers">{rows.map(([label, state]) => <span key={label} data-state={state}>{state === "verified" ? <Check size={11} /> : state === "failed" ? <TriangleAlert size={11} /> : <Circle size={9} />}<span>{label}</span><small>{state}</small></span>)}</span>;
}
