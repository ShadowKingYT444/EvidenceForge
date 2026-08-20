import type { ZodType } from "zod";

import {
  apiErrorSchema,
  compileResponseSchema,
  demoResponseSchema,
  reviewResponseSchema,
  type ChangeId,
  type CompileResponse,
  type DemoResponse,
  type ReviewResponse,
} from "./contracts";

export class EpistemicApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "EpistemicApiError";
  }
}

async function parseResponse<T>(response: Response, schema: ZodType<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EpistemicApiError(
      "INVALID_JSON",
      "The server returned an unreadable response.",
      response.status,
    );
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new EpistemicApiError(
      parsed.success ? parsed.data.error.code : `HTTP_${response.status}`,
      parsed.success
        ? parsed.data.error.message
        : "The evidence build could not be completed.",
      response.status,
      parsed.success ? parsed.data.error.recoverable ?? true : response.status < 500,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new EpistemicApiError(
      "INVALID_PROJECTION",
      "The server response did not match the Epistemic CI contract.",
      response.status,
      false,
    );
  }
  return parsed.data;
}

export async function loadDemo(signal?: AbortSignal): Promise<DemoResponse> {
  const response = await fetch("/api/epistemic-ci/demo", {
    cache: "no-store",
    signal,
  });
  return parseResponse(response, demoResponseSchema);
}

export async function compileChanges(
  appliedChangeIds: ChangeId[],
  signal?: AbortSignal,
): Promise<CompileResponse> {
  const response = await fetch("/api/epistemic-ci/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedChangeIds }),
    signal,
  });
  return parseResponse(response, compileResponseSchema);
}

export async function authorizeReview(input: {
  appliedChangeIds: ChangeId[];
  expectedGraphHash: string;
  declaredActor: string;
  rationale: string;
  signal?: AbortSignal;
}): Promise<ReviewResponse> {
  const response = await fetch("/api/epistemic-ci/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appliedChangeIds: input.appliedChangeIds,
      expectedGraphHash: input.expectedGraphHash,
      action: "approve_evidence_update",
      declaredActor: input.declaredActor,
      rationale: input.rationale,
    }),
    signal: input.signal,
  });
  return parseResponse(response, reviewResponseSchema);
}

export function downloadCanonicalReceipt(review: ReviewResponse): void {
  const blob = new Blob([review.canonicalExport], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${review.receipt.buildId}-research-pr.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
