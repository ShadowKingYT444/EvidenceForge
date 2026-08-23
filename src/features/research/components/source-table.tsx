import { ArrowRight, Trash2 } from "lucide-react";

export type SourceTableRow = { id: string; title: string; year: string; kind: string; coverage: string; rights: string; passages: number; verification: string; pending: boolean };

export function SourceTable({ rows, loading, onSelect, onRemove }: { rows: SourceTableRow[]; loading: boolean; onSelect: (row: SourceTableRow, target: HTMLElement) => void; onRemove: (id: string) => Promise<void> }) {
  const passageCount = rows.reduce((total, row) => total + row.passages, 0);
  const pending = rows.some((row) => row.pending);
  return <div className="research-source-table-wrap"><div className="research-ledger-header"><h3>Packet ledger</h3><span>{rows.length} sources / {passageCount} {pending ? "awaiting verification" : "verified"}</span></div><table className="research-source-table"><caption>Retained scholarly sources and passage verification</caption><thead><tr><th scope="col">Source</th><th scope="col">Year / type</th><th scope="col">Claim coverage</th><th scope="col">Access / rights</th><th scope="col">Passages</th><th scope="col">Verification</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id} data-state={row.pending ? "pending" : "retained"}><th scope="row"><button type="button" onClick={(event) => onSelect(row, event.currentTarget)}><span>{row.title}</span><ArrowRight size={13} aria-hidden="true" /></button></th><td>{row.year}<small>{row.kind}</small></td><td>{row.coverage}</td><td>{row.rights}</td><td>{row.passages}</td><td><span className="research-table-status">{row.verification}</span></td><td><button type="button" className="research-icon-button" aria-label={`Remove ${row.title}`} onClick={() => void onRemove(row.id)}><Trash2 size={14} /></button></td></tr>)}
    {loading && rows.length === 0 ? Array.from({ length: 4 }, (_, index) => <tr className="research-source-skeleton" key={index} aria-hidden="true"><td colSpan={7}><span /></td></tr>) : null}
  </tbody></table>{!loading && rows.length === 0 ? <div className="research-ledger-empty"><strong>Collection has not retained a source yet.</strong><p>EvidenceForge will screen candidates, import permitted text, and expose exact passages here. You can also add a trusted source.</p></div> : null}</div>;
}
