import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { z } from "zod";

import {
  SourceChunkSchema,
  SourceRecordSchema,
  canonicalSha256,
  canonicalizeJson,
  freezePacket,
  type PacketFreeze,
} from "../../contracts";
import { normalizeDoi } from "../retrieval/doi";

export type SourcePermissionState = "allowed" | "denied" | "unknown";
export type SourceContentScope =
  | "metadata_only"
  | "abstract"
  | "user_excerpt"
  | "full_text";

type SourceRecord = z.output<typeof SourceRecordSchema>;
type SourceChunk = z.output<typeof SourceChunkSchema>;

export type SourceRightsInput = {
  mayStore?: SourcePermissionState;
  mayDisplay?: SourcePermissionState;
  maySendToModel?: SourcePermissionState;
  permissionBasis?: string | null;
  checkedAt?: string | null;
};

export type SourceIngestionInput = {
  id: string;
  stableId?: string | null;
  originalInput: string;
  doi?: string | null;
  url?: string | null;
  title: string;
  authors?: readonly string[];
  year?: number | null;
  venue?: string | null;
  studyType?: string | null;
  origin: "user_import" | "curated_fixture" | "live_discovery";
  contentScope: SourceContentScope;
  provider: string;
  version?: string | null;
  location: string;
  retrievedAt: string;
  content?: string | null;
  rights?: SourceRightsInput;
  doiResolution?: SourceRecord["doiResolution"];
  metadataVerification?: SourceRecord["metadataVerification"];
  integrityNotices?: SourceRecord["integrityNotices"];
  warnings?: readonly string[];
};

export type SourceSafeMetadata = {
  requestedSourceId: string;
  canonicalSourceId: string | null;
  canonicalDoi: string | null;
  canonicalUrl: string | null;
  title: string;
  contentScope: SourceContentScope;
  rights: {
    mayStore: SourcePermissionState;
    mayDisplay: SourcePermissionState;
    maySendToModel: SourcePermissionState;
  };
  permissionBasis: string | null;
  contentReason:
    | "available"
    | "metadata_only"
    | "storage_permission_denied"
    | "storage_permission_unknown"
    | "permission_basis_missing"
    | "permission_decision_invalid"
    | "display_permission_denied"
    | "display_permission_unknown";
};

export type SourceIngestionErrorCode =
  | "storage_permission_denied"
  | "storage_permission_unknown"
  | "permission_basis_missing"
  | "permission_decision_invalid"
  | "stable_identifier_missing"
  | "invalid_identifier"
  | "identity_collision"
  | "alias_conflict"
  | "invalid_metadata"
  | "invalid_content"
  | "content_required"
  | "content_not_allowed"
  | "content_limit_exceeded"
  | "packet_source_limit_exceeded"
  | "packet_chunk_limit_exceeded";

export type SourceIngestionResult =
  | {
      status: "stored";
      code: null;
      canonicalSourceId: string;
      safeMetadata: SourceSafeMetadata;
    }
  | {
      status: "deduplicated";
      code: null;
      canonicalSourceId: string;
      safeMetadata: SourceSafeMetadata;
    }
  | {
      status: "rejected";
      code: SourceIngestionErrorCode;
      canonicalSourceId: null;
      safeMetadata: SourceSafeMetadata;
    };

type PacketOperation =
  | "add"
  | "edit"
  | "delete"
  | "change_permissions"
  | "freeze";

export type PacketMutationErrorCode =
  | "packet_frozen"
  | "freeze_conflict"
  | "invalid_input"
  | "source_not_found"
  | "invalid_permissions"
  | "invalid_edit"
  | "empty_packet";

export class PacketMutationError extends Error {
  readonly code: PacketMutationErrorCode;
  readonly operation: PacketOperation;

  constructor(
    code: PacketMutationErrorCode,
    operation: PacketOperation,
    message: string,
  ) {
    super(message);
    this.name = "PacketMutationError";
    this.code = code;
    this.operation = operation;
  }
}

export type PacketAuditRecord = {
  id: string;
  sequence: number;
  occurredAt: string;
  operation: PacketOperation;
  outcome: "rejected";
  code: PacketMutationErrorCode;
  targetIdHash: string | null;
};

export type PacketLogEvent = {
  service: "source_packet";
  operation: PacketOperation;
  outcome: "stored" | "deduplicated" | "rejected" | "frozen";
  code: SourceIngestionErrorCode | PacketMutationErrorCode | null;
  sourceCount: number;
  chunkCount: number;
};

export type SourcePacketLimits = {
  maxSources: number;
  maxChunks: number;
  maxContentBytes: number;
  maxChunkBytes: number;
};

export type SourcePacketBuilderDependencies = {
  now?: () => Date;
  limits?: Partial<SourcePacketLimits>;
  log?: (event: PacketLogEvent) => void;
};

type NormalizedRights = {
  mayStore: SourcePermissionState;
  mayDisplay: SourcePermissionState;
  maySendToModel: SourcePermissionState;
  basis: string | null;
  checkedAt: string | null;
};

type Identity = {
  canonicalDoi: string | null;
  canonicalUrl: string | null;
  explicitCanonicalUrl: string | null;
  stableId: string | null;
  keys: string[];
};

type StoredSource = {
  record: SourceRecord;
  chunks: SourceChunk[];
  identity: Identity;
  aliasMaterialHash: string;
};

