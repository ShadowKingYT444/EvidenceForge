import { expect, it } from "vitest";

import { runReviewerProbeOperator } from "./operator-v1";

it("runs the bounded authorized reviewer compatibility probes", async () => {
  const result = await runReviewerProbeOperator(process.env);
  process.stdout.write(
    `${JSON.stringify({
      selectedModelId: result.selectedModelId,
      outcomes: result.outcomes,
      evidenceMode: result.evidenceMode,
    }, null, 2)}\n`,
  );
  expect(result.selectedModelId).not.toBeNull();
});
