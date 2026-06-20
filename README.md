# llm-wiki

`llm-wiki` is a local-first CLI for creating a Git-backed, Obsidian-compatible Markdown wiki that can later grow into the full LLM Wiki workflow described in the PRD.

The current supported foundation is intentionally small: `llm-wiki init` creates a deterministic wiki scaffold with raw/curated separation, agent instructions, profile files, privacy defaults, and Git initialization. `llm-wiki add`, `llm-wiki add-text`, and `llm-wiki add-url` capture private raw sources into the queue with deterministic source IDs, SHA-256 hashes, source cards, queue JSON, and log entries. `llm-wiki queue` and `llm-wiki log` expose that control plane for reviewable local workflow state. Non-init commands share repository discovery and output contracts so future workflow commands can behave consistently.

## Development

Use Node 22.

The local verification commands are the same commands run in CI:

```bash
npm ci
npm run lint
npm test
npm run build
```

CI is defined in `.github/workflows/ci.yml`. It verifies the package itself and does not require any generated wiki repository to be committed.

## Package Structure

- `src/cli.ts` registers the CLI entrypoint and command surface.
- `src/commands/init.ts` owns the first supported `llm-wiki init` command behavior.
- `src/commands/add.ts`, `src/commands/addText.ts`, and `src/commands/addUrl.ts` own source capture command behavior.
- `src/commands/queue.ts` and `src/commands/log.ts` own queue inspection, status transitions, and parsed runtime log output.
- `src/sourceCapture/` owns deterministic source IDs, hashing, metadata, duplicate detection, and raw writes.
- `src/runtime/queue.ts` and `src/runtime/log.ts` own queue/source-card consistency and runtime log parsing/appending.
- `src/scaffold/` plans and writes generated wiki files.
- `src/scaffold/templates/` contains reusable scaffold template content.
- `src/utils/` contains filesystem, Git, and result helpers.
- `test/` contains Vitest coverage for the CLI, scaffold, safety, privacy, and repository foundation contracts.
- `.github/workflows/ci.yml` runs the package verification pipeline on Node 22.

## First Supported Workflow

Build the CLI, then initialize a wiki:

```bash
npm run build
llm-wiki init my-wiki --agent codex --obsidian --dataview --git --quartz-ready
cd my-wiki
llm-wiki add ../notes/research-note.md --title "Research Note"
llm-wiki add-text --title "Pasted Note" --text "Captured text"
llm-wiki add-url https://example.com/research-note --title "Fetched Note"
llm-wiki queue
llm-wiki queue show <source_id>
llm-wiki queue set-status <source_id> ingesting
llm-wiki log
git status
```

For an uninstalled local checkout, use `node dist/src/cli.js init ...` after `npm run build`. The npm package exposes the same command as `llm-wiki` through `bin` after installation.

## Shared Command Runtime

Non-init commands accept the shared runtime options:

```bash
llm-wiki status --repo my-wiki
llm-wiki status --repo my-wiki --json
llm-wiki status --repo my-wiki --quiet
llm-wiki add ../notes/research-note.md --repo my-wiki --title "Research Note" --json
llm-wiki add-text --repo my-wiki --title "Pasted Note" --text "Captured text" --json
llm-wiki add-url https://example.com/research-note --repo my-wiki --title "Fetched Note" --json
llm-wiki queue --repo my-wiki --json
llm-wiki queue show <source_id> --repo my-wiki --json
llm-wiki queue set-status <source_id> ingesting --repo my-wiki --json
llm-wiki log --repo my-wiki --json
```

- `--repo <path>` may point at a wiki root or any descendant directory containing `.llm-wiki/config.yml` above it.
- `--json` prints stable envelopes shaped as `{ ok, command, repo, data, warnings }` on success or `{ ok, command, repo, error, issues }` on failure.
- `--quiet` suppresses human success output only. Human errors and JSON output are still printed.

`status` currently verifies that the CLI can resolve an existing LLM Wiki workspace and reports the resolved repository root. `add`, `add-text`, and `add-url` return the captured source metadata, created paths, or duplicate source metadata. `queue`, `queue show`, `queue set-status`, and `log` return the queue records, source-card frontmatter, transition results, and parsed runtime log entries. Full health reporting is deferred to the status slice.

## Source Capture

`llm-wiki add <path> --title <title>` copies a local source file into `raw/inputs/YYYY/MM/<source_id>/original.<ext>`, writes a source card at `_source.md`, writes `raw/queue/<source_id>.json`, and appends a parseable `add` entry to `curated/log.md`.

