import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  canonicalSha256,
  CurrentResearchRunSchema,
  type ResearchRun,
} from "../../contracts";

export const PACKET_REVIEW_SCENARIOS = [
  "frozen",
  "review",
  "loading",
  "empty",
  "denied",
  "error",
  "rejected",
  "duplicate",
  "long-content",
  "missing-packet",
  "tampered-packet",
  "stale-session",
] as const;

export type PacketReviewScenario = (typeof PACKET_REVIEW_SCENARIOS)[number];

type PermissionState = ResearchRun["sources"][number]["rights"]["mayStore"];

type PacketBlocker = {
  code: string;
  severity: "blocking" | "warning";
  message: string;
};

export type PacketBoundaryError = {
  name: "PacketBoundaryError";
  code: string;
  path: string;
  message: string;
};

type SourceDisplay =
  | {
      state: "available";
      chunks: Array<{
        id: string;
        text: string;
        location: string;
        contentHash: string;
      }>;
    }
  | { state: "hidden"; reason: string };

type ModelAccess =
  | { state: "included"; reason: string }
  | { state: "excluded"; reason: string };

export type PacketReviewSource = {
  id: string;
  title: string;
  canonicalDoi: string | null;
  canonicalUrl: string | null;
  doiSyntax: string;
  doiResolution: string;
  registrationAgency: string | null;
  origin: string;
  contentScope: string;
  provider: string;
  version: string | null;
  location: string;
  retrievedAt: string;
  rights: {
    mayStore: PermissionState;
    mayDisplay: PermissionState;
    maySendToModel: PermissionState;
  };
  permissionBasis: string;
  contentHash: string;
  mergedSourceIds: string[];
  warnings: string[];
  display: SourceDisplay;
  modelAccess: ModelAccess;
};

export type PacketReviewModel = {
  scenario: PacketReviewScenario;
  state:
    | "frozen"
    | "awaiting_decision"
    | "loading"
    | "empty"
    | "error"
    | "rejected";
  stateLabel: string;
  stateDescription: string;
  evidenceMode: ResearchRun["evidenceMode"];
  packet: {
    version: number;
    fingerprint: string;
    frozenAt: string;
    sourceHashCount: number;
    chunkHashCount: number;
  } | null;
  sources: PacketReviewSource[];
  blockers: PacketBlocker[];
  mutationError: {
    name: "PacketMutationError";
    code: "packet_frozen";
    operation: "update_source";
    message: string;
  } | null;
  boundaryError: PacketBoundaryError | null;
  decisionSessionId: string | null;
  decisionSessionError: PacketDecisionError | null;
  canAccept: boolean;
  canReject: boolean;
};

type PreparedPacketReview = {
  run: ResearchRun | null;
  model: PacketReviewModel;
};

type Decision = "accept" | "reject";

export type PacketDecisionError = {
  name: "PacketDecisionError";
  code: string;
  message: string;
};

export type PacketDecisionResult =
  | {
      ok: true;
      decision: Decision;
      packetFingerprint: string;
    }
  | { ok: false; error: PacketDecisionError };

class BoundaryFailure extends Error {
  readonly detail: PacketBoundaryError;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "PacketBoundaryError";
    this.detail = { name: "PacketBoundaryError", code, path, message };
  }
}

const stateCopy: Record<
  Exclude<
    PacketReviewScenario,
    "missing-packet" | "tampered-packet"
  >,
  Pick<PacketReviewModel, "state" | "stateLabel" | "stateDescription">
> = {
  frozen: {
    state: "frozen",
    stateLabel: "Frozen packet",
    stateDescription:
      "The fixture packet has a recorded human approval and immutable fingerprint.",
  },
  review: {
    state: "awaiting_decision",
    stateLabel: "Awaiting packet decision",
    stateDescription:
      "Evidence extraction stays blocked until a human accepts or rejects this bounded packet.",
  },
  loading: {
    state: "loading",
    stateLabel: "Loading packet review",
    stateDescription: "The fixture packet projection is being prepared for review.",
  },
  empty: {
    state: "empty",
    stateLabel: "No approved sources in this packet",
    stateDescription:
      "Nothing can be frozen or sent to evidence extraction until an approved source is added.",
  },
  denied: {
    state: "awaiting_decision",
    stateLabel: "Rights decision required",
    stateDescription:
      "At least one source has separate display and model-use restrictions that must remain explicit.",
  },
  error: {
    state: "error",
    stateLabel: "Post-freeze mutation rejected",
    stateDescription:
      "The attempted source update failed closed and the original frozen fingerprint remains unchanged.",
  },
  rejected: {
    state: "rejected",
    stateLabel: "Packet rejected",
    stateDescription:
      "A human rejected this fixture packet preview. Evidence extraction remains blocked.",
  },
  duplicate: {
    state: "awaiting_decision",
    stateLabel: "Duplicate alias merged",
    stateDescription:
      "An exact normalized alias was merged into its canonical source and remains visible for review.",
  },
  "long-content": {
    state: "awaiting_decision",
    stateLabel: "Long fixture content boundary",
    stateDescription:
      "Long titles, warnings, permission bases, and locations must wrap without hiding the decision controls.",
  },
  "stale-session": {
    state: "awaiting_decision",
    stateLabel: "Stale decision session preview",
    stateDescription:
      "This fixture preview proves an expired decision capability fails closed.",
  },
};

