import * as unpdf from "unpdf";
import { z } from "zod";

import { canonicalSha256 } from "../../contracts";
import { extractRunToken } from "../auth/run-token";
import { getDurableRunCoordinator, RunAccessDeniedError } from "../workflow/durable-coordinator";
import { liveRouteError } from "../workflow/live-http";
import { searchFirecrawl } from "./firecrawl";
import { importOpenAlexWork, createPastedSource } from "./import-service";
import { extractPdfText } from "./pdf";
import { searchScholarlyWorks } from "./openalex";
import {
  OpenAlexImportRequestSchema,
  OpenAlexSearchRequestSchema,
  PasteSourceRequestSchema,
  SourceRightsRequestSchema,
} from "./schemas";
import { addDraftSource, PacketDraftSchema, removeDraftSource } from "./packet-draft";
import { AutomaticCollectionRequestSchema, collectAutomaticResearchPacket } from "../research/live-collection";

type Context = { params: Promise<{ runId: string; sourceId?: string }> };

async function runAccess(request: Request, context: Context) {
  const { runId, sourceId } = await context.params;
  const token = extractRunToken(request, runId);
  if (!token) throw new RunAccessDeniedError();
  const coordinator = getDurableRunCoordinator();
  const snapshot = await coordinator.authorize(runId, token);
  return { runId, sourceId, token, coordinator, snapshot };
}

async function json(request: Request) {
  return request.json() as Promise<unknown>;
}

