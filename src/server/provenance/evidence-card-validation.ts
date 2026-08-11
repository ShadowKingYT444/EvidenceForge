import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { z } from "zod";

import {
  DeterministicVerificationSchema,
  EvidenceCardSchema,
  PacketFreezeSchema,
  SourceChunkSchema,
  SourceRecordSchema,
  canonicalSha256,
  canonicalizeJson,
} from "../../contracts";
import {
  readTrustedSourcePacketCapability,
  type TrustedSourcePacketCapability,
} from "./source-packet";

type EvidenceCard = z.output<typeof EvidenceCardSchema>;
type SourceChunk = z.output<typeof SourceChunkSchema>;
type SourceRecord = z.output<typeof SourceRecordSchema>;
type EvidenceRelationship = EvidenceCard["relationship"];

export const EVIDENCE_RELATIONSHIPS = Object.freeze([
  ...EvidenceCardSchema.shape.relationship.options,
]) as readonly EvidenceRelationship[];

const relationshipSet = new Set<string>(EVIDENCE_RELATIONSHIPS);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const UNSAFE_REFERENCE_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/)/u;
const LOCALHOST_ENDPOINT_PATTERN = /^localhost(?::\d{1,5})?$/iu;
const IPV4_ENDPOINT_PATTERN =
  /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const UNSAFE_REFERENCE_FIELDS = new Set([
  "command",
  "endpoint",
  "fetch",
  "file",
  "href",
  "path",
  "tool",
  "uri",
  "url",
]);

export type EvidenceBoundaryErrorCode =
  | "invalid_context"
  | "duplicate_source_id"
  | "duplicate_chunk_id"
  | "unknown_source"
  | "invalid_chunk_hash"
  | "packet_identity_mismatch"
  | "model_send_denied"
  | "model_send_unknown";

export class EvidenceBoundaryError extends Error {
  readonly code: EvidenceBoundaryErrorCode;

  constructor(code: EvidenceBoundaryErrorCode, message: string) {
    super(message);
    this.name = "EvidenceBoundaryError";
    this.code = code;
  }
}

export type UntrustedEvidencePacket = Readonly<{
  kind: "evidenceforge.untrusted-source-packet.v1";
  authority: "none";
  toolAccess: "none";
  networkAccess: "none";
  permittedOperation: "reference_existing_chunk_and_exact_literal_only";
  packetFingerprint: string;
  chunks: readonly Readonly<{
    id: string;
    sourceId: string;
    location: string;
    contentHash: string;
    untrustedText: Readonly<{
      kind: "untrusted_source_text";
      encoding: "utf-8";
      value: string;
    }>;
  }>[];
}>;

export type EvidenceCardValidationFailureCode =
  | "unsafe_candidate_structure"
  | "unsafe_reference"
  | "invalid_candidate"
  | "unsupported_relationship"
  | "unknown_subclaim"
  | "unknown_chunk"
  | "model_send_denied"
  | "model_send_unknown"
  | "display_denied"
  | "display_unknown"
  | "missing_passage"
  | "ambiguous_passage";

export type EvidenceCardValidationResult =
  | Readonly<{
      status: "accepted";
      card: EvidenceCard;
      visibleQuote: string;
    }>
  | Readonly<{
      status: "rejected";
      code: EvidenceCardValidationFailureCode;
      field: "candidate" | "relationship" | "subclaimId" | "sourceChunkId" | "excerpt" | "rights";
      message: string;
    }>;

type EvidenceCardValidationField =
  | "candidate"
  | "relationship"
  | "subclaimId"
  | "sourceChunkId"
  | "excerpt"
  | "rights";

type EvidenceContextInput = Readonly<{
  knownSubclaimIds: readonly string[];
  checkedAt: string;
}>;

type PreparedPacketContext = Readonly<{
  packetFingerprint: string;
  sourcesById: ReadonlyMap<string, SourceRecord>;
  chunksById: ReadonlyMap<string, SourceChunk>;
}>;

