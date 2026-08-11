import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  EvidenceCardSchema,
  SourceChunkSchema,
  SourceRecordSchema,
} from "../../../src/contracts";
import { createSourcePacketBuilder } from "../../../src/server/provenance/source-packet";

export const EVIDENCE_CHECKED_AT = "2026-08-08T05:30:00.000Z";
export const EVIDENCE_CHUNK_TEXT =
  "A bounded synthetic study found lower error in the reviewed setting.";

type EvidenceCard = z.output<typeof EvidenceCardSchema>;
type SourceChunk = z.output<typeof SourceChunkSchema>;
type SourceRecord = z.output<typeof SourceRecordSchema>;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function evidenceSource(
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return SourceRecordSchema.parse({
    id: "fixture-source-evidence-1",
    originalInput: "approved fixture source",
    canonicalDoi: "10.5555/evidence.1",
    canonicalUrl: "https://example.test/evidence/1",
    doiResolution: {
      syntax: "valid",
      resolution: "resolved",
      registrationAgency: "Crossref",
      checkedAt: EVIDENCE_CHECKED_AT,
    },
    bibliographicMetadata: {
      title: "Bounded synthetic evidence-card fixture",
      authors: ["Fixture Author"],
      year: 2026,
      venue: "Fixture Journal",
      studyType: "synthetic fixture",
    },
    access: {
      origin: "curated_fixture",
      contentScope: "user_excerpt",
      provider: "fixture",
      version: "fixture-v1",
      location: "approved fixture excerpt",
      retrievedAt: EVIDENCE_CHECKED_AT,
    },
    rights: {
      mayStore: "allowed",
      mayDisplay: "allowed",
      maySendToModel: "allowed",
      basis: "project-authored fixture",
      checkedAt: EVIDENCE_CHECKED_AT,
    },
    contentHash: sha256(EVIDENCE_CHUNK_TEXT),
    metadataVerification: {
      status: "match",
      method: "fixture",
      checkedAt: EVIDENCE_CHECKED_AT,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: ["fixture evidence only"],
    ...overrides,
  });
}

export function evidenceChunk(
  overrides: Partial<SourceChunk> = {},
): SourceChunk {
  const text = overrides.text ?? EVIDENCE_CHUNK_TEXT;
  return SourceChunkSchema.parse({
    id: "fixture-source-evidence-1-chunk-1",
    sourceId: "fixture-source-evidence-1",
    text,
    location: "approved fixture excerpt",
    contentHash: sha256(text),
    displayPermission: "allowed",
    ...overrides,
  });
}

export function evidenceCard(
  overrides: Partial<EvidenceCard> = {},
): EvidenceCard {
  return EvidenceCardSchema.parse({
    id: "fixture-evidence-card-1",
    subclaimId: "fixture-claim-1",
    sourceChunkId: "fixture-source-evidence-1-chunk-1",
    excerpt: "lower error",
    extractedResult: "The fixture reports lower error.",
    settingAndSample: "Bounded synthetic fixture setting.",
    studyType: "synthetic fixture",
    limitation: "This is fixture evidence, not a live study result.",
    relationship: "supports",
    deterministicVerification: {
      method: "model_claimed_check",
      status: "not_checked",
      checkedAt: null,
      details: "Application validation has not run.",
    },
    modelAssessment: {
      entailment: "partial_support",
      rationale: "Fixture model assessment remains separate.",
      provider: "fixture",
      requestedModelId: "fixture-primary",
      returnedModelId: "fixture-primary",
      promptId: "extract-grounded-evidence",
      promptVersion: "1.0.0",
      executionId: "fixture-execution-1",
    },
    conclusionStrengthWarning: "Fixture evidence is bounded.",
    humanReview: {
      status: "unreviewed",
      reason: null,
      reviewedAt: null,
      reviewerId: null,
    },
    extractionIssues: [],
    ...overrides,
  });
}

export async function evidenceContext(
  overrides: {
    knownSubclaimIds?: readonly string[];
    sources?: readonly SourceRecord[];
    chunks?: readonly SourceChunk[];
    checkedAt?: string;
  } = {},
) {
  const sources = structuredClone(overrides.sources ?? [evidenceSource()]);
  const chunks = structuredClone(overrides.chunks ?? [evidenceChunk()]);
  const builder = createSourcePacketBuilder();
  for (const source of sources) {
    const chunk = chunks.find(({ sourceId }) => sourceId === source.id);
    const stored = await builder.addSource({
      id: source.id,
      stableId: `fixture:${source.id}`,
      originalInput: source.originalInput,
      doi: null,
      url: null,
      title: source.bibliographicMetadata.title,
      authors: source.bibliographicMetadata.authors,
      year: source.bibliographicMetadata.year,
      venue: source.bibliographicMetadata.venue,
      studyType: source.bibliographicMetadata.studyType,
      origin: source.access.origin,
      contentScope:
        chunk === undefined ? "metadata_only" : source.access.contentScope,
      provider: source.access.provider,
      version: source.access.version,
      location: chunk?.location ?? source.access.location,
      retrievedAt: source.access.retrievedAt,
      content: chunk?.text ?? null,
      rights: {
        mayStore: source.rights.mayStore,
        mayDisplay: source.rights.mayDisplay,
        maySendToModel: source.rights.maySendToModel,
        permissionBasis: source.rights.basis,
        checkedAt: source.rights.checkedAt,
      },
      metadataVerification: source.metadataVerification,
      integrityNotices: source.integrityNotices,
      warnings: source.warnings,
    });
    if (stored.status === "rejected") {
      throw new Error(`fixture source rejected: ${stored.code}`);
    }
  }
  const frozen = await builder.freeze({
    frozenAt: EVIDENCE_CHECKED_AT,
    freezeDecision: {
      id: "fixture-evidence-packet-freeze",
      checkpoint: "packet_freeze",
      optionsShown: ["approve fixture packet", "return to fixture review"],
      decision: "approve",
      edits: [],
      decidedAt: EVIDENCE_CHECKED_AT,
      unresolvedObjections: [],
    },
  });
  return {
    capability: frozen.evidenceCapability,
    knownSubclaimIds: overrides.knownSubclaimIds ?? ["fixture-claim-1"],
    checkedAt: overrides.checkedAt ?? EVIDENCE_CHECKED_AT,
  };
}
