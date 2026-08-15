export function GET(): Response {
  return Response.json(
    {
      status: "ok",
      service: "evidenceforge-demo",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
