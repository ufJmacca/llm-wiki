# Product Requirements Document: LLM Wiki Remaining Work

**Product name:** `llm-wiki`
**Document status:** Draft follow-up PRD
**Created:** 2026-06-17
**Source PRD:** `./prds/llm-wiki-prd.md`
**Current AINative run:** `20260616T225508717429Z-llm-wiki-prd`
**Purpose:** Define the partially covered and not covered requirements after the current AINative run, which is scoped to the `llm-wiki init` foundation.

---

## 1. Executive Summary

The current AINative run implements the first foundation of `llm-wiki`: a TypeScript/Node CLI package, `llm-wiki init`, deterministic wiki scaffolding, generated agent instructions, private-by-default profiles, optional Obsidian/Dataview files, Git initialization, tests, docs, and CI.

That run is intentionally not the full product and not the full MVP from the source PRD. It does not implement source capture, queue management, ingest scaffolding, search, navigation, lint command behavior, Quartz Explorer runtime, GitHub Pages deploy generation, local upload, or remote upload.

This follow-up PRD covers the remaining work needed to move from an init-only foundation to the source PRD's MVP, plus the V1 upload/review work that was explicitly deferred.

---

## 2. Current Coverage Baseline

### 2.1 Covered by the current AINative run

- Product package foundation: `package.json`, lockfile, TypeScript, Vitest, lint/build/test scripts, CLI binary.
- `llm-wiki init <dir>` command surface.
- Deterministic scaffold planner and safe writer.
- Core generated repo structure under `raw/`, `curated/`, and `.llm-wiki/`.
- Canonical `AGENTS.md`.
- Optional `CODEX.md`, `CLAUDE.md`, `.obsidian/`, and Dataview dashboard scaffolds.
- Private-by-default local/review/public profile YAML files.
- Git initialization and initial commit for generated wiki repos.
- Human and JSON output for `init`.
- Contract tests for scaffold shape, determinism, safety, privacy defaults, and init options.
- Repository README and CI.

### 2.2 Partially covered

| Area | Current state | Required follow-up |
|---|---|---|
| Raw immutability | Encoded in generated docs/config only | Enforce through hashes, lint checks, and source capture behavior |
| Source model | Templates and directory placeholders exist | Implement source IDs, source cards, queue JSON, duplicate detection, and status transitions |
| Index/log control plane | Initial files exist | Maintain and validate them during add, ingest, query-save, lint, deploy, and upload |
| Agent instructions | `AGENTS.md` exists | Generate ingest/query task prompts and validate agent outputs |
| Dataview | Optional dashboard scaffolds exist | Ensure real source cards/frontmatter feed dashboards; provide static Quartz equivalents |
| Profiles | YAML defaults exist | Implement profile selection, manifest generation, filtering, and leak checks |
| Quartz readiness | `--quartz-ready` is a no-op | Implement `explore init`, `explore sync`, `explore serve`, `explore open`, and `explore build` |
| Public safety | Public profile is fail-closed by default | Enforce through `lint --profile public --strict` and deploy preflight |

### 2.3 Not covered

- `llm-wiki add`, `add-url`, `add-text`, and `queue`.
- `llm-wiki ingest` task scaffolding and validation.
- `llm-wiki query --save`.
- `llm-wiki search`, `nav`, `index rebuild`, `log`, `status`, and `snapshot`.
- Functional `llm-wiki lint`.
- Functional Quartz Explorer runtime.
- GitHub Pages deploy workflow generation and local preflight.
- Local upload daemon and browser upload form.
- Static GitHub Pages publication from reviewed local upload output.
- Cross-command `--repo`, `--json`, `--quiet` consistency.
- Performance targets and profile-isolated manifests/build outputs.

---

## 3. Product Goal

Complete the source PRD's MVP after the init foundation by making the scaffold operational:

1. Users can add raw sources and queue them safely.
2. Agents can receive constrained ingest tasks and produce validated curated updates.
3. Users can lint, search, navigate, and rebuild indexes locally.
4. Users can browse the wiki through Quartz Explorer from day one.
5. Users can generate and validate a safe GitHub Pages deploy path.
6. V1 users can upload raw sources through local Explorer and, later, through authenticated remote Git-backed workflows.

