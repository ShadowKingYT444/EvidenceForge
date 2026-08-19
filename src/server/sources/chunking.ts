import { createHash } from "node:crypto";

export type RankedChunk = { id: string; text: string; location: string; score: number; contentHash: string; };
const MAX_CHUNKS = 32; const MAX_CHARS = 160_000;
const words = (value: string) => new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function rankClaimChunks(input: { sourceId: string; text: string; claim: string; location?: string; maxChunks?: number; maxChars?: number }): RankedChunk[] {
  const maxChunks = Math.min(input.maxChunks ?? MAX_CHUNKS, MAX_CHUNKS); const maxChars = Math.min(input.maxChars ?? MAX_CHARS, MAX_CHARS);
  const paragraphs = input.text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u).map((text) => text.trim()).filter(Boolean);
  const claimWords = words(input.claim);
  const ranked = paragraphs.map((text, index) => { const paragraphWords = words(text); const overlap = [...claimWords].filter((word) => paragraphWords.has(word)).length; return { text, index, score: claimWords.size ? overlap / claimWords.size : 0 }; }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: RankedChunk[] = []; let chars = 0;
  for (const part of ranked) { if (selected.length >= maxChunks || chars + part.text.length > maxChars) continue; const id = `${input.sourceId}-chunk-${selected.length + 1}`; selected.push({ id, text: part.text, location: input.location ? `${input.location} · paragraph ${part.index + 1}` : `paragraph ${part.index + 1}`, score: part.score, contentHash: hash(part.text) }); chars += part.text.length; }
  return selected;
}
