import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const workspaceRoot = resolve(__dirname, "../..");
const artifactRoot = resolve(
  workspaceRoot,
  "artifacts",
  "submission",
  "demo-v1",
);
const persistentLabel = "FIXTURE PLAYBACK — NOT LIVE OR MEASURED";
const localOrigin = "http://127.0.0.1:3100/";
const viewport = { width: 1440, height: 900 } as const;

const frames = [
  {
    id: "01-intake-loaded",
    file: "01-intake-loaded.png",
    route: "/intake",
    focus: "Loaded bounded question and three-claim contract",
    startSecond: 0,
    endSecond: 30,
  },
  {
    id: "02-scope-approved",
    file: "02-scope-approved.png",
    route: "/intake",
    focus: "Human scope approval before evidence work",
    startSecond: 30,
    endSecond: 55,
  },
  {
    id: "03-passage-trace",
    file: "03-passage-trace.png",
    route: "/workbench?evidence=gf-evidence-02#evidence-verification-drawer",
    focus: "Exact unloaded 77-hour passage with three separate review layers",
    startSecond: 55,
    endSecond: 105,
  },
  {
    id: "04-conclusion-gap",
    file: "04-conclusion-gap.png",
    route: "/workbench#synthesis-gap",
    focus: "Conflicting duration conclusion, insufficient integration, selected gap",
    startSecond: 105,
    endSecond: 145,
  },
  {
    id: "05-experiment-limits",
    file: "05-experiment-limits.png",
    route: "/workbench#experiment",
    focus: "Bounded educational pilot and explicit does-not-establish limits",
    startSecond: 145,
    endSecond: 195,
  },
  {
    id: "06-objections-audit",
    file: "06-objections-audit.png",
    route: "/workbench#review-revision",
    focus: "Accepted load-verification objection and unresolved degradation risk",
    startSecond: 195,
    endSecond: 245,
  },
  {
    id: "07-final-export",
    file: "07-final-export.png",
    route: "/workbench?runId={process-local-fixture-session}#final-decision",
    focus: "Isolated final human decision and canonical JSON export receipt",
    startSecond: 245,
    endSecond: 290,
  },
] as const;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Buffer) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("demo capture output is not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function observeBrowser(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(localOrigin)) externalRequests.push(request.url());
  });
  return { consoleErrors, failedRequests, externalRequests };
}

async function installCaptureBanner(page: Page, frameId: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(
    async ({ label, id }) => {
      await document.fonts.ready;
      document.querySelector("[data-demo-capture-banner]")?.remove();
      const banner = document.createElement("div");
      banner.dataset.demoCaptureBanner = "true";
      banner.dataset.testid = "demo-capture-banner";
      banner.textContent = `${label} · ${id}`;
      Object.assign(banner.style, {
        position: "fixed",
        inset: "0 0 auto 0",
        zIndex: "2147483647",
        boxSizing: "border-box",
        minHeight: "48px",
        padding: "13px 24px",
        background: "#7f1d1d",
        borderBottom: "3px solid #fecaca",
        color: "#ffffff",
        font: "700 16px/1.25 Arial, sans-serif",
        letterSpacing: "0.04em",
        textAlign: "center",
      });
      document.body.appendChild(banner);
      document.body.style.paddingTop = "48px";
      document.documentElement.style.scrollPaddingTop = "64px";
    },
    { label: persistentLabel, id: frameId },
  );
  await expect(page.getByTestId("demo-capture-banner")).toHaveText(
    `${persistentLabel} · ${frameId}`,
  );
}

async function normalizeEphemeralReceipt(
  page: Page,
  replacements: Array<[string, string]>,
) {
  await page.evaluate((pairs) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      let value = node.nodeValue ?? "";
      for (const [observed, replacement] of pairs) {
        if (observed !== "") value = value.replaceAll(observed, replacement);
      }
      node.nodeValue = value;
      node = walker.nextNode();
    }
  }, replacements);
}

