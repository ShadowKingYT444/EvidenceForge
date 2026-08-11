import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvidenceCardSchema,
  canonicalSha256,
} from "../../../src/contracts";
import {
  GOLDEN_FIXTURE_SHA256,
  GOLDEN_PACKET_FINGERPRINT,
  computedGoldenFixtureSha256,
  goldenRunV01,
} from "../../../src/fixtures/golden-run-v0.1";
import {
  createEvidenceCardValidator,
  createUntrustedEvidencePacket,
} from "../../../src/server/provenance/evidence-card-validation";
import { createSourcePacketBuilder } from "../../../src/server/provenance/source-packet";
import { createCrossrefMetadataVerifier } from "../../../src/server/retrieval/crossref";
import { createDoiInspector, normalizeDoi } from "../../../src/server/retrieval/doi";
import { createOpenAlexDiscoveryClient } from "../../../src/server/retrieval/openalex";
import { evidenceContext } from "../../fixtures/retrieval/evidence-card";
import {
  OFFLINE_CASES_BY_KIND,
  OFFLINE_RETRIEVAL_CASES,
  type ExactRuntimeExpectation,
  type OfflineEvidenceMode,
  type OfflineRetrievalCase,
} from "../../fixtures/retrieval/offline-suite";
import {
  fixtureSource,
  packetFreezeDecision,
} from "../../fixtures/retrieval/source-packet";

const EXPECTED_GOLDEN_CHUNK_HASHES = [
  [
    "gf-source-01",
    "9c2819492aebf688f659453d7aecbe2c797ffc410d4caae1f3ec15cf193c7050",
  ],
  [
    "gf-source-02",
    "26637262fbf4de761f483a56d4905b3db0cfb574e63e4f9bebff64c75a9ce8be",
  ],
  [
    "gf-source-03",
    "dc7ee32cfbcb25a1b9383eba4f9bf6954ae58ddbf447c5caea44f0bc01033d42",
  ],
  [
    "gf-source-04",
    "b832e77f36e948d20835ffcfb9325d30d0cdab4d51047c665e2e0e931af3ae07",
  ],
  [
    "gf-source-05",
    "caa79bef324cac532c50dababd87e6571b9fe6d1898773aac0eab59cd362f6f8",
  ],
  [
    "gf-source-06",
    "4e97cdbca2eb8851e6dea80008515f6fd3b74215af36b992c70f090a82c6838e",
  ],
  [
    "gf-source-07",
    "60dfe7d5fad5d2a834f56fd6b67005964242ba345de956ba1b2278ab26328ca9",
  ],
] as const;

const FIXTURE_OPENALEX_KEY = "fixture-openalex-key-placeholder";
const HAS_ACCEPTED_RETRIEVAL_PRIVACY = existsSync(
  new URL("../../../src/server/retrieval/privacy.ts", import.meta.url),
);

const EXPECTED_CASE_EVIDENCE_MODES = {
  matching_metadata: "fixture",
  metadata_mismatch: "fixture",
  non_resolving_doi: "mocked",
  datacite_routing: "mocked",
  no_doi: "fixture",
  duplicate_source: "simulated",
  abstract_only: "fixture",
  user_excerpt: "fixture",
  missing_passage: "simulated",
  support_contradiction: "fixture",
  rate_limit: "mocked",
  timeout: "mocked",
  invented_quote: "simulated",
  rights_denial: "simulated",
  prompt_injection: "simulated",
} as const satisfies {
  [Kind in OfflineRetrievalCase["kind"]]: Extract<
    OfflineRetrievalCase,
    { kind: Kind }
  >["evidenceMode"] & OfflineEvidenceMode;
};

type RuntimeExpectationEntry = Readonly<{
  label: string;
  expected: ExactRuntimeExpectation<unknown>;
}>;

