# PRD-020 — Retrieval, Verification, and Provenance

## Lane mission

Turn a bounded, user-approved source packet into normalized source records, immutable source chunks, deterministic existence/metadata checks, and traceable evidence-card inputs without claiming access or certainty the system does not have.

The first vertical slice must work from five to eight curated titles, abstracts, or user-approved excerpts. Live OpenAlex discovery improves packet assembly but is not required for deterministic demo playback.

## Non-goals

- Comprehensive/systematic search coverage.
- Google Scholar scraping, arbitrary web crawling, paywall bypass, or unrestricted PDF storage.
- Treating Crossref/OpenAlex metadata as full text.
- Treating an LLM’s entailment label as deterministic citation validation.
- Editing shared contracts, workflow orchestration, UI, or eval scoring.

## Owned paths

- `src/server/retrieval/**`
- `src/server/provenance/**`
- Lane-owned source fixtures and focused tests.

Any required shared field or dependency is a lane 010 request.

## User-visible capability

The user can:

- import a DOI, URL, title/abstract, or labeled excerpt;
- inspect normalized metadata and warnings;
- optionally search OpenAlex and select results into the bounded packet;
- see whether the system has an abstract, a user excerpt, or permitted full text;
- inspect duplicate/merged sources;
- see DOI resolution and bibliographic match separately;
- trace every evidence card to the exact source chunk used.
- freeze the reviewed packet and see its immutable fingerprint before model work begins.

## Service responsibilities

### DOI.org

- Normalize DOI variants to a canonical DOI.
- Resolve the DOI, identify its Registration Agency through `doiRA`, and record status, final URL, timestamp, attempt count, and failure details.
- A successful resolution proves only that the identifier resolves.

### Crossref

- Query only when the DOI Registration Agency is Crossref; return `unsupported_agency` rather than converting a non-Crossref 404 into an invalid DOI.
- Query by DOI using `CROSSREF_MAILTO` and a clear user agent.
- Compare title, authors when available, year, venue, and DOI against supplied metadata.
- Return `verified`, `partial`, `mismatch`, `record_not_found`, `unsupported_agency`, `provider_unavailable`, `rate_limited`, `error`, or `not_applicable` with field-level differences.
- Cache responses and honor backoff/rate-limit signals.
- Inspect both `update-to` and `updated-by`, distinguish a notice from the affected work, and say “no notice found in checked sources” rather than “not retracted.”

### OpenAlex

- Search and filter works using the configured free API key.
- Return only fields needed for selection: title, authors, year, DOI, source, abstract availability, provider-specific locations/open-access/license signals, citation links/counts, and stable OpenAlex ID.
- Preserve the original query and selected result IDs.
- Do not automatically treat top-ranked search results as authoritative or complete.
- Do not download content unless a later approved requirement records a compatible license and cost.
- Redact API keys and query strings from logs and honor current spend/cost headers.

Semantic Scholar is an optional fallback after the primary path works. It must not become a hidden dependency of fixtures or evaluation.

## Ingestion and normalization

For every imported item:

1. Normalize DOI and canonical URL without losing the original user input.
2. Fetch or accept metadata, recording method and timestamp.
3. Detect likely duplicates by DOI first, then canonical URL, then conservative title/year similarity.
4. Record content scope as `metadata_only`, `abstract`, `user_excerpt`, or `full_text`, plus access and exact version/location.
5. Record `mayStore`, `mayDisplay`, and `maySendToModel` as independent `yes`, `no`, or `unknown` rights states.
6. Hash the exact displayable/model-visible UTF-8 content with SHA-256.
7. Split into stable chunks with human-readable location labels.
8. Preserve license/display state and warnings.

Do not paraphrase during ingestion. Source chunks are immutable evidence inputs. A corrected source creates a new hash/version rather than silently changing the old packet.

The application fingerprints a frozen packet from sorted source/chunk hashes using RFC 8785 canonical JSON. Freezing blocks in-place mutation and records a human decision. The fingerprint proves internal immutability, not source authenticity.

## Evidence-card boundary

The lane provides validated source/chunk data to the workflow’s extraction prompt and validates returned references against known IDs. It does not own the prompt registry or shared `EvidenceCard` schema.

Every extracted card must:

- reference an existing subclaim and chunk;
- contain only a quote/excerpt permitted by the chunk;
- identify study setting/sample, result, limitation, and relationship when available;
- fall back to unresolved when the passage does not support a stronger label;
- keep extraction, metadata check, model entailment, and human review separate.

Treat every source chunk as untrusted indirect-prompt input. Delimit it, grant it no tool authority, and never use model output as HTML, a URL, or a filesystem path. The model returns an existing chunk ID plus a literal substring; application code derives the visible quote and rejects missing, ambiguous, or invented text.

Reject cards with invented source IDs, missing chunk IDs, quote text not found in the referenced chunk, or a relationship outside the allowed enum.

## Failure semantics

- `does_not_resolve`: DOI.org did not resolve a syntactically valid identifier.
- `record_not_found`: one metadata provider did not find a record; this says nothing about identifier existence.
- `unsupported_agency`: the DOI belongs to a Registration Agency not implemented by the selected metadata adapter.
- `mismatch`: a record exists but supplied bibliographic fields materially differ.
- `provider_unavailable` or `rate_limited`: the named service could not answer, so no conclusion is possible.
- `error`: malformed request, rate limit, network failure, or unexpected response.
- `unresolved`: available evidence does not decide the claim.

Never convert unavailable/error to not-found or unresolved without preserving the underlying failure.

## Fixtures

Provide offline fixtures for:

- valid DOI with matching Crossref/OpenAlex metadata;
- valid DOI with title/year mismatch;
- invalid or non-resolving DOI;
- valid DataCite DOI that Crossref does not own;
- source without DOI;
- duplicate DOI submitted as different URLs;
- abstract-only source;
- user excerpt with a location label;
- missing content/passage;
- one support and one contradiction for the same subclaim;
- service rate limit or timeout;
- quote not present in the referenced chunk.
- unknown or denied display/model-send rights;
- indirect prompt-injection text;

Fixtures must be labeled `fixture`, contain no restricted full text, and preserve the raw service response or a license-safe minimal representation needed by tests.

## Acceptance criteria

- DOI normalization handles URL, `doi:`, case, and whitespace variants.
- DOI resolution, Registration Agency, and provider metadata checks are independent and field-diffed.
- OpenAlex selection preserves query and selected stable IDs.
- Duplicate ingestion produces one canonical source with aliases, not competing records.
- Every source and chunk has a stable hash.
- A frozen packet has a canonical fingerprint and cannot mutate in place.
- Every evidence card reference resolves and every permitted quote is found in its chunk.
- Abstract-only cards are visibly scoped as abstract-only.
- Not found, mismatch, unavailable, error, unresolved, and human override remain distinct.
- Cached/retried requests obey bounded backoff and never fabricate a service response.
- Arbitrary user URLs are never server-fetched in the MVP; URL import is canonicalization plus pasted content only.
- API keys, query strings, private excerpts, and user questions do not appear in scholarly-service logs.
- Offline fixture tests cover all listed failure modes.
- A live DOI/Crossref/OpenAlex smoke test is run only when permitted and configured; key/rate/network failure remains blocked.

## Required handoff

List service methods, fixture paths, cache behavior, live checks attempted, evidence modes, content/license assumptions, failed/blocked cases, and any contract field requests. Do not report a live retrieval pass from fixture data.
