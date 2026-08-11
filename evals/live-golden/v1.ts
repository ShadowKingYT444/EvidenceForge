import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  NodeExecutionSchema,
  ResearchRunSchema,
  RunErrorSchema,
  canonicalSha256,
  canonicalizeJson,
} from "../../src/contracts";
import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_SHA256,
  GOLDEN_PACKET_FINGERPRINT,
  goldenRunV01,
} from "../../src/fixtures/golden-run-v0.1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
} from "../protocol/v1";
import {
  ArtifactBoundary,
  readTextContained,
  writeJsonAtomicNoReplace,
} from "../runner/v1";

export const LEGACY_LIVE_GOLDEN_ARTIFACT_VERSION = "1.0.0" as const;
export const LIVE_GOLDEN_ARTIFACT_VERSION = "2.0.0" as const;
export const APPROVED_EVF9_RIGHTS_APPROVAL_SHA256 =
  "9a0ffe668eb7562ee576d443a7c00c5d73cdf0727b09a661de460cbeb9efb8f5" as const;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CostBasisSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    inputPerMillionTokens: z.number().nonnegative(),
    cachedInputPerMillionTokens: z.number().nonnegative().nullable(),
    outputPerMillionTokens: z.number().nonnegative(),
    snapshotDate: z.iso.date(),
  })
  .strict();
const ModelIdentitySchema = z
  .object({
    provider: z.enum(["groq", "nvidia_nim", "featherless"]),
    modelId: z.string().min(1),
    developerFamily: z.string().min(1),
    baseFamily: z.string().min(1),
  })
  .strict();

export const APPROVED_PROMPT_MANIFEST_HASH =
  "f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2" as const;
export const R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH =
  "a2cdf4c65368d99ac1f48171338c77cf9ebb51b0631829ebf4e2411d67a4c174" as const;
export const COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH =
  "da10bd36100bb22decedde6951fbaec8cc88d98fe14f92d0d14b582890f442ca" as const;
export const HISTORICAL_PROMPT_MANIFEST_HASH =
  "4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e" as const;
export const APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH =
  "aca24c0d26695e54a2d22986363e5ee7193366bc24fcd7a4432e02877de05b29" as const;
export const R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "768d5bd15a146206fec01a618b2b6dfe471c60c902b6a0c81033132ea66c02c8" as const;
export const R11_DEEPSEEK_PREDECESSOR_COMPARISON_HASH =
  "687b4798de3becf7a99996c0051a199a5f9e8116b33e1492ee55b4a96a1a72ad" as const;
export const R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "12ff806d851ff4a81598f05ced5f7673c40fee1cd993faef4fb81b46c50bff3e" as const;
export const R10_PLANNING_PREDECESSOR_COMPARISON_HASH =
  "c8a088630ca8b09bf791db62613c89bb2032b0381e984165c18fb4c29ac42f14" as const;
export const MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "1347106d3f16087832c49d7b4e5b53f759898a65e7e65959d5e7cf7e41f346eb" as const;
export const GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "747dee0c54252db00aca26f31fd5aa9e62ee6474b3ab90bea87f46e4ab0a366c" as const;
export const COMPACT_EVIDENCE_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "685c145a7c57cb23fe2ff684c11b2bce1f8f0aa71589111ece48088c67f853e2" as const;
export const HISTORICAL_GPT_OSS_COMPACT_PREDECESSOR_NODE_CONFIGURATION_HASH =
  "3347ac013a0ce0af3cf2b8ef1e35abb75217422d3d782d9066e6c724bd375215" as const;
export const HISTORICAL_FEATHERLESS_NODE_CONFIGURATION_HASH =
  "d3a34da9017151599d34c1971a004264e9886c8e1ced6f6cbd392f52dd3e9ffb" as const;
export const HISTORICAL_FEATHERLESS_120S_NODE_CONFIGURATION_HASH =
  "09819024f1e35457c0af7198b7a501064c3c069e66987b5cb724779954c4570f" as const;
export const APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH =
  "0f284f3740446cb4b782be98b449cfdf4acbbc1d57d5eacb261bc91925123b87" as const;

export const APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY = Object.freeze({
  fixtureId: GOLDEN_FIXTURE_ID,
  fixtureSha256: GOLDEN_FIXTURE_SHA256,
  packetFingerprint: GOLDEN_PACKET_FINGERPRINT,
  rightsApprovalSha256: APPROVED_EVF9_RIGHTS_APPROVAL_SHA256,
  sourceOrder: Object.freeze(goldenRunV01.sources.map(({ id }) => id)),
  chunkOrder: Object.freeze(goldenRunV01.chunks.map(({ id }) => id)),
  sourceHashes: Object.freeze(
    goldenRunV01.sources.map(({ contentHash }) => contentHash),
  ),
  chunkHashes: Object.freeze(
    goldenRunV01.chunks.map(({ contentHash }) => contentHash),
  ),
});

export const COMPUTED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH = canonicalSha256(
  APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY,
);

export const HISTORICAL_PROMPT_MANIFEST_VERSION = "1.0.0" as const;
export const GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_VERSION = "2.0.0" as const;
export const MISTRAL_SHARED_TIMEOUT_PREDECESSOR_VERSION = "2.0.0" as const;
export const R11_DEEPSEEK_PREDECESSOR_VERSION = "2.0.0" as const;
function deepFreezeLiteral<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeLiteral(nested);
    Object.freeze(value);
  }
  return value;
}