type PreparedContext = PreparedPacketContext & Readonly<{
  knownSubclaimIds: ReadonlySet<string>;
  checkedAt: string;
}>;

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isEndpointIdentifier(value: string): boolean {
  if (LOCALHOST_ENDPOINT_PATTERN.test(value)) {
    return true;
  }
  const ipv4 = IPV4_ENDPOINT_PATTERN.exec(value);
  if (ipv4 === null) {
    return false;
  }
  const octets = ipv4[1]?.split(".").map(Number) ?? [];
  const port = ipv4[2] === undefined ? null : Number(ipv4[2]);
  return (
    octets.length === 4 &&
    octets.every((octet) => octet >= 0 && octet <= 255) &&
    (port === null || (port >= 1 && port <= 65_535))
  );
}

function isUnsafeIdentifier(value: string): boolean {
  return (
    !IDENTIFIER_PATTERN.test(value) ||
    UNSAFE_REFERENCE_PATTERN.test(value) ||
    isEndpointIdentifier(value)
  );
}

function hasPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSafeStructuredString(value: string): boolean {
  return (
    value.trim().length > 0 &&
    hasPairedSurrogates(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function uniqueById<T extends { id: string }>(
  values: readonly T[],
  duplicateCode: "duplicate_source_id" | "duplicate_chunk_id",
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) {
      throw new EvidenceBoundaryError(
        duplicateCode,
        "evidence context IDs must be unique",
      );
    }
    result.set(value.id, value);
  }
  return result;
}

function preparePacketContext(
  capability: TrustedSourcePacketCapability,
): PreparedPacketContext {
  const trustedPacket = readTrustedSourcePacketCapability(capability);
  if (trustedPacket === null) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "evidence validation requires a capability issued by a frozen source packet",
    );
  }
  const parsedPacket = PacketFreezeSchema.safeParse(trustedPacket.packet);
  if (
    !parsedPacket.success ||
    !HASH_PATTERN.test(trustedPacket.frozenEnvelopeHash)
  ) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "trusted frozen-packet identity must satisfy the shared contract",
    );
  }

  const parsedSources = SourceRecordSchema.array().safeParse(
    trustedPacket.sources,
  );
  const parsedChunks = SourceChunkSchema.array().safeParse(
    trustedPacket.chunks,
  );
  if (!parsedSources.success || !parsedChunks.success) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "evidence context does not satisfy the frozen shared contract",
    );
  }

  const sourcesById = uniqueById(parsedSources.data, "duplicate_source_id");
  const chunksById = uniqueById(parsedChunks.data, "duplicate_chunk_id");
  if (
    [...sourcesById.keys(), ...chunksById.keys()].some((id) =>
      isUnsafeIdentifier(id),
    ) ||
    [...chunksById.values()].some(
      (chunk) => isUnsafeIdentifier(chunk.sourceId),
    )
  ) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "source and chunk references must be canonical non-URL identifiers",
    );
  }
  for (const chunk of chunksById.values()) {
    if (!sourcesById.has(chunk.sourceId)) {
      throw new EvidenceBoundaryError(
        "unknown_source",
        "every evidence chunk must reference a known source",
      );
    }
    if (sha256Utf8(chunk.text) !== chunk.contentHash) {
      throw new EvidenceBoundaryError(
        "invalid_chunk_hash",
        "evidence chunk bytes must match their immutable hash",
      );
    }
  }

  const packet = parsedPacket.data;
  const sourceHashes = [
    ...new Set(parsedSources.data.map(({ contentHash }) => contentHash)),
  ].sort();
  const chunkHashes = [
    ...new Set(parsedChunks.data.map(({ contentHash }) => contentHash)),
  ].sort();
  let actualEnvelopeHash: string;
  try {
    actualEnvelopeHash = canonicalSha256({
      packet,
      sources: parsedSources.data,
      chunks: parsedChunks.data,
    });
  } catch {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "frozen packet graph is not canonically serializable",
    );
  }
  if (
    packet.sourceHashes.length !== sourceHashes.length ||
    packet.sourceHashes.some((hash, index) => hash !== sourceHashes[index]) ||
    packet.chunkHashes.length !== chunkHashes.length ||
    packet.chunkHashes.some((hash, index) => hash !== chunkHashes[index]) ||
    actualEnvelopeHash !== trustedPacket.frozenEnvelopeHash
  ) {
    throw new EvidenceBoundaryError(
      "packet_identity_mismatch",
      "source, chunk, rights, and ownership graph does not match the trusted frozen envelope",
    );
  }

  return {
    packetFingerprint: packet.fingerprint,
    sourcesById,
    chunksById,
  };
}

