import {
  CONTRACT_VERSION,
  canonicalSha256,
  exportCanonicalGoldenRun,
  parseCompleteGoldenRun,
} from "../contracts";

import { goldenRunV01 } from "./golden-run-v0.1";

export const GOLDEN_FIXTURE_VERSION_V02 = "0.2" as const;
export const GOLDEN_FIXTURE_ID_V02 =
  "golden-biodegradable-sensor-72h-v0.2" as const;
export const GOLDEN_FIXTURE_SHA256_V02 =
  "6665902c3abc6855916d2d41f8d6c21b2db84272e97261f4dd2a8fa10090c49c" as const;
export const GOLDEN_PACKET_FINGERPRINT_V02 =
  "a99b8fb0df30f7fd8f9c7a5dbcdb0cba027d42653a40350eaa81b597d5c2f4e7" as const;

const prior = structuredClone(goldenRunV01);
if (prior.packet === null || prior.finalDecision === null) {
  throw new Error("reviewed 0.1 golden fixture is incomplete");
}

const { fingerprint: _priorFingerprint, ...priorPacketPayload } = prior.packet;
void _priorFingerprint;
const packetPayload = {
  ...priorPacketPayload,
  schemaVersion: CONTRACT_VERSION,
};
const packet = {
  ...packetPayload,
  fingerprint: canonicalSha256(packetPayload),
};

const runInput = {
  ...prior,
  schemaVersion: CONTRACT_VERSION,
  id: GOLDEN_FIXTURE_ID_V02,
  packet,
  finalDecision: {
    ...prior.finalDecision,
    optionsShown: ["approve", "reject"],
    edits: [],
    declaredActor: "Fixture review lead",
    rationale:
      "Approve only the bounded, non-hazardous educational pilot while retaining the unresolved degradation-safety risk and qualified-review requirement.",
  },
  executions: prior.executions.map((execution) => ({
    ...execution,
    structuredOutputSchemaVersion: execution.structuredOutputSchemaVersion,
    inputRefs: execution.inputRefs.map((reference) =>
      reference === prior.id ? GOLDEN_FIXTURE_ID_V02 : reference,
    ),
    outputRefs: execution.outputRefs.map((reference) =>
      reference === prior.id ? GOLDEN_FIXTURE_ID_V02 : reference,
    ),
  })),
};

export function parseGoldenRunV02(input: unknown) {
  const parsed = parseCompleteGoldenRun(input);
  if (canonicalSha256(parsed) !== GOLDEN_FIXTURE_SHA256_V02) {
    throw new Error("golden 0.2 fixture does not match the reviewed canonical hash");
  }
  if (parsed.packet?.fingerprint !== GOLDEN_PACKET_FINGERPRINT_V02) {
    throw new Error("golden 0.2 packet does not match the reviewed fingerprint");
  }
  return parsed;
}

export const goldenRunV02 = parseGoldenRunV02(runInput);
export const computedGoldenFixtureSha256V02 = canonicalSha256(goldenRunV02);
export const computedGoldenPacketFingerprintV02 = goldenRunV02.packet!.fingerprint;

export function exportGoldenRunV02(): string {
  return exportCanonicalGoldenRun(goldenRunV02);
}