type ReviewChunk = {
  id: string;
  sourceId: string;
  text: string;
  location: string;
  contentHash: string;
};

type ReviewSource = {
  id: string;
  canonicalDoi: string | null;
  canonicalUrl: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  studyType: string | null;
  contentScope: SourceContentScope;
  rights: {
    mayStore: SourcePermissionState;
    mayDisplay: SourcePermissionState;
    maySendToModel: SourcePermissionState;
  };
  permissionBasis: string;
  mergedSourceIds: string[];
  warnings: string[];
  content:
    | {
        status: "available";
        reason: "available";
        chunks: ReviewChunk[];
      }
    | {
        status: "metadata_only";
        reason: "metadata_only";
        chunks: [];
      }
    | {
        status: "blocked";
        reason:
          | "display_permission_denied"
          | "display_permission_unknown";
        chunks: [];
      };
};

export type PacketReviewSnapshot = {
  state: "draft" | "frozen";
  packetFingerprint: string | null;
  sources: ReviewSource[];
};

export type PacketModelPayload = {
  state: "draft" | "frozen";
  packetFingerprint: string | null;
  chunks: ReviewChunk[];
};

export type FrozenSourcePacket = {
  packet: PacketFreeze;
  frozenEnvelopeHash: string;
  frozenByteLength: number;
  sourceCount: number;
  chunkCount: number;
  review: PacketReviewSnapshot;
  modelPayload: PacketModelPayload;
  evidenceCapability: TrustedSourcePacketCapability;
};

/**
 * Process-local authority issued only by a successful packet freeze. The
 * enumerable fields are audit metadata; cloning or serializing them does not
 * transfer authority.
 */
export type TrustedSourcePacketCapability = Readonly<{
  kind: "evidenceforge.trusted-source-packet-capability.v1";
  packetFingerprint: string;
}>;

export type TrustedSourcePacketSnapshot = Readonly<{
  packet: PacketFreeze;
  frozenEnvelopeHash: string;
  sources: readonly SourceRecord[];
  chunks: readonly SourceChunk[];
}>;

type FrozenSourcePacketData = Omit<
  FrozenSourcePacket,
  "evidenceCapability"
>;

type FrozenEnvelope = {
  packet: PacketFreeze;
  sources: SourceRecord[];
  chunks: SourceChunk[];
};

const trustedSourcePacketSnapshots = new WeakMap<
  object,
  TrustedSourcePacketSnapshot
>();

type FrozenInternal = {
  requestHash: string;
  packet: PacketFreeze;
  envelope: FrozenEnvelope;
  envelopeHash: string;
  byteLength: number;
  result: FrozenSourcePacketData;
  evidenceCapability: TrustedSourcePacketCapability;
};

const DEFAULT_LIMITS: SourcePacketLimits = {
  maxSources: 8,
  maxChunks: 128,
  maxContentBytes: 1_000_000,
  maxChunkBytes: 4_000,
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function assertPairedSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PacketMutationError(
          "invalid_edit",
          "add",
          "text contains an unpaired surrogate",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new PacketMutationError(
        "invalid_edit",
        "add",
        "text contains an unpaired surrogate",
      );
    }
  }
}

function isCanonicalIdentifier(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    assertPairedSurrogates(value);
  } catch {
    return false;
  }
  return IDENTIFIER_PATTERN.test(value);
}