---

## 4. Non-Goals

This follow-up PRD should not reimplement the existing `init` foundation except where changes are required to support later behavior.

Out of scope for the next MVP tranche:

- Hosted SaaS.
- Vector database or embedding-first RAG platform.
- MCP server.
- QMD adapter.
- PDF OCR.
- Browser extension.
- Obsidian plugin companion.
- Non-GitHub deploy providers.
- Private-team authenticated hosting beyond documented future extension points.

---

## 5. MVP Follow-Up Scope

### 5.1 Raw Source Capture

Implement:

- `llm-wiki add <path>`
- `llm-wiki add-text --title <title>`
- `llm-wiki add-url <url>` as lightweight P1 capture
- `llm-wiki queue`

Requirements:

- Generate deterministic source IDs:

```text
src_<yyyy>_<mm>_<dd>_<slug>_<short_hash>
```

- Copy local files into:

```text
raw/inputs/YYYY/MM/<source_id>/original.<ext>
```

- Store pasted text as `original.md`.
- Create `_source.md` with YAML frontmatter.
- Create `raw/queue/<source_id>.json`.
- Compute and store content hash.
- Default source visibility to `private`.
- Detect duplicate hashes and return actionable output.
- Never overwrite existing raw originals unless an explicit future repair command is introduced.
- Support `--json`, `--quiet`, and `--repo <path>`.

Acceptance criteria:

- A local Markdown/text file can be added and appears in `raw/inputs` and `raw/queue`.
- `llm-wiki queue` lists queued sources with source ID, title, kind, status, and path.
- Duplicate content is detected by hash.
- `llm-wiki lint` can verify the raw source hash has not changed.
- Generated source cards are readable in Obsidian and usable by Dataview dashboards.

### 5.2 Queue Management

Implement:

```bash
llm-wiki queue
llm-wiki queue show <source_id>
llm-wiki queue set-status <source_id> <queued|ingesting|ingested|blocked>
```

Requirements:

- Queue state is stored in `raw/queue/*.json`.
- `_source.md` and queue JSON statuses must remain consistent.
- Status changes append to `curated/log.md` where appropriate.
- Queue commands support human and JSON output.

Acceptance criteria:

- Queue items without source cards are lint errors.
- Source cards without queue items are lint warnings unless ingested.
- Status transitions are validated and reversible only through explicit commands.

### 5.3 Ingest Task Scaffolding

Implement:

```bash
llm-wiki ingest <source_id>
```

Requirements:

- Create or recommend an ingest branch when Git is enabled.
- Read source card, raw/extracted content path, index, relevant existing pages, and `AGENTS.md`.
- Generate a clear task prompt for the configured agent.
- Require the agent to:
  - Create or update `curated/sources/<source_id>.md`.
  - Update relevant entity/concept/topic/question/comparison pages.
  - Add `source_ids` to every edited curated page.
  - Update `curated/index.md`.
  - Append to `curated/log.md`.
  - Flag contradictions and open questions.
  - Avoid editing `raw/inputs/**/original.*`.
- Validate resulting edits before marking a queue item as `ingested`.

Acceptance criteria:

- Ingesting a queued source produces a task artifact or printed agent prompt.
- Validation fails if the source summary, index update, log entry, or source references are missing.
- Raw source hashes remain unchanged.
- Queue status becomes `ingested` only after validation passes.

### 5.4 Query and File-Back

Implement:

```bash
llm-wiki query "<question>" --save curated/questions/<slug>.md
```

Requirements:

- Build context from curated Markdown, index, source summaries, and relevant links.
- Generate a task prompt for the configured agent rather than silently calling a provider.
- When `--save` is used, require frontmatter type `question`, source references where available, and a log entry.

Acceptance criteria:

