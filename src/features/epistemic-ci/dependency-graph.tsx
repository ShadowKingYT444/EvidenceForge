"use client";

import {
  Beaker,
  BookOpen,
  CircleDot,
  FlaskConical,
  Gavel,
  GitBranch,
  Scale,
  ShieldAlert,
  Target,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { EpistemicBuild, EpistemicNode } from "./contracts";
import { NodeInspector } from "./node-inspector";
import { StateBadge } from "./primitives";
import styles from "./workspace.module.css";

const lanes = [
  { id: "evidence", label: "Evidence", kinds: ["passage"] },
  { id: "reasoning", label: "Claims & constraints", kinds: ["scope", "assumption", "claim", "objection"] },
  { id: "validation", label: "Criteria & next tests", kinds: ["criterion", "gap", "experiment"] },
  { id: "decision", label: "Decision", kinds: ["decision"] },
] as const;

const kindIcons = {
  passage: BookOpen,
  scope: Target,
  assumption: GitBranch,
  claim: CircleDot,
  criterion: Scale,
  gap: ShieldAlert,
  experiment: FlaskConical,
  objection: ShieldAlert,
  decision: Gavel,
} as const;

type Position = { x: number; y: number };

export function DependencyGraph({ build }: { build: EpistemicBuild }) {
  const [selected, setSelected] = useState<EpistemicNode | null>(null);
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const impacted = useMemo(() => new Set(build.impactedNodeIds), [build.impactedNodeIds]);
  const nodesById = useMemo(
    () => new Map(build.graph.nodes.map((node) => [node.id, node])),
    [build.graph.nodes],
  );
  const positions = useMemo(() => {
    const result = new Map<string, Position>();
    lanes.forEach((lane, laneIndex) => {
      const members = build.graph.nodes.filter((node) => lane.kinds.includes(node.kind as never));
      members.forEach((node, index) => {
        const gap = 430 / Math.max(members.length, 1);
        result.set(node.id, { x: 18 + laneIndex * 260, y: 48 + index * gap });
      });
    });
    return result;
  }, [build.graph.nodes]);

  return (
    <section className={styles.graphPanel} aria-labelledby="dependency-graph-title">
      <header className={styles.panelHeader}>
        <div>
          <span>Derived dependency build</span>
          <h2 id="dependency-graph-title">What depends on what</h2>
        </div>
        <span className={styles.graphCount}>{build.graph.nodes.length} nodes · {build.graph.edges.length} typed edges</span>
      </header>
      <div className={styles.graphCanvas}>
        <div className={styles.laneLabels} aria-hidden="true">
          {lanes.map((lane) => <span key={lane.id}>{lane.label}</span>)}
        </div>
        <svg className={styles.graphEdges} viewBox="0 0 1040 520" preserveAspectRatio="none" aria-hidden="true">
          {build.graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const middle = (from.x + to.x) / 2;
            return (
              <path
                key={edge.id}
                d={`M ${from.x + 178} ${from.y + 25} C ${middle} ${from.y + 25}, ${middle} ${to.y + 25}, ${to.x} ${to.y + 25}`}
                data-relation={edge.relation}
                data-impacted={impacted.has(edge.from) || impacted.has(edge.to)}
              />
            );
          })}
        </svg>
        <div className={styles.graphNodes}>
          {build.graph.nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const Icon = kindIcons[node.kind] ?? Beaker;
            return (
              <button
                key={node.id}
                className={styles.graphNode}
                data-kind={node.kind}
                data-state={node.state}
                data-impacted={impacted.has(node.id)}
                style={{ left: position.x, top: position.y }}
                type="button"
                aria-label={`${node.label}. ${node.state}. Open details.`}
                onClick={(event) => {
                  returnTarget.current = event.currentTarget;
                  setSelected(node);
                }}
              >
                <Icon aria-hidden="true" size={15} />
                <span><strong>{node.label}</strong><small>{node.kind.replaceAll("_", " ")}</small></span>
                <StateBadge state={node.state} />
              </button>
            );
          })}
        </div>
      </div>
      <details className={styles.relationshipList}>
        <summary>Accessible dependency list</summary>
        <ul>
          {build.graph.edges.map((edge) => {
            const from = nodesById.get(edge.from)?.label ?? edge.from;
            const to = nodesById.get(edge.to)?.label ?? edge.to;
            return <li key={edge.id}><strong>{from}</strong> {edge.relation.replaceAll("_", " ")} <strong>{to}</strong></li>;
          })}
        </ul>
      </details>
      {selected ? <NodeInspector node={selected} returnTarget={returnTarget} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