export const R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST = deepFreezeLiteral([
  { hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52", id: "adversarial-experiment-review", version: "1.0.0" },
  { hash: "d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9", id: "assess-evidence-entailment", version: "2.0.0" },
  { hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e", id: "clarify-decompose", version: "1.0.0" },
  { hash: "98d1622f99392bdaea21a8c2cfa41deb7225e9dc84c3e2b2b69f9dae4ee7cf3f", id: "collect-bounded-source-packet", version: "1.0.0" },
  { hash: "bd505af273b69e4c30d0c74ab4b34067c6c1b92229db104027934c79ef637491", id: "design-reviewable-experiment", version: "2.0.0" },
  { hash: "0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1", id: "extract-grounded-evidence", version: "2.0.0" },
  { hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f", id: "selective-experiment-revision", version: "1.0.0" },
  { hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f", id: "strong-single-prompt-baseline", version: "1.0.0" },
  { hash: "ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02", id: "synthesize-conclusions-gaps", version: "2.0.0" },
]);

export const R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS = deepFreezeLiteral(JSON.parse('[{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"disabled","seed":null,"temperature":0,"topP":null},"hash":"654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52","id":"adversarial-experiment-review","inputSchema":{"hash":"701aa818bddb853d6dcbea2ef3648e866c055e0e48804128319b6209fa02c5a0","id":"adversarial-review-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"review-experiment","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"1a32e50bbe357e2a371cd23015ed784ff01c391bb448776f717fbcb2001b9e39","id":"adversarial-experiment-review-output","version":"1.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":true,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"1.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9","id":"assess-evidence-entailment","inputSchema":{"hash":"33658a2f3ebc3b5432891f546f5a2292ac4049eec2ec6f07ed916aa4cdbd8b12","id":"evidence-entailment-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"assess-entailment","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"8e851dac0dfaa40a140bedeaa5ee3b74af9fb29b5b61970d76e57f53c82828bb","id":"evidence-entailment-output","version":"2.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"2.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e","id":"clarify-decompose","inputSchema":{"hash":"6123be48259427e5e46d87b086defbf7efd4d800df32acca4317269805f860fb","id":"clarify-and-decompose-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"clarify-and-decompose","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"c600f6f6bd08201731273f66f6ec823582f1cf21c5ed5cca77f8c69052b4a0e5","id":"clarify-and-decompose-output","version":"1.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":false,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"1.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"bd505af273b69e4c30d0c74ab4b34067c6c1b92229db104027934c79ef637491","id":"design-reviewable-experiment","inputSchema":{"hash":"612a57285269affb4ebf3670eaae2c774aeca761ec1016ae29a342e3176ffcf0","id":"experiment-planning-input","version":"2.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"plan-experiment","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"43366eeae3349eb5fc893ba0abec18f3dceb9e3c4bbbc60f0fe147abeb1dd196","id":"experiment-planning-model-output","version":"2.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"2.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1","id":"extract-grounded-evidence","inputSchema":{"hash":"9f8198627867e7033e540617c59090ed3c2fe907ae9db4d13c0087095eda8592","id":"grounded-evidence-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"extract-evidence","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"fc10151c87618e51e2a3cb4bb39f7e2c6f767ce0406a42a1d83dae19dada6971","id":"grounded-evidence-output","version":"2.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"2.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f","id":"selective-experiment-revision","inputSchema":{"hash":"cffc3355b654c8a308f7ed62feb173d1f30c1ef21c1206af32b68ee059e54a3e","id":"selective-revision-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"revise-experiment","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"88a7ab8ef85ab3e8d19b856cfd3de55cbeb5da18dcf1993e512849ef2284d921","id":"selective-experiment-revision-output","version":"1.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"1.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f","id":"strong-single-prompt-baseline","inputSchema":{"hash":"0486687334fe02ab279d48498f7a283c2144eba8b6b26beabd426202271e3410","id":"strong-single-prompt-baseline-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"strong-baseline","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"a6f50534cb124ceae5f72f2ef986064327a43b4da68a97855dff555a5e2ae9fc","id":"strong-single-prompt-baseline-output","version":"1.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"1.0.0"},{"generationSettings":{"maxOutputTokens":2048,"reasoningBudgetTokens":null,"reasoningMode":"provider_default","seed":null,"temperature":0,"topP":null},"hash":"ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02","id":"synthesize-conclusions-gaps","inputSchema":{"hash":"47ea734ca3806dc68b12e74628026f6a70625e662bd32c990699ddef3eb8baef","id":"synthesis-and-gap-input","version":"1.0.0"},"maximumAttempts":2,"maximumRetryBackoffMs":1000,"maximumTransportBudgetMs":240000,"nodeId":"synthesize-conclusions","outputLimitPolicyVersion":"1.0.0","outputSchema":{"hash":"e5c34aa592d46012eb7d6569a57c596795b736afa0fa29f5fbe6378c89171220","id":"synthesis-and-gap-output","version":"2.0.0"},"providerCapabilities":{"modelInvocation":"allowed","requiresDifferentBaseFamily":false,"requiresFrozenPacket":true,"structuredOutput":"application_validated_json"},"repairInvalidOutput":true,"structuredOutputTransportPolicy":{"applicationValidation":true,"promptSchemaAppended":true,"responseFormat":"json_object","version":"1.0.0"},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","timeoutScope":"per_transport_attempt","version":"2.0.0"}]'));

if (
  canonicalSha256(R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST) !==
    APPROVED_PROMPT_MANIFEST_HASH ||
  canonicalSha256(R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS) !==
    R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH
) {
  throw new Error("r11 DeepSeek predecessor literal identity mismatch");
}

export const GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST =
  deepFreezeLiteral([
    { id: "adversarial-experiment-review", version: "1.0.0", hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52" },
    { id: "assess-evidence-entailment", version: "2.0.0", hash: "d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9" },
    { id: "clarify-decompose", version: "1.0.0", hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e" },
    { id: "collect-bounded-source-packet", version: "1.0.0", hash: "98d1622f99392bdaea21a8c2cfa41deb7225e9dc84c3e2b2b69f9dae4ee7cf3f" },
    { id: "design-reviewable-experiment", version: "1.0.0", hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941" },
    { id: "extract-grounded-evidence", version: "2.0.0", hash: "0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1" },
    { id: "selective-experiment-revision", version: "1.0.0", hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f" },
    { id: "strong-single-prompt-baseline", version: "1.0.0", hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f" },
    { id: "synthesize-conclusions-gaps", version: "2.0.0", hash: "ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02" },
  ]);

export const MISTRAL_SHARED_TIMEOUT_PREDECESSOR_PROMPT_MANIFEST =
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST;

export const R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST =
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST;
export const R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS =
  deepFreezeLiteral([{"id":"adversarial-experiment-review","version":"1.0.0","hash":"654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52","nodeId":"review-experiment","inputSchema":{"id":"adversarial-review-input","version":"1.0.0","hash":"701aa818bddb853d6dcbea2ef3648e866c055e0e48804128319b6209fa02c5a0"},"outputSchema":{"id":"adversarial-experiment-review-output","version":"1.0.0","hash":"1a32e50bbe357e2a371cd23015ed784ff01c391bb448776f717fbcb2001b9e39"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"disabled","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":true},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"assess-evidence-entailment","version":"2.0.0","hash":"d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9","nodeId":"assess-entailment","inputSchema":{"id":"evidence-entailment-input","version":"1.0.0","hash":"33658a2f3ebc3b5432891f546f5a2292ac4049eec2ec6f07ed916aa4cdbd8b12"},"outputSchema":{"id":"evidence-entailment-output","version":"2.0.0","hash":"8e851dac0dfaa40a140bedeaa5ee3b74af9fb29b5b61970d76e57f53c82828bb"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"clarify-decompose","version":"1.0.0","hash":"f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e","nodeId":"clarify-and-decompose","inputSchema":{"id":"clarify-and-decompose-input","version":"1.0.0","hash":"6123be48259427e5e46d87b086defbf7efd4d800df32acca4317269805f860fb"},"outputSchema":{"id":"clarify-and-decompose-output","version":"1.0.0","hash":"c600f6f6bd08201731273f66f6ec823582f1cf21c5ed5cca77f8c69052b4a0e5"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":false,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"design-reviewable-experiment","version":"1.0.0","hash":"efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941","nodeId":"plan-experiment","inputSchema":{"id":"experiment-planning-input","version":"1.0.0","hash":"9903e755597262306915d2ab3da47e81f4b13ed198f9842a6947b058dcbaf2cb"},"outputSchema":{"id":"experiment-planning-result","version":"1.0.0","hash":"6e6d5b7f030a2eb0daa17120fde61490f4f2c4dd9d94f4d7c0b469d99d545210"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"extract-grounded-evidence","version":"2.0.0","hash":"0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1","nodeId":"extract-evidence","inputSchema":{"id":"grounded-evidence-input","version":"1.0.0","hash":"9f8198627867e7033e540617c59090ed3c2fe907ae9db4d13c0087095eda8592"},"outputSchema":{"id":"grounded-evidence-output","version":"2.0.0","hash":"fc10151c87618e51e2a3cb4bb39f7e2c6f767ce0406a42a1d83dae19dada6971"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"selective-experiment-revision","version":"1.0.0","hash":"10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f","nodeId":"revise-experiment","inputSchema":{"id":"selective-revision-input","version":"1.0.0","hash":"cffc3355b654c8a308f7ed62feb173d1f30c1ef21c1206af32b68ee059e54a3e"},"outputSchema":{"id":"selective-experiment-revision-output","version":"1.0.0","hash":"88a7ab8ef85ab3e8d19b856cfd3de55cbeb5da18dcf1993e512849ef2284d921"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"strong-single-prompt-baseline","version":"1.0.0","hash":"278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f","nodeId":"strong-baseline","inputSchema":{"id":"strong-single-prompt-baseline-input","version":"1.0.0","hash":"0486687334fe02ab279d48498f7a283c2144eba8b6b26beabd426202271e3410"},"outputSchema":{"id":"strong-single-prompt-baseline-output","version":"1.0.0","hash":"a6f50534cb124ceae5f72f2ef986064327a43b4da68a97855dff555a5e2ae9fc"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000},{"id":"synthesize-conclusions-gaps","version":"2.0.0","hash":"ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02","nodeId":"synthesize-conclusions","inputSchema":{"id":"synthesis-and-gap-input","version":"1.0.0","hash":"47ea734ca3806dc68b12e74628026f6a70625e662bd32c990699ddef3eb8baef"},"outputSchema":{"id":"synthesis-and-gap-output","version":"2.0.0","hash":"e5c34aa592d46012eb7d6569a57c596795b736afa0fa29f5fbe6378c89171220"},"generationSettings":{"temperature":0,"maxOutputTokens":2048,"topP":null,"seed":null,"reasoningMode":"provider_default","reasoningBudgetTokens":null},"outputLimitPolicyVersion":"1.0.0","structuredOutputTransportPolicy":{"version":"1.0.0","responseFormat":"json_object","promptSchemaAppended":true,"applicationValidation":true},"timeoutMs":120000,"timeoutPolicyVersion":"2.0.0","maximumAttempts":2,"repairInvalidOutput":true,"providerCapabilities":{"structuredOutput":"application_validated_json","requiresFrozenPacket":true,"modelInvocation":"allowed","requiresDifferentBaseFamily":false},"timeoutScope":"per_transport_attempt","maximumTransportBudgetMs":240000,"maximumRetryBackoffMs":1000}]);

if (
  canonicalSha256(R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST) !==
    R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH ||
  canonicalSha256(R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS) !==
    R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH
) {
  throw new Error("r10 planning predecessor literal identity mismatch");
}

export const MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS = deepFreezeLiteral([
  { id: "adversarial-experiment-review", version: "1.0.0", hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52", nodeId: "review-experiment", inputSchema: { id: "adversarial-review-input", version: "1.0.0", hash: "701aa818bddb853d6dcbea2ef3648e866c055e0e48804128319b6209fa02c5a0" }, outputSchema: { id: "adversarial-experiment-review-output", version: "1.0.0", hash: "1a32e50bbe357e2a371cd23015ed784ff01c391bb448776f717fbcb2001b9e39" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: true } },
  { id: "assess-evidence-entailment", version: "2.0.0", hash: "d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9", nodeId: "assess-entailment", inputSchema: { id: "evidence-entailment-input", version: "1.0.0", hash: "33658a2f3ebc3b5432891f546f5a2292ac4049eec2ec6f07ed916aa4cdbd8b12" }, outputSchema: { id: "evidence-entailment-output", version: "2.0.0", hash: "8e851dac0dfaa40a140bedeaa5ee3b74af9fb29b5b61970d76e57f53c82828bb" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "clarify-decompose", version: "1.0.0", hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e", nodeId: "clarify-and-decompose", inputSchema: { id: "clarify-and-decompose-input", version: "1.0.0", hash: "6123be48259427e5e46d87b086defbf7efd4d800df32acca4317269805f860fb" }, outputSchema: { id: "clarify-and-decompose-output", version: "1.0.0", hash: "c600f6f6bd08201731273f66f6ec823582f1cf21c5ed5cca77f8c69052b4a0e5" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: false, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "design-reviewable-experiment", version: "1.0.0", hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941", nodeId: "plan-experiment", inputSchema: { id: "experiment-planning-input", version: "1.0.0", hash: "9903e755597262306915d2ab3da47e81f4b13ed198f9842a6947b058dcbaf2cb" }, outputSchema: { id: "experiment-planning-result", version: "1.0.0", hash: "6e6d5b7f030a2eb0daa17120fde61490f4f2c4dd9d94f4d7c0b469d99d545210" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "extract-grounded-evidence", version: "2.0.0", hash: "0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1", nodeId: "extract-evidence", inputSchema: { id: "grounded-evidence-input", version: "1.0.0", hash: "9f8198627867e7033e540617c59090ed3c2fe907ae9db4d13c0087095eda8592" }, outputSchema: { id: "grounded-evidence-output", version: "2.0.0", hash: "fc10151c87618e51e2a3cb4bb39f7e2c6f767ce0406a42a1d83dae19dada6971" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "selective-experiment-revision", version: "1.0.0", hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f", nodeId: "revise-experiment", inputSchema: { id: "selective-revision-input", version: "1.0.0", hash: "cffc3355b654c8a308f7ed62feb173d1f30c1ef21c1206af32b68ee059e54a3e" }, outputSchema: { id: "selective-experiment-revision-output", version: "1.0.0", hash: "88a7ab8ef85ab3e8d19b856cfd3de55cbeb5da18dcf1993e512849ef2284d921" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "strong-single-prompt-baseline", version: "1.0.0", hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f", nodeId: "strong-baseline", inputSchema: { id: "strong-single-prompt-baseline-input", version: "1.0.0", hash: "0486687334fe02ab279d48498f7a283c2144eba8b6b26beabd426202271e3410" }, outputSchema: { id: "strong-single-prompt-baseline-output", version: "1.0.0", hash: "a6f50534cb124ceae5f72f2ef986064327a43b4da68a97855dff555a5e2ae9fc" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "synthesize-conclusions-gaps", version: "2.0.0", hash: "ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02", nodeId: "synthesize-conclusions", inputSchema: { id: "synthesis-and-gap-input", version: "1.0.0", hash: "47ea734ca3806dc68b12e74628026f6a70625e662bd32c990699ddef3eb8baef" }, outputSchema: { id: "synthesis-and-gap-output", version: "2.0.0", hash: "e5c34aa592d46012eb7d6569a57c596795b736afa0fa29f5fbe6378c89171220" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", structuredOutputTransportPolicy: { version: "1.0.0", responseFormat: "json_object", promptSchemaAppended: true, applicationValidation: true }, timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
]);

if (
  canonicalSha256(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS) !==
  MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH
) {
  throw new Error("Mistral shared-timeout predecessor node literal hash mismatch");
}

export const GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS = deepFreezeLiteral([
  { id: "adversarial-experiment-review", version: "1.0.0", hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52", nodeId: "review-experiment", inputSchema: { id: "adversarial-review-input", version: "1.0.0", hash: "701aa818bddb853d6dcbea2ef3648e866c055e0e48804128319b6209fa02c5a0" }, outputSchema: { id: "adversarial-experiment-review-output", version: "1.0.0", hash: "1a32e50bbe357e2a371cd23015ed784ff01c391bb448776f717fbcb2001b9e39" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "disabled", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: true } },
  { id: "assess-evidence-entailment", version: "2.0.0", hash: "d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9", nodeId: "assess-entailment", inputSchema: { id: "evidence-entailment-input", version: "1.0.0", hash: "33658a2f3ebc3b5432891f546f5a2292ac4049eec2ec6f07ed916aa4cdbd8b12" }, outputSchema: { id: "evidence-entailment-output", version: "2.0.0", hash: "8e851dac0dfaa40a140bedeaa5ee3b74af9fb29b5b61970d76e57f53c82828bb" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "clarify-decompose", version: "1.0.0", hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e", nodeId: "clarify-and-decompose", inputSchema: { id: "clarify-and-decompose-input", version: "1.0.0", hash: "6123be48259427e5e46d87b086defbf7efd4d800df32acca4317269805f860fb" }, outputSchema: { id: "clarify-and-decompose-output", version: "1.0.0", hash: "c600f6f6bd08201731273f66f6ec823582f1cf21c5ed5cca77f8c69052b4a0e5" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: false, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "design-reviewable-experiment", version: "1.0.0", hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941", nodeId: "plan-experiment", inputSchema: { id: "experiment-planning-input", version: "1.0.0", hash: "9903e755597262306915d2ab3da47e81f4b13ed198f9842a6947b058dcbaf2cb" }, outputSchema: { id: "experiment-planning-result", version: "1.0.0", hash: "6e6d5b7f030a2eb0daa17120fde61490f4f2c4dd9d94f4d7c0b469d99d545210" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "extract-grounded-evidence", version: "2.0.0", hash: "0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1", nodeId: "extract-evidence", inputSchema: { id: "grounded-evidence-input", version: "1.0.0", hash: "9f8198627867e7033e540617c59090ed3c2fe907ae9db4d13c0087095eda8592" }, outputSchema: { id: "grounded-evidence-output", version: "2.0.0", hash: "fc10151c87618e51e2a3cb4bb39f7e2c6f767ce0406a42a1d83dae19dada6971" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "selective-experiment-revision", version: "1.0.0", hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f", nodeId: "revise-experiment", inputSchema: { id: "selective-revision-input", version: "1.0.0", hash: "cffc3355b654c8a308f7ed62feb173d1f30c1ef21c1206af32b68ee059e54a3e" }, outputSchema: { id: "selective-experiment-revision-output", version: "1.0.0", hash: "88a7ab8ef85ab3e8d19b856cfd3de55cbeb5da18dcf1993e512849ef2284d921" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "strong-single-prompt-baseline", version: "1.0.0", hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f", nodeId: "strong-baseline", inputSchema: { id: "strong-single-prompt-baseline-input", version: "1.0.0", hash: "0486687334fe02ab279d48498f7a283c2144eba8b6b26beabd426202271e3410" }, outputSchema: { id: "strong-single-prompt-baseline-output", version: "1.0.0", hash: "a6f50534cb124ceae5f72f2ef986064327a43b4da68a97855dff555a5e2ae9fc" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
  { id: "synthesize-conclusions-gaps", version: "2.0.0", hash: "ec16986cc487b81acd160ee9a57483214eb970240b08657a0c95a0b4b8374a02", nodeId: "synthesize-conclusions", inputSchema: { id: "synthesis-and-gap-input", version: "1.0.0", hash: "47ea734ca3806dc68b12e74628026f6a70625e662bd32c990699ddef3eb8baef" }, outputSchema: { id: "synthesis-and-gap-output", version: "2.0.0", hash: "e5c34aa592d46012eb7d6569a57c596795b736afa0fa29f5fbe6378c89171220" }, generationSettings: { temperature: 0, maxOutputTokens: 2048, topP: null, seed: null, reasoningMode: "provider_default", reasoningBudgetTokens: null }, outputLimitPolicyVersion: "1.0.0", timeoutMs: 120000, timeoutPolicyVersion: "1.0.0", maximumAttempts: 2, repairInvalidOutput: true, providerCapabilities: { structuredOutput: "application_validated_json", requiresFrozenPacket: true, modelInvocation: "allowed", requiresDifferentBaseFamily: false } },
]);

if (
  canonicalSha256(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST) !==
  R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH
) {
  throw new Error("GPT-OSS structured-output predecessor prompt literal hash mismatch");
}

if (
  canonicalSha256(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS) !==
  GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH
) {
  throw new Error("GPT-OSS structured-output predecessor node literal hash mismatch");
}
export const COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_VERSION =
  "2.0.0" as const;
export const COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST = Object.freeze([
  Object.freeze({
    id: "adversarial-experiment-review",
    version: "1.0.0",
    hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52",
  }),
  Object.freeze({
    id: "assess-evidence-entailment",
    version: "2.0.0",
    hash: "d3b5d81cade367516fca9ef2f6a02536fe5f33bffa0a2b2337c24f3268bc2ad9",
  }),
  Object.freeze({
    id: "clarify-decompose",
    version: "1.0.0",
    hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e",
  }),
  Object.freeze({
    id: "collect-bounded-source-packet",
    version: "1.0.0",
    hash: "98d1622f99392bdaea21a8c2cfa41deb7225e9dc84c3e2b2b69f9dae4ee7cf3f",
  }),
  Object.freeze({
    id: "design-reviewable-experiment",
    version: "1.0.0",
    hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
  }),
  Object.freeze({
    id: "extract-grounded-evidence",
    version: "2.0.0",
    hash: "0046fb5ed4a7d2ed3dae68a3b082fd189d1ac953294dc1839ad91ace767df9a1",
  }),
  Object.freeze({
    id: "selective-experiment-revision",
    version: "1.0.0",
    hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f",
  }),
  Object.freeze({
    id: "strong-single-prompt-baseline",
    version: "1.0.0",
    hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f",
  }),
  Object.freeze({
    id: "synthesize-conclusions-gaps",
    version: "1.0.0",
    hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
  }),
]);
export const HISTORICAL_PROMPT_MANIFEST = Object.freeze([
  Object.freeze({
    id: "adversarial-experiment-review",
    version: "1.0.0",
    hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52",
  }),
  Object.freeze({
    id: "assess-evidence-entailment",
    version: "1.0.0",
    hash: "ca4924bb6987012a9b79ef59e3cd9c50d8a44f256b34ae7c3e358a4ab03a2cc2",
  }),
  Object.freeze({
    id: "clarify-decompose",
    version: "1.0.0",
    hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e",
  }),
  Object.freeze({
    id: "collect-bounded-source-packet",
    version: "1.0.0",
    hash: "98d1622f99392bdaea21a8c2cfa41deb7225e9dc84c3e2b2b69f9dae4ee7cf3f",
  }),
  Object.freeze({
    id: "design-reviewable-experiment",
    version: "1.0.0",
    hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
  }),
  Object.freeze({
    id: "extract-grounded-evidence",
    version: "1.0.0",
    hash: "e1129746a245922b8843522d0853921b9d4b37fc3a820abc19dc5d24e75bd0d4",
  }),
  Object.freeze({
    id: "selective-experiment-revision",
    version: "1.0.0",
    hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f",
  }),
  Object.freeze({
    id: "strong-single-prompt-baseline",
    version: "1.0.0",
    hash: "278581b7b39aea90981e1c51a2d8040bc28d4706883fe63d6a05454036088e5f",
  }),
  Object.freeze({
    id: "synthesize-conclusions-gaps",
    version: "1.0.0",
    hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
  }),
]);

if (
  canonicalSha256(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST) !==
  COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH
) {
  throw new Error("compact-evidence predecessor prompt manifest literal hash mismatch");
}

if (
  canonicalSha256(HISTORICAL_PROMPT_MANIFEST) !==
  HISTORICAL_PROMPT_MANIFEST_HASH
) {
  throw new Error("historical prompt manifest literal hash mismatch");
}

const LiveGoldenConfigBasePayloadSchema = z
  .object({
    schemaVersion: z.literal(LIVE_GOLDEN_ARTIFACT_VERSION),
    artifactScope: z.literal("approved_live_golden"),
    evidenceMode: z.enum(["live", "mocked"]),
    contractVersion: z.literal("0.1"),
    benchmarkProtocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
    benchmarkProtocolSchemaHash: z.literal(BENCHMARK_PROTOCOL_SCHEMA_HASH),
    conditionMatrixHash: z.literal(CONDITION_MATRIX_HASH),
    promptManifestHash: HashSchema,
    promptManifest: z.array(
      z
        .object({
          id: z.string().min(1),
          version: z.string().min(1),
          hash: HashSchema,
        })
        .strict(),
    ),
    codeVersion: z.string().regex(/^[a-f0-9]{40}$/),
    authority: z
      .object({
        fixtureId: z.literal(GOLDEN_FIXTURE_ID),
        fixtureSha256: z.literal(GOLDEN_FIXTURE_SHA256),
        packetFingerprint: z.literal(GOLDEN_PACKET_FINGERPRINT),
        rightsApprovalSha256: z.literal(
          APPROVED_EVF9_RIGHTS_APPROVAL_SHA256,
        ),
        sourceOrder: z.array(z.string().min(1)).length(7),
        chunkOrder: z.array(z.string().min(1)).length(7),
        sourceHashes: z.array(HashSchema).length(7),
        chunkHashes: z.array(HashSchema).length(7),
      })
      .strict(),
    primaryModel: ModelIdentitySchema.extend({
      provider: z.literal("featherless"),
      modelId: z.literal("mistralai/Mistral-Large-Instruct-2411"),
      developerFamily: z.literal("mistralai"),
      baseFamily: z.literal("mistral-large"),
    }).strict(),
    reviewerModel: ModelIdentitySchema.extend({
      provider: z.literal("featherless"),
      modelId: z.literal("deepseek-ai/DeepSeek-V4-Flash"),
      developerFamily: z.literal("deepseek"),
      baseFamily: z.literal("deepseek-v4"),
    }).strict(),
    costBasis: z
      .object({
        primary: CostBasisSchema,
        reviewer: CostBasisSchema,
      })
      .strict(),
    nodeConfigurations: z.array(z.json()).min(1),
    nodeConfigurationHash: HashSchema,
  })
  .strict();

const CurrentLiveGoldenNodeConfigurationSchema = z
  .object({
    generationSettings: z
      .object({ maxOutputTokens: z.literal(2_048) })
      .passthrough(),
    outputLimitPolicyVersion: z.literal("1.0.0"),
    structuredOutputTransportPolicy: z
      .object({
        version: z.literal("1.0.0"),
        responseFormat: z.literal("json_object"),
        promptSchemaAppended: z.literal(true),
        applicationValidation: z.literal(true),
      })
      .strict(),
    timeoutMs: z.literal(120_000),
    timeoutPolicyVersion: z.literal("2.0.0"),
    timeoutScope: z.literal("per_transport_attempt"),
    maximumTransportBudgetMs: z.literal(240_000),
    maximumRetryBackoffMs: z.literal(1_000),
    maximumAttempts: z.literal(2),
  })
  .passthrough();

const LiveGoldenConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    promptManifestHash: z.literal(APPROVED_PROMPT_MANIFEST_HASH),
    reviewerModel: ModelIdentitySchema.extend({
      provider: z.literal("featherless"),
      modelId: z.literal("Qwen/Qwen2.5-72B-Instruct"),
      developerFamily: z.literal("qwen"),
      baseFamily: z.literal("qwen2.5"),
    }).strict(),
    costBasis: z.null(),
    nodeConfigurationHash: z.literal(
      APPROVED_LIVE_GOLDEN_NODE_CONFIGURATION_HASH,
    ),
    nodeConfigurations: z
      .array(CurrentLiveGoldenNodeConfigurationSchema)
      .min(1),
  });

export const LiveGoldenArtifactConfigSchema =
  LiveGoldenConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message: "comparison invalidating hash does not match live config",
        });
      }
      if (
        config.nodeConfigurationHash !==
        canonicalSha256({
          nodeConfigurations: config.nodeConfigurations,
          reviewerModel: config.reviewerModel,
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurationHash"],
          message: "node configuration hash does not match its manifest",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          APPROVED_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(FROZEN_CONSUMER_EDGE.promptManifest)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "prompt manifest does not match the exact approved contents",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH ||
        COMPUTED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "authority does not match the exact approved contents",
        });
      }
    });

export type LiveGoldenArtifactConfig = z.output<
  typeof LiveGoldenArtifactConfigSchema
>;

const R11DeepSeekPredecessorConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    evidenceMode: z.literal("live"),
    codeVersion: z.literal("17969fec472a8641a765b03366f85944324693af"),
    costBasis: z
      .object({
        primary: CostBasisSchema.extend({
          currency: z.literal("USD"),
          inputPerMillionTokens: z.literal(0),
          cachedInputPerMillionTokens: z.null(),
          outputPerMillionTokens: z.literal(0),
          snapshotDate: z.literal("2026-08-11"),
        }).strict(),
        reviewer: CostBasisSchema.extend({
          currency: z.literal("USD"),
          inputPerMillionTokens: z.literal(0),
          cachedInputPerMillionTokens: z.null(),
          outputPerMillionTokens: z.literal(0),
          snapshotDate: z.literal("2026-08-11"),
        }).strict(),
      })
      .strict(),
    promptManifestHash: z.literal(APPROVED_PROMPT_MANIFEST_HASH),
    nodeConfigurationHash: z.literal(
      R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH,
    ),
    nodeConfigurations: z
      .array(CurrentLiveGoldenNodeConfigurationSchema)
      .min(1),
  });

const R11DeepSeekPredecessorArtifactConfigSchema =
  R11DeepSeekPredecessorConfigPayloadSchema.extend({
    comparisonInvalidatingHash: z.literal(
      R11_DEEPSEEK_PREDECESSOR_COMPARISON_HASH,
    ),
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (
        comparisonInvalidatingHash !==
          R11_DEEPSEEK_PREDECESSOR_COMPARISON_HASH ||
        canonicalSha256(payload) !== comparisonInvalidatingHash ||
        canonicalSha256(config.nodeConfigurations) !==
          R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH ||
        canonicalizeJson(config.nodeConfigurations) !==
          canonicalizeJson(R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATIONS)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurations"],
          message: "r11 DeepSeek predecessor configuration is not exact",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          APPROVED_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(R11_DEEPSEEK_PREDECESSOR_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "r11 DeepSeek predecessor prompt manifest is not exact",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "r11 DeepSeek predecessor authority is not exact",
        });
      }
    });

const R10PlanningPredecessorConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    evidenceMode: z.literal("live"),
    codeVersion: z.literal("db460a29f284f6cb813c370ed2a1846a46c0e0a5"),
    costBasis: z
      .object({
        primary: CostBasisSchema.extend({
          inputPerMillionTokens: z.literal(0),
          cachedInputPerMillionTokens: z.null(),
          outputPerMillionTokens: z.literal(0),
          snapshotDate: z.literal("2026-08-11"),
        }).strict(),
        reviewer: CostBasisSchema.extend({
          inputPerMillionTokens: z.literal(0),
          cachedInputPerMillionTokens: z.null(),
          outputPerMillionTokens: z.literal(0),
          snapshotDate: z.literal("2026-08-11"),
        }).strict(),
      })
      .strict(),
    promptManifestHash: z.literal(R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH),
    nodeConfigurationHash: z.literal(
      R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH,
    ),
  });

const R10PlanningPredecessorArtifactConfigSchema =
  R10PlanningPredecessorConfigPayloadSchema.extend({
    comparisonInvalidatingHash: z.literal(
      R10_PLANNING_PREDECESSOR_COMPARISON_HASH,
    ),
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (
        comparisonInvalidatingHash !== R10_PLANNING_PREDECESSOR_COMPARISON_HASH ||
        canonicalSha256(payload) !== comparisonInvalidatingHash ||
        config.nodeConfigurationHash !==
          canonicalSha256(config.nodeConfigurations) ||
        canonicalizeJson(config.nodeConfigurations) !==
          canonicalizeJson(R10_PLANNING_PREDECESSOR_NODE_CONFIGURATIONS)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurations"],
          message: "r10 planning predecessor configuration is not exact",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "r10 planning predecessor prompt manifest is not exact",
        });
      }
    });

const MistralSharedTimeoutPredecessorConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    promptManifestHash: z.literal(R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH),
    nodeConfigurationHash: z.literal(
      MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
    ),
  });

const MistralSharedTimeoutPredecessorArtifactConfigSchema =
  MistralSharedTimeoutPredecessorConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message: "comparison invalidating hash does not match Mistral shared-timeout predecessor config",
        });
      }
      if (
        config.nodeConfigurationHash !== canonicalSha256(config.nodeConfigurations) ||
        canonicalizeJson(config.nodeConfigurations) !==
          canonicalizeJson(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATIONS)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurations"],
          message: "Mistral shared-timeout predecessor node configuration does not match the complete literal",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !== R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(MISTRAL_SHARED_TIMEOUT_PREDECESSOR_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "Mistral shared-timeout predecessor prompt manifest does not match a2cdf",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "Mistral shared-timeout predecessor authority does not match the approved contents",
        });
      }
    });

const GptOssStructuredOutputPredecessorConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    promptManifestHash: z.literal(R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH),
    primaryModel: ModelIdentitySchema.extend({
      provider: z.literal("featherless"),
      modelId: z.literal("openai/gpt-oss-120b"),
      developerFamily: z.literal("openai"),
      baseFamily: z.literal("gpt-oss"),
    }).strict(),
    nodeConfigurationHash: z.literal(
      GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH,
    ),
  });

const GptOssStructuredOutputPredecessorArtifactConfigSchema =
  GptOssStructuredOutputPredecessorConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message: "comparison invalidating hash does not match GPT-OSS predecessor config",
        });
      }
      if (
        config.nodeConfigurationHash !== canonicalSha256(config.nodeConfigurations) ||
        canonicalizeJson(config.nodeConfigurations) !==
          canonicalizeJson(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATIONS)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurations"],
          message: "GPT-OSS predecessor node configuration does not match the complete literal",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !== R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "GPT-OSS predecessor prompt manifest does not match a2cdf",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "GPT-OSS predecessor authority does not match the approved contents",
        });
      }
    });

const CompactEvidencePredecessorConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    promptManifestHash: z.literal(
      COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH,
    ),
    primaryModel: ModelIdentitySchema.extend({
      provider: z.literal("featherless"),
      modelId: z.literal("openai/gpt-oss-120b"),
      developerFamily: z.literal("openai"),
      baseFamily: z.literal("gpt-oss"),
    }).strict(),
    nodeConfigurationHash: z.literal(
      COMPACT_EVIDENCE_PREDECESSOR_NODE_CONFIGURATION_HASH,
    ),
  });

const CompactEvidencePredecessorArtifactConfigSchema =
  CompactEvidencePredecessorConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message:
            "comparison invalidating hash does not match compact-evidence predecessor config",
        });
      }
      if (
        config.nodeConfigurationHash !==
        canonicalSha256(config.nodeConfigurations)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurationHash"],
          message:
            "compact-evidence predecessor node configuration hash does not match its manifest",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message:
            "compact-evidence predecessor prompt manifest does not match the literal contents",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message:
            "compact-evidence predecessor authority does not match the approved contents",
        });
      }
    });

const HistoricalFeatherlessConfigPayloadSchema =
  LiveGoldenConfigBasePayloadSchema.extend({
    promptManifestHash: z.literal(HISTORICAL_PROMPT_MANIFEST_HASH),
    primaryModel: z.union([
      ModelIdentitySchema.extend({
        provider: z.literal("featherless"),
        modelId: z.literal("Qwen/Qwen3.5-397B-A17B"),
        developerFamily: z.literal("qwen"),
        baseFamily: z.literal("qwen3.5"),
      }).strict(),
      ModelIdentitySchema.extend({
        provider: z.literal("featherless"),
        modelId: z.literal("openai/gpt-oss-120b"),
        developerFamily: z.literal("openai"),
        baseFamily: z.literal("gpt-oss"),
      }).strict(),
    ]),
    nodeConfigurationHash: z.union([
      z.literal(HISTORICAL_FEATHERLESS_NODE_CONFIGURATION_HASH),
      z.literal(HISTORICAL_FEATHERLESS_120S_NODE_CONFIGURATION_HASH),
      z.literal(
        HISTORICAL_GPT_OSS_COMPACT_PREDECESSOR_NODE_CONFIGURATION_HASH,
      ),
    ]),
  });