const ALL_RUNTIME_EXPECTATIONS = [
  {
    label: "matching-crossref",
    expected: OFFLINE_CASES_BY_KIND.matching_metadata.expected.crossref,
  },
  {
    label: "matching-openalex",
    expected: OFFLINE_CASES_BY_KIND.matching_metadata.expected.openAlex,
  },
  {
    label: "metadata-mismatch",
    expected: OFFLINE_CASES_BY_KIND.metadata_mismatch.expected.runtime,
  },
  {
    label: "non-resolving-doi",
    expected: OFFLINE_CASES_BY_KIND.non_resolving_doi.expected.runtime,
  },
  {
    label: "datacite-routing",
    expected: OFFLINE_CASES_BY_KIND.datacite_routing.expected.runtime,
  },
  {
    label: "no-doi",
    expected: OFFLINE_CASES_BY_KIND.no_doi.expected.runtime,
  },
  ...OFFLINE_CASES_BY_KIND.duplicate_source.expected.results.map(
    (expected, index) => ({ label: `duplicate-${index}`, expected }),
  ),
  {
    label: "duplicate-review",
    expected: OFFLINE_CASES_BY_KIND.duplicate_source.expected.review,
  },
  {
    label: "abstract-result",
    expected: OFFLINE_CASES_BY_KIND.abstract_only.expected.result,
  },
  {
    label: "abstract-review",
    expected: OFFLINE_CASES_BY_KIND.abstract_only.expected.review,
  },
  {
    label: "excerpt-result",
    expected: OFFLINE_CASES_BY_KIND.user_excerpt.expected.result,
  },
  {
    label: "excerpt-review",
    expected: OFFLINE_CASES_BY_KIND.user_excerpt.expected.review,
  },
  {
    label: "missing-passage",
    expected: OFFLINE_CASES_BY_KIND.missing_passage.expected.runtime,
  },
  ...OFFLINE_CASES_BY_KIND.support_contradiction.expected.results.map(
    (expected, index) => ({
      label: `support-contradiction-${index}`,
      expected,
    }),
  ),
  {
    label: "rate-limit",
    expected: OFFLINE_CASES_BY_KIND.rate_limit.expected.runtime,
  },
  {
    label: "timeout",
    expected: OFFLINE_CASES_BY_KIND.timeout.expected.runtime,
  },
  {
    label: "invented-quote",
    expected: OFFLINE_CASES_BY_KIND.invented_quote.expected.runtime,
  },
  ...OFFLINE_CASES_BY_KIND.rights_denial.variants.map((variant) => ({
    label: variant.id,
    expected: variant.expected,
  })),
  {
    label: "prompt-injection-packet",
    expected: OFFLINE_CASES_BY_KIND.prompt_injection.expected.packet,
  },
  {
    label: "prompt-injection-validation",
    expected: OFFLINE_CASES_BY_KIND.prompt_injection.expected.validation,
  },
] as const satisfies readonly RuntimeExpectationEntry[];

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function strictRuntimeError(label: string, path: string, reason: string): never {
  throw new Error(`${label}: ${path} ${reason}`);
}

function assertStrictRuntimeValue(
  label: string,
  actual: unknown,
  expected: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): void {
  if (expected === null || typeof expected !== "object") {
    if (expected === undefined) {
      strictRuntimeError(label, path, "has an undefined expected value");
    }
    if (typeof expected === "number" && !Number.isFinite(expected)) {
      strictRuntimeError(label, path, "has a non-finite expected number");
    }
    if (
      typeof expected === "string" &&
      CONTROL_CHARACTER_PATTERN.test(expected)
    ) {
      strictRuntimeError(label, path, "has control characters in expected text");
    }
    if (typeof actual !== typeof expected || !Object.is(actual, expected)) {
      strictRuntimeError(label, path, "does not exactly equal expected value");
    }
    if (typeof actual === "number" && !Number.isFinite(actual)) {
      strictRuntimeError(label, path, "has a non-finite runtime number");
    }
    if (
      typeof actual === "string" &&
      CONTROL_CHARACTER_PATTERN.test(actual)
    ) {
      strictRuntimeError(label, path, "has control characters in runtime text");
    }
    return;
  }

  if (actual === null || typeof actual !== "object") {
    strictRuntimeError(label, path, "is not an object");
  }
  if (seen.has(actual)) {
    strictRuntimeError(label, path, "contains a repeated or circular object");
  }
  seen.add(actual);

  const expectedIsArray = Array.isArray(expected);
  if (Array.isArray(actual) !== expectedIsArray) {
    strictRuntimeError(label, path, "has the wrong container type");
  }
  const requiredPrototype = expectedIsArray
    ? Array.prototype
    : Object.prototype;
  if (Object.getPrototypeOf(expected) !== requiredPrototype) {
    strictRuntimeError(label, path, "has a non-plain expected prototype");
  }
  if (Object.getPrototypeOf(actual) !== requiredPrototype) {
    strictRuntimeError(label, path, "has a non-plain prototype");
  }

  const actualKeys = Reflect.ownKeys(actual);
  const expectedKeys = Reflect.ownKeys(expected);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    expectedKeys.some((key) => typeof key !== "string")
  ) {
    strictRuntimeError(label, path, "contains symbol keys");
  }
  const actualNames = (actualKeys as string[]).sort();
  const expectedNames = (expectedKeys as string[]).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((key, index) => key !== expectedNames[index])
  ) {
    strictRuntimeError(label, path, "has unknown or missing keys");
  }

  for (const key of expectedNames) {
    const actualDescriptor = Object.getOwnPropertyDescriptor(actual, key);
    const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
    if (
      actualDescriptor === undefined ||
      expectedDescriptor === undefined ||
      !("value" in actualDescriptor) ||
      !("value" in expectedDescriptor) ||
      actualDescriptor.get !== undefined ||
      actualDescriptor.set !== undefined
    ) {
      strictRuntimeError(label, `${path}.${key}`, "must be a data property");
    }
    if (key === "evidenceMode") {
      const mode = actualDescriptor.value as unknown;
      if (mode !== "fixture" && mode !== "mocked" && mode !== "simulated") {
        strictRuntimeError(label, `${path}.${key}`, "has a forbidden label");
      }
    }
    assertStrictRuntimeValue(
      label,
      actualDescriptor.value as unknown,
      expectedDescriptor.value as unknown,
      expectedIsArray ? `${path}[${key}]` : `${path}.${key}`,
      seen,
    );
  }
}

