import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/reviewer-probes/operator-v1.live.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
