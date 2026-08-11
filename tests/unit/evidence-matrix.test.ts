import { describe, expect, it } from "vitest";

import type { ResearchRun } from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  buildEvidenceMatrixModel,
  buildEvidenceMatrixScenarioModel,
} from "../../src/features/workbench/evidence-matrix-state";
import { validateExecutionHistory } from "../../src/server/workflow/state-machine";

function cloneRun(): ResearchRun {
  return structuredClone(goldenRunV01);
}

function expectGraphError(run: ResearchRun) {
  expect(buildEvidenceMatrixModel(run)).toMatchObject({
    state: "error",
    error: { code: "matrix_cross_link_invalid" },
    rows: [],
    sources: [],
  });
}

describe("evidence matrix state", () => {
  it("sorts claim rows canonically rather than trusting caller array order", () => {
    const run = cloneRun();
    run.claims.reverse();

    expect(buildEvidenceMatrixModel(run).rows.map(({ claim }) => claim.id)).toEqual(
      goldenRunV01.claims.map(({ id }) => id).sort(),
    );
  });

  it("builds claim rows, deterministic source columns, and every relationship cell", () => {
    const run = cloneRun();
    run.sources.reverse();
    run.chunks.reverse();
    run.evidenceCards.reverse();

    const model = buildEvidenceMatrixModel(run);

    expect(model.state).toBe("ready");
    expect(model.rows.map(({ claim }) => claim.id)).toEqual(
      goldenRunV01.claims.map(({ id }) => id).sort(),
    );
    expect(model.sources.map(({ id }) => id)).toEqual(
      goldenRunV01.sources.map(({ id }) => id).sort(),
    );
    expect(model.rows.flatMap(({ cells }) => cells)).toHaveLength(
      goldenRunV01.claims.length * goldenRunV01.sources.length,
    );
    expect(
      model.rows.flatMap(({ cells }) => cells).map(({ relationship }) => relationship),
    ).toEqual(expect.arrayContaining(["supports", "contradicts", "unresolved", "missing"]));
    expect(model.summary).toEqual({
      claimCount: 3,
      sourceCount: 7,
      evidenceCount: 7,
      missingCount: 14,
    });
  });

  it("projects a deterministic source ledger and keeps every verification layer distinct", () => {
    const run = cloneRun();
    const source = run.sources[0]!;
    const card = run.evidenceCards[0]!;
    const cell = buildEvidenceMatrixModel(run).rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes(card.id))!;

    expect(cell.sourceLedger).toEqual({
      state: "available",
      sourceId: source.id,
      title: source.bibliographicMetadata.title,
      identifier: {
        value: source.canonicalDoi,
        href: source.canonicalUrl,
      },
      contentScope: source.access.contentScope,
      identifierResolution: structuredClone(source.doiResolution),
      accessDetails: {
        state: "available",
        provider: source.access.provider,
        version: source.access.version,
        location: source.access.location,
        retrievedAt: source.access.retrievedAt,
      },
      metadataVerification: {
        status: source.metadataVerification.status,
        details: {
          state: "available",
          method: source.metadataVerification.method,
          checkedAt: source.metadataVerification.checkedAt,
          fieldDiffs: structuredClone(source.metadataVerification.fieldDiffs),
        },
      },
      integrityNotices: [],
      sourceWarnings: [...source.warnings],
    });
    expect(cell.evidence[0]).toMatchObject({
      state: "available",
      excerpt: card.excerpt,
      settingAndSample: card.settingAndSample,
      studyType: card.studyType,
      deterministicVerification: structuredClone(card.deterministicVerification),
      modelAssessment: structuredClone(card.modelAssessment),
      humanReview: structuredClone(card.humanReview),
      limitation: card.limitation,
      conclusionStrengthWarning: card.conclusionStrengthWarning,
    });
  });

  it("projects the evidence card's exact permitted excerpt instead of its full source chunk", () => {
    const run = cloneRun();
    const card = run.evidenceCards[0]!;
    const chunk = run.chunks.find(({ id }) => id === card.sourceChunkId)!;
    chunk.text = `Private context before. ${card.excerpt} Private context after.`;

    expect(chunk.text.split(card.excerpt)).toHaveLength(2);

    const cell = buildEvidenceMatrixModel(run).rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes(card.id))!;

    expect(cell.evidence[0]).toMatchObject({
      state: "available",
      excerpt: card.excerpt,
    });
    expect(cell.evidence[0]).not.toMatchObject({ excerpt: chunk.text });
  });

  it("keeps mixed multiple-card relationships and every warning condition explicit", () => {
    const run = cloneRun();
    const duplicate = structuredClone(run.evidenceCards[0]!);
    duplicate.id = "gf-evidence-00-mixed";
    duplicate.relationship = "supports";
    duplicate.deterministicVerification.status = "failed";
    duplicate.extractionIssues = ["Mixed-card deterministic failure."];
    run.evidenceCards.push(duplicate);

    const cell = buildEvidenceMatrixModel(run).rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes(duplicate.id))!;

    expect(cell).toMatchObject({
      relationship: "mixed",
      evidenceCount: 2,
      evidenceIds: ["gf-evidence-00-mixed", "gf-evidence-01"],
      warningConditions: [
        { kind: "failure", label: "Verification failure" },
        { kind: "mismatch", label: "Metadata mismatch" },
        { kind: "warning", label: "Multiple evidence records" },
      ],
    });
  });

  it("represents missing optional ledger and review layers without inventing success", () => {
    const run = cloneRun();
    const source = run.sources[1]!;
    source.canonicalDoi = null;
    source.canonicalUrl = null;
    source.doiResolution = {
      syntax: "not_provided",
      resolution: "not_checked",
      registrationAgency: null,
      checkedAt: null,
    };
    source.metadataVerification = {
      status: "not_checked",
      method: "No metadata check was run.",
      checkedAt: null,
      fieldDiffs: [],
    };
    const card = run.evidenceCards.find(({ sourceChunkId }) =>
      run.chunks.find(({ id }) => id === sourceChunkId)?.sourceId === source.id,
    )!;
    card.conclusionStrengthWarning = null;
    card.humanReview = {
      status: "unreviewed",
      reason: null,
      reviewedAt: null,
      reviewerId: null,
    };

    const cell = buildEvidenceMatrixModel(run).rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes(card.id))!;

    expect(cell.sourceLedger).toMatchObject({
      state: "available",
      identifier: { value: source.id, href: null },
      identifierResolution: {
        resolution: "not_checked",
        registrationAgency: null,
        checkedAt: null,
      },
      metadataVerification: {
        status: "not_checked",
        details: { state: "available", checkedAt: null, fieldDiffs: [] },
      },
      integrityNotices: [],
    });
    expect(cell.evidence[0]).toMatchObject({
      state: "available",
      conclusionStrengthWarning: null,
      humanReview: { status: "unreviewed", reason: null, reviewedAt: null, reviewerId: null },
    });
  });

  it("canonicalizes ledger collections and owns every nested projected value", () => {
    const run = cloneRun();
    const source = run.sources[0]!;
    source.metadataVerification.fieldDiffs.push({
      field: "authors",
      expected: "Canonical author",
      observed: "Supplied author",
    });
    source.integrityNotices.push(
      {
        kind: "update",
        noticeUrl: "https://example.test/update?tracking=1#notice",
        affectsSource: false,
        checkedAt: "2026-08-08T00:00:00.000Z",
      },
      {
        kind: "correction",
        noticeUrl: "https://example.test/correction",
        affectsSource: true,
        checkedAt: "2026-08-07T00:00:00.000Z",
      },
    );
    source.warnings.push("Earlier warning that should sort first.");
    const reordered = structuredClone(run);
    reordered.sources.reverse();
    reordered.chunks.reverse();
    reordered.evidenceCards.reverse();
    reordered.sources[reordered.sources.findIndex(({ id }) => id === source.id)]!
      .metadataVerification.fieldDiffs.reverse();
    reordered.sources[reordered.sources.findIndex(({ id }) => id === source.id)]!
      .integrityNotices.reverse();
    reordered.sources[reordered.sources.findIndex(({ id }) => id === source.id)]!
      .warnings.reverse();

    const first = buildEvidenceMatrixModel(run);
    const second = buildEvidenceMatrixModel(reordered);
    const firstLedger = first.rows[0]!.cells.find(({ sourceId }) => sourceId === source.id)!.sourceLedger;
    const secondLedger = second.rows[0]!.cells.find(({ sourceId }) => sourceId === source.id)!.sourceLedger;
    expect(secondLedger).toEqual(firstLedger);

    source.metadataVerification.fieldDiffs[0]!.expected = "MUTATED_AFTER_PROJECTION";
    source.integrityNotices[0]!.noticeUrl = "https://example.test/mutated";
    source.warnings[0] = "MUTATED_AFTER_PROJECTION";
    expect(JSON.stringify(firstLedger)).not.toContain("MUTATED_AFTER_PROJECTION");
  });

  it("totally orders and deduplicates integrity notices across collisions and permutations", () => {
    const run = cloneRun();
    const source = run.sources[0]!;
    const collision = {
      kind: "update" as const,
      noticeUrl: "https://example.test/notice?tracking=one#fragment",
      affectsSource: true,
      checkedAt: "2026-08-08T00:00:00.000Z",
    };
    source.integrityNotices = [
      collision,
      { ...collision, affectsSource: false },
      { ...collision },
      { ...collision, checkedAt: "2026-08-08T00:00:01.000Z" },
    ];
    const permuted = structuredClone(run);
    permuted.sources[0]!.integrityNotices = [
      permuted.sources[0]!.integrityNotices[3]!,
      permuted.sources[0]!.integrityNotices[2]!,
      permuted.sources[0]!.integrityNotices[1]!,
      permuted.sources[0]!.integrityNotices[0]!,
    ];

    const project = (value: ResearchRun) => buildEvidenceMatrixModel(value).rows[0]!.cells
      .find(({ sourceId }) => sourceId === source.id)!.sourceLedger;
    const first = project(run);
    const second = project(permuted);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      state: "available",
      integrityNotices: [
        { affectsSource: false, checkedAt: "2026-08-08T00:00:00.000Z" },
        { affectsSource: true, checkedAt: "2026-08-08T00:00:00.000Z" },
        { affectsSource: true, checkedAt: "2026-08-08T00:00:01.000Z" },
      ],
    });
  });

  it("projects only safe HTTP source and integrity links", () => {
    const run = cloneRun();
    const source = run.sources[0]!;
    source.canonicalUrl = "https://user:secret@example.test/source?token=private#fragment";
    source.integrityNotices = [
      {
        kind: "update",
        noticeUrl: "https://example.test/notice?tracking=1#fragment",
        affectsSource: true,
        checkedAt: "2026-08-08T00:00:00.000Z",
      },
      {
        kind: "other",
        noticeUrl: "ftp://example.test/unsafe",
        affectsSource: false,
        checkedAt: "2026-08-08T00:00:01.000Z",
      },
    ];

    const ledger = buildEvidenceMatrixModel(run).rows[0]!.cells
      .find(({ sourceId }) => sourceId === source.id)!.sourceLedger;

    expect(ledger.state).toBe("available");
    if (ledger.state !== "available") throw new Error("Expected an available ledger.");
    expect(ledger.identifier).toEqual({
      value: source.canonicalDoi,
      href: "https://example.test/source",
    });
    expect(ledger.integrityNotices.map(({ href }) => href)).toEqual([
      null,
      "https://example.test/notice",
    ]);
    expect(JSON.stringify(ledger)).not.toContain("secret");
    expect(JSON.stringify(ledger)).not.toContain("token=private");
    expect(JSON.stringify(ledger)).not.toContain("ftp://");
  });

  it("keeps metadata mismatch and verification failure separate from entailment", () => {
    const run = cloneRun();
    run.evidenceCards[2]!.deterministicVerification.status = "failed";
    run.evidenceCards[2]!.extractionIssues = ["Exact passage verification failed."];

    const model = buildEvidenceMatrixModel(run);
    const cells = model.rows.flatMap(({ cells }) => cells);
    const mismatch = cells.find(({ sourceId }) => sourceId === "gf-source-01");
    const failure = cells.find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-03"));

    expect(mismatch).toMatchObject({
      relationship: "contradicts",
      warningState: "mismatch",
      warningLabel: "Metadata mismatch",
    });
    expect(failure).toMatchObject({
      relationship: "supports",
      warningState: "failure",
      warningLabel: "Verification failure",
    });
    expect(failure?.evidence[0]).toMatchObject({
      deterministicVerification: { status: "failed" },
      modelAssessment: { entailment: "partial_support" },
      humanReview: { status: "confirmed" },
    });
  });

  it("preserves simultaneous verification-failure and metadata-mismatch warnings", () => {
    const run = cloneRun();
    run.evidenceCards[0]!.deterministicVerification.status = "failed";
    run.evidenceCards[0]!.extractionIssues = ["Exact verification failed."];

    const cell = buildEvidenceMatrixModel(run).rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-01"));

    expect(cell).toMatchObject({
      relationship: "contradicts",
      warningState: "failure",
      warningLabel: "Verification failure · Metadata mismatch",
      warningConditions: [
        { kind: "failure", label: "Verification failure" },
        { kind: "mismatch", label: "Metadata mismatch" },
      ],
    });
    expect(cell?.accessibleLabel).toContain("Verification failure · Metadata mismatch");
  });

  it.each([
    ["claim", (run: ResearchRun) => run.claims.push(structuredClone(run.claims[0]!))],
    ["source", (run: ResearchRun) => run.sources.push(structuredClone(run.sources[0]!))],
    ["chunk", (run: ResearchRun) => run.chunks.push(structuredClone(run.chunks[0]!))],
    ["evidence card", (run: ResearchRun) => run.evidenceCards.push(structuredClone(run.evidenceCards[0]!))],
  ])("fails closed on a duplicate %s ID before projection", (_label, duplicate) => {
    const run = cloneRun();
    duplicate(run);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_identity_duplicate" },
      rows: [],
      sources: [],
    });
  });

  it("fails closed when object IDs collide across claim/source/chunk/card collections", () => {
    const run = cloneRun();
    const priorClaimId = run.claims[0]!.id;
    run.claims[0]!.id = run.sources[0]!.id;
    run.evidenceCards.forEach((card) => {
      if (card.subclaimId === priorClaimId) card.subclaimId = run.claims[0]!.id;
    });

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_identity_collision" },
      rows: [],
      sources: [],
    });
  });

  it.each([
    ["research gap", (run: ResearchRun) => run.researchGaps.push(structuredClone(run.researchGaps[0]!))],
    ["execution", (run: ResearchRun) => run.executions.push(structuredClone(run.executions[0]!))],
    ["error", (run: ResearchRun) => run.errors.push(structuredClone(run.errors[0]!))],
    ["objection", (run: ResearchRun) => run.review!.objections.push(structuredClone(run.review!.objections[0]!))],
  ])("fails closed on a duplicate globally referenced %s ID", (_label, duplicate) => {
    const run = cloneRun();
    duplicate(run);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_identity_duplicate" },
      rows: [],
      sources: [],
    });
  });

  it("fails closed when a projection ID collides with an execution ID", () => {
    const run = cloneRun();
    run.executions[0]!.id = run.sources[0]!.id;

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_identity_collision" },
      rows: [],
      sources: [],
    });
  });

  it("sorts evidence IDs within a cell and exposes a duplicate-card warning", () => {
    const run = cloneRun();
    const duplicate = structuredClone(run.evidenceCards[2]!);
    duplicate.id = "gf-evidence-00-duplicate";
    run.evidenceCards.push(duplicate);

    const model = buildEvidenceMatrixModel(run);
    const cell = model.rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-03"));

    expect(cell).toMatchObject({
      evidenceCount: 2,
      warningState: "warning",
      warningLabel: "Multiple evidence records",
    });
    expect(cell?.evidenceIds).toEqual([
      "gf-evidence-00-duplicate",
      "gf-evidence-03",
    ]);
  });

  it("removes rights-hidden excerpts while retaining an explicit explanation", () => {
    const run = cloneRun();
    run.sources[0]!.rights.mayDisplay = "denied";
    run.chunks[0]!.displayPermission = "denied";

    const model = buildEvidenceMatrixModel(run);
    const cell = model.rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-01"));

    expect(cell?.evidence[0]).toEqual({
      id: "gf-evidence-01",
      state: "hidden",
      reasonCode: "source_display_denied",
    });
    expect(JSON.stringify(cell)).not.toContain(goldenRunV01.evidenceCards[0]!.excerpt);
  });

  it.each(["source rights", "chunk rights", "packet display override"])(
    "removes every denied source-derived field recursively for %s",
    (boundary) => {
      const run = cloneRun();
      const canary = `DENIED_DERIVED_CANARY_${boundary.replaceAll(" ", "_")}`;
      const card = run.evidenceCards[0]!;
      const chunk = run.chunks.find(({ id }) => id === card.sourceChunkId)!;
      const source = run.sources.find(({ id }) => id === chunk.sourceId)!;
      card.excerpt = canary;
      card.extractedResult = canary;
      card.limitation = canary;
      card.conclusionStrengthWarning = canary;
      card.extractionIssues = [canary];
      card.modelAssessment.rationale = canary;
      card.humanReview.reason = canary;
      chunk.text = canary;

      const overrides = new Map<
        string,
        { state: "hidden"; reasonCode: "packet_display_hidden" }
      >();
      if (boundary === "source rights") source.rights.mayDisplay = "denied";
      if (boundary === "chunk rights") chunk.displayPermission = "denied";
      if (boundary === "packet display override") {
        overrides.set(source.id, {
          state: "hidden",
          reasonCode: "packet_display_hidden",
        });
      }

      const model = buildEvidenceMatrixModel(run, overrides);
      const cell = model.rows
        .flatMap(({ cells }) => cells)
        .find(({ evidenceIds }) => evidenceIds.includes(card.id));

      expect(model.state).toBe("ready");
      expect(JSON.stringify(model)).not.toContain(canary);
      expect(cell?.evidence[0]).toEqual({
        id: card.id,
        state: "hidden",
        reasonCode:
          boundary === "source rights"
            ? "source_display_denied"
            : boundary === "chunk rights"
              ? "chunk_display_denied"
              : "packet_display_hidden",
      });
    },
  );

  it.each(["source rights", "chunk rights", "packet display override"])(
    "omits every source-ledger free-text and link surface for denied %s even in a zero-card cell",
    (boundary) => {
      const run = cloneRun();
      const canary = `DENIED_LEDGER_CANARY_${boundary.replaceAll(" ", "_")}`;
      const titleCanary = `${canary}_TITLE`;
      const doiCanary = `10.1234/${boundary.replaceAll(" ", "-")}-denied`;
      const sourceUrlCanary = `https://example.test/${canary.toLowerCase()}-source?private=1#fragment`;
      const noticeUrlCanary = `https://example.test/${canary.toLowerCase()}-notice?private=1#fragment`;
      const agencyCanary = `${canary}_REGISTRATION_AGENCY`;
      const source = run.sources[0]!;
      const chunk = run.chunks.find(({ sourceId }) => sourceId === source.id)!;
      source.bibliographicMetadata.title = titleCanary;
      source.canonicalDoi = doiCanary;
      source.canonicalUrl = sourceUrlCanary;
      source.doiResolution.registrationAgency = agencyCanary;
      source.access.provider = canary;
      source.access.version = canary;
      source.access.location = canary;
      source.metadataVerification.method = canary;
      source.metadataVerification.fieldDiffs = [{
        field: "title",
        expected: canary,
        observed: canary,
      }];
      source.warnings = [canary];
      source.integrityNotices = [{
        kind: "update",
        noticeUrl: noticeUrlCanary,
        affectsSource: true,
        checkedAt: "2026-08-08T00:00:00.000Z",
      }];

      const overrides = new Map<
        string,
        { state: "hidden"; reasonCode: "packet_display_hidden" }
      >();
      if (boundary === "source rights") source.rights.mayDisplay = "denied";
      if (boundary === "chunk rights") chunk.displayPermission = "denied";
      if (boundary === "packet display override") {
        overrides.set(source.id, {
          state: "hidden",
          reasonCode: "packet_display_hidden",
        });
      }

      const model = buildEvidenceMatrixModel(run, overrides);
      const zeroCard = model.rows
        .flatMap(({ cells }) => cells)
        .find(({ sourceId, evidenceCount }) => sourceId === source.id && evidenceCount === 0)!;

      const reasonCode = boundary === "source rights"
        ? "source_display_denied"
        : boundary === "chunk rights"
          ? "chunk_display_denied"
          : "packet_display_hidden";
      expect(zeroCard.sourceLedger).toEqual({
        state: "hidden",
        sourceId: source.id,
        reasonCode,
      });
      expect(model.sources.find(({ id }) => id === source.id)).toEqual({
        id: source.id,
        label: "Source 1",
        state: "hidden",
        reasonCode,
      });
      expect(zeroCard).not.toHaveProperty("sourceTitle");
      expect(zeroCard).not.toHaveProperty("sourceIdentifier");
      const serialized = JSON.stringify(model);
      for (const forbidden of [
        canary,
        titleCanary,
        doiCanary,
        agencyCanary,
        new URL(sourceUrlCanary).pathname,
        new URL(noticeUrlCanary).pathname,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );

  it("passively rejects accessor and Proxy-backed integrity records without executing them", () => {
    const accessorRun = cloneRun();
    let getterCalls = 0;
    const accessorNotice = {
      kind: "update" as const,
      noticeUrl: "https://example.test/notice",
      affectsSource: true,
      checkedAt: "2026-08-08T00:00:00.000Z",
    };
    Object.defineProperty(accessorNotice, "noticeUrl", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "https://example.test/ACCESSOR_CANARY";
      },
    });
    accessorRun.sources[0]!.integrityNotices = [accessorNotice];

    const proxyRun = cloneRun();
    let trapCalls = 0;
    proxyRun.sources[0]!.integrityNotices = [new Proxy(
      {
        kind: "update" as const,
        noticeUrl: "https://example.test/notice",
        affectsSource: true,
        checkedAt: "2026-08-08T00:00:00.000Z",
      },
      {
        get(target, key, receiver) {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    )];

    expect(buildEvidenceMatrixModel(accessorRun)).toMatchObject({
      state: "error",
      error: { code: "matrix_input_accessor" },
    });
    expect(buildEvidenceMatrixModel(proxyRun)).toMatchObject({
      state: "error",
      error: { code: "matrix_input_proxy" },
    });
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  it("preserves untrusted source strings only as inert projected text", () => {
    const run = cloneRun();
    const untrusted = '</script><img data-evf-untrusted src="x" onerror="alert(1)">';
    const card = run.evidenceCards[0]!;
    const chunk = run.chunks.find(({ id }) => id === card.sourceChunkId)!;
    chunk.text = untrusted;
    card.excerpt = untrusted;
    card.extractedResult = untrusted;
    card.limitation = untrusted;
    card.modelAssessment.rationale = untrusted;
    card.humanReview.reason = untrusted;

    const model = buildEvidenceMatrixModel(run);
    const evidence = model.rows.flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes(card.id))!.evidence[0]!;

    expect(model.state).toBe("ready");
    expect(evidence).toMatchObject({
      state: "available",
      excerpt: untrusted,
      extractedResult: untrusted,
      limitation: untrusted,
      modelAssessment: { rationale: untrusted },
      humanReview: { reason: untrusted },
    });
  });

  it("passively rejects accessor-backed input without executing the getter", () => {
    const run = cloneRun();
    let getterCalls = 0;
    Object.defineProperty(run.evidenceCards[0]!, "extractedResult", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "ACCESSOR_LEAK";
      },
    });

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_input_accessor" },
    });
    expect(getterCalls).toBe(0);
  });

  it("passively rejects Proxy-backed input without executing proxy traps", () => {
    const run = cloneRun();
    let trapCalls = 0;
    run.evidenceCards[0] = new Proxy(run.evidenceCards[0]!, {
      get(target, key, receiver) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_input_proxy" },
    });
    expect(trapCalls).toBe(0);
  });

  it("owns its projection so later input and model mutations do not alias", () => {
    const run = cloneRun();
    const originalTitle = run.sources[0]!.bibliographicMetadata.title;
    const originalDetails = run.evidenceCards[0]!.deterministicVerification.details;
    const model = buildEvidenceMatrixModel(run);
    const evidence = model.rows
      .flatMap(({ cells }) => cells)
      .find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-01"))!
      .evidence[0]!;

    run.sources[0]!.bibliographicMetadata.title = "MUTATED_INPUT_TITLE";
    expect(model.sources[0]!.state).toBe("available");
    if (model.sources[0]!.state !== "available") throw new Error("Expected an available source.");
    expect(model.sources[0]!.title).toBe(originalTitle);
    if (evidence.state === "available") {
      evidence.deterministicVerification.details = "MUTATED_MODEL_DETAILS";
    }
    expect(run.evidenceCards[0]!.deterministicVerification.details).toBe(originalDetails);
  });

  it("fails closed on a broken evidence cross-link instead of projecting partial content", () => {
    const run = cloneRun();
    run.evidenceCards[0]!.sourceChunkId = "missing-chunk";

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: {
        code: "matrix_cross_link_invalid",
        message: "Evidence gf-evidence-01 does not resolve to an approved source chunk.",
      },
      rows: [],
      sources: [],
    });
  });

  it.each([
    ["claim", (run: ResearchRun) => { run.evidenceCards[0]!.subclaimId = "missing-claim"; }],
    ["chunk", (run: ResearchRun) => { run.evidenceCards[0]!.sourceChunkId = "missing-chunk"; }],
    ["source", (run: ResearchRun) => { run.chunks[0]!.sourceId = "missing-source"; }],
  ])("fails closed when a %s cross-link is missing", (_label, breakLink) => {
    const run = cloneRun();
    breakLink(run);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
      rows: [],
      sources: [],
    });
  });

  it("fails closed on an unreferenced chunk whose source does not exist", () => {
    const run = cloneRun();
    const orphan = structuredClone(run.chunks[0]!);
    orphan.id = "orphan-unreferenced-chunk";
    orphan.sourceId = "missing-source";
    run.chunks.push(orphan);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
      rows: [],
      sources: [],
    });
  });

  it.each([
    ["claim parent", (run: ResearchRun) => { run.claims[0]!.parentClaimId = "missing-claim"; }],
    ["merged source", (run: ResearchRun) => { run.sources[0]!.mergedSourceIds = ["missing-source"]; }],
    ["model execution", (run: ResearchRun) => { run.evidenceCards[0]!.modelAssessment.executionId = "missing-execution"; }],
    ["conclusion claim", (run: ResearchRun) => { run.conclusions[0]!.subclaimId = "missing-claim"; }],
    ["conclusion evidence", (run: ResearchRun) => { run.conclusions[0]!.supportingEvidenceCardIds = ["missing-evidence"]; }],
    ["gap claim", (run: ResearchRun) => { run.researchGaps[0]!.affectedSubclaimIds = ["missing-claim"]; }],
    ["gap evidence", (run: ResearchRun) => { run.researchGaps[0]!.evidenceCardIds = ["missing-evidence"]; }],
    ["selected gap", (run: ResearchRun) => { run.selectedGapId = "missing-gap"; }],
    ["experiment gap", (run: ResearchRun) => { run.experiment!.selectedGapId = "missing-gap"; }],
    ["experiment evidence", (run: ResearchRun) => { run.experiment!.supportingEvidenceCardIds = ["missing-evidence"]; }],
    ["review execution", (run: ResearchRun) => { run.review!.reviewerExecutionId = "missing-execution"; }],
    ["objection evidence", (run: ResearchRun) => { run.review!.objections[0]!.evidenceCardIds = ["missing-evidence"]; }],
    ["revision objection", (run: ResearchRun) => { run.revision!.decisions[0]!.objectionId = "missing-objection"; }],
    ["decision objection", (run: ResearchRun) => { run.finalDecision!.unresolvedObjections = ["missing-objection"]; }],
    ["execution retry", (run: ResearchRun) => { run.executions[0]!.retryOfExecutionId = "missing-execution"; }],
    ["execution object", (run: ResearchRun) => { run.executions[0]!.inputRefs = ["missing-object"]; }],
    ["execution error", (run: ResearchRun) => { run.executions[0]!.errorIds = ["missing-error"]; }],
    ["error execution", (run: ResearchRun) => { run.errors[0]!.executionId = "missing-execution"; }],
  ])("fails closed on a dangling global %s reference", (_label, breakReference) => {
    const run = cloneRun();
    breakReference(run);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
      rows: [],
      sources: [],
    });
  });

  it.each([
    ["claim parent", (run: ResearchRun) => {
      run.claims[0]!.parentClaimId = run.claims[1]!.id;
      run.claims[1]!.parentClaimId = run.claims[0]!.id;
    }],
    ["merged source", (run: ResearchRun) => {
      run.sources[0]!.mergedSourceIds = [run.sources[1]!.id];
      run.sources[1]!.mergedSourceIds = [run.sources[0]!.id];
    }],
    ["execution retry", (run: ResearchRun) => {
      run.executions[0]!.retryOfExecutionId = run.executions[1]!.id;
      run.executions[1]!.retryOfExecutionId = run.executions[0]!.id;
    }],
  ])("fails closed on a %s reference cycle", (_label, makeCycle) => {
    const run = cloneRun();
    makeCycle(run);

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
    });
  });

  it("fails closed on repeated merged-source aliases", () => {
    const run = cloneRun();
    run.sources[0]!.mergedSourceIds = [run.sources[1]!.id, run.sources[1]!.id];

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
    });
  });

  it("fails closed when a model assessment is cross-bound to the wrong existing execution", () => {
    const run = cloneRun();
    const wrongExecution = run.executions.find(({ id }) => id !== run.evidenceCards[0]!.modelAssessment.executionId)!;
    run.evidenceCards[0]!.modelAssessment.executionId = wrongExecution.id;

    expect(buildEvidenceMatrixModel(run)).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
    });
  });

  it.each([
    ["empty conclusion evidence", (run: ResearchRun) => {
      run.conclusions[0]!.supportingEvidenceCardIds = [];
      run.conclusions[0]!.contradictingEvidenceCardIds = [];
    }],
    ["duplicate conclusion evidence", (run: ResearchRun) => {
      const id = run.conclusions[0]!.supportingEvidenceCardIds[0]!;
      run.conclusions[0]!.supportingEvidenceCardIds = [id, id];
    }],
    ["foreign-claim conclusion evidence", (run: ResearchRun) => {
      run.conclusions[0]!.supportingEvidenceCardIds = ["gf-evidence-04"];
    }],
    ["contradictory evidence in supporting refs", (run: ResearchRun) => {
      run.conclusions[0]!.supportingEvidenceCardIds = ["gf-evidence-01"];
      run.conclusions[0]!.contradictingEvidenceCardIds = [];
    }],
    ["supporting evidence in contradicting refs", (run: ResearchRun) => {
      run.conclusions[0]!.contradictingEvidenceCardIds = ["gf-evidence-03"];
    }],
    ["duplicate conclusion for one claim", (run: ResearchRun) => {
      run.conclusions.push(structuredClone(run.conclusions[0]!));
    }],
    ["duplicate gap claim refs", (run: ResearchRun) => {
      run.researchGaps[0]!.affectedSubclaimIds = ["gf-claim-duration", "gf-claim-duration"];
    }],
    ["duplicate gap evidence refs", (run: ResearchRun) => {
      run.researchGaps[0]!.evidenceCardIds = ["gf-evidence-01", "gf-evidence-01"];
    }],
    ["gap evidence outside affected claims", (run: ResearchRun) => {
      run.researchGaps[0]!.affectedSubclaimIds = ["gf-claim-duration"];
      run.researchGaps[0]!.evidenceCardIds = ["gf-evidence-04"];
    }],
    ["duplicate experiment evidence refs", (run: ResearchRun) => {
      run.experiment!.supportingEvidenceCardIds = ["gf-evidence-01", "gf-evidence-01"];
    }],
    ["experiment evidence outside selected-gap claims", (run: ResearchRun) => {
      run.experiment!.supportingEvidenceCardIds = ["gf-evidence-05"];
    }],
    ["selected gap not marked selected", (run: ResearchRun) => {
      run.researchGaps[0]!.selection = "unselected";
    }],
    ["more than one selected gap", (run: ResearchRun) => {
      const other = structuredClone(run.researchGaps[0]!);
      other.id = "gf-gap-other";
      other.rank = 2;
      run.researchGaps.push(other);
    }],
    ["experiment bound to a different existing gap", (run: ResearchRun) => {
      const other = structuredClone(run.researchGaps[0]!);
      other.id = "gf-gap-other";
      other.rank = 2;
      other.selection = "unselected";
      run.researchGaps.push(other);
      run.experiment!.selectedGapId = other.id;
    }],
    ["review execution from another workflow stage", (run: ResearchRun) => {
      run.review!.reviewerExecutionId = "gf-execution-assess-1";
    }],
    ["duplicate objection evidence refs", (run: ResearchRun) => {
      run.review!.objections[0]!.evidenceCardIds = ["gf-evidence-01", "gf-evidence-01"];
    }],
    ["objection evidence outside selected-gap claims", (run: ResearchRun) => {
      run.review!.objections[0]!.evidenceCardIds = ["gf-evidence-05"];
    }],
    ["review execution output missing an objection", (run: ResearchRun) => {
      const execution = run.executions.find(({ id }) => id === run.review!.reviewerExecutionId)!;
      execution.outputRefs = [run.review!.objections[0]!.id];
    }],
    ["revision omits an objection", (run: ResearchRun) => {
      run.revision!.decisions = [run.revision!.decisions[0]!];
    }],
    ["accepted objection without a revision", (run: ResearchRun) => {
      run.revision!.decisions[0]!.revisedValue = null;
    }],
    ["unresolved objection with a fabricated revision", (run: ResearchRun) => {
      run.revision!.decisions[1]!.revisedValue = "fabricated revision";
    }],
    ["duplicate disposition unresolved refs", (run: ResearchRun) => {
      const id = run.objectionDispositionDecision!.unresolvedObjections[0]!;
      run.objectionDispositionDecision!.unresolvedObjections = [id, id];
    }],
    ["disposition unresolved refs disagree with revision", (run: ResearchRun) => {
      run.objectionDispositionDecision!.unresolvedObjections = [];
    }],
    ["duplicate final unresolved refs", (run: ResearchRun) => {
      const id = run.finalDecision!.unresolvedObjections[0]!;
      run.finalDecision!.unresolvedObjections = [id, id];
    }],
    ["final unresolved refs disagree with revision", (run: ResearchRun) => {
      run.finalDecision!.unresolvedObjections = [];
    }],
    ["duplicate execution input refs", (run: ResearchRun) => {
      const execution = run.executions.find(({ inputRefs }) => inputRefs.length > 0)!;
      execution.inputRefs = [execution.inputRefs[0]!, execution.inputRefs[0]!];
    }],
    ["duplicate execution output refs", (run: ResearchRun) => {
      const execution = run.executions.find(({ outputRefs }) => outputRefs.length > 0)!;
      execution.outputRefs = [execution.outputRefs[0]!, execution.outputRefs[0]!];
    }],
    ["duplicate execution error refs", (run: ResearchRun) => {
      const execution = run.executions.find(({ errorIds }) => errorIds.length > 0)!;
      execution.errorIds = [execution.errorIds[0]!, execution.errorIds[0]!];
    }],
    ["error node disagrees with execution", (run: ResearchRun) => {
      run.errors[0]!.nodeId = "another-node";
    }],
    ["duplicate attempt number for a node", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.attempt = 1;
    }],
    ["retry crosses workflow nodes", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.retryOfExecutionId = "gf-execution-review-failure-1";
    }],
    ["retry skips its immediate attempt lineage", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.attempt = 3;
    }],
    ["retry parent did not fail", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-1")!.status = "succeeded";
    }],
    ["same-node attempts are reordered", (run: ResearchRun) => {
      const firstIndex = run.executions.findIndex(({ id }) => id === "gf-execution-plan-1");
      const secondIndex = run.executions.findIndex(({ id }) => id === "gf-execution-plan-2");
      [run.executions[firstIndex], run.executions[secondIndex]] = [
        run.executions[secondIndex]!,
        run.executions[firstIndex]!,
      ];
    }],
    ["failed attempt carries output refs", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-1")!.outputRefs = ["gf-gap-loaded-duration"];
    }],
    ["retry parent has no retryable error", (run: ResearchRun) => {
      run.errors.find(({ id }) => id === "gf-error-plan-1")!.retryable = false;
    }],
    ["succeeded attempt has invalid validation", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.validation.valid = false;
    }],
    ["failed attempt has no linked error", (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-1")!.errorIds = [];
      run.errors = run.errors.filter(({ id }) => id !== "gf-error-plan-1");
    }],
  ])("fails closed on semantic graph defect: %s", (_label, mutate) => {
    const run = cloneRun();
    mutate(run);
    expectGraphError(run);
  });

  it("accepts the contract-valid review-complete state before dispositions and revision", () => {
    const run = cloneRun();
    run.status = "awaiting_objection_dispositions";
    run.objectionDispositionDecision = null;
    run.revision = null;
    run.finalDecision = null;
    run.executions = run.executions.filter(({ nodeId }) => nodeId !== "revise-experiment");

    expect(buildEvidenceMatrixModel(run).state).toBe("ready");
  });

  it.each([
    ["complete golden history", true, (run: ResearchRun) => { void run; }],
    ["review-complete intermediate history", true, (run: ResearchRun) => {
      run.status = "awaiting_objection_dispositions";
      run.objectionDispositionDecision = null;
      run.revision = null;
      run.finalDecision = null;
      run.executions = run.executions.filter(({ nodeId }) => nodeId !== "revise-experiment");
    }],
    ["reordered attempts", false, (run: ResearchRun) => {
      const first = run.executions.findIndex(({ id }) => id === "gf-execution-plan-1");
      const second = run.executions.findIndex(({ id }) => id === "gf-execution-plan-2");
      [run.executions[first], run.executions[second]] = [run.executions[second]!, run.executions[first]!];
    }],
    ["failed output", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-1")!.outputRefs = ["gf-gap-loaded-duration"];
    }],
    ["non-retryable parent", false, (run: ResearchRun) => {
      run.errors.find(({ id }) => id === "gf-error-plan-1")!.retryable = false;
    }],
    ["invalid successful validation", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.validation.valid = false;
    }],
    ["failed without error", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-1")!.errorIds = [];
      run.errors = run.errors.filter(({ id }) => id !== "gf-error-plan-1");
    }],
    ["duplicate attempt", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.attempt = 1;
    }],
    ["retry skips an attempt", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.attempt = 3;
    }],
    ["retry names another node", false, (run: ResearchRun) => {
      run.executions.find(({ id }) => id === "gf-execution-plan-2")!.retryOfExecutionId = "gf-execution-review-failure-1";
    }],
    ["successful attempt carries an error", false, (run: ResearchRun) => {
      const execution = run.executions.find(({ id }) => id === "gf-execution-plan-2")!;
      const error = structuredClone(run.errors.find(({ id }) => id === "gf-error-plan-1")!);
      error.id = "gf-error-plan-2";
      error.executionId = execution.id;
      execution.errorIds = [error.id];
      run.errors.push(error);
    }],
    ["shared-accepted nonadjacent fallback annotation", true, (run: ResearchRun) => {
      run.executions[0]!.fallbackFromExecutionId = run.executions.at(-1)!.id;
    }],
    ["shared-accepted dangling fallback annotation", true, (run: ResearchRun) => {
      run.executions[0]!.fallbackFromExecutionId = "missing-execution";
    }],
  ] as const)("matches authoritative execution-history acceptance: %s", (_label, expected, mutate) => {
    const run = cloneRun();
    mutate(run);
    let authoritativeAccepted = true;
    try {
      validateExecutionHistory(run);
    } catch {
      authoritativeAccepted = false;
    }

    expect(authoritativeAccepted).toBe(expected);
    expect(buildEvidenceMatrixModel(run).state === "ready").toBe(authoritativeAccepted);
  });

  it("accepts only exact discriminated display override shapes", () => {
    const run = cloneRun();
    const available = buildEvidenceMatrixModel(run, new Map([
      [run.sources[0]!.id, { state: "available" as const }],
    ]));
    const hidden = buildEvidenceMatrixModel(run, new Map([
      [run.sources[0]!.id, { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }],
    ]));
    const hiddenEvidence = hidden.rows
      .flatMap(({ cells }) => cells)
      .find(({ sourceId, evidenceCount }) => sourceId === run.sources[0]!.id && evidenceCount > 0)!
      .evidence[0];

    expect(available.state).toBe("ready");
    expect(hidden.state).toBe("ready");
    expect(hiddenEvidence).toEqual({
      id: "gf-evidence-01",
      state: "hidden",
      reasonCode: "packet_display_hidden",
    });
  });

  it.each([
    ["hidden missing reason code", { state: "hidden" }],
    ["hidden arbitrary reason", { state: "hidden", reason: "UNTRUSTED_OVERRIDE_REASON_CANARY" }],
    ["hidden unknown reason code", { state: "hidden", reasonCode: "unknown_reason" }],
    ["hidden unknown field", { state: "hidden", reasonCode: "packet_display_hidden", extra: true }],
    ["available reason code", { state: "available", reasonCode: "packet_display_hidden" }],
    ["available unknown field", { state: "available", extra: true }],
  ])("rejects display override shape: %s", (_label, override) => {
    const run = cloneRun();

    expect(buildEvidenceMatrixModel(run, new Map([[run.sources[0]!.id, override]])))
      .toMatchObject({
        state: "error",
        error: { code: "matrix_display_override_invalid" },
        rows: [],
        sources: [],
      });
  });

  it("rejects accessor-backed override containers and values without executing getters", () => {
    const run = cloneRun();
    let getterCalls = 0;
    const container = new Map([
      [run.sources[0]!.id, { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }],
    ]);
    Object.defineProperty(container, "get", {
      get() {
        getterCalls += 1;
        return Map.prototype.get;
      },
    });
    const value = { state: "hidden" as const } as { state: "hidden"; reasonCode?: string };
    Object.defineProperty(value, "reasonCode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "ACCESSOR_OVERRIDE_CANARY";
      },
    });
    const valueContainer = new Map([[run.sources[0]!.id, value]]);

    expect(buildEvidenceMatrixModel(run, container)).toMatchObject({
      state: "error",
      error: { code: "matrix_display_override_accessor" },
    });
    expect(buildEvidenceMatrixModel(run, valueContainer)).toMatchObject({
      state: "error",
      error: { code: "matrix_display_override_accessor" },
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects Proxy-backed override containers and values without executing traps", () => {
    const run = cloneRun();
    let trapCalls = 0;
    const map = new Map([
      [run.sources[0]!.id, { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }],
    ]);
    const proxyMap = new Proxy(map, {
      get(target, key, receiver) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    const proxyValue = new Proxy(
      { state: "hidden" as const, reasonCode: "packet_display_hidden" as const },
      {
        get(target, key, receiver) {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(buildEvidenceMatrixModel(run, proxyMap)).toMatchObject({
      state: "error",
      error: { code: "matrix_display_override_proxy" },
    });
    expect(buildEvidenceMatrixModel(run, new Map([[run.sources[0]!.id, proxyValue]]))).toMatchObject({
      state: "error",
      error: { code: "matrix_display_override_proxy" },
    });
    expect(trapCalls).toBe(0);
  });

  it("owns override state and rejects cyclic override values", () => {
    const run = cloneRun();
    const override = { state: "hidden" as const, reasonCode: "packet_display_hidden" as const } as {
      state: "hidden";
      reasonCode: unknown;
    };
    const overrides = new Map([[run.sources[0]!.id, override]]);
    const model = buildEvidenceMatrixModel(run, overrides);
    override.state = "available" as never;
    expect(model.rows.flatMap(({ cells }) => cells).find(({ evidenceIds }) => evidenceIds.includes("gf-evidence-01"))?.evidence[0])
      .toMatchObject({ state: "hidden", reasonCode: "packet_display_hidden" });

    override.reasonCode = override;
    expect(buildEvidenceMatrixModel(run, overrides)).toMatchObject({
      state: "error",
      error: { code: "matrix_display_override_cycle" },
    });
  });

  it("fails closed when an override key does not resolve to a source", () => {
    const run = cloneRun();

    expect(buildEvidenceMatrixModel(run, new Map([
      ["missing-source", { state: "hidden" as const, reasonCode: "packet_display_hidden" as const }],
    ]))).toMatchObject({
      state: "error",
      error: { code: "matrix_cross_link_invalid" },
    });
  });

  it("redacts denied mismatch field diffs even when a claim-source cell has zero cards", () => {
    const run = cloneRun();
    const canary = "DENIED_ZERO_CARD_METADATA_CANARY";
    const source = run.sources[0]!;
    source.rights.mayDisplay = "denied";
    source.metadataVerification.fieldDiffs = [{
      field: "title",
      expected: canary,
      observed: canary,
    }];

    const model = buildEvidenceMatrixModel(run);
    const emptyMismatch = model.rows
      .flatMap(({ cells }) => cells)
      .find(({ sourceId, evidenceCount }) => sourceId === source.id && evidenceCount === 0);

    expect(emptyMismatch).toMatchObject({
      warningState: "mismatch",
      warningLabel: "Metadata mismatch",
      warnings: ["A metadata mismatch is recorded for evidence whose source text is hidden."],
    });
    expect(JSON.stringify(model)).not.toContain(canary);
  });

  it("redacts zero-card mismatch field diffs when any chunk owned by the source is denied", () => {
    const run = cloneRun();
    const canary = "DENIED_CHUNK_ZERO_CARD_METADATA_CANARY";
    const source = run.sources[0]!;
    const chunk = run.chunks.find(({ sourceId }) => sourceId === source.id)!;
    chunk.displayPermission = "denied";
    source.metadataVerification.fieldDiffs = [{
      field: "title",
      expected: canary,
      observed: canary,
    }];

    const model = buildEvidenceMatrixModel(run);
    const emptyMismatch = model.rows
      .flatMap(({ cells }) => cells)
      .find(({ sourceId, evidenceCount }) => sourceId === source.id && evidenceCount === 0);

    expect(emptyMismatch).toMatchObject({
      warningState: "mismatch",
      warningLabel: "Metadata mismatch",
      warnings: ["A metadata mismatch is recorded for evidence whose source text is hidden."],
    });
    expect(JSON.stringify(model)).not.toContain(canary);
  });

  it("models loading, empty, error, duplicate, long-content, and missing-evidence states honestly", () => {
    const base = cloneRun();

    expect(buildEvidenceMatrixScenarioModel(base, "loading")).toMatchObject({
      state: "loading",
      rows: [],
    });
    expect(buildEvidenceMatrixScenarioModel(base, "empty")).toMatchObject({
      state: "empty",
      rows: [],
      sources: [],
    });
    expect(buildEvidenceMatrixScenarioModel(base, "error")).toMatchObject({
      state: "error",
      rows: [],
    });
    expect(buildEvidenceMatrixScenarioModel(base, "duplicate").disclosure).toContain(
      "two evidence records",
    );
    expect(buildEvidenceMatrixScenarioModel(base, "long-content").rows[0]?.claim.statement.length)
      .toBeGreaterThan(250);
    expect(buildEvidenceMatrixScenarioModel(base, "missing-evidence").summary.missingCount)
      .toBeGreaterThan(0);
  });
});
