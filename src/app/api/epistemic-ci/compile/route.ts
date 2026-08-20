import { compileInput, compileSafely, parseJsonBody, RequestBodyError, invalidRequest, json } from "../_http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return error instanceof RequestBodyError ? invalidRequest(error.message) : invalidRequest();
  }
  const parsed = compileInput(body);
  if (!parsed.ok) return parsed.response;
  const compiled = compileSafely(parsed.value);
  if (!compiled.ok) return compiled.response;
  return json(compiled.build);
}
