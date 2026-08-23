import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Windows Defender/filesystem contention can push the immutable-artifact
    // tests past Vitest's default timeout when the suite fans out.
    testTimeout: process.platform === "win32" ? 15_000 : undefined,
  },
});