- Saved answers are durable Markdown pages under `curated/questions/`.
- Query-save updates `curated/index.md` and appends to `curated/log.md`.
- Missing provenance is represented as an open question, not invented evidence.

### 5.5 Lint and Index Rebuild

Implement:

```bash
llm-wiki lint
llm-wiki lint --fix
llm-wiki lint --profile public --strict
llm-wiki index rebuild
```

Lint categories:

- Broken wikilinks.
- Missing required frontmatter.
- Invalid frontmatter types.
- Missing `source_ids` on curated pages.
- Raw source hash drift.
- Queue/source-card mismatch.
- Ingested source without curated summary.
- Invalid log heading timestamp.
- `curated/index.md` missing known pages.
- Orphan pages.
- Pages needing human review.
- Public page links to private pages.
- Public page links to raw sources.
- Public graph/search leak risks.
- Quartz profile conflicts.
- GitHub Pages deploy profile errors.

Requirements:

- `lint` exits non-zero on critical errors.
- `--json` returns stable issue records.
- `--fix` only performs deterministic safe fixes.
- `index rebuild` regenerates machine cache from Markdown/frontmatter without making hidden JSON the source of truth.

Acceptance criteria:

- A malformed source card is reported with path, severity, rule ID, and fix hint.
- `lint --profile public --strict` fails before any private/raw content can enter public Quartz output.
- `index rebuild` produces caches and manifests from existing Markdown.

### 5.6 Search and Navigation

Implement:

```bash
llm-wiki search "<query>" --scope raw|curated|all --json
llm-wiki nav backlinks "<page>"
llm-wiki nav outlinks "<page>"
llm-wiki nav orphans
llm-wiki nav sources "<page>"
llm-wiki nav graph --json
```

Requirements:

- Search Markdown titles, aliases, tags, headings, and body text.
- Support offline operation.
- Parse Obsidian-style `[[wikilinks]]`.
- Return paths, page type, title, snippet, score, and source IDs where available.
- Exclude configured system pages from orphan reports.

Acceptance criteria:

- Search works without Quartz and without network access.
- `nav graph --json` is suitable for a browser graph visualization.
- Backlink/outlink output matches Markdown content.

### 5.7 Status, Log, and Snapshot

Implement:

```bash
llm-wiki status
llm-wiki log
llm-wiki snapshot
```

Requirements:

- `status` reports repo health, queue state, Git state, profile state, and Explorer readiness.
- `log` reads structured entries from `curated/log.md`.
- `snapshot` commits current repo state with a standard message when Git is enabled.

Acceptance criteria:

- `status --json` is stable and agent-readable.
- `snapshot` refuses to commit when lint has critical errors unless an explicit override is added.

---

## 6. Quartz Explorer Scope

### 6.1 `explore init`

Implement:

```bash
llm-wiki explore init
```

Requirements:

- Create `quartz/` runtime directory.
- Install or check Quartz dependencies, or print precise install instructions when install is not performed.
- Generate Quartz config/layout suitable for local exploration.
- Add LLM Wiki components/plugins or placeholders:
  - Source status badges.
  - Review panel.
  - Queue dashboard.
  - Visibility warnings.
  - Upload form placeholder for V1 daemon.
- Configure wikilinks, backlinks, graph, and search.

Acceptance criteria:

- A user can run `explore init` after `init`.
- `quartz/` is present with package/config files.
- No public profile includes raw originals.

### 6.2 `explore sync`

Implement:

```bash
llm-wiki explore sync --profile local|review|public
```

Requirements:

- Read `.llm-wiki/profiles/<profile>.yml`.
- Select eligible files.
- Materialize selected Markdown into `quartz/content/`.
- Rewrite or validate wikilinks.
- Generate profile manifests:
  - `.llm-wiki/cache/quartz-manifest.local.json`
  - `.llm-wiki/cache/quartz-manifest.review.json`
  - `.llm-wiki/cache/quartz-manifest.public.json`
- Generate static review pages where Dataview does not execute.
- Fail closed for unsafe public links or content.

Acceptance criteria:

