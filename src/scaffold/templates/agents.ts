export function agentInstructionsContent(): string {
  return `# LLM Wiki Agent Instructions

AGENTS.md is the canonical instruction source for this LLM Wiki. Agent-specific files may point here, but this file defines the shared rules.

## Mission

Maintain this repo as a persistent, compounding LLM Wiki.

## Hard rules

1. Never modify files under \`raw/inputs/**/original.*\`.
2. Treat raw inputs as source of truth.
3. Write and update curated Markdown pages under \`curated/\`.
4. Use Obsidian wikilinks.
   - Link targets must be repo-root-relative. For curated pages, include the \`curated/\` prefix, for example \`[[curated/topics/example|Example]]\`.
5. Preserve provenance through \`source_ids\`.
6. Update \`curated/index.md\` after every ingest.
7. Append to \`curated/log.md\` after every ingest, query save, or lint pass.
8. Flag contradictions explicitly.
9. Do not invent missing facts.
10. Prefer updating existing pages over creating duplicates.
11. Respect page \`visibility\`.
12. Never make private/raw content public without explicit human instruction.
13. Do not curate a PDF until a validated canonical \`document.md\` artifact is selected.

## Page types

- source_summary
- entity
- concept
- topic
- question
- comparison
- dashboard

## Ingest workflow

1. Read the source card. For PDFs, use only the selected validated canonical extraction artifact; for other supported sources, use the captured content supplied by the ingest task.
2. Read \`curated/index.md\` before creating pages.
3. Create or update the curated source summary.
4. Update relevant entity, concept, topic, question, or comparison pages.
5. Add source provenance through \`source_ids\`.
6. Update \`curated/index.md\`.
7. Append an entry to \`curated/log.md\`.

## PDF artifact workflow

Queue status and PDF extraction status are separate state machines.

Do not curate a PDF until a validated canonical \`document.md\` artifact is selected.

Run \`llm-wiki extract pdf <source_id>\` when the artifact is missing, stale, or inconsistent. A blocked queue item must first be returned to \`queued\` with \`llm-wiki queue set-status <source_id> queued\`.

PDF originals, extraction runs, metadata, queue state, and review data stay private. Never copy raw extraction content or operational provenance into public output.

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

export function agentVariantContent(agentName: string): string {
  if (agentName === "Codex") {
    return `# Codex Instructions

Read AGENTS.md first. AGENTS.md is authoritative for this LLM Wiki.

## Standalone PDF experiment

The standalone PDF experiment requires \`pdf@openai-primary-runtime\`.

Codex installation, authentication, and plugin enablement are user-managed. This is a standalone Codex experiment with no parser fallback.

Use \`llm-wiki status\` to inspect readiness and \`llm-wiki extract pdf <source_id>\` to create or reselect the private canonical artifact. Never write PDF extraction metadata or any path other than the permitted \`document.md\` proposal.

A future \`ainative\` workflow must call the shared artifact boundary instead of duplicating extraction logic.
`;
  }

  return `# ${agentName} Instructions

Read AGENTS.md first. AGENTS.md is authoritative for this LLM Wiki.
`;
}