async function installWorkbenchFocusStage(
  page: Page,
  kind: "synthesis-gap" | "experiment" | "objections-audit" | "final-decision",
) {
  await page.evaluate((focusKind) => {
    document.querySelector("[data-demo-focus-stage]")?.remove();

    const stage = document.createElement("section");
    stage.dataset.demoFocusStage = focusKind;
    Object.assign(stage.style, {
      position: "fixed",
      inset: "48px 0 0",
      zIndex: "2147483646",
      boxSizing: "border-box",
      overflow: "hidden",
      padding: "18px 32px 24px",
      background:
        "linear-gradient(90deg, rgb(36 84 58 / 4%) 1px, transparent 1px) 0 0 / 48px 48px, #eef1eb",
      color: "#17231c",
    });

    const required = <T extends Element>(selector: string, root: ParentNode = document) => {
      const found = root.querySelector<T>(selector);
      if (!found) throw new Error(`capture focus source missing: ${selector}`);
      return found;
    };

    const cloned = <T extends Element>(selector: string, root: ParentNode = document) =>
      required<T>(selector, root).cloneNode(true) as T;

    if (focusKind === "synthesis-gap") {
      const synthesis = required<HTMLElement>(
        '[aria-label="Conclusions and selected research gap"]',
      );
      const header = cloned<HTMLElement>(":scope > header", synthesis);
      const lead = cloned<HTMLElement>(":scope > p", synthesis);
      const firstConclusion = cloned<HTMLElement>(
        ":scope > ol > li:nth-child(1)",
        synthesis,
      );
      const secondConclusion = cloned<HTMLElement>(
        ":scope > ol > li:nth-child(2)",
        synthesis,
      );
      const selectionRecord = cloned<HTMLElement>(
        '[aria-labelledby="selection-record-title"]',
        synthesis,
      );
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: "14px",
        alignItems: "start",
      });
      for (const card of [firstConclusion, secondConclusion, selectionRecord]) {
        Object.assign(card.style, {
          minWidth: "0",
          margin: "0",
          listStyle: "none",
          border: "1px solid #cad3ca",
          borderRadius: "10px",
          background: "#fffef9",
        });
        grid.appendChild(card);
      }
      Object.assign(header.style, {
        border: "1px solid #cad3ca",
        background: "#fffef9",
      });
      Object.assign(lead.style, {
        margin: "0 0 12px",
        border: "1px solid #cad3ca",
        borderTop: "0",
        background: "#fffef9",
      });
      stage.append(header, lead, grid);
    } else if (focusKind === "experiment") {
      const protocol = required<HTMLElement>('[aria-label="Experiment protocol inspector"]');
      const header = cloned<HTMLElement>(":scope > header", protocol);
      const objective = cloned<HTMLElement>(":scope > div > div:first-child", protocol);
      const safety = required<HTMLElement>("#safety-title", protocol).parentElement
        ?.parentElement;
      const criteria = required<HTMLElement>("#criteria-title", protocol).parentElement;
      const inference = required<HTMLElement>("#inference-title", protocol).parentElement;
      if (!safety || !criteria || !inference) {
        throw new Error("capture focus experiment section boundary missing");
      }

      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "0.95fr 0.95fr 1.35fr",
        gap: "14px",
        alignItems: "start",
      });
      objective.style.gridColumn = "1 / -1";
      for (const source of [objective, safety, criteria, inference]) {
        const copy = source === objective ? objective : (source.cloneNode(true) as HTMLElement);
        Object.assign(copy.style, {
          minWidth: "0",
          margin: "0",
          border: "1px solid #cad3ca",
          borderRadius: "10px",
          background: "#fffef9",
        });
        grid.appendChild(copy);
      }
      Object.assign(header.style, {
        marginBottom: "12px",
        border: "1px solid #cad3ca",
        background: "#fffef9",
      });
      stage.append(header, grid);
    } else if (focusKind === "objections-audit") {
      const objections = required<HTMLElement>(
        '[aria-label="Objection dispositions and selective revision"]',
      );
      const accepted = cloned<HTMLElement>(
        '[data-testid="objection-gf-objection-calibration"]',
        objections,
      );
      const unresolved = cloned<HTMLElement>(
        '[data-testid="objection-gf-objection-degradation"]',
        objections,
      );
      const objectionHeader = cloned<HTMLElement>(":scope > header", objections);

      const attempts = [
        '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"]',
        '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="succeeded"]',
        '[data-audit-attempt][data-node-id="review-experiment"][data-execution-status="failed"]',
        '[data-audit-attempt][data-node-id="review-experiment"][data-execution-status="succeeded"]',
      ].map((selector) => required<HTMLElement>(selector));

      const objectionGrid = document.createElement("div");
      Object.assign(objectionGrid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "12px",
      });
      for (const card of [accepted, unresolved]) {
        Object.assign(card.style, {
          minWidth: "0",
          margin: "0",
          padding: "12px",
          border: "1px solid #cad3ca",
          borderRadius: "10px",
          background: "#fffef9",
        });
        objectionGrid.appendChild(card);
      }

      const auditHeading = document.createElement("div");
      auditHeading.innerHTML =
        '<span style="font:800 11px/1.2 Arial;letter-spacing:.1em;text-transform:uppercase;color:#24543a">07 · Audit</span><h2 style="margin:3px 0 0;font:600 22px/1.2 Georgia,serif">Visible failure and retry lineage</h2>';
      const auditGrid = document.createElement("div");
      Object.assign(auditGrid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: "10px",
      });
      for (const attempt of attempts) {
        const details = required<HTMLDetailsElement>("details", attempt);
        const summary = cloned<HTMLElement>(":scope > summary", details);
        const body = required<HTMLElement>(":scope > div", details);
        const validation = body.children.item(2)?.cloneNode(true) as HTMLElement | undefined;
        const recovery = body.lastElementChild?.cloneNode(true) as HTMLElement | undefined;
        const card = document.createElement("article");
        Object.assign(card.style, {
          minWidth: "0",
          padding: "10px",
          border: "1px solid #cad3ca",
          borderTop:
            attempt.dataset.executionStatus === "failed"
              ? "4px solid #91372f"
              : "4px solid #275c32",
          background: "#fffef9",
          fontSize: "11px",
        });
        card.appendChild(summary);
        if (attempt.dataset.executionStatus === "failed" && validation) {
          card.appendChild(validation);
        }
        if (recovery) card.appendChild(recovery);
        auditGrid.appendChild(card);
      }

      Object.assign(objectionHeader.style, {
        marginBottom: "10px",
        border: "1px solid #cad3ca",
        background: "#fffef9",
      });
      Object.assign(auditHeading.style, { margin: "12px 0 8px" });
      stage.append(objectionHeader, objectionGrid, auditHeading, auditGrid);
    } else {
      const question = cloned<HTMLElement>("#workbench-title");
      const mode = cloned<HTMLElement>('[aria-label^="Evidence mode: Fixture"]');
      const decision = cloned<HTMLElement>("#final-decision");
      const exportControl = cloned<HTMLElement>(
        '#final-decision a[href*="/export"]',
      );
      const context = document.createElement("header");
      Object.assign(context.style, {
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: "20px",
        alignItems: "center",
        marginBottom: "18px",
        padding: "20px 24px",
        border: "1px solid #cad3ca",
        background: "#fffef9",
      });
      Object.assign(question.style, { margin: "0", fontSize: "32px" });
      context.append(question, mode);
      Object.assign(decision.style, {
        position: "static",
        width: "100%",
        margin: "0",
        padding: "24px",
        boxSizing: "border-box",
        background: "#fffef9",
      });
      const exportReceipt = document.createElement("div");
      exportReceipt.innerHTML =
        '<strong style="display:block;margin-bottom:8px;font:800 11px/1.2 Arial;letter-spacing:.1em;text-transform:uppercase;color:#24543a">Canonical JSON export control</strong>';
      Object.assign(exportReceipt.style, {
        width: "fit-content",
        margin: "16px 0 0 auto",
        padding: "14px 18px",
        border: "1px solid #9eada2",
        background: "#fffef9",
      });
      Object.assign(exportControl.style, {
        display: "inline-flex",
        padding: "10px 14px",
        border: "0",
        background: "#17231c",
        color: "#ffffff",
        fontWeight: "800",
      });
      exportReceipt.appendChild(exportControl);
      stage.append(context, decision, exportReceipt);
    }

    document.body.appendChild(stage);
  }, kind);
}

