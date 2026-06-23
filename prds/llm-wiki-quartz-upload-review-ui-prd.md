# Product Requirements Document: LLM Wiki Quartz Upload and Review UI

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-23
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`
**Purpose:** Complete the browser-facing local Quartz Explorer upload and review experience.

---

## 1. Executive Summary

`llm-wiki` currently initializes a Quartz runtime, syncs profile-selected Markdown into `quartz/content`, serves the local Explorer, and can start a localhost upload daemon. The backend upload API works independently through `POST /api/raw-upload`.

The browser-facing product is not complete. Generated Quartz components such as `LlmWikiUploadForm`, `LlmWikiReviewPanel`, `LlmWikiQueueDashboard`, `LlmWikiSourceBadge`, and `LlmWikiVisibilityWarning` are placeholders. Review profile output is limited to static generated pages for profile summary and source queue.

This PRD defines the missing local Explorer UI: a working upload form, queue state display, source status badges, visibility warnings, review dashboard surfaces, and a useful root/home behavior.

---

## 2. Goals

1. Let a user upload file, text, or URL sources from the local Explorer when `--with-daemon` is active.
2. Show queued source state immediately after upload.
3. Provide review-focused browser pages for queued sources, recent ingests, pages needing review, contradictions, stale pages, orphan pages, and profile safety.
4. Make `http://127.0.0.1:8080/` land on useful wiki content.
5. Keep all local upload and review data private by default.

---

## 3. Non-Goals

- Implement remote deployed upload UI. That is covered by the remote upload PRD.
- Implement live collaborative review workflows.
- Implement an Obsidian plugin.
- Replace Quartz's built-in search, backlinks, graph, or wikilink rendering.
- Expose raw originals in browser profiles.

---

## 4. Current State

Implemented:

- `llm-wiki explore init`
- `llm-wiki explore sync --profile local|review|public|github-pages`
- `llm-wiki explore serve --profile local --with-daemon`
- local upload daemon with token-protected `POST /api/raw-upload`
- profile-aware public leak checks
- generated review pages:
  - `_llm-wiki/review/profile-summary.md`
  - `_llm-wiki/review/source-queue.md`

Gaps:

- Upload form component is a placeholder.
- Queue dashboard and review panel components are placeholders.
- Browser upload flow requires manual curl instead of UI.
- Review dashboard does not cover all PRD surfaces.
- Root URL may not guide users to the synced wiki index in all local serve cases.
- No standard browser-visible daemon metadata handoff.

---

## 5. User Stories

### 5.1 Upload from local Explorer

As a user running:

```bash
llm-wiki explore serve --profile local --with-daemon
```

I want the local Explorer to show an upload control so I can add a file, pasted text, or URL without using curl.

### 5.2 Review upload result

As a user who uploaded a source, I want to see the returned `source_id`, queue status, source card link, and next ingest command.

### 5.3 Review wiki health in browser

As a reviewer, I want a review profile page that shows queued sources, recent ingests, needs-review pages, contradictions, stale pages, orphan pages, and private/public visibility warnings.

### 5.4 Root route

As a user opening `http://127.0.0.1:8080/`, I want the Explorer to show the wiki index or a generated local home page instead of a confusing empty or missing page.

---

## 6. Local Daemon Metadata

The Explorer needs enough metadata to render a local upload form.

When `explore serve --with-daemon` starts, write a generated local-only metadata file into `quartz/content/_llm-wiki/runtime/local-daemon.json` or an equivalent generated static asset.

