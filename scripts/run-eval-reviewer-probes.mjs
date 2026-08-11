import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const environmentFile = process.env.EVF_CONTROL_ENV_FILE;
if (!environmentFile || !isAbsolute(environmentFile)) {
  throw new Error("an absolute control environment file is required");
}
process.loadEnvFile(environmentFile);
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
}).trim();
if (process.env.REVIEWER_PROBE_CODE_VERSION !== expectedCommit) {
  throw new Error("reviewer probe code version does not match HEAD");
}
const child = spawnSync(
  process.execPath,
  [
    join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    "evals/reviewer-probes/vitest.live.config.mts",
    "--maxWorkers=1",
    "--reporter=dot",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