function isCanonicalStructuredString(value: string): boolean {
  try {
    assertPairedSurrogates(value);
  } catch {
    return false;
  }
  return (
    value.trim().length > 0 &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function hasCanonicalStructuredStrings(value: unknown): boolean {
  if (typeof value === "string") {
    return isCanonicalStructuredString(value);
  }
  if (Array.isArray(value)) {
    return value.every(hasCanonicalStructuredStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(hasCanonicalStructuredStrings);
  }
  return true;
}

function hasCanonicalSourceInputStrings(
  input: SourceIngestionInput,
): boolean {
  return Object.entries(input).every(
    ([key, value]) =>
      key === "content" || hasCanonicalStructuredStrings(value),
  );
}

function isPassivePlainData(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null || typeof value !== "object") {
    return (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    );
  }
  if (utilTypes.isProxy(value) || ancestors.has(value)) {
    return false;
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    prototype !== (isArray ? Array.prototype : Object.prototype)
  ) {
    return false;
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      ancestors.delete(value);
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !isPassivePlainData(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

export function sha256Utf8(value: string): string {
  assertPairedSurrogates(value);
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256AuditIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function issueTrustedSourcePacketCapability(
  snapshot: TrustedSourcePacketSnapshot,
): TrustedSourcePacketCapability {
  const ownedSnapshot = frozenClone(snapshot);
  const capability = Object.freeze({
    kind: "evidenceforge.trusted-source-packet-capability.v1" as const,
    packetFingerprint: ownedSnapshot.packet.fingerprint,
  });
  trustedSourcePacketSnapshots.set(capability, ownedSnapshot);
  return capability;
}

/** @internal Authenticate before any reflection or schema traversal. */
export function readTrustedSourcePacketCapability(
  capability: unknown,
): TrustedSourcePacketSnapshot | null {
  if (
    capability === null ||
    (typeof capability !== "object" && typeof capability !== "function")
  ) {
    return null;
  }
  const snapshot = trustedSourcePacketSnapshots.get(capability);
  return snapshot === undefined ? null : frozenClone(snapshot);
}

function frozenSourcePacketResult(
  frozenPacket: FrozenInternal,
): FrozenSourcePacket {
  return deepFreeze({
    ...structuredClone(frozenPacket.result),
    evidenceCapability: frozenPacket.evidenceCapability,
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new RangeError(`${name} must be an integer ${minimum}-${maximum}`);
  }
  return selected;
}

function readLimits(input: Partial<SourcePacketLimits> | undefined) {
  const limits = {
    maxSources: boundedInteger(
      input?.maxSources,
      DEFAULT_LIMITS.maxSources,
      1,
      8,
      "maxSources",
    ),
    maxChunks: boundedInteger(
      input?.maxChunks,
      DEFAULT_LIMITS.maxChunks,
      1,
      1_024,
      "maxChunks",
    ),
    maxContentBytes: boundedInteger(
      input?.maxContentBytes,
      DEFAULT_LIMITS.maxContentBytes,
      1,
      4_000_000,
      "maxContentBytes",
    ),
    maxChunkBytes: boundedInteger(
      input?.maxChunkBytes,
      DEFAULT_LIMITS.maxChunkBytes,
      4,
      64_000,
      "maxChunkBytes",
    ),
  };
  if (limits.maxChunkBytes > limits.maxContentBytes) {
    throw new RangeError(
      "maxChunkBytes must not exceed maxContentBytes",
    );
  }
  return limits;
}

function normalizePermission(
  value: SourcePermissionState | undefined,
): SourcePermissionState {
  return value === "allowed" || value === "denied" ? value : "unknown";
}

function normalizeRights(
  rights: SourceRightsInput | undefined,
): NormalizedRights {
  const basis = rights?.permissionBasis?.trim() || null;
  const checkedAt =
    rights?.checkedAt !== null &&
    rights?.checkedAt !== undefined &&
    ISO_TIMESTAMP_PATTERN.test(rights.checkedAt) &&
    Number.isFinite(Date.parse(rights.checkedAt))
      ? rights.checkedAt
      : null;
  return {
    mayStore: normalizePermission(rights?.mayStore),
    mayDisplay: normalizePermission(rights?.mayDisplay),
    maySendToModel: normalizePermission(rights?.maySendToModel),
    basis,
    checkedAt,
  };
}

function redactCanonicalUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const url = new URL(value);
  const hasQuery = url.search !== "";
  url.search = "";
  return hasQuery ? `${url.toString()}?…` : url.toString();
}

function safeMetadata(
  input: SourceIngestionInput,
  rights: NormalizedRights,
  identity: Identity | null,
  reason: SourceSafeMetadata["contentReason"],
  canonicalSourceId: string | null = null,
): SourceSafeMetadata {
  const contentScope = [
    "metadata_only",
    "abstract",
    "user_excerpt",
    "full_text",
  ].includes(input.contentScope)
    ? input.contentScope
    : "metadata_only";
  return {
    requestedSourceId: isCanonicalIdentifier(input.id) ? input.id : "",
    canonicalSourceId,
    canonicalDoi: identity?.canonicalDoi ?? null,
    canonicalUrl: redactCanonicalUrl(identity?.canonicalUrl ?? null),
    title:
      typeof input.title === "string" &&
      isCanonicalStructuredString(input.title)
        ? input.title
        : "",
    contentScope,
    rights: {
      mayStore: rights.mayStore,
      mayDisplay: rights.mayDisplay,
      maySendToModel: rights.maySendToModel,
    },
    permissionBasis:
      rights.basis !== null &&
      isCanonicalStructuredString(rights.basis)
        ? rights.basis
        : null,
    contentReason: reason,
  };
}

function canonicalizeImportedUrl(input: string): string | null {
  try {
    assertPairedSurrogates(input);
    const url = new URL(input.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    url.hash = "";
    const pairs = [...url.searchParams.entries()].sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) ||
        leftValue.localeCompare(rightValue),
    );
    url.search = "";
    for (const [key, value] of pairs) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeStableId(input: string | null | undefined): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  return isCanonicalIdentifier(input) ? input : null;
}

function sourceIdentity(
  input: SourceIngestionInput,
): { identity: Identity | null; code: SourceIngestionErrorCode | null } {
  const doi = normalizeDoi(input.doi);
  if (input.doi !== null && input.doi !== undefined && doi.status !== "valid") {
    return { identity: null, code: "invalid_identifier" };
  }
  const explicitCanonicalUrl =
    input.url === null || input.url === undefined
      ? null
      : canonicalizeImportedUrl(input.url);
  if (
    input.url !== null &&
    input.url !== undefined &&
    explicitCanonicalUrl === null
  ) {
    return { identity: null, code: "invalid_identifier" };
  }
  const stableId = normalizeStableId(input.stableId);
  if (
    input.stableId !== null &&
    input.stableId !== undefined &&
    stableId === null
  ) {
    return { identity: null, code: "invalid_identifier" };
  }
  const canonicalDoi = doi.status === "valid" ? doi.canonicalDoi : null;
  const canonicalUrl =
    doi.status === "valid" ? doi.canonicalUrl : explicitCanonicalUrl;
  const keys = [
    ...(canonicalDoi === null ? [] : [`doi:${canonicalDoi}`]),
    ...(canonicalUrl === null ? [] : [`url:${canonicalUrl}`]),
    ...(explicitCanonicalUrl === null ||
    explicitCanonicalUrl === canonicalUrl
      ? []
      : [`url:${explicitCanonicalUrl}`]),
    ...(stableId === null ? [] : [`stable:${stableId}`]),
  ];
  if (keys.length === 0) {
    return { identity: null, code: "stable_identifier_missing" };
  }
  return {
    identity: {
      canonicalDoi,
      canonicalUrl,
      explicitCanonicalUrl,
      stableId,
      keys: [...new Set(keys)].sort(),
    },
    code: null,
  };
}

function splitContent(
  sourceId: string,
  text: string,
  location: string,
  maximumBytes: number,
): SourceChunk[] {
  assertPairedSurrogates(text);
  const chunks: SourceChunk[] = [];
  let current = "";
  let currentBytes = 0;
  let startByte = 0;
  let consumedBytes = 0;

  const push = () => {
    if (current.length === 0) {
      return;
    }
    const endByte = startByte + currentBytes;
    chunks.push(
      SourceChunkSchema.parse({
        id: `${sourceId}-chunk-${chunks.length + 1}`,
        sourceId,
        text: current,
        location: `${location} [UTF-8 bytes ${startByte}-${endByte})`,
        contentHash: sha256Utf8(current),
        displayPermission: "allowed",
      }),
    );
    current = "";
    currentBytes = 0;
    startByte = endByte;
  };

  for (const scalar of text) {
    const scalarBytes = new TextEncoder().encode(scalar).byteLength;
    if (currentBytes > 0 && currentBytes + scalarBytes > maximumBytes) {
      push();
    }
    current += scalar;
    currentBytes += scalarBytes;
    consumedBytes += scalarBytes;
  }
  push();
  if (startByte !== consumedBytes) {
    throw new Error("chunk byte accounting failed");
  }
  return chunks;
}

function defaultDoiResolution(
  identity: Identity,
): SourceRecord["doiResolution"] {
  return {
    syntax: identity.canonicalDoi === null ? "not_provided" : "valid",
    resolution: "not_checked",
    registrationAgency: null,
    checkedAt: null,
  };
}

function defaultMetadataVerification(): SourceRecord["metadataVerification"] {
  return {
    status: "not_checked",
    method: "not_checked",
    checkedAt: null,
    fieldDiffs: [],
  };
}

function aliasMaterial(
  record: SourceRecord,
): string {
  return canonicalSha256({
    canonicalDoi: record.canonicalDoi,
    canonicalUrl: record.canonicalUrl,
    bibliographicMetadata: record.bibliographicMetadata,
    access: {
      origin: record.access.origin,
      contentScope: record.access.contentScope,
      provider: record.access.provider,
      version: record.access.version,
      location: record.access.location,
    },
    rights: record.rights,
    contentHash: record.contentHash,
    metadataVerification: record.metadataVerification,
    integrityNotices: record.integrityNotices,
    warnings: record.warnings,
  });
}

function identitiesConflict(left: Identity, right: Identity): boolean {
  return (
    left.canonicalDoi !== right.canonicalDoi &&
    (left.canonicalDoi !== null || right.canonicalDoi !== null)
  );
}

function compareSourceId(
  left: StoredSource,
  right: StoredSource,
): number {
  return left.record.id.localeCompare(right.record.id);
}

export function createSourcePacketBuilder(
  dependencies: SourcePacketBuilderDependencies = {},
) {
  const limits = readLimits(dependencies.limits);
  const now = dependencies.now ?? (() => new Date());
  const sources = new Map<string, StoredSource>();
  const identityIndex = new Map<string, string>();
  const aliasIndex = new Map<string, string>();
  const audit: PacketAuditRecord[] = [];
  let frozen: FrozenInternal | null = null;
  let queue: Promise<void> = Promise.resolve();

  function sourceCount() {
    return sources.size;
  }

  function chunkCount() {
    return [...sources.values()].reduce(
      (total, source) => total + source.chunks.length,
      0,
    );
  }

  function log(
    operation: PacketOperation,
    outcome: PacketLogEvent["outcome"],
    code: PacketLogEvent["code"],
  ) {
    dependencies.log?.({
      service: "source_packet",
      operation,
      outcome,
      code,
      sourceCount: sourceCount(),
      chunkCount: chunkCount(),
    });
  }

  function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = queue.then(operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function appendRejectedAudit(
    operation: PacketOperation,
    code: PacketMutationErrorCode,
    targetId: string | null,
  ) {
    const sequence = audit.length + 1;
    audit.push({
      id: `packet-audit-${sequence}`,
      sequence,
      occurredAt: now().toISOString(),
      operation,
      outcome: "rejected",
      code,
      targetIdHash:
        targetId === null ? null : sha256AuditIdentifier(targetId),
    });
    log(operation, "rejected", code);
  }

  function ensureMutable(
    operation: Exclude<PacketOperation, "freeze">,
    targetId: string | null,
  ) {
    if (frozen !== null) {
      appendRejectedAudit(operation, "packet_frozen", targetId);
      throw new PacketMutationError(
        "packet_frozen",
        operation,
        "the source packet is frozen",
      );
    }
  }

  function rejected(
    input: SourceIngestionInput,
    rights: NormalizedRights,
    identity: Identity | null,
    code: SourceIngestionErrorCode,
    reason: SourceSafeMetadata["contentReason"] = "available",
  ): SourceIngestionResult {
    log("add", "rejected", code);
    return frozenClone({
      status: "rejected",
      code,
      canonicalSourceId: null,
      safeMetadata: safeMetadata(input, rights, identity, reason),
    });
  }

  function buildSource(
    input: SourceIngestionInput,
    identity: Identity,
    rights: NormalizedRights,
  ):
    | { source: StoredSource; code: null }
    | { source: null; code: SourceIngestionErrorCode } {
    let content = input.content ?? null;
    if (input.contentScope === "metadata_only") {
      if (content !== null && content.length > 0) {
        return { source: null, code: "content_not_allowed" };
      }
      content = "";
    } else if (content === null || content.trim().length === 0) {
      return { source: null, code: "content_required" };
    }

    let contentBytes: number;
    let chunks: SourceChunk[];
    try {
      assertPairedSurrogates(content);
      contentBytes = new TextEncoder().encode(content).byteLength;
      if (contentBytes > limits.maxContentBytes) {
        return { source: null, code: "content_limit_exceeded" };
      }
      chunks =
        input.contentScope === "metadata_only"
          ? []
          : splitContent(
              input.id,
              content,
              input.location,
              limits.maxChunkBytes,
            );
    } catch {
      return { source: null, code: "invalid_content" };
    }
    if (chunkCount() + chunks.length > limits.maxChunks) {
      return { source: null, code: "packet_chunk_limit_exceeded" };
    }
    for (const chunk of chunks) {
      chunk.displayPermission = rights.mayDisplay;
    }

    try {
      const record = SourceRecordSchema.parse({
        id: input.id,
        originalInput: input.originalInput,
        canonicalDoi: identity.canonicalDoi,
        canonicalUrl: identity.canonicalUrl,
        doiResolution:
          input.doiResolution ?? defaultDoiResolution(identity),
        bibliographicMetadata: {
          title: input.title,
          authors: [...(input.authors ?? [])],
          year: input.year ?? null,
          venue: input.venue ?? null,
          studyType: input.studyType ?? null,
        },
        access: {
          origin: input.origin,
          contentScope: input.contentScope,
          provider: input.provider,
          version: input.version ?? null,
          location: input.location,
          retrievedAt: input.retrievedAt,
        },
        rights: {
          mayStore: rights.mayStore,
          mayDisplay: rights.mayDisplay,
          maySendToModel: rights.maySendToModel,
          basis: rights.basis,
          checkedAt: rights.checkedAt,
        },
        contentHash: sha256Utf8(content),
        metadataVerification:
          input.metadataVerification ?? defaultMetadataVerification(),
        integrityNotices: structuredClone(input.integrityNotices ?? []),
        mergedSourceIds: [],
        warnings: [...(input.warnings ?? [])],
      });
      return {
        source: {
          record,
          chunks,
          identity: structuredClone(identity),
          aliasMaterialHash: aliasMaterial(record),
        },
        code: null,
      };
    } catch {
      return { source: null, code: "invalid_metadata" };
    }
  }

  async function addSource(
    input: SourceIngestionInput,
  ): Promise<SourceIngestionResult> {
    if (!isPassivePlainData(input)) {
      return enqueue(() => {
        ensureMutable("add", null);
        log("add", "rejected", "invalid_metadata");
        return frozenClone({
          status: "rejected" as const,
          code: "invalid_metadata" as const,
          canonicalSourceId: null,
          safeMetadata: {
            requestedSourceId: "invalid-input",
            canonicalSourceId: null,
            canonicalDoi: null,
            canonicalUrl: null,
            title: "Invalid source input",
            contentScope: "metadata_only" as const,
            rights: {
              mayStore: "unknown" as const,
              mayDisplay: "unknown" as const,
              maySendToModel: "unknown" as const,
            },
            permissionBasis: null,
            contentReason: "permission_decision_invalid" as const,
          },
        });
      });
    }
    const inputSnapshot = structuredClone(input);
    return enqueue(() => {
      ensureMutable(
        "add",
        typeof inputSnapshot.id === "string" ? inputSnapshot.id : null,
      );
      const rights = normalizeRights(inputSnapshot.rights);
      if (rights.mayStore === "denied") {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "storage_permission_denied",
          "storage_permission_denied",
        );
      }
      if (rights.mayStore !== "allowed") {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "storage_permission_unknown",
          "storage_permission_unknown",
        );
      }
      if (rights.basis === null) {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "permission_basis_missing",
          "permission_basis_missing",
        );
      }
      if (rights.checkedAt === null) {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "permission_decision_invalid",
          "permission_decision_invalid",
        );
      }

      if (!isCanonicalIdentifier(inputSnapshot.id)) {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "invalid_identifier",
        );
      }
      if (!hasCanonicalSourceInputStrings(inputSnapshot)) {
        return rejected(
          inputSnapshot,
          rights,
          null,
          "invalid_metadata",
        );
      }

      const identified = sourceIdentity(inputSnapshot);
      if (identified.identity === null || identified.code !== null) {
        return rejected(
          inputSnapshot,
          rights,
          null,
          identified.code ?? "invalid_identifier",
        );
      }
      const identity = identified.identity;
      const matchingIds = new Set<string>();
      const existingAlias = aliasIndex.get(inputSnapshot.id);
      if (existingAlias !== undefined) {
        matchingIds.add(existingAlias);
      }
      for (const key of identity.keys) {
        const match = identityIndex.get(key);
        if (match !== undefined) {
          matchingIds.add(match);
        }
      }
      if (matchingIds.size > 1) {
        return rejected(
          inputSnapshot,
          rights,
          identity,
          "identity_collision",
        );
      }
      const matchingId = matchingIds.values().next().value as
        | string
        | undefined;
      if (matchingId === undefined && sources.size >= limits.maxSources) {
        return rejected(
          inputSnapshot,
          rights,
          identity,
          "packet_source_limit_exceeded",
        );
      }
      const built = buildSource(inputSnapshot, identity, rights);
      if (built.source === null) {
        return rejected(inputSnapshot, rights, identity, built.code);
      }
      if (matchingId !== undefined) {
        const existing = sources.get(matchingId);
        if (
          existing === undefined ||
          identitiesConflict(existing.identity, identity)
        ) {
          return rejected(
            inputSnapshot,
            rights,
            identity,
            "identity_collision",
          );
        }
        if (existing.aliasMaterialHash !== built.source.aliasMaterialHash) {
          return rejected(
            inputSnapshot,
            rights,
            identity,
            "alias_conflict",
          );
        }
        if (inputSnapshot.id !== existing.record.id) {
          existing.record.mergedSourceIds = [
            ...new Set([
              ...existing.record.mergedSourceIds,
              inputSnapshot.id,
            ]),
          ].sort();
        }
        aliasIndex.set(inputSnapshot.id, existing.record.id);
        for (const key of identity.keys) {
          identityIndex.set(key, existing.record.id);
        }
        log("add", "deduplicated", null);
        return frozenClone({
          status: "deduplicated",
          code: null,
          canonicalSourceId: existing.record.id,
          safeMetadata: safeMetadata(
            inputSnapshot,
            rights,
            identity,
            rights.mayDisplay === "allowed"
              ? "available"
              : rights.mayDisplay === "denied"
                ? "display_permission_denied"
                : "display_permission_unknown",
            existing.record.id,
          ),
        });
      }

      sources.set(inputSnapshot.id, built.source);
      aliasIndex.set(inputSnapshot.id, inputSnapshot.id);
      for (const key of identity.keys) {
        identityIndex.set(key, inputSnapshot.id);
      }
      log("add", "stored", null);
      return frozenClone({
        status: "stored",
        code: null,
        canonicalSourceId: inputSnapshot.id,
        safeMetadata: safeMetadata(
          inputSnapshot,
          rights,
          identity,
          inputSnapshot.contentScope === "metadata_only"
            ? "metadata_only"
            : rights.mayDisplay === "allowed"
              ? "available"
              : rights.mayDisplay === "denied"
                ? "display_permission_denied"
                : "display_permission_unknown",
          inputSnapshot.id,
        ),
      });
    });
  }

  function findSource(sourceId: string): StoredSource | null {
    const canonicalId = aliasIndex.get(sourceId) ?? sourceId;
    return sources.get(canonicalId) ?? null;
  }

  function removeStoredSource(source: StoredSource) {
    sources.delete(source.record.id);
    for (const [key, sourceId] of identityIndex) {
      if (sourceId === source.record.id) {
        identityIndex.delete(key);
      }
    }
    for (const [alias, sourceId] of aliasIndex) {
      if (sourceId === source.record.id) {
        aliasIndex.delete(alias);
      }
    }
  }

  async function editSource(
    sourceId: string,
    changes: Partial<{
      title: string;
      authors: readonly string[];
      year: number | null;
      venue: string | null;
      studyType: string | null;
      warnings: readonly string[];
    }>,
  ) {
    if (!isPassivePlainData(changes)) {
      return enqueue(() => {
        ensureMutable("edit", sourceId);
        throw new PacketMutationError(
          "invalid_edit",
          "edit",
          "source edit is invalid",
        );
      });
    }
    const changesSnapshot = structuredClone(changes);
    return enqueue(() => {
      ensureMutable("edit", sourceId);
      if (
        !isCanonicalIdentifier(sourceId) ||
        !hasCanonicalStructuredStrings(changesSnapshot)
      ) {
        throw new PacketMutationError(
          "invalid_edit",
          "edit",
          "source edit is invalid",
        );
      }
      const source = findSource(sourceId);
      if (source === null) {
        throw new PacketMutationError(
          "source_not_found",
          "edit",
          "source was not found",
        );
      }
      try {
        source.record = SourceRecordSchema.parse({
          ...source.record,
          bibliographicMetadata: {
            ...source.record.bibliographicMetadata,
            ...(changesSnapshot.title === undefined
              ? {}
              : { title: changesSnapshot.title }),
            ...(changesSnapshot.authors === undefined
              ? {}
              : { authors: [...changesSnapshot.authors] }),
            ...(changesSnapshot.year === undefined
              ? {}
              : { year: changesSnapshot.year }),
            ...(changesSnapshot.venue === undefined
              ? {}
              : { venue: changesSnapshot.venue }),
            ...(changesSnapshot.studyType === undefined
              ? {}
              : { studyType: changesSnapshot.studyType }),
          },
          ...(changesSnapshot.warnings === undefined
            ? {}
            : { warnings: [...changesSnapshot.warnings] }),
        });
        source.aliasMaterialHash = aliasMaterial(source.record);
      } catch {
        throw new PacketMutationError(
          "invalid_edit",
          "edit",
          "source edit is invalid",
        );
      }
      return frozenClone({ status: "edited" as const, sourceId: source.record.id });
    });
  }

  async function deleteSource(sourceId: string) {
    return enqueue(() => {
      ensureMutable("delete", sourceId);
      if (!isCanonicalIdentifier(sourceId)) {
        throw new PacketMutationError(
          "source_not_found",
          "delete",
          "source was not found",
        );
      }
      const source = findSource(sourceId);
      if (source === null) {
        throw new PacketMutationError(
          "source_not_found",
          "delete",
          "source was not found",
        );
      }
      removeStoredSource(source);
      return frozenClone({ status: "deleted" as const, sourceId: source.record.id });
    });
  }

  async function changePermissions(
    sourceId: string,
    input: SourceRightsInput,
  ) {
    if (!isPassivePlainData(input)) {
      return enqueue(() => {
        ensureMutable("change_permissions", sourceId);
        throw new PacketMutationError(
          "invalid_permissions",
          "change_permissions",
          "permission change is invalid",
        );
      });
    }
    const inputSnapshot = structuredClone(input);
    return enqueue(() => {
      ensureMutable("change_permissions", sourceId);
      if (
        !isCanonicalIdentifier(sourceId) ||
        !hasCanonicalStructuredStrings(inputSnapshot)
      ) {
        throw new PacketMutationError(
          "invalid_permissions",
          "change_permissions",
          "permission change is invalid",
        );
      }
      const source = findSource(sourceId);
      if (source === null) {
        throw new PacketMutationError(
          "source_not_found",
          "change_permissions",
          "source was not found",
        );
      }
      const rights = normalizeRights(inputSnapshot);
      if (rights.basis === null || rights.checkedAt === null) {
        throw new PacketMutationError(
          "invalid_permissions",
          "change_permissions",
          "permission change requires an explicit basis and timestamp",
        );
      }
      if (rights.mayStore !== "allowed") {
        removeStoredSource(source);
        return frozenClone({
          status: "removed" as const,
          sourceId: source.record.id,
          reason:
            rights.mayStore === "denied"
              ? "storage_permission_denied"
              : "storage_permission_unknown",
        });
      }
      source.record.rights = {
        mayStore: rights.mayStore,
        mayDisplay: rights.mayDisplay,
        maySendToModel: rights.maySendToModel,
        basis: rights.basis,
        checkedAt: rights.checkedAt,
      };
      for (const chunk of source.chunks) {
        chunk.displayPermission = rights.mayDisplay;
      }
      source.aliasMaterialHash = aliasMaterial(source.record);
      return frozenClone({
        status: "changed" as const,
        sourceId: source.record.id,
      });
    });
  }

  function reviewSnapshot(): PacketReviewSnapshot {
    const packetFingerprint = frozen?.packet.fingerprint ?? null;
    return {
      state: frozen === null ? "draft" : "frozen",
      packetFingerprint,
      sources: [...sources.values()].sort(compareSourceId).map((source) => {
        const rights = source.record.rights;
        const content: ReviewSource["content"] =
          source.record.access.contentScope === "metadata_only"
            ? {
                status: "metadata_only",
                reason: "metadata_only",
                chunks: [],
              }
            : rights.mayDisplay === "allowed"
              ? {
                  status: "available",
                  reason: "available",
                  chunks: source.chunks.map((chunk) => ({
                    id: chunk.id,
                    sourceId: chunk.sourceId,
                    text: chunk.text,
                    location: chunk.location,
                    contentHash: chunk.contentHash,
                  })),
                }
              : {
                  status: "blocked",
                  reason:
                    rights.mayDisplay === "denied"
                      ? "display_permission_denied"
                      : "display_permission_unknown",
                  chunks: [],
                };
        return {
          id: source.record.id,
          canonicalDoi: source.record.canonicalDoi,
          canonicalUrl: redactCanonicalUrl(source.record.canonicalUrl),
          title: source.record.bibliographicMetadata.title,
          authors: [...source.record.bibliographicMetadata.authors],
          year: source.record.bibliographicMetadata.year,
          venue: source.record.bibliographicMetadata.venue,
          studyType: source.record.bibliographicMetadata.studyType,
          contentScope: source.record.access.contentScope,
          rights: {
            mayStore: rights.mayStore,
            mayDisplay: rights.mayDisplay,
            maySendToModel: rights.maySendToModel,
          },
          permissionBasis: rights.basis,
          mergedSourceIds: [...source.record.mergedSourceIds],
          warnings: [...source.record.warnings],
          content,
        };
      }),
    };
  }

  function modelPayload(): PacketModelPayload {
    const packetFingerprint = frozen?.packet.fingerprint ?? null;
    return {
      state: frozen === null ? "draft" : "frozen",
      packetFingerprint,
      chunks: [...sources.values()]
        .sort(compareSourceId)
        .filter(
          (source) => source.record.rights.maySendToModel === "allowed",
        )
        .flatMap((source) =>
          source.chunks.map((chunk) => ({
            id: chunk.id,
            sourceId: chunk.sourceId,
            text: chunk.text,
            location: chunk.location,
            contentHash: chunk.contentHash,
          })),
        ),
    };
  }

  async function getReviewSnapshot() {
    return enqueue(() => frozenClone(reviewSnapshot()));
  }

  async function getModelPayload() {
    return enqueue(() => frozenClone(modelPayload()));
  }

  async function getAuditLog() {
    return enqueue(() => frozenClone(audit));
  }

  async function freeze(input: {
    packetVersion?: number;
    frozenAt: string;
    freezeDecision: z.input<
      typeof import("../../contracts").HumanDecisionSchema
    >;
  }): Promise<FrozenSourcePacket> {
    if (!isPassivePlainData(input)) {
      return enqueue(() => {
        const code = frozen === null ? "invalid_input" : "freeze_conflict";
        appendRejectedAudit("freeze", code, null);
        throw new PacketMutationError(
          code,
          "freeze",
          frozen === null
            ? "packet freeze input is invalid"
            : "a malformed retry cannot replace the frozen packet",
        );
      });
    }
    const inputSnapshot = structuredClone(input);
    return enqueue(() => {
      if (frozen !== null) {
        if (!hasCanonicalStructuredStrings(inputSnapshot)) {
          appendRejectedAudit("freeze", "freeze_conflict", null);
          throw new PacketMutationError(
            "freeze_conflict",
            "freeze",
            "a malformed retry cannot replace the frozen packet",
          );
        }
        const retryHash = canonicalSha256({
          packetVersion: inputSnapshot.packetVersion ?? 1,
          frozenAt: inputSnapshot.frozenAt,
          freezeDecision: inputSnapshot.freezeDecision,
        });
        if (frozen.requestHash === retryHash) {
          return frozenSourcePacketResult(frozen);
        }
        appendRejectedAudit("freeze", "freeze_conflict", null);
        throw new PacketMutationError(
          "freeze_conflict",
          "freeze",
          "a different freeze decision cannot replace the frozen packet",
        );
      }
      if (!hasCanonicalStructuredStrings(inputSnapshot)) {
        appendRejectedAudit("freeze", "invalid_input", null);
        throw new PacketMutationError(
          "invalid_input",
          "freeze",
          "packet freeze input is invalid",
        );
      }
      const requestHash = canonicalSha256({
        packetVersion: inputSnapshot.packetVersion ?? 1,
        frozenAt: inputSnapshot.frozenAt,
        freezeDecision: inputSnapshot.freezeDecision,
      });
      if (sources.size === 0) {
        throw new PacketMutationError(
          "empty_packet",
          "freeze",
          "at least one stored source is required",
        );
      }
      const orderedSources = [...sources.values()].sort(compareSourceId);
      const sourceRecords = orderedSources.map((source) =>
        structuredClone(source.record),
      );
      const chunks = orderedSources.flatMap((source) =>
        source.chunks.map((chunk) => structuredClone(chunk)),
      );
      const packet = freezePacket({
        packetVersion: inputSnapshot.packetVersion,
        sourceHashes: [
          ...new Set(sourceRecords.map(({ contentHash }) => contentHash)),
        ],
        chunkHashes: [
          ...new Set(chunks.map(({ contentHash }) => contentHash)),
        ],
        frozenAt: inputSnapshot.frozenAt,
        freezeDecision: inputSnapshot.freezeDecision,
      });
      const envelope = {
        packet,
        sources: sourceRecords,
        chunks,
      };
      const envelopeText = canonicalizeJson(envelope);
      const envelopeHash = sha256Utf8(envelopeText);
      const review = {
        ...reviewSnapshot(),
        state: "frozen" as const,
        packetFingerprint: packet.fingerprint,
      };
      const model = {
        ...modelPayload(),
        state: "frozen" as const,
        packetFingerprint: packet.fingerprint,
      };
      const result: FrozenSourcePacketData = {
        packet,
        frozenEnvelopeHash: envelopeHash,
        frozenByteLength: new TextEncoder().encode(envelopeText).byteLength,
        sourceCount: sourceRecords.length,
        chunkCount: chunks.length,
        review,
        modelPayload: model,
      };
      const frozenEnvelope = frozenClone(envelope);
      const evidenceCapability = issueTrustedSourcePacketCapability({
        packet: frozenEnvelope.packet,
        frozenEnvelopeHash: envelopeHash,
        sources: frozenEnvelope.sources,
        chunks: frozenEnvelope.chunks,
      });
      frozen = {
        requestHash,
        packet: frozenClone(packet),
        envelope: frozenEnvelope,
        envelopeHash,
        byteLength: result.frozenByteLength,
        result: frozenClone(result),
        evidenceCapability,
      };
      log("freeze", "frozen", null);
      return frozenSourcePacketResult(frozen);
    });
  }

  async function verifyFrozenEnvelope(expectedHash: string) {
    return enqueue(() => {
      if (
        frozen === null ||
        !/^[a-f0-9]{64}$/u.test(expectedHash) ||
        expectedHash !== frozen.envelopeHash ||
        canonicalSha256(frozen.envelope) !== frozen.envelopeHash
      ) {
        return frozenClone({ status: "tampered" as const });
      }
      return frozenClone({ status: "verified" as const });
    });
  }

  return {
    addSource,
    editSource,
    deleteSource,
    changePermissions,
    getReviewSnapshot,
    getModelPayload,
    getAuditLog,
    freeze,
    verifyFrozenEnvelope,
  };
}
