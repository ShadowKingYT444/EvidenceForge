export type PdfPage = { pageNumber: number; text: string };
export type PdfTextExtraction = { pages: PdfPage[]; text: string; pageCount: number };
export type UnpdfLikeModule = { extractText: (data: Uint8Array | ArrayBuffer, options?: { mergePages?: boolean }) => Promise<{ text: string | string[]; totalPages?: number }> };

export async function extractPdfText(bytes: Uint8Array, parser: UnpdfLikeModule): Promise<PdfTextExtraction> {
  const result = await parser.extractText(bytes, { mergePages: false });
  if ((result.totalPages ?? 0) > 50) throw new Error("PDF exceeds 50-page limit");
  const raw = result.text;
  const pageTexts = Array.isArray(raw) ? raw : raw.split(/\f/gu);
  const pages = pageTexts.map((text, index) => ({ pageNumber: index + 1, text: text.replace(/\s+/gu, " ").trim() })).filter((page) => page.text.length > 0);
  if (pages.length > 50) throw new Error("PDF exceeds 50-page limit");
  return { pages, text: pages.map((page) => page.text).join("\n\n"), pageCount: pages.length };
}