function assertRuntimeAgainstExpectation(
  label: string,
  actual: unknown,
  expected: ExactRuntimeExpectation<unknown>,
): void {
  assertStrictRuntimeValue(label, actual, expected.value);
  const expectedDigest = canonicalSha256(expected.value);
  if (expectedDigest !== expected.canonicalSha256) {
    strictRuntimeError(label, "$", "has an expected-object/hash mismatch");
  }
  if (canonicalSha256(actual) !== expected.canonicalSha256) {
    strictRuntimeError(label, "$", "has a runtime/expected hash mismatch");
  }
}

function expectExactRuntime<Actual>(
  label: string,
  actual: Actual,
  expected: ExactRuntimeExpectation<Actual>,
) {
  assertRuntimeAgainstExpectation(label, actual, expected);
  expect(actual).toStrictEqual(expected.value);
  if (
    actual !== null &&
    typeof actual === "object" &&
    "status" in actual &&
    actual.status === "accepted" &&
    "card" in actual
  ) {
    EvidenceCardSchema.parse(actual.card);
    EvidenceCardSchema.parse(
      (expected.value as { card: unknown }).card,
    );
  }
}

function response(spec: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return new Response(
    spec.body === undefined ? null : JSON.stringify(spec.body),
    { status: spec.status, headers: spec.headers },
  );
}

function sequentialFetch(
  specs: readonly {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }[],
) {
  let index = 0;
  return vi.fn(async () => {
    const spec = specs[index];
    index += 1;
    if (spec === undefined) {
      throw new Error("fixture transport exhausted");
    }
    return response(spec);
  });
}

type RuntimePath = readonly (string | number)[];

function collectContainerPaths(
  value: unknown,
  path: RuntimePath = [],
): readonly RuntimePath[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const nestedPaths = Object.entries(value).flatMap(([key, nested]) =>
    collectContainerPaths(
      nested,
      [...path, Array.isArray(value) ? Number(key) : key],
    ),
  );
  return [path, ...nestedPaths];
}

function cloneAndMutateAtPath<T>(
  value: T,
  path: RuntimePath,
  mutate: (target: object) => void,
): T {
  const cloned = structuredClone(value);
  let target: object = cloned as object;
  for (const segment of path) {
    const nested = Reflect.get(target, segment);
    if (nested === null || typeof nested !== "object") {
      throw new Error(`mutation path ${path.join(".")} is not a container`);
    }
    target = nested;
  }
  mutate(target);
  return cloned;
}

async function validationContext(
  fixture: Extract<
    OfflineRetrievalCase,
    {
      kind:
        | "missing_passage"
        | "support_contradiction"
        | "invented_quote"
        | "rights_denial"
        | "prompt_injection";
    }
  >,
  sources = fixture.sources,
  chunks = fixture.chunks,
) {
  return evidenceContext({
    knownSubclaimIds: fixture.knownSubclaimIds,
    sources,
    chunks,
    checkedAt: fixture.checkedAt,
  });
}

