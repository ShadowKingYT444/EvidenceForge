import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  exportCanonicalGoldenRun,
  parseCompleteGoldenRun,
} from "../../src/contracts/golden";
import {
  freezeCurrentPacket,
  ResearchRunSchema,
} from "../../src/contracts";
import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_SHA256,
  GOLDEN_FIXTURE_VERSION,
  GOLDEN_PACKET_FINGERPRINT,
  computedGoldenFixtureSha256,
  exportGoldenRunV01,
  goldenRunV01,
} from "../../src/fixtures/golden-run-v0.1";
import {
  GOLDEN_FIXTURE_ID_V02,
  GOLDEN_FIXTURE_SHA256_V02,
  GOLDEN_FIXTURE_VERSION_V02,
  GOLDEN_PACKET_FINGERPRINT_V02,
  computedGoldenFixtureSha256V02,
  computedGoldenPacketFingerprintV02,
  exportGoldenRunV02,
  goldenRunV02,
  parseGoldenRunV02,
} from "../../src/fixtures/golden-run-v0.2";

function mutableGoldenRun(): Record<string, unknown> {
  return structuredClone(goldenRunV01) as Record<string, unknown>;
}

function mutableGoldenRunV02(): Record<string, unknown> {
  return structuredClone(goldenRunV02) as Record<string, unknown>;
}

