import {
  PREVIOUS_CONTRACT_VERSION,
  canonicalSha256,
  exportCanonicalGoldenRun,
  parseCompleteGoldenRun,
  type NodeExecution,
} from "../contracts";

export const GOLDEN_FIXTURE_VERSION = "0.1" as const;
export const GOLDEN_FIXTURE_ID =
  "golden-biodegradable-sensor-72h-v0.1" as const;
export const GOLDEN_FIXTURE_SHA256 =
  "f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7" as const;
export const GOLDEN_PACKET_FINGERPRINT =
  "944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e" as const;

const approvedAt = "2026-08-06T14:31:38.000Z";
const createdAt = "2026-08-06T15:00:00.000Z";
const completedAt = "2026-08-06T21:44:30.000Z";
const promptResources = {
  "clarify-and-decompose": {
    id: "clarify-decompose",
    version: "1.0.0",
    hash: "f6f926299cde5c2ccad42ba3b99eb1f508c2c77bc842750b8472e4c27d71733e",
  },
  "collect-sources": {
    id: "collect-bounded-source-packet",
    version: "1.0.0",
    hash: "98d1622f99392bdaea21a8c2cfa41deb7225e9dc84c3e2b2b69f9dae4ee7cf3f",
  },
  "extract-evidence": {
    id: "extract-grounded-evidence",
    version: "1.0.0",
    hash: "e1129746a245922b8843522d0853921b9d4b37fc3a820abc19dc5d24e75bd0d4",
  },
  "assess-entailment": {
    id: "assess-evidence-entailment",
    version: "1.0.0",
    hash: "ca4924bb6987012a9b79ef59e3cd9c50d8a44f256b34ae7c3e358a4ab03a2cc2",
  },
  "synthesize-conclusions": {
    id: "synthesize-conclusions-gaps",
    version: "1.0.0",
    hash: "4341e1f72a2d67482f23f9b42a0594c041f3ba3411a2397af638abf504e7919c",
  },
  "plan-experiment": {
    id: "design-reviewable-experiment",
    version: "1.0.0",
    hash: "efde2b067e463e9ee6bced4de57c002d1d325677a5a69eeb21f99b35b5ca3941",
  },
  "review-experiment": {
    id: "adversarial-experiment-review",
    version: "1.0.0",
    hash: "654c5cf4ef90eeffe433eee2f3eb0b7052114d006561a0918aa7fc41e5cb7a52",
  },
  "revise-experiment": {
    id: "selective-experiment-revision",
    version: "1.0.0",
    hash: "10f550071dd53d841ca821d98df81a3f227d56206acc2cb8b94266f1af3df28f",
  },
} as const;
const excerptHashes = {
  "gf-source-01":
    "9c2819492aebf688f659453d7aecbe2c797ffc410d4caae1f3ec15cf193c7050",
  "gf-source-02":
    "26637262fbf4de761f483a56d4905b3db0cfb574e63e4f9bebff64c75a9ce8be",
  "gf-source-03":
    "dc7ee32cfbcb25a1b9383eba4f9bf6954ae58ddbf447c5caea44f0bc01033d42",
  "gf-source-04":
    "b832e77f36e948d20835ffcfb9325d30d0cdab4d51047c665e2e0e931af3ae07",
  "gf-source-05":
    "caa79bef324cac532c50dababd87e6571b9fe6d1898773aac0eab59cd362f6f8",
  "gf-source-06":
    "4e97cdbca2eb8851e6dea80008515f6fd3b74215af36b992c70f090a82c6838e",
  "gf-source-07":
    "60dfe7d5fad5d2a834f56fd6b67005964242ba345de956ba1b2278ab26328ca9",
} as const;

