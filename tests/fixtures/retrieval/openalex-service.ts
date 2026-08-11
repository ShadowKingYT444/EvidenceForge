export const OPENALEX_WORK_1 = {
  id: "https://openalex.org/W1111111111",
  doi: "https://doi.org/10.1000/example-one",
  title: "A bounded evidence discovery example",
  publication_year: 2024,
  cited_by_count: 12,
  cited_by_api_url:
    "https://api.openalex.org/works?filter=cites:W1111111111",
  authorships: [
    {
      author: {
        id: "https://openalex.org/A1111111111",
        display_name: "Ada Example",
      },
    },
  ],
  primary_location: {
    landing_page_url: "https://publisher.example/work-one",
    is_oa: false,
    license: null,
    version: "publishedVersion",
    source: {
      id: "https://openalex.org/S1111111111",
      display_name: "Journal of Bounded Examples",
    },
  },
  best_oa_location: null,
  open_access: {
    is_oa: false,
    oa_status: "closed",
    any_repository_has_fulltext: false,
  },
  abstract_inverted_index: {
    Bounded: [0],
    abstract: [1],
  },
};

export const OPENALEX_WORK_2 = {
  id: "https://openalex.org/W2222222222",
  doi: null,
  title: "An open access signal is not a rights decision",
  publication_year: 2023,
  cited_by_count: 3,
  cited_by_api_url:
    "https://api.openalex.org/works?filter=cites:W2222222222",
  authorships: [
    {
      author: {
        id: "https://openalex.org/A2222222222",
        display_name: "Grace Example",
      },
    },
  ],
  primary_location: {
    landing_page_url: "https://repository.example/work-two",
    is_oa: true,
    license: "cc-by",
    version: "acceptedVersion",
    source: {
      id: "https://openalex.org/S2222222222",
      display_name: "Example Repository",
    },
  },
  best_oa_location: {
    landing_page_url: "https://repository.example/work-two",
    is_oa: true,
    license: "cc-by",
    version: "acceptedVersion",
    source: {
      id: "https://openalex.org/S2222222222",
      display_name: "Example Repository",
    },
  },
  open_access: {
    is_oa: true,
    oa_status: "green",
    any_repository_has_fulltext: true,
  },
  abstract_inverted_index: null,
};

export const OPENALEX_WORK_3 = {
  id: "https://openalex.org/W3333333333",
  doi: "https://doi.org/10.1000/example-three",
  title: null,
  publication_year: null,
  cited_by_count: 0,
  cited_by_api_url:
    "https://api.openalex.org/works?filter=cites:W3333333333",
  authorships: [],
  primary_location: null,
  best_oa_location: null,
  open_access: {
    is_oa: false,
    oa_status: null,
    any_repository_has_fulltext: false,
  },
  abstract_inverted_index: null,
};

export function openAlexPage(
  results: readonly unknown[],
  nextCursor: string | null,
  options: {
    count?: number;
    costUsd?: number;
  } = {},
) {
  return {
    meta: {
      count: options.count ?? results.length,
      per_page: results.length,
      next_cursor: nextCursor,
      cost_usd: options.costUsd ?? 0.001,
    },
    results,
    group_by: [],
  };
}