const HistoricalFeatherlessArtifactConfigSchema =
  HistoricalFeatherlessConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      const allowedNodeHashes: readonly string[] =
        config.primaryModel.modelId === "openai/gpt-oss-120b"
          ? [
              HISTORICAL_FEATHERLESS_120S_NODE_CONFIGURATION_HASH,
              HISTORICAL_GPT_OSS_COMPACT_PREDECESSOR_NODE_CONFIGURATION_HASH,
            ]
          : [
              HISTORICAL_FEATHERLESS_NODE_CONFIGURATION_HASH,
              HISTORICAL_FEATHERLESS_120S_NODE_CONFIGURATION_HASH,
            ];
      if (!allowedNodeHashes.includes(config.nodeConfigurationHash)) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurationHash"],
          message:
            "historical GPT-OSS config requires the exact 120-second node configuration",
        });
      }
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message: "comparison invalidating hash does not match historical Featherless config",
        });
      }
      if (
        config.nodeConfigurationHash !==
        canonicalSha256(config.nodeConfigurations)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurationHash"],
          message: "historical Featherless node configuration hash does not match its manifest",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          HISTORICAL_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(HISTORICAL_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "historical Featherless prompt manifest does not match the approved contents",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "historical Featherless authority does not match the approved contents",
        });
      }
    });

