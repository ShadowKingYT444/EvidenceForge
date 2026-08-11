export const CROSSREF_DOI = "10.5555/evidence.2026.21";

export const CROSSREF_WORK = {
  DOI: CROSSREF_DOI.toUpperCase(),
  title: ["Evidence-first metadata verification"],
  author: [
    {
      given: "Ada",
      family: "Lovelace",
      sequence: "first",
    },
    {
      given: "Grace",
      family: "Hopper",
      sequence: "additional",
    },
  ],
  "published-print": {
    "date-parts": [[2024, 4, 2]],
  },
  "published-online": {
    "date-parts": [[2023, 12, 18]],
  },
  issued: {
    "date-parts": [[2022]],
  },
  created: {
    "date-parts": [[2021, 8, 1]],
  },
  "update-to": [
    {
      DOI: "10.5555/evidence.2026.correction",
      type: "correction",
      source: "publisher",
      label: "Correction",
      updated: {
        "date-time": "2025-02-03T00:00:00Z",
      },
    },
  ],
  relation: {
    "updated-by": [
      {
        id: "10.5555/evidence.2026.notice",
        "id-type": "doi",
        "asserted-by": "subject",
      },
    ],
  },
};

export function crossrefEnvelope(
  message: Record<string, unknown> = CROSSREF_WORK,
) {
  return {
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message,
  };
}