`llm-wiki add-text --title <title> --text <text>` stores pasted text as `original.md` with `source_kind: text`, `origin: pasted_text`, `visibility: private`, and queued status.

`llm-wiki add-url <url> --title <title>` fetches an HTTP(S) text response, stores it as `original.md` with `source_kind: url`, `origin: url`, `origin_url: <url>`, `visibility: private`, and queued status. If no title is supplied, the title defaults to the final URL path segment or host. Failed fetches, invalid URLs, empty responses, and unsupported non-text response types fail before any source files are written.

Source IDs are deterministic for the UTC capture date, source title slug, and content hash:

```text
src_<yyyy>_<mm>_<dd>_<slug>_<12-char-sha256>
```

Duplicate content returns the existing source metadata with `status: duplicate` and does not write new files or log entries. Raw originals are written with binary-safe no-overwrite semantics.

## Queue and Log

`llm-wiki queue` lists queue items from `raw/queue/*.json` with source ID, title, source kind, status, visibility, source-card path, queue path, original path, updated time, and status counts.

`llm-wiki queue show <source_id>` returns the queue record and linked `_source.md` frontmatter. It fails with stable errors when the queue item is missing, the source card is missing, or the queue JSON and source-card frontmatter disagree on source ID, title, source kind, status, or visibility.

`llm-wiki queue set-status <source_id> <status>` supports explicit validated transitions: `queued -> ingesting`, `ingesting -> ingested`, `ingesting -> blocked`, and `blocked -> queued`. It mirrors the status and `updated_at` timestamp into both the queue JSON and `_source.md`, updates the source card body status line, and appends a parseable `ingest` entry to `curated/log.md`.

`llm-wiki log` parses runtime entries from `curated/log.md` while ignoring the seeded entry-format template and fenced examples. JSON output includes parsed entries, scanner issues, and counts.

## Generated Scaffold Semantics

`llm-wiki init` creates a wiki repository scaffold, not a completed knowledge base.

- `raw/inputs/` stores captured source folders. Once present, raw originals are immutable source material.
- `raw/queue/` stores source queue items waiting for ingest.
- `curated/` stores LLM-maintained Markdown pages.
- `curated/index.md` is the content-oriented wiki map.
- `curated/log.md` is the append-only operation ledger.
- `.llm-wiki/config.yml` records scaffold options, paths, raw immutability, curated write policy, and privacy defaults.
- `.llm-wiki/schema.yml` documents required frontmatter and supported page types.
- `.llm-wiki/profiles/local.yml`, `.llm-wiki/profiles/review.yml`, and `.llm-wiki/profiles/public.yml` define future Explorer/profile selection rules.
- `AGENTS.md` is always generated as the canonical instruction file.
- `CODEX.md` is generated only with `--agent codex`.
- `CLAUDE.md` is generated only with `--agent claude`.

Generated files are deterministic. The scaffold avoids timestamps so init output is stable and reviewable.

## Privacy Defaults

The scaffold is private by default.

- Raw source cards and curated pages default to `visibility: private`.
- Public publishing is opt-in through `visibility: public`.
- The public profile excludes `raw/**`, source summaries, logs, private dashboards, queues, and private curated paths.
- Local and review profiles may include private curated pages and raw source cards, but raw source originals are excluded from Explorer profiles by default.
- Public leak checks are represented in generated lint-rule configuration, but the executable lint command is deferred.

## Agent Files

`AGENTS.md` is the canonical, model-agnostic instruction source. It contains the hard rules for raw immutability, provenance through `source_ids`, index/log maintenance, contradiction handling, and public/private visibility.

AGENTS.md is always generated and is the source of truth for agent behavior.

Agent-specific files are thin pointers:

- CODEX.md is generated only with `--agent codex` and points back to `AGENTS.md`.
- CLAUDE.md is generated only with `--agent claude` and points back to `AGENTS.md`.
- The default `--agent generic` mode generates only `AGENTS.md`.

## Quartz Ready Flag

`--quartz-ready` is accepted but currently a no-op. It is recorded in CLI output so callers can express intent, but it does not create a `quartz/` runtime, install Quartz, or change scaffold bytes.

## Deferred Features

The following PRD features are not implemented in this foundation slice:

- `ingest` task orchestration and validation.
- `lint command behavior` beyond generated lint-rule configuration.
- `Quartz runtime`, including `explore init`, `explore sync`, `explore serve`, search, backlinks, and graph UI.
- `upload` workflows, local daemon, remote API, and browser upload form.
- `GitHub Pages deploy`, including deploy profile initialization, local preflight, generated Pages workflow, and Pages status checks.

Until those features land, the supported product behavior is repo initialization plus package verification.
