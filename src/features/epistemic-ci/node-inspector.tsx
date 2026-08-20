"use client";

import { X } from "lucide-react";
import { useRef } from "react";

import { useFocusBoundary } from "../use-focus-boundary";
import type { EpistemicNode } from "./contracts";
import { StateBadge } from "./primitives";
import styles from "./workspace.module.css";

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

export function NodeInspector({
  node,
  onClose,
  returnTarget,
}: {
  node: EpistemicNode;
  onClose: () => void;
  returnTarget: React.RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  function close() {
    onClose();
    requestAnimationFrame(() => returnTarget.current?.focus());
  }

  useFocusBoundary({
    active: true,
    boundaryRef: dialog,
    initialFocusRef: closeButton,
    onDismiss: close,
  });

  const metadata = Object.entries(node.metadata);
  const deterministicBoundary = node.kind === "passage"
    ? "Exact fixture passage identity and hash are preserved."
    : "Stable node identity and state are derived from the hashed graph build.";
  const modelBoundary = typeof node.metadata.relationship === "string"
    ? `Recorded relationship: ${humanize(node.metadata.relationship)}. This assessment is not mechanical verification.`
    : "No model assessment is promoted to deterministic proof for this node.";
  const humanBoundary = node.kind === "decision"
    ? "The scientific decision remains blocked; a Research PR receipt does not approve it."
    : "Human authorization is recorded separately in the Research PR receipt.";

  return (
    <div className={styles.inspectorBackdrop} onMouseDown={close}>
      <aside
        className={styles.inspector}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="epistemic-node-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{humanize(node.kind)}</span>
            <h2 id="epistemic-node-title">{node.label}</h2>
          </div>
          <button ref={closeButton} type="button" onClick={close} aria-label="Close node details">
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className={styles.inspectorBody}>
          <StateBadge state={node.state} />
          <section>
            <h3>{node.kind === "passage" ? "Exact passage" : "Recorded meaning"}</h3>
            {node.kind === "passage" ? <blockquote>{node.detail}</blockquote> : <p>{node.detail}</p>}
          </section>
          <section>
            <h3>Verification boundary</h3>
            <dl>
              <div><dt>Deterministic verification</dt><dd>{deterministicBoundary}</dd></div>
              <div><dt>Model assessment</dt><dd>{modelBoundary}</dd></div>
              <div><dt>Human decision</dt><dd>{humanBoundary}</dd></div>
            </dl>
          </section>
          <section>
            <h3>Stable record</h3>
            <dl>
              <div><dt>Stable node</dt><dd>{node.id}</dd></div>
              <div><dt>Source reference</dt><dd>{node.sourceRef ?? "Derived node"}</dd></div>
              <div><dt>Branch mutable</dt><dd>{node.mutable ? "Proposal only" : "No"}</dd></div>
            </dl>
          </section>
          {metadata.length > 0 ? (
            <section>
              <h3>Compiler facts</h3>
              <dl>
                {metadata.map(([key, value]) => (
                  <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
