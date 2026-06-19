# llm-wiki

`llm-wiki` is a local-first CLI for creating a Git-backed, Obsidian-compatible Markdown wiki that can later grow into the full LLM Wiki workflow described in the PRD.

The current supported foundation is intentionally small: `llm-wiki init` creates a deterministic wiki scaffold with raw/curated separation, agent instructions, profile files, privacy defaults, and Git initialization. `llm-wiki add`, `llm-wiki add-text`, and `llm-wiki add-url` capture private raw sources into the queue with deterministic source IDs, SHA-256 hashes, source cards, queue JSON, and log entries. `llm-wiki queue`, `llm-wiki log`, `llm-wiki lint`, `llm-wiki index rebuild`, `llm-wiki search`, `llm-wiki nav`, `llm-wiki explore init/sync/build`, and `llm-wiki deploy github-pages` expose that control plane for reviewable local workflow state. Non-init commands share repository discovery and output contracts so future workflow commands can behave consistently.

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
- `src/commands/lint.ts` and `src/commands/index.ts` own executable lint checks and rebuildable cache generation.
- `src/commands/search.ts` and `src/commands/nav.ts` own offline search and Markdown graph/navigation command behavior.
- `src/commands/explore.ts` owns Quartz Explorer runtime initialization and profile sync commands.
- `src/commands/deploy.ts` owns deploy command routing for GitHub Pages.
- `src/deploy/` owns generated deploy workflows, deploy profiles, and local deploy preflight checks.
- `src/sourceCapture/` owns deterministic source IDs, hashing, metadata, duplicate detection, and raw writes.
- `src/scanner/` normalizes repository Markdown, queue, profile, raw, and log state for lint and cache rebuild workflows.
- `src/lint/` owns raw hash, source-card, queue, log, index, wikilink, provenance, and public-profile leak rules.
- `src/index/` owns generated `.llm-wiki/cache/*` files built from source Markdown and raw state.
- `src/search/` and `src/nav/` own local Markdown search scoring, source relation lookup, wikilink navigation, orphan reporting, and graph JSON.
- `src/profiles/` owns profile YAML loading and profile-based Markdown selection.
- `src/quartz/` owns generated Quartz runtime files, profile materialization, static review pages, and manifests.
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
llm-wiki explore serve --profile local
llm-wiki explore open
llm-wiki explore build --profile public
llm-wiki deploy github-pages init
llm-wiki deploy github-pages check
llm-wiki deploy github-pages build-local
llm-wiki deploy github-pages status
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
llm-wiki explore serve --repo my-wiki --profile local --json
llm-wiki explore open --repo my-wiki --json
llm-wiki explore build --repo my-wiki --profile public --json
llm-wiki deploy github-pages init --repo my-wiki --json
llm-wiki deploy github-pages init --repo my-wiki --custom-domain docs.example.com --json
llm-wiki deploy github-pages check --repo my-wiki --json
llm-wiki deploy github-pages build-local --repo my-wiki --json
llm-wiki deploy github-pages status --repo my-wiki --json
```

- `--repo <path>` may point at a wiki root or any descendant directory containing `.llm-wiki/config.yml` above it.
- `--json` prints stable envelopes shaped as `{ ok, command, repo, data, warnings }` on success or `{ ok, command, repo, error, issues }` on failure.
- `--quiet` suppresses human success output only. Human errors and JSON output are still printed.

`status` currently verifies that the CLI can resolve an existing LLM Wiki workspace and reports the resolved repository root. `add`, `add-text`, and `add-url` return the captured source metadata, created paths, or duplicate source metadata. `queue`, `queue show`, `queue set-status`, and `log` return the queue records, source-card frontmatter, transition results, and parsed runtime log entries. `lint` returns stable issue records and exits non-zero for error-severity findings. `index rebuild` writes non-authoritative cache files under `.llm-wiki/cache/` from Markdown, queue, raw, and profile state. `search` and `nav` read live Markdown from disk and do not require Quartz, network access, or cache files. `explore init` writes isolated Quartz runtime files, `explore sync` materializes profile-selected Markdown into generated Quartz content, `explore serve` starts the local Quartz script after sync, `explore open` prints the recorded local URL, and `explore build` runs public sync, strict public lint, and the Quartz build script. `deploy github-pages` generates the Pages workflow/profile pair, validates deploy readiness, and runs the local preflight sequence that mirrors CI. Full health reporting is deferred to the status slice.

## Quartz Explorer

`llm-wiki explore init` creates an isolated `quartz/` runtime directory with package, config, layout, LLM Wiki component placeholders, and an npm postinstall hook that copies the installed Quartz source tree into the local runtime layout. It also upgrades the generated placeholder package/config/layout files from earlier Explorer runtimes while leaving custom runtime files unchanged. It does not install dependencies by default. Human output prints the exact install command:

```bash
cd quartz && npm install
```

Pass `--install` to run that install command from the generated `quartz/` directory.

`llm-wiki explore sync --profile local|review|public|github-pages` rebuilds `quartz/content/` from live Markdown and writes a profile manifest under `.llm-wiki/cache/quartz-manifest.<profile>.json`. Local and review profiles include curated Markdown, raw source cards, and generated static review pages such as the source queue; raw originals are excluded for every profile. Public and GitHub Pages syncs are public-like: they run strict leak checks before writing content, materialize only public-safe Markdown, and never copy raw source cards or raw originals.

`llm-wiki explore serve --profile local` runs sync first, requires installed Quartz dependencies and the copied Quartz runtime source layout, binds the Quartz serve script to `127.0.0.1` by default, forwards a separate free Quartz `--wsPort`, prints the generated curated index URL after Quartz reports that it is listening, and records the current URL plus watched wiki inputs in `.llm-wiki/cache/explorer-state.json`. Serve watch mode tracks curated pages, raw source cards, raw queue JSON, profiles, and config changes. JSON mode emits the startup success envelope only after that readiness signal remains stable, with the URL and Quartz command marked `status: "running"`. Missing dependencies fail with `QUARTZ_DEPENDENCIES_MISSING` and the exact recovery command:

```bash
cd quartz && npm install
```

`llm-wiki explore open` reads the recorded Explorer state and prints the current URL. JSON output is stable as `{ url, opened }`; `opened` is currently `false` because the command avoids launching a platform browser process.

`llm-wiki explore build --profile public` runs public sync, strict public lint, then `npm run build` from `quartz/`. Static builds accept only `public` and `github-pages` profiles, and the build stops before sync if a local or review profile is requested. The build also stops before Quartz runs if strict public lint has error-severity issues or dependencies are missing.

## GitHub Pages Deploy

`llm-wiki deploy github-pages init` writes `.github/workflows/llm-wiki-pages.yml`, `.llm-wiki/profiles/github-pages.yml`, and refreshes `.llm-wiki/profiles/public.yml` with fail-closed public defaults. Without `--custom-domain`, the command infers the Pages base URL from the GitHub `origin` remote. With `--custom-domain docs.example.com`, it uses `https://docs.example.com`.

