# llm-wiki

`llm-wiki` is a local-first CLI for creating a Git-backed, Obsidian-compatible Markdown wiki that can later grow into the full LLM Wiki workflow described in the PRD.

The current supported foundation is intentionally small: `llm-wiki init` creates a deterministic wiki scaffold with raw/curated separation, agent instructions, profile files, privacy defaults, and Git initialization.

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
git status
```

For an uninstalled local checkout, use `node dist/src/cli.js init ...` after `npm run build`. The npm package exposes the same command as `llm-wiki` through `bin` after installation.

## Generated Scaffold Semantics

`llm-wiki init` creates a wiki repository scaffold, not a completed knowledge base.

- `raw/inputs/` is reserved for captured source folders. Future `add` commands will place raw originals and source cards here. Once present, raw originals are immutable source material.
- `raw/queue/` is reserved for source queue items waiting for ingest.
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

- `add/add-text` source capture commands.
- `ingest` task orchestration and validation.
- `lint command behavior` beyond generated lint-rule configuration.
- `Quartz runtime`, including `explore init`, `explore sync`, `explore serve`, search, backlinks, and graph UI.
- `upload` workflows, local daemon, remote API, and browser upload form.
- `GitHub Pages deploy`, including deploy profile initialization, local preflight, generated Pages workflow, and Pages status checks.

Until those features land, the supported product behavior is repo initialization plus package verification.
