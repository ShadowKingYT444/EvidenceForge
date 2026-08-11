import type { ResearchRun } from "../../contracts";

export type FinalDecisionChoice = "approve" | "reject";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const fixtureId = "golden-biodegradable-sensor-72h-v0.2";
const fixtureSha256 =
  "6665902c3abc6855916d2d41f8d6c21b2db84272e97261f4dd2a8fa10090c49c";
const packetFingerprint =
  "a99b8fb0df30f7fd8f9c7a5dbcdb0cba027d42653a40350eaa81b597d5c2f4e7";
export const FINAL_SESSION_RESET_NOTICE =
  "This isolated demo session is process-local and resets on server restart or redeploy.";
export const FINAL_ACTOR_AUTHORITY =
  "Final-decision actor labels are declared and unverified; authentication is not enabled.";

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const forbiddenAuditText = /[\p{Cc}\p{Cf}]/u;
const receiptKeys = [
  "checkpoint",
  "decidedAt",
  "decision",
  "declaredActor",
  "edits",
  "id",
  "optionsShown",
  "rationale",
  "unresolvedObjections",
] as const;

export type FinalDecisionReceipt = {
  id: string;
  checkpoint: "final";
  optionsShown: ["approve", "reject"];
  decision: FinalDecisionChoice;
  edits: [];
  decidedAt: string;
  unresolvedObjections: string[];
  declaredActor: string;
  rationale: string;
};

export type FixtureSession = {
  runId: string;
  revision: string;
  snapshot: ResearchRun;
  disclosure: {
    evidenceMode: "fixture";
    sourceFixtureId: typeof fixtureId;
    sourceFixtureSha256: typeof fixtureSha256;
    packetFingerprint: typeof packetFingerprint;
    persistence: {
      scope: "process_local";
      survivesCallsWithinProcess: true;
      survivesProcessRestart: false;
      diskDurable: false;
      multiProcessSafe: false;
    };
    resetNotice: typeof FINAL_SESSION_RESET_NOTICE;
    actorAuthority: typeof FINAL_ACTOR_AUTHORITY;
  };
};

export type FixtureSessionResult =
  | { ok: true; session: FixtureSession }
  | {
      ok: false;
      code: "request_failed" | "invalid_response";
      message: string;
    };

export type VerifiedTerminal = {
  revision: string;
  run: ResearchRun;
  receipt: FinalDecisionReceipt;
};

export type FinalDecisionResult =
  | ({ ok: true; source: "submitted"; message: string } & VerifiedTerminal)
  | {
      ok: false;
      code:
        | "input_required"
        | "invalid_target"
        | "revision_conflict"
        | "already_decided"
        | "session_reset"
        | "request_failed"
        | "invalid_response";
      message: string;
      fields?: Array<"choice" | "declaredActor" | "rationale">;
      latest?: { revision: string; run: ResearchRun };
      terminal?: VerifiedTerminal;
    };

type SubmissionInput = {
  runId: string;
  expectedRevision: string;
  priorSnapshot: ResearchRun;
  choice: FinalDecisionChoice | null;
  declaredActor: string;
  rationale: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function nonBlank(value: unknown, maximum = Number.POSITIVE_INFINITY): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function isAuditText(value: unknown, maximum: number): value is string {
  return nonBlank(value, maximum) && !forbiddenAuditText.test(value);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedUnresolved(run: ResearchRun): string[] | null {
  if (!run.revision || !Array.isArray(run.revision.decisions)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const decision of run.revision.decisions) {
    if (!nonBlank(decision.objectionId) || seen.has(decision.objectionId)) {
      return null;
    }
    seen.add(decision.objectionId);
    if (decision.disposition === "unresolved") ids.push(decision.objectionId);
  }
  return ids.sort();
}

function isCanonicalFixtureRun(value: unknown, runId: string): value is ResearchRun {
  if (!isRecord(value) || value.id !== runId) return false;
  if (
    value.schemaVersion !== "0.2" ||
    value.evidenceMode !== "fixture" ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(value.packet) ||
    value.packet.fingerprint !== packetFingerprint
  ) {
    return false;
  }
  return expectedUnresolved(value as ResearchRun) !== null;
}

function isWaitingFixtureRun(value: unknown, runId: string): value is ResearchRun {
  return (
    isCanonicalFixtureRun(value, runId) &&
    value.status === "awaiting_final_approval" &&
    value.finalDecision === null
  );
}

function isDisclosure(value: unknown): value is FixtureSession["disclosure"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actorAuthority",
      "evidenceMode",
      "packetFingerprint",
      "persistence",
      "resetNotice",
      "sourceFixtureId",
      "sourceFixtureSha256",
    ]) ||
    value.evidenceMode !== "fixture" ||
    value.sourceFixtureId !== fixtureId ||
    value.sourceFixtureSha256 !== fixtureSha256 ||
    value.packetFingerprint !== packetFingerprint ||
    value.resetNotice !== FINAL_SESSION_RESET_NOTICE ||
    value.actorAuthority !== FINAL_ACTOR_AUTHORITY ||
    !isRecord(value.persistence) ||
    !hasExactKeys(value.persistence, [
      "diskDurable",
      "multiProcessSafe",
      "scope",
      "survivesCallsWithinProcess",
      "survivesProcessRestart",
    ])
  ) {
    return false;
  }
  return (
    value.persistence.scope === "process_local" &&
    value.persistence.survivesCallsWithinProcess === true &&
    value.persistence.survivesProcessRestart === false &&
    value.persistence.diskDurable === false &&
    value.persistence.multiProcessSafe === false
  );
}