const LegacyLiveGoldenConfigPayloadSchema = HistoricalFeatherlessConfigPayloadSchema.extend({
  schemaVersion: z.literal(LEGACY_LIVE_GOLDEN_ARTIFACT_VERSION),
  nodeConfigurationHash: z.literal(
    HISTORICAL_FEATHERLESS_NODE_CONFIGURATION_HASH,
  ),
  primaryModel: ModelIdentitySchema.extend({
    provider: z.literal("groq"),
    modelId: z.literal("openai/gpt-oss-120b"),
    developerFamily: z.literal("openai"),
    baseFamily: z.literal("gpt-oss"),
  }).strict(),
  reviewerModel: ModelIdentitySchema.extend({
    provider: z.literal("nvidia_nim"),
    modelId: z.literal("nvidia/nemotron-3-super-120b-a12b"),
    developerFamily: z.literal("nvidia"),
    baseFamily: z.literal("nemotron-3"),
  }).strict(),
});

const LegacyLiveGoldenArtifactConfigSchema =
  LegacyLiveGoldenConfigPayloadSchema.extend({
    comparisonInvalidatingHash: HashSchema,
  })
    .strict()
    .superRefine((config, context) => {
      const { comparisonInvalidatingHash, ...payload } = config;
      if (comparisonInvalidatingHash !== canonicalSha256(payload)) {
        context.addIssue({
          code: "custom",
          path: ["comparisonInvalidatingHash"],
          message: "comparison invalidating hash does not match legacy config",
        });
      }
      if (
        config.nodeConfigurationHash !==
        canonicalSha256(config.nodeConfigurations)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodeConfigurationHash"],
          message: "legacy node configuration hash does not match its manifest",
        });
      }
      if (
        canonicalSha256(config.promptManifest) !==
          HISTORICAL_PROMPT_MANIFEST_HASH ||
        canonicalizeJson(config.promptManifest) !==
          canonicalizeJson(HISTORICAL_PROMPT_MANIFEST)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptManifest"],
          message: "legacy prompt manifest does not match the approved contents",
        });
      }
      if (
        canonicalizeJson(config.authority) !==
          canonicalizeJson(APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY) ||
        canonicalSha256(config.authority) !==
          APPROVED_LIVE_GOLDEN_CONFIG_AUTHORITY_HASH
      ) {
        context.addIssue({
          code: "custom",
          path: ["authority"],
          message: "legacy authority does not match the approved contents",
        });
      }
    });

