export type WorkbenchProjectionQuery = {
  scenario?: string;
  packet?: string;
  matrix?: string;
  evidence?: string;
  protocol?: string;
  dispositions?: string;
  runId?: string;
  expectedRevision?: string;
};

export const SIMULATED_OBJECTION_RUN_ID =
  "simulated-objection-dispositions";

export function resolveWorkbenchProjectionQuery(
  query: WorkbenchProjectionQuery,
): WorkbenchProjectionQuery {
  if (query.runId === undefined) {
    return query;
  }

  return {
    ...query,
    scenario: undefined,
    packet: undefined,
    matrix: undefined,
    protocol: undefined,
    dispositions: undefined,
    expectedRevision: undefined,
  };
}
