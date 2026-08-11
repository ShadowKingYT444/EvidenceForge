import type { ResearchRun } from "../../contracts";
import { inspectStoredTerminal } from "./final-decision-actions";

type RuntimeEnvironment = Record<string, string | undefined>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function unavailable(): never {
  throw new Error("Process-local origin authority unavailable.");
}

export function resolveProcessLocalOrigin(
  host: string,
  environment: RuntimeEnvironment,
): string {
  if (environment.RENDER === "true") {
    const externalUrlText = environment.RENDER_EXTERNAL_URL;
    const externalHostname = environment.RENDER_EXTERNAL_HOSTNAME;
    if (!externalUrlText || !externalHostname) unavailable();
    let externalUrl: URL;
    try {
      externalUrl = new URL(externalUrlText);
    } catch {
      unavailable();
    }
    if (
      externalUrl.protocol !== "https:" ||
      externalUrl.username !== "" ||
      externalUrl.password !== "" ||
      externalUrl.port !== "" ||
      externalUrl.pathname !== "/" ||
      externalUrl.search !== "" ||
      externalUrl.hash !== "" ||
      externalUrl.hostname !== externalHostname ||
      externalUrl.host !== externalHostname ||
      host !== externalHostname
    ) {
      unavailable();
    }
    return externalUrl.origin;
  }

  const match = /^(localhost|127\.0\.0\.1):(\d{1,5})$/i.exec(host);
  if (!match) unavailable();
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) unavailable();
  return `http://${match[1].toLowerCase()}:${port}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadProcessLocalRunFromApi({
  runId,
  host,
  environment,
  fetcher = fetch,
}: {
  runId: string;
  host: string;
  environment: RuntimeEnvironment;
  fetcher?: Fetcher;
}): Promise<{ run: ResearchRun; revision: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId) || runId.length > 128) {
    throw new Error("Invalid process-local run identifier.");
  }
  const origin = resolveProcessLocalOrigin(host, environment);
  const response = await fetcher(
    `${origin}/api/runs/${encodeURIComponent(runId)}`,
    { cache: "no-store", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error("Process-local run unavailable.");
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(",") !== "revision,run" ||
    typeof payload.revision !== "string" ||
    payload.revision.length === 0 ||
    payload.revision.length > 128 ||
    !isRecord(payload.run) ||
    payload.run.id !== runId ||
    payload.run.schemaVersion !== "0.2" ||
    payload.run.evidenceMode !== "fixture" ||
    !isRecord(payload.run.packet) ||
    payload.run.packet.fingerprint !==
      "a99b8fb0df30f7fd8f9c7a5dbcdb0cba027d42653a40350eaa81b597d5c2f4e7"
  ) {
    throw new Error("Invalid process-local run response.");
  }
  const snapshot = structuredClone(payload) as {
    run: ResearchRun;
    revision: string;
  };
  const waiting =
    snapshot.run.status === "awaiting_final_approval" &&
    snapshot.run.finalDecision === null;
  const terminal =
    (snapshot.run.status === "approved" || snapshot.run.status === "rejected") &&
    inspectStoredTerminal(snapshot.run, snapshot.revision) !== null;
  if (!waiting && !terminal) {
    throw new Error("Invalid process-local run response.");
  }
  return snapshot;
}