const modelCapabilities = new WeakMap<
  PacketReviewModel,
  {
    packetFingerprint: string;
    canAccept: boolean;
    canReject: boolean;
  }
>();

type DecisionSession = {
  packetFingerprint: string;
  canAccept: boolean;
  canReject: boolean;
  issuedAt: number;
  expiresAt: number;
  decision: Decision | null;
};

type DecisionCapability = Omit<DecisionSession, "decision"> & {
  version: 2;
  domain: "evidenceforge.packet-review.decision-capability";
  nonce: string;
};

const decisionCapabilityDomain =
  "evidenceforge.packet-review.decision-capability" as const;
const decisionTokenPrefix = "evidenceforge-packet-review";
const decisionTokenVersion = "v2";
const decisionHmacDomain = `${decisionCapabilityDomain}\0${decisionTokenVersion}\0`;
const decisionKeyEnvironmentName = "EVIDENCEFORGE_PACKET_DECISION_KEY_V2";

const sessionRegistryKey = Symbol.for(
  "evidenceforge.packet-review-decision-sessions.v2",
);
const maximumDecisionSessions = 256;

function sessionRegistry(): Map<string, DecisionSession> {
  const host = process as NodeJS.Process & {
    [sessionRegistryKey]?: Map<string, DecisionSession>;
  };
  host[sessionRegistryKey] ??= new Map<string, DecisionSession>();
  return host[sessionRegistryKey];
}

export function preparePacketReview(
  input: unknown,
  scenario: PacketReviewScenario = "frozen",
): PreparedPacketReview {
  try {
    let scenarioInput = input;
    if (scenario === "missing-packet" || scenario === "tampered-packet") {
      scenarioInput = passiveSnapshot(input);
      const record = scenarioInput as Record<string, unknown>;
      if (scenario === "missing-packet") {
        record.packet = null;
      } else {
        const chunks = record.chunks as Array<Record<string, unknown>>;
        if (chunks[0]) chunks[0].text = "tampered fixture passage";
      }
    }

    const run = validateCanonicalRun(scenarioInput);
    const model = buildValidatedModel(
      run,
      scenario === "missing-packet" || scenario === "tampered-packet"
        ? "frozen"
        : scenario,
    );
    return deepFreeze({ run, model });
  } catch (error) {
    const detail =
      error instanceof BoundaryFailure
        ? error.detail
        : {
            name: "PacketBoundaryError" as const,
            code: "boundary_failure",
            path: "$",
            message: "The packet could not be validated safely.",
          };
    return deepFreeze({
      run: null,
      model: boundaryErrorModel(scenario, detail),
    });
  }
}

export function buildPacketReviewModel(
  input: unknown,
  scenario: PacketReviewScenario = "frozen",
): PacketReviewModel {
  return preparePacketReview(input, scenario).model;
}

