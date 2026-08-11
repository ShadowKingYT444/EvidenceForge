import { describe, expect, it } from "vitest";

import { createCrossrefMetadataVerifier } from "../../../src/server/retrieval/crossref";
import type { RegistrationAgencyResult } from "../../../src/server/retrieval/doi";

const LIVE_SMOKE_ENABLED = process.env.CROSSREF_LIVE_SMOKE === "1";
const OFFICIAL_CROSSREF_EXAMPLE_DOI = "10.1128/mbio.01735-25";

describe.skipIf(!LIVE_SMOKE_ENABLED)("Crossref public live smoke", () => {
  it(
    "keeps live transport explicitly labeled and returns the exact checked DOI",
    async () => {
      const registrationAgency: RegistrationAgencyResult = {
        status: "identified",
        agency: "Crossref",
        attempts: 1,
        checkedAt: new Date().toISOString(),
        attemptHistory: [],
      };
      const verifier = createCrossrefMetadataVerifier({
        evidenceMode: "live",
        userAgent: "EvidenceForge-ReverieHacks/0.1",
        retry: {
          maxAttempts: 1,
          timeoutMs: 10_000,
        },
        limits: {
          deadlineMs: 10_000,
        },
      });

      const result = await verifier.verify({
        doi: OFFICIAL_CROSSREF_EXAMPLE_DOI,
        registrationAgency,
        supplied: {},
      });

      expect(result).toMatchObject({
        status: "partial",
        failureCode: null,
        evidenceMode: "live",
        canonicalDoi: OFFICIAL_CROSSREF_EXAMPLE_DOI,
        source: {
          access: "live_transport",
          fromCache: false,
        },
      });
      expect(result.checkedAt).toEqual(expect.any(String));
      expect(result.comparison.fields[0]).toMatchObject({
        field: "doi",
        status: "match",
        supplied: OFFICIAL_CROSSREF_EXAMPLE_DOI,
        provider: OFFICIAL_CROSSREF_EXAMPLE_DOI,
      });
    },
    15_000,
  );
});
