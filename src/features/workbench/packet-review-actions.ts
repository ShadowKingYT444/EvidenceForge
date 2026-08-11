"use server";

import {
  decidePacketReviewSession,
  type PacketDecisionResult,
} from "./packet-review-state";

export async function submitPacketReviewDecision(
  sessionId: string,
  decision: "accept" | "reject",
): Promise<PacketDecisionResult> {
  if (typeof sessionId !== "string" || !sessionId) {
    return {
      ok: false,
      error: {
        name: "PacketDecisionError",
        code: "invalid_session",
        message: "The decision session is invalid.",
      },
    };
  }
  if (decision !== "accept" && decision !== "reject") {
    return {
      ok: false,
      error: {
        name: "PacketDecisionError",
        code: "invalid_decision",
        message: "The packet decision is invalid.",
      },
    };
  }
  return decidePacketReviewSession(sessionId, decision);
}