function buildValidatedModel(
  run: ResearchRun,
  scenario: Exclude<PacketReviewScenario, "missing-packet" | "tampered-packet">,
): PacketReviewModel {
  let sources = run.sources.map((source): PacketReviewSource => {
    const sourceChunks = run.chunks.filter(
      (chunk) => chunk.sourceId === source.id,
    );
    const display = sourceDisplay(source, sourceChunks);
    const modelAccess: ModelAccess =
      source.rights.maySendToModel === "allowed"
        ? {
            state: "included",
            reason: "Model-use permission is allowed for the frozen source chunks.",
          }
        : {
            state: "excluded",
            reason: `Model-use permission is ${source.rights.maySendToModel}; no source text enters the model projection.`,
          };

    return {
      id: source.id,
      title: source.bibliographicMetadata.title,
      canonicalDoi: source.canonicalDoi,
      canonicalUrl: safeCanonicalUrl(source.canonicalUrl),
      doiSyntax: source.doiResolution.syntax,
      doiResolution: source.doiResolution.resolution,
      registrationAgency: source.doiResolution.registrationAgency,
      origin: source.access.origin,
      contentScope: source.access.contentScope,
      provider: source.access.provider,
      version: source.access.version,
      location: source.access.location,
      retrievedAt: source.access.retrievedAt,
      rights: {
        mayStore: source.rights.mayStore,
        mayDisplay: source.rights.mayDisplay,
        maySendToModel: source.rights.maySendToModel,
      },
      permissionBasis: source.rights.basis,
      contentHash: source.contentHash,
      mergedSourceIds: [...source.mergedSourceIds],
      warnings: [...source.warnings],
      display,
      modelAccess,
    };
  });

  if (scenario === "loading" || scenario === "empty") {
    sources = [];
  } else if (scenario === "denied" && sources[0]) {
    sources[0] = {
      ...sources[0],
      rights: {
        ...sources[0].rights,
        mayDisplay: "denied",
        maySendToModel: "denied",
      },
      display: {
        state: "hidden",
        reason: "Display permission is denied; source text is not rendered.",
      },
      modelAccess: {
        state: "excluded",
        reason:
          "Model-use permission is denied; no source text enters the model projection.",
      },
    };
  } else if (scenario === "duplicate" && sources[0]) {
    sources[0] = {
      ...sources[0],
      mergedSourceIds: [
        ...sources[0].mergedSourceIds,
        "fixture-duplicate-alias",
      ],
    };
  } else if (scenario === "long-content" && sources[0]) {
    sources[0] = {
      ...sources[0],
      title: `${sources[0].title} — long fixture title used to verify wrapping across narrow and zoomed layouts without truncating audit information`,
      location: `${sources[0].location} · a deliberately expanded location descriptor that remains exact, readable, and available to keyboard and zoom users`,
      warnings: [
        "Long fixture content boundary",
        ...sources[0].warnings,
        "This deliberately expanded warning checks that important rights and provenance text wraps instead of clipping or creating horizontal overflow.",
      ],
    };
  }

  const blockers = buildBlockers(sources, scenario);
  const copy = stateCopy[scenario];
  const packet =
    scenario !== "frozen" && scenario !== "error"
      ? null
      : {
          version: run.packet!.packetVersion,
          fingerprint: run.packet!.fingerprint,
          frozenAt: run.packet!.frozenAt,
          sourceHashCount: run.packet!.sourceHashes.length,
          chunkHashCount: run.packet!.chunkHashes.length,
        };

  const model = deepFreeze({
    scenario,
    ...copy,
    evidenceMode: run.evidenceMode,
    packet,
    sources,
    blockers,
    mutationError:
      scenario === "error"
        ? {
            name: "PacketMutationError" as const,
            code: "packet_frozen" as const,
            operation: "update_source" as const,
            message:
              "The source packet is frozen; the attempted update was rejected and preserved as failure evidence.",
          }
        : null,
    boundaryError: null,
    decisionSessionId: null,
    decisionSessionError: null,
    canAccept:
      (scenario === "review" || scenario === "stale-session") &&
      blockers.every(({ severity }) => severity !== "blocking"),
    canReject:
      scenario === "review" ||
      scenario === "denied" ||
      scenario === "duplicate" ||
      scenario === "long-content" ||
      scenario === "stale-session",
  } satisfies PacketReviewModel);

  modelCapabilities.set(model, {
    packetFingerprint: run.packet!.fingerprint,
    canAccept: model.canAccept,
    canReject: model.canReject,
  });
  return model;
}

function boundaryErrorModel(
  scenario: PacketReviewScenario,
  detail: PacketBoundaryError,
): PacketReviewModel {
  return deepFreeze({
    scenario,
    state: "error",
    stateLabel: "Packet validation failed",
    stateDescription:
      "No packet content, model projection, or decision action is available because validation failed closed.",
    evidenceMode: "unverified",
    packet: null,
    sources: [],
    blockers: [
      {
        code: detail.code,
        severity: "blocking",
        message: detail.message,
      },
    ],
    mutationError: null,
    boundaryError: detail,
    decisionSessionId: null,
    decisionSessionError: null,
    canAccept: false,
    canReject: false,
  });
}

