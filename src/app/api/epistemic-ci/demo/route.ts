import { getEpistemicDemo, EPISTEMIC_CI_SCHEMA_VERSION } from "@/epistemic-ci";
import { isOwnerRequest } from "@/server/session/research-session";
import { json } from "../_http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isOwnerRequest(request)) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  return json({
    schemaVersion: EPISTEMIC_CI_SCHEMA_VERSION,
    mode: "fixture",
    disclosure: "Deterministic fixture replay; no live model, retrieval, or database dependency.",
    ...getEpistemicDemo(),
  });
}
