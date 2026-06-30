# Product Requirements Document: LLM Wiki Auto Ingest for Uploads and Queue Processing

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-30
**Updated:** 2026-06-30
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`, `./prds/llm-wiki-remote-upload-e2e-prd.md`
**Purpose:** Define an opt-in auto-ingestion capability for Quartz local uploads and CLI queue processing while preserving raw-source privacy, ingest validation, and static-only GitHub Pages publication.

---

## 1. Executive Summary

`llm-wiki` currently supports local source capture through CLI commands and the Quartz Explorer upload daemon. Captured sources are written as private raw artifacts, source cards, queue JSON, and log entries. Maintainers then run `llm-wiki ingest <source_id> --auto` or a manual ingest workflow to curate the source into validated Markdown.

This PRD adds an opt-in auto-ingest capability that can run immediately after Quartz local uploads or process queued sources from the CLI. Auto-ingest must reuse the existing validated ingest pipeline. It automates the transition from queued raw source to curated proposal, but it must not bypass validation, mutate raw originals, publish to GitHub Pages, or build public static output automatically.

The safety boundary is:

```text
source capture -> private queue -> validated auto-ingest -> curated Markdown
```

Publication remains separate:

```text
curated Markdown -> public lint/build/check -> review commit or PR -> static Pages output
```

---

## 2. Goals

1. Allow maintainers to opt into automatic ingest immediately after successful Quartz local uploads.
2. Allow maintainers to auto-ingest existing queued sources from the CLI.
3. Reuse the same ingest validation behavior as `llm-wiki ingest <source_id> --auto`.
4. Preserve private-by-default raw source handling and reviewed publication flow.
5. Provide clear status, logs, and review UI feedback for queued, ingesting, ingested, and blocked sources.
6. Prevent concurrent auto-ingest workers from corrupting curated Markdown or queue state.

---

## 3. Non-Goals

- Do not enable uploads on GitHub Pages.
- Do not render upload forms in `public` or `github-pages` profiles.
- Do not publish uploaded raw content directly.
- Do not automatically build, commit, deploy, or publish GitHub Pages output.
- Do not bypass `ingest --validate` or accept unvalidated agent/provider output.
- Do not modify raw originals after capture.
- Do not enable anonymous remote ingestion by default.
- Do not require auto-ingest for existing manual review workflows.

---

## 4. Current State

Implemented behavior:

- `llm-wiki explore serve --profile local --with-daemon` starts a local upload daemon.
- Quartz local uploads create private raw originals, source cards, queue JSON, and log entries.
- Successful upload responses include a `source_id` and next ingest command.
- `llm-wiki ingest <source_id> --auto` runs the configured default local agent and validates curated output before accepting it.
- Queue statuses are `queued`, `ingesting`, `ingested`, and `blocked`.
- Public and GitHub Pages profiles must exclude upload UI, daemon metadata, queue internals, raw originals, and private source cards.

Missing behavior:

- Uploads cannot automatically trigger ingest after source capture.
- There is no CLI queue worker to process queued sources in bulk.
- There is no watch mode that auto-ingests sources as they arrive.
- Auto-ingest attempt results are not exposed as first-class queue processing events.

---

## 5. User Stories

### 5.1 Auto-ingest after Quartz upload

As a maintainer, I want to run:

```bash
llm-wiki explore serve --profile local --with-daemon --auto-ingest-uploads
```

then upload a file, pasted text, or URL from the local Quartz Explorer and have `llm-wiki` automatically run validated ingest for that uploaded source.

### 5.2 Keep manual upload behavior by default

As a maintainer, I want existing upload behavior to remain unchanged unless I explicitly pass the auto-ingest flag.

### 5.3 Auto-ingest queued sources from CLI

As a maintainer, I want to run:

```bash
llm-wiki queue ingest --auto
```

and have `llm-wiki` process currently queued sources with the configured default local agent.

### 5.4 Watch the queue

As a maintainer, I want to run:

```bash
llm-wiki queue ingest --auto --watch
```

so newly queued sources are picked up and auto-ingested while the command is running.

### 5.5 Understand failures

As a maintainer, I want failed auto-ingest attempts to mark the source as `blocked`, preserve the failed proposal context, and show an actionable error in CLI output and review pages.

---

## 6. Proposed Commands

### 6.1 Quartz upload-triggered auto-ingest

Add:

```bash
llm-wiki explore serve --profile local --with-daemon --auto-ingest-uploads
```

Behavior:

- Valid only with `--with-daemon`.
- Valid only for local or review-capable private profiles.
- Uses `agent.default` from `.llm-wiki/config.yml`.
- Runs auto-ingest after the upload is successfully captured and queued.
- Upload success is not rolled back if auto-ingest fails.
- Upload response and browser UI must report the auto-ingest result.

Optional supporting flags:

```bash
--auto-ingest-concurrency <n>
--auto-ingest-provider <name>
```

Default concurrency must be `1` unless a later implementation proves safe multi-source curated writes.

### 6.2 CLI queue auto-ingest

Add:

```bash
llm-wiki queue ingest --auto
llm-wiki queue ingest --auto --watch
llm-wiki queue ingest --auto --limit 5
llm-wiki queue ingest --auto --source-id <source_id>
```

Behavior:

- Processes only sources with status `queued` unless `--source-id` targets a source that is already `blocked` and an explicit retry flag is added later.
- Uses `agent.default` from `.llm-wiki/config.yml`.
- Prints a per-source result summary.
- Exits non-zero if any selected source fails to ingest.
- `--watch` keeps running and processes new queued sources until interrupted.
- `--limit` bounds the number of sources processed in a single non-watch run.

---

## 7. Auto-Ingest Worker Requirements

Auto-ingest should be implemented as a shared worker used by both Quartz upload-triggered ingestion and CLI queue ingestion.

Worker requirements:

- Select eligible queue items deterministically, oldest first by queue timestamp.
- Acquire a per-repository ingest lock before mutating queue state or curated files.
- Transition `queued -> ingesting` before invoking the agent.
- Run the same proposal, validation, and application flow as `llm-wiki ingest <source_id> --auto`.
- Transition `ingesting -> ingested` only after validation passes.
- Transition `ingesting -> blocked` when agent execution, proposal extraction, validation, or application fails.
- Leave raw originals immutable.
- Reject or defer work if another ingest is already mutating the repository.
- Record an auto-ingest event in `curated/log.md` or a structured runtime log for every success and failure.

The worker must not directly call publication, deploy, Pages build, or snapshot commands.

---

## 8. Queue State and Status Model

Existing statuses remain:

```text
queued -> ingesting -> ingested
queued -> ingesting -> blocked
blocked -> queued
```

Auto-ingest adds attempt metadata, not new required statuses.

Recommended queue metadata:

```yaml
auto_ingest:
  enabled: true
  attempt_count: 1
  last_attempt_at: "2026-06-30T00:00:00.000Z"
  last_result: "ingested"
  last_error_code: null
  last_error_message: null
