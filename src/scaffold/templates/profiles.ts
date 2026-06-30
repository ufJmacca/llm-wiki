import { PUBLIC_PROFILE_EXCLUDES, PUBLIC_PROFILE_REQUIRED_VISIBILITY } from "../../config/defaults.js";

export function localProfileContent(): string {
  return `name: local
mode: local-exploration
include:
  - curated/**
  - raw/inputs/**/_source.md
  - raw/queue/**
exclude:
  - raw/inputs/**/original.*
  - .git/**
visibility:
  include_private: true
features:
  search: true
  graph: true
  backlinks: true
  upload: true
  review_panel: true
source_links:
  allow_local_file_links: true
`;
}

export function reviewProfileContent(): string {
  return `name: review
mode: review
include:
  - curated/**
  - raw/inputs/**/_source.md
  - raw/queue/**
exclude:
  - raw/inputs/**/original.*
  - .git/**
visibility:
  include_private: true
features:
  search: true
  graph: true
  backlinks: true
  upload: false
  review_panel: true
source_links:
  allow_local_file_links: true
`;
}

export function publicProfileContent(): string {
  return `name: public
mode: deploy
include:
  - curated/**
exclude:
${formatYamlList(PUBLIC_PROFILE_EXCLUDES)}
visibility:
  include_private: false
  required_value: ${PUBLIC_PROFILE_REQUIRED_VISIBILITY}
features:
  search: true
  graph: true
  backlinks: true
  upload: false
  review: false
  review_panel: false
source_links:
  allow_local_file_links: false
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_missing_visibility: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`;
}

function formatYamlList(values: readonly string[]): string {
  return values.map((value) => `  - ${value}`).join("\n");
}
