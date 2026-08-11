const CONTRACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const LEGACY_CONTRACT_VERSION = "0.0" as const;
export const PREVIOUS_CONTRACT_VERSION = "0.1" as const;
export const CONTRACT_VERSION = "0.2" as const;

export const CONTRACT_EVOLUTION_POLICY = Object.freeze({
  compatibilityDirection: "new_reader_accepts_prior_minor",
  allowedWithinMajor: [
    "add an optional field whose absence remains semantically explicit",
    "add a new standalone schema that does not alter an existing payload",
  ],
  requiresMajorChange: [
    "remove or rename a field",
    "change a field type or make an optional field required",
    "change canonicalization or packet-fingerprint semantics",
    "change the meaning of an existing enum value",
  ],
} as const);

export const PRE_FREEZE_COMPATIBILITY_NOTES = Object.freeze({
  "NodeExecution.promptHash":
    "Optional only when reading legacy 0.0 candidate records through the explicit legacy reader; every 0.1 and current 0.2 execution must persist the server-selected canonical prompt hash.",
  "ResearchRun.experimentAbstention":
    "Optional only when reading legacy 0.0 candidate records through the explicit legacy reader; 0.1 and current 0.2 runs initialize it explicitly and use it for typed safety abstention.",
  "HumanDecision.declaredActor/rationale":
    "Optional when reading 0.0 and 0.1 records. Current 0.2 final decisions require the paired declared, unauthenticated actor label and human rationale.",
  legacyMigration:
    "A 0.0 or 0.1 run is readable but is not automatically relabeled as 0.2. Migration requires resolving exact prompt resources and human-refreezing the versioned packet because schema version participates in packet identity.",
} as const);

type ParsedContractVersion = {
  major: number;
  minor: number;
};

export function parseContractVersion(
  version: string,
): ParsedContractVersion | null {
  const match = CONTRACT_VERSION_PATTERN.exec(version);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

/**
 * Checks whether a declared contract-version transition is allowed.
 *
 * This is a version policy check, not structural proof that a schema diff is
 * additive. A newer reader must separately prove that it still accepts the
 * prior minor version's payloads.
 */
export function isAllowedContractVersionTransition(
  currentVersion: string,
  candidateVersion: string,
): boolean {
  const current = parseContractVersion(currentVersion);
  const candidate = parseContractVersion(candidateVersion);

  return (
    current !== null &&
    candidate !== null &&
    current.major === candidate.major &&
    candidate.minor >= current.minor
  );
}
