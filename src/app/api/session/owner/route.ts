import { createOwnerCookie, verifyOwnerSecret } from "@/server/session/research-session";
import { z } from "zod";

const schema = z.object({ ownerSecret: z.string().trim().min(1).max(2048) }).strict();

export async function POST(request: Request): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return Response.json({ ok: false }, { status: 403 });
  let value;
  try { value = schema.parse(await request.json()); } catch { return Response.json({ ok: false, error: { message: "Enter the owner passphrase." } }, { status: 400 }); }
  if (!verifyOwnerSecret(value.ownerSecret)) return Response.json({ ok: false, error: { message: "Owner access was not accepted." } }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store", "set-cookie": createOwnerCookie() } });
}
