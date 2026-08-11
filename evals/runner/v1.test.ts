import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResearchRunSchema,
  canonicalSha256,
  type ResearchRun,
} from "../../src/contracts";
import { goldenRunV01 } from "../../src/fixtures/golden-run-v0.1";
import {
  BENCHMARK_PROTOCOL_SCHEMA_HASH,
  BENCHMARK_PROTOCOL_VERSION,
  CONDITION_MATRIX_HASH,
  FROZEN_CONSUMER_EDGE,
  createBenchmarkCase,
  createBenchmarkConfig,
  type BenchmarkCase,
  type BenchmarkConfig,
} from "../protocol/v1";
import {
  ARTIFACT_THREAT_MODEL,
  EVAL_RUNNER_VERSION,
  EvalRunConfigSchema,
  RunManifestSchema,
  SmokeMetricsSchema,
  assertArtifactPathContained,
  createRequestMetadata,
  createValidParsedAttempt,
  materializeFixtureRun,
  type EvalRunConfig,
  type RecordedAttempt,
} from "./v1";

const workspaceBase = "99a90c9c0884ab7109533e8742a1d9fe26d2bf24";
const temporaryRoots: string[] = [];
const temporaryRedirects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRedirects.splice(0).map((redirect) =>
      unlink(redirect).catch(() => undefined),
    ),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryArtifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evidenceforge-eval-runner-"));
  temporaryRoots.push(root);
  return root;
}

async function temporaryContainmentRoots(): Promise<{
  sandboxRoot: string;
  artifactRoot: string;
  outsideRoot: string;
}> {
  const sandboxRoot = await mkdtemp(
    join(tmpdir(), "evidenceforge-eval-containment-"),
  );
  temporaryRoots.push(sandboxRoot);
  const artifactRoot = join(sandboxRoot, "artifacts");
  const outsideRoot = join(sandboxRoot, "outside");
  await Promise.all([
    mkdir(artifactRoot, { recursive: false }),
    mkdir(outsideRoot, { recursive: false }),
  ]);
  return { sandboxRoot, artifactRoot, outsideRoot };
}

async function createDirectoryRedirect(
  redirectPath: string,
  outsideRoot: string,
  linkType: "dir" | "junction" = process.platform === "win32"
    ? "junction"
    : "dir",
): Promise<void> {
  await mkdir(dirname(redirectPath), { recursive: true });
  await symlink(outsideRoot, redirectPath, linkType);
  temporaryRedirects.push(redirectPath);
}

function fixtureCase(
  override: Partial<{
    graderInstructions: string;
  }> = {},
): BenchmarkCase {
  const packet = goldenRunV01.packet;
  if (packet === null) {
    throw new Error("complete golden fixture is missing its frozen packet");
  }
  return createBenchmarkCase({
    id: "fixture-materials-01",
    version: "1.0.0",
    role: "development",
    domain: "materials_engineering",
    originalQuestion: goldenRunV01.intake.originalQuestion,
    resolvedScope: {
      question: goldenRunV01.intake.originalQuestion,
      constraints: goldenRunV01.intake.constraints,
    },
    packet: {
      fingerprint: packet.fingerprint,
      sourceHashes: packet.sourceHashes,
      chunkHashes: packet.chunkHashes,
    },
    metadataSnapshot: {
      id: "fixture-metadata-01",
      hash: canonicalSha256({
        fixture: "golden-biodegradable-sensor-72h-v0.1",
        evidenceMode: "fixture",
      }),
      capturedAt: "2026-08-06T21:43:00.000Z",
    },
    expectedFailureLabels: [
      "conflicting_evidence",
      "experiment_confound_or_inferential_limitation",
    ],
    safety: {
      nonMedical: true,
      nonHazardous: true,
      notes: ["Fixture-only evaluation; no real-world execution."],
    },
    graderInstructions:
      override.graderInstructions ??
      "Inspect fixture structure only; do not treat it as a measured result.",
  });
}

