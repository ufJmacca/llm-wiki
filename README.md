# llm-wiki

`llm-wiki` is a local-first CLI for creating a Git-backed, Obsidian-compatible Markdown wiki that can later grow into the full LLM Wiki workflow described in the PRD.

The current supported foundation is intentionally small: `llm-wiki init` creates a deterministic wiki scaffold with raw/curated separation, agent instructions, profile files, privacy defaults, and Git initialization. `llm-wiki add`, `llm-wiki add-text`, and `llm-wiki add-url` capture private raw sources into the queue with deterministic source IDs, SHA-256 hashes, source cards, queue JSON, and log entries. `llm-wiki queue`, `llm-wiki ingest`, `llm-wiki query`, `llm-wiki log`, `llm-wiki lint`, `llm-wiki index rebuild`, `llm-wiki status`, `llm-wiki snapshot`, `llm-wiki search`, `llm-wiki nav`, and `llm-wiki explore init/sync` expose that control plane for reviewable local workflow state. Non-init commands share repository discovery and output contracts so future workflow commands can behave consistently.

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
- `src/commands/ingest.ts` owns ingest task prompt generation, optional branch creation, and validation-driven completion.
- `src/commands/query.ts` owns query task prompt generation and validation of durable saved question pages.
- `src/commands/lint.ts` and `src/commands/index.ts` own executable lint checks and rebuildable cache generation.
- `src/commands/search.ts` and `src/commands/nav.ts` own offline search and Markdown graph/navigation command behavior.
- `src/commands/explore.ts` owns Quartz Explorer runtime initialization and profile sync commands.
- `src/agentTasks/` owns deterministic agent prompt/task assembly.
- `src/validation/` owns workflow-specific validation gates before state transitions.
- `src/commands/status.ts` and `src/commands/snapshot.ts` own runtime health reporting and lint-gated Git snapshots.
- `src/sourceCapture/` owns deterministic source IDs, hashing, metadata, duplicate detection, and raw writes.
- `src/scanner/` normalizes repository Markdown, queue, profile, raw, and log state for lint and cache rebuild workflows.
- `src/lint/` owns raw hash, source-card, queue, log, index, wikilink, provenance, and public-profile leak rules.
- `src/index/` owns generated `.llm-wiki/cache/*` files built from source Markdown and raw state.
- `src/search/` and `src/nav/` own local Markdown search scoring, source relation lookup, wikilink navigation, orphan reporting, and graph JSON.
- `src/profiles/` owns profile YAML loading and profile-based Markdown selection.
- `src/quartz/` owns generated Quartz runtime placeholders, profile materialization, static review pages, and manifests.
- `src/providers/` owns explicit provider proposal execution and safe proposal application.
- `src/runtime/status.ts` owns health aggregation across lint, queue, profiles, Git, and Explorer readiness.
- `src/runtime/queue.ts` and `src/runtime/log.ts` own queue/source-card consistency and runtime log parsing/appending.
- `src/runtime/config.ts` owns provider config loading, env-var secret checks, and Git feature config parsing.
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
llm-wiki ingest <source_id>
llm-wiki ingest <source_id> --validate
llm-wiki ingest <source_id> --provider local
llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md
llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --validate
llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --provider local
llm-wiki log
llm-wiki lint
llm-wiki lint --fix
llm-wiki lint --profile public --strict
llm-wiki index rebuild
llm-wiki search "research note" --scope all
llm-wiki nav outlinks curated/topics/example.md
llm-wiki nav backlinks curated/topics/example.md
llm-wiki nav sources curated/topics/example.md
llm-wiki nav orphans
llm-wiki nav graph --json
llm-wiki explore init
llm-wiki explore sync --profile local
llm-wiki status
llm-wiki snapshot
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
llm-wiki ingest <source_id> --repo my-wiki --json
llm-wiki ingest <source_id> --repo my-wiki --validate --json
llm-wiki ingest <source_id> --repo my-wiki --provider local --json
llm-wiki query "What does this source prove?" --repo my-wiki --save curated/questions/source-proof.md --json
llm-wiki query "What does this source prove?" --repo my-wiki --save curated/questions/source-proof.md --validate --json
llm-wiki query "What does this source prove?" --repo my-wiki --save curated/questions/source-proof.md --provider local --json
llm-wiki log --repo my-wiki --json
llm-wiki lint --repo my-wiki --json
llm-wiki lint --repo my-wiki --profile public --strict --json
llm-wiki index rebuild --repo my-wiki --json
llm-wiki search "research note" --repo my-wiki --scope all --json
llm-wiki nav outlinks curated/topics/example.md --repo my-wiki --json
llm-wiki nav backlinks curated/topics/example.md --repo my-wiki --json
llm-wiki nav sources curated/topics/example.md --repo my-wiki --json
llm-wiki nav orphans --repo my-wiki --json
llm-wiki nav graph --repo my-wiki --json
llm-wiki explore init --repo my-wiki --json
llm-wiki explore sync --repo my-wiki --profile local --json
llm-wiki snapshot --repo my-wiki --json
```

- `--repo <path>` may point at a wiki root or any descendant directory containing `.llm-wiki/config.yml` above it.
- `--json` prints stable envelopes shaped as `{ ok, command, repo, data, warnings }` on success or `{ ok, command, repo, error, issues }` on failure.
- `--quiet` suppresses human success output only. Human errors and JSON output are still printed.

`status --json` reports repository health, configuration validity, queue counts and items, lint summary, Git branch/head/dirty state and Git command errors, profile validity, and Explorer readiness. It remains usable when Git is disabled or Git commands fail; malformed or unreadable config is reported separately from intentional `features.git: false`. Git failures include the command, exit code when available, stderr, and manual next steps.

`snapshot` runs lint before touching Git. It refuses to commit while error-severity lint issues exist, and malformed or unreadable config fails with an actionable config error before Git preflight. When lint passes, it stages the repository, creates a `chore: snapshot llm-wiki state` commit, falls back to the built-in llm-wiki Git identity when local Git identity is missing, and reports the commit SHA plus post-commit Git state.

`add`, `add-text`, and `add-url` return the captured source metadata, created paths, or duplicate source metadata. `queue`, `queue show`, `queue set-status`, and `log` return the queue records, source-card frontmatter, transition results, and parsed runtime log entries. `ingest` and `query` return generated agent task prompts or validation results. `lint` returns stable issue records and exits non-zero for error-severity findings. `index rebuild` writes non-authoritative cache files under `.llm-wiki/cache/` from Markdown, queue, raw, and profile state. `search` and `nav` read live Markdown from disk and do not require Quartz, network access, or cache files. `explore init` writes isolated Quartz placeholder runtime files, and `explore sync` materializes profile-selected Markdown into generated Quartz content.

## Quartz Explorer Init and Sync

`llm-wiki explore init` creates an isolated `quartz/` runtime directory with package, config, layout, and LLM Wiki component placeholders. It does not install dependencies by default. Human output prints the exact install command:

```bash
cd quartz && npm install
```

Pass `--install` to run that install command from the generated `quartz/` directory.

`llm-wiki explore sync --profile local|review|public|github-pages` rebuilds `quartz/content/` from live Markdown and writes a profile manifest under `.llm-wiki/cache/quartz-manifest.<profile>.json`. Local and review profiles include curated Markdown, raw source cards, and generated static review pages such as the source queue; raw originals are excluded for every profile. Public and GitHub Pages syncs are public-like: they run strict leak checks before writing content, materialize only public-safe Markdown, and never copy raw source cards or raw originals.

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

## Ingest Tasks

`llm-wiki ingest <source_id>` loads the queue item, raw source card, immutable original path, text originals when safe to inline, `AGENTS.md`, `curated/index.md`, and related pages discovered through search/navigation. It prints a task prompt with required curated outputs, raw immutability rules, and the follow-up validation command. Queued sources move to `ingesting`; already-ingesting sources keep their status.

When the wiki has Git enabled, `ingest` recommends `git switch -c ingest/<source_id>`. Pass `--create-branch` to create that branch explicitly.

`llm-wiki ingest <source_id> --validate` checks that the agent created `curated/sources/<source_id>.md`, updated `curated/index.md`, appended an ingest log entry, kept `source_ids` on edited curated pages, and left raw originals unchanged. The queue item moves to `ingested` only after validation passes.

`llm-wiki ingest <source_id> --provider <name>` is optional and never used unless requested explicitly. The configured provider must return structured file proposals under `curated/`; proposals are validated on a temporary copy with the same ingest validation gates before any files are applied. Rejected provider output does not change queue status or raw originals.

## Query Tasks

`llm-wiki query "<question>" --save curated/questions/<slug>.md` loads `AGENTS.md`, `curated/index.md`, relevant curated pages, source summaries, `source_ids`, and linked context, then prints an agent task prompt. Without `--provider`, the CLI does not call an LLM provider or invent an answer.

After an agent writes the saved question page, `llm-wiki query "<question>" --save curated/questions/<slug>.md --validate` checks that the page has `type: question`, title, visibility, source references where sources are available, explicit open questions for missing provenance, an index entry, and a compatible `query` entry in `curated/log.md`.

`llm-wiki query "<question>" --save curated/questions/<slug>.md --provider <name>` is optional explicit provider mode. It requires `--save`; provider proposals may only write the saved question page, `curated/index.md`, and `curated/log.md`, and must pass the same saved-query validation before being applied.

## Provider Proposal Mode

Provider mode is configured under `.llm-wiki/config.yml` and is unavailable unless a command includes `--provider <name>`.

```yaml
providers:
  local:
    type: http
    endpoint: "http://127.0.0.1:8787/propose"
    api_key_env: LLM_WIKI_PROVIDER_API_KEY
    model: example-model
