const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

export class PdfDownloadError extends Error { constructor(readonly code: "untrusted_origin" | "private_address" | "redirect_blocked" | "http_error" | "not_pdf" | "too_large" | "invalid_url", message: string) { super(message); this.name = "PdfDownloadError"; } }

function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h.endsWith(".internal")) return true;
  const parts = h.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function allowed(url: URL, origins: readonly string[]): boolean { return origins.some((origin) => { try { return new URL(origin).origin === url.origin; } catch { return false; } }); }

export async function downloadBoundedPdf(input: string, options: { trustedOrigins: readonly string[]; fetch?: typeof fetch; maxBytes?: number }): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string | null }> {
  let url: URL; try { url = new URL(input); } catch { throw new PdfDownloadError("invalid_url", "Invalid PDF URL"); }
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  if (url.protocol !== "https:" || privateHost(url.hostname)) throw new PdfDownloadError("private_address", "Only public HTTPS addresses are allowed");
  if (!allowed(url, options.trustedOrigins)) throw new PdfDownloadError("untrusted_origin", "PDF origin is not a trusted scholarly provider");
  const response = await (options.fetch ?? fetch)(url.toString(), { redirect: "manual", headers: { accept: "application/pdf" } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location"); if (!location) throw new PdfDownloadError("redirect_blocked", "Redirect has no location");
    let redirected: URL; try { redirected = new URL(location, url); } catch { throw new PdfDownloadError("redirect_blocked", "Invalid redirect location"); }
    if (redirected.protocol !== "https:" || privateHost(redirected.hostname) || !allowed(redirected, options.trustedOrigins)) throw new PdfDownloadError("redirect_blocked", "Redirect leaves the trusted provider origin");
    return downloadBoundedPdf(redirected.toString(), options);
  }
  if (!response.ok) throw new PdfDownloadError("http_error", `PDF request failed (${response.status})`);
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("application/pdf")) {
    throw new PdfDownloadError("not_pdf", "Response content type is not PDF");
  }
  const declared = Number(response.headers.get("content-length") ?? "0"); if (declared > maxBytes) throw new PdfDownloadError("too_large", "PDF exceeds byte limit");
  const buffer = new Uint8Array(await response.arrayBuffer()); if (buffer.byteLength > maxBytes) throw new PdfDownloadError("too_large", "PDF exceeds byte limit");
  if (buffer.length < PDF_MAGIC.length || !PDF_MAGIC.every((value, index) => buffer[index] === value)) throw new PdfDownloadError("not_pdf", "Response is not a PDF");
  return { bytes: buffer, finalUrl: url.toString(), contentType };
}
