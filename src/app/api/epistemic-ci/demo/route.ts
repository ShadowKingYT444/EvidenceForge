import { getEpistemicDemo, EPISTEMIC_CI_SCHEMA_VERSION } from "@/epistemic-ci";
import { json } from "../_http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({
    schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
    mode: "fixture",
    disclosure: "Deterministic fixture replay; no live model, retrieval, or database dependency.",
    ...getEpistemicDemo(),
  });
}
