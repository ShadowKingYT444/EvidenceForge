/** Shared, provider-neutral types for bounded automatic research. */

export type ResearchRole = "support" | "challenge";

export type ResearchWorkerStatus =
  | "completed"
  | "fallback"
  | "failed"
  | "cancelled"
  | "timed-out";

export type ResearchProgressKind =
  | "queued"
  | "started"
  | "completed"
  | "fallback"
  | "failed"
  | "cancelled"
  | "degraded"
  | "finished";

export interface ResearchProgressEvent {
  kind: ResearchProgressKind;
  itemId?: string;
  completed: number;
  total: number;
  concurrency: number;
  timestamp: number;
  detail?: string;
}

export interface WorkerAuditResult<T> {
  itemId: string;
  index: number;
  status: ResearchWorkerStatus;
  value?: T;
  error?: unknown;
  startedAt?: number;
  finishedAt: number;
  durationMs?: number;
  concurrencyAtStart: number;
  fallbackUsed: boolean;
  signal?: "429" | "5xx" | "timeout" | "cancelled" | "error";
}

export interface ResearchWorkItem<TQuery = string> {
  id: string;
  query: TQuery;
  /** Optional stable key when the provider's item id differs from query identity. */
  key?: string;
}

export interface ResearchWorkerContext<TQuery = string> {
  signal: AbortSignal;
  item: ResearchWorkItem<TQuery>;
  index: number;
  concurrency: number;
  deadlineAt: number;
}

export type ResearchWorker<T, TQuery = string> = (
  item: ResearchWorkItem<TQuery>,
  context: ResearchWorkerContext<TQuery>,
) => Promise<T> | T;

export type ResearchFallback<T, TQuery = string> = (
  item: ResearchWorkItem<TQuery>,
  error: unknown,
  context: ResearchWorkerContext<TQuery>,
) => Promise<T> | T;

export interface ResearchRunResult<T> {
  results: Array<WorkerAuditResult<T>>;
  progress: ResearchProgressEvent[];
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
  deadlineExceeded: boolean;
  finalConcurrency: number;
}

export interface CandidateRights {
  /** True only when the source may be retained for this run. */
  eligible: boolean;
  basis?: string;
}

export interface CandidateContentScope {
  /** True only when the content is within the requested scope. */
  eligible: boolean;
  basis?: string;
}

export interface EvidenceCandidate {
  id: string;
  url?: string;
  title?: string;
  abstract?: string;
  query?: string;
  role: ResearchRole;
  rank?: number;
  score?: number;
  publishedAt?: string | number | Date;
  /** Explicit eligibility is required; omitted is ineligible. */
  rights?: CandidateRights;
  contentScope?: CandidateContentScope;
  rightsEligible?: boolean;
  contentScopeEligible?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RankedCandidate extends EvidenceCandidate {
  deterministicScore: number;
  originalIndex: number;
}

export interface PacketSelectionRejection {
  candidate: EvidenceCandidate;
  reason:
    | "duplicate"
    | "rights-ineligible"
    | "content-scope-ineligible"
    | "candidate-cap"
    | "not-selected";
}

export interface EvidencePacket {
  selected: RankedCandidate[];
  rejected: PacketSelectionRejection[];
  supportCount: number;
  challengeCount: number;
  eligibleCount: number;
  target: number;
  minimum: number;
  mixedRoles: boolean;
}
