import * as unpdf from "unpdf";
import { z } from "zod";

import { extractRunToken } from "../auth/run-token";
import { getDurableRunCoordinator, RunAccessDeniedError } from "../workflow/durable-coordinator";
import { liveRouteError } from "../workflow/live-http";
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
    const result = await searchScholarlyWorks(parsed.query, { apiKey });
    return Response.json(
      { provider: "openalex", query: result.query, candidates: result.candidates },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return liveRouteError(error);
  }
}

export async function autoCollectRunSources(request: Request, context: Context): Promise<Response> {
  try {
    const access = await runAccess(request, context);
    const body = AutomaticCollectionRequestSchema.parse(await json(request));
    const apiKey = process.env.OPENALEX_API_KEY?.trim();
    if (access.snapshot.run.status !== "collecting_sources") {
      throw new Error("Automatic collection requires approved scope and the collecting_sources phase.");
    }
    const collected = await collectAutomaticResearchPacket({
      run: access.snapshot.run,
      currentDraft: await access.coordinator.getPacketDraft(access.runId, access.token),
      config: body.config,
      openAlexApiKey: apiKey ?? "",
      signal: request.signal,
    });
    const saved = await access.coordinator.savePacketDraft(
      access.runId,
      body.expectedRevision,
      access.token,
      collected.draft,
    );
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
        blocked: collected.blocked,
        durationMs: collected.durationMs,
        searchWorkers: collected.searchAudits.map(({ itemId, status, durationMs, signal, error, value }) => ({
          itemId,
          status,
          durationMs: durationMs ?? null,
          signal: signal ?? null,
          providerStatus: value?.raw.status ?? null,
          failureCode: value?.raw.failureCode ?? null,
          error: error instanceof Error ? error.message : null,
        })),
        triageWorkers: collected.triageAudits.map(({ itemId, status, durationMs, fallbackUsed, signal, error }) => ({ itemId, status, durationMs: durationMs ?? null, fallbackUsed, signal: signal ?? null, error: error instanceof Error ? error.message : null })),
        importWorkers: collected.importAudits.map(({ itemId, status, durationMs, signal }) => ({ itemId, status, durationMs: durationMs ?? null, signal: signal ?? null })),
      },
    }, { status: collected.blocked ? 206 : 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
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
    if (usable.length < 2) {
      throw new Error("Add at least two sources with permitted text before freezing the packet.");
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