type ReadableLiveGoldenArtifactConfig =
  | LiveGoldenArtifactConfig
  | z.output<typeof R11DeepSeekPredecessorArtifactConfigSchema>
  | z.output<typeof R10PlanningPredecessorArtifactConfigSchema>
  | z.output<typeof MistralSharedTimeoutPredecessorArtifactConfigSchema>
  | z.output<typeof GptOssStructuredOutputPredecessorArtifactConfigSchema>
  | z.output<typeof CompactEvidencePredecessorArtifactConfigSchema>
  | z.output<typeof HistoricalFeatherlessArtifactConfigSchema>
  | z.output<typeof LegacyLiveGoldenArtifactConfigSchema>;

export function createLiveGoldenArtifactConfig(
  input: z.input<typeof LiveGoldenConfigPayloadSchema>,
): LiveGoldenArtifactConfig {
  const payload = LiveGoldenConfigPayloadSchema.parse(structuredClone(input));
  return LiveGoldenArtifactConfigSchema.parse({
    ...payload,
    comparisonInvalidatingHash: canonicalSha256(payload),
  });
}

const ArtifactRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/);

const ArtifactEntrySchema = z
  .object({
    path: ArtifactRelativePathSchema,
    sha256: HashSchema,
    kind: z.enum(["config", "canonical_run", "attempt", "error"]),
  })
  .strict();

export const LiveGoldenArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(LIVE_GOLDEN_ARTIFACT_VERSION),
    artifactScope: z.literal("approved_live_golden"),
    runId: z.string().min(1),
    status: ResearchRunSchema.shape.status,
    evidenceMode: z.enum(["live", "mocked"]),
    configHash: HashSchema,
    canonicalRunHash: HashSchema,
    comparisonInvalidatingHash: HashSchema,
    complete: z.boolean(),
    attemptIds: z.array(z.string().min(1)),
    errorIds: z.array(z.string().min(1)),
    artifacts: z.array(ArtifactEntrySchema).min(2),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.artifacts.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "artifact paths must be unique",
      });
    }
  });

const LegacyLiveGoldenArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_LIVE_GOLDEN_ARTIFACT_VERSION),
    artifactScope: z.literal("approved_live_golden"),
    runId: z.string().min(1),
    status: ResearchRunSchema.shape.status,
    evidenceMode: z.enum(["live", "mocked"]),
    configHash: HashSchema,
    canonicalRunHash: HashSchema,
    comparisonInvalidatingHash: HashSchema,
    complete: z.boolean(),
    attemptIds: z.array(z.string().min(1)),
    errorIds: z.array(z.string().min(1)),
    artifacts: z.array(ArtifactEntrySchema).min(2),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.artifacts.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "legacy artifact paths must be unique",
      });
    }
  });

