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
    { path: "AGENTS.md", content: agentInstructionsContent() },
    { path: "README.md", content: readmeContent() },
    { path: "curated/contradictions.md", content: titledPage("Contradictions", "page") },
    { path: "curated/home.md", content: titledPage("Home", "page") },
    { path: "curated/index.md", content: indexContent() },
    { path: "curated/log.md", content: logContent() },
    { path: "curated/map.md", content: titledPage("Map", "page") },
    { path: "curated/open-questions.md", content: titledPage("Open Questions", "page") },
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
agent: ${options.agent}
features:
  obsidian: ${options.obsidian}
  dataview: ${options.dataview}
  git: ${options.git}
`;
}

function schemaContent(): string {
  return `frontmatter:
  required:
    - type
    - title
    - visibility
`;
}

function agentInstructionsContent(): string {
  return `# LLM Wiki Agent Instructions

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
`;
}

function titledPage(title: string, type: string): string {
  return `${frontmatter(type, title)}# ${title}
`;
}

function rawReadmeContent(): string {
  return `# Raw Sources

Raw source originals are immutable. Store captured inputs under raw/inputs/.
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
