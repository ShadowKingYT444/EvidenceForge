import { ResearchGate } from "@/features/providers/research-gate";
import { isOwnerCookieValue, readResearchSessionCookieValue, researchSessionCookies } from "@/server/session/research-session";
import { cookies } from "next/headers";

export default async function Home() {
  const store = await cookies();
  const session = readResearchSessionCookieValue(store.get(researchSessionCookies.research)?.value);
  return <ResearchGate initialState={{ configured: Boolean(session), ownerDemo: isOwnerCookieValue(store.get(researchSessionCookies.owner)?.value), session: session?.safe ?? null }} />;
}
