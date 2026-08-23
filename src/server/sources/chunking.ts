import { createHash } from "node:crypto";

export type RankedChunk = {
  id: string;
  text: string;
  location: string;
  score: number;
  contentHash: string;
  paragraphIndex: number;
};

const MAX_CHUNKS = 32;
const MAX_CHARS = 160_000;

const words = (value: string) => new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? []);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const normalizedChunkText = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();

export function rankClaimChunks(input: {
  sourceId: string;
  text: string;
  claim: string;
  location?: string;
  maxChunks?: number;
  maxChars?: number;
}): RankedChunk[] {
  const maxChunks = Math.min(input.maxChunks ?? MAX_CHUNKS, MAX_CHUNKS);
  const maxChars = Math.min(input.maxChars ?? MAX_CHARS, MAX_CHARS);
  const paragraphs = input.text
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map(normalizedChunkText)
    .filter(Boolean);
  const claimWords = words(input.claim);
  const ranked = paragraphs
    .map((text, index) => {
      const paragraphWords = words(text);
      const overlap = [...claimWords].filter((word) => paragraphWords.has(word)).length;
      return { text, index, score: claimWords.size ? overlap / claimWords.size : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: RankedChunk[] = [];
  let chars = 0;
  for (const part of ranked) {
    if (selected.length >= maxChunks || chars + part.text.length > maxChars) continue;
    const contentHash = hash(part.text);
    selected.push({
      id: `${input.sourceId}-chunk-${contentHash.slice(0, 20)}-p${part.index + 1}`,
      text: part.text,
      location: input.location ? `${input.location} - paragraph ${part.index + 1}` : `paragraph ${part.index + 1}`,
      score: part.score,
      contentHash,
      paragraphIndex: part.index,
    });
    chars += part.text.length;
  }
  return selected;
}
