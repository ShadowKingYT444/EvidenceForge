import { expect, test } from "@playwright/test";

const hash = "a".repeat(64);

test("projects, perturbs, and reviews a live run through Epistemic CI", async ({ page }) => {
  const runId = "live-epistemic-browser";
  const run = {
    id: runId,
    status: "synthesizing",
    evidenceMode: "live",
    intake: { originalQuestion: "Does sodium-ion storage improve cold-weather reliability?", intendedApplication: "Remote environmental sensor design" },
    claims: [{ id: "claim-1", statement: "Sodium-ion storage improves cold-weather reliability", operationalDefinition: "Higher retained capacity at -20 C" }],
    evidenceCards: [{ id: "card-1", subclaimId: "claim-1", sourceChunkId: "chunk-1", excerpt: "Sodium-ion cells retained capacity at low temperature.", relationship: "supports", deterministicVerification: { excerptExists: true }, modelAssessment: { entailment: "partial_support" }, humanReview: { status: "unreviewed" } }],
    conclusions: [], researchGaps: [], experiment: null, experimentAbstention: null, review: null,
  };
  await page.route(`**/api/runs/${runId}`, async (route) => {
    if (route.request().url().includes("/epistemic")) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run, revision: "revision-1" }) });
  });
  await page.route(`**/api/runs/${runId}/progress`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "synthesizing", revision: "revision-1" }) }));
  await page.route(`**/api/runs/${runId}/sources`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ draft: { sources: [] }, revision: "revision-1" }) }));
  await page.route(`**/api/runs/${runId}/timeline`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) }));
  await page.route(`**/api/runs/${runId}/epistemic`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projectionHash: hash, projection: { nodes: [
    { id: "passage-1", kind: "passage", label: "Low-temperature result", state: "supported" },
    { id: "assumption-1", kind: "assumption", label: "Lab-to-field equivalence", state: "insufficient" },
    { id: "claim-node-1", kind: "claim", label: "Cold-weather reliability", state: "insufficient" },
  ], edges: [] } }) }));
  let compileOperations: unknown[] = [];
  await page.route(`**/api/runs/${runId}/epistemic/compile`, async (route) => {
    compileOperations = (route.request().postDataJSON() as { operations: unknown[] }).operations;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ build: { buildId: `build-${compileOperations.length}`, graphHash: hash, decision: { label: "Live research branch blocked" }, impactedNodeIds: compileOperations.length ? ["claim-node-1"] : [], errors: [{ id: "error-1", code: "INSUFFICIENT_SUPPORT", message: "Human review is still required." }] } }) });
  });
  await page.route(`**/api/runs/${runId}/epistemic/review`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt: { evidenceUpdateStatus: "merged_with_blockers", receiptHash: hash }, scientificDecisionApproved: false }) }));

  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Project live dependency graph" }).click();
  await page.getByRole("button", { name: "Compile live run" }).click();
  await expect(page.getByText("Live research branch blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Remove Low-temperature result/ }).click();
  expect(compileOperations).toHaveLength(1);
  await page.getByRole("button", { name: "Authorize Research PR" }).click();
  await expect(page.getByText("Research PR receipt sealed", { exact: true })).toBeVisible();
  await expect(page.getByText(/scientific decision approved: no/i)).toBeVisible();
});
