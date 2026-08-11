import { expect, it } from "vitest";
import { z } from "zod";
import { ExperimentPlanningModelOutputSchema } from "../../src/server/prompts";
import { goldenRunV02 } from "../../src/fixtures/golden-run-v0.2";
import { experimentPlanningModelOutputSchemaForRun } from "../../src/server/workflow/run-api";

function maximumValue(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.anyOf)) {
    return maximumValue(
      schema.anyOf.find(
        (candidate) =>
          (candidate as Record<string, unknown>).type !== "null",
      ) as Record<string, unknown>,
    );
  }
  if (Array.isArray(schema.enum)) {
    return [...schema.enum].sort(
      (left, right) => JSON.stringify(right).length - JSON.stringify(left).length,
    )[0];
  }
  if (schema.type === "string") {
    return "x".repeat((schema.maxLength as number | undefined) ?? 1);
  }
  if (schema.type === "array") {
    const itemSchema = schema.items as Record<string, unknown>;
    if (Array.isArray(itemSchema.enum)) {
      return itemSchema.enum.slice(
        0,
        (schema.maxItems as number | undefined) ?? itemSchema.enum.length,
      );
    }
    return Array.from(
      { length: (schema.maxItems as number | undefined) ?? 1 },
      () => maximumValue(itemSchema),
    );
  }
  if (schema.type === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(
        ([key, child]) => [key, maximumValue(child)],
      ),
    );
  }
  throw new TypeError(`unsupported schema ${JSON.stringify(schema)}`);
}

it("bounds the approved-live-run maximum proposed semantic planning response", () => {
  const dynamicSchema = experimentPlanningModelOutputSchemaForRun(goldenRunV02);
  const schema = z.toJSONSchema(dynamicSchema) as Record<
    string,
    unknown
  >;
  const maximum = maximumValue(schema) as Record<string, unknown>;
  maximum.disposition = "proposed";
  maximum.abstention = null;
  const serialized = JSON.stringify(maximum);
  expect(dynamicSchema.parse(maximum)).toEqual(maximum);
  expect(serialized.length).toBe(7_194);
  expect(Math.ceil(serialized.length / 4)).toBe(1_799);
  expect(serialized.length).toBeLessThanOrEqual(7_200);
  expect(Math.ceil(serialized.length / 4)).toBeLessThan(2_048);
});

it("bounds the approved-live-run maximum abstained semantic planning response", () => {
  const dynamicSchema = experimentPlanningModelOutputSchemaForRun(goldenRunV02);
  const schema = z.toJSONSchema(dynamicSchema) as Record<
    string,
    unknown
  >;
  const maximum = maximumValue(schema) as Record<string, unknown>;
  maximum.disposition = "abstained";
  maximum.experiment = null;
  const serialized = JSON.stringify(maximum);
  expect(dynamicSchema.parse(maximum)).toEqual(maximum);
  expect(serialized.length).toBe(1_112);
  expect(Math.ceil(serialized.length / 4)).toBe(278);
  expect(serialized.length).toBeLessThanOrEqual(7_200);
  expect(Math.ceil(serialized.length / 4)).toBeLessThan(2_048);
});

it("rejects JSON-expanding and control characters at the semantic boundary", () => {
  for (const unsafe of ['"', "\\", "\u0000", "\u001f"]) {
    expect(
      ExperimentPlanningModelOutputSchema.safeParse({
        disposition: "abstained",
        experiment: null,
        abstention: {
          reason: `unsafe${unsafe}`,
          safetyCategories: ["other"],
          missingInputs: [],
          allowedNextStep: "Ask a qualified reviewer.",
        },
      }).success,
    ).toBe(false);
  }
});
