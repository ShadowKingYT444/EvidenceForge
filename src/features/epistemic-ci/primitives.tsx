import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";

import styles from "./workspace.module.css";

export function shortHash(value: string): string {
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}
export function StateBadge({ state, label }: { state: string; label?: string }) {
  const Icon = state === "supported" || state === "resolved" || state === "passing"
    ? CheckCircle2
    : state === "conflicting" || state === "blocked" || state === "failing"
      ? XCircle
      : state === "insufficient" || state === "warning" || state === "obsolete"
        ? AlertTriangle
        : CircleHelp;
  return (
    <span className={styles.stateBadge} data-state={state}>
      <Icon aria-hidden="true" size={13} strokeWidth={2} />
      {label ?? state.replaceAll("_", " ")}
    </span>
  );
}

export function BusyState({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.busyState} role="status" aria-live="polite">
      <LoaderCircle aria-hidden="true" size={18} />
      <span>{children}</span>
    </div>
  );
}

export function FailureState({
  title,
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  title: string;
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <section className={styles.failureState} role="alert">
      <AlertTriangle aria-hidden="true" size={20} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
        <button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={14} /> {retryLabel}
        </button>
      </div>
    </section>
  );
}