test.describe("public deterministic fixture capture", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("captures the bounded seven-frame route and canonical export", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await mkdir(artifactRoot, { recursive: true });
    const observed = observeBrowser(page);
    const screenshots: Array<{
      id: string;
      file: string;
      route: string;
      focus: string;
      width: number;
      height: number;
      sha256: string;
    }> = [];

    async function capture(frame: (typeof frames)[number]) {
      await installCaptureBanner(page, frame.id);
      const path = resolve(artifactRoot, frame.file);
      await page.screenshot({
        path,
        animations: "disabled",
        caret: "hide",
      });
      const bytes = await readFile(path);
      const dimensions = pngDimensions(bytes);
      expect(dimensions).toEqual(viewport);
      screenshots.push({
        id: frame.id,
        file: frame.file,
        route: frame.route,
        focus: frame.focus,
        ...dimensions,
        sha256: sha256(bytes),
      });
    }

    await page.setViewportSize(viewport);
    await page.goto("/intake");
    await page.getByRole("button", { name: "Load golden fixture" }).click();
    await expect(page.getByLabel("Research question")).toHaveValue(
      "For a single-use 72-hour environmental sensor, can a biodegradable battery replace a lithium coin cell?",
    );
    await expect(page.getByRole("heading", { name: "Testable claim ledger" })).toBeVisible();
    await capture(frames[0]);

    await page.getByRole("button", { name: "Approve claim scope" }).click();
    await expect(page.getByText("Scope approved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Research question")).toBeDisabled();
    await page.getByText("Scope approved", { exact: true }).scrollIntoViewIfNeeded();
    await capture(frames[1]);

    await page
      .getByRole("link", { name: "Continue to recorded fixture workbench" })
      .click();
    await expect(page).toHaveURL(/\/workbench$/);
    await page.goto(frames[2].route);
    const drawer = page.getByRole("dialog", { name: /Evidence verification/ });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByText(
        "Under ambient conditions, mechanically and electrically unloaded batteries could sustain a voltage above 1.5 V for 77 h.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      drawer.getByText("Deterministic passage check", { exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText("Model entailment", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Human review", { exact: true })).toBeVisible();
    await capture(frames[2]);

    await page.goto(frames[3].route);
    const conclusions = page.getByRole("region", {
      name: "Conclusions and selected research gap",
    });
    await conclusions.scrollIntoViewIfNeeded();
    await expect(conclusions.getByText("Conflicting", { exact: true })).toBeVisible();
    await expect(
      conclusions.getByText("Insufficient evidence · abstain", { exact: true }),
    ).toBeVisible();
    await installWorkbenchFocusStage(page, "synthesis-gap");
    const synthesisFocus = page.locator(
      '[data-demo-focus-stage="synthesis-gap"]',
    );
    for (const label of [
      "Conflicting",
      "Insufficient evidence · abstain",
      "Gap 01 · selected",
    ]) {
      const visibleRecord = synthesisFocus.getByText(label, { exact: true });
      await expect(visibleRecord).toBeVisible();
      await expect(visibleRecord).toBeInViewport({ ratio: 1 });
    }
    await capture(frames[3]);
    await page.locator("[data-demo-focus-stage]").evaluate((stage) => stage.remove());

    await page.goto(frames[4].route);
    const protocol = page.getByRole("region", {
      name: "Experiment protocol inspector",
    });
    const inferenceBoundary = protocol
      .getByText("What this outcome does not establish", { exact: true })
      .first();
    await inferenceBoundary.scrollIntoViewIfNeeded();
    await expect(inferenceBoundary).toBeVisible();
    await expect(protocol.getByText("Qualified human review required")).toBeVisible();
    await expect(
      protocol.getByText(/Commercial replacement, lifecycle superiority/),
    ).toBeVisible();
    await installWorkbenchFocusStage(page, "experiment");
    await capture(frames[4]);
    await page.locator("[data-demo-focus-stage]").evaluate((stage) => stage.remove());

    await page.goto(frames[5].route);
    const objections = page.getByRole("region", {
      name: "Objection dispositions and selective revision",
    });
    await objections.scrollIntoViewIfNeeded();
    const accepted = objections.getByTestId("objection-gf-objection-calibration");
    const unresolved = objections.getByTestId("objection-gf-objection-degradation");
    await expect(accepted.getByText("Accepted", { exact: true })).toBeVisible();
    await expect(unresolved.getByText("Unresolved", { exact: true })).toBeVisible();
    await expect(unresolved.getByText("No field change", { exact: true })).toBeVisible();

    const failedPlan = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="failed"]',
    );
    const repairedPlan = page.locator(
      '[data-audit-attempt][data-node-id="plan-experiment"][data-execution-status="succeeded"]',
    );
    const failedReview = page.locator(
      '[data-audit-attempt][data-node-id="review-experiment"][data-execution-status="failed"]',
    );
    const retriedReview = page.locator(
      '[data-audit-attempt][data-node-id="review-experiment"][data-execution-status="succeeded"]',
    );
    await expect(failedPlan).toHaveCount(1);
    await expect(repairedPlan).toHaveCount(1);
    await expect(failedReview).toHaveCount(1);
    await expect(retriedReview).toHaveCount(1);
    await failedPlan.locator("summary").click();
    await repairedPlan.locator("summary").click();
    await failedReview.locator("summary").click();
    await retriedReview.locator("summary").click();
    await expect(
      failedPlan.getByText("sampleSizeBasis was omitted", { exact: true }).first(),
    ).toBeVisible();
    await expect(repairedPlan.getByText("Retry of gf-execution-plan-1")).toBeVisible();
    await expect(failedReview.getByText("Refusal", { exact: true })).toBeVisible();
    await expect(failedReview.getByText("Unavailable", { exact: true }).first()).toBeVisible();
    await expect(
      retriedReview.getByText("Retry of gf-execution-review-failure-1"),
    ).toBeVisible();
    await installWorkbenchFocusStage(page, "objections-audit");
    await capture(frames[5]);
    await page.locator("[data-demo-focus-stage]").evaluate((stage) => stage.remove());

    const bootstrapResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runs/fixture-workbench") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Start isolated final review" }).click();
    const bootstrapResponse = await bootstrapResponsePromise;
    expect(bootstrapResponse.status()).toBe(201);
    const bootstrap = (await bootstrapResponse.json()) as { runId: string };
    await expect(page).toHaveURL(new RegExp(`/workbench\\?runId=${bootstrap.runId}$`));

    const finalDecision = page.locator(
      'section[aria-labelledby="final-decision-title"]',
    );
    await finalDecision.getByRole("radio", { name: "Approve" }).check();
    await finalDecision.getByLabel("Declared actor").fill("Demo reviewer");
    await finalDecision
      .getByLabel("Decision rationale")
      .fill("Approve only this bounded fixture demonstration.");
    const checkpointResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${bootstrap.runId}/checkpoints`) &&
        response.request().method() === "POST",
    );
    await finalDecision
      .getByRole("button", { name: "Persist final decision" })
      .click();
    expect((await checkpointResponsePromise).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Decision recorded · approve" }),
    ).toBeVisible();
    await expect(page.getByTestId("final-decision-receipt")).toContainText(
      "Demo reviewer",
    );

    const exportResponse = await page.request.get(
      `/api/runs/${bootstrap.runId}/export`,
    );
    expect(exportResponse.status()).toBe(200);
    const exportBytes = await exportResponse.body();
    const exported = JSON.parse(exportBytes.toString("utf8")) as {
      id: string;
      schemaVersion: string;
      evidenceMode: string;
      status: string;
      finalDecision: {
        id: string;
        decidedAt: string;
        declaredActor: string;
        rationale: string;
      };
    };
    expect(exported).toMatchObject({
      schemaVersion: "0.2",
      evidenceMode: "fixture",
      status: "approved",
      finalDecision: {
        declaredActor: "Demo reviewer",
        rationale: "Approve only this bounded fixture demonstration.",
      },
    });
    const exportFile = "canonical-approved-run.json";
    await writeFile(resolve(artifactRoot, exportFile), exportBytes);

    await normalizeEphemeralReceipt(page, [
      [bootstrap.runId, "{process-local-fixture-session}"],
      [exported.finalDecision.id, "{final-decision-receipt}"],
      [exported.finalDecision.decidedAt, "{decision-time}"],
    ]);
    await installWorkbenchFocusStage(page, "final-decision");
    await capture(frames[6]);

    expect(screenshots).toHaveLength(7);
    expect(observed.consoleErrors).toEqual([]);
    expect(observed.externalRequests).toEqual([]);
    expect(
      observed.failedRequests.filter(
        (failure) =>
          !/[?&]_rsc=/.test(failure) || !failure.endsWith("net::ERR_ABORTED"),
      ),
    ).toEqual([]);

    const manifest = {
      schemaVersion: "1.0.0",
      title: "EvidenceForge deterministic fixture demo",
      acceptedBaseSha: "a1ba19c32edce9184aaa731473a89563ffca4994",
      evidenceMode: "fixture",
      persistentLabel,
      viewport,
      buildCommand: "pnpm build",
      captureCommand:
        "pnpm exec playwright test --config evals/demo/playwright.config.ts --project=chromium --workers=1",
      targetDurationSeconds: 290,
      narrationTimeline: frames.map(
        ({ id: frameId, startSecond, endSecond }) => ({
          frameId,
          startSecond,
          endSecond,
        }),
      ),
      screenshots,
      canonicalExport: {
        file: exportFile,
        sha256: sha256(exportBytes),
        evidenceMode: exported.evidenceMode,
        schemaVersion: exported.schemaVersion,
        status: exported.status,
        declaredActor: exported.finalDecision.declaredActor,
        route:
          "/workbench?runId={process-local-fixture-session}#final-decision",
        capturedRoute: `/workbench?runId=${bootstrap.runId}#final-decision`,
        byteStability:
          "Stable for this accepted process-local session; a new session receives new server-authored IDs and time.",
      },
      captureNormalizations: [
        "Persistent fixture/non-live/non-measured banner added by the Lane-040 capture seam.",
        "Frames 04-07 use capture-only focus layouts cloned from the rendered accepted fixture DOM; no record content is changed and the product UI is not modified.",
        "Ephemeral process-local run, receipt, and decision-time text replaced only in frame 07 with explicit placeholders; canonical export bytes remain unmodified.",
      ],
      truthBoundary: {
        completeDemoPath: "fixture",
        finalBoundedLiveAttempt:
          "failed at experiment planning after extraction and entailment succeeded and synthesis repaired once",
        measuredBenchmarkComplete: false,
        ablationsComplete: false,
        measuredCostClaim: false,
        superiorityClaim: false,
      },
    };
    await writeFile(
      resolve(artifactRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  });
});
