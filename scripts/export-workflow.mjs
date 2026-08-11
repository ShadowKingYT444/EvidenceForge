import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

const renderer = "@mermaid-js/mermaid-cli@11.16.0";
const sourcePath = resolve("docs/architecture/workflow.mmd");
const outputPath = resolve("artifacts/submission/workflow-v1.png");
const metadataPath = resolve("artifacts/submission/workflow-v1.metadata.json");
const rendererArguments = [
  "dlx",
  renderer,
  "-i",
  "docs/architecture/workflow.mmd",
  "-o",
  "artifacts/submission/workflow-v1.png",
  "-w",
  "2400",
  "-H",
  "1350",
  "-s",
  "1",
  "-b",
  "white",
];

async function firstAccessible(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the explicit, bounded candidates.
    }
  }
  return undefined;
}

async function resolvePnpmScript(environment = process.env) {
  const pathDirectories = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const shimNames =
    process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe"] : ["pnpm"];
  const shimDirectories = pathDirectories.flatMap((directory) =>
    shimNames.map((name) => dirname(resolve(directory, name))),
  );
  const pnpmRelativePaths = [
    ["node_modules", "pnpm", "bin", "pnpm.mjs"],
    ["node_modules", "pnpm", "bin", "pnpm.cjs"],
    ["node_modules", "corepack", "dist", "pnpm.js"],
  ];
  const candidates = [
    environment.MERMAID_PNPM_SCRIPT,
    ...pnpmRelativePaths.map((parts) =>
      resolve(dirname(process.execPath), "..", ...parts),
    ),
    ...shimDirectories.flatMap((directory) => [
      ...pnpmRelativePaths.map((parts) => resolve(directory, ...parts)),
      ...pnpmRelativePaths.map((parts) => resolve(directory, "..", ...parts)),
      ...pnpmRelativePaths.map((parts) =>
        resolve(directory, "..", "..", "node", ...parts),
      ),
    ]),
  ];
  const pnpmScript = await firstAccessible(candidates);
  if (!pnpmScript) {
    throw new Error(
      "workflow export could not resolve the pnpm CLI script; set MERMAID_PNPM_SCRIPT",
    );
  }
  return pnpmScript;
}

export function runExecutable(
  executable,
  argumentsList,
  options = {},
  spawn = spawnSync,
) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new TypeError("an executable path is required");
  }
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("command arguments must be a string array");
  }
  return spawn(executable, [...argumentsList], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    shell: false,
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
  });
}

export async function exportWorkflow(environment = process.env) {
  await mkdir(dirname(outputPath), { recursive: true });
  const browserCandidates = [
    environment.MERMAID_CHROME_PATH,
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ]),
  ];
  const browserExecutable = await firstAccessible(browserCandidates);
  if (!browserExecutable) {
    throw new Error(
      "workflow export requires an existing Chrome or Edge executable",
    );
  }

  const pnpmScript = await resolvePnpmScript(environment);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "workflow export "),
  );
  const puppeteerConfig = join(temporaryDirectory, "puppeteer config.json");
  await writeFile(
    puppeteerConfig,
    `${JSON.stringify({ executablePath: browserExecutable })}\n`,
    "utf8",
  );
  try {
    const rendered = runExecutable(
      process.execPath,
      [pnpmScript, ...rendererArguments, "-p", puppeteerConfig],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    if (rendered.error) throw rendered.error;
    if (rendered.status !== 0) {
      throw new Error(`Mermaid export failed with status ${rendered.status}`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const [source, png] = await Promise.all([
    readFile(sourcePath),
    readFile(outputPath),
  ]);
  const canonicalSource = Buffer.from(
    source.toString("utf8").replace(/\r\n/g, "\n"),
    "utf8",
  );
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    throw new Error("workflow export is not a PNG");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 2200 || height < 900 || height > 1800) {
    throw new Error(
      `workflow export dimensions are unreadable: ${width}x${height}`,
    );
  }

  const sha256 = (value) =>
    createHash("sha256").update(value).digest("hex");
  let priorReview = null;
  try {
    const prior = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      prior.sourceSha256 === sha256(canonicalSource) &&
      prior.pngSha256 === sha256(png) &&
      prior.visualInspection?.status === "passed"
    ) {
      priorReview = prior.visualInspection;
    }
  } catch {
    // First export or stale metadata: manual inspection must be repeated.
  }

  const metadata = {
    schemaVersion: "1.0.0",
    source: "docs/architecture/workflow.mmd",
    sourceSha256: sha256(canonicalSource),
    sourceHashNormalization: "UTF-8 with CRLF normalized to LF",
    renderer,
    command: "node scripts/export-workflow.mjs",
    rendererCommand:
      "node <resolved-pnpm-script> dlx @mermaid-js/mermaid-cli@11.16.0 " +
      "-i docs/architecture/workflow.mmd -o artifacts/submission/workflow-v1.png " +
      "-w 2400 -H 1350 -s 1 -b white -p <generated-local-browser-config>",
    processLaunch: "real executable plus argv; shell disabled",
    browser: {
      executable: basename(browserExecutable),
      selection:
        "MERMAID_CHROME_PATH override or bounded system Chrome/Edge lookup",
    },
    output: "artifacts/submission/workflow-v1.png",
    pngSha256: sha256(png),
    dimensions: { width, height },
    background: "white",
    visualInspection: priorReview ?? {
      status: "pending",
      submissionResolution: "2400px export",
      laptopViewport: "1600x900 fit-to-window",
    },
    evidenceBoundary: {
      fixtureDemo: "explicitly labeled fixture",
      liveEndToEndSuccess: false,
      measuredBenchmarkComplete: false,
    },
  };
  await writeFile(
    metadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ sourceSha256: metadata.sourceSha256, pngSha256: metadata.pngSha256, width, height, renderer })}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await exportWorkflow();
