import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PacketFreezeSchema } from "../../../src/contracts";
import {
  PacketMutationError,
  createSourcePacketBuilder,
  sha256Utf8,
  type SourceIngestionInput,
  type SourcePermissionState,
} from "../../../src/server/provenance/source-packet";
import {
  PACKET_CHECKED_AT,
  PACKET_FROZEN_AT,
  fixtureSource,
  packetFreezeDecision,
} from "../../fixtures/retrieval/source-packet";

function expectedUtf8Hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function permission(
  allowed: boolean,
): SourcePermissionState {
  return allowed ? "allowed" : "denied";
}

describe("rights-aware source ingestion", () => {
  it.each([
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true],
  ])(
    "enforces independent store=%s display=%s model=%s permissions",
    async (mayStore, mayDisplay, maySendToModel) => {
      const builder = createSourcePacketBuilder();
      const added = await builder.addSource(
        fixtureSource({
          rights: {
            mayStore: permission(mayStore),
            mayDisplay: permission(mayDisplay),
            maySendToModel: permission(maySendToModel),
            permissionBasis: "explicit fixture matrix decision",
            checkedAt: PACKET_CHECKED_AT,
          },
        }),
      );
      const review = await builder.getReviewSnapshot();
      const model = await builder.getModelPayload();

      if (!mayStore) {
        expect(added).toMatchObject({
          status: "rejected",
          code: "storage_permission_denied",
          safeMetadata: {
            contentScope: "user_excerpt",
            permissionBasis: "explicit fixture matrix decision",
            rights: {
              mayStore: "denied",
              mayDisplay: permission(mayDisplay),
              maySendToModel: permission(maySendToModel),
            },
            contentReason: "storage_permission_denied",
          },
        });
        expect(review.sources).toEqual([]);
        expect(model.chunks).toEqual([]);
        return;
      }

      expect(added).toMatchObject({
        status: "stored",
        safeMetadata: {
          contentScope: "user_excerpt",
          permissionBasis: "explicit fixture matrix decision",
        },
      });
      expect(review.sources).toHaveLength(1);
      expect(review.sources[0]?.content).toMatchObject(
        mayDisplay
          ? { status: "available" }
          : { status: "blocked", reason: "display_permission_denied" },
      );
      expect(review.sources[0]?.content.chunks).toHaveLength(
        mayDisplay ? 1 : 0,
      );
      expect(model.chunks).toHaveLength(maySendToModel ? 1 : 0);
      if (!mayDisplay && maySendToModel) {
        expect(review.sources[0]?.content.chunks).toEqual([]);
        expect(model.chunks[0]?.text).toBe(
          "Synthetic excerpt for deterministic packet tests.",
        );
      }
    },
  );

  it("fails closed for unknown and missing rights without inventing a permission basis", async () => {
    const missing = createSourcePacketBuilder();
    await expect(
      missing.addSource(fixtureSource({ rights: undefined })),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "storage_permission_unknown",
      safeMetadata: {
        permissionBasis: null,
        rights: {
          mayStore: "unknown",
          mayDisplay: "unknown",
          maySendToModel: "unknown",
        },
      },
    });
    expect((await missing.getReviewSnapshot()).sources).toEqual([]);

    const partial = createSourcePacketBuilder();
    await expect(
      partial.addSource(
        fixtureSource({
          rights: {
            mayStore: "allowed",
            permissionBasis: "storage only was reviewed",
            checkedAt: PACKET_CHECKED_AT,
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "stored",
      safeMetadata: {
        rights: {
          mayStore: "allowed",
          mayDisplay: "unknown",
          maySendToModel: "unknown",
        },
      },
    });
    expect(
      (await partial.getReviewSnapshot()).sources[0]?.content,
    ).toMatchObject({
      status: "blocked",
      reason: "display_permission_unknown",
      chunks: [],
    });
    expect((await partial.getModelPayload()).chunks).toEqual([]);

    const noBasis = createSourcePacketBuilder();
    await expect(
      noBasis.addSource(
        fixtureSource({
          rights: {
            mayStore: "allowed",
            mayDisplay: "allowed",
            maySendToModel: "allowed",
            checkedAt: PACKET_CHECKED_AT,
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "permission_basis_missing",
      safeMetadata: { permissionBasis: null },
    });
    expect((await noBasis.getReviewSnapshot()).sources).toEqual([]);
  });

  it("never emits denied content through review or model payloads and records a visible safe reason", async () => {
    const secret = "SYNTHETIC-CONTENT-DO-NOT-EXPOSE";
    const builder = createSourcePacketBuilder();
    await builder.addSource(
      fixtureSource({
        content: secret,
        rights: {
          mayStore: "allowed",
          mayDisplay: "denied",
          maySendToModel: "denied",
          permissionBasis: "storage-only fixture decision",
          checkedAt: PACKET_CHECKED_AT,
        },
      }),
    );

    const review = await builder.getReviewSnapshot();
    const model = await builder.getModelPayload();
    expect(JSON.stringify(review)).not.toContain(secret);
    expect(JSON.stringify(model)).not.toContain(secret);
    expect(review.sources[0]?.content).toEqual({
      status: "blocked",
      reason: "display_permission_denied",
      chunks: [],
    });
    expect(review.sources[0]?.permissionBasis).toBe(
      "storage-only fixture decision",
    );
  });
});

describe("exact content hashing and immutable chunks", () => {
  it("hashes exact UTF-8 bytes without normalizing Unicode, newlines, or null bytes", () => {
    const values = [
      "\u00e9",
      "e\u0301",
      "\ud83d\ude00",
      "line one\nline two",
      "line one\r\nline two",
      "left\u0000right",
    ];

    for (const value of values) {
      expect(sha256Utf8(value)).toBe(expectedUtf8Hash(value));
    }
    expect(sha256Utf8("\u00e9")).not.toBe(sha256Utf8("e\u0301"));
    expect(sha256Utf8("a\nb")).not.toBe(sha256Utf8("a\r\nb"));
    expect(() => sha256Utf8("\ud800")).toThrow(PacketMutationError);
    expect(() => sha256Utf8("\udc00")).toThrow(PacketMutationError);
  });

  it("splits on Unicode scalar boundaries with exact byte locations and tamper-evident hashes", async () => {
    const content = "A\ud83d\ude00B\nC\u0000D";
    const builder = createSourcePacketBuilder({
      limits: { maxChunkBytes: 5 },
    });
    await builder.addSource(fixtureSource({ content }));

    const review = await builder.getReviewSnapshot();
    const chunks = review.sources[0]?.content.chunks ?? [];
    expect(chunks.map(({ text }) => text).join("")).toBe(content);
    expect(chunks).toEqual([
      expect.objectContaining({
        text: "A\ud83d\ude00",
        location: "approved fixture excerpt [UTF-8 bytes 0-5)",
        contentHash: expectedUtf8Hash("A\ud83d\ude00"),
      }),
      expect.objectContaining({
        text: "B\nC\u0000D",
        location: "approved fixture excerpt [UTF-8 bytes 5-10)",
        contentHash: expectedUtf8Hash("B\nC\u0000D"),
      }),
    ]);
    expect(sha256Utf8(`${chunks[0]?.text}tampered`)).not.toBe(
      chunks[0]?.contentHash,
    );
  });

  it("rejects invalid content/surrogates and enforces source, content, and chunk bounds", async () => {
    const invalid = createSourcePacketBuilder({
      limits: {
        maxSources: 1,
        maxContentBytes: 8,
        maxChunkBytes: 4,
        maxChunks: 2,
      },
    });
    await expect(
      invalid.addSource(fixtureSource({ content: "\ud800" })),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_content",
    });
    await expect(
      invalid.addSource(fixtureSource({ content: "123456789" })),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "content_limit_exceeded",
    });
    await expect(
      invalid.addSource(fixtureSource({ content: "12345678" })),
    ).resolves.toMatchObject({ status: "stored" });
    await expect(
      invalid.addSource(
        fixtureSource({
          id: "fixture-source-2",
          stableId: "fixture:source:2",
          doi: "10.5555/packet.2",
          url: "https://example.test/articles/packet-2",
          content: "ok",
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "packet_source_limit_exceeded",
    });
  });

  it("deep-copies caller input and returns deeply frozen snapshots", async () => {
    const authors = ["Ada Lovelace", "Grace Hopper"];
    const warnings = ["fixture evidence only"];
    const rights = {
      mayStore: "allowed" as const,
      mayDisplay: "allowed" as const,
      maySendToModel: "allowed" as const,
      permissionBasis: "explicit fixture approval",
      checkedAt: PACKET_CHECKED_AT,
    };
    const input = fixtureSource({
      authors,
      warnings,
      rights,
      content: "immutable input",
    });
    const builder = createSourcePacketBuilder();
    await builder.addSource(input);

    authors.reverse();
    warnings.push("caller mutation");
    rights.permissionBasis = "caller mutation";
    input.content = "caller mutation";

    const review = await builder.getReviewSnapshot();
    expect(review.sources[0]).toMatchObject({
      authors: ["Ada Lovelace", "Grace Hopper"],
      warnings: ["fixture evidence only"],
      permissionBasis: "explicit fixture approval",
      content: {
        chunks: [expect.objectContaining({ text: "immutable input" })],
      },
    });
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(review.sources)).toBe(true);
    expect(Object.isFrozen(review.sources[0])).toBe(true);
    expect(Object.isFrozen(review.sources[0]?.content.chunks)).toBe(true);
  });
});

describe("canonical builder-owned input boundary", () => {
  const malformedCases: Array<[
    string,
    () => Partial<SourceIngestionInput>,
    "invalid_identifier" | "invalid_metadata",
  ]> = [
    ["empty primary ID", () => ({ id: "" }), "invalid_identifier"],
    ["newline primary ID", () => ({ id: "source\npoison" }), "invalid_identifier"],
    ["NUL primary ID", () => ({ id: "source\u0000poison" }), "invalid_identifier"],
    ["surrogate primary ID", () => ({ id: "\ud800" }), "invalid_identifier"],
    ["blank original input", () => ({ originalInput: "   " }), "invalid_metadata"],
    ["newline title", () => ({ title: "unsafe\ntitle" }), "invalid_metadata"],
    ["NUL author", () => ({ authors: ["Ada\u0000Lovelace"] }), "invalid_metadata"],
    ["empty author", () => ({ authors: [""] }), "invalid_metadata"],
    ["control venue", () => ({ venue: "venue\u0001" }), "invalid_metadata"],
    ["newline provider", () => ({ provider: "fixture\nprovider" }), "invalid_metadata"],
    ["surrogate location", () => ({ location: "page \ud800" }), "invalid_metadata"],
    ["newline warning", () => ({ warnings: ["warning\npoison"] }), "invalid_metadata"],
    [
      "control permission basis",
      () => ({
        rights: {
          mayStore: "allowed",
          mayDisplay: "allowed",
          maySendToModel: "allowed",
          permissionBasis: "basis\u0000poison",
          checkedAt: PACKET_CHECKED_AT,
        },
      }),
      "invalid_metadata",
    ],
    [
      "control DOI resolution metadata",
      () => ({
        doiResolution: {
          syntax: "valid",
          resolution: "resolved",
          registrationAgency: "Crossref\u0000",
          checkedAt: PACKET_CHECKED_AT,
        },
      }),
      "invalid_metadata",
    ],
    [
      "newline verification diff",
      () => ({
        metadataVerification: {
          status: "mismatch",
          method: "fixture",
          checkedAt: PACKET_CHECKED_AT,
          fieldDiffs: [
            {
              field: "title\npoison",
              expected: "Expected title",
              observed: "Observed title",
            },
          ],
        },
      }),
      "invalid_metadata",
    ],
    [
      "surrogate integrity notice",
      () => ({
        integrityNotices: [
          {
            kind: "update",
            noticeUrl: "https://example.test/notices/\ud800",
            affectsSource: true,
            checkedAt: PACKET_CHECKED_AT,
          },
        ],
      }),
      "invalid_metadata",
    ],
  ];

  it.each(malformedCases)(
    "rejects %s before state mutation or chunk construction",
    async (_label, overrides, expectedCode) => {
      const events: unknown[] = [];
      const builder = createSourcePacketBuilder({
        log: (event) => events.push(event),
      });

      const rejectedResult = await builder.addSource(
        fixtureSource(overrides()),
      );
      expect(rejectedResult).toMatchObject({
        status: "rejected",
        code: expectedCode,
        canonicalSourceId: null,
      });
      expect(rejectedResult.safeMetadata.requestedSourceId).toMatch(
        /^(?:|[A-Za-z0-9][A-Za-z0-9._:/-]{0,255})$/u,
      );
      expect(rejectedResult.safeMetadata.title).not.toMatch(/\p{Cc}/u);
      expect(
        rejectedResult.safeMetadata.permissionBasis ?? "safe",
      ).not.toMatch(/\p{Cc}/u);
      expect((await builder.getReviewSnapshot()).sources).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({
          service: "source_packet",
          operation: "add",
          outcome: "rejected",
          code: expectedCode,
          sourceCount: 0,
          chunkCount: 0,
        }),
      ]);

      await expect(builder.addSource(fixtureSource())).resolves.toMatchObject({
        status: "stored",
      });
      await expect(
        builder.freeze({
          frozenAt: PACKET_FROZEN_AT,
          freezeDecision: packetFreezeDecision(),
        }),
      ).resolves.toMatchObject({ sourceCount: 1, chunkCount: 1 });
    },
  );

  it("rejects malformed alias near-collisions without merging or poisoning a valid source", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());

    for (const id of [
      "fixture-source-1 ",
      "fixture-source-1\n",
      "fixture-source-1\u0000",
      "fixture-source-\ud800",
    ]) {
      await expect(
        builder.addSource(
          fixtureSource({ id, stableId: `alias:${id}` }),
        ),
      ).resolves.toMatchObject({
        status: "rejected",
        code: "invalid_identifier",
      });
    }
    await expect(
      builder.addSource(
        fixtureSource({
          id: "well-formed-alias-id",
          stableId: " fixture:source:1 ",
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_identifier",
    });

    const review = await builder.getReviewSnapshot();
    expect(review.sources).toHaveLength(1);
    expect(review.sources[0]?.mergedSourceIds).toEqual([]);
    await expect(
      builder.freeze({
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision(),
      }),
    ).resolves.toMatchObject({ sourceCount: 1 });
  });

  it("snapshots every nested add input synchronously before queued work can observe mutation", async () => {
    const original = fixtureSource({
      title: "Original title",
      authors: ["Original author"],
      warnings: ["Original warning"],
      content: "Original content",
      doiResolution: {
        syntax: "valid",
        resolution: "resolved",
        registrationAgency: "Crossref",
        checkedAt: PACKET_CHECKED_AT,
      },
      metadataVerification: {
        status: "match",
        method: "fixture comparison",
        checkedAt: PACKET_CHECKED_AT,
        fieldDiffs: [
          {
            field: "title",
            expected: "Original title",
            observed: "Original title",
          },
        ],
      },
      integrityNotices: [
        {
          kind: "update",
          noticeUrl: "https://example.test/notices/original",
          affectsSource: false,
          checkedAt: PACKET_CHECKED_AT,
        },
      ],
    });
    const expected = structuredClone(original);
    const builder = createSourcePacketBuilder();
    const control = createSourcePacketBuilder();

    const adding = builder.addSource(original);
    original.title = "Mutated title";
    (original.authors as string[])[0] = "Mutated author";
    (original.warnings as string[])[0] = "Mutated warning";
    original.content = "Mutated content";
    original.rights!.permissionBasis = "mutated basis";
    original.doiResolution!.registrationAgency = "DataCite";
    original.metadataVerification!.method = "mutated method";
    original.metadataVerification!.fieldDiffs[0]!.field = "mutated field";
    original.integrityNotices![0]!.noticeUrl =
      "https://example.test/notices/mutated";

    await expect(adding).resolves.toMatchObject({ status: "stored" });
    await control.addSource(expected);
    const freezeInput = {
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    };
    const [actualFrozen, expectedFrozen] = await Promise.all([
      builder.freeze(freezeInput),
      control.freeze(structuredClone(freezeInput)),
    ]);
    expect(actualFrozen.frozenEnvelopeHash).toBe(
      expectedFrozen.frozenEnvelopeHash,
    );
    expect(actualFrozen.review).toEqual(expectedFrozen.review);
    expect(actualFrozen.modelPayload).toEqual(expectedFrozen.modelPayload);
  });

  it("snapshots add and freeze inputs at invocation across queued operation orders", async () => {
    const builder = createSourcePacketBuilder();
    const source = fixtureSource({ content: "queued original content" });
    const freezeInput = {
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision({
        edits: ["original edit"],
        unresolvedObjections: ["original objection"],
      }),
    };

    const adding = builder.addSource(source);
    const freezing = builder.freeze(freezeInput);
    source.content = "synchronously mutated content";
    (source.authors as string[])[0] = "synchronously mutated author";
    freezeInput.frozenAt = "2026-08-06T13:00:00.000Z";
    freezeInput.freezeDecision.id = "mutated-decision";
    freezeInput.freezeDecision.optionsShown[0] = "mutated option";
    freezeInput.freezeDecision.edits[0] = "mutated edit";
    freezeInput.freezeDecision.unresolvedObjections[0] =
      "mutated objection";

    await expect(adding).resolves.toMatchObject({ status: "stored" });
    const frozen = await freezing;
    expect(frozen.packet.frozenAt).toBe(PACKET_FROZEN_AT);
    expect(frozen.packet.freezeDecision).toEqual(
      packetFreezeDecision({
        edits: ["original edit"],
        unresolvedObjections: ["original objection"],
      }),
    );
    expect(frozen.review.sources[0]?.authors[0]).toBe("Ada Lovelace");
    expect(frozen.review.sources[0]?.content.chunks[0]?.text).toBe(
      "queued original content",
    );
  });

  it("rejects malformed edit and permission strings before they enter packet state", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());
    await expect(
      builder.editSource("fixture-source-1", {
        title: "malformed\ntitle",
      }),
    ).rejects.toMatchObject({
      name: "PacketMutationError",
      code: "invalid_edit",
      operation: "edit",
    });
    await expect(
      builder.changePermissions("fixture-source-1", {
        mayStore: "allowed",
        mayDisplay: "allowed",
        maySendToModel: "allowed",
        permissionBasis: "malformed\u0000basis",
        checkedAt: PACKET_CHECKED_AT,
      }),
    ).rejects.toMatchObject({
      name: "PacketMutationError",
      code: "invalid_permissions",
      operation: "change_permissions",
    });

    const review = await builder.getReviewSnapshot();
    expect(review.sources[0]).toMatchObject({
      title: "Bounded synthetic evidence",
      permissionBasis: "author-created fixture approved for this test",
    });
    await expect(
      builder.freeze({
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision(),
      }),
    ).resolves.toMatchObject({ sourceCount: 1 });
  });
});