export function createPacketReviewDecisionSession(
  model: PacketReviewModel,
  options: { now?: number; ttlMs?: number } = {},
):
  | { ok: true; sessionId: string }
  | { ok: false; error: PacketDecisionError } {
  const capability = modelCapabilities.get(model);
  if (!capability || (!capability.canAccept && !capability.canReject)) {
    return decisionFailure(
      "invalid_packet_capability",
      "A validated private packet capability is required.",
    );
  }
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return decisionFailure(
      "invalid_session_options",
      "The decision-session lifetime is invalid.",
    );
  }
  const expiresAt = now + ttlMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return decisionFailure(
      "invalid_session_options",
      "The decision-session lifetime is invalid.",
    );
  }

  const registry = sessionRegistry();
  for (const [id, session] of registry) {
    if (session.expiresAt <= now) registry.delete(id);
  }
  if (registry.size >= maximumDecisionSessions) {
    return decisionFailure(
      "session_capacity_reached",
      "The process-local decision-session capacity is full; retry after an existing session expires.",
    );
  }

  const tokenCapability: DecisionCapability = {
    version: 2,
    domain: decisionCapabilityDomain,
    nonce: randomUUID(),
    ...capability,
    issuedAt: now,
    expiresAt,
  };
  const sessionId = signDecisionCapability(tokenCapability);
  registry.set(sessionId, {
    packetFingerprint: tokenCapability.packetFingerprint,
    canAccept: tokenCapability.canAccept,
    canReject: tokenCapability.canReject,
    issuedAt: tokenCapability.issuedAt,
    expiresAt: tokenCapability.expiresAt,
    decision: null,
  });
  return { ok: true, sessionId };
}

export function bindPacketReviewDecisionSession(
  model: PacketReviewModel,
  options: { now?: number; ttlMs?: number } = {},
): PacketReviewModel {
  const session = createPacketReviewDecisionSession(model, options);
  if (!session.ok) {
    if (session.error.code !== "session_capacity_reached") return model;
    return deepFreeze({
      ...model,
      decisionSessionError: session.error,
      canAccept: false,
      canReject: false,
    });
  }
  return deepFreeze({
    ...model,
    decisionSessionId: session.sessionId,
    decisionSessionError: null,
  });
}

export function decidePacketReviewSession(
  sessionId: string,
  decision: Decision,
  options: { now?: number } = {},
): PacketDecisionResult {
  if (decision !== "accept" && decision !== "reject") {
    return decisionFailure(
      "invalid_decision",
      "The packet decision is invalid.",
    );
  }
  const registry = sessionRegistry();
  const capability = verifyDecisionCapability(sessionId);
  if (!capability) {
    return decisionFailure("invalid_session", "The decision session is invalid.");
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    return decisionFailure("invalid_session_time", "The decision time is invalid.");
  }
  if (now < capability.issuedAt) {
    return decisionFailure(
      "session_clock_rollback",
      "The decision time precedes issuance; the session remains unused.",
    );
  }
  if (now >= capability.expiresAt) {
    registry.delete(sessionId);
    return decisionFailure(
      "session_stale",
      "The decision session expired; reload the validated packet.",
    );
  }
  const session = registry.get(sessionId);
  if (!session) {
    return decisionFailure("invalid_session", "The decision session is invalid.");
  }
  if (
    session.packetFingerprint !== capability.packetFingerprint ||
    session.canAccept !== capability.canAccept ||
    session.canReject !== capability.canReject ||
    session.issuedAt !== capability.issuedAt ||
    session.expiresAt !== capability.expiresAt
  ) {
    registry.delete(sessionId);
    return decisionFailure(
      "invalid_session",
      "The decision session is invalid.",
    );
  }
  if (session.decision !== null) {
    return decisionFailure(
      "decision_already_recorded",
      "This packet decision session has already been used.",
    );
  }
  if (
    (decision === "accept" && !session.canAccept) ||
    (decision === "reject" && !session.canReject)
  ) {
    return decisionFailure(
      "decision_not_allowed",
      "That decision is not allowed for this validated packet state.",
    );
  }
  session.decision = decision;
  return {
    ok: true,
    decision,
    packetFingerprint: session.packetFingerprint,
  };
}

function decisionKey() {
  const existing = process.env[decisionKeyEnvironmentName];
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  process.env[decisionKeyEnvironmentName] = generated;
  return generated;
}

function signDecisionCapability(capability: DecisionCapability) {
  const payload = Buffer.from(JSON.stringify(capability), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", decisionKey())
    .update(`${decisionHmacDomain}${payload}`, "utf8")
    .digest("base64url");
  return `${decisionTokenPrefix}.${decisionTokenVersion}.${payload}.${signature}`;
}

function verifyDecisionCapability(value: string): DecisionCapability | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [prefix, tokenVersion, payload, signature] = parts;
  if (
    prefix !== decisionTokenPrefix ||
    tokenVersion !== decisionTokenVersion ||
    !payload ||
    !signature
  ) {
    return null;
  }
  let payloadBytes: Buffer;
  let provided: Buffer;
  try {
    payloadBytes = Buffer.from(payload, "base64url");
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    payloadBytes.toString("base64url") !== payload ||
    provided.toString("base64url") !== signature
  ) {
    return null;
  }
  const expected = createHmac("sha256", decisionKey())
    .update(`${decisionHmacDomain}${payload}`, "utf8")
    .digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const expectedKeys = [
      "version",
      "domain",
      "nonce",
      "packetFingerprint",
      "canAccept",
      "canReject",
      "issuedAt",
      "expiresAt",
    ];
    const actualKeys = Object.keys(record);
    if (
      actualKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(record, key))
    ) {
      return null;
    }
    if (
      record.version !== 2 ||
      record.domain !== decisionCapabilityDomain ||
      typeof record.nonce !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        record.nonce,
      ) ||
      typeof record.packetFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.packetFingerprint) ||
      typeof record.canAccept !== "boolean" ||
      typeof record.canReject !== "boolean" ||
      (!record.canAccept && !record.canReject) ||
      typeof record.issuedAt !== "number" ||
      !Number.isFinite(record.issuedAt) ||
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= record.issuedAt
    ) {
      return null;
    }
    return record as DecisionCapability;
  } catch {
    return null;
  }
}

