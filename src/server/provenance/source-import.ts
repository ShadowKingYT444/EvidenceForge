import {
  normalizeDoi,
  type DoiNormalizationResult,
} from "../retrieval/doi";

export type SourceImportPreparation = {
  originalDoiInput: string | null;
  originalUrlInput: string | null;
  doi: DoiNormalizationResult;
  canonicalUrl: string | null;
  serverFetch: "forbidden";
  contentPolicy: "pasted_content_only";
};

type SourceImportInput = {
  doi?: string | null;
  url?: string | null;
};

function canonicalizeImportedUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isDoiResolverUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["doi.org", "www.doi.org", "dx.doi.org"].includes(
        url.hostname.toLowerCase(),
      )
    );
  } catch {
    return false;
  }
}

export function prepareSourceImport(
  input: SourceImportInput,
): SourceImportPreparation {
  const originalDoiInput = input.doi ?? null;
  const originalUrlInput = input.url ?? null;
  const doiCandidate =
    originalDoiInput ??
    (originalUrlInput !== null && isDoiResolverUrl(originalUrlInput)
      ? originalUrlInput
      : null);
  const doi = normalizeDoi(doiCandidate);
  const canonicalUrl =
    doi.status === "valid"
      ? doi.canonicalUrl
      : originalUrlInput === null
        ? null
        : canonicalizeImportedUrl(originalUrlInput);

  return {
    originalDoiInput,
    originalUrlInput,
    doi,
    canonicalUrl,
    serverFetch: "forbidden",
    contentPolicy: "pasted_content_only",
  };
}