describe("complete golden run fixture", () => {
  it("refreezes the current 0.2 fixture without relabeling the readable 0.1 fixture", () => {
    expect(GOLDEN_FIXTURE_VERSION_V02).toBe("0.2");
    expect(GOLDEN_FIXTURE_ID_V02).toBe(
      "golden-biodegradable-sensor-72h-v0.2",
    );
    expect(goldenRunV02.schemaVersion).toBe("0.2");
    expect(goldenRunV01.schemaVersion).toBe("0.1");
    expect(computedGoldenFixtureSha256V02).toBe(GOLDEN_FIXTURE_SHA256_V02);
    expect(computedGoldenPacketFingerprintV02).toBe(
      GOLDEN_PACKET_FINGERPRINT_V02,
    );
    expect(goldenRunV02.packet?.schemaVersion).toBe("0.2");
    expect(goldenRunV01.packet?.schemaVersion).toBe("0.1");
    expect(goldenRunV02.packet?.fingerprint).not.toBe(
      goldenRunV01.packet?.fingerprint,
    );
    expect(goldenRunV02.finalDecision).toMatchObject({
      declaredActor: "Fixture review lead",
      optionsShown: ["approve", "reject"],
    });
    expect(exportGoldenRunV02()).toBe(
      exportCanonicalGoldenRun(goldenRunV02),
    );
  });

  it("validates and exports one deterministic canonical fixture", () => {
    const parsed = parseCompleteGoldenRun(goldenRunV01);
    const canonical = exportCanonicalGoldenRun(parsed);

    expect(GOLDEN_FIXTURE_VERSION).toBe("0.1");
    expect(GOLDEN_FIXTURE_ID).toBe(
      "golden-biodegradable-sensor-72h-v0.1",
    );
    expect(parsed.id).toBe(GOLDEN_FIXTURE_ID);
    expect(canonical.endsWith("\n")).toBe(false);
    expect(GOLDEN_FIXTURE_SHA256).toBe(
      "f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7",
    );
    expect(computedGoldenFixtureSha256).toBe(GOLDEN_FIXTURE_SHA256);
    expect(exportCanonicalGoldenRun(JSON.parse(canonical))).toBe(canonical);
    expect(parsed.packet?.fingerprint).toBe(
      GOLDEN_PACKET_FINGERPRINT,
    );
    expect(GOLDEN_PACKET_FINGERPRINT).toBe(
      "944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e",
    );
    expect(exportGoldenRunV01()).toBe(canonical);
  });

  it("preserves the seven approved excerpts and their exact UTF-8 hashes", () => {
    expect(
      goldenRunV01.chunks.map(({ sourceId, contentHash }) => [
        sourceId,
        contentHash,
      ]),
    ).toEqual([
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
    ]);
    expect(goldenRunV01.chunks).toHaveLength(7);
    for (const chunk of goldenRunV01.chunks) {
      expect(
        createHash("sha256").update(chunk.text, "utf8").digest("hex"),
      ).toBe(chunk.contentHash);
      expect(chunk.text.trim().split(/\s+/u).length).toBeLessThanOrEqual(25);
      expect(
        goldenRunV01.sources.filter(({ id }) => id === chunk.sourceId),
      ).toHaveLength(1);
    }
    for (const source of goldenRunV01.sources) {
      expect(source.canonicalDoi).not.toBeNull();
      expect(source.canonicalUrl).toBe(
        `https://doi.org/${source.canonicalDoi}`,
      );
      expect(source.rights.basis).toContain(
        "https://creativecommons.org/licenses/by/4.0/",
      );
      expect(source.rights.basis).toContain("attribution required");
      expect(source.rights.basis).toContain(
        "excerpt reproduced without textual changes",
      );
    }
    expect(
      new Set(goldenRunV01.evidenceCards.map(({ relationship }) => relationship)),
    ).toEqual(new Set(["supports", "contradicts", "unresolved"]));
  });

  it("maps each source access location to its own immutable chunk", () => {
    expect(
      goldenRunV01.sources.map((source) => {
        const linkedChunk = goldenRunV01.chunks.find(
          ({ sourceId }) => sourceId === source.id,
        );
        return [
          source.id,
          linkedChunk?.id,
          source.access.location,
          linkedChunk?.location,
        ];
      }),
    ).toEqual([
      [
        "gf-source-01",
        "gf-chunk-01",
        "Results and discussion → Battery performance, paragraph beginning “After 1 h of discharge”",
        "Results and discussion → Battery performance, paragraph beginning “After 1 h of discharge”",
      ],
      [
        "gf-source-02",
        "gf-chunk-02",
        "section 7.1, Biodegradable Batteries, paragraph discussing Karami-Mosammam et al.",
        "section 7.1, Biodegradable Batteries, paragraph discussing Karami-Mosammam et al.",
      ],
      [
        "gf-source-03",
        "gf-chunk-03",
        "Results and discussion → PCL-coated Mg/Fe full-cells, paragraph beginning “The discharge performance”",
        "Results and discussion → PCL-coated Mg/Fe full-cells, paragraph beginning “The discharge performance”",
      ],
      [
        "gf-source-04",
        "gf-chunk-04",
        "abstract, paragraph beginning “Flexible and thin-film humidity sensors…”",
        "abstract, paragraph beginning “Flexible and thin-film humidity sensors…”",
      ],
      [
        "gf-source-05",
        "gf-chunk-05",
        "section 1.1, Epidemiology, paragraph beginning “New button batteries are more likely…”",
        "section 1.1, Epidemiology, paragraph beginning “New button batteries are more likely…”",
      ],
      [
        "gf-source-06",
        "gf-chunk-06",
        "DataCite Abstract at https://api.datacite.org/dois/10.25394/pgs.23496710.v1; primary repository record https://api.figshare.com/v2/articles/23496710",
        "DataCite Abstract at https://api.datacite.org/dois/10.25394/pgs.23496710.v1; primary repository record https://api.figshare.com/v2/articles/23496710",
      ],
      [
        "gf-source-07",
        "gf-chunk-07",
        "section 2, Transient Materials, introductory paragraph",
        "section 2, Transient Materials, introductory paragraph",
      ],
    ]);
  });

  it("keeps metadata/existence checks separate from entailment and review", () => {
    const mismatch = goldenRunV01.sources.find(
      ({ id }) => id === "gf-source-01",
    );
    const mismatchCard = goldenRunV01.evidenceCards.find(
      ({ sourceChunkId }) => sourceChunkId === "gf-chunk-01",
    );
    const missingError = goldenRunV01.errors.find(
      ({ id }) => id === "gf-error-source-08",
    );
    const missingExecution = goldenRunV01.executions.find(
      ({ id }) => id === "gf-execution-collect-1",
    );

    expect(mismatch?.metadataVerification.status).toBe("mismatch");
    expect(mismatchCard?.relationship).toBe("contradicts");
    expect(mismatchCard?.humanReview.status).toBe("confirmed");
    expect(missingError).toEqual(
      expect.objectContaining({
        kind: "missing_source",
        executionId: "gf-execution-collect-1",
        details: expect.objectContaining({
          providerCode: "DOI_NOT_FOUND",
          httpStatus: 404,
        }),
      }),
    );
    expect(missingExecution).toEqual(
      expect.objectContaining({
        status: "failed",
        outputRefs: [],
        errorIds: ["gf-error-source-08"],
      }),
    );
    expect(
      goldenRunV01.sources.some(({ id }) => id === "gf-source-08"),
    ).toBe(false);
    expect(
      goldenRunV01.evidenceCards.some(
        ({ sourceChunkId }) => sourceChunkId === "gf-chunk-08",
      ),
    ).toBe(false);
  });

  it("retains every human checkpoint, one accepted revision, and one unresolved objection", () => {
    expect(goldenRunV01.scopeDecision?.checkpoint).toBe("scope");
    expect(goldenRunV01.packet?.freezeDecision.checkpoint).toBe(
      "packet_freeze",
    );
    expect(goldenRunV01.objectionDispositionDecision?.checkpoint).toBe(
      "objection_dispositions",
    );
    expect(goldenRunV01.finalDecision?.checkpoint).toBe("final");
    expect(
      goldenRunV01.revision?.decisions.map(
        ({ objectionId, disposition, revisedValue }) => ({
          objectionId,
          disposition,
          revisedValue,
        }),
      ),
    ).toEqual([
      {
        objectionId: "gf-objection-calibration",
        disposition: "accepted",
        revisedValue:
          "Calibrate voltage and current channels before each block; verify the programmed load against an independent logger.",
      },
      {
        objectionId: "gf-objection-degradation",
        disposition: "unresolved",
        revisedValue: null,
      },
    ]);
    expect(goldenRunV01.finalDecision?.unresolvedObjections).toEqual([
      "gf-objection-degradation",
    ]);
  });

  it("preserves failed execution history and labels every attempt fixture", () => {
    expect(
      goldenRunV01.executions.map(
        ({ id, attempt, status, evidenceMode, retryOfExecutionId }) => ({
          id,
          attempt,
          status,
          evidenceMode,
          retryOfExecutionId,
        }),
      ),
    ).toContainEqual({
      id: "gf-execution-plan-1",
      attempt: 1,
      status: "failed",
      evidenceMode: "fixture",
      retryOfExecutionId: null,
    });
    expect(goldenRunV01.executions).toContainEqual(
      expect.objectContaining({
        id: "gf-execution-plan-2",
        attempt: 2,
        status: "succeeded",
        evidenceMode: "fixture",
        retryOfExecutionId: "gf-execution-plan-1",
      }),
    );
    expect(goldenRunV01.errors).toContainEqual(
      expect.objectContaining({
        id: "gf-error-plan-1",
        executionId: "gf-execution-plan-1",
      }),
    );
    expect(
      goldenRunV01.executions.every(
        ({ evidenceMode }) => evidenceMode === "fixture",
      ),
    ).toBe(true);
  });

  it("covers the literal consumer-freeze DOI and provider-retry scenarios", () => {
    const nonCrossrefSource = goldenRunV01.sources.find(
      ({ canonicalDoi }) => canonicalDoi === "10.25394/pgs.23496710.v1",
    );
    const nonCrossrefDoi =
      nonCrossrefSource?.doiResolution.resolution === "resolved" &&
      nonCrossrefSource.doiResolution.registrationAgency === "DataCite";
    const providerFailureRetry = goldenRunV01.errors.some((error) => {
      if (error.kind !== "provider_failure" || error.executionId === null) {
        return false;
      }
      const failedAttempt = goldenRunV01.executions.find(
        ({ id }) => id === error.executionId,
      );
      return (
        failedAttempt?.status === "failed" &&
        goldenRunV01.executions.some(
          ({ nodeId, status, retryOfExecutionId }) =>
            nodeId === failedAttempt.nodeId &&
            status === "succeeded" &&
            retryOfExecutionId === failedAttempt.id,
        )
      );
    });

    expect({ nonCrossrefDoi, providerFailureRetry }).toEqual({
      nonCrossrefDoi: true,
      providerFailureRetry: true,
    });
    expect(nonCrossrefSource).toEqual(
      expect.objectContaining({
        bibliographicMetadata: expect.objectContaining({
          title:
            "SCALABLE LASER ASSISTED MANUFACTURING TECHNIQUES FOR LOW-COST MULTI-FUNCTIONAL PASSIVE WIRELESS CHIPLESS SENSORS.pdf",
          year: 2023,
          venue: "Purdue University Graduate School",
        }),
        doiResolution: {
          syntax: "valid",
          resolution: "resolved",
          registrationAgency: "DataCite",
          checkedAt: "2026-08-06T21:42:38.499Z",
        },
        rights: expect.objectContaining({
          mayStore: "allowed",
          mayDisplay: "allowed",
          maySendToModel: "allowed",
          basis: expect.stringContaining(
            "attribution required to Sarath Gopalakrishnan",
          ),
        }),
        access: expect.objectContaining({
          location: expect.stringContaining(
            "https://api.datacite.org/dois/10.25394/pgs.23496710.v1",
          ),
        }),
      }),
    );
    expect(goldenRunV01.errors).toContainEqual(
      expect.objectContaining({
        id: "gf-error-review-1",
        kind: "provider_failure",
        executionId: "gf-execution-review-failure-1",
        retryable: true,
      }),
    );
    expect(goldenRunV01.executions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gf-execution-review-failure-1",
          attempt: 1,
          status: "failed",
          errorIds: ["gf-error-review-1"],
          retryOfExecutionId: null,
        }),
        expect.objectContaining({
          id: "gf-execution-review-1",
          attempt: 2,
          status: "succeeded",
          errorIds: [],
          retryOfExecutionId: "gf-execution-review-failure-1",
        }),
      ]),
    );
  });

  it("deep-freezes the parsed fixture", () => {
    expect(Object.isFrozen(goldenRunV01)).toBe(true);
    expect(Object.isFrozen(goldenRunV01.sources)).toBe(true);
    expect(Object.isFrozen(goldenRunV01.sources[0])).toBe(true);
    expect(() => {
      (goldenRunV01.sources[0] as { contentHash: string }).contentHash =
        "0".repeat(64);
    }).toThrow(TypeError);
  });

  it.each([
    [
      "missing scope checkpoint",
      (run: Record<string, unknown>) => {
        run.scopeDecision = null;
      },
    ],
    [
      "mutated source text",
      (run: Record<string, unknown>) => {
        const chunks = run.chunks as Array<{ text: string }>;
        chunks[0].text += " mutated";
      },
    ],
    [
      "missing contradiction state",
      (run: Record<string, unknown>) => {
        const cards = run.evidenceCards as Array<{ relationship: string }>;
        cards[0].relationship = "unresolved";
      },
    ],
    [
      "missing support state",
      (run: Record<string, unknown>) => {
        const cards = run.evidenceCards as Array<{ relationship: string }>;
        for (const card of cards) {
          if (card.relationship === "supports") {
            card.relationship = "unresolved";
          }
        }
      },
    ],
    [
      "missing unresolved state",
      (run: Record<string, unknown>) => {
        const cards = run.evidenceCards as Array<{ relationship: string }>;
        for (const card of cards) {
          if (card.relationship === "unresolved") {
            card.relationship = "supports";
          }
        }
      },
    ],
    [
      "missing metadata mismatch",
      (run: Record<string, unknown>) => {
        const sources = run.sources as Array<{
          metadataVerification: { status: string; fieldDiffs: unknown[] };
        }>;
        sources[0].metadataVerification.status = "match";
        sources[0].metadataVerification.fieldDiffs = [];
      },
    ],
    [
      "missing identifier failure",
      (run: Record<string, unknown>) => {
        run.errors = (
          run.errors as Array<{ id: string }>
        ).filter(({ id }) => id !== "gf-error-source-08");
      },
    ],
    [
      "missing non-Crossref DOI",
      (run: Record<string, unknown>) => {
        const sources = run.sources as Array<{
          canonicalDoi: string | null;
          doiResolution: { registrationAgency: string | null };
        }>;
        const dataCiteSource = sources.find(
          ({ canonicalDoi }) => canonicalDoi === "10.25394/pgs.23496710.v1",
        );
        if (dataCiteSource === undefined) {
          throw new Error("DataCite fixture source is missing");
        }
        dataCiteSource.doiResolution.registrationAgency = "Crossref";
      },
    ],
    [
      "missing provider-failure retry",
      (run: Record<string, unknown>) => {
        const errors = run.errors as Array<{ id: string; kind: string }>;
        const providerError = errors.find(
          ({ id }) => id === "gf-error-review-1",
        );
        if (providerError === undefined) {
          throw new Error("provider-failure fixture error is missing");
        }
        providerError.kind = "timeout";
      },
    ],
    [
      "unknown excerpt right",
      (run: Record<string, unknown>) => {
        const sources = run.sources as Array<{
          rights: { maySendToModel: string };
        }>;
        sources[0].rights.maySendToModel = "unknown";
      },
    ],
    [
      "removed attribution basis",
      (run: Record<string, unknown>) => {
        const sources = run.sources as Array<{ rights: { basis: string } }>;
        sources[0].rights.basis = "approved";
      },
    ],
    [
      "missing frozen packet",
      (run: Record<string, unknown>) => {
        run.packet = null;
      },
    ],
    [
      "missing experiment",
      (run: Record<string, unknown>) => {
        run.experiment = null;
      },
    ],
    [
      "missing review",
      (run: Record<string, unknown>) => {
        run.review = null;
      },
    ],
    [
      "missing objection checkpoint",
      (run: Record<string, unknown>) => {
        run.objectionDispositionDecision = null;
      },
    ],
    [
      "missing revision",
      (run: Record<string, unknown>) => {
        run.revision = null;
      },
    ],
    [
      "missing final checkpoint",
      (run: Record<string, unknown>) => {
        run.finalDecision = null;
      },
    ],
    [
      "non-fixture run mode",
      (run: Record<string, unknown>) => {
        run.evidenceMode = "simulated";
      },
    ],
    [
      "incomplete run status",
      (run: Record<string, unknown>) => {
        run.status = "awaiting_final_approval";
      },
    ],
    [
      "missing accepted revision",
      (run: Record<string, unknown>) => {
        const revision = run.revision as {
          decisions: Array<{ disposition: string; revisedValue: string | null }>;
        };
        revision.decisions[0].disposition = "unresolved";
        revision.decisions[0].revisedValue = null;
      },
    ],
    [
      "erased failed attempt",
      (run: Record<string, unknown>) => {
        run.executions = (
          run.executions as Array<{ id: string }>
        ).filter(({ id }) => id !== "gf-execution-plan-1");
      },
    ],
    [
      "hidden unresolved objection",
      (run: Record<string, unknown>) => {
        const finalDecision = run.finalDecision as {
          unresolvedObjections: string[];
        };
        finalDecision.unresolvedObjections = [];
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const run = mutableGoldenRun();
    mutate(run);
    expect(ResearchRunSchema.safeParse(run).success).toBe(true);
    expect(() => parseCompleteGoldenRun(run)).toThrow();
  });

  it("rejects a self-consistent rewrite against the reviewed full-run hash", () => {
    const run = mutableGoldenRunV02();
    const chunks = run.chunks as Array<{
      sourceId: string;
      text: string;
      contentHash: string;
    }>;
    const sources = run.sources as Array<{
      id: string;
      contentHash: string;
    }>;
    const changed = chunks[0];
    changed.text += " mutated";
    changed.contentHash = createHash("sha256")
      .update(changed.text, "utf8")
      .digest("hex");
    const source = sources.find(({ id }) => id === changed.sourceId);
    if (source === undefined) {
      throw new Error("test source is missing");
    }
    source.contentHash = changed.contentHash;
    const currentPacket = run.packet as NonNullable<
      typeof goldenRunV02.packet
    >;
    run.packet = freezeCurrentPacket({
      packetVersion: currentPacket.packetVersion,
      sourceHashes: sources.map(({ contentHash }) => contentHash),
      chunkHashes: chunks.map(({ contentHash }) => contentHash),
      frozenAt: currentPacket.frozenAt,
      freezeDecision: currentPacket.freezeDecision,
    });

    expect(() => parseCompleteGoldenRun(run)).not.toThrow();
    expect(() => parseGoldenRunV02(run)).toThrow(
      "golden 0.2 fixture does not match the reviewed canonical hash",
    );
  });

  it("rejects a complete proposal that also claims a safety abstention", () => {
    const run = mutableGoldenRun();
    run.experimentAbstention = {
      id: "gf-abstention-conflict",
      reason: "A qualified reviewer is required.",
      safetyCategories: ["missing_qualified_review"],
      qualifiedReviewRequired: true,
      missingInputs: ["qualified reviewer"],
      allowedNextStep: "Obtain qualified human review.",
    };

    expect(ResearchRunSchema.safeParse(run).success).toBe(false);
    expect(() => parseCompleteGoldenRun(run)).toThrow();
  });

  it("does not weaken the general contract for valid in-progress runs", () => {
    const inProgress = {
      ...mutableGoldenRun(),
      status: "awaiting_scope_approval",
      scopeDecision: null,
      packet: null,
      sources: [],
      chunks: [],
      evidenceCards: [],
      conclusions: [],
      researchGaps: [],
      selectedGapId: null,
      experiment: null,
      review: null,
      objectionDispositionDecision: null,
      revision: null,
      finalDecision: null,
      executions: [],
      errors: [],
    };

    expect(ResearchRunSchema.safeParse(inProgress).success).toBe(true);
    expect(() => parseCompleteGoldenRun(inProgress)).toThrow();
  });
});
