import { describe, expect, it, vi } from "vitest";

import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import {
  loadProcessLocalRunFromApi,
  resolveProcessLocalOrigin,
} from "../../src/features/workbench/process-local-run-loader";

describe("process-local workbench origin authority", () => {
  it("accepts only loopback hosts with a valid numeric port locally", () => {
    expect(resolveProcessLocalOrigin("127.0.0.1:3100", {})).toBe(
      "http://127.0.0.1:3100",
    );
    expect(resolveProcessLocalOrigin("localhost:3000", {})).toBe(
      "http://localhost:3000",
    );
    for (const host of [
      "localhost",
      "localhost:not-a-port",
      "localhost:0",
      "localhost:65536",
      "evil.localhost:3100",
      "attacker.onrender.com",
      "127.0.0.1:3100@attacker.onrender.com",
    ]) {
      expect(() => resolveProcessLocalOrigin(host, {})).toThrow(
        /origin authority unavailable/i,
      );
    }
  });

  it("uses only the exact authenticated Render runtime origin", () => {
    const environment = {
      RENDER: "true",
      RENDER_EXTERNAL_URL:
        "https://evidenceforge-reveriehacks-demo.onrender.com",
      RENDER_EXTERNAL_HOSTNAME:
        "evidenceforge-reveriehacks-demo.onrender.com",
    };
    expect(
      resolveProcessLocalOrigin(
        "evidenceforge-reveriehacks-demo.onrender.com",
        environment,
      ),
    ).toBe("https://evidenceforge-reveriehacks-demo.onrender.com");
    expect(() =>
      resolveProcessLocalOrigin("attacker.onrender.com", environment),
    ).toThrow(/origin authority unavailable/i);
  });

  it("rejects missing, malformed, or inconsistent Render authority", () => {
    const invalid = [
      {
        RENDER: "true",
        RENDER_EXTERNAL_HOSTNAME: "evidenceforge-reveriehacks-demo.onrender.com",
      },
      {
        RENDER: "true",
        RENDER_EXTERNAL_URL: "not a URL",
        RENDER_EXTERNAL_HOSTNAME: "evidenceforge-reveriehacks-demo.onrender.com",
      },
      {
        RENDER: "true",
        RENDER_EXTERNAL_URL:
          "http://evidenceforge-reveriehacks-demo.onrender.com",
        RENDER_EXTERNAL_HOSTNAME: "evidenceforge-reveriehacks-demo.onrender.com",
      },
      {
        RENDER: "true",
        RENDER_EXTERNAL_URL: "https://different-service.onrender.com",
        RENDER_EXTERNAL_HOSTNAME: "evidenceforge-reveriehacks-demo.onrender.com",
      },
      {
        RENDER: "true",
        RENDER_EXTERNAL_URL:
          "https://evidenceforge-reveriehacks-demo.onrender.com/path",
        RENDER_EXTERNAL_HOSTNAME: "evidenceforge-reveriehacks-demo.onrender.com",
      },
    ];
    for (const environment of invalid) {
      expect(() =>
        resolveProcessLocalOrigin(
          "evidenceforge-reveriehacks-demo.onrender.com",
          environment,
        ),
      ).toThrow(/origin authority unavailable/i);
    }
  });

  it("fails before fetching when the Host is spoofed", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      loadProcessLocalRunFromApi({
        runId: "fixture-workbench-1",
        host: "attacker.onrender.com",
        environment: {},
        fetcher,
      }),
    ).rejects.toThrow(/origin authority unavailable/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the exact final-checkpoint fixture snapshot envelope", async () => {
    const run = {
      ...structuredClone(goldenRunV02),
      id: "fixture-workbench-1",
      status: "awaiting_final_approval" as const,
      finalDecision: null,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ run, revision: "revision-1" }),
    );
    await expect(
      loadProcessLocalRunFromApi({
        runId: run.id,
        host: "127.0.0.1:3100",
        environment: {},
        fetcher,
      }),
    ).resolves.toEqual({ run, revision: "revision-1" });
    expect(fetcher).toHaveBeenCalledWith(
      `http://127.0.0.1:3100/api/runs/${run.id}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );

    const wrongPacket = structuredClone(run);
    wrongPacket.packet!.fingerprint = "0".repeat(64);
    fetcher.mockResolvedValueOnce(
      Response.json({ run: wrongPacket, revision: "revision-1" }),
    );
    await expect(
      loadProcessLocalRunFromApi({
        runId: run.id,
        host: "127.0.0.1:3100",
        environment: {},
        fetcher,
      }),
    ).rejects.toThrow(/invalid process-local run response/i);
  });
});
