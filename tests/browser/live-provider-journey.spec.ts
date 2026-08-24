import { expect, test, type APIResponse } from "@playwright/test";

type JsonRecord = Record<string, unknown>;

const LIVE_SMOKE = process.env.EVIDENCEFORGE_LIVE_SMOKE === "1";
const QUESTION = "Does retrieval-augmented generation reduce factual hallucination in knowledge-grounded language generation compared with the same model without retrieval?";
const APPLICATION = "Choose a bounded retrieval architecture for a factual research assistant.";
const MODEL_STATUSES = new Set(["draft", "decomposing", "extracting_evidence", "verifying_evidence", "synthesizing", "planning_experiment", "reviewing_experiment", "revising_experiment"]);

function record(value: unknown, label: string): JsonRecord {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as JsonRecord[];
}

async function responseJson(response: APIResponse, label: string): Promise<JsonRecord> {
  if (response.status() < 200 || response.status() >= 300) {
    const body = await response.text();
    expect(response.status(), `${label}: ${body}`).toBeGreaterThanOrEqual(200);
  }
  expect(response.status(), label).toBeLessThan(300);
  return record(await response.json(), label);
}

test.describe("genuine live provider journey", () => {
  test.skip(!LIVE_SMOKE, "Set EVIDENCEFORGE_LIVE_SMOKE=1 with a complete live server environment.");

  test("runs one bounded investigation through the real application APIs", async ({ context, page }) => {
    test.setTimeout(15 * 60_000);
    const browserErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    page.on("pageerror", (error) => browserErrors.push(error.name));

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Test a claim against the evidence." })).toBeVisible();

    const api = context.request;
    const healthResponse = await api.get("/api/health");
    const health = await responseJson(healthResponse, "live readiness");
    expect(health).toMatchObject({ status: "ok", evidenceMode: "live", liveInvestigationsReady: true });

    const createResponse = await api.post("/api/runs", {
      data: {
        expectedRevision: null,
        intake: {
          originalQuestion: QUESTION,
          intendedApplication: APPLICATION,
          populationOrGeography: "Knowledge-grounded language generation",
          timeHorizon: "Published evidence available through the current provider indexes",
          availableMaterialsOrBudget: "One bounded live-provider investigation",
          desiredDepth: "Ten literal passages with complete claim coverage",
          constraints: ["Exclude unlicensed text and unverifiable summaries."],
          unansweredClarifications: [],
        },
      },
    });
    expect(createResponse.status()).toBe(201);
    expect(createResponse.headers()["set-cookie"]).toMatch(/evidenceforge_run_token_[^=]+=.*HttpOnly.*SameSite=Lax.*Secure/iu);
    const created = await responseJson(createResponse, "create live investigation");
    let run = record(created.run, "created run");
    const runId = String(run.id);
    let revision = String(created.revision);
    expect(runId).toBeTruthy();
    expect(revision).toBeTruthy();

    for (let step = 0; step < 4 && run.status !== "awaiting_scope_approval"; step += 1) {
      const continued = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/continue`, { data: { expectedRevision: revision } }), "claim decomposition");
      expect(continued.failure).toBeFalsy();
      const snapshot = record(continued.snapshot, "decomposition snapshot");
      run = record(snapshot.run, "decomposed run");
      revision = String(snapshot.revision);
    }
    expect(run.status).toBe("awaiting_scope_approval");
    const claims = records(run.claims, "generated claims");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((claim) => /retriev|hallucin|factual/iu.test(String(claim.statement)))).toBe(true);

    const approved = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/checkpoints`, {
      data: {
        checkpoint: "scope",
        expectedRevision: revision,
        decision: { declaredActor: "Live smoke researcher", rationale: "Approve the bounded retrieval and factual-hallucination scope." },
      },
    }), "scope approval");
    run = record(approved.run, "approved run");
    revision = String(approved.revision);
    expect(run.status).toBe("collecting_sources");

    let mode: "initial" | "deeper" | "retry_verification" = "initial";
    let draft: JsonRecord = {};
    let verification: JsonRecord = {};
    let priorVerifiedIds = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const collectionResponse = await api.post(`/api/runs/${encodeURIComponent(runId)}/sources/auto`, { data: { expectedRevision: revision, mode } });
      expect([201, 206]).toContain(collectionResponse.status());
      const collection = await responseJson(collectionResponse, `${mode} collection`);
      revision = String(collection.revision);
      draft = record(collection.draft, "packet draft");
      verification = record(draft.verification, "packet verification");
      const verified = records(verification.passages, "verified passages");
      const verifiedIds = new Set(verified.map((passage) => String(passage.id)));
      expect([...priorVerifiedIds].every((id) => verifiedIds.has(id)), `${mode} must preserve previously verified passages`).toBe(true);
      priorVerifiedIds = verifiedIds;
      if (verification.status === "ready") break;
      const pending = records(verification.pendingPassages, "pending passages");
      mode = verification.status === "provider_unavailable" && pending.length > 0 ? "retry_verification" : "deeper";
    }

    const queries = records(verification.queries, "search queries");
    const searchAudits = records(verification.searchAudits, "search audits");
    const openAlexAudits = searchAudits.filter((audit) => audit.provider === "openalex");
    expect(openAlexAudits.length).toBeGreaterThan(0);
    expect(openAlexAudits.every((audit) => ["completed", "partial", "failed", "timed_out", "worker_failed"].includes(String(audit.status)))).toBe(true);
    const providerFailures = records(verification.providerFailures, "provider failures");
    if (verification.status === "evidence_shortfall") {
      const latestRound = Math.max(...openAlexAudits.map((audit) => Number(audit.round)));
      expect(openAlexAudits.filter((audit) => Number(audit.round) === latestRound).every((audit) => audit.failureCode === null)).toBe(true);
    }
    if (openAlexAudits.some((audit) => audit.failureCode !== null) && verification.status !== "ready") {
      expect(verification.status).toBe("provider_unavailable");
    }

    const draftSources = records(draft.sources, "saved draft sources");
    const sourceById = new Map(draftSources.map((entry) => {
      const source = record(entry.source, "draft source");
      return [String(source.id), source] as const;
    }));
    const chunks = draftSources.flatMap((entry) => records(entry.chunks, "source chunks"));
    const chunkById = new Map(chunks.map((chunk) => [String(chunk.id), chunk] as const));
    expect(chunkById.size).toBe(chunks.length);
    for (const source of sourceById.values()) {
      expect(String(source.contentHash)).toMatch(/^[a-f0-9]{64}$/u);
      expect(record(source.rights, "source rights")).toMatchObject({ mayStore: "allowed", mayDisplay: "allowed", maySendToModel: "allowed" });
    }
    for (const chunk of chunks) {
      expect(sourceById.has(String(chunk.sourceId))).toBe(true);
      expect(String(chunk.contentHash)).toMatch(/^[a-f0-9]{64}$/u);
    }
    const verifiedPassages = records(verification.passages, "verified passages");
    const pendingPassages = records(verification.pendingPassages, "pending passages");
    const knownClaimIds = new Set(claims.map((claim) => String(claim.id)));
    const knownQueryIds = new Set(queries.map((query) => String(query.id)));
    for (const passage of [...verifiedPassages, ...pendingPassages]) {
      const chunk = chunkById.get(String(passage.sourceChunkId));
      expect(sourceById.has(String(passage.sourceId))).toBe(true);
      expect(chunk).toBeTruthy();
      expect(String(chunk!.text)).toContain(String(passage.excerpt));
      expect(knownQueryIds.has(String(passage.queryId))).toBe(true);
      expect(knownClaimIds.has(String(passage.subclaimId ?? passage.claimId))).toBe(true);
    }
    for (const passage of verifiedPassages) {
      const primary = record(passage.primary, "primary decision");
      const reviewer = record(passage.reviewer, "reviewer decision");
      expect(primary.provider).not.toBe(reviewer.provider);
    }

    let exportCompleted = false;
    if (verification.status === "ready") {
      expect(verifiedPassages).toHaveLength(10);
      expect(records(verification.claimsMissing, "missing claims")).toHaveLength(0);
      const frozen = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/packet`, {
        data: { expectedRevision: revision, declaredActor: "Live smoke researcher", rationale: "Freeze ten literal, rights-eligible, independently reviewed passages." },
      }), "packet freeze");
      run = record(frozen.run, "frozen run");
      revision = String(frozen.revision);

      for (let step = 0; step < 20 && !["approved", "rejected", "failed"].includes(String(run.status)); step += 1) {
        const status = String(run.status);
        if (MODEL_STATUSES.has(status)) {
          const continued = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/continue`, { data: { expectedRevision: revision } }), `continue ${status}`);
          expect(continued.failure).toBeFalsy();
          const snapshot = record(continued.snapshot, `${status} snapshot`);
          run = record(snapshot.run, `${status} run`);
          revision = String(snapshot.revision);
        } else if (status === "awaiting_objection_dispositions") {
          const review = record(run.review, "independent review");
          const objections = records(review.objections, "objections");
          const disposed = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/checkpoints`, {
            data: {
              checkpoint: "objection_dispositions",
              expectedRevision: revision,
              decision: { declaredActor: "Live smoke researcher", rationale: "Preserve every live objection as unresolved for the bounded smoke." },
              dispositions: objections.map((objection) => ({ objectionId: String(objection.id), disposition: "unresolved", basis: "Retained as unresolved in the live-smoke audit." })),
            },
          }), "objection dispositions");
          run = record(disposed.run, "disposed run");
          revision = String(disposed.revision);
        } else if (status === "awaiting_final_approval") {
          const decided = await responseJson(await api.post(`/api/runs/${encodeURIComponent(runId)}/checkpoints`, {
            data: { checkpoint: "final", expectedRevision: revision, decision: { choice: "approve", declaredActor: "Live smoke researcher", rationale: "Approve only this bounded live-smoke conclusion with all recorded limitations." } },
          }), "final decision");
          run = record(decided.run, "decided run");
          revision = String(decided.revision);
        } else {
          throw new Error(`Unexpected live workflow status: ${status}`);
        }
      }
      expect(run.status).toBe("approved");
      const exportResponse = await api.get(`/api/runs/${encodeURIComponent(runId)}/export`);
      const exported = await responseJson(exportResponse, "canonical export");
      expect(exported.id).toBe(runId);
      expect(String(record(exported.packet, "export packet").fingerprint)).toMatch(/^[a-f0-9]{64}$/u);
      expect(records(exported.sources, "export sources").length).toBeGreaterThan(0);
      expect(records(exported.chunks, "export chunks").length).toBeGreaterThan(0);
      expect(records(exported.executions, "export executions").length).toBeGreaterThan(0);
      expect(record(exported.finalDecision, "export final decision").decision).toBe("approve");
      expect(Array.isArray(exported.errors)).toBe(true);
      exportCompleted = true;
    }

    await page.goto(`/runs/${encodeURIComponent(runId)}#sources`);
    await expect(page.getByRole("heading", { level: 1, name: /retrieval-augmented generation/iu })).toBeVisible();
    if (verification.status === "provider_unavailable") await expect(page.getByText(/provider/iu).first()).toBeVisible();
    if (verification.status === "evidence_shortfall") await expect(page.getByText(/evidence|search deeper/iu).first()).toBeVisible();
    expect(browserErrors, "live browser console errors").toEqual([]);

    console.log(JSON.stringify({
      liveSmoke: {
        queries: queries.map((query) => String(query.query)),
        candidatesConsidered: Number(verification.candidatesConsidered),
        importedSources: draftSources.length,
        verifiedPassages: verifiedPassages.length,
        claimsCovered: records(verification.claimsCovered, "covered claims").map(String),
        claimsMissing: records(verification.claimsMissing, "missing claims").map(String),
        providerFailures: providerFailures.map((failure) => ({ provider: String(failure.provider), stage: String(failure.stage), code: String(failure.code) })),
        status: String(verification.status),
        freezeCompleted: verification.status === "ready",
        exportCompleted,
      },
    }));
  });
});