Required fields:

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:32123",
  "upload_path": "/api/raw-upload",
  "token_header": "x-llm-wiki-upload-token",
  "upload_token": "<ephemeral-token>",
  "commit_uploads": false,
  "updated_at": "2026-06-23T00:00:00.000Z"
}
```

Requirements:

- This file must never be synced into public or github-pages profiles.
- The token must be per-daemon-run and must not be committed.
- `llm-wiki explore serve` without `--with-daemon` must either omit this file or write `enabled: false`.
- Public profile lint must fail if runtime daemon metadata is included.

---

## 7. Upload Form Requirements

### 7.1 Supported inputs

The form must support:

- file upload,
- pasted text with required title,
- URL capture with optional title.

### 7.2 Request contract

The form must submit `multipart/form-data` to:

```text
<daemon.url>/api/raw-upload
```

Headers:

```text
x-llm-wiki-upload-token: <upload_token>
```

Fields:

- `file` for file upload.
- `text` and `title` for pasted text.
- `url` and optional `title` for URL capture.

### 7.3 Result display

On success, the form must display:

- source title,
- source ID,
- source kind,
- queue status,
- source card path,
- original path,
- next command:

```bash
llm-wiki ingest <source_id>
```

If automated agent mode is configured, also show:

```bash
llm-wiki ingest <source_id> --auto
```

### 7.4 Error display

On failure, show:

- error code,
- message,
- fix hint,
- path when provided.

Common handled failures:

- daemon unavailable,
- token missing or rejected,
- unsupported content type,
- upload too large,
- invalid URL,
- duplicate source,
- non-local daemon configuration.

---

## 8. Review UI Requirements

### 8.1 Generated review pages

`explore sync --profile review` and local profile sync must generate static pages under:

```text
quartz/content/_llm-wiki/review/
```

Required pages:

- `overview.md`
- `source-queue.md`
- `recent-ingests.md`
- `needs-review.md`
- `contradictions.md`
- `orphans.md`
- `stale-pages.md`
- `visibility-warnings.md`
- `profile-summary.md`

### 8.2 Review data sources

The generated pages must derive from canonical repo state:

- raw queue JSON,
- raw source cards,
- curated page frontmatter,
- `curated/log.md`,
- lint results,
- profile selection rules,
- link graph scanner.

Generated review pages must not rely on hidden caches as source of truth.

### 8.3 Component requirements

Replace placeholders with components that render useful UI when included in Quartz layout:

- `LlmWikiUploadForm`: upload UI, state, success/error display.
- `LlmWikiQueueDashboard`: queued/ingesting/blocked source summary.
- `LlmWikiReviewPanel`: links to generated review pages and counts.
- `LlmWikiSourceBadge`: source status and visibility indicators for source cards and summaries.
- `LlmWikiVisibilityWarning`: local-only warning for pages that are private or unsafe for public profile.

MVP may implement these as lightweight client components that read generated JSON or Markdown-derived data.

---

## 9. Root and Navigation Behavior

The local Explorer root must be useful.

Acceptance order:

1. If `curated/index.md` exists in the synced profile, materialize it as `quartz/content/index.md`.
2. If `curated/index.md` is not selected, generate `quartz/content/index.md` with links to:
   - curated home,
   - review overview,
   - source queue,
   - dashboards.
3. Public and github-pages profiles must continue to require a public-safe root page before build.

The user must be able to start from `http://127.0.0.1:8080/` and navigate to wiki content without knowing internal Quartz paths.

---

## 10. Privacy Requirements

- Raw originals must never be synced into Quartz content by default.
- Local daemon metadata must never be included in public or github-pages profiles.
- Upload tokens must never be written to tracked files.
- Review pages may include private titles and queue state only in local/review profiles.
- Public lint must reject generated review pages if they expose private source titles, raw paths, queue data, or daemon tokens.

---

## 11. Acceptance Criteria

1. `llm-wiki explore serve --profile local --with-daemon` starts Quartz and daemon, then the Explorer displays a working upload form.
2. A browser file upload creates raw original, source card, queue JSON, and log entry.
3. Upload success updates the visible queue dashboard after refresh or client-side reload.
4. Pasted text upload and URL upload work from the same UI.
5. The upload form shows actionable errors when daemon is unavailable or the token is invalid.
6. Review profile includes pages for source queue, recent ingests, needs-review pages, contradictions, stale pages, orphans, and visibility warnings.
7. Root URL shows a wiki index or generated local home page.
8. `llm-wiki lint --profile public --strict` fails if upload UI runtime metadata or private review pages can enter public output.

---

## 12. Tests

Add tests for:

- Explorer serve with daemon writes local-only runtime metadata.
- Public sync excludes and rejects daemon metadata.
- Upload form component renders configured endpoint state.
- Browser upload form submits file/text/url payloads to a test daemon.
- Successful upload result renders source ID, paths, and next commands.
- Error result renders code, message, and hint.
- Review sync generates all required review pages.
- Review pages derive counts from queue JSON, source cards, log, lint, and graph state.
- Root page materialization for local profile.
- Public build still requires public-safe `curated/index.md`.

---

## 13. Documentation

Update docs to cover:

- Starting local Explorer with upload enabled.
- Browser upload payload types.
- Difference between local browser upload and remote deployed upload.
- Why local daemon binds only to loopback.
- How to ingest an uploaded source after upload.
- How review pages map to raw queue, lint, and log state.

---

## 14. Open Questions

1. Should the upload form be embedded in the default local layout or only linked from `_llm-wiki/review/overview.md`?
2. Should local profile upload be enabled whenever daemon metadata exists, or only when profile features include `upload: true`?
3. Should review pages be regenerated on file watcher events while Explorer is serving?