function decisionFailure(code: string, message: string) {
  return {
    ok: false as const,
    error: { name: "PacketDecisionError" as const, code, message },
  };
}

function validateCanonicalRun(input: unknown): ResearchRun {
  const snapshot = passiveSnapshot(input);
  const parsed = CurrentResearchRunSchema.safeParse(snapshot);
  if (!parsed.success) {
    const fingerprintIssue = parsed.error.issues.find(
      (issue) =>
        issue.path[0] === "packet" && issue.path[1] === "fingerprint",
    );
    if (fingerprintIssue) {
      throw new BoundaryFailure(
        "packet_fingerprint_mismatch",
        "$.packet.fingerprint",
        "The packet fingerprint does not match its canonical freeze payload.",
      );
    }
    const first = parsed.error.issues[0];
    throw new BoundaryFailure(
      "contract_invalid",
      first ? `$.${first.path.join(".")}` : "$",
      "The packet graph does not satisfy the accepted current contract.",
    );
  }

  const run = parsed.data;
  if (run.packet === null) {
    throw new BoundaryFailure(
      "packet_missing",
      "$.packet",
      "A frozen packet is required before review or decision.",
    );
  }
  if (
    run.sources.length === 0 ||
    run.chunks.length === 0 ||
    run.packet.sourceHashes.length === 0 ||
    run.packet.chunkHashes.length === 0
  ) {
    throw new BoundaryFailure(
      "packet_empty",
      "$.packet",
      "The canonical packet must contain at least one source and one chunk.",
    );
  }

  validateGraph(run);
  validateHashes(run);
  return deepFreeze(run);
}

