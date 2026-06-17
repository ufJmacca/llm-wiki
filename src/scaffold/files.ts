import type { InitAgent } from "../config/defaults.js";
import type { ScaffoldEntry } from "../utils/fs.js";

export type WikiScaffoldOptions = {
  agent: InitAgent;
  obsidian: boolean;
  dataview: boolean;
  git: boolean;
};

export function planWikiScaffold(options: WikiScaffoldOptions): ScaffoldEntry[] {
  const entries: ScaffoldEntry[] = [
    { path: ".gitignore", content: gitignoreContent() },
    { path: ".llm-wiki/config.yml", content: configContent(options) },
    { path: ".llm-wiki/profiles/local.yml", content: localProfileContent() },
    { path: ".llm-wiki/profiles/public.yml", content: publicProfileContent() },
    { path: ".llm-wiki/profiles/review.yml", content: reviewProfileContent() },
    { path: ".llm-wiki/schema.yml", content: schemaContent() },
    { path: ".llm-wiki/templates/comparison.md", content: comparisonTemplateContent() },
    { path: ".llm-wiki/templates/concept.md", content: conceptTemplateContent() },
    { path: ".llm-wiki/templates/entity.md", content: entityTemplateContent() },
    { path: ".llm-wiki/templates/log-entry.md", content: logEntryTemplateContent() },
    { path: ".llm-wiki/templates/question.md", content: questionTemplateContent() },
    { path: ".llm-wiki/templates/review-page.md", content: reviewPageTemplateContent() },
    { path: ".llm-wiki/templates/source-card.md", content: sourceCardTemplateContent() },
    { path: ".llm-wiki/templates/source-summary.md", content: sourceSummaryTemplateContent() },
    { path: ".llm-wiki/templates/topic.md", content: topicTemplateContent() },
    { path: "AGENTS.md", content: agentInstructionsContent() },
    { path: "README.md", content: readmeContent() },
    { path: "curated/contradictions.md", content: titledPage("Contradictions", "page") },
    { path: "curated/home.md", content: titledPage("Home", "page") },
    { path: "curated/index.md", content: indexContent() },
    { path: "curated/log.md", content: logContent() },
    { path: "curated/map.md", content: titledPage("Map", "page") },
    { path: "curated/open-questions.md", content: titledPage("Open Questions", "page") },
    { path: "raw/inputs/.gitkeep", content: "" },
    { path: "raw/queue/.gitkeep", content: "" },
    { path: "raw/README.md", content: rawReadmeContent() },
  ];

  if (options.agent === "codex") {
    entries.push({ path: "CODEX.md", content: agentVariantContent("Codex") });
  }

  if (options.agent === "claude") {
    entries.push({ path: "CLAUDE.md", content: agentVariantContent("Claude") });
  }

  if (options.dataview) {
    entries.push(
      { path: "curated/dashboards/ingestion-queue.md", content: ingestionQueueDashboardContent() },
      { path: "curated/dashboards/needs-review.md", content: needsReviewDashboardContent() },
    );
  }

  if (options.obsidian) {
    entries.push({ path: ".obsidian/app.json", content: "{\n  \"alwaysUpdateLinks\": true\n}\n" });
  }

  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

function readmeContent(): string {
  return `# llm-wiki

This repository is an LLM Wiki workspace with immutable raw sources and curated Markdown synthesis.

## Core layout

- \`raw/inputs/\` stores captured originals and source cards.
- \`raw/queue/\` stores source queue items waiting for ingest.
- \`curated/\` stores LLM-maintained Markdown pages.
- \`curated/index.md\` is the wiki map.
- \`curated/log.md\` is the append-only operation ledger.
`;
}

function gitignoreContent(): string {
  return `.DS_Store
.llm-wiki/cache/
node_modules/
quartz/public/
`;
}

function configContent(options: WikiScaffoldOptions): string {
  return `version: 1
agent:
  default: ${options.agent}
features:
  obsidian: ${options.obsidian}
  dataview: ${options.dataview}
  git: ${options.git}
defaults:
  visibility: private
  source_status: queued
paths:
  raw: raw
  raw_inputs: raw/inputs
  raw_queue: raw/queue
  curated: curated
  index: curated/index.md
  log: curated/log.md
raw:
  immutable_original_glob: raw/inputs/**/original.*
  source_card_name: _source.md
  default_visibility: private
curated:
  default_visibility: private
  require_source_ids: true
  write_policy: llm-maintained-human-reviewable
control_plane:
  index: curated/index.md
  log: curated/log.md
privacy:
  raw_public_by_default: false
  public_requires_visibility: public
`;
}

function schemaContent(): string {
  return `version: 1
visibility:
  default: private
  allowed:
    - private
    - public
page_types:
  raw:
    - raw_source
  curated:
    - source_summary
    - entity
    - concept
    - topic
    - question
    - comparison
    - dashboard
    - index
    - log
    - page
raw_source:
  required:
    - type
    - source_id
    - title
    - source_kind
    - origin
    - captured_at
    - content_hash
    - status
    - visibility
  immutable:
    - raw/inputs/**/original.*
curated_page:
  required:
    - type
    - title
    - visibility
    - source_ids
  recommended:
    - status
    - review_status
    - tags
log:
  append_only: true
  operations:
    - init
    - add
    - ingest
    - query
    - lint
    - explore
    - deploy
    - upload
  heading_pattern: "^## \\\\[[^\\\\]]+\\\\] (init|add|ingest|query|lint|explore|deploy|upload) \\\\| .+ \\\\| .+$"
`;
}

function agentInstructionsContent(): string {
  return `# LLM Wiki Agent Instructions

AGENTS.md is the canonical instruction source for this LLM Wiki. Agent-specific files may point here, but this file defines the shared rules.

## Mission

Maintain this repo as a persistent, compounding LLM Wiki.

## Hard rules

1. Never modify files under \`raw/inputs/**/original.*\`.
2. Treat raw inputs as source of truth.
3. Write and update curated Markdown pages under \`curated/\`.
4. Use Obsidian wikilinks.
5. Preserve provenance through \`source_ids\`.
6. Update \`curated/index.md\` after every ingest.
7. Append to \`curated/log.md\` after every ingest, query save, or lint pass.
8. Flag contradictions explicitly.
9. Do not invent missing facts.
10. Prefer updating existing pages over creating duplicates.
11. Respect page \`visibility\`.
12. Never make private/raw content public without explicit human instruction.

## Page types

- source_summary
- entity
- concept
- topic
- question
- comparison
- dashboard

## Ingest workflow

1. Read the source card and original or extracted content.
2. Read \`curated/index.md\` before creating pages.
3. Create or update the curated source summary.
4. Update relevant entity, concept, topic, question, or comparison pages.
5. Add source provenance through \`source_ids\`.
6. Update \`curated/index.md\`.
7. Append an entry to \`curated/log.md\`.

## Query workflow

Use curated pages first, cite source IDs when filing answers back, and save durable answers under \`curated/questions/\` only when requested.

## Lint workflow

Check frontmatter, wikilinks, source IDs, raw immutability, index coverage, log format, and public/private visibility before considering work complete.

## Review workflow

Flag incomplete evidence with \`review_status: needs-human-review\`, add open questions when facts are missing, and record contradictions explicitly.

## Frontmatter schema

Curated pages must include \`type\`, \`title\`, \`visibility\`, and \`source_ids\`. Raw source cards must include stable source metadata and default to \`visibility: private\`.

## Citation and provenance conventions

Use source-level provenance through \`source_ids\`. Do not invent missing facts or silently merge conflicting claims.

## Public/private visibility rules

Private is the default visibility. Public pages must not link to raw originals, private pages, private source summaries, queue files, or local-only assets.

## Quartz Explorer profile rules

Local and review profiles may include private curated pages and source cards. Public profiles must include only public curated content and fail closed on leaks.
`;
}

function agentVariantContent(agentName: string): string {
  return `# ${agentName} Instructions

Read AGENTS.md first. It is the canonical instruction source for this LLM Wiki.
`;
}

function indexContent(): string {
  return `${frontmatter("index", "Index")}# Index

## Overview

## Sources

| Source | Status | Summary | Key pages |
|---|---|---|---|

## Concepts

| Page | Summary | Source count | Updated |
|---|---:|---:|---|

## Entities

## Topics

## Questions

## Comparisons

## Dashboards

## Needs review

## Orphans / weakly connected pages
`;
}

function logContent(): string {
  return `${frontmatter("log", "Log")}# Log

## Entry format

Append entries using this parseable heading shape:

\`\`\`markdown
## [operation-timestamp] operation | affected-id | title

- actor:
- command:
- git_branch:
- git_commit:
- raw_source:
- created:
- updated:
- contradictions:
- follow_ups:
\`\`\`
`;
}

function titledPage(title: string, type: string): string {
  return `${frontmatter(type, title)}# ${title}
`;
}

function rawReadmeContent(): string {
  return `# Raw Sources

Raw source originals are immutable and private by default. Store captured inputs under \`raw/inputs/\`.

Each source folder should contain a source card named \`_source.md\` and an immutable captured original named \`original.*\`. Derived files such as extracted text may be added next to the original.
`;
}

function sourceCardTemplateContent(): string {
  return `---
type: raw_source
source_id:
title:
source_kind:
origin:
origin_url:
captured_at:
content_hash:
status: queued
visibility: private
tags: []
curated_summary:
ingested_at:
supersedes:
superseded_by:
---

# Raw Source Card

Original file: [[original]]

## Capture notes

## Human notes

## Ingest status

- Status: queued
- Curated summary:
`;
}

function sourceSummaryTemplateContent(): string {
  return `---
type: source_summary
source_id:
title:
source_kind:
source_path:
status: active
visibility: private
confidence: medium
source_ids: []
tags:
  - source-summary
---

# Source Summary

## Summary

## Key claims

## Useful concepts

## Links created or updated

## Contradictions or tensions

## Open questions

## Source references
`;
}

function conceptTemplateContent(): string {
  return wikiPageTemplateContent("concept", "Concept");
}

function entityTemplateContent(): string {
  return wikiPageTemplateContent("entity", "Entity");
}

function topicTemplateContent(): string {
  return wikiPageTemplateContent("topic", "Topic");
}

function questionTemplateContent(): string {
  return `---
type: question
title:
status: active
visibility: private
source_ids: []
source_count: 0
review_status: needs-human-review
tags:
  - question
---

# Question

## Question

## Answer

## Evidence

## Open questions
`;
}

function comparisonTemplateContent(): string {
  return `---
type: comparison
title:
status: active
visibility: private
source_ids: []
source_count: 0
review_status: needs-human-review
tags:
  - comparison
---

# Comparison

## Compared items

## Summary

## Similarities

## Differences

## Evidence

## Open questions
`;
}

function reviewPageTemplateContent(): string {
  return `---
type: dashboard
title:
visibility: private
source_ids: []
tags:
  - review
---

# Review

## Needs human review

## Recent changes

## Contradictions

## Follow-ups
`;
}

function logEntryTemplateContent(): string {
  return `## [operation-timestamp] operation | affected-id | title

- actor:
- command:
- git_branch:
- git_commit:
- raw_source:
- created:
- updated:
- contradictions:
- follow_ups:
`;
}

function wikiPageTemplateContent(type: string, title: string): string {
  return `---
type: ${type}
title:
aliases: []
status: active
visibility: private
source_ids: []
source_count: 0
review_status: needs-human-review
tags:
  - ${type}
---

# ${title}

## Definition

## Why it matters

## Related pages

## Evidence

## Open questions
`;
}

function ingestionQueueDashboardContent(): string {
  return `${frontmatter("dashboard", "Ingestion Queue")}# Ingestion Queue

\`\`\`dataview
TABLE source_kind, status, captured_at, tags
FROM "raw/inputs"
WHERE type = "raw_source" AND status != "ingested"
SORT captured_at DESC
\`\`\`
`;
}

function needsReviewDashboardContent(): string {
  return `${frontmatter("dashboard", "Needs Review")}# Needs Review

\`\`\`dataview
TABLE type, updated, source_count, next_review
FROM "curated"
WHERE review_status = "needs-human-review"
SORT updated DESC
\`\`\`
`;
}

function frontmatter(type: string, title: string): string {
  return `---
type: ${type}
title: ${title}
visibility: private
source_ids: []
---

`;
}

function localProfileContent(): string {
  return `name: local
mode: local-exploration
include:
  - curated/**
  - raw/inputs/**/_source.md
exclude:
  - raw/inputs/**/original.*
visibility:
  include_private: true
`;
}

function reviewProfileContent(): string {
  return `name: review
mode: review
include:
  - curated/**
  - raw/queue/**
visibility:
  include_private: true
`;
}

function publicProfileContent(): string {
  return `name: public
mode: deploy
include:
  - curated/**
exclude:
  - raw/**
  - curated/log.md
visibility:
  include_private: false
safety:
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_missing_visibility: true
`;
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