export async function searchRunSources(request: Request, context: Context): Promise<Response> {
  try {
    await runAccess(request, context);
    const query = new URL(request.url).searchParams.get("query") ?? "";
    const parsed = OpenAlexSearchRequestSchema.parse({ query, maxResults: 10 });
    const apiKey = process.env.OPENALEX_API_KEY?.trim();
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
    const [result, web] = await Promise.all([
      searchScholarlyWorks(parsed.query, { apiKey, limits: { maxResults: parsed.maxResults, pageSize: parsed.maxResults, maxPages: 2 } }),
      firecrawlApiKey ? searchFirecrawl(parsed.query, { apiKey: firecrawlApiKey, maxResults: parsed.maxResults, deadlineMs: 20_000, signal: request.signal }) : Promise.resolve(null),
    ]);
    return Response.json(
      {
        provider: "openalex",
        query: result.query,
        candidates: result.candidates,
        providerStatus: result.raw.status,
        failureCode: result.raw.failureCode,
        partial: result.raw.status === "partial",
        webCandidates: web?.candidates.map((candidate) => ({ id: candidate.id, url: candidate.url, title: candidate.title, description: candidate.description, category: candidate.category, license: candidate.license, canonicalDoi: candidate.canonicalDoi, authors: candidate.authors, publicationYear: candidate.publicationYear, rightsEligible: candidate.rightsEligible })) ?? [],
        providers: {
          openalex: { status: result.raw.status, failureCode: result.raw.failureCode },
          firecrawl: web ? { status: web.raw.status, failureCode: web.raw.failureCode } : { status: "not_configured", failureCode: null },
        },
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function autoCollectRunSources(request: Request, context: Context): Promise<Response> {
  const startedAt = Date.now();
  let observedRunId = "unknown";
  try {
    const access = await runAccess(request, context);
    observedRunId = access.runId;
    const body = AutomaticCollectionRequestSchema.parse(await json(request));
    const apiKey = process.env.OPENALEX_API_KEY?.trim();
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
    if (access.snapshot.run.status !== "collecting_sources") {
      throw new Error("Automatic collection requires approved scope and the collecting_sources phase.");
    }
    const collected = await collectAutomaticResearchPacket({
      run: access.snapshot.run,
      currentDraft: await access.coordinator.getPacketDraft(access.runId, access.token),
      mode: body.mode,
      config: body.config,
      openAlexApiKey: apiKey ?? "",
      firecrawlApiKey,
      signal: request.signal,
    });
    const saved = await access.coordinator.savePacketDraft(
      access.runId,
      body.expectedRevision,
      access.token,
      collected.draft,
    );
    console.info("[evidenceforge.research.collection]", JSON.stringify({
      runId: access.runId,
      mode: body.mode,
      status: collected.status,
      verifiedPassages: collected.verifiedPassages,
      pendingPassages: collected.pendingPassages,
      providerFailures: collected.providerFailures,
      primaryWorkers: collected.primaryAudits.map(({ itemId, status, fallbackUsed, durationMs, value }) => ({ itemId, status, fallbackUsed, durationMs: durationMs ?? null, provider: value?.provider ?? null })),
      reviewerWorkers: collected.reviewerAudits.map(({ itemId, status, fallbackUsed, durationMs, value }) => ({ itemId, status, fallbackUsed, durationMs: durationMs ?? null, provider: value?.provider ?? null })),
      durationMs: Date.now() - startedAt,
    }));
    return Response.json({
      revision: saved.revision,
      draft: PacketDraftSchema.parse(saved.draft),
      collection: {
        queries: collected.queries,
        candidatesConsidered: collected.candidatesConsidered,
        selectedCandidateIds: collected.selectedCandidateIds,
        skipped: collected.skipped,
        usableSources: collected.usableSources,
        targetSources: collected.targetSources,
        minimumSources: collected.minimumSources,
        verifiedPassages: collected.verifiedPassages,
        targetPassages: collected.targetPassages,
        claimsCovered: collected.claimsCovered,
        claimsMissing: collected.claimsMissing,
        roundsCompleted: collected.roundsCompleted,
        rejectionCounts: collected.rejectionCounts,
        plannerFallbackUsed: collected.plannerFallbackUsed,
        status: collected.status,
        pendingPassages: collected.pendingPassages,
        providerFailures: collected.providerFailures,
        blocked: collected.blocked,
        durationMs: collected.durationMs,
        searchWorkers: collected.searchAudits.map(({ itemId, status, durationMs, signal, error, value }) => ({
          itemId,
          provider: value?.provider ?? null,
          status,
          durationMs: durationMs ?? null,
          signal: signal ?? null,
          providerStatus: value?.raw.status ?? null,
          failureCode: value?.raw.failureCode ?? null,
          error: error instanceof Error ? error.message : null,
        })),
        triageWorkers: collected.triageAudits.map(({ itemId, status, durationMs, fallbackUsed, signal, error, value }) => ({ itemId, status, durationMs: durationMs ?? null, provider: value?.provider ?? null, fallbackUsed: value?.fallbackUsed ?? fallbackUsed, signal: signal ?? null, error: error instanceof Error ? error.message : null })),
        reviewerWorkers: collected.reviewerAudits.map(({ itemId, status, durationMs, fallbackUsed, signal, error, value }) => ({ itemId, status, durationMs: durationMs ?? null, provider: value?.provider ?? null, fallbackUsed: value?.fallbackUsed ?? fallbackUsed, signal: signal ?? null, error: error instanceof Error ? error.message : null })),
        importWorkers: collected.importAudits.map(({ itemId, status, durationMs, signal }) => ({ itemId, status, durationMs: durationMs ?? null, signal: signal ?? null })),
      },
    }, { status: collected.blocked ? 206 : 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    console.error("[evidenceforge.research.collection.failed]", JSON.stringify({
      runId: observedRunId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      durationMs: Date.now() - startedAt,
    }));
    return liveRouteError(error);
  }
}

const importBodySchema = OpenAlexImportRequestSchema.extend({
  expectedRevision: z.string().min(1),
}).strict();

export async function importRunOpenAlexSource(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    const body = importBodySchema.parse(await json(request));
    const apiKey = process.env.OPENALEX_API_KEY?.trim();
    if (access.snapshot.run.status !== "collecting_sources") {
      throw new Error("Sources can only be changed during packet collection.");
    }
    const imported = await importOpenAlexWork(
      {
        openAlexId: body.openAlexId,
        claims: access.snapshot.run.claims.map(({ statement }) => statement),
        rights: SourceRightsRequestSchema.parse(body.rights),
      },
      {
        apiKey,
        trustedPdfOrigins: ["https://content.openalex.org"],
        pdfParser: unpdf,
      },
    );
    const draft = addDraftSource(
      await access.coordinator.getPacketDraft(access.runId, access.token),
      { source: imported.source, chunks: imported.chunks, importedAt: new Date().toISOString() },
    );
    const saved = await access.coordinator.savePacketDraft(
      access.runId,
      body.expectedRevision,
      access.token,
      draft,
    );
    return Response.json(
      { revision: saved.revision, draft: PacketDraftSchema.parse(saved.draft) },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

const pasteBodySchema = PasteSourceRequestSchema.extend({
  expectedRevision: z.string().min(1),
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

export async function pasteRunSource(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    const body = pasteBodySchema.parse(await json(request));
    if (access.snapshot.run.status !== "collecting_sources") {
      throw new Error("Sources can only be changed during packet collection.");
    }
    const imported = createPastedSource({
      id: body.id,
      title: body.title,
      text: body.text,
      claims: access.snapshot.run.claims.map(({ statement }) => statement),
      originalInput: body.originalInput,
      authors: body.authors,
      year: body.year,
      venue: body.venue,
      rights: SourceRightsRequestSchema.parse(body.rights),
    });
    const draft = addDraftSource(
      await access.coordinator.getPacketDraft(access.runId, access.token),
      { source: imported.source, chunks: imported.chunks, importedAt: new Date().toISOString() },
    );
    const saved = await access.coordinator.savePacketDraft(
      access.runId,
      body.expectedRevision,
      access.token,
      draft,
    );
    return Response.json(
      { revision: saved.revision, draft: PacketDraftSchema.parse(saved.draft) },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function uploadRunSource(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    if (access.snapshot.run.status !== "collecting_sources") {
      throw new Error("Sources can only be changed during packet collection.");
    }
    const form = await request.formData();
    const file = form.get("file");
    const expectedRevision = String(form.get("expectedRevision") ?? "");
    const title = String(form.get("title") ?? "").trim();
    const permissionBasis = String(form.get("permissionBasis") ?? "").trim();
    if (!(file instanceof File) || file.type !== "application/pdf") {
      throw new Error("Upload one PDF document.");
    }
    if (file.size > 10 * 1024 * 1024) throw new Error("PDF exceeds the 10 MB limit.");
    if (!expectedRevision || !permissionBasis) {
      throw new Error("Revision and an explicit permission basis are required.");
    }
    const extracted = await extractPdfText(new Uint8Array(await file.arrayBuffer()), unpdf);
    const id = `upload-${crypto.randomUUID()}`;
    const imported = createPastedSource({
      id,
      title: title || file.name.replace(/\.pdf$/iu, "") || "Uploaded research paper",
      text: extracted.text,
      claims: access.snapshot.run.claims.map(({ statement }) => statement),
      originalInput: file.name,
      rights: {
        mayStore: "allowed",
        mayDisplay: "allowed",
        maySendToModel: "allowed",
        permissionBasis,
        checkedAt: new Date().toISOString(),
      },
    });
    const draft = addDraftSource(
      await access.coordinator.getPacketDraft(access.runId, access.token),
      { source: imported.source, chunks: imported.chunks, importedAt: new Date().toISOString() },
    );
    const saved = await access.coordinator.savePacketDraft(access.runId, expectedRevision, access.token, draft);
    return Response.json(
      { revision: saved.revision, draft: PacketDraftSchema.parse(saved.draft) },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function getRunPacketDraft(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    const draft = PacketDraftSchema.parse(
      await access.coordinator.getPacketDraft(access.runId, access.token),
    );
    return Response.json(
      { revision: access.snapshot.revision, draft },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function deleteRunDraftSource(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    if (!access.sourceId) throw new Error("Source ID is required.");
    const body = z.object({ expectedRevision: z.string().min(1) }).strict().parse(await json(request));
    const draft = removeDraftSource(
      await access.coordinator.getPacketDraft(access.runId, access.token),
      access.sourceId,
    );
    const saved = await access.coordinator.savePacketDraft(access.runId, body.expectedRevision, access.token, draft);
    return Response.json({ revision: saved.revision, draft: saved.draft }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function freezeRunPacket(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    const body = z.object({
      expectedRevision: z.string().min(1),
      declaredActor: z.string().min(1).optional(),
      rationale: z.string().min(1).optional(),
    }).strict().parse(await json(request));
    const draft = PacketDraftSchema.parse(
      await access.coordinator.getPacketDraft(access.runId, access.token),
    );
    const usable = draft.sources.filter(({ chunks }) => chunks.length > 0);
    const verification = draft.verification;
    if (verification?.status !== "ready" || verification.passages.length !== 10 || verification.claimsMissing.length > 0) {
      throw new Error("packet_not_ready: ten dual-model verified passages covering every claim are required before freeze");
    }
    const allSources = usable.map(({ source }) => source);
    const allChunks = usable.flatMap(({ chunks: entryChunks }) => entryChunks);
    const sources = new Map(allSources.map((source) => [source.id, source]));
    const chunks = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
    if (sources.size !== allSources.length || chunks.size !== allChunks.length) {
      throw new Error("packet_not_ready: duplicate source or chunk identity would overwrite frozen evidence");
    }
    for (const passage of verification.passages) {
      const source = sources.get(passage.sourceId);
      const chunk = chunks.get(passage.sourceChunkId);
      if (
        !source || !chunk || chunk.sourceId !== source.id ||
        source.contentHash !== passage.deterministic.sourceHash ||
        chunk.contentHash !== passage.deterministic.chunkHash ||
        canonicalSha256(passage.excerpt) !== passage.excerptHash ||
        !chunk.text.includes(passage.excerpt) ||
        source.rights.mayStore !== "allowed" ||
        source.rights.mayDisplay !== "allowed" ||
        source.rights.maySendToModel !== "allowed" ||
        chunk.displayPermission !== "allowed"
      ) {
        throw new Error("packet_not_ready: verified passage hashes, rights, or literal membership changed");
      }
    }
    const collected = await access.coordinator.collectSources(
      access.runId,
      body.expectedRevision,
      access.token,
      usable.map(({ source }) => source),
      usable.flatMap(({ chunks }) => chunks),
    );
    const frozen = await access.coordinator.freezePacket(
      access.runId,
      collected.revision,
      access.token,
      body,
    );
    return Response.json(frozen.snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return liveRouteError(error);
  }
}