function benchmarkConfig(
  benchmarkCase: BenchmarkCase = fixtureCase(),
  evidenceMode: "fixture" | "mocked" | "simulated" = "fixture",
): BenchmarkConfig {
  return createBenchmarkConfig({
    id: "fixture-materials-01-complete-workflow",
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    case: benchmarkCase,
    conditionId: "complete_workflow",
    primaryModel: {
      provider: "fixture",
      modelId: "fixture-primary-v1",
      developerFamily: "fixture-primary-family",
      baseFamily: "fixture-primary-base",
    },
    adversarialReviewerModel: {
      provider: "fixture",
      modelId: "fixture-reviewer-v1",
      developerFamily: "fixture-reviewer-family",
      baseFamily: "fixture-reviewer-base",
    },
    generation: {
      maxOutputTokens: 4096,
      timeoutMs: 30_000,
      temperature: 0,
      topP: 1,
      responseFormat: "json_schema",
      seedPolicy: "unsupported",
    },
    outputContract: {
      schemaId: "workflow-benchmark-output",
      schemaVersion: "1.0.0",
      schemaHash: canonicalSha256({ schema: "fixture-output" }),
      requiredFieldsHash: canonicalSha256({
        required: ["claims", "experiment"],
      }),
      safetyConstraintsHash: canonicalSha256({
        safety: "bounded-educational-only",
      }),
    },
    promptManifest: FROZEN_CONSUMER_EDGE.promptManifest.map((prompt) => ({
      ...prompt,
    })),
    benchmarkCodeVersion: workspaceBase,
    retryPolicy: {
      maximumAttempts: 2,
      repairInvalidOutput: true,
      retryableFailureKinds: [
        "provider_transport",
        "provider_timeout",
        "invalid_structured_output",
      ],
    },
    fallbackPolicy: {
      mode: "forbidden",
      configuredModel: null,
    },
    trialPlan: {
      count: 3,
      trialIds: ["trial-1", "trial-2", "trial-3"],
      trialSeeds: [null, null, null],
      selectionPolicy: "report_all_no_best_of",
    },
    exclusionPolicy: {
      allowedReasons: [
        "safety_gate_blocked",
        "rights_gate_blocked",
        "provider_unavailable_before_attempt",
        "configuration_invalid_before_attempt",
      ],
      denominatorPolicy: "retain_failures_report_pre_run_exclusions",
    },
    evidenceMode,
  });
}

function runConfig(
  runId: string,
  options: {
    rerunOfRunId?: string | null;
    benchmarkConfig?: BenchmarkConfig;
    evidenceMode?: "fixture" | "mocked" | "simulated";
  } = {},
): EvalRunConfig {
  const config =
    options.benchmarkConfig ??
    benchmarkConfig(fixtureCase(), options.evidenceMode);
  return EvalRunConfigSchema.parse({
    runnerVersion: EVAL_RUNNER_VERSION,
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    protocolSchemaHash: BENCHMARK_PROTOCOL_SCHEMA_HASH,
    conditionMatrixHash: CONDITION_MATRIX_HASH,
    promptManifestHash: FROZEN_CONSUMER_EDGE.promptManifestHash,
    runId,
    rerunOfRunId: options.rerunOfRunId ?? null,
    createdAt: "2026-08-06T23:55:00.000Z",
    trialId: "trial-1",
    benchmarkConfig: config,
    evidenceMode: config.evidenceMode,
    reportingUse: "development",
    resultClass: "smoke_only",
    headlineEligible: false,
  });
}

function attempts(
  runId: string,
  options: {
    evidenceMode?: "fixture" | "mocked" | "simulated";
    canonicalRun?: ResearchRun;
  } = {},
): RecordedAttempt[] {
  const evidenceMode = options.evidenceMode ?? "fixture";
  const config = benchmarkConfig(fixtureCase(), evidenceMode);
  const canonicalRun = options.canonicalRun ?? goldenRunV01;
  const requestBase = {
    runId,
    trialId: "trial-1",
    evidenceMode,
    requestedProvider: config.primaryModel.provider,
    requestedModelId: config.primaryModel.modelId,
    seed: null,
    generation: config.generation,
    promptManifestHash: config.promptManifestHash,
  };

  return [
    {
      raw: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId: "attempt-invalid-1",
        attemptNumber: 1,
        trialId: "trial-1",
        evidenceMode,
        startedAt: "2026-08-06T23:55:01.000Z",
        completedAt: "2026-08-06T23:55:01.120Z",
        latencyMs: 120,
        request: createRequestMetadata({
          ...requestBase,
          attemptId: "attempt-invalid-1",
          requestedAt: "2026-08-06T23:55:01.000Z",
          providerRequestId: "fixture-request-1",
        }),
        status: "failed",
        rawOutput: "{\"claims\":",
        failure: {
          kind: "invalid_structured_output",
          message: "Fixture output ended before valid JSON was complete.",
          retryable: true,
          providerCode: "FIXTURE_INVALID_JSON",
        },
      },
      parsed: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId: "attempt-invalid-1",
        attemptNumber: 1,
        trialId: "trial-1",
        evidenceMode,
        parseStatus: "invalid",
        canonicalRun: null,
        canonicalRunHash: null,
        validationIssues: ["Unexpected end of JSON input."],
      },
    },
    {
      raw: {
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId: "attempt-success-2",
        attemptNumber: 2,
        trialId: "trial-1",
        evidenceMode,
        startedAt: "2026-08-06T23:55:01.200Z",
        completedAt: "2026-08-06T23:55:01.450Z",
        latencyMs: 250,
        request: createRequestMetadata({
          ...requestBase,
          attemptId: "attempt-success-2",
          requestedAt: "2026-08-06T23:55:01.200Z",
          providerRequestId: "fixture-request-2",
        }),
        status: "succeeded",
        rawOutput: {
          fixturePointer: goldenRunV01.id,
          note: "Recorded fixture payload; no provider call occurred.",
        },
        failure: null,
      },
      parsed: createValidParsedAttempt({
        schemaVersion: EVAL_RUNNER_VERSION,
        runId,
        attemptId: "attempt-success-2",
        attemptNumber: 2,
        trialId: "trial-1",
        evidenceMode,
        canonicalRun,
        validationIssues: [],
      }),
    },
  ];
}