function prepareContext(
  input: EvidenceContextInput,
  capability: TrustedSourcePacketCapability,
): PreparedContext {
  if (
    !isPassiveJsonData(input) ||
    !Array.isArray(input.knownSubclaimIds) ||
    input.knownSubclaimIds.length === 0 ||
    input.knownSubclaimIds.some(
      (id) =>
        isUnsafeIdentifier(id),
    ) ||
    new Set(input.knownSubclaimIds).size !== input.knownSubclaimIds.length
  ) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "evidence context subclaim IDs must be canonical and unique",
    );
  }
  const checkedAt = DeterministicVerificationSchema.safeParse({
    method: "exact_unique_literal_substring",
    status: "verified",
    checkedAt: input.checkedAt,
    details: "Application-derived exact quote validation.",
  });
  if (!checkedAt.success) {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "evidence validation time must satisfy the shared contract",
    );
  }
  return {
    ...preparePacketContext(capability),
    knownSubclaimIds: new Set(input.knownSubclaimIds),
    checkedAt: input.checkedAt,
  };
}

function modelSendCode(
  source: SourceRecord,
): "model_send_denied" | "model_send_unknown" | null {
  if (source.rights.maySendToModel === "denied") {
    return "model_send_denied";
  }
  if (source.rights.maySendToModel === "unknown") {
    return "model_send_unknown";
  }
  return null;
}