function parseBootstrap(value: unknown): FixtureSession | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["disclosure", "revision", "runId", "snapshot"]) ||
    !nonBlank(value.runId, 128) ||
    !runIdPattern.test(value.runId) ||
    !nonBlank(value.revision, 128) ||
    !isWaitingFixtureRun(value.snapshot, value.runId) ||
    !isDisclosure(value.disclosure)
  ) {
    return null;
  }
  return structuredClone(value) as FixtureSession;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseCode(value: unknown): string | null {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string"
    ? value.error.code
    : null;
}

export async function startFixtureWorkbenchSession(
  fetcher: Fetcher = fetch,
): Promise<FixtureSessionResult> {
  let response: Response;
  try {
    response = await fetcher("/api/runs/fixture-workbench", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    return {
      ok: false,
      code: "request_failed",
      message: "The fixture decision session could not be started. Try again.",
    };
  }
  const payload = await responseJson(response);
  if (!response.ok) {
    return {
      ok: false,
      code: "request_failed",
      message: "The fixture decision session could not be started. Try again.",
    };
  }
  const session = parseBootstrap(payload);
  return session
    ? { ok: true, session }
    : {
        ok: false,
        code: "invalid_response",
        message: "The session response did not prove a canonical fixture run.",
      };
}

function parseSnapshotEnvelope(
  value: unknown,
  runId: string,
): { revision: string; run: ResearchRun } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["revision", "run"]) ||
    !nonBlank(value.revision, 128) ||
    !isCanonicalFixtureRun(value.run, runId)
  ) {
    return null;
  }
  return structuredClone(value) as { revision: string; run: ResearchRun };
}

function parseReceipt(
  value: unknown,
  expectedChoice: FinalDecisionChoice | null,
  expectedActor: string | null,
  expectedRationale: string | null,
  unresolved: readonly string[],
): FinalDecisionReceipt | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, receiptKeys) ||
    !nonBlank(value.id) ||
    value.checkpoint !== "final" ||
    !sameStrings(value.optionsShown, ["approve", "reject"]) ||
    (value.decision !== "approve" && value.decision !== "reject") ||
    (expectedChoice !== null && value.decision !== expectedChoice) ||
    !Array.isArray(value.edits) ||
    value.edits.length !== 0 ||
    !isTimestamp(value.decidedAt) ||
    !sameStrings(value.unresolvedObjections, unresolved) ||
    new Set(value.unresolvedObjections as string[]).size !== unresolved.length ||
    !isAuditText(value.declaredActor, 80) ||
    !isAuditText(value.rationale, 2_000) ||
    (expectedActor !== null && value.declaredActor !== expectedActor) ||
    (expectedRationale !== null && value.rationale !== expectedRationale)
  ) {
    return null;
  }
  return structuredClone(value) as FinalDecisionReceipt;
}

function verifyTerminal(
  envelope: { revision: string; run: ResearchRun },
  prior: ResearchRun,
  expectedRevision: string,
  expectedChoice: FinalDecisionChoice | null,
  expectedActor: string | null,
  expectedRationale: string | null,
): VerifiedTerminal | null {
  if (envelope.revision === expectedRevision) return null;
  const unresolved = expectedUnresolved(prior);
  if (unresolved === null) return null;
  const receipt = parseReceipt(
    envelope.run.finalDecision,
    expectedChoice,
    expectedActor,
    expectedRationale,
    unresolved,
  );
  if (!receipt) return null;
  const expectedStatus = receipt.decision === "approve" ? "approved" : "rejected";
  if (
    envelope.run.status !== expectedStatus ||
    envelope.run.updatedAt !== receipt.decidedAt
  ) {
    return null;
  }
  const normalized = {
    ...structuredClone(envelope.run),
    status: prior.status,
    updatedAt: prior.updatedAt,
    finalDecision: prior.finalDecision,
  };
  if (stableJson(normalized) !== stableJson(prior)) return null;
  return { ...envelope, receipt };
}