```

For blocked sources:

```yaml
auto_ingest:
  enabled: true
  attempt_count: 1
  last_attempt_at: "2026-06-30T00:00:00.000Z"
  last_result: "blocked"
  last_error_code: "INGEST_VALIDATION_FAILED"
  last_error_message: "curated/sources/<source_id>.md was not created."
```

Duplicate uploads must not trigger a second ingest when the existing source is already `ingested`. If the duplicate source is still `queued`, upload-triggered auto-ingest may enqueue or attempt ingest for the existing queue item.

---

## 9. Quartz Explorer UX Requirements

When `--auto-ingest-uploads` is disabled:

- The upload form keeps current behavior.
- Successful upload shows the next manual ingest command.

When `--auto-ingest-uploads` is enabled:

- Local daemon runtime metadata must include `auto_ingest_available: true`.
- Successful upload initially shows that the source was captured and auto-ingest started.
- The UI must show final result when available:
  - `ingested`: source was captured and curated successfully.
  - `blocked`: source was captured but auto-ingest failed.
  - `queued`: source was captured but auto-ingest could not start.
- The UI must include the manual retry command for blocked or queued results.

The review pages should continue to derive queue counts from live queue state. They should show accurate counts after auto-ingest transitions.

---

## 10. Error Handling

### Missing auto agent

If `--auto-ingest-uploads` or `queue ingest --auto` is used without a configured `agent.default`, fail clearly before processing.

Upload-triggered behavior:

- The upload may still be captured.
- Auto-ingest result must report that no default auto agent is configured.
- The source remains `queued`.

CLI queue behavior:

- The command exits non-zero.
- No queue items are moved to `ingesting`.

### Agent execution failure

- Reject proposed changes.
- Mark source `blocked`.
- Store an actionable error summary.
- Preserve enough context for retry.

### Validation failure

- Do not accept curated writes.
- Mark source `blocked`.
- Report validation issues in CLI output and review state.

### Concurrent mutation

- If another ingest worker holds the repo lock, wait, retry, or fail with a clear lock message.
- Default behavior should prefer safe serialization over parallel curated writes.

### Upload failure

- Failed uploads must not create ingest work.
- Upload validation and authentication errors behave as they do today.

---

## 11. Security and Safety Requirements

- Auto-ingest is opt-in and must never be enabled by default.
- Auto-ingest is allowed only in local/private contexts.
- Public and `github-pages` profiles must still exclude upload UI, daemon metadata, queue internals, raw originals, private source cards, and auto-ingest runtime metadata.
- Auto-ingest must never publish, deploy, or expose raw uploads directly.
- Auto-ingest logs must not include raw upload body contents or secrets.
- Runtime daemon metadata must not include credentials other than the existing ephemeral local upload token.
- Queue and review output must not leak private content into public static output.

---

## 12. Acceptance Criteria

1. `llm-wiki explore serve --profile local --with-daemon` keeps current queue-only upload behavior.
2. `llm-wiki explore serve --profile local --with-daemon --auto-ingest-uploads` captures an uploaded text source and automatically ingests it with the configured default agent.
3. Upload-triggered auto-ingest marks the source `ingested` only after ingest validation passes.
4. Upload-triggered auto-ingest marks the source `blocked` when the agent or validation fails, without rolling back the captured upload.
5. `llm-wiki queue ingest --auto` processes currently queued sources and reports per-source results.
6. `llm-wiki queue ingest --auto --limit 1` processes only one eligible queued source.
7. `llm-wiki queue ingest --auto --watch` processes new queued sources while running.
8. Missing `agent.default` fails clearly and leaves queue state safe.
9. Concurrent auto-ingest attempts do not corrupt curated files, queue JSON, or `curated/log.md`.
10. Public and `github-pages` sync/build output remains free of upload UI, daemon metadata, queue internals, auto-ingest runtime metadata, raw originals, and private source cards.
11. Review pages show accurate queue counts after successful and failed auto-ingest attempts.

---

## 13. Test Plan

Add or maintain tests for:

- CLI parsing for `--auto-ingest-uploads`.
- CLI parsing for `queue ingest --auto`, `--watch`, `--limit`, and `--source-id`.
- Upload capture with auto-ingest disabled.
- Upload capture with auto-ingest enabled and successful validation.
- Upload capture with auto-ingest enabled and agent failure.
- Upload capture with auto-ingest enabled and validation failure.
- Queue batch auto-ingest with zero, one, and multiple queued sources.
- Queue batch auto-ingest with `--limit`.
- Watch mode processing newly queued sources.
- Missing default agent configuration.
- Duplicate upload behavior for queued and ingested sources.
- Repository lock behavior under concurrent auto-ingest attempts.
- Public and GitHub Pages profile leak checks.
- Review page queue counts after `queued`, `ingesting`, `ingested`, and `blocked` transitions.

---

## 14. Documentation

Update docs to include:

- The difference between upload capture, auto-ingest, and publication.
- How to run local Quartz uploads without auto-ingest.
- How to run local Quartz uploads with auto-ingest.
- How to process queued sources with `llm-wiki queue ingest --auto`.
- How to run queue watch mode.
- How to configure `agent.default` for auto-ingest.
- How to inspect and retry blocked auto-ingest sources.
- The security model: auto-ingest does not enable GitHub Pages uploads or automatic publication.

---

## 15. Open Questions

1. Should `queue ingest --auto --source-id <source_id>` support retrying `blocked` sources by default, or require a separate `--retry-blocked` flag?
2. Should upload-triggered auto-ingest wait for completion before returning the upload HTTP response, or return immediately and expose status polling?
3. Should successful upload-triggered auto-ingest optionally run `explore sync --profile local` so the local Quartz view refreshes curated pages faster?
4. Should auto-ingest support provider mode at launch, or only the configured local agent default?
5. Should auto-ingest attempts be logged only in `curated/log.md`, or should there also be a structured `.llm-wiki/cache/auto-ingest-events.jsonl` runtime log?