describe("conservative identity and alias handling", () => {
  it("deduplicates only exact normalized DOI/URL aliases and keeps alias IDs unique", async () => {
    const builder = createSourcePacketBuilder();
    await expect(
      builder.addSource(
        fixtureSource({
          id: "source-primary",
          stableId: "provider:primary",
          doi: " HTTPS://DOI.ORG/10.5555/PACKET.1 ",
          url: "https://EXAMPLE.test/article?a=1&b=2#section",
        }),
      ),
    ).resolves.toMatchObject({
      status: "stored",
      canonicalSourceId: "source-primary",
    });
    await expect(
      builder.addSource(
        fixtureSource({
          id: "source-alias",
          stableId: "provider:alias",
          doi: "doi:10.5555/packet.1",
          url: "https://example.test/article?b=2&a=1",
        }),
      ),
    ).resolves.toMatchObject({
      status: "deduplicated",
      canonicalSourceId: "source-primary",
    });
    await expect(
      builder.addSource(
        fixtureSource({
          id: "source-alias",
          stableId: "provider:alias",
          doi: "10.5555/packet.1",
        }),
      ),
    ).resolves.toMatchObject({
      status: "deduplicated",
      canonicalSourceId: "source-primary",
    });

    const review = await builder.getReviewSnapshot();
    expect(review.sources).toHaveLength(1);
    expect(review.sources[0]?.mergedSourceIds).toEqual(["source-alias"]);
    expect(review.sources[0]?.canonicalDoi).toBe("10.5555/packet.1");
    expect(review.sources[0]?.canonicalUrl).toBe(
      "https://doi.org/10.5555%2Fpacket.1",
    );
  });

  it("does not merge merely similar records and rejects identifier collisions or missing stable IDs", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(
      fixtureSource({
        id: "similar-1",
        stableId: "provider:similar:1",
        doi: null,
        url: "https://example.test/similar/1",
        title: "Nearly identical title",
      }),
    );
    await builder.addSource(
      fixtureSource({
        id: "similar-2",
        stableId: "provider:similar:2",
        doi: null,
        url: "https://example.test/similar/2",
        title: "Nearly identical title!",
      }),
    );
    expect((await builder.getReviewSnapshot()).sources).toHaveLength(2);

    await expect(
      builder.addSource(
        fixtureSource({
          id: "collision",
          stableId: "provider:similar:1",
          doi: "10.5555/conflicting-doi",
          url: "https://example.test/similar/1",
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "identity_collision",
    });
    await expect(
      builder.addSource(
        fixtureSource({
          id: "missing-identity",
          stableId: null,
          doi: null,
          url: null,
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "stable_identifier_missing",
    });
  });

  it("rejects same-identity aliases with changed content or permissions", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());

    await expect(
      builder.addSource(
        fixtureSource({
          id: "changed-content",
          stableId: "fixture:changed-content",
          content: "different excerpt",
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "alias_conflict",
    });
    await expect(
      builder.addSource(
        fixtureSource({
          id: "changed-rights",
          stableId: "fixture:changed-rights",
          rights: {
            mayStore: "allowed",
            mayDisplay: "denied",
            maySendToModel: "allowed",
            permissionBasis: "different decision",
            checkedAt: PACKET_CHECKED_AT,
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "alias_conflict",
    });
    expect((await builder.getReviewSnapshot()).sources).toHaveLength(1);
  });
});

describe("deterministic packet freeze and mutation boundary", () => {
  it("uses the frozen RFC 8785 hash-set contract independent of input and object property order", async () => {
    const first = createSourcePacketBuilder();
    const second = createSourcePacketBuilder();
    const sourceA = fixtureSource({
      id: "source-a",
      stableId: "fixture:a",
      doi: "10.5555/a",
      url: "https://example.test/sources/a",
      content: "ordered source A",
    });
    const sourceB = fixtureSource({
      id: "source-b",
      stableId: "fixture:b",
      doi: "10.5555/b",
      url: "https://example.test/sources/b",
      content: "ordered source B",
    });
    await first.addSource(sourceA);
    await first.addSource(sourceB);
    await second.addSource(sourceB);
    await second.addSource(sourceA);

    const decisionA = packetFreezeDecision();
    const decisionB = {
      unresolvedObjections: [],
      edits: [],
      decision: "approve",
      optionsShown: ["approve packet", "return to source review"],
      checkpoint: "packet_freeze" as const,
      decidedAt: PACKET_FROZEN_AT,
      id: "fixture-packet-freeze",
    };
    const frozenA = await first.freeze({
      packetVersion: 1,
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: decisionA,
    });
    const frozenB = await second.freeze({
      freezeDecision: decisionB,
      frozenAt: PACKET_FROZEN_AT,
      packetVersion: 1,
    });

    expect(frozenA.packet).toEqual(frozenB.packet);
    expect(frozenA.packet.fingerprint).toBe(frozenB.packet.fingerprint);
    expect(frozenA.packet.sourceHashes).toEqual(
      [...frozenA.packet.sourceHashes].sort(),
    );
    expect(frozenA.packet.chunkHashes).toEqual(
      [...frozenA.packet.chunkHashes].sort(),
    );
    expect(PacketFreezeSchema.parse(frozenA.packet)).toEqual(frozenA.packet);

    const semanticallyReordered = createSourcePacketBuilder();
    await semanticallyReordered.addSource(sourceA);
    await semanticallyReordered.addSource(sourceB);
    const changed = await semanticallyReordered.freeze({
      packetVersion: 1,
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision({
        optionsShown: ["return to source review", "approve packet"],
      }),
    });
    expect(changed.packet.fingerprint).not.toBe(
      frozenA.packet.fingerprint,
    );
  });

  it("detects packet, chunk, and frozen-envelope tampering", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());
    const frozen = await builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    const review = await builder.getReviewSnapshot();
    const chunk = review.sources[0]?.content.chunks[0];
    expect(chunk).toBeDefined();
    expect(sha256Utf8(chunk!.text)).toBe(chunk!.contentHash);
    expect(sha256Utf8(`${chunk!.text}x`)).not.toBe(chunk!.contentHash);
    expect(
      PacketFreezeSchema.safeParse({
        ...frozen.packet,
        fingerprint: "0".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      await builder.verifyFrozenEnvelope(frozen.frozenEnvelopeHash),
    ).toEqual({ status: "verified" });
    expect(
      await builder.verifyFrozenEnvelope("0".repeat(64)),
    ).toEqual({ status: "tampered" });
  });

  it("deep-freezes returned packet data and makes same-decision freeze retries deterministic", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());
    const input = {
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    };
    const first = await builder.freeze(input);
    const second = await builder.freeze(input);

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.packet)).toBe(true);
    expect(Object.isFrozen(first.review.sources)).toBe(true);
    expect(await builder.getAuditLog()).toEqual([]);
  });

  it("serializes concurrent freeze/mutation and leaves no race-dependent partial state", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());
    const frozenPromise = builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    const lateAddPromise = builder.addSource(
      fixtureSource({
        id: "late-source",
        stableId: "fixture:late",
        doi: "10.5555/late",
      }),
    );

    const frozen = await frozenPromise;
    await expect(lateAddPromise).rejects.toMatchObject({
      name: "PacketMutationError",
      code: "packet_frozen",
      operation: "add",
    });
    expect(frozen.sourceCount).toBe(1);
    expect((await builder.getReviewSnapshot()).sources).toHaveLength(1);

    const addFirst = createSourcePacketBuilder();
    const addPromise = addFirst.addSource(fixtureSource());
    const freezeAfterAdd = addFirst.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    await expect(addPromise).resolves.toMatchObject({ status: "stored" });
    await expect(freezeAfterAdd).resolves.toMatchObject({ sourceCount: 1 });
  });

  it("rejects and audits every post-freeze mutation without changing frozen bytes or fingerprint", async () => {
    const events: unknown[] = [];
    const builder = createSourcePacketBuilder({
      now: () => new Date(PACKET_FROZEN_AT),
      log: (event) => events.push(event),
    });
    await builder.addSource(
      fixtureSource({
        originalInput:
          "https://example.test/sensitive?marker=never-log-this",
        content: "SENSITIVE-EXCERPT-NEVER-LOG",
      }),
    );
    const frozen = await builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });

    const attempts = [
      builder.addSource(
        fixtureSource({
          id: "late",
          stableId: "fixture:late",
          doi: "10.5555/late",
          content: "LATE-SENSITIVE-CONTENT-NEVER-LOG",
        }),
      ),
      builder.addSource(
        fixtureSource({
          id: "\ud800",
          stableId: "fixture:malformed-id",
          doi: "10.5555/malformed-id",
        }),
      ),
      builder.editSource("fixture-source-1", {
        title: "post-freeze edit",
      }),
      builder.deleteSource("fixture-source-1"),
      builder.changePermissions("fixture-source-1", {
        mayStore: "denied",
        mayDisplay: "denied",
        maySendToModel: "denied",
        permissionBasis: "post-freeze permission change",
        checkedAt: PACKET_CHECKED_AT,
      }),
    ];
    const settled = await Promise.allSettled(attempts);
    expect(settled).toHaveLength(5);
    for (const result of settled) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          name: "PacketMutationError",
          code: "packet_frozen",
        }),
      });
    }

    const after = await builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    expect(after.packet.fingerprint).toBe(frozen.packet.fingerprint);
    expect(after.frozenEnvelopeHash).toBe(frozen.frozenEnvelopeHash);
    expect(await builder.verifyFrozenEnvelope(frozen.frozenEnvelopeHash)).toEqual(
      { status: "verified" },
    );

    const audit = await builder.getAuditLog();
    expect(audit.map(({ operation }) => operation)).toEqual([
      "add",
      "add",
      "edit",
      "delete",
      "change_permissions",
    ]);
    expect(audit.every(({ code }) => code === "packet_frozen")).toBe(true);
    const serialized = JSON.stringify({ audit, events });
    for (const forbidden of [
      "SENSITIVE-EXCERPT",
      "LATE-SENSITIVE-CONTENT",
      "never-log-this",
      "post-freeze edit",
      "post-freeze permission change",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects a conflicting freeze retry while preserving the original packet", async () => {
    const builder = createSourcePacketBuilder();
    await builder.addSource(fixtureSource());
    const frozen = await builder.freeze({
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    });
    await expect(
      builder.freeze({
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision({
          id: "different-decision",
        }),
      }),
    ).rejects.toMatchObject({
      name: "PacketMutationError",
      code: "freeze_conflict",
      operation: "freeze",
    });
    expect(
      (
        await builder.freeze({
          frozenAt: PACKET_FROZEN_AT,
          freezeDecision: packetFreezeDecision(),
        })
      ).packet.fingerprint,
    ).toBe(frozen.packet.fingerprint);
  });

  it("routes hostile frozen retries through typed sanitized audit before canonicalization", async () => {
    const events: unknown[] = [];
    const builder = createSourcePacketBuilder({
      now: () => new Date(PACKET_FROZEN_AT),
      log: (event) => events.push(event),
    });
    await builder.addSource(fixtureSource());
    const originalInput = {
      frozenAt: PACKET_FROZEN_AT,
      freezeDecision: packetFreezeDecision(),
    };
    const frozen = await builder.freeze(originalInput);

    const hostileInputs = [
      {
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision({ id: "hostile-\ud800" }),
      },
      {
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision({
          optionsShown: ["approve\u0000poison"],
        }),
      },
      {
        frozenAt: PACKET_FROZEN_AT,
        freezeDecision: packetFreezeDecision({
          edits: ["hostile\ncontent"],
        }),
      },
    ];
    for (const hostile of hostileInputs) {
      await expect(builder.freeze(hostile)).rejects.toMatchObject({
        name: "PacketMutationError",
        code: "freeze_conflict",
        operation: "freeze",
      });
    }

    const retryInput = structuredClone(originalInput);
    const retrying = builder.freeze(retryInput);
    retryInput.freezeDecision.id = "synchronously-mutated-hostile-\ud800";
    await expect(retrying).resolves.toEqual(frozen);

    const after = await builder.freeze(originalInput);
    expect(after.packet.fingerprint).toBe(frozen.packet.fingerprint);
    expect(after.frozenEnvelopeHash).toBe(frozen.frozenEnvelopeHash);
    expect(await builder.verifyFrozenEnvelope(frozen.frozenEnvelopeHash)).toEqual(
      { status: "verified" },
    );
    const audit = await builder.getAuditLog();
    expect(audit.map(({ operation, code }) => ({ operation, code }))).toEqual([
      { operation: "freeze", code: "freeze_conflict" },
      { operation: "freeze", code: "freeze_conflict" },
      { operation: "freeze", code: "freeze_conflict" },
    ]);
    const serializedAudit = JSON.stringify({ audit, events });
    for (const hostile of [
      "hostile-",
      "approve",
      "poison",
      "hostile",
      "synchronously-mutated-hostile",
    ]) {
      expect(serializedAudit).not.toContain(hostile);
    }
  });
});
