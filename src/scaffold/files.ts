import type { InitAgent } from "../config/defaults.js";
import type { ScaffoldEntry } from "../utils/fs.js";
import { agentInstructionsContent, agentVariantContent } from "./templates/agents.js";
import { ingestionQueueDashboardContent, needsReviewDashboardContent } from "./templates/dataview.js";
import { obsidianAppConfigContent } from "./templates/obsidian.js";
import { localProfileContent, publicProfileContent, reviewProfileContent } from "./templates/profiles.js";

export type WikiScaffoldOptions = {
  agent: InitAgent;
  obsidian: boolean;
  dataview: boolean;
  git: boolean;
};

export function planWikiScaffold(options: WikiScaffoldOptions): ScaffoldEntry[] {
  const entries: ScaffoldEntry[] = [
    { path: ".gitignore", content: gitignoreContent() },
    { path: ".llm-wiki/checks/lint-rules.yml", content: lintRulesContent() },
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
    { path: "curated/comparisons/.gitkeep", content: "" },
    { path: "curated/concepts/.gitkeep", content: "" },
    { path: "curated/contradictions.md", content: titledPage("Contradictions", "page") },
    { path: "curated/dashboards/.gitkeep", content: "" },
    { path: "curated/entities/.gitkeep", content: "" },
    { path: "curated/home.md", content: titledPage("Home", "page") },
    { path: "curated/index.md", content: indexContent() },
    { path: "curated/log.md", content: logContent() },
    { path: "curated/map.md", content: titledPage("Map", "page") },
    { path: "curated/open-questions.md", content: titledPage("Open Questions", "page") },
    { path: "curated/questions/.gitkeep", content: "" },
    { path: "curated/sources/.gitkeep", content: "" },
    { path: "curated/topics/.gitkeep", content: "" },
    { path: "raw/assets/.gitkeep", content: "" },
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
    entries.push({ path: ".obsidian/app.json", content: obsidianAppConfigContent() });
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

## Local upload and review

Run local upload with \`llm-wiki explore serve --profile local --with-daemon\`.

Opt into upload-triggered auto-ingest with \`llm-wiki explore serve --profile local --with-daemon --auto-ingest-uploads\`.

Capture files, pasted text, or URLs through the local Explorer. Review private queued sources under \`raw/queue/\` and their private source cards before ingest.

Ingest approved sources into curated Markdown with \`llm-wiki ingest <source_id>\`.

Process queued sources with \`llm-wiki queue ingest --auto\`, \`llm-wiki queue ingest --auto --limit 5\`, \`llm-wiki queue ingest --auto --source-id <source_id>\`, or \`llm-wiki queue ingest --auto --watch\`. Watch mode cannot be combined with \`--source-id\` or \`--limit\`.

Auto-ingest uses \`.llm-wiki/config.yml:agent.default\` and requires that default to name a configured local agent under \`agents.<name>\`; provider-mode auto-ingest is deferred.

If no default local agent is configured, upload capture can still leave the source \`queued\`, while \`llm-wiki queue ingest --auto\` fails before moving queue items to \`ingesting\`.

If auto-ingest fails, inspect the \`blocked\` source with \`llm-wiki queue show <source_id>\` or review pages. To retry automation, run \`llm-wiki queue set-status <source_id> queued\` and then \`llm-wiki ingest <source_id> --auto\`; after manual repairs, run \`llm-wiki ingest <source_id> --validate\`.

Duplicate uploads do not trigger a second ingest when the existing source is already \`ingested\`; queued duplicates may attempt the existing queue item.

## GitHub Pages publication

Publish to GitHub Pages by running \`llm-wiki deploy github-pages build-local\`, running \`llm-wiki deploy github-pages check\`, committing \`quartz/public\`, opening a pull request, merging it, and letting Pages serve the committed static files.

Auto-ingest never builds, commits curated files, snapshots, deploys, publishes, or enables uploads on GitHub Pages.

GitHub Pages never supports uploads, upload endpoint config, tokens, runtime daemon metadata, raw originals, private source cards, queue state, or review pages.

Do not commit raw upload artifacts, \`_llm-wiki/runtime/local-daemon.json\`, queue internals, or review-only Explorer pages to the Pages payload.

Treat existing \`upload/github/serverless/*\` files as unsupported migration debris for GitHub Pages.
`;
}

function gitignoreContent(): string {
  return `.DS_Store
.llm-wiki/cache/
node_modules/
quartz/.quartz-cache/
quartz/content/
quartz/quartz/
`;
}

function configContent(options: WikiScaffoldOptions): string {
  return `version: 1
agent:
  default: ${options.agent}
${localAgentConfigContent(options.agent)}features:
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

function localAgentConfigContent(agent: InitAgent): string {
  if (agent !== "codex") {
    return "";
  }

  return `agents:
  codex:
    type: local-exec
    command: codex
    args:
      - exec
    approval_policy: never
    sandbox_mode: workspace-write
    output_mode: git-diff
    timeout_seconds: 900
`;
}

function lintRulesContent(): string {
  return `version: 1
rules:
  raw_originals_are_immutable:
    severity: error
    glob: raw/inputs/**/original.*
  raw_sources_default_private:
    severity: error
    required_value: private
  curated_pages_require_frontmatter:
    severity: error
    required:
      - type
      - title
      - visibility
      - source_ids
  log_entries_use_parseable_headings:
    severity: error
    heading_pattern: "^## \\\\[[^\\\\]]+\\\\] (init|add|ingest|query|lint|explore|deploy|upload) \\\\| .+ \\\\| .+$"
  public_pages_require_visibility:
    severity: error
    required_value: public
  public_pages_must_not_link_raw:
    severity: error
  public_pages_must_not_link_private:
    severity: error
  public_search_must_not_include_private_text:
    severity: error
  public_graph_must_not_include_private_nodes:
    severity: error
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

function frontmatter(type: string, title: string): string {
  return `---
type: ${type}
title: ${title}
visibility: private
source_ids: []
---

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