async function exerciseFixture(fixture: OfflineRetrievalCase) {
  switch (fixture.kind) {
    case "matching_metadata": {
      const crossrefFetch = sequentialFetch([fixture.crossrefResponse]);
      const crossref = await createCrossrefMetadataVerifier({
        evidenceMode: fixture.evidenceMode,
        fetch: crossrefFetch,
        now: () => new Date(fixture.checkedAt),
        sleep: async () => undefined,
        mailto: fixture.mailto,
        retry: { maxAttempts: 1 },
      }).verify(fixture.crossrefRequest);
      expectExactRuntime(
        "matching-crossref",
        crossref,
        fixture.expected.crossref,
      );
      expect(crossrefFetch).toHaveBeenCalledTimes(1);

      const openAlexFetch = sequentialFetch([fixture.openAlexResponse]);
      const discovery = await createOpenAlexDiscoveryClient({
        apiKey: FIXTURE_OPENALEX_KEY,
        evidenceMode: fixture.evidenceMode,
        fetch: openAlexFetch,
        now: () => new Date(fixture.checkedAt),
        sleep: async () => undefined,
        limits: { maxPages: 1, maxResults: 1, pageSize: 1 },
        retry: { maxAttempts: 1 },
      }).discover(fixture.openAlexQuery);
      expectExactRuntime(
        "matching-openalex",
        discovery,
        fixture.expected.openAlex,
      );
      expect(openAlexFetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ crossref, discovery })).not.toContain(
        FIXTURE_OPENALEX_KEY,
      );
      return;
    }
    case "metadata_mismatch": {
      const fetch = sequentialFetch([fixture.response]);
      const result = await createCrossrefMetadataVerifier({
        evidenceMode: fixture.evidenceMode,
        fetch,
        now: () => new Date(fixture.checkedAt),
        sleep: async () => undefined,
        retry: { maxAttempts: 1 },
      }).verify(fixture.request);
      expectExactRuntime(
        "metadata-mismatch",
        result,
        fixture.expected.runtime,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      return;
    }
    case "non_resolving_doi":
    case "rate_limit": {
      const fetch = sequentialFetch(fixture.responses);
      const result = await createDoiInspector({
        fetch,
        now: () => new Date(fixture.checkedAt),
        sleep: async () => undefined,
        retry: { maxAttempts: fixture.responses.length },
      }).resolve(fixture.input);
      expectExactRuntime(
        fixture.kind,
        result,
        fixture.expected.runtime,
      );
      expect(fetch).toHaveBeenCalledTimes(fixture.responses.length);
      return;
    }
    case "timeout": {
      vi.useFakeTimers();
      const observedSignals: AbortSignal[] = [];
      const fetch = vi.fn(
        async (_input: string, init?: RequestInit): Promise<Response> => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            throw new Error("timeout fixture requires the adapter signal");
          }
          observedSignals.push(signal);
          return await new Promise<Response>((_resolve, reject) => {
            const rejectAfterAbort = () => {
              reject(
                new DOMException(
                  "fixture deadline elapsed",
                  "AbortError",
                ),
              );
            };
            if (signal.aborted) {
              rejectAfterAbort();
            } else {
              signal.addEventListener("abort", rejectAfterAbort, {
                once: true,
              });
            }
          });
        },
      );
      try {
        const pending = createDoiInspector({
          fetch,
          now: () => new Date(fixture.checkedAt),
          sleep: async () => undefined,
          retry: {
            maxAttempts: fixture.expected.runtime.value.attempts,
            timeoutMs: 25,
          },
        }).resolve(fixture.input);
        await vi.runAllTimersAsync();
        const result = await pending;
        expectExactRuntime(
          "timeout",
          result,
          fixture.expected.runtime,
        );
        expect(fetch).toHaveBeenCalledTimes(
          fixture.expected.runtime.value.attempts,
        );
        expect(observedSignals).toHaveLength(
          fixture.expected.runtime.value.attempts,
        );
        expect(observedSignals.every(({ aborted }) => aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      return;
    }
    case "datacite_routing": {
      const fetch = sequentialFetch(fixture.responses);
      const result = await createDoiInspector({
        fetch,
        now: () => new Date(fixture.checkedAt),
        sleep: async () => undefined,
        retry: { maxAttempts: 1 },
      }).inspect(normalizeDoi(fixture.input));
      expectExactRuntime(
        "datacite-routing",
        result,
        fixture.expected.runtime,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      return;
    }
    case "no_doi": {
      const fetch = vi.fn(async () => {
        throw new Error("network forbidden for no-DOI fixture");
      });
      const result = await createDoiInspector({ fetch }).inspect(
        normalizeDoi(null),
      );
      expectExactRuntime(
        "no-doi",
        result,
        fixture.expected.runtime,
      );
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    case "duplicate_source": {
      const builder = createSourcePacketBuilder();
      const outcomes = [];
      for (const source of fixture.sources) {
        outcomes.push(await builder.addSource(source));
      }
      outcomes.forEach((outcome, index) =>
        expectExactRuntime(
          `duplicate-${index}`,
          outcome,
          fixture.expected.results[index]!,
        ),
      );
      const review = await builder.getReviewSnapshot();
      expectExactRuntime(
        "duplicate-review",
        review,
        fixture.expected.review,
      );
      return;
    }
    case "abstract_only":
    case "user_excerpt": {
      const builder = createSourcePacketBuilder();
      const result = await builder.addSource(fixture.source);
      const review = await builder.getReviewSnapshot();
      expectExactRuntime(
        `${fixture.kind}-result`,
        result,
        fixture.expected.result,
      );
      expectExactRuntime(
        `${fixture.kind}-review`,
        review,
        fixture.expected.review,
      );
      return;
    }
    case "missing_passage":
    case "invented_quote": {
      const { capability, ...input } = await validationContext(fixture);
      const result = createEvidenceCardValidator(input, capability).validate(
        fixture.card,
      );
      expectExactRuntime(
        fixture.kind,
        result,
        fixture.expected.runtime,
      );
      return;
    }
    case "support_contradiction": {
      const { capability, ...input } = await validationContext(fixture);
      const validator = createEvidenceCardValidator(input, capability);
      const results = fixture.cards.map((card) => validator.validate(card));
      results.forEach((result, index) => {
        expectExactRuntime(
          `support-contradiction-${index}`,
          result,
          fixture.expected.results[index]!,
        );
      });
      return;
    }
    case "rights_denial": {
      for (const variant of fixture.variants) {
        const context = await validationContext(
          fixture,
          variant.sources,
          variant.chunks,
        );
        const { capability, ...input } = context;
        const result = createEvidenceCardValidator(
          input,
          capability,
        ).validate(variant.card);
        expectExactRuntime(
          variant.id,
          result,
          variant.expected,
        );
      }
      return;
    }
    case "prompt_injection": {
      const { capability, ...input } = await validationContext(fixture);
      const packet = createUntrustedEvidencePacket(capability);
      expectExactRuntime(
        "prompt-injection-packet",
        packet,
        fixture.expected.packet,
      );
      expect(packet.chunks[0]?.untrustedText.value).toBe(
        fixture.injectionText,
      );
      const result = createEvidenceCardValidator(input, capability).validate(
        fixture.card,
      );
      expectExactRuntime(
        "prompt-injection-validation",
        result,
        fixture.expected.validation,
      );
      return;
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("complete offline retrieval and provenance fixture matrix", () => {
  it("declares every required case with typed expectations and honest evidence", () => {
    expect(OFFLINE_RETRIEVAL_CASES.map(({ id }) => id)).toEqual([
      "matching_metadata",
      "metadata_mismatch",
      "non_resolving_doi",
      "datacite_routing",
      "no_doi",
      "duplicate_source",
      "abstract_only",
      "user_excerpt",
      "missing_passage",
      "support_contradiction",
      "rate_limit",
      "timeout",
      "invented_quote",
      "rights_denial",
      "prompt_injection",
    ]);
    expect(new Set(OFFLINE_RETRIEVAL_CASES.map(({ id }) => id)).size).toBe(
      OFFLINE_RETRIEVAL_CASES.length,
    );
    expect(ALL_RUNTIME_EXPECTATIONS).toHaveLength(23);
    for (const entry of ALL_RUNTIME_EXPECTATIONS) {
      assertRuntimeAgainstExpectation(
        `${entry.label}-expected-self-check`,
        entry.expected.value,
        entry.expected,
      );
    }
    for (const fixture of OFFLINE_RETRIEVAL_CASES) {
      expect(fixture.evidenceMode).toBe(
        EXPECTED_CASE_EVIDENCE_MODES[fixture.kind],
      );
      expect(fixture.expected.outcome).toMatch(/^(?:result|error)$/u);
      expect(fixture.policy).toEqual({
        provenance: "project_authored",
        license: "CC0-1.0",
        containsRestrictedText: false,
        network: expect.stringMatching(
          /^(?:forbidden|injected_mock_transport_only)$/u,
        ),
      });
    }
    expect(JSON.stringify(OFFLINE_RETRIEVAL_CASES)).not.toContain(
      '"evidenceMode":"live"',
    );
  });

  it.each(OFFLINE_RETRIEVAL_CASES)(
    "$id returns its declared typed offline result",
    async (fixture) => {
      const forbiddenGlobalFetch = vi.fn(async () => {
        throw new Error("global network access is forbidden in fixtures");
      });
      vi.stubGlobal("fetch", forbiddenGlobalFetch);

      await exerciseFixture(fixture);

      expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
    },
  );

  it.runIf(HAS_ACCEPTED_RETRIEVAL_PRIVACY)(
    "keeps a forged AbortError without an aborted signal as network_error",
    async () => {
      vi.useFakeTimers();
      const observedSignals: AbortSignal[] = [];
      const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("network-error control requires adapter signal");
        }
        observedSignals.push(signal);
        throw new DOMException("forged timeout name", "AbortError");
      });
      try {
        const result = await createDoiInspector({
          fetch,
          now: () => new Date("2026-08-08T07:00:00.000Z"),
          sleep: async () => undefined,
          retry: { maxAttempts: 1, timeoutMs: 25 },
        }).resolve("10.5555/offline.forged-timeout");
        expect(result).toStrictEqual({
          status: "provider_unavailable",
          finalUrl: null,
          failureCode: "network_error",
          attempts: 1,
          checkedAt: "2026-08-08T07:00:00.000Z",
          attemptHistory: [
            {
              attempt: 1,
              startedAt: "2026-08-08T07:00:00.000Z",
              endedAt: "2026-08-08T07:00:00.000Z",
              outcome: "network_error",
              httpStatus: null,
              retryDelayMs: null,
            },
          ],
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]?.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects runtime relabeling and exact-shape mutations", async () => {
    const matchingFixture = OFFLINE_CASES_BY_KIND.matching_metadata;
    const matchingResult = await createCrossrefMetadataVerifier({
      evidenceMode: matchingFixture.evidenceMode,
      fetch: sequentialFetch([matchingFixture.crossrefResponse]),
      now: () => new Date(matchingFixture.checkedAt),
      sleep: async () => undefined,
      mailto: matchingFixture.mailto,
      retry: { maxAttempts: 1 },
    }).verify(matchingFixture.crossrefRequest);

    const noDoiFixture = OFFLINE_CASES_BY_KIND.no_doi;
    const noDoiResult = await createDoiInspector({
      fetch: async () => {
        throw new Error("network forbidden for no-DOI mutation fixture");
      },
    }).inspect(normalizeDoi(null));

    const rightsFixture = OFFLINE_CASES_BY_KIND.rights_denial;
    const rightsVariant = rightsFixture.variants[0]!;
    const rightsContext = await validationContext(
      rightsFixture,
      rightsVariant.sources,
      rightsVariant.chunks,
    );
    const { capability: rightsCapability, ...rightsInput } = rightsContext;
    const rightsResult = createEvidenceCardValidator(
      rightsInput,
      rightsCapability,
    ).validate(rightsVariant.card);
    if (rightsResult.status !== "rejected") {
      throw new Error("rights mutation baseline unexpectedly accepted");
    }

    const injectionFixture = OFFLINE_CASES_BY_KIND.prompt_injection;
    const injectionContext = await validationContext(injectionFixture);
    const { capability: injectionCapability, ...injectionInput } =
      injectionContext;
    const injectionResult = createEvidenceCardValidator(
      injectionInput,
      injectionCapability,
    ).validate(injectionFixture.card);
    if (injectionResult.status !== "accepted") {
      throw new Error("prompt-injection mutation baseline was rejected");
    }

    assertRuntimeAgainstExpectation(
      "matching-baseline",
      matchingResult,
      matchingFixture.expected.crossref,
    );
    assertRuntimeAgainstExpectation(
      "no-doi-baseline",
      noDoiResult,
      noDoiFixture.expected.runtime,
    );
    assertRuntimeAgainstExpectation(
      "rights-baseline",
      rightsResult,
      rightsVariant.expected,
    );
    assertRuntimeAgainstExpectation(
      "quote-baseline",
      injectionResult,
      injectionFixture.expected.validation,
    );

    const missingCanonicalDoi = { ...matchingResult };
    Reflect.deleteProperty(missingCanonicalDoi, "canonicalDoi");
    const missingMetadataRoute = { ...noDoiResult };
    Reflect.deleteProperty(missingMetadataRoute, "metadataRoute");

    const recomputedHashSubstitution = {
      ...matchingResult,
      notAResult: true,
    };
    const recomputedHashExpectation = {
      ...matchingFixture.expected.crossref,
      canonicalSha256: canonicalSha256(recomputedHashSubstitution),
    };

    const missingNestedReason = structuredClone(matchingResult);
    Reflect.deleteProperty(
      missingNestedReason.comparison.fields[0]!,
      "reason",
    );
    const accessorMutation = structuredClone(matchingResult);
    let runtimeGetterCalls = 0;
    Object.defineProperty(accessorMutation, "canonicalDoi", {
      enumerable: true,
      configurable: true,
      get() {
        runtimeGetterCalls += 1;
        return matchingResult.canonicalDoi;
      },
    });
    const prototypeMutation = structuredClone(matchingResult);
    Object.setPrototypeOf(prototypeMutation.source, { hostile: true });
    const symbolMutation = structuredClone(matchingResult);
    Reflect.defineProperty(symbolMutation, Symbol("notAResult"), {
      value: true,
      enumerable: true,
    });

    const unknownFieldMutations = ALL_RUNTIME_EXPECTATIONS.flatMap(
      (entry) =>
        collectContainerPaths(entry.expected.value).map((path) => ({
          label: `${entry.label} unknown key at ${path.join(".") || "$"}`,
          actual: cloneAndMutateAtPath(
            entry.expected.value,
            path,
            (target) => {
              Reflect.defineProperty(target, "notAResult", {
                value: true,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            },
          ),
          expected: entry.expected,
        })),
    );

    const mutations: readonly Readonly<{
      label: string;
      actual: unknown;
      expected: ExactRuntimeExpectation<unknown>;
    }>[] = [
      {
        label: "recomputed-hash substitution",
        actual: recomputedHashSubstitution,
        expected: recomputedHashExpectation,
      },
      {
        label: "expected-object/hash mismatch",
        actual: matchingResult,
        expected: {
          ...matchingFixture.expected.crossref,
          canonicalSha256: "0".repeat(64),
        },
      },
      {
        label: "live evidence relabel",
        actual: { ...matchingResult, evidenceMode: "live" },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "unverified evidence relabel",
        actual: { ...matchingResult, evidenceMode: "unverified" },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "extra result field",
        actual: { ...matchingResult, notAResult: true },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "missing required field",
        actual: missingCanonicalDoi,
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "wrong result discriminant",
        actual: { ...matchingResult, status: "mismatch" },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "wrong runtime type",
        actual: { ...matchingResult, attempts: "1" },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "runtime undefined",
        actual: { ...matchingResult, canonicalDoi: undefined },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "runtime NaN",
        actual: { ...matchingResult, attempts: Number.NaN },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "runtime control character",
        actual: {
          ...matchingResult,
          canonicalDoi: `${matchingResult.canonicalDoi}\u0000`,
        },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "nested missing field",
        actual: missingNestedReason,
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "nested hostile prototype",
        actual: prototypeMutation,
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "runtime accessor",
        actual: accessorMutation,
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "runtime symbol key",
        actual: symbolMutation,
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "array order mutation",
        actual: {
          ...matchingResult,
          comparison: {
            ...matchingResult.comparison,
            fields: [...matchingResult.comparison.fields].reverse(),
          },
        },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "array duplicate mutation",
        actual: {
          ...matchingResult,
          comparison: {
            ...matchingResult.comparison,
            fields: [
              ...matchingResult.comparison.fields,
              matchingResult.comparison.fields[0]!,
            ],
          },
        },
        expected: matchingFixture.expected.crossref,
      },
      {
        label: "missing nested DOI route",
        actual: missingMetadataRoute,
        expected: noDoiFixture.expected.runtime,
      },
      {
        label: "mismatched nested DOI error",
        actual: {
          ...noDoiResult,
          resolution: {
            ...noDoiResult.resolution,
            failureCode: "invalid_syntax",
          },
        },
        expected: noDoiFixture.expected.runtime,
      },
      {
        label: "mismatched rights rejection",
        actual: {
          ...rightsResult,
          code: "display_denied",
          field: "excerpt",
        },
        expected: rightsVariant.expected,
      },
      {
        label: "mismatched visible quote",
        actual: {
          ...injectionResult,
          visibleQuote: "invented replacement quote",
        },
        expected: injectionFixture.expected.validation,
      },
      {
        label: "mismatched nested relationship",
        actual: {
          ...injectionResult,
          card: { ...injectionResult.card, relationship: "supports" },
        },
        expected: injectionFixture.expected.validation,
      },
      ...unknownFieldMutations,
    ];

    for (const mutation of mutations) {
      expect(() =>
        assertRuntimeAgainstExpectation(
          mutation.label,
          mutation.actual,
          mutation.expected,
        ),
      ).toThrow();
    }
    expect(runtimeGetterCalls).toBe(0);
  });

  it("leaves the frozen golden packet, source, and chunk bytes unchanged", () => {
    expect(computedGoldenFixtureSha256).toBe(GOLDEN_FIXTURE_SHA256);
    expect(GOLDEN_FIXTURE_SHA256).toBe(
      "f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7",
    );
    expect(GOLDEN_PACKET_FINGERPRINT).toBe(
      "944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e",
    );
    expect(
      goldenRunV01.chunks.map(({ sourceId, contentHash }) => [
        sourceId,
        contentHash,
      ]),
    ).toEqual(EXPECTED_GOLDEN_CHUNK_HASHES);
    for (const chunk of goldenRunV01.chunks) {
      expect(
        createHash("sha256").update(chunk.text, "utf8").digest("hex"),
      ).toBe(chunk.contentHash);
      expect(
        goldenRunV01.sources.find(({ id }) => id === chunk.sourceId)
          ?.contentHash,
      ).toBe(chunk.contentHash);
    }
  });

  it("rejects accessors, hostile aliases, and copied packet authority", async () => {
    let getterCalls = 0;
    const accessorSource = {
      ...fixtureSource({
        id: "offline-accessor-source",
        stableId: "fixture:offline-accessor-source",
        doi: null,
        url: null,
      }),
    };
    Object.defineProperty(accessorSource, "rights", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return fixtureSource().rights;
      },
    });
    const accessorBuilder = createSourcePacketBuilder();
    const accessorResult = await accessorBuilder.addSource(accessorSource);
    expect({
      status: accessorResult.status,
      code: accessorResult.code,
      canonicalSourceId: accessorResult.canonicalSourceId,
    }).toEqual({
      status: "rejected",
      code: "invalid_metadata",
      canonicalSourceId: null,
    });
    expect(getterCalls).toBe(0);

    const aliasBuilder = createSourcePacketBuilder();
    await aliasBuilder.addSource(
      fixtureSource({
        id: "offline-alias-primary",
        stableId: "fixture:offline-alias-primary",
        doi: "10.5555/offline.alias",
        url: null,
      }),
    );
    const aliasResult = await aliasBuilder.addSource(
      fixtureSource({
        id: "offline-alias-hostile",
        stableId: "fixture:offline-alias-hostile",
        doi: "10.5555/offline.alias",
        url: null,
        content: "Changed bytes cannot inherit an existing identity.",
      }),
    );
    expect({
      status: aliasResult.status,
      code: aliasResult.code,
      canonicalSourceId: aliasResult.canonicalSourceId,
    }).toEqual({
      status: "rejected",
      code: "alias_conflict",
      canonicalSourceId: null,
    });

    const authorityBuilder = createSourcePacketBuilder();
    await authorityBuilder.addSource(
      fixtureSource({
        id: "offline-authority-source",
        stableId: "fixture:offline-authority-source",
        doi: null,
        url: null,
      }),
    );
    const frozen = await authorityBuilder.freeze({
      frozenAt: "2026-08-08T07:05:00.000Z",
      freezeDecision: packetFreezeDecision(),
    });
    const copiedCapability = structuredClone(frozen.evidenceCapability);
    expect(() => createUntrustedEvidencePacket(copiedCapability)).toThrow(
      "evidence validation requires a capability issued by a frozen source packet",
    );
  });

  it("keeps packet order canonical while preserving Unicode byte distinctions", async () => {
    const sourceA = fixtureSource({
      id: "offline-order-a",
      stableId: "fixture:offline-order-a",
      doi: null,
      url: null,
      content: "Order-independent fixture A.",
    });
    const sourceB = fixtureSource({
      id: "offline-order-b",
      stableId: "fixture:offline-order-b",
      doi: null,
      url: null,
      content: "Order-independent fixture B.",
    });
    const fingerprints = [];
    for (const sources of [
      [sourceA, sourceB],
      [sourceB, sourceA],
    ]) {
      const builder = createSourcePacketBuilder();
      for (const source of sources) {
        await builder.addSource(source);
      }
      fingerprints.push(
        (
          await builder.freeze({
            frozenAt: "2026-08-08T07:05:00.000Z",
            freezeDecision: packetFreezeDecision(),
          })
        ).packet.fingerprint,
      );
    }
    expect(fingerprints[0]).toBe(fingerprints[1]);

    const unicodeFingerprints = [];
    for (const [id, content] of [
      ["offline-unicode-nfc", "caf\u00e9"],
      ["offline-unicode-nfd", "cafe\u0301"],
    ] as const) {
      const builder = createSourcePacketBuilder();
      await builder.addSource(
        fixtureSource({
          id,
          stableId: `fixture:${id}`,
          doi: null,
          url: null,
          content,
        }),
      );
      unicodeFingerprints.push(
        (
          await builder.freeze({
            frozenAt: "2026-08-08T07:05:00.000Z",
            freezeDecision: packetFreezeDecision(),
          })
        ).packet.fingerprint,
      );
    }
    expect(unicodeFingerprints[0]).not.toBe(unicodeFingerprints[1]);
  });

});