- Local profile includes curated pages, source summaries, dashboards, review pages, queue/status pages, and raw source cards, but excludes raw originals.
- Public profile includes only `visibility: public` pages and public-safe assets.
- Public manifest contains no private/raw text.

### 6.3 `explore serve`, `open`, and `build`

Implement:

```bash
llm-wiki explore serve --profile local
llm-wiki explore open
llm-wiki explore build --profile public
```

Requirements:

- `serve` runs sync first.
- Local server binds to localhost by default.
- Show the local URL.
- Watch curated pages, source cards, profiles, and config for changes.
- `open` opens or prints the current Explorer URL.
- `build` produces static output for the selected profile.

Acceptance criteria:

- User can browse curated pages locally without deployment.
- Browser search, wikilinks, backlinks, and graph work for synced content.
- Review profile shows recent ingests, needs-review pages, contradictions, orphans, source queue, and private-link leaks.

---

## 7. GitHub Pages Deploy Scope

Implement:

```bash
llm-wiki deploy github-pages init
llm-wiki deploy github-pages check
llm-wiki deploy github-pages build-local
llm-wiki deploy github-pages status
```

Requirements:

- Generate:

```text
.github/workflows/llm-wiki-pages.yml
.llm-wiki/profiles/github-pages.yml
.llm-wiki/profiles/public.yml
```

- Infer Quartz `baseUrl` from Git remote and repo name.
- Support `--custom-domain`.
- Generate a workflow that:
  - Checks out the repo.
  - Installs Node/Quartz dependencies.
  - Installs or runs the `llm-wiki` CLI.
  - Runs `llm-wiki explore sync --profile public`.
  - Runs `llm-wiki lint --profile public --strict`.
  - Builds Quartz.
  - Uploads `quartz/public` using the Pages artifact action.
  - Deploys through the official Pages deploy action.
  - Supports `workflow_dispatch`.
- Print setup instructions for GitHub Pages source configuration.

Acceptance criteria:

- `deploy github-pages init` creates the workflow and profiles.
- `build-local` performs the same public sync/lint/build sequence as CI.
- Public leak checks fail before Quartz build.
- Generated workflow uses least required permissions for Pages deployment.

---

## 8. V1 Upload and Review Scope

### 8.1 Local upload daemon

Implement:

```bash
llm-wiki daemon
llm-wiki explore serve --profile local --with-daemon
```

Requirements:

- Bind to localhost by default.
- Expose `POST /api/raw-upload`.
- Support multipart file, URL, and text note payloads.
- Reuse the same source capture service as CLI `add`, `add-url`, and `add-text`.
- Create source card and queue item.
- Optionally trigger ingest or commit upload when explicitly configured.

Acceptance criteria:

- Local Explorer can upload a file and receive `source_id`, status, and path.
- Daemon never exposes raw originals through public profiles.
- Daemon refuses non-local binding without an explicit flag.

### 8.2 Local upload to GitHub Pages publication

Implement a static publication flow, not a deployed upload service:

```bash
llm-wiki explore serve --profile local --with-daemon
llm-wiki deploy github-pages build-local
```

Requirements:

- Uploads are accepted only by local/private `llm-wiki` instances.
- GitHub Pages output never includes upload forms, upload API routes, upload endpoint config, daemon metadata, tokens, or secrets.
- Uploaded content remains queued and private until reviewed and ingested.
- Reviewed static pages are built, committed to the repo, and then served by GitHub Pages.
- Publication uses a PR-first flow by default.

Acceptance criteria:

- Local/private upload creates queued raw source artifacts without publishing them.
- Public and `github-pages` deploy output exclude all upload functionality.
- Static Pages output can be committed to a branch and reviewed in a pull request before publication.

---

## 9. Cross-Cutting Requirements

### 9.1 Command consistency

Every command used by agents must support:

```bash
--repo <path>
--json
--quiet
```

Human output should be readable and actionable. JSON output should be stable and tested.

### 9.2 Privacy and safety