```

Secrets are referenced only by environment variable name. Literal secret fields such as `api_key`, `access_token`, `client_secret`, `password`, `token`, or `secret` are rejected. Missing env vars, malformed config, provider request failures, malformed output, raw-path proposals, and validation failures all exit non-zero without applying proposed edits.

Providers must return:

```json
{
  "files": [
    { "path": "curated/index.md", "content": "..." }
  ]
}
```

## Search and Navigation

`llm-wiki search "<query>" --scope raw|curated|all` searches live Markdown titles, aliases, tags, headings, body text, source cards, curated summaries, and `source_ids`. JSON results include path, page type, title, snippet, score, source IDs, visibility, and matched fields. System/generated pages such as `curated/log.md`, dashboards, and Quartz output are excluded from search inputs.

`llm-wiki nav outlinks <page>` and `llm-wiki nav backlinks <page>` parse Obsidian-style wikilinks, including aliases and heading targets, and return resolved target page metadata where possible.

`llm-wiki nav sources <page>` resolves `source_ids` from a curated page to raw source cards and curated source summaries.

`llm-wiki nav orphans` reports user-authored concept, entity, topic, question, and comparison pages with no inbound curated wikilinks. Generated/system pages such as `curated/home.md`, `curated/index.md`, `curated/log.md`, and `curated/dashboards/**` are excluded.

`llm-wiki nav graph --json` returns browser-ready nodes and edges for local graph visualization.

## Lint and Index Rebuild

`llm-wiki lint` reports stable issue records with `rule_id`, severity, path, optional line, message, fix hint, and fixability. Error-severity issues return exit code 1, and JSON failures use `error.code: lint_failed`.

Current lint rules detect raw source hash drift, malformed source cards, queue/source-card mismatches, source cards without queue items, ingested sources without curated summaries, missing `source_ids`, malformed runtime log headings, stale `curated/index.md`, broken wikilinks, and orphan pages.

`llm-wiki lint --fix` only performs deterministic safe repairs. Currently it regenerates `curated/index.md` from source cards and valid curated pages. It does not rewrite raw originals and does not invent missing provenance.

`llm-wiki lint --profile public --strict` fails closed when a public profile would select private pages, raw originals, public pages that link raw content, public pages that link private targets, or private nodes/text that would leak into public graph/search output.

`llm-wiki index rebuild` writes `.llm-wiki/cache/pages.json`, `sources.json`, `queue.json`, `graph.json`, and `metadata.json`. These caches are rebuildable and non-authoritative; existing `.llm-wiki/cache/*` files are ignored as scan inputs.

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
- `quartz/content/`, `quartz/public/`, and `quartz/.quartz-cache/` are generated Explorer outputs ignored by the wiki scaffold.
- `AGENTS.md` is always generated as the canonical instruction file.
- `CODEX.md` is generated only with `--agent codex`.
- `CLAUDE.md` is generated only with `--agent claude`.

Generated files are deterministic. The scaffold avoids timestamps so init output is stable and reviewable.

## Privacy Defaults

The scaffold is private by default.

- Raw source cards must remain `visibility: private`; curated pages default to `visibility: private`.
- Public publishing is opt-in for curated pages through `visibility: public`.
- The public profile excludes `raw/**`, source summaries, logs, private dashboards, queues, and private curated paths.
- Local and review profiles may include private curated pages and raw source cards, but raw source originals are excluded from Explorer profiles by default.
- Public leak checks are represented in generated lint-rule configuration and enforced by `llm-wiki lint --profile public --strict`.

## Agent Files

`AGENTS.md` is the canonical, model-agnostic instruction source. It contains the hard rules for raw immutability, provenance through `source_ids`, index/log maintenance, contradiction handling, and public/private visibility.

AGENTS.md is always generated and is the source of truth for agent behavior.

Agent-specific files are thin pointers:

- CODEX.md is generated only with `--agent codex` and points back to `AGENTS.md`.
- CLAUDE.md is generated only with `--agent claude` and points back to `AGENTS.md`.
- The default `--agent generic` mode generates only `AGENTS.md`.

## Quartz Ready Flag

`--quartz-ready` is accepted but currently a no-op for `init`. It is recorded in CLI output so callers can express intent, but it does not create a `quartz/` runtime, install Quartz, or change scaffold bytes. Use `llm-wiki explore init` to create Quartz runtime placeholders.

## Deferred Features

The following PRD features are not implemented in this foundation slice:

- `Quartz serve/build runtime`, including `explore serve`, browser search, backlinks, and graph UI.
- `upload` workflows, local daemon, remote API, and browser upload form.
- `GitHub Pages deploy`, including deploy profile initialization, local preflight, generated Pages workflow, and Pages status checks.

Until those features land, the supported product behavior is repo initialization plus local source capture, ingest and query task scaffolding and validation, optional provider proposal mode, queue/log inspection, lint/index rebuild, status reporting, Git snapshots, offline search/navigation over local Markdown, and Quartz placeholder init/profile sync.