function bytes(value: unknown): string {
  return `${canonicalizeJson(value)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function assertRunMatchesConfig(
  runInput: unknown,
  configInput: ReadableLiveGoldenArtifactConfig,
): z.output<typeof ResearchRunSchema> {
  const config = configInput.schemaVersion === LEGACY_LIVE_GOLDEN_ARTIFACT_VERSION
    ? LegacyLiveGoldenArtifactConfigSchema.parse(structuredClone(configInput))
    : configInput.primaryModel.modelId === "mistralai/Mistral-Large-Instruct-2411" &&
        configInput.reviewerModel.modelId === "deepseek-ai/DeepSeek-V4-Flash" &&
        configInput.promptManifestHash === APPROVED_PROMPT_MANIFEST_HASH &&
        configInput.nodeConfigurationHash ===
          R11_DEEPSEEK_PREDECESSOR_NODE_CONFIGURATION_HASH
      ? R11DeepSeekPredecessorArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
    : configInput.primaryModel.modelId === "mistralai/Mistral-Large-Instruct-2411" &&
        configInput.promptManifestHash ===
          R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH &&
        configInput.nodeConfigurationHash ===
          R10_PLANNING_PREDECESSOR_NODE_CONFIGURATION_HASH
      ? R10PlanningPredecessorArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
    : configInput.primaryModel.modelId === "mistralai/Mistral-Large-Instruct-2411" &&
        configInput.promptManifestHash === R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH &&
        configInput.nodeConfigurationHash ===
          MISTRAL_SHARED_TIMEOUT_PREDECESSOR_NODE_CONFIGURATION_HASH
      ? MistralSharedTimeoutPredecessorArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
    : configInput.primaryModel.modelId === "openai/gpt-oss-120b" &&
        configInput.promptManifestHash === R10_PLANNING_PREDECESSOR_PROMPT_MANIFEST_HASH &&
        configInput.nodeConfigurationHash ===
          GPT_OSS_STRUCTURED_OUTPUT_PREDECESSOR_NODE_CONFIGURATION_HASH
      ? GptOssStructuredOutputPredecessorArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
      : configInput.primaryModel.modelId === "openai/gpt-oss-120b" &&
        configInput.promptManifestHash ===
          COMPACT_EVIDENCE_PREDECESSOR_PROMPT_MANIFEST_HASH &&
        configInput.nodeConfigurationHash ===
          COMPACT_EVIDENCE_PREDECESSOR_NODE_CONFIGURATION_HASH
      ? CompactEvidencePredecessorArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
      : configInput.primaryModel.modelId === "Qwen/Qwen3.5-397B-A17B" ||
        (configInput.primaryModel.modelId === "openai/gpt-oss-120b" &&
          (configInput.nodeConfigurationHash ===
            HISTORICAL_FEATHERLESS_120S_NODE_CONFIGURATION_HASH ||
            configInput.nodeConfigurationHash ===
              HISTORICAL_GPT_OSS_COMPACT_PREDECESSOR_NODE_CONFIGURATION_HASH))
      ? HistoricalFeatherlessArtifactConfigSchema.parse(
          structuredClone(configInput),
        )
      : LiveGoldenArtifactConfigSchema.parse(structuredClone(configInput));
  const run = ResearchRunSchema.parse(structuredClone(runInput));
  if (
    run.evidenceMode !== config.evidenceMode ||
    run.schemaVersion !== config.contractVersion ||
    run.packet?.fingerprint !== config.authority.packetFingerprint ||
    !exactJson(run.intake, goldenRunV01.intake) ||
    !exactJson(run.claims, goldenRunV01.claims) ||
    !exactJson(run.scopeDecision, goldenRunV01.scopeDecision) ||
    !exactJson(run.packet, goldenRunV01.packet) ||
    !exactJson(run.sources, goldenRunV01.sources) ||
    !exactJson(run.chunks, goldenRunV01.chunks)
  ) {
    throw new Error("live golden materializer input does not match its config");
  }
  const configurations = new Map(
    config.nodeConfigurations.map((item) => {
      const parsed = z
        .object({
          nodeId: z.string().min(1),
          id: z.string().min(1),
          version: z.string().min(1),
          hash: HashSchema,
          generationSettings: NodeExecutionSchema.shape.generationSettings,
        })
        .passthrough()
        .parse(item);
      return [parsed.nodeId, parsed] as const;
    }),
  );
  for (const execution of run.executions) {
    const expected = configurations.get(execution.nodeId);
    const reviewer = execution.nodeId === "review-experiment";
    const model = reviewer ? config.reviewerModel : config.primaryModel;
    if (
      expected === undefined ||
      execution.evidenceMode !== config.evidenceMode ||
      execution.requestedProvider !== model.provider ||
      execution.requestedModelId !== model.modelId ||
      execution.requestedDeveloperFamily !== model.developerFamily ||
      execution.requestedBaseFamily !== model.baseFamily ||
      execution.promptId !== expected.id ||
      execution.promptVersion !== expected.version ||
      execution.promptHash !== expected.hash ||
      !exactJson(execution.generationSettings, expected.generationSettings) ||
      execution.codeVersion !== config.codeVersion ||
      (execution.status === "succeeded" &&
        (execution.returnedProvider !== model.provider ||
          execution.returnedModelId !== model.modelId ||
          execution.returnedDeveloperFamily !== model.developerFamily ||
          execution.returnedBaseFamily !== model.baseFamily))
    ) {
      throw new Error(
        "live golden execution does not match the exact approved configuration",
      );
    }
  }
  return run;
}

type ArtifactEntry = z.output<typeof ArtifactEntrySchema>;

export class LiveGoldenArtifactSession {
  readonly #boundary: ArtifactBoundary;
  readonly #config: LiveGoldenArtifactConfig;
  readonly #runPath: string;
  readonly #entries: ArtifactEntry[];
  readonly #attempts: z.output<typeof NodeExecutionSchema>[] = [];
  readonly #errors: z.output<typeof RunErrorSchema>[] = [];
  #finalized = false;

  private constructor(input: {
    boundary: ArtifactBoundary;
    config: LiveGoldenArtifactConfig;
    runPath: string;
    configEntry: ArtifactEntry;
  }) {
    this.#boundary = input.boundary;
    this.#config = input.config;
    this.#runPath = input.runPath;
    this.#entries = [input.configEntry];
  }

  static async initialize(input: {
    artifactRoot: string;
    config: LiveGoldenArtifactConfig;
    runId: string;
  }): Promise<LiveGoldenArtifactSession> {
    const config = LiveGoldenArtifactConfigSchema.parse(
      structuredClone(input.config),
    );
    const runId = z.string().regex(/^[A-Za-z0-9._-]+$/).parse(input.runId);
    const boundary = await ArtifactBoundary.initialize(input.artifactRoot);
    const runParent = boundary.path(
      ["approved-live-golden", LIVE_GOLDEN_ARTIFACT_VERSION].join("/"),
    );
    await boundary.ensureDirectory(runParent);
    const runPath = boundary.path(
      [
        "approved-live-golden",
        LIVE_GOLDEN_ARTIFACT_VERSION,
        runId,
      ].join("/"),
    );
    await boundary.ensureDirectory(runPath, { exclusive: true });
    const configPath = join(runPath, "config.json");
    const configSha256 = await writeJsonAtomicNoReplace(
      boundary,
      configPath,
      config,
    );
    return new LiveGoldenArtifactSession({
      boundary,
      config,
      runPath,
      configEntry: {
        path: "config.json",
        sha256: configSha256,
        kind: "config",
      },
    });
  }

  get runPath(): string {
    return this.#runPath;
  }

  async appendAttempt(
    attemptInput: unknown,
    errorInputs: readonly unknown[],
  ): Promise<void> {
    if (this.#finalized) {
      throw new Error("live golden artifact session is already finalized");
    }
    const attempt = NodeExecutionSchema.parse(structuredClone(attemptInput));
    const errors = errorInputs.map((error) =>
      RunErrorSchema.parse(structuredClone(error)),
    );
    if (
      this.#attempts.some(({ id }) => id === attempt.id) ||
      errors.some(
        (error) =>
          error.executionId !== attempt.id ||
          this.#errors.some(({ id }) => id === error.id),
      ) ||
      new Set(errors.map(({ id }) => id)).size !== errors.length
    ) {
      throw new Error("live golden attempt journal is not append-only");
    }
    assertRunMatchesConfig(
      {
        ...goldenRunV01,
        id: "journal-validation",
        status: "extracting_evidence",
        evidenceMode: this.#config.evidenceMode,
        executions: [...this.#attempts, attempt],
        errors: [...this.#errors, ...errors],
      },
      this.#config,
    );

    for (const error of errors) {
      const sequence = String(this.#errors.length + 1).padStart(3, "0");
      const relativePath = `errors/${sequence}.json`;
      const hash = await writeJsonAtomicNoReplace(
        this.#boundary,
        join(this.#runPath, ...relativePath.split("/")),
        error,
      );
      this.#errors.push(error);
      this.#entries.push({ path: relativePath, sha256: hash, kind: "error" });
    }
    const sequence = String(this.#attempts.length + 1).padStart(3, "0");
    const relativePath = `attempts/${sequence}.json`;
    const hash = await writeJsonAtomicNoReplace(
      this.#boundary,
      join(this.#runPath, ...relativePath.split("/")),
      attempt,
    );
    this.#attempts.push(attempt);
    this.#entries.push({ path: relativePath, sha256: hash, kind: "attempt" });
  }

  async finalize(runInput: unknown) {
    if (this.#finalized) {
      throw new Error("live golden artifact session is already finalized");
    }
    const run = assertRunMatchesConfig(runInput, this.#config);
    if (
      !exactJson(run.executions, this.#attempts) ||
      !exactJson(run.errors, this.#errors)
    ) {
      throw new Error("live golden durable history does not match final run");
    }
    const canonicalPath = join(this.#runPath, "canonical", "run.json");
    const canonicalFileSha256 = await writeJsonAtomicNoReplace(
      this.#boundary,
      canonicalPath,
      run,
    );
    this.#entries.push({
      path: "canonical/run.json",
      sha256: canonicalFileSha256,
      kind: "canonical_run",
    });
    const manifest = LiveGoldenArtifactManifestSchema.parse({
      schemaVersion: LIVE_GOLDEN_ARTIFACT_VERSION,
      artifactScope: "approved_live_golden",
      runId: run.id,
      status: run.status,
      evidenceMode: this.#config.evidenceMode,
      configHash: canonicalSha256(this.#config),
      canonicalRunHash: canonicalSha256(run),
      comparisonInvalidatingHash: this.#config.comparisonInvalidatingHash,
      complete: run.status === "approved" || run.status === "rejected",
      attemptIds: run.executions.map(({ id }) => id),
      errorIds: run.errors.map(({ id }) => id),
      artifacts: [...this.#entries].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    });
    const manifestPath = join(this.#runPath, "manifest.json");
    await writeJsonAtomicNoReplace(this.#boundary, manifestPath, manifest);
    this.#finalized = true;
    return { runPath: this.#runPath, manifestPath, manifest };
  }
}

export async function materializeLiveGoldenArtifact(input: {
  artifactRoot: string;
  config: LiveGoldenArtifactConfig;
  run: unknown;
}) {
  const run = assertRunMatchesConfig(input.run, input.config);
  const session = await LiveGoldenArtifactSession.initialize({
    artifactRoot: input.artifactRoot,
    config: input.config,
    runId: run.id,
  });
  for (const attempt of run.executions) {
    await session.appendAttempt(
      attempt,
      run.errors.filter(({ executionId }) => executionId === attempt.id),
    );
  }
  if (run.errors.some(({ executionId }) => executionId === null)) {
    throw new Error("live golden errors must link to a durable attempt");
  }
  return session.finalize(run);
}

function parseCanonicalArtifact(content: string): unknown {
  const parsed = JSON.parse(content) as unknown;
  if (content !== bytes(parsed)) {
    throw new Error("live golden artifact is not canonical JSON");
  }
  return parsed;
}

export async function reopenLiveGoldenArtifact(manifestPathInput: string) {
  const manifestPath = resolve(manifestPathInput);
  const artifactRoot = resolve(manifestPath, "..", "..", "..", "..");
  const boundary = await ArtifactBoundary.initialize(artifactRoot);
  const manifestContent = await readTextContained(boundary, manifestPath);
  const parsedManifest = parseCanonicalArtifact(manifestContent);
  const version = z.object({ schemaVersion: z.string() }).parse(parsedManifest).schemaVersion;
  const manifest = version === LIVE_GOLDEN_ARTIFACT_VERSION
    ? LiveGoldenArtifactManifestSchema.parse(parsedManifest)
    : LegacyLiveGoldenArtifactManifestSchema.parse(parsedManifest);
  const expectedManifestPath = boundary.path(
    [
      "approved-live-golden",
      manifest.schemaVersion,
      manifest.runId,
      "manifest.json",
    ].join("/"),
  );
  if (expectedManifestPath !== manifestPath) {
    throw new Error("live golden manifest path does not match its run identity");
  }
  const attemptArtifacts = [];
  const errorArtifacts = [];
  let config: ReadableLiveGoldenArtifactConfig | null = null;
  let run: z.output<typeof ResearchRunSchema> | null = null;
  for (const entry of manifest.artifacts) {
    const path = boundary.path(
      [
        "approved-live-golden",
        manifest.schemaVersion,
        manifest.runId,
        entry.path,
      ].join("/"),
    );
    const content = await readTextContained(boundary, path);
    if (sha256(content) !== entry.sha256) {
      throw new Error(`live golden artifact hash mismatch: ${entry.path}`);
    }
    const parsed = parseCanonicalArtifact(content);
    if (entry.kind === "attempt") {
      attemptArtifacts.push(NodeExecutionSchema.parse(parsed));
    } else if (entry.kind === "error") {
      errorArtifacts.push(RunErrorSchema.parse(parsed));
    } else if (entry.kind === "config" && entry.path === "config.json") {
      if (config !== null) throw new Error("duplicate live golden config artifact");
      config = manifest.schemaVersion === LEGACY_LIVE_GOLDEN_ARTIFACT_VERSION
        ? LegacyLiveGoldenArtifactConfigSchema.parse(parsed)
        : z.union([
            LiveGoldenArtifactConfigSchema,
            R11DeepSeekPredecessorArtifactConfigSchema,
            R10PlanningPredecessorArtifactConfigSchema,
            MistralSharedTimeoutPredecessorArtifactConfigSchema,
            GptOssStructuredOutputPredecessorArtifactConfigSchema,
            CompactEvidencePredecessorArtifactConfigSchema,
            HistoricalFeatherlessArtifactConfigSchema,
          ]).parse(parsed);
    } else if (
      entry.kind === "canonical_run" &&
      entry.path === "canonical/run.json"
    ) {
      if (run !== null) throw new Error("duplicate live golden run artifact");
      run = ResearchRunSchema.parse(parsed);
    } else {
      throw new Error("live golden manifest contains an unexpected artifact");
    }
  }
  if (config === null || run === null) {
    throw new Error("live golden manifest is missing config or canonical run");
  }
  assertRunMatchesConfig(run, config);
  if (
    canonicalSha256(config) !== manifest.configHash ||
    canonicalSha256(run) !== manifest.canonicalRunHash ||
    manifest.runId !== run.id ||
    manifest.evidenceMode !== config.evidenceMode ||
    manifest.status !== run.status ||
    manifest.comparisonInvalidatingHash !==
      config.comparisonInvalidatingHash ||
    manifest.complete !==
      (run.status === "approved" || run.status === "rejected") ||
    run.executions.map(({ id }) => id).join("\n") !==
      manifest.attemptIds.join("\n") ||
    run.errors.map(({ id }) => id).join("\n") !==
      manifest.errorIds.join("\n") ||
    canonicalizeJson(attemptArtifacts) !== canonicalizeJson(run.executions) ||
    canonicalizeJson(errorArtifacts) !== canonicalizeJson(run.errors)
  ) {
    throw new Error("live golden manifest does not reopen deterministically");
  }
  return { manifest, config, run };
}