const chunks = [
  {
    id: "gf-chunk-01",
    sourceId: "gf-source-01",
    text: "After 1 h of discharge (and the additional power capability measurements), performance significantly decreases due to drying of the paper substrate.",
    location:
      "Results and discussion → Battery performance, paragraph beginning “After 1 h of discharge”",
    contentHash: excerptHashes["gf-source-01"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-02",
    sourceId: "gf-source-02",
    text: "Under ambient conditions, mechanically and electrically unloaded batteries could sustain a voltage above 1.5 V for 77 h.",
    location:
      "section 7.1, Biodegradable Batteries, paragraph discussing Karami-Mosammam et al.",
    contentHash: excerptHashes["gf-source-02"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-03",
    sourceId: "gf-source-03",
    text: "PCL-coated Mg/Fe batteries discharged in PBS achieved an average discharge power and lifetime of approximately 30 µW and 100 h, respectively.",
    location:
      "Results and discussion → PCL-coated Mg/Fe full-cells, paragraph beginning “The discharge performance”",
    contentHash: excerptHashes["gf-source-03"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-04",
    sourceId: "gf-source-04",
    text: "Our sensors and the fabrication techniques employed, such as dip and spray coating, provide a biodegradable, low cost, and highly reproducible device.",
    location:
      "abstract, paragraph beginning “Flexible and thin-film humidity sensors…”",
    contentHash: excerptHashes["gf-source-04"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-05",
    sourceId: "gf-source-05",
    text: "Spent, used, or “dead” batteries can still cause significant tissue damage if swallowed and should be properly discarded.",
    location:
      "section 1.1, Epidemiology, paragraph beginning “New button batteries are more likely…”",
    contentHash: excerptHashes["gf-source-05"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-06",
    sourceId: "gf-source-06",
    text: "In this pursuit, the first study explores combining the SLAM process with 3D printing to develop a miniaturized, biodegradable, chipless sensor for soil moisture monitoring.",
    location:
      "DataCite Abstract at https://api.datacite.org/dois/10.25394/pgs.23496710.v1; primary repository record https://api.figshare.com/v2/articles/23496710",
    contentHash: excerptHashes["gf-source-06"],
    displayPermission: "allowed" as const,
  },
  {
    id: "gf-chunk-07",
    sourceId: "gf-source-07",
    text: "These materials are required to satisfy designated dissolution rates, electrical/mechanical properties, and other demands depending on the desired application of the device.",
    location: "section 2, Transient Materials, introductory paragraph",
    contentHash: excerptHashes["gf-source-07"],
    displayPermission: "allowed" as const,
  },
];

function sourceChunkLocation(sourceId: string): string {
  const chunk = chunks.find((candidate) => candidate.sourceId === sourceId);
  if (chunk === undefined) {
    throw new Error(`golden source ${sourceId} is missing its immutable chunk`);
  }
  return chunk.location;
}

const allowedRights = {
  mayStore: "allowed" as const,
  mayDisplay: "allowed" as const,
  maySendToModel: "allowed" as const,
  basis:
    "CC BY 4.0 https://creativecommons.org/licenses/by/4.0/; attribution required; human-approved excerpt reproduced without textual changes; provenance retained",
  checkedAt: approvedAt,
};

const resolvedDoi = {
  syntax: "valid" as const,
  resolution: "resolved" as const,
  registrationAgency: "Crossref",
  checkedAt: approvedAt,
};

const sources = [
  {
    id: "gf-source-01",
    originalInput:
      "doi:10.1038/s41598-022-15900-5 | supplied title: Biodegradable coin cell lasts 72 hours",
    canonicalDoi: "10.1038/s41598-022-15900-5",
    canonicalUrl: "https://doi.org/10.1038/s41598-022-15900-5",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title: "Water activated disposable paper battery",
      authors: ["Alexandre Poulin", "Xavier Aeby", "Gustav Nyström"],
      year: 2022,
      venue: "Scientific Reports",
      studyType: "primary proof-of-concept battery study",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "full_text" as const,
      provider: "approved source packet",
      version: "publisher article",
      location: sourceChunkLocation("gf-source-01"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-01"],
    metadataVerification: {
      status: "mismatch" as const,
      method: "fixture comparison against canonical publisher metadata",
      checkedAt: approvedAt,
      fieldDiffs: [
        {
          field: "title",
          expected: "Water activated disposable paper battery",
          observed: "Biodegradable coin cell lasts 72 hours",
        },
      ],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "The deliberate supplied-title mismatch is not an entailment result.",
    ],
  },
  {
    id: "gf-source-02",
    originalInput: "doi:10.1002/advs.202307232",
    canonicalDoi: "10.1002/advs.202307232",
    canonicalUrl: "https://doi.org/10.1002/advs.202307232",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title:
        "Design and Development of Transient Sensing Devices for Healthcare Applications",
      authors: ["Željko Janićijević et al."],
      year: 2024,
      venue: "Advanced Science",
      studyType: "critical review",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "full_text" as const,
      provider: "approved source packet",
      version: "PMC full-text record",
      location: sourceChunkLocation("gf-source-02"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-02"],
    metadataVerification: {
      status: "match" as const,
      method: "fixture comparison against approved canonical metadata",
      checkedAt: approvedAt,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "Publisher retrieval returned HTTP 403; DOI existence and archival full text remain separate facts.",
    ],
  },
  {
    id: "gf-source-03",
    originalInput: "doi:10.1038/micronano.2015.24",
    canonicalDoi: "10.1038/micronano.2015.24",
    canonicalUrl: "https://doi.org/10.1038/micronano.2015.24",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title:
        "Biodegradable magnesium/iron batteries with polycaprolactone encapsulation: A microfabricated power source for transient implantable devices",
      authors: [
        "Melissa Tsang",
        "Andac Armutlulu",
        "Adam W. Martinez",
        "Sue Ann Bidstrup Allen",
        "Mark G. Allen",
      ],
      year: 2015,
      venue: "Microsystems & Nanoengineering",
      studyType: "primary battery study",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "full_text" as const,
      provider: "approved source packet",
      version: "publisher article",
      location: sourceChunkLocation("gf-source-03"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-03"],
    metadataVerification: {
      status: "match" as const,
      method: "fixture comparison against approved canonical metadata",
      checkedAt: approvedAt,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "The cited physiological-electrolyte test does not establish environmental-sensor application fit.",
    ],
  },
  {
    id: "gf-source-04",
    originalInput: "doi:10.3389/felec.2022.838472",
    canonicalDoi: "10.3389/felec.2022.838472",
    canonicalUrl: "https://doi.org/10.3389/felec.2022.838472",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title:
        "Paper and Salt: Biodegradable NaCl-Based Humidity Sensors for Sustainable Electronics",
      authors: ["Aniello Falco et al."],
      year: 2022,
      venue: "Frontiers in Electronics",
      studyType: "primary sensor study",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "abstract" as const,
      provider: "approved source packet",
      version: "publisher abstract",
      location: sourceChunkLocation("gf-source-04"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-04"],
    metadataVerification: {
      status: "match" as const,
      method: "fixture comparison against approved canonical metadata",
      checkedAt: approvedAt,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "Sensor biodegradability does not prove battery integration or loaded 72-hour operation.",
    ],
  },
  {
    id: "gf-source-05",
    originalInput: "doi:10.3390/children12121678",
    canonicalDoi: "10.3390/children12121678",
    canonicalUrl: "https://doi.org/10.3390/children12121678",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title:
        "A Review of Button Battery Ingestions in Children—Diagnosis and Management",
      authors: ["John Amodio", "Michelle Lightman"],
      year: 2025,
      venue: "Children",
      studyType: "clinical review",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "full_text" as const,
      provider: "approved source packet",
      version: "PMC full-text record",
      location: sourceChunkLocation("gf-source-05"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-05"],
    metadataVerification: {
      status: "match" as const,
      method: "fixture comparison against approved canonical metadata",
      checkedAt: approvedAt,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "The excerpt does not establish comparative lifecycle impact or a universal packaged-sensor exposure.",
    ],
  },
  {
    id: "gf-source-06",
    originalInput: "doi:10.25394/pgs.23496710.v1",
    canonicalDoi: "10.25394/pgs.23496710.v1",
    canonicalUrl: "https://doi.org/10.25394/pgs.23496710.v1",
    doiResolution: {
      syntax: "valid" as const,
      resolution: "resolved" as const,
      registrationAgency: "DataCite",
      checkedAt: "2026-08-06T21:42:38.499Z",
    },
    bibliographicMetadata: {
      title:
        "SCALABLE LASER ASSISTED MANUFACTURING TECHNIQUES FOR LOW-COST MULTI-FUNCTIONAL PASSIVE WIRELESS CHIPLESS SENSORS.pdf",
      authors: ["Sarath Gopalakrishnan"],
      year: 2023,
      venue: "Purdue University Graduate School",
      studyType: "doctoral dissertation",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "abstract" as const,
      provider: "DataCite REST API",
      version: "DataCite record updated 2026-03-17T11:53:23.000Z",
      location: sourceChunkLocation("gf-source-06"),
      retrievedAt: "2026-08-06T21:42:38.499Z",
    },
    rights: {
      mayStore: "allowed" as const,
      mayDisplay: "allowed" as const,
      maySendToModel: "allowed" as const,
      basis:
        "Official DataCite and repository records report CC BY 4.0 https://creativecommons.org/licenses/by/4.0/; attribution required to Sarath Gopalakrishnan; fixture human-rights decision allows the exact abstract excerpt reproduced without textual changes for store/display/model use; provenance retained; not legal clearance",
      checkedAt: "2026-08-06T21:42:38.499Z",
    },
    contentHash: excerptHashes["gf-source-06"],
    metadataVerification: {
      status: "match" as const,
      method:
        "DOI Foundation RA https://doi.org/doiRA/10.25394/pgs.23496710.v1 and DataCite https://api.datacite.org/dois/10.25394/pgs.23496710.v1",
      checkedAt: "2026-08-06T21:42:38.499Z",
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "A biodegradable soil-moisture sensor does not establish battery integration, loaded runtime, or disposal safety.",
      "The deposited license and metadata were verified live; this run's rights approval remains fixture evidence and is not legal clearance.",
    ],
  },
  {
    id: "gf-source-07",
    originalInput: "doi:10.3390/bios12110952",
    canonicalDoi: "10.3390/bios12110952",
    canonicalUrl: "https://doi.org/10.3390/bios12110952",
    doiResolution: resolvedDoi,
    bibliographicMetadata: {
      title:
        "Micro-/Nano-Structured Biodegradable Pressure Sensors for Biomedical Applications",
      authors: [
        "Yoo-Kyum Shin",
        "Yujin Shin",
        "Jung Woo Lee",
        "Min-Ho Seo",
      ],
      year: 2022,
      venue: "Biosensors",
      studyType: "review",
    },
    access: {
      origin: "curated_fixture" as const,
      contentScope: "full_text" as const,
      provider: "approved source packet",
      version: "PMC full-text record",
      location: sourceChunkLocation("gf-source-07"),
      retrievedAt: approvedAt,
    },
    rights: allowedRights,
    contentHash: excerptHashes["gf-source-07"],
    metadataVerification: {
      status: "match" as const,
      method: "fixture comparison against approved canonical metadata",
      checkedAt: approvedAt,
      fieldDiffs: [],
    },
    integrityNotices: [],
    mergedSourceIds: [],
    warnings: [
      "Application-specific degradation, electrical, and mechanical requirements remain unmeasured.",
    ],
  },
];

const scopeDecision = {
  id: "gf-decision-scope",
  checkpoint: "scope" as const,
  optionsShown: ["approve", "edit", "reject"],
  decision: "approve",
  edits: [
    "Bound the decision to this approved packet and a non-hazardous reviewable experiment proposal.",
  ],
  decidedAt: "2026-08-06T15:01:00.000Z",
  unresolvedObjections: [],
};

const freezeDecision = {
  id: "gf-decision-packet-freeze",
  checkpoint: "packet_freeze" as const,
  optionsShown: ["approve", "remove source", "reject"],
  decision: "approve",
  edits: [
    "Fixture reviewer added the DataCite-registered CC BY 4.0 abstract excerpt after checking attribution and bounded use.",
  ],
  decidedAt: "2026-08-06T21:43:00.000Z",
  unresolvedObjections: [],
};

const packetPayload = {
  schemaVersion: PREVIOUS_CONTRACT_VERSION,
  packetVersion: 1,
  sourceHashes: sources.map(({ contentHash }) => contentHash).sort(),
  chunkHashes: chunks.map(({ contentHash }) => contentHash).sort(),
  frozenAt: "2026-08-06T21:43:00.000Z",
  freezeDecision,
};
const packet = {
  ...packetPayload,
  fingerprint: canonicalSha256(packetPayload),
};

const baseExecution = {
  evidenceMode: "fixture" as const,
  requestedProvider: "fixture",
  returnedProvider: "fixture",
  requestedModelId: "fixture-primary-v1",
  returnedModelId: "fixture-primary-v1",
  requestedDeveloperFamily: "fixture-primary-family",
  returnedDeveloperFamily: "fixture-primary-family",
  requestedBaseFamily: "fixture-primary-base",
  returnedBaseFamily: "fixture-primary-base",
  returnedReasoningMode: "disabled" as const,
  promptVersion: "1.0.0",
  structuredOutputSchemaVersion: PREVIOUS_CONTRACT_VERSION,
  generationSettings: {
    temperature: 0,
    maxOutputTokens: 4096,
    topP: null,
    seed: null,
    reasoningMode: "provider_default" as const,
    reasoningBudgetTokens: null,
  },
  clientLatencyMs: 4,
  providerTiming: {
    queueMs: null,
    promptMs: null,
    completionMs: null,
    totalMs: null,
  },
  finishReason: "stop",
  refusal: { refused: false, reason: null },
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
  },
  pricing: {
    currency: "USD",
    inputPerMillionTokens: null,
    outputPerMillionTokens: null,
    estimatedCost: null,
    snapshotDate: null,
  },
  validation: { valid: true, issues: [] as string[] },
  errorIds: [] as string[],
  retryOfExecutionId: null,
  fallbackFromExecutionId: null,
  codeVersion: "golden-fixture-v0.1",
};

function execution(
  value: Pick<
    NodeExecution,
    | "id"
    | "nodeId"
    | "attempt"
    | "status"
    | "inputRefs"
    | "outputRefs"
    | "promptId"
    | "promptHash"
    | "startedAt"
    | "endedAt"
    | "requestIds"
  > &
    Partial<NodeExecution>,
): NodeExecution {
  return {
    ...baseExecution,
    ...value,
  };
}

const executions: NodeExecution[] = [
  execution({
    id: "gf-execution-decompose-1",
    nodeId: "clarify-and-decompose",
    attempt: 1,
    status: "succeeded",
    inputRefs: [GOLDEN_FIXTURE_ID],
    outputRefs: ["gf-claim-duration", "gf-claim-integration", "gf-claim-hazard"],
    promptId: promptResources["clarify-and-decompose"].id,
    promptVersion: promptResources["clarify-and-decompose"].version,
    promptHash: promptResources["clarify-and-decompose"].hash,
    startedAt: "2026-08-06T15:00:01.000Z",
    endedAt: "2026-08-06T15:00:01.004Z",
    requestIds: {
      clientRequestId: "gf-request-decompose-1",
      providerRequestId: "gf-provider-decompose-1",
      responseId: "gf-response-decompose-1",
    },
  }),
  execution({
    id: "gf-execution-collect-1",
    nodeId: "collect-sources",
    attempt: 1,
    status: "failed",
    inputRefs: [GOLDEN_FIXTURE_ID],
    outputRefs: [],
    promptId: promptResources["collect-sources"].id,
    promptVersion: promptResources["collect-sources"].version,
    promptHash: promptResources["collect-sources"].hash,
    startedAt: "2026-08-06T15:02:10.000Z",
    endedAt: "2026-08-06T15:02:10.004Z",
    requestIds: {
      clientRequestId: "gf-request-collect-1",
      providerRequestId: "gf-provider-doi-resolver-1",
      responseId: "gf-response-doi-resolver-1",
    },
    requestedModelId: "fixture-deterministic-doi-resolver-v1",
    returnedModelId: "fixture-deterministic-doi-resolver-v1",
    requestedDeveloperFamily: "fixture-deterministic-family",
    returnedDeveloperFamily: "fixture-deterministic-family",
    requestedBaseFamily: "fixture-deterministic-base",
    returnedBaseFamily: "fixture-deterministic-base",
    validation: {
      valid: false,
      issues: ["DOI does not exist; no source or passage was produced"],
    },
    errorIds: ["gf-error-source-08"],
  }),
  execution({
    id: "gf-execution-extract-1",
    nodeId: "extract-evidence",
    attempt: 1,
    status: "succeeded",
    inputRefs: chunks.map(({ id }) => id),
    outputRefs: [
      "gf-evidence-01",
      "gf-evidence-02",
      "gf-evidence-03",
      "gf-evidence-04",
      "gf-evidence-05",
      "gf-evidence-06",
      "gf-evidence-07",
    ],
    promptId: promptResources["extract-evidence"].id,
    promptVersion: promptResources["extract-evidence"].version,
    promptHash: promptResources["extract-evidence"].hash,
    startedAt: "2026-08-06T21:43:10.000Z",
    endedAt: "2026-08-06T21:43:10.004Z",
    requestIds: {
      clientRequestId: "gf-request-evidence-1",
      providerRequestId: "gf-provider-evidence-1",
      responseId: "gf-response-evidence-1",
    },
  }),
  execution({
    id: "gf-execution-assess-1",
    nodeId: "assess-entailment",
    attempt: 1,
    status: "succeeded",
    inputRefs: [
      "gf-evidence-01",
      "gf-evidence-02",
      "gf-evidence-03",
      "gf-evidence-04",
      "gf-evidence-05",
      "gf-evidence-06",
      "gf-evidence-07",
    ],
    outputRefs: [
      "gf-evidence-01",
      "gf-evidence-02",
      "gf-evidence-03",
      "gf-evidence-04",
      "gf-evidence-05",
      "gf-evidence-06",
      "gf-evidence-07",
    ],
    promptId: promptResources["assess-entailment"].id,
    promptVersion: promptResources["assess-entailment"].version,
    promptHash: promptResources["assess-entailment"].hash,
    startedAt: "2026-08-06T21:43:20.000Z",
    endedAt: "2026-08-06T21:43:20.004Z",
    requestIds: {
      clientRequestId: "gf-request-assess-1",
      providerRequestId: "gf-provider-assess-1",
      responseId: "gf-response-assess-1",
    },
  }),
  execution({
    id: "gf-execution-synthesis-1",
    nodeId: "synthesize-conclusions",
    attempt: 1,
    status: "succeeded",
    inputRefs: [
      "gf-evidence-01",
      "gf-evidence-02",
      "gf-evidence-03",
      "gf-evidence-04",
      "gf-evidence-05",
      "gf-evidence-06",
      "gf-evidence-07",
    ],
    outputRefs: [
      "gf-claim-duration",
      "gf-claim-integration",
      "gf-claim-hazard",
      "gf-gap-loaded-duration",
    ],
    promptId: promptResources["synthesize-conclusions"].id,
    promptVersion: promptResources["synthesize-conclusions"].version,
    promptHash: promptResources["synthesize-conclusions"].hash,
    startedAt: "2026-08-06T21:43:30.000Z",
    endedAt: "2026-08-06T21:43:30.004Z",
    requestIds: {
      clientRequestId: "gf-request-synthesis-1",
      providerRequestId: "gf-provider-synthesis-1",
      responseId: "gf-response-synthesis-1",
    },
  }),
  execution({
    id: "gf-execution-plan-1",
    nodeId: "plan-experiment",
    attempt: 1,
    status: "failed",
    inputRefs: ["gf-gap-loaded-duration"],
    outputRefs: [],
    promptId: promptResources["plan-experiment"].id,
    promptVersion: promptResources["plan-experiment"].version,
    promptHash: promptResources["plan-experiment"].hash,
    startedAt: "2026-08-06T21:43:40.000Z",
    endedAt: "2026-08-06T21:43:40.004Z",
    requestIds: {
      clientRequestId: "gf-request-plan-1",
      providerRequestId: "gf-provider-plan-1",
      responseId: "gf-response-plan-1",
    },
    validation: {
      valid: false,
      issues: ["sampleSizeBasis was omitted"],
    },
    errorIds: ["gf-error-plan-1"],
  }),
  execution({
    id: "gf-execution-plan-2",
    nodeId: "plan-experiment",
    attempt: 2,
    status: "succeeded",
    inputRefs: ["gf-gap-loaded-duration"],
    outputRefs: ["gf-gap-loaded-duration"],
    promptId: promptResources["plan-experiment"].id,
    promptVersion: promptResources["plan-experiment"].version,
    promptHash: promptResources["plan-experiment"].hash,
    startedAt: "2026-08-06T21:43:40.010Z",
    endedAt: "2026-08-06T21:43:40.014Z",
    requestIds: {
      clientRequestId: "gf-request-plan-2",
      providerRequestId: "gf-provider-plan-2",
      responseId: "gf-response-plan-2",
    },
    retryOfExecutionId: "gf-execution-plan-1",
  }),
  execution({
    id: "gf-execution-review-failure-1",
    nodeId: "review-experiment",
    attempt: 1,
    status: "failed",
    inputRefs: ["gf-gap-loaded-duration", "gf-evidence-01", "gf-evidence-03"],
    outputRefs: [],
    promptId: promptResources["review-experiment"].id,
    promptVersion: promptResources["review-experiment"].version,
    promptHash: promptResources["review-experiment"].hash,
    startedAt: "2026-08-06T21:43:50.000Z",
    endedAt: "2026-08-06T21:43:50.004Z",
    requestIds: {
      clientRequestId: "gf-request-review-failure-1",
      providerRequestId: null,
      responseId: null,
    },
    requestedModelId: "fixture-reviewer-v1",
    returnedProvider: null,
    returnedModelId: null,
    requestedDeveloperFamily: "fixture-reviewer-family",
    returnedDeveloperFamily: null,
    requestedBaseFamily: "fixture-reviewer-base",
    returnedBaseFamily: null,
    returnedReasoningMode: null,
    generationSettings: {
      ...baseExecution.generationSettings,
      reasoningMode: "disabled",
    },
    clientLatencyMs: 4,
    providerTiming: {
      queueMs: null,
      promptMs: null,
      completionMs: null,
      totalMs: null,
    },
    finishReason: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
    validation: {
      valid: false,
      issues: ["scripted fixture provider transport failure"],
    },
    errorIds: ["gf-error-review-1"],
  }),
  execution({
    id: "gf-execution-review-1",
    nodeId: "review-experiment",
    attempt: 2,
    status: "succeeded",
    inputRefs: ["gf-gap-loaded-duration", "gf-evidence-01", "gf-evidence-03"],
    outputRefs: ["gf-objection-calibration", "gf-objection-degradation"],
    promptId: promptResources["review-experiment"].id,
    promptVersion: promptResources["review-experiment"].version,
    promptHash: promptResources["review-experiment"].hash,
    startedAt: "2026-08-06T21:43:50.010Z",
    endedAt: "2026-08-06T21:43:50.014Z",
    requestIds: {
      clientRequestId: "gf-request-review-1",
      providerRequestId: "gf-provider-review-1",
      responseId: "gf-response-review-1",
    },
    requestedModelId: "fixture-reviewer-v1",
    returnedModelId: "fixture-reviewer-v1",
    requestedDeveloperFamily: "fixture-reviewer-family",
    returnedDeveloperFamily: "fixture-reviewer-family",
    requestedBaseFamily: "fixture-reviewer-base",
    returnedBaseFamily: "fixture-reviewer-base",
    generationSettings: {
      ...baseExecution.generationSettings,
      reasoningMode: "disabled",
    },
    retryOfExecutionId: "gf-execution-review-failure-1",
  }),
  execution({
    id: "gf-execution-revision-1",
    nodeId: "revise-experiment",
    attempt: 1,
    status: "succeeded",
    inputRefs: [
      "gf-objection-calibration",
      "gf-objection-degradation",
      "gf-decision-objections",
    ],
    outputRefs: [
      "gf-objection-calibration",
      "gf-objection-degradation",
    ],
    promptId: promptResources["revise-experiment"].id,
    promptVersion: promptResources["revise-experiment"].version,
    promptHash: promptResources["revise-experiment"].hash,
    startedAt: "2026-08-06T21:44:10.000Z",
    endedAt: "2026-08-06T21:44:10.004Z",
    requestIds: {
      clientRequestId: "gf-request-revision-1",
      providerRequestId: "gf-provider-revision-1",
      responseId: "gf-response-revision-1",
    },
  }),
];

function evidenceCard(value: {
  id: string;
  subclaimId: string;
  chunkIndex: number;
  extractedResult: string;
  settingAndSample: string;
  studyType: string;
  limitation: string;
  relationship: "supports" | "contradicts" | "unresolved";
  entailment:
    | "full_support"
    | "partial_support"
    | "contradicts"
    | "insufficient"
    | "unclear";
  rationale: string;
  warning: string | null;
}) {
  const chunk = chunks[value.chunkIndex];
  return {
    id: value.id,
    subclaimId: value.subclaimId,
    sourceChunkId: chunk.id,
    excerpt: chunk.text,
    extractedResult: value.extractedResult,
    settingAndSample: value.settingAndSample,
    studyType: value.studyType,
    limitation: value.limitation,
    relationship: value.relationship,
    deterministicVerification: {
      method: "exact UTF-8 hash and unique literal-substring check",
      status: "verified" as const,
      checkedAt: "2026-08-06T21:43:21.000Z",
      details: `Exact excerpt hash ${chunk.contentHash} matched its immutable source chunk.`,
    },
    modelAssessment: {
      entailment: value.entailment,
      rationale: value.rationale,
      provider: "fixture",
      requestedModelId: "fixture-primary-v1",
      returnedModelId: "fixture-primary-v1",
      promptId: promptResources["assess-entailment"].id,
      promptVersion: promptResources["assess-entailment"].version,
      executionId: "gf-execution-assess-1",
    },
    conclusionStrengthWarning: value.warning,
    humanReview: {
      status: "confirmed" as const,
      reason:
        "Fixture reviewer confirmed the literal excerpt and bounded relationship without treating metadata as entailment proof.",
      reviewedAt: "2026-08-06T21:43:35.000Z",
      reviewerId: "fixture-human-reviewer",
    },
    extractionIssues: [],
  };
}

const evidenceCards = [
  evidenceCard({
    id: "gf-evidence-01",
    subclaimId: "gf-claim-duration",
    chunkIndex: 0,
    extractedResult: "Performance decreased after one hour as the paper dried.",
    settingAndSample: "Water-activated disposable paper-battery demonstration",
    studyType: "primary proof-of-concept battery study",
    limitation: "Does not test every hydration strategy or sensor duty cycle.",
    relationship: "contradicts",
    entailment: "contradicts",
    rationale:
      "The excerpt contradicts an unqualified continuous 72-hour claim for this paper-battery configuration.",
    warning:
      "Do not generalize one drying-limited configuration to all biodegradable batteries.",
  }),
  evidenceCard({
    id: "gf-evidence-02",
    subclaimId: "gf-claim-duration",
    chunkIndex: 1,
    extractedResult: "An unloaded battery retained voltage above 1.5 V for 77 hours.",
    settingAndSample: "Ambient, mechanically and electrically unloaded condition",
    studyType: "critical review",
    limitation: "No electrical load or environmental-sensor duty cycle was tested.",
    relationship: "unresolved",
    entailment: "insufficient",
    rationale:
      "An unloaded duration does not distinguish whether a loaded sensor can operate for 72 hours.",
    warning: "Voltage retention without load is not loaded runtime evidence.",
  }),
  evidenceCard({
    id: "gf-evidence-03",
    subclaimId: "gf-claim-duration",
    chunkIndex: 2,
    extractedResult: "A PCL-coated Mg/Fe battery delivered about 30 µW for 100 hours.",
    settingAndSample: "PBS electrolyte in a transient implantable-device battery study",
    studyType: "primary battery study",
    limitation:
      "Voltage, duty cycle, electrolyte, packaging, and safety differ from the proposed environmental sensor.",
    relationship: "supports",
    entailment: "partial_support",
    rationale:
      "The excerpt supports configuration-specific duration feasibility but not the target application.",
    warning:
      "Physiological-electrolyte duration does not establish environmental-sensor replacement.",
  }),
  evidenceCard({
    id: "gf-evidence-04",
    subclaimId: "gf-claim-integration",
    chunkIndex: 3,
    extractedResult: "The reported humidity sensor and fabrication techniques were described as biodegradable.",
    settingAndSample: "NaCl-based humidity-sensor demonstration",
    studyType: "primary sensor study",
    limitation: "Battery integration and loaded 72-hour operation were not tested.",
    relationship: "supports",
    entailment: "partial_support",
    rationale:
      "The excerpt supports biodegradable environmental-sensor feasibility only.",
    warning:
      "A biodegradable sensor component is not proof of an integrated biodegradable power system.",
  }),
  evidenceCard({
    id: "gf-evidence-05",
    subclaimId: "gf-claim-hazard",
    chunkIndex: 4,
    extractedResult: "Spent button batteries can retain an ingestion hazard.",
    settingAndSample: "Clinical review of button-battery ingestion",
    studyType: "clinical review",
    limitation:
      "Does not compare lifecycle impact or show equal exposure for every packaged sensor.",
    relationship: "supports",
    entailment: "full_support",
    rationale:
      "The excerpt directly supports the bounded residual-ingestion-hazard claim.",
    warning:
      "Do not turn the cited disposal recommendation into a universal lifecycle verdict.",
  }),
  evidenceCard({
    id: "gf-evidence-06",
    subclaimId: "gf-claim-integration",
    chunkIndex: 5,
    extractedResult:
      "A dissertation study explored a biodegradable chipless sensor for soil-moisture monitoring.",
    settingAndSample: "Dissertation study of laser-assisted sensor manufacturing",
    studyType: "doctoral dissertation",
    limitation:
      "The excerpt does not test battery integration, the target load profile, or disposal safety.",
    relationship: "supports",
    entailment: "partial_support",
    rationale:
      "The excerpt supports biodegradable environmental-sensor feasibility, not the complete power-system replacement claim.",
    warning:
      "A biodegradable sensor does not establish a biodegradable battery or loaded 72-hour operation.",
  }),
  evidenceCard({
    id: "gf-evidence-07",
    subclaimId: "gf-claim-integration",
    chunkIndex: 6,
    extractedResult: "Application-specific dissolution, electrical, and mechanical requirements must be satisfied.",
    settingAndSample: "Review of biodegradable pressure-sensor materials",
    studyType: "review",
    limitation: "The target sensor's application-specific requirements remain unmeasured.",
    relationship: "unresolved",
    entailment: "insufficient",
    rationale:
      "The excerpt identifies requirements but does not show the proposed replacement satisfies them.",
    warning:
      "Biodegradability alone does not establish application fit or safe degradation.",
  }),
];

const runInput = {
  schemaVersion: PREVIOUS_CONTRACT_VERSION,
  id: GOLDEN_FIXTURE_ID,
  status: "approved" as const,
  evidenceMode: "fixture" as const,
  createdAt,
  updatedAt: completedAt,
  intake: {
    originalQuestion:
      "For a single-use 72-hour environmental sensor, can a biodegradable battery replace a lithium coin cell?",
    intendedApplication:
      "A single-use environmental humidity sensor operating for 72 hours",
    populationOrGeography: "Bounded laboratory prototype; no geography claim",
    timeHorizon: "72 hours of loaded operation",
    availableMaterialsOrBudget:
      "Rights-approved seven-excerpt packet and non-hazardous bench-test planning only",
    desiredDepth: "Evidence audit plus one reviewable experiment proposal",
    constraints: [
      "Use only the human-approved source packet.",
      "Keep source existence, metadata, model entailment, and human review separate.",
      "Do not claim factual truth, live-provider evidence, lifecycle superiority, cost parity, or safe degradation.",
    ],
    unansweredClarifications: [
      "Target load profile and voltage range",
      "Acceptable degradation products and disposal environment",
      "Fair commercial coin-cell comparator specification",
    ],
  },
  claims: [
    {
      id: "gf-claim-duration",
      statement:
        "A biodegradable battery can power the target environmental sensor under its loaded duty cycle for 72 hours.",
      operationalDefinition:
        "The preregistered sensor load completes 72 hours without crossing voltage, data-loss, or safety failure thresholds.",
      category: "duration_and_power",
      parentClaimId: null,
      scopeConstraints: [
        "Target load and environment only",
        "No extrapolation from unloaded voltage retention",
      ],
      disposition: "approved" as const,
      rationale: "Loaded duration is necessary to justify replacing the coin cell.",
    },
    {
      id: "gf-claim-integration",
      statement:
        "The biodegradable power system is compatible with the target sensor and intended disposal environment.",
      operationalDefinition:
        "The integrated prototype meets electrical, mechanical, and predefined degradation-safety criteria.",
      category: "application_fit",
      parentClaimId: null,
      scopeConstraints: [
        "No claim of universal biodegradability",
        "Qualified safety review required",
      ],
      disposition: "approved" as const,
      rationale: "Component biodegradability alone cannot establish system fit.",
    },
    {
      id: "gf-claim-hazard",
      statement:
        "Even spent button cells can retain an ingestion hazard for which the cited authors recommend proper disposal.",
      operationalDefinition:
        "The approved passage explicitly reports residual ingestion harm and a disposal recommendation.",
      category: "bounded_hazard",
      parentClaimId: null,
      scopeConstraints: [
        "No universal packaged-sensor exposure claim",
        "No comparative lifecycle conclusion",
      ],
      disposition: "approved" as const,
      rationale:
        "This bounded comparator hazard is relevant without deciding overall replacement.",
    },
  ],
  scopeDecision,
  packet,
  sources,
  chunks,
  evidenceCards,
  conclusions: [
    {
      subclaimId: "gf-claim-duration",
      strength: "conflicting" as const,
      conclusion:
        "The approved packet contains configuration-specific duration support and a drying-limited contradiction, but it does not establish loaded 72-hour operation for the target sensor.",
      supportingEvidenceCardIds: ["gf-evidence-02", "gf-evidence-03"],
      contradictingEvidenceCardIds: ["gf-evidence-01"],
      disagreementSummary:
        "Reported duration depends on load, electrolyte, packaging, and hydration conditions.",
      limitations: [
        "The 77-hour result was unloaded.",
        "No excerpt tests the target sensor load profile.",
      ],
      changeEvidence: [
        "A preregistered loaded comparison against a specified coin cell",
      ],
      overclaimingWarnings: [
        "Do not infer application replacement from voltage retention or a different electrolyte.",
      ],
      humanReviewStatus: "confirmed" as const,
    },
    {
      subclaimId: "gf-claim-integration",
      strength: "insufficient" as const,
      conclusion:
        "Biodegradable sensor components are feasible, while battery integration and application-specific degradation, electrical, and mechanical requirements remain unresolved.",
      supportingEvidenceCardIds: [
        "gf-evidence-04",
        "gf-evidence-06",
        "gf-evidence-07",
      ],
      contradictingEvidenceCardIds: [],
      disagreementSummary: null,
      limitations: [
        "No integrated target-system test",
        "No qualified degradation-product assessment",
      ],
      changeEvidence: [
        "Integrated prototype measurements and qualified material review",
      ],
      overclaimingWarnings: [
        "Biodegradable component evidence is not integrated-system evidence.",
      ],
      humanReviewStatus: "confirmed" as const,
    },
    {
      subclaimId: "gf-claim-hazard",
      strength: "moderate" as const,
      conclusion:
        "The approved excerpt supports the bounded statement that spent button batteries can retain an ingestion hazard and should be properly discarded.",
      supportingEvidenceCardIds: ["gf-evidence-05"],
      contradictingEvidenceCardIds: [],
      disagreementSummary: null,
      limitations: [
        "No lifecycle comparison",
        "No claim that every packaged sensor creates the same exposure",
      ],
      changeEvidence: ["Application-specific exposure and disposal evidence"],
      overclaimingWarnings: [
        "Do not convert the bounded hazard into a universal replacement verdict.",
      ],
      humanReviewStatus: "confirmed" as const,
    },
  ],
  researchGaps: [
    {
      id: "gf-gap-loaded-duration",
      affectedSubclaimIds: ["gf-claim-duration", "gf-claim-integration"],
      type: "short_duration" as const,
      impactRationale:
        "Without loaded 72-hour data, the central replacement decision is unsupported.",
      tractabilityRationale:
        "A non-hazardous, preregistered prototype comparison can directly measure runtime and sensor data continuity.",
      evidenceCardIds: [
        "gf-evidence-01",
        "gf-evidence-02",
        "gf-evidence-03",
        "gf-evidence-06",
        "gf-evidence-07",
      ],
      rank: 1,
      selection: "selected" as const,
    },
  ],
  selectedGapId: "gf-gap-loaded-duration",
  experiment: {
    selectedGapId: "gf-gap-loaded-duration",
    objective:
      "Compare a specified biodegradable prototype with a specified lithium coin-cell control under the same non-hazardous 72-hour sensor load profile.",
    designType: "randomized blocked bench comparison with repeated measurements",
    hypothesis:
      "The biodegradable prototype meets preregistered 72-hour voltage and data-continuity criteria without a higher failure rate than the coin-cell control.",
    nullHypothesis:
      "The biodegradable prototype fails at least one preregistered criterion or has a higher failure rate than the control.",
    experimentalOrObservationalUnit: "Independently assembled sensor-power unit",
    unitOfAnalysis: "Sensor-power unit",
    interventionOrExposure: "Biodegradable prototype power source",
    comparator: "Specified lithium coin cell",
    independentVariables: ["Power-source type", "Environmental block"],
    dependentVariables: [
      "Terminal voltage",
      "Successful sensor reads",
      "Data continuity",
      "Unit failure",
    ],
    primaryOutcomes: [
      "Proportion of units completing 72 hours without preregistered failure",
    ],
    secondaryOutcomes: [
      "Voltage trajectory",
      "Missing sensor-read count",
      "Time to failure",
    ],
    controls: [
      "Identical sensor firmware and load profile",
      "Calibrated measurement equipment",
    ],
    comparisonGroups: [
      "Biodegradable prototype",
      "Lithium coin-cell control",
    ],
    measurementValidity:
      "Calibrate voltage and current channels before each block; verify the programmed load against an independent logger.",
    allocation: {
      randomization:
        "Randomize power-source assignment within each environmental block.",
      blocking:
        "Block by temperature/humidity condition and assembly batch.",
      blinding:
        "Blind the analyst to coded power-source labels until primary metrics are computed.",
      rationale:
        "Blocking and coded analysis reduce environmental, batch, and analytic bias.",
    },
    replicationPlan:
      "Use independently assembled units; repeated reads within one unit are not independent replicates.",
    repeatedMeasurementPlan:
      "Log voltage and sensor-read status at fixed intervals for 72 hours.",
    inclusionCriteria: [
      "Passes preregistered pre-run electrical and enclosure checks",
    ],
    exclusionCriteria: [
      "Visible assembly defect documented before randomization",
    ],
    attritionPlan:
      "Retain every randomized unit in the accounting and classify post-start loss by the preregistered failure rules.",
    missingDataPlan:
      "Report missing intervals and analyze primary completion conservatively as failure unless a documented logger-only fault is independently confirmed.",
    procedure: [
      "Obtain qualified electrical and materials review before testing.",
      "Pre-register load, environment, calibration, failure, and stopping criteria.",
      "Assemble coded units using approved low-energy components.",
      "Randomize within blocks and collect automated measurements for at most 72 hours.",
      "Inspect the audit record and disclose all exclusions, missing data, and failures.",
    ],
    sampleSizeBasis:
      "Pilot first because target failure rates, variance, and a meaningful non-inferiority margin are unavailable; a statistician must set the confirmatory sample size.",
    missingPowerAssumptions: [
      "Prototype and control failure rates",
      "Voltage-trajectory variance",
      "Meaningful non-inferiority margin",
    ],
    estimand:
      "Between-group difference in the probability of completing 72 hours without a preregistered failure.",
    metrics: [
      "72-hour completion proportion",
      "Kaplan–Meier time-to-failure summary",
      "Voltage and missing-read trajectories",
    ],
    analysisPlan:
      "Summarize the pilot descriptively; do not claim non-inferiority until assumptions and confirmatory sample size are approved.",
    assumptionChecks: [
      "Measurement calibration",
      "Independent unit assembly",
      "Missingness mechanism",
      "Environmental block balance",
    ],
    confounders: [
      "Assembly batch",
      "Temperature and humidity",
      "Sensor firmware variation",
    ],
    mitigations: [
      "Blocking",
      "Identical firmware",
      "Coded analysis",
      "Pre-run calibration",
    ],
    feasibility:
      "Educational pilot only; exact prototype, comparator, and qualified supervision remain prerequisites.",
    requiredResources: [
      "Qualified reviewer",
      "Low-energy sensor units",
      "Calibrated logger",
      "Environmental monitor",
    ],
    constraints: [
      "No hazardous chemistry synthesis",
      "No autonomous real-world deployment",
      "No confirmatory claim from an underpowered pilot",
    ],
    hazards: [
      "Battery leakage or short circuit",
      "Improper disposal",
      "Unknown degradation products",
    ],
    ethics: [
      "No human or animal subjects",
      "Follow qualified electrical, materials, and waste guidance",
    ],
    qualifiedReviewRequired: true,
    stoppingCriteria: [
      "Unexpected heating, swelling, leakage, or enclosure breach",
      "Measurement equipment leaves its calibrated range",
    ],
    failureCriteria: [
      "Voltage crosses the preregistered lower bound",
      "Sensor data loss exceeds the preregistered limit",
      "Safety stopping criterion occurs",
    ],
    expectedOutcomeBranches: [
      {
        outcome: "Prototype meets pilot criteria",
        establishes:
          "Pilot feasibility under the exact tested load, environment, and prototype",
        doesNotEstablish:
          "Commercial replacement, lifecycle superiority, safe degradation, or population-wide performance",
      },
      {
        outcome: "Prototype fails pilot criteria",
        establishes:
          "The tested prototype is not ready for the target configuration",
        doesNotEstablish:
          "All biodegradable batteries are unsuitable",
      },
    ],
    externalValidityBoundary:
      "Only the exact prototype, comparator, load profile, environment, and pilot procedures reviewed here.",
    supportingEvidenceCardIds: [
      "gf-evidence-01",
      "gf-evidence-02",
      "gf-evidence-03",
      "gf-evidence-04",
      "gf-evidence-07",
    ],
  },
  experimentAbstention: null,
  review: {
    protocolVersion: "0.1",
    reviewerExecutionId: "gf-execution-review-1",
    objections: [
      {
        id: "gf-objection-calibration",
        category: "metrics" as const,
        severity: "high" as const,
        targetField: "measurementValidity",
        rationale:
          "The original plan did not require independent verification of the programmed load.",
        evidenceCardIds: ["gf-evidence-01", "gf-evidence-03"],
      },
      {
        id: "gf-objection-degradation",
        category: "ethics_safety" as const,
        severity: "critical" as const,
        targetField: "externalValidityBoundary",
        rationale:
          "The packet does not establish degradation-product safety in the intended disposal environment.",
        evidenceCardIds: ["gf-evidence-07"],
      },
    ],
  },
  objectionDispositionDecision: {
    id: "gf-decision-objections",
    checkpoint: "objection_dispositions" as const,
    optionsShown: ["approve", "request revision", "reject"],
    decision: "approve",
    edits: [
      "Accept the load-verification objection.",
      "Keep degradation-product safety unresolved pending qualified review.",
    ],
    decidedAt: "2026-08-06T21:44:00.000Z",
    unresolvedObjections: ["gf-objection-degradation"],
  },
  revision: {
    protocolVersion: "0.2",
    decisions: [
      {
        objectionId: "gf-objection-calibration",
        disposition: "accepted" as const,
        basis:
          "Human reviewer required independent load verification before the run.",
        originalValue:
          "Calibrate voltage and current channels before each block.",
        revisedValue:
          "Calibrate voltage and current channels before each block; verify the programmed load against an independent logger.",
        residualRisk: "Calibration drift during a 72-hour run remains possible.",
      },
      {
        objectionId: "gf-objection-degradation",
        disposition: "unresolved" as const,
        basis:
          "No approved degradation-product or disposal-environment evidence exists in the bounded packet.",
        originalValue:
          "The prototype may be suitable for the intended disposal environment.",
        revisedValue: null,
        residualRisk:
          "Environmental and human safety of degradation products remains unknown and blocks a real-world disposal claim.",
      },
    ],
  },
  finalDecision: {
    id: "gf-decision-final",
    checkpoint: "final" as const,
    optionsShown: ["approve", "request revision", "reject"],
    decision: "approve",
    edits: [
      "Approve only the non-hazardous educational pilot proposal.",
      "Retain qualified review and unresolved degradation-safety block.",
    ],
    decidedAt: completedAt,
    unresolvedObjections: ["gf-objection-degradation"],
  },
  executions,
  errors: [
    {
      id: "gf-error-source-08",
      kind: "missing_source" as const,
      message:
        "Supplied DOI 10.1002/open.209900999 does not exist; no source, passage, or entailment record was created.",
      nodeId: "collect-sources",
      executionId: "gf-execution-collect-1",
      retryable: false,
      occurredAt: "2026-08-06T15:02:10.004Z",
      details: {
        field: "sources[doi:10.1002/open.209900999]",
        providerCode: "DOI_NOT_FOUND",
        httpStatus: 404,
      },
    },
    {
      id: "gf-error-review-1",
      kind: "provider_failure" as const,
      message:
        "Scripted fixture provider transport failed before returning an adversarial experiment review.",
      nodeId: "review-experiment",
      executionId: "gf-execution-review-failure-1",
      retryable: true,
      occurredAt: "2026-08-06T21:43:50.004Z",
      details: {
        field: null,
        providerCode: "FIXTURE_PROVIDER_FAILURE",
        httpStatus: null,
      },
    },
    {
      id: "gf-error-plan-1",
      kind: "invalid_model_output" as const,
      message:
        "Fixture planning attempt omitted the required sample-size basis.",
      nodeId: "plan-experiment",
      executionId: "gf-execution-plan-1",
      retryable: true,
      occurredAt: "2026-08-06T21:43:40.004Z",
      details: {
        field: "experiment.sampleSizeBasis",
        providerCode: "fixture_validation_failure",
        httpStatus: null,
      },
    },
  ],
};

export function parseGoldenRunV01(input: unknown) {
  const parsed = parseCompleteGoldenRun(input);
  if (canonicalSha256(parsed) !== GOLDEN_FIXTURE_SHA256) {
    throw new Error("golden fixture does not match the reviewed canonical hash");
  }
  return parsed;
}

export const goldenRunV01 = parseGoldenRunV01(runInput);
export const computedGoldenFixtureSha256 = canonicalSha256(goldenRunV01);

export function exportGoldenRunV01(): string {
  return exportCanonicalGoldenRun(goldenRunV01);
}