function validateGraph(run: ResearchRun) {
  const sourceIds = uniqueIds(
    run.sources.map(({ id }) => id),
    "duplicate_source_id",
    "$.sources",
  );
  const chunkIds = uniqueIds(
    run.chunks.map(({ id }) => id),
    "duplicate_chunk_id",
    "$.chunks",
  );
  const claimIds = uniqueIds(
    run.claims.map(({ id }) => id),
    "duplicate_claim_id",
    "$.claims",
  );
  const evidenceIds = uniqueIds(
    run.evidenceCards.map(({ id }) => id),
    "duplicate_evidence_id",
    "$.evidenceCards",
  );
  const gapIds = uniqueIds(
    run.researchGaps.map(({ id }) => id),
    "duplicate_gap_id",
    "$.researchGaps",
  );
  const executionIds = uniqueIds(
    run.executions.map(({ id }) => id),
    "duplicate_execution_id",
    "$.executions",
  );
  const errorIds = uniqueIds(
    run.errors.map(({ id }) => id),
    "duplicate_error_id",
    "$.errors",
  );
  const objections = run.review?.objections ?? [];
  const objectionIds = uniqueIds(
    objections.map(({ id }) => id),
    "duplicate_objection_id",
    "$.review.objections",
  );
  const decisionIds = [
    run.scopeDecision?.id,
    run.packet?.freezeDecision.id,
    run.objectionDispositionDecision?.id,
    run.finalDecision?.id,
  ].filter((id): id is string => id !== undefined && id !== null);
  const knownObjectIds = [
    run.id,
    ...sourceIds,
    ...chunkIds,
    ...claimIds,
    ...evidenceIds,
    ...gapIds,
    ...executionIds,
    ...errorIds,
    ...objectionIds,
    ...decisionIds,
    ...(run.experimentAbstention ? [run.experimentAbstention.id] : []),
  ];
  const knownIds = uniqueIds(
    knownObjectIds,
    "duplicate_object_id",
    "$",
  );

  run.claims.forEach((claim, index) => {
    if (claim.parentClaimId !== null && !claimIds.has(claim.parentClaimId)) {
      crossLinkFailure("claim_parent_missing", `$.claims.${index}.parentClaimId`);
    }
  });
  run.chunks.forEach((chunk, index) => {
    if (!sourceIds.has(chunk.sourceId)) {
      crossLinkFailure("chunk_source_missing", `$.chunks.${index}.sourceId`);
    }
  });
  run.evidenceCards.forEach((card, index) => {
    if (!chunkIds.has(card.sourceChunkId)) {
      crossLinkFailure(
        "evidence_chunk_missing",
        `$.evidenceCards.${index}.sourceChunkId`,
      );
    }
    if (!claimIds.has(card.subclaimId)) {
      crossLinkFailure(
        "evidence_claim_missing",
        `$.evidenceCards.${index}.subclaimId`,
      );
    }
    if (!executionIds.has(card.modelAssessment.executionId)) {
      crossLinkFailure(
        "evidence_execution_missing",
        `$.evidenceCards.${index}.modelAssessment.executionId`,
      );
    }
  });
  run.conclusions.forEach((conclusion, index) => {
    if (!claimIds.has(conclusion.subclaimId)) {
      crossLinkFailure(
        "conclusion_claim_missing",
        `$.conclusions.${index}.subclaimId`,
      );
    }
    validateRefs(
      [
        ...conclusion.supportingEvidenceCardIds,
        ...conclusion.contradictingEvidenceCardIds,
      ],
      evidenceIds,
      "conclusion_evidence_missing",
      `$.conclusions.${index}`,
    );
  });
  run.researchGaps.forEach((gap, index) => {
    validateRefs(
      gap.affectedSubclaimIds,
      claimIds,
      "gap_claim_missing",
      `$.researchGaps.${index}.affectedSubclaimIds`,
    );
    validateRefs(
      gap.evidenceCardIds,
      evidenceIds,
      "gap_evidence_missing",
      `$.researchGaps.${index}.evidenceCardIds`,
    );
  });
  if (run.selectedGapId !== null && !gapIds.has(run.selectedGapId)) {
    crossLinkFailure("selected_gap_missing", "$.selectedGapId");
  }
  if (run.experiment !== null) {
    if (!gapIds.has(run.experiment.selectedGapId)) {
      crossLinkFailure("experiment_gap_missing", "$.experiment.selectedGapId");
    }
    validateRefs(
      run.experiment.supportingEvidenceCardIds,
      evidenceIds,
      "experiment_evidence_missing",
      "$.experiment.supportingEvidenceCardIds",
    );
  }
  if (run.review !== null) {
    if (!executionIds.has(run.review.reviewerExecutionId)) {
      crossLinkFailure(
        "review_execution_missing",
        "$.review.reviewerExecutionId",
      );
    }
    run.review.objections.forEach((objection, index) => {
      validateRefs(
        objection.evidenceCardIds,
        evidenceIds,
        "objection_evidence_missing",
        `$.review.objections.${index}.evidenceCardIds`,
      );
    });
  }
  if ((run.review === null) !== (run.revision === null)) {
    crossLinkFailure("review_revision_mismatch", "$.revision");
  }
  const revisionObjectionIds = run.revision?.decisions.map(
    ({ objectionId }) => objectionId,
  ) ?? [];
  uniqueIds(
    revisionObjectionIds,
    "duplicate_revision_objection",
    "$.revision.decisions",
  );
  run.revision?.decisions.forEach((decision, index) => {
    if (!objectionIds.has(decision.objectionId)) {
      crossLinkFailure(
        "revision_objection_missing",
        `$.revision.decisions.${index}.objectionId`,
      );
    }
  });
  if (run.review !== null && revisionObjectionIds.length > 0) {
    if (!sameStrings(uniqueSorted(revisionObjectionIds), uniqueSorted([...objectionIds]))) {
      crossLinkFailure("revision_objection_coverage", "$.revision.decisions");
    }
  }
  for (const [field, decision] of [
    ["objectionDispositionDecision", run.objectionDispositionDecision],
    ["finalDecision", run.finalDecision],
  ] as const) {
    if (decision !== null) {
      validateRefs(
        decision.unresolvedObjections,
        objectionIds,
        "decision_objection_missing",
        `$.${field}.unresolvedObjections`,
      );
    }
  }
  run.executions.forEach((execution, index) => {
    for (const [field, reference] of [
      ["retryOfExecutionId", execution.retryOfExecutionId],
      ["fallbackFromExecutionId", execution.fallbackFromExecutionId],
    ] as const) {
      if (reference !== null && !executionIds.has(reference)) {
        crossLinkFailure(
          field === "retryOfExecutionId"
            ? "execution_retry_missing"
            : "execution_fallback_missing",
          `$.executions.${index}.${field}`,
        );
      }
    }
    validateRefs(
      execution.errorIds,
      errorIds,
      "execution_error_missing",
      `$.executions.${index}.errorIds`,
    );
    validateRefs(
      [...execution.inputRefs, ...execution.outputRefs],
      knownIds,
      "execution_object_missing",
      `$.executions.${index}`,
    );
  });
  run.errors.forEach((error, index) => {
    if (error.executionId !== null && !executionIds.has(error.executionId)) {
      crossLinkFailure(
        "error_execution_missing",
        `$.errors.${index}.executionId`,
      );
    }
    if (
      error.executionId !== null &&
      !run.executions
        .find(({ id }) => id === error.executionId)!
        .errorIds.includes(error.id)
    ) {
      crossLinkFailure("error_execution_backlink_missing", `$.errors.${index}`);
    }
  });
}