- Raw sources are private by default.
- Public publishing is opt-in through `visibility: public`.
- Public profile builds fail closed.
- Raw originals are never copied to public Quartz content by default.
- Public graph/search indexes must not include private node names or private body text.
- Destructive actions require explicit flags.

### 9.3 Git behavior

- Meaningful operations should create reviewable Git diffs.
- Ingest operations should prefer branches when Git is enabled.
- `snapshot` should use standard commit messages.
- Commands must never hide failed Git operations.

### 9.4 Performance targets

MVP targets:

- `llm-wiki status`: under 2 seconds for 1,000 Markdown pages.
- `llm-wiki search`: under 1 second for 1,000 Markdown pages.
- `llm-wiki index rebuild`: under 10 seconds for 5,000 Markdown pages.
- `llm-wiki lint`: under 15 seconds for 5,000 Markdown pages.
- `explore sync`: under 3 seconds for small changes after dependencies are installed.
- Public leak check: under 10 seconds for 5,000 pages.

---

## 10. Recommended Follow-Up Slice Plan

### REM-001: Source Capture Core

Implement source IDs, hashing, source cards, queue JSON, `add`, `add-text`, and duplicate detection.

### REM-002: Queue, Log, and Status

Implement `queue`, `status`, structured log parsing/appending, and queue/source consistency checks.

### REM-003: Lint and Index Rebuild

Implement frontmatter, wikilink, queue, source hash, index/log, and public profile lint rules plus `index rebuild`.

### REM-004: Search and Navigation

Implement local Markdown search, wikilink graph parsing, backlinks, outlinks, orphans, source relations, and graph JSON.

### REM-005: Ingest and Query Task Scaffolding

Implement agent task generation for `ingest` and `query --save`, validation of agent outputs, index/log enforcement, and queue status transitions.

### REM-006: Quartz Explorer Init and Sync

Implement `explore init`, profile-aware `explore sync`, generated manifests, Quartz content materialization, and static review pages.

### REM-007: Quartz Serve/Open/Build

Implement local `explore serve`, `explore open`, `explore build`, watch mode, browser search/backlinks/graph configuration, and review profile surfaces.

### REM-008: GitHub Pages Deploy

Implement workflow/profile generation, base URL inference, custom domain support, deploy checks, local preflight, strict leak checks, and setup instructions.

### REM-009: Local Upload V1

Implement local daemon, upload API, Explorer upload form integration, and optional upload commit behavior.

### REM-010: Static Pages Publication from Local Upload V1

Implement local-upload-to-static-Pages publication, including upload-free GitHub Pages output, static output commit support, PR-first publication, and documentation that the legacy remote upload scaffold is not a GitHub Pages upload path.

---

## 11. Acceptance Criteria for This Follow-Up PRD

The follow-up implementation is complete when:

- A user can initialize a wiki, add a raw source, queue it, lint it, search it, and browse it in local Quartz Explorer.
- A configured agent can receive an ingest task and produce validated curated updates.
- `curated/index.md` and `curated/log.md` are maintained across add, ingest, query-save, lint, deploy, and upload workflows.
- Public profile sync and GitHub Pages preflight fail before private/raw content can leak.
- GitHub Pages deploy workflow generation and local build preflight work.
- Review profile exposes queued sources, recent ingests, contradictions, stale pages, orphans, and needs-review pages.
- Local upload works only through a localhost daemon.
- GitHub Pages publication is static and upload-free, with reviewed output committed through a PR-first flow.

---

## 12. Open Questions

1. Should `add-url` be included in the next MVP tranche or deferred until after file/text capture is stable?
2. Should ingest branch creation be automatic or printed as an explicit next command?
3. Should `query` call a provider directly in any mode, or always generate an agent task first?
4. Should `quartz/content/` be committed, generated, or configurable per profile?
5. Should `explore init` install Quartz dependencies automatically or require an explicit `--install` flag?
6. Should public deploy require all included pages to have `review_status: approved`?
7. Should local upload commits be enabled by default or only with an explicit flag?
8. Should the legacy remote upload scaffold be removed, hidden, or retained with documentation that it is not a GitHub Pages feature?