function researchRunWithEvidence(
  runEvidenceMode:
    | "live"
    | "fixture"
    | "mocked"
    | "simulated"
    | "unverified",
  executionEvidenceMode:
    | "live"
    | "fixture"
    | "mocked"
    | "simulated"
    | "unverified" = runEvidenceMode,
): ResearchRun {
  const run: ResearchRun = structuredClone(goldenRunV01);
  run.evidenceMode = runEvidenceMode;
  run.executions = run.executions.map((execution) => ({
    ...execution,
    evidenceMode: executionEvidenceMode,
  }));
  return ResearchRunSchema.parse(run);
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat().sort();
}

async function byteSnapshot(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await filesBelow(root)).map(async (path) => [
        relative(root, path).replaceAll("\\", "/"),
        canonicalSha256(await readFile(path, "utf8")),
      ]),
    ),
  );
}

describe("evaluation artifact runner v1", () => {
  it("binds validated smoke configs to the exact frozen protocol packet", () => {
    expect(EVAL_RUNNER_VERSION).toBe("1.0.0");
    expect(BENCHMARK_PROTOCOL_SCHEMA_HASH).toBe(
      "caa468800f311a214cc71a360b4720f07e8fa77ada926ba2869e8f705bb08015",
    );
    expect(CONDITION_MATRIX_HASH).toBe(
      "6256e3c2235b9becf9c2a2d197900d91c5b1bdd45f3e12ed9db14b79d7453b89",
    );
    expect(FROZEN_CONSUMER_EDGE.promptManifestHash).toBe(
      "f3a5a9154dab5bb64d6d438533d566ed7ccd07772e215c2ccac62aa52fd8e9e2",
    );

    const valid = runConfig("smoke-run-001");
    expect(EvalRunConfigSchema.parse(valid)).toEqual(valid);
    expect(() =>
      EvalRunConfigSchema.parse({
        ...valid,
        protocolSchemaHash: "0".repeat(64),
      }),
    ).toThrow();
  });

  it("makes fixture smoke structurally ineligible for live or headline output", () => {
    const valid = runConfig("smoke-run-001");
    expect(() =>
      EvalRunConfigSchema.parse({
        ...valid,
        evidenceMode: "live",
      }),
    ).toThrow();
    expect(() =>
      EvalRunConfigSchema.parse({
        ...valid,
        reportingUse: "headline",
      }),
    ).toThrow();
    expect(() =>
      EvalRunConfigSchema.parse({
        ...valid,
        headlineEligible: true,
      }),
    ).toThrow();
  });

  it("materializes versioned case/run directories with separate immutable raw and parsed artifacts", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const config = runConfig("smoke-run-001");
    const recordedAttempts = attempts(config.runId);
    const inputBefore = structuredClone({ config, recordedAttempts });

    const result = await materializeFixtureRun({
      artifactRoot,
      config,
      attempts: recordedAttempts,
    });

    expect({ config, recordedAttempts }).toEqual(inputBefore);
    expect(result.casePath.replaceAll("\\", "/")).toMatch(
      /cases\/fixture-materials-01\/1\.0\.0\/case\.json$/,
    );
    expect(result.runPath.replaceAll("\\", "/")).toMatch(
      /runs\/1\.0\.0\/smoke-run-001$/,
    );

    const rawFailure = JSON.parse(
      await readFile(join(result.runPath, "raw", "attempt-001-attempt-invalid-1.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsedFailure = JSON.parse(
      await readFile(join(result.runPath, "parsed", "attempt-001-attempt-invalid-1.json"), "utf8"),
    ) as Record<string, unknown>;
    const rawSuccess = JSON.parse(
      await readFile(join(result.runPath, "raw", "attempt-002-attempt-success-2.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsedSuccess = JSON.parse(
      await readFile(join(result.runPath, "parsed", "attempt-002-attempt-success-2.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(rawFailure).toMatchObject({
      status: "failed",
      evidenceMode: "fixture",
      failure: {
        kind: "invalid_structured_output",
        retryable: true,
      },
      request: {
        providerRequestId: "fixture-request-1",
        requestedProvider: "fixture",
        requestedModelId: "fixture-primary-v1",
      },
    });
    expect(rawFailure).toHaveProperty("rawOutput");
    expect(rawFailure).not.toHaveProperty("canonicalRun");
    expect(parsedFailure).toMatchObject({
      parseStatus: "invalid",
      canonicalRun: null,
    });
    expect(parsedFailure).not.toHaveProperty("rawOutput");
    expect(rawSuccess).not.toHaveProperty("canonicalRun");
    expect(parsedSuccess).toMatchObject({
      parseStatus: "valid",
      canonicalRun: { id: goldenRunV01.id },
    });
    expect(parsedSuccess).not.toHaveProperty("rawOutput");

    const manifest = RunManifestSchema.parse(
      JSON.parse(await readFile(join(result.runPath, "manifest.json"), "utf8")),
    );
    expect(manifest).toMatchObject({
      runId: "smoke-run-001",
      rerunOfRunId: null,
      evidenceMode: "fixture",
      reportingUse: "development",
      resultClass: "smoke_only",
      headlineEligible: false,
      complete: true,
    });
    expect(manifest.artifacts.map(({ path }) => path)).toEqual(
      [...manifest.artifacts.map(({ path }) => path)].sort(),
    );
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(join(result.runPath, ...artifact.path.split("/")));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        artifact.sha256,
      );
    }
  });

  it("writes smoke metrics JSON/CSV and empty annotation placeholders without result-table fields", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const result = await materializeFixtureRun({
      artifactRoot,
      config: runConfig("smoke-run-001"),
      attempts: attempts("smoke-run-001"),
    });

    const metrics = SmokeMetricsSchema.parse(
      JSON.parse(
        await readFile(join(result.runPath, "metrics", "smoke.json"), "utf8"),
      ),
    );
    expect(metrics).toMatchObject({
      evidenceMode: "fixture",
      reportingUse: "development",
      resultClass: "smoke_only",
      headlineEligible: false,
      counts: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        parsedValid: 1,
        parsedInvalid: 1,
      },
    });
    expect(() =>
      SmokeMetricsSchema.parse({
        ...metrics,
        liveResults: { improvement: 99 },
      }),
    ).toThrow();

    const csv = await readFile(
      join(result.runPath, "metrics", "smoke.csv"),
      "utf8",
    );
    expect(csv).toContain(
      "runner_version,run_id,evidence_mode,reporting_use,result_class,headline_eligible",
    );
    expect(csv).toContain("1.0.0,smoke-run-001,fixture,development,smoke_only,false");

    const annotation = JSON.parse(
      await readFile(
        join(result.runPath, "annotations", "placeholder.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(annotation).toMatchObject({
      status: "awaiting_human_annotation",
      randomizedConditionLabel: null,
      graderId: null,
      annotations: [],
    });

    const paths = (await filesBelow(result.runPath)).map((path) =>
      relative(result.runPath, path).replaceAll("\\", "/"),
    );
    expect(paths).toContain("metrics/smoke.json");
    expect(paths).toContain("metrics/smoke.csv");
    expect(paths.some((path) => /(?:^|\/)(?:live|headline|results)(?:\/|\.|$)/.test(path))).toBe(false);
  });

  it("atomically refuses overwrites and preserves every existing byte", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const config = runConfig("smoke-run-001");
    await materializeFixtureRun({
      artifactRoot,
      config,
      attempts: attempts(config.runId),
    });
    const before = await byteSnapshot(artifactRoot);

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config,
        attempts: attempts(config.runId),
      }),
    ).rejects.toThrow(/already exists/i);
    expect(await byteSnapshot(artifactRoot)).toEqual(before);

    const changedCase = fixtureCase({
      graderInstructions: "A different frozen instruction at the same version.",
    });
    const conflictingConfig = runConfig("smoke-run-conflict", {
      benchmarkConfig: benchmarkConfig(changedCase),
    });
    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: conflictingConfig,
        attempts: attempts(conflictingConfig.runId),
      }),
    ).rejects.toThrow(/frozen case conflict/i);
    expect(await byteSnapshot(artifactRoot)).toEqual(before);
  });

  it("validates request/config parity before writing any artifact", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const config = runConfig("smoke-run-drift");
    const drifted = structuredClone(attempts(config.runId));
    drifted[0]!.raw.request = createRequestMetadata({
      ...drifted[0]!.raw.request,
      requestedModelId: "different-fixture-model",
      requestHash: undefined,
    });

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config,
        attempts: drifted,
      }),
    ).rejects.toThrow(/request metadata drifted/i);
    expect(await readdir(artifactRoot)).toEqual([]);
  });

  it("claims a run ID atomically under concurrent materialization", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const config = runConfig("smoke-run-concurrent");
    const results = await Promise.allSettled([
      materializeFixtureRun({
        artifactRoot,
        config,
        attempts: attempts(config.runId),
      }),
      materializeFixtureRun({
        artifactRoot,
        config,
        attempts: attempts(config.runId),
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const fulfilled = results.find(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof materializeFixtureRun>>
      > => result.status === "fulfilled",
    );
    expect(fulfilled).toBeDefined();
    expect(
      RunManifestSchema.parse(
        JSON.parse(
          await readFile(join(fulfilled!.value.runPath, "manifest.json"), "utf8"),
        ),
      ).complete,
    ).toBe(true);
  });

  it("creates addressable reruns while preserving the complete parent run", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const first = await materializeFixtureRun({
      artifactRoot,
      config: runConfig("smoke-run-001"),
      attempts: attempts("smoke-run-001"),
    });
    const firstBefore = await byteSnapshot(first.runPath);

    const rerun = await materializeFixtureRun({
      artifactRoot,
      config: runConfig("smoke-run-002", {
        rerunOfRunId: "smoke-run-001",
      }),
      attempts: attempts("smoke-run-002"),
    });
    const rerunManifest = RunManifestSchema.parse(
      JSON.parse(await readFile(join(rerun.runPath, "manifest.json"), "utf8")),
    );
    expect(rerunManifest.rerunOfRunId).toBe("smoke-run-001");
    expect(await byteSnapshot(first.runPath)).toEqual(firstBefore);

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: runConfig("smoke-run-orphan", {
          rerunOfRunId: "missing-parent-run",
        }),
        attempts: attempts("smoke-run-orphan"),
      }),
    ).rejects.toThrow(/rerun parent is not a complete run/i);
  });

  it("rejects a runs-directory junction without writing outside or returning lexical success paths", async () => {
    const { artifactRoot, outsideRoot } =
      await temporaryContainmentRoots();
    const redirectPath = join(artifactRoot, "runs");
    await createDirectoryRedirect(redirectPath, outsideRoot);

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: runConfig("escape-run-001"),
        attempts: attempts("escape-run-001"),
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      reason: "reparse_point",
      path: redirectPath,
    });

    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a Windows-compatible directory symlink without outside writes", async () => {
    const { artifactRoot, outsideRoot } =
      await temporaryContainmentRoots();
    const redirectPath = join(artifactRoot, "cases");
    await createDirectoryRedirect(redirectPath, outsideRoot, "dir");

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: runConfig("escape-symlink-001"),
        attempts: attempts("escape-symlink-001"),
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      reason: "reparse_point",
      path: redirectPath,
    });
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a requested artifact root that is itself a pre-existing redirect", async () => {
    const { artifactRoot, outsideRoot } =
      await temporaryContainmentRoots();
    await rmdir(artifactRoot);
    await createDirectoryRedirect(artifactRoot, outsideRoot);

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: runConfig("redirected-root-run"),
        attempts: attempts("redirected-root-run"),
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      artifactRoot,
      operation: "initialize_root",
      path: artifactRoot,
      reason: "reparse_point",
    });
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a pre-existing redirected ancestor before creating a missing artifact root", async () => {
    const { sandboxRoot, outsideRoot } =
      await temporaryContainmentRoots();
    const redirectedAncestor = join(sandboxRoot, "redirected-parent");
    const artifactRoot = join(
      redirectedAncestor,
      "missing",
      "artifact-root",
    );
    await createDirectoryRedirect(redirectedAncestor, outsideRoot);

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: runConfig("redirected-ancestor-run"),
        attempts: attempts("redirected-ancestor-run"),
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      artifactRoot,
      operation: "initialize_root",
      path: redirectedAncestor,
      reason: "reparse_point",
    });
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it.each([
    ["existing", true],
    ["missing", false],
  ] as const)(
    "never probes the %s descendant below a redirected ancestor",
    async (descendantKind, createOutsideDescendant) => {
      const { sandboxRoot, outsideRoot } =
        await temporaryContainmentRoots();
      const redirectedAncestor = join(sandboxRoot, "ordered-parent");
      const descendantSegments = [
        `${descendantKind}-outside`,
        "artifact-root",
      ];
      if (createOutsideDescendant) {
        await mkdir(join(outsideRoot, ...descendantSegments), {
          recursive: true,
        });
      }
      await createDirectoryRedirect(redirectedAncestor, outsideRoot);
      const artifactRoot = join(
        redirectedAncestor,
        ...descendantSegments,
      );
      const outsideBefore = await readdir(outsideRoot);
      const probes: Array<{
        operation: "lstat" | "realpath" | "mkdir";
        path: string;
      }> = [];

      vi.resetModules();
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          lstat: async (path: string) => {
            probes.push({ operation: "lstat", path: resolve(path) });
            return actual.lstat(path);
          },
          realpath: async (path: string) => {
            probes.push({ operation: "realpath", path: resolve(path) });
            return actual.realpath(path);
          },
          mkdir: async (
            path: string,
            options?: Parameters<typeof mkdir>[1],
          ) => {
            probes.push({ operation: "mkdir", path: resolve(path) });
            return actual.mkdir(path, options);
          },
        };
      });

      try {
        const instrumentedRunner = await import("./v1");
        await expect(
          instrumentedRunner.materializeFixtureRun({
            artifactRoot,
            config: runConfig(`ordered-${descendantKind}-run`),
            attempts: attempts(`ordered-${descendantKind}-run`),
          }),
        ).rejects.toMatchObject({
          name: "ArtifactPathValidationError",
          operation: "initialize_root",
          path: redirectedAncestor,
          reason: "reparse_point",
        });
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      const probesBelowRedirect = probes.filter(({ path }) => {
        const pathFromRedirect = relative(redirectedAncestor, path);
        return (
          pathFromRedirect !== "" &&
          !isAbsolute(pathFromRedirect) &&
          pathFromRedirect !== ".." &&
          !pathFromRedirect.startsWith(`..${sep}`)
        );
      });
      expect(probesBelowRedirect).toEqual([]);
      const lexicalRoot = parse(redirectedAncestor).root;
      const checkedComponents = [lexicalRoot];
      let component = lexicalRoot;
      for (const segment of relative(
        lexicalRoot,
        redirectedAncestor,
      ).split(sep)) {
        if (segment === "") continue;
        component = join(component, segment);
        checkedComponents.push(component);
      }
      expect(probes).toEqual(
        checkedComponents.flatMap((path, index) =>
          index === checkedComponents.length - 1
            ? [{ operation: "lstat" as const, path }]
            : [
                { operation: "lstat" as const, path },
                { operation: "realpath" as const, path },
              ],
        ),
      );
      expect(await readdir(outsideRoot)).toEqual(outsideBefore);
    },
  );

  it.each([
    ["cases root", ["cases"]],
    ["case ID", ["cases", "fixture-materials-01"]],
    ["case version", ["cases", "fixture-materials-01", "1.0.0"]],
    ["runs root", ["runs"]],
    ["runner version", ["runs", EVAL_RUNNER_VERSION]],
    [
      "run ID",
      ["runs", EVAL_RUNNER_VERSION, "escape-run-table"],
    ],
  ])(
    "rejects a pre-existing %s redirect before materialization",
    async (_label, redirectSegments) => {
      const { artifactRoot, outsideRoot } =
        await temporaryContainmentRoots();
      const redirectPath = join(artifactRoot, ...redirectSegments);
      await createDirectoryRedirect(redirectPath, outsideRoot);

      await expect(
        materializeFixtureRun({
          artifactRoot,
          config: runConfig("escape-run-table"),
          attempts: attempts("escape-run-table"),
        }),
      ).rejects.toMatchObject({
        name: "ArtifactPathValidationError",
        code: "ARTIFACT_PATH_VALIDATION_FAILED",
        reason: "reparse_point",
        path: redirectPath,
      });

      expect(await readdir(outsideRoot)).toEqual([]);
    },
  );

  it.each(["raw", "parsed", "metrics", "annotations"])(
    "rejects a %s destination redirect during the immediate pre-publication containment check",
    async (artifactDirectory) => {
      const { artifactRoot, outsideRoot } =
        await temporaryContainmentRoots();
      const runPath = join(
        artifactRoot,
        "runs",
        EVAL_RUNNER_VERSION,
        "destination-probe",
      );
      const redirectPath = join(runPath, artifactDirectory);
      await createDirectoryRedirect(redirectPath, outsideRoot);

      await expect(
        assertArtifactPathContained({
          artifactRoot,
          path: join(redirectPath, "probe.json"),
          operation: "publish_file",
        }),
      ).rejects.toMatchObject({
        name: "ArtifactPathValidationError",
        code: "ARTIFACT_PATH_VALIDATION_FAILED",
        operation: "publish_file",
        reason: "reparse_point",
        path: redirectPath,
      });

      expect(await readdir(outsideRoot)).toEqual([]);
    },
  );

  it("initializes a missing clean artifact root and returns canonical in-root paths", async () => {
    const sandboxRoot = await temporaryArtifactRoot();
    const artifactRoot = join(
      sandboxRoot,
      "new",
      "nested",
      "artifact-root",
    );
    const result = await materializeFixtureRun({
      artifactRoot,
      config: runConfig("clean-root-run"),
      attempts: attempts("clean-root-run"),
    });
    const canonicalRoot = await realpath(artifactRoot);

    expect(result.artifactRoot).toBe(canonicalRoot);
    expect(relative(canonicalRoot, result.casePath)).not.toMatch(/^\.\./);
    expect(relative(canonicalRoot, result.runPath)).not.toMatch(/^\.\./);
    expect(relative(canonicalRoot, result.manifestPath)).not.toMatch(
      /^\.\./,
    );
    expect(
      RunManifestSchema.parse(
        JSON.parse(await readFile(result.manifestPath, "utf8")),
      ).complete,
    ).toBe(true);
  });

  it("rejects lexical traversal while accepting canonical descendants", async () => {
    const { sandboxRoot, artifactRoot } =
      await temporaryContainmentRoots();
    const canonicalRoot = await realpath(artifactRoot);
    const descendant = join(artifactRoot, "runs", "probe.json");
    const traversed = join(sandboxRoot, "outside-lexical.json");

    await expect(
      assertArtifactPathContained({
        artifactRoot,
        path: descendant,
        operation: "publish_file",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertArtifactPathContained({
        artifactRoot,
        path: traversed,
        operation: "publish_file",
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      artifactRoot: canonicalRoot,
      operation: "publish_file",
      path: traversed,
      reason: "lexical_escape",
    });
  });

  it("detects an observed descendant replacement when the redirected path is revalidated", async () => {
    const { artifactRoot, outsideRoot } =
      await temporaryContainmentRoots();
    const replaceablePath = join(artifactRoot, "runs");
    const candidate = join(replaceablePath, "probe.json");
    await mkdir(replaceablePath);

    await expect(
      assertArtifactPathContained({
        artifactRoot,
        path: candidate,
        operation: "publish_file",
      }),
    ).resolves.toBeUndefined();

    await rmdir(replaceablePath);
    await createDirectoryRedirect(replaceablePath, outsideRoot);
    await expect(
      assertArtifactPathContained({
        artifactRoot,
        path: candidate,
        operation: "publish_file",
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPathValidationError",
      code: "ARTIFACT_PATH_VALIDATION_FAILED",
      operation: "publish_file",
      path: replaceablePath,
      reason: "reparse_point",
    });
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("allows cooperative concurrent reruns without mutating their complete parent", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const parent = await materializeFixtureRun({
      artifactRoot,
      config: runConfig("cooperative-parent"),
      attempts: attempts("cooperative-parent"),
    });
    const parentBefore = await byteSnapshot(parent.runPath);

    const reruns = await Promise.all(
      ["cooperative-rerun-a", "cooperative-rerun-b"].map((runId) =>
        materializeFixtureRun({
          artifactRoot,
          config: runConfig(runId, {
            rerunOfRunId: "cooperative-parent",
          }),
          attempts: attempts(runId),
        }),
      ),
    );

    expect(await byteSnapshot(parent.runPath)).toEqual(parentBefore);
    for (const rerun of reruns) {
      expect(
        RunManifestSchema.parse(
          JSON.parse(await readFile(rerun.manifestPath, "utf8")),
        ).rerunOfRunId,
      ).toBe("cooperative-parent");
    }
  });

  it.each([
    ["fixture", "live"],
    ["fixture", "simulated"],
    ["simulated", "fixture"],
  ] as const)(
    "rejects an outer %s envelope carrying a %s canonical run before creating its artifact root",
    async (outerEvidenceMode, canonicalEvidenceMode) => {
      const sandboxRoot = await temporaryArtifactRoot();
      const artifactRoot = join(sandboxRoot, "must-remain-missing");
      const runId = `canonical-${outerEvidenceMode}-${canonicalEvidenceMode}`;
      const canonicalRun = researchRunWithEvidence(
        canonicalEvidenceMode,
      );

      await expect(
        materializeFixtureRun({
          artifactRoot,
          config: runConfig(runId, {
            evidenceMode: outerEvidenceMode,
          }),
          attempts: attempts(runId, {
            evidenceMode: outerEvidenceMode,
            canonicalRun,
          }),
        }),
      ).rejects.toThrow(/canonical run evidence mode/i);
      await expect(lstat(artifactRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    ["fixture", "live"],
    ["fixture", "mocked"],
    ["simulated", "live"],
    ["simulated", "fixture"],
  ] as const)(
    "rejects a %s canonical run with a %s execution before creating its artifact root",
    async (outerEvidenceMode, mismatchedExecutionMode) => {
      const sandboxRoot = await temporaryArtifactRoot();
      const artifactRoot = join(sandboxRoot, "must-remain-missing");
      const runId =
        `execution-${outerEvidenceMode}-${mismatchedExecutionMode}`;
      const canonicalRun = researchRunWithEvidence(outerEvidenceMode);
      canonicalRun.executions[0] = {
        ...canonicalRun.executions[0]!,
        evidenceMode: mismatchedExecutionMode,
      };
      const validCanonicalRun = ResearchRunSchema.parse(canonicalRun);

      await expect(
        materializeFixtureRun({
          artifactRoot,
          config: runConfig(runId, {
            evidenceMode: outerEvidenceMode,
          }),
          attempts: attempts(runId, {
            evidenceMode: outerEvidenceMode,
            canonicalRun: validCanonicalRun,
          }),
        }),
      ).rejects.toThrow(/execution evidence mode/i);
      await expect(lstat(artifactRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects an outer live run before creating any artifact root", async () => {
    const sandboxRoot = await temporaryArtifactRoot();
    const artifactRoot = join(sandboxRoot, "must-remain-missing");
    const fixtureConfig = runConfig("outer-live-run");
    const liveConfig = {
      ...fixtureConfig,
      benchmarkConfig: createBenchmarkConfig({
        ...fixtureConfig.benchmarkConfig,
        evidenceMode: "live",
      }),
      evidenceMode: "live",
    } as unknown as EvalRunConfig;

    await expect(
      materializeFixtureRun({
        artifactRoot,
        config: liveConfig,
        attempts: attempts("outer-live-run"),
      }),
    ).rejects.toThrow();
    await expect(lstat(artifactRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts a coherent simulated envelope without changing smoke-only result rules", async () => {
    const artifactRoot = await temporaryArtifactRoot();
    const runId = "coherent-simulated-run";
    const canonicalRun = researchRunWithEvidence("simulated");
    const result = await materializeFixtureRun({
      artifactRoot,
      config: runConfig(runId, { evidenceMode: "simulated" }),
      attempts: attempts(runId, {
        evidenceMode: "simulated",
        canonicalRun,
      }),
    });
    const manifest = RunManifestSchema.parse(
      JSON.parse(await readFile(result.manifestPath, "utf8")),
    );

    expect(manifest).toMatchObject({
      evidenceMode: "simulated",
      reportingUse: "development",
      resultClass: "smoke_only",
      headlineEligible: false,
      complete: true,
    });
    expect(
      canonicalRun.executions.every(
        ({ evidenceMode }) => evidenceMode === "simulated",
      ),
    ).toBe(true);
  });

  it("characterizes same-account hard-link aliasing as an excluded threat instead of a passing security check", async () => {
    const { artifactRoot, outsideRoot } =
      await temporaryContainmentRoots();
    const temporaryPath = join(artifactRoot, "known-probe.tmp");
    const outsideAlias = join(outsideRoot, "known-alias.json");
    const bytes = "excluded same-account hard-link behavior";
    const handle = await open(temporaryPath, "wx");

    try {
      await link(temporaryPath, outsideAlias);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      expect({
        excludedThreat:
          ARTIFACT_THREAT_MODEL.excludedThreats.sameAccountHardLinking,
        observedAliasedBytes: await readFile(outsideAlias, "utf8"),
      }).toEqual({
        excludedThreat: true,
        observedAliasedBytes: bytes,
      });
      expect(ARTIFACT_THREAT_MODEL).toMatchObject({
        mode: "trusted_local_single_writer",
        artifactRootIsSecurityBoundary: false,
        excludedThreats: {
          sameAccountHardLinking: true,
          concurrentAncestorSwap: true,
          postWriteCopying: true,
        },
      });
    } finally {
      await handle.close();
      await unlink(outsideAlias).catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
    expect(await readdir(outsideRoot)).toEqual([]);
  });
});
