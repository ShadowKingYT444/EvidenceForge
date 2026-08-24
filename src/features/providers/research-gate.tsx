"use client";

import { useEffect, useState } from "react";

import { EpistemicCiWorkspace } from "../epistemic-ci/workspace";
import { ProviderOnboarding } from "./onboarding";

export type GateState = {
  configured: boolean;
  ownerDemo: boolean;
  session: null | { primary: { provider: string; model: string }; reviewer: { provider: string; model: string }; expiresAt: string };
};

export function ResearchGate({ initialState }: { initialState: GateState }) {
  const [state, setState] = useState<GateState>(initialState);
  const [error, setError] = useState("");
  async function refresh() {
    try {
      const response = await fetch("/api/session/research", { cache: "no-store" });
      if (!response.ok) throw new Error("Session status unavailable");
      setState(await response.json() as GateState);
      setError("");
    } catch {
      setError("The secure credential session is unavailable. Refresh and try again.");
      setState({ configured: false, ownerDemo: false, session: null });
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session/research", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session status unavailable");
        setState(await response.json() as GateState);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("The secure credential session is unavailable. Refresh and try again.");
      });
    return () => controller.abort();
  }, []);
  if (!state.configured) return <ProviderOnboarding ownerDemo={state.ownerDemo} error={error} onChanged={() => void refresh()} />;
  return <EpistemicCiWorkspace ownerDemo={state.ownerDemo} />;
}