export function inspectStoredTerminal(
  run: ResearchRun,
  revision: string,
): VerifiedTerminal | null {
  if (
    !nonBlank(revision, 128) ||
    !isCanonicalFixtureRun(run, run.id) ||
    (run.status !== "approved" && run.status !== "rejected")
  ) {
    return null;
  }
  const unresolved = expectedUnresolved(run);
  if (unresolved === null) return null;
  const receipt = parseReceipt(
    run.finalDecision,
    null,
    null,
    null,
    unresolved,
  );
  if (!receipt) return null;
  const expectedStatus = receipt.decision === "approve" ? "approved" : "rejected";
  return run.status === expectedStatus && run.updatedAt === receipt.decidedAt
    ? { run: structuredClone(run), revision, receipt }
    : null;
}

async function recoverConflict(
  input: SubmissionInput,
  fetcher: Fetcher,
): Promise<FinalDecisionResult> {
  let response: Response;
  try {
    response = await fetcher(`/api/runs/${encodeURIComponent(input.runId)}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    return {
      ok: false,
      code: "request_failed",
      message: "The latest canonical run could not be loaded. Your inputs were retained.",
    };
  }
  const payload = await responseJson(response);
  if (response.status === 404 && responseCode(payload) === "run_not_found") {
    return {
      ok: false,
      code: "session_reset",
      message: `${FINAL_SESSION_RESET_NOTICE} Start a new fixture session to continue.`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "request_failed",
      message: "The latest canonical run could not be loaded. Your inputs were retained.",
    };
  }
  const envelope = parseSnapshotEnvelope(payload, input.runId);
  if (!envelope) {
    return {
      ok: false,
      code: "invalid_response",
      message: "The latest run response could not be validated. Your inputs were retained.",
    };
  }
  if (isWaitingFixtureRun(envelope.run, input.runId)) {
    return {
      ok: false,
      code: "revision_conflict",
      message: "This run changed before the decision was saved. Review the latest revision before retrying.",
      latest: envelope,
    };
  }
  const terminal = verifyTerminal(
    envelope,
    input.priorSnapshot,
    input.expectedRevision,
    null,
    null,
    null,
  );
  return terminal
    ? {
        ok: false,
        code: "already_decided",
        message: "Another final decision was recorded first. The canonical receipt is shown; your inputs were not submitted as that decision.",
        terminal,
      }
    : {
        ok: false,
        code: "invalid_response",
        message: "The latest run response could not be validated. Your inputs were retained.",
      };
}

export async function submitFinalDecision(
  input: SubmissionInput,
  fetcher: Fetcher = fetch,
): Promise<FinalDecisionResult> {
  const fields: Array<"choice" | "declaredActor" | "rationale"> = [];
  if (input.choice !== "approve" && input.choice !== "reject") fields.push("choice");
  const declaredActor = input.declaredActor.trim();
  const rationale = input.rationale.trim();
  if (!isAuditText(declaredActor, 80)) fields.push("declaredActor");
  if (!isAuditText(rationale, 2_000)) fields.push("rationale");
  if (fields.length > 0) {
    return {
      ok: false,
      code: "input_required",
      message: "Choose approve or reject and provide a valid declared actor and rationale.",
      fields,
    };
  }
  if (
    !nonBlank(input.runId, 128) ||
    !runIdPattern.test(input.runId) ||
    !nonBlank(input.expectedRevision, 128) ||
    !isWaitingFixtureRun(input.priorSnapshot, input.runId)
  ) {
    return {
      ok: false,
      code: "invalid_target",
      message: "The canonical process-local run target is unavailable.",
    };
  }

  let response: Response;
  try {
    response = await fetcher(
      `/api/runs/${encodeURIComponent(input.runId)}/checkpoints`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkpoint: "final",
          expectedRevision: input.expectedRevision,
          decision: {
            choice: input.choice,
            declaredActor,
            rationale,
          },
        }),
      },
    );
  } catch {
    return {
      ok: false,
      code: "request_failed",
      message: "The final decision request failed. Your inputs were retained.",
    };
  }
  const payload = await responseJson(response);
  if (
    response.status === 409 &&
    responseCode(payload) === "revision_conflict"
  ) {
    return recoverConflict(input, fetcher);
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "request_failed",
      message: "The final decision was not saved. Your inputs were retained.",
    };
  }
  const envelope = parseSnapshotEnvelope(payload, input.runId);
  const terminal = envelope
    ? verifyTerminal(
        envelope,
        input.priorSnapshot,
        input.expectedRevision,
        input.choice,
        declaredActor,
        rationale,
      )
    : null;
  return terminal
    ? {
        ok: true,
        source: "submitted",
        message: "Final decision persisted to this process-local run.",
        ...terminal,
      }
    : {
        ok: false,
        code: "invalid_response",
        message: "The response could not prove that the final decision was persisted. Your inputs were retained.",
      };
}