function validateHashes(run: ResearchRun) {
  for (const [index, chunk] of run.chunks.entries()) {
    if (sha256Utf8(chunk.text) !== chunk.contentHash) {
      throw new BoundaryFailure(
        "chunk_content_hash_mismatch",
        `$.chunks.${index}.contentHash`,
        "A source chunk hash does not match its exact UTF-8 text.",
      );
    }
    const source = run.sources.find(({ id }) => id === chunk.sourceId)!;
    if (chunk.displayPermission !== source.rights.mayDisplay) {
      throw new BoundaryFailure(
        "chunk_display_rights_mismatch",
        `$.chunks.${index}.displayPermission`,
        "Chunk display permission disagrees with the validated source rights.",
      );
    }
  }

  run.evidenceCards.forEach((card, index) => {
    const chunk = run.chunks.find(({ id }) => id === card.sourceChunkId)!;
    if (!chunk.text.includes(card.excerpt)) {
      crossLinkFailure(
        "evidence_excerpt_mismatch",
        `$.evidenceCards.${index}.excerpt`,
      );
    }
  });

  for (const [index, source] of run.sources.entries()) {
    const sourceChunks = run.chunks.filter(
      (chunk) => chunk.sourceId === source.id,
    );
    if (source.access.contentScope !== "metadata_only" && sourceChunks.length === 0) {
      throw new BoundaryFailure(
        "source_chunk_missing",
        `$.sources.${index}`,
        "A content-bearing source has no canonical chunk.",
      );
    }
    const text = sourceChunks.map(({ text }) => text).join("");
    if (sha256Utf8(text) !== source.contentHash) {
      throw new BoundaryFailure(
        "source_content_hash_mismatch",
        `$.sources.${index}.contentHash`,
        "A source content hash does not match its ordered UTF-8 chunks.",
      );
    }
  }

  const sourceHashes = uniqueSorted(run.sources.map(({ contentHash }) => contentHash));
  const chunkHashes = uniqueSorted(run.chunks.map(({ contentHash }) => contentHash));
  if (!sameStrings(run.packet!.sourceHashes, sourceHashes)) {
    throw new BoundaryFailure(
      "packet_source_hashes_mismatch",
      "$.packet.sourceHashes",
      "Packet source-hash membership does not match the validated sources.",
    );
  }
  if (!sameStrings(run.packet!.chunkHashes, chunkHashes)) {
    throw new BoundaryFailure(
      "packet_chunk_hashes_mismatch",
      "$.packet.chunkHashes",
      "Packet chunk-hash membership does not match the validated chunks.",
    );
  }
  const packet = run.packet!;
  const expectedFingerprint = canonicalSha256({
    schemaVersion: packet.schemaVersion,
    packetVersion: packet.packetVersion,
    sourceHashes: packet.sourceHashes,
    chunkHashes: packet.chunkHashes,
    frozenAt: packet.frozenAt,
    freezeDecision: packet.freezeDecision,
  });
  if (packet.fingerprint !== expectedFingerprint) {
    throw new BoundaryFailure(
      "packet_fingerprint_mismatch",
      "$.packet.fingerprint",
      "The packet fingerprint does not match its canonical freeze payload.",
    );
  }
}

function uniqueIds(values: string[], code: string, path: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) {
    throw new BoundaryFailure(code, path, "The packet graph contains a duplicate identity.");
  }
  return set;
}

function validateRefs(
  values: string[],
  allowed: Set<string>,
  code: string,
  path: string,
) {
  if (values.some((value) => !allowed.has(value))) {
    crossLinkFailure(code, path);
  }
}

function crossLinkFailure(code: string, path: string): never {
  throw new BoundaryFailure(
    code,
    path,
    "The packet graph contains a missing or invalid cross-object reference.",
  );
}

function passiveSnapshot(input: unknown): unknown {
  return snapshotValue(input, "$", new WeakSet<object>());
}

function snapshotValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new BoundaryFailure("non_json_input", path, "Packet input must be finite JSON data.");
  }
  if (typeof value !== "object") {
    throw new BoundaryFailure("non_json_input", path, "Packet input must be passive JSON data.");
  }
  if (nodeTypes.isProxy(value)) {
    throw new BoundaryFailure("proxy_input", path, "Proxy-backed packet input is not accepted.");
  }
  if (seen.has(value)) {
    throw new BoundaryFailure("cyclic_input", path, "Cyclic packet input is not accepted.");
  }
  seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new BoundaryFailure("non_plain_input", path, "Packet arrays must use the standard array prototype.");
    }
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      throw new BoundaryFailure("accessor_input", `${path}.length`, "Accessor-backed packet data is not accepted.");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new BoundaryFailure("non_json_input", `${path}.length`, "Packet array length is invalid.");
    }
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        throw new BoundaryFailure("sparse_array", `${path}.${index}`, "Sparse packet arrays are not accepted.");
      }
      output.push(snapshotDescriptor(descriptor, `${path}.${index}`, seen));
    }
    const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) {
        throw new BoundaryFailure("non_json_input", path, "Packet arrays cannot carry extra properties.");
      }
    }
    seen.delete(value);
    return output;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new BoundaryFailure("non_plain_input", path, "Packet objects must be plain JSON objects.");
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new BoundaryFailure("symbol_input", path, "Symbol packet fields are not accepted.");
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new BoundaryFailure("unsafe_key", `${path}.${key}`, "Unsafe packet object keys are not accepted.");
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable) {
      throw new BoundaryFailure("non_json_input", `${path}.${key}`, "Non-enumerable packet fields are not accepted.");
    }
    Object.defineProperty(output, key, {
      value: snapshotDescriptor(descriptor, `${path}.${key}`, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return output;
}

function snapshotDescriptor(
  descriptor: PropertyDescriptor,
  path: string,
  seen: WeakSet<object>,
) {
  if (!("value" in descriptor) || descriptor.get || descriptor.set) {
    throw new BoundaryFailure(
      "accessor_input",
      path,
      "Accessor-backed packet data is not accepted.",
    );
  }
  return snapshotValue(descriptor.value, path, seen);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256Utf8(value: string) {
  assertPairedUnicode(value);
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPairedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new BoundaryFailure("invalid_unicode", "$", "Packet strings must contain paired Unicode scalars.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new BoundaryFailure("invalid_unicode", "$", "Packet strings must contain paired Unicode scalars.");
    }
  }
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceDisplay(
  source: ResearchRun["sources"][number],
  chunks: ResearchRun["chunks"],
): SourceDisplay {
  if (source.access.contentScope === "metadata_only") {
    return {
      state: "hidden",
      reason: "This source is metadata-only; no reproducible passage is rendered.",
    };
  }
  if (source.rights.mayDisplay !== "allowed") {
    return {
      state: "hidden",
      reason: `Display permission is ${source.rights.mayDisplay}; source text is not rendered.`,
    };
  }
  return {
    state: "available",
    chunks: chunks.map(({ id, text, location, contentHash }) => ({
      id,
      text,
      location,
      contentHash,
    })),
  };
}

function buildBlockers(
  sources: PacketReviewSource[],
  scenario: Exclude<PacketReviewScenario, "missing-packet" | "tampered-packet">,
): PacketBlocker[] {
  if (scenario === "loading") return [];
  if (sources.length === 0) {
    return [
      {
        code: "empty_packet",
        severity: "blocking",
        message: "No approved source records are available to freeze.",
      },
    ];
  }

  const blockers: PacketBlocker[] = [];
  for (const source of sources) {
    if (source.rights.mayStore !== "allowed") {
      blockers.push({
        code: "storage_rights_unresolved",
        severity: "blocking",
        message: `${source.id}: storage permission is ${source.rights.mayStore}.`,
      });
    }
    if (source.rights.mayDisplay !== "allowed") {
      blockers.push({
        code: "display_restricted",
        severity: "warning",
        message: `${source.id}: display permission is ${source.rights.mayDisplay}; content stays hidden.`,
      });
    }
    if (source.rights.maySendToModel !== "allowed") {
      blockers.push({
        code: "model_use_restricted",
        severity: "blocking",
        message: `${source.id}: model-use permission is ${source.rights.maySendToModel}; content stays outside model input.`,
      });
    }
    if (source.mergedSourceIds.length > 0) {
      blockers.push({
        code: "duplicate_alias_merged",
        severity: "warning",
        message: `${source.id}: ${source.mergedSourceIds.length} exact alias was merged and must be reviewed.`,
      });
    }
  }
  return blockers;
}

export function isPacketReviewScenario(
  value: string | undefined,
): value is PacketReviewScenario {
  return PACKET_REVIEW_SCENARIOS.includes(value as PacketReviewScenario);
}

function safeCanonicalUrl(value: string | null) {
  if (value === null) return null;
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
