import { describe, expect, it } from "vitest";

import { searchFirecrawl } from "../../../src/server/sources/firecrawl";
import { searchScholarlyWorks } from "../../../src/server/sources/openalex";

const openAlexApiKey = process.env.OPENALEX_API_KEY?.trim() ?? "";
const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim() ?? "";

describe("credentialed multi-provider retrieval smoke", () => {
  it.runIf(Boolean(openAlexApiKey && firecrawlApiKey))("queries OpenAlex and Firecrawl without exposing either key", async () => {
    const query = "retrieval augmented generation factual accuracy evaluation";
    const [scholarly, web] = await Promise.all([
      searchScholarlyWorks(query, { apiKey: openAlexApiKey, evidenceMode: "live", limits: { maxResults: 2, pageSize: 2, maxPages: 1, deadlineMs: 20_000 } }),
      searchFirecrawl(query, { apiKey: firecrawlApiKey, maxResults: 2, deadlineMs: 30_000 }),
    ]);
    expect(["completed", "partial"], JSON.stringify({ provider: "openalex", audit: scholarly.raw })).toContain(scholarly.raw.status);
    expect(scholarly.candidates.length).toBeGreaterThan(0);
    expect(["completed", "partial"], JSON.stringify({ provider: "firecrawl", audit: web.raw })).toContain(web.raw.status);
    expect(web.candidates.length).toBeGreaterThan(0);
    const serialized = JSON.stringify({ scholarly, web });
    expect(serialized).not.toContain(openAlexApiKey);
    expect(serialized).not.toContain(firecrawlApiKey);
  }, 60_000);
});