export function createUntrustedEvidencePacket(
  capability: TrustedSourcePacketCapability,
): UntrustedEvidencePacket {
  const prepared = preparePacketContext(capability);
  const chunks = [...prepared.chunksById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((chunk) => {
      const source = prepared.sourcesById.get(chunk.sourceId);
      if (source === undefined) {
        throw new EvidenceBoundaryError(
          "unknown_source",
          "every evidence chunk must reference a known source",
        );
      }
      const denied = modelSendCode(source);
      if (denied !== null) {
        throw new EvidenceBoundaryError(
          denied,
          "source rights do not permit this chunk to cross the model boundary",
        );
      }
      return {
        id: chunk.id,
        sourceId: chunk.sourceId,
        location: chunk.location,
        contentHash: chunk.contentHash,
        untrustedText: {
          kind: "untrusted_source_text" as const,
          encoding: "utf-8" as const,
          value: chunk.text,
        },
      };
    });
  const packet = {
    kind: "evidenceforge.untrusted-source-packet.v1" as const,
    authority: "none" as const,
    toolAccess: "none" as const,
    networkAccess: "none" as const,
    permittedOperation:
      "reference_existing_chunk_and_exact_literal_only" as const,
    packetFingerprint: prepared.packetFingerprint,
    chunks,
  };
  try {
    canonicalizeJson(packet);
  } catch {
    throw new EvidenceBoundaryError(
      "invalid_context",
      "untrusted source data is not canonically serializable",
    );
  }
  return deepFreeze(packet);
}

export function serializeUntrustedEvidencePacket(
  packet: UntrustedEvidencePacket,
): string {
  return canonicalizeJson(packet);
}

function isPassiveJsonData(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    ancestors.has(value)
  ) {
    return false;
  }

  const isArray = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (isArray ? Array.prototype : Object.prototype) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (isArray && key === "length") {
      continue;
    }
    if (
      isArray &&
      (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)
    ) {
      ancestors.delete(value);
      return false;
    }
    if (
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      !isPassiveJsonData(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function hasSafeStructuredStrings(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (typeof value === "string") {
    return isSafeStructuredString(value);
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (utilTypes.isProxy(value) || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      "value" in descriptor &&
      !hasSafeStructuredStrings(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function reject(
  code: EvidenceCardValidationFailureCode,
  field: EvidenceCardValidationField,
  message: string,
): EvidenceCardValidationResult {
  return Object.freeze({ status: "rejected", code, field, message });
}

function hasUnsafeReference(candidate: Record<string, unknown>): boolean {
  if (
    Object.keys(candidate).some((key) =>
      UNSAFE_REFERENCE_FIELDS.has(key.toLowerCase()),
    )
  ) {
    return true;
  }
  return [candidate.id, candidate.subclaimId, candidate.sourceChunkId].some(
    (value) =>
      typeof value === "string" && UNSAFE_REFERENCE_PATTERN.test(value),
  );
}

function displayCode(
  source: SourceRecord,
  chunk: SourceChunk,
): "display_denied" | "display_unknown" | null {
  if (
    source.rights.mayDisplay === "denied" ||
    chunk.displayPermission === "denied"
  ) {
    return "display_denied";
  }
  if (
    source.rights.mayDisplay === "unknown" ||
    chunk.displayPermission === "unknown"
  ) {
    return "display_unknown";
  }
  return null;
}

export function createEvidenceCardValidator(
  input: EvidenceContextInput,
  capability: TrustedSourcePacketCapability,
) {
  const prepared = prepareContext(input, capability);
  return Object.freeze({
    validate(candidateInput: unknown): EvidenceCardValidationResult {
      if (!isPassiveJsonData(candidateInput)) {
        return reject(
          "unsafe_candidate_structure",
          "candidate",
          "evidence candidate must be passive JSON data",
        );
      }
      const candidate = candidateInput as Record<string, unknown>;
      if (!hasSafeStructuredStrings(candidate)) {
        return reject(
          "invalid_candidate",
          "candidate",
          "evidence candidate strings must be nonempty control-free Unicode scalars",
        );
      }
      if (hasUnsafeReference(candidate)) {
        return reject(
          "unsafe_reference",
          "candidate",
          "evidence candidates cannot supply network, file, path, or tool references",
        );
      }
      if (
        typeof candidate.relationship === "string" &&
        !relationshipSet.has(candidate.relationship)
      ) {
        return reject(
          "unsupported_relationship",
          "relationship",
          "evidence relationship is outside the shared contract enum",
        );
      }
      const parsed = EvidenceCardSchema.safeParse(candidate);
      if (!parsed.success) {
        return reject(
          "invalid_candidate",
          "candidate",
          "evidence candidate does not satisfy the shared closed schema",
        );
      }
      const card = parsed.data;
      if (card.humanReview.status !== "unreviewed") {
        return reject(
          "invalid_candidate",
          "candidate",
          "model evidence candidates cannot manufacture a completed human review",
        );
      }
      if (!prepared.knownSubclaimIds.has(card.subclaimId)) {
        return reject(
          "unknown_subclaim",
          "subclaimId",
          "evidence candidate must reference a known subclaim",
        );
      }
      const chunk = prepared.chunksById.get(card.sourceChunkId);
      if (chunk === undefined) {
        return reject(
          "unknown_chunk",
          "sourceChunkId",
          "evidence candidate must reference a known immutable chunk",
        );
      }
      const source = prepared.sourcesById.get(chunk.sourceId);
      if (source === undefined) {
        return reject(
          "unknown_chunk",
          "sourceChunkId",
          "evidence chunk is detached from the frozen packet",
        );
      }

      const deniedModelSend = modelSendCode(source);
      if (deniedModelSend !== null) {
        return reject(
          deniedModelSend,
          "rights",
          "source rights do not permit model use",
        );
      }
      const deniedDisplay = displayCode(source, chunk);
      if (deniedDisplay !== null) {
        return reject(
          deniedDisplay,
          "rights",
          "source rights do not permit quote display",
        );
      }

      const firstMatch = chunk.text.indexOf(card.excerpt);
      if (firstMatch < 0) {
        return reject(
          "missing_passage",
          "excerpt",
          "evidence excerpt is not an exact literal chunk substring",
        );
      }
      if (chunk.text.indexOf(card.excerpt, firstMatch + 1) >= 0) {
        return reject(
          "ambiguous_passage",
          "excerpt",
          "evidence excerpt occurs more than once in the referenced chunk",
        );
      }

      const visibleQuote = chunk.text.slice(
        firstMatch,
        firstMatch + card.excerpt.length,
      );
      const validatedCard = EvidenceCardSchema.parse({
        ...card,
        excerpt: visibleQuote,
        deterministicVerification: {
          method: "exact_unique_literal_substring",
          status: "verified",
          checkedAt: prepared.checkedAt,
          details:
            "Application derived one exact literal substring from the referenced immutable chunk after model-send and display rights checks.",
        },
      });
      return deepFreeze({
        status: "accepted" as const,
        card: validatedCard,
        visibleQuote,
      });
    },
  });
}
