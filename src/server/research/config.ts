import { z } from "zod";

/** Defaults are deliberately conservative: ten sources, with five required. */
export const RESEARCH_DEFAULTS = {
  target: 10,
  minimum: 5,
  candidateCap: 30,
  sourceDeadlineMs: 180_000,
  perItemTimeoutMs: 20_000,
  deadlineMs: 300_000,
  maxConcurrency: 6,
} as const;

const integer = z.number().int().finite();

/**
 * Runtime configuration for a bounded run. `strict()` is intentional: a
 * misspelled limit must fail at the boundary instead of silently weakening it.
 */
export const researchConfigSchema = z
  .object({
    target: integer.min(1).max(10_000).default(RESEARCH_DEFAULTS.target),
    minimum: integer.min(0).max(10_000).default(RESEARCH_DEFAULTS.minimum),
    candidateCap: integer.min(1).max(RESEARCH_DEFAULTS.candidateCap).default(RESEARCH_DEFAULTS.candidateCap),
    sourceDeadlineMs: integer.min(1).max(RESEARCH_DEFAULTS.sourceDeadlineMs).default(RESEARCH_DEFAULTS.sourceDeadlineMs),
    perItemTimeoutMs: integer.min(1).max(RESEARCH_DEFAULTS.perItemTimeoutMs).default(RESEARCH_DEFAULTS.perItemTimeoutMs),
    deadlineMs: integer.min(1).max(RESEARCH_DEFAULTS.deadlineMs).default(RESEARCH_DEFAULTS.deadlineMs),
    maxConcurrency: integer.min(1).max(RESEARCH_DEFAULTS.maxConcurrency).default(RESEARCH_DEFAULTS.maxConcurrency),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minimum > value.target) {
      ctx.addIssue({ code: "custom", path: ["minimum"], message: "minimum cannot exceed target" });
    }
  });

export type ResearchConfig = z.infer<typeof researchConfigSchema>;

export function parseResearchConfig(input: unknown = {}): ResearchConfig {
  return researchConfigSchema.parse(input);
}
