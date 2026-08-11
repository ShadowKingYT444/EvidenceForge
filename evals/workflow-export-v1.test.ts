import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The production exporter is intentionally a directly executable ESM script.
// @ts-expect-error It has no separate TypeScript declaration file.
import { runExecutable } from "../scripts/export-workflow.mjs";

describe("public workflow export", () => {
  it("keeps internal control IDs out and shows the typed-abstention branch", async () => {
    const source = await readFile("docs/architecture/workflow.mmd", "utf8");

    expect(source).not.toMatch(/\b[A-Z]{2,5}-\d+\b/);
    expect(source).not.toMatch(/internal codename/i);
    expect(source).toContain("PRESERVED BOUNDED LIVE ATTEMPT");
    expect(source).toContain(
      "N5 -->|typed abstention<br/>skip review + revision| H4",
    );
  });

  it("does not join renderer arguments into a shell command", async () => {
    const script = await readFile("scripts/export-workflow.mjs", "utf8");

    expect(script).not.toContain("command.join");
    expect(script).not.toContain("shell: true");
  });

  it("passes paths with spaces and shell metacharacters as inert argv", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow export test "));
    const hostileBasename =
      process.platform === "win32"
        ? "rendered & copy NUL injected.txt"
        : "rendered; touch injected.txt";
    const output = join(directory, hostileBasename);
    const injected = join(directory, "injected.txt");
    try {
      const result = runExecutable(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'safe argv')",
          output,
        ],
        { cwd: directory },
      );

      expect(result.status).toBe(0);
      await expect(readFile(output, "utf8")).resolves.toBe("safe argv");
      await expect(readFile(injected, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
