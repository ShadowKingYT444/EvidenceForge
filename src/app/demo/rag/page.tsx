import { RecordedRagDemo } from "@/features/research/recorded-rag-demo";
import { isOwnerCookieValue, researchSessionCookies } from "@/server/session/research-session";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export default async function RecordedRagDemoPage() {
  if (!isOwnerCookieValue((await cookies()).get(researchSessionCookies.owner)?.value)) notFound();
  return <RecordedRagDemo />;
}