The generated workflow uses least required Pages permissions (`contents: read`, `pages: write`, `id-token: write`), supports `workflow_dispatch`, sets up Node 22, installs the `llm-wiki` CLI without requiring root npm project files, installs Quartz dependencies under `quartz/`, runs GitHub Pages profile sync, strict public lint, Quartz build, uploads `quartz/public`, and deploys through the official Pages actions.

`llm-wiki deploy github-pages check` validates the workflow, deploy profiles, Quartz runtime dependencies, and strict public preflight. `build-local` runs the same public sync, strict lint, and Quartz build sequence locally. `status` reports readiness without failing on incomplete setup and prints setup instructions such as installing Quartz dependencies and enabling GitHub Pages with Source: GitHub Actions.

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
- `quartz/content/`, `quartz/public/`, `quartz/.quartz-cache/`, and `quartz/quartz/` are generated Explorer/runtime outputs ignored by the wiki scaffold.
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

`--quartz-ready` is accepted but currently a no-op for `init`. It is recorded in CLI output so callers can express intent, but it does not create a `quartz/` runtime, install Quartz, or change scaffold bytes. Use `llm-wiki explore init` to create the Quartz runtime.

## Deferred Features

The following PRD features are not implemented in this foundation slice:

- `ingest` task orchestration and validation.
- Full Quartz browser feature wiring beyond the generated runtime defaults.
- `upload` workflows, local daemon, remote API, and browser upload form.

Until those features land, the supported product behavior is repo initialization, raw source capture, queue/log/lint/index control-plane commands, offline search/navigation over local Markdown, Quartz init/sync/serve/open/build workflows, and GitHub Pages deploy workflow generation/preflight.
