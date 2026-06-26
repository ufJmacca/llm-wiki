# Product Requirements Document: LLM Wiki Local Upload to Static GitHub Pages

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-23
**Updated:** 2026-06-26
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`
**Purpose:** Define the end-to-end upload path where uploads are handled by a local or privately hosted `llm-wiki` instance, reviewed into committed static site output, and then served by GitHub Pages.

---

## 1. Executive Summary

GitHub Pages deployments for `llm-wiki` are static, read-only publication targets. They must not provide upload functionality, upload forms, upload endpoint configuration, runtime upload metadata, write credentials, or any client behavior that submits new raw sources.

Upload functionality belongs to a local or privately hosted `llm-wiki` instance. A maintainer runs `llm-wiki explore serve --profile local --with-daemon`, uploads file/text/URL sources through the local Explorer, reviews and ingests private queued content, builds static output, commits that static output to the repository, and publishes it through a review pull request. GitHub Pages then serves only the committed static pages.

This PRD replaces the earlier remote/serverless upload direction for GitHub Pages. Any existing `llm-wiki upload init --target github` scaffold must be treated as deprecated or out of scope for GitHub Pages until a separate PRD defines a non-Pages hosted service.

---

## 2. Goals

1. Make upload end-to-end usable through local or privately hosted `llm-wiki` instances.
2. Keep GitHub Pages deployments static and upload-free.
3. Keep uploaded content private, queued, and unpublished until reviewed.
4. Publish only reviewed static site output to GitHub Pages.
5. Use pull requests as the default review path before Pages serves updated static output.

---

## 3. Non-Goals

- Add upload support to GitHub Pages deployments.
- Render upload forms in public or `github-pages` profiles.
- Expose `POST /api/raw-upload` from GitHub Pages.
- Store upload endpoint config, upload tokens, backend secrets, or write credentials in public static output.
- Build a hosted `llm-wiki` upload service.
- Complete the old serverless remote-upload backend scaffold in this PRD.
- Publish uploaded raw content directly to GitHub Pages.
- Accept anonymous public uploads by default.

---

## 4. Current State

Implemented:

- `llm-wiki daemon`
- `llm-wiki explore serve --profile local --with-daemon`
- Local token-protected `POST /api/raw-upload`
- Local upload support for file, text, and URL payloads
- Source card, raw input, queue JSON, and log updates from local source capture
- Public profile leak checks that reject runtime daemon metadata and upload/review leaks
- GitHub Pages deploy workflow/profile generation
- `llm-wiki upload init --target github` remote scaffold

Required changes:

- Reframe the upload E2E product around local/private hosting, not deployed GitHub Pages upload.
- Ensure `github-pages` and public profiles never materialize upload UI, upload metadata, or upload endpoint configuration.
- Ensure deploy checks fail if static output contains upload-capable surfaces.
- Define a static publication flow where reviewed generated pages are committed to the repo before GitHub Pages serves them.
- Mark the remote/serverless upload scaffold as out of scope for the GitHub Pages path.

---

## 5. User Stories

### 5.1 Upload locally

As a maintainer, I want to run:

```bash
llm-wiki explore serve --profile local --with-daemon
```

and use the local Explorer to upload a file, pasted text, or URL into the private raw source queue.

### 5.2 Review and ingest locally

As a maintainer, I want uploaded sources to remain private and queued until I review source cards, ingest approved sources, update curated pages, and run local checks.

### 5.3 Build static publication output

As a maintainer, I want to build a static public site from approved curated content only, with no upload controls or runtime upload configuration.

### 5.4 Publish through review PR

As a repo maintainer, I want `llm-wiki` to commit reviewed static output to a branch and open a pull request before GitHub Pages serves the updated site.

### 5.5 Browse on GitHub Pages

As a site visitor, I want GitHub Pages to serve a static wiki that has no upload affordance and cannot accept new content.

---

## 6. Architecture

```text
Local/private llm-wiki instance
  -> Local Explorer upload form
  -> Local upload daemon on localhost/private host
  -> Payload validation
  -> Private raw source artifacts
  -> Queue and review state
  -> Maintainer review and ingest
  -> Static public build
  -> Commit static output to repo branch
  -> Open pull request
  -> Merge reviewed static output
  -> GitHub Pages serves committed static files
```

GitHub Pages is the final static serving layer only. It does not host upload code, receive upload requests, call upload backends, or hold write authority.

---

## 7. GitHub Pages Static-Only Requirements

GitHub Pages deployments must never include:

- upload forms or upload buttons,
- `LlmWikiUploadForm` or equivalent upload-capable components,
- `/api/raw-upload` routes or links,
- local daemon metadata,
- remote upload endpoint metadata,
- upload tokens, auth headers, signatures, secrets, or GitHub credentials,
- client code that submits file/text/URL payloads,
- review-only or queue-only pages that expose private source state,
- raw originals or private source cards.

The `github-pages` profile must be equivalent to a public static publication profile for upload purposes. A feature flag such as `upload: true` must be ignored, rejected, or fail preflight when the active profile is `public` or `github-pages`.

Static output may include reviewed, public-safe pages generated from approved curated content. It must not include a hidden upload configuration that could be enabled later by client-side code.

---

## 8. Local Upload Requirements

### 8.1 Serve mode

The supported upload surface is:

```bash
llm-wiki explore serve --profile local --with-daemon
```

Requirements:

- Bind to localhost by default.
- Require an explicit opt-in for any non-local bind address.
- Use an ephemeral per-run upload token.
- Write runtime daemon metadata only into local generated Explorer output.
- Never commit daemon metadata or tokens.
- Omit upload UI when the daemon is not enabled.

### 8.2 Upload API

The local daemon exposes:

```http
POST /api/raw-upload
```

Request type:

```text
multipart/form-data
```

Supported payloads:

- file: `file`
- text: `text`, `title`
- URL: `url`, optional `title`

Required header:

```text
x-llm-wiki-upload-token: <ephemeral-token>
```

### 8.3 Payload validation

Default limits:

- max file bytes: 25 MiB,
- max text bytes: 1 MiB,
- allowed extensions: `.md`, `.markdown`, `.txt`, `.pdf`,
- allowed MIME types: `text/markdown`, `text/plain`, `application/pdf`.

Oversized, unsupported, malformed, or unauthenticated uploads must fail with structured errors.

### 8.4 Source artifact generation

The daemon must reuse the same logical source capture behavior as CLI source capture:

- immutable original under `raw/inputs/YYYY/MM/<source_id>/original.<ext>`,
- source card under `raw/inputs/YYYY/MM/<source_id>/_source.md`,
- queue JSON under `raw/queue/<source_id>.json`,
- log entry appended to `curated/log.md`.

Uploaded source card requirements:

- `visibility: private`,
- `status: queued`,
- `origin: local-upload:<filename-or-kind>` or equivalent local origin,
- uploader/session identity when available,
- content hash recorded.

### 8.5 Success response

```json
{
  "ok": true,
  "data": {
    "source_id": "src_2026_06_23_upload_title_abc123ef",
    "title": "Upload Title",
    "source_kind": "file",
    "visibility": "private",
    "queue_status": "queued",
    "created_paths": [
      "raw/inputs/2026/06/src_2026_06_23_upload_title_abc123ef/original.md",
      "raw/inputs/2026/06/src_2026_06_23_upload_title_abc123ef/_source.md",
      "raw/queue/src_2026_06_23_upload_title_abc123ef.json"
    ],
    "message": "Raw source uploaded and queued for ingest."
  }
}
```

### 8.6 Failure response

```json
{
  "ok": false,
  "error": {
    "code": "UPLOAD_AUTH_FAILED",
    "message": "Upload authentication failed.",
    "hint": "Refresh the local Explorer session and retry the upload."
  },
  "issues": []
}
```

---

## 9. Review, Build, and Publication Flow

The default publication path is review PR.

Required flow:

1. Upload through a local/private `llm-wiki` instance.
2. Keep raw source artifacts private and queued.
3. Review uploaded source cards and queue state locally.
4. Ingest approved sources into curated Markdown.
5. Run public safety checks:

```bash
llm-wiki lint --profile public --strict
```

6. Build static output for GitHub Pages.
7. Commit only reviewed source changes and static public output intended for publication.
8. Open a pull request for review.
9. Merge the pull request.
10. GitHub Pages serves the committed static files or the static build generated from committed public-safe content.

Direct commits to the Pages source branch are not the default. Any direct-commit mode must require an explicit opt-in outside this PRD.

---

## 10. Static Output Commit Requirements

The implementation must support a path where generated static pages are committed to the repository before GitHub Pages serves them.

Requirements:

- Static output is generated from public-safe profile content only.
- The committed Pages payload contains no upload UI, local runtime metadata, queue internals, raw originals, private source cards, or secrets.
- The committed payload is reviewable in a pull request before publication.
- GitHub Pages configuration points at the committed static output location or a workflow artifact generated only from committed public-safe content.
- The build path must be deterministic enough that reviewers can understand what changed.

If both committed static output and action-built output exist later, this PRD's required baseline remains committed static output through review PR.

---

## 11. Security Requirements

- GitHub Pages is read-only static output and must not provide upload functionality.
- No raw upload is published directly.
- No upload token, daemon metadata, endpoint config, backend secret, or GitHub write credential is written into public static files.
- Public and `github-pages` profile lint must fail if upload-capable surfaces are selected.
- Public and `github-pages` profile lint must fail if generated output includes runtime, upload, review, raw path, or queue leaks.
- The local daemon must not log raw upload body contents.
- The local daemon must reject missing or invalid upload tokens.
- Upload error messages must not expose secrets or local filesystem internals beyond actionable safe paths.

---

## 12. Acceptance Criteria

1. `llm-wiki explore serve --profile local --with-daemon` supports file/text/URL upload through the local Explorer.
2. Local uploads create private raw originals, source cards, queue JSON, and log entries.
3. Uploaded content remains unpublished until reviewed and ingested into public-safe curated output.
4. `github-pages` and public profile sync/build output never includes upload forms, upload runtime metadata, upload endpoint configuration, or upload-capable client code.
5. `llm-wiki deploy github-pages check` and public strict lint fail if upload functionality is selected for GitHub Pages.
6. Static output intended for GitHub Pages can be committed to a branch and reviewed in a pull request.
7. GitHub Pages serves only committed static files or workflow-built files generated from committed public-safe content.
8. Existing serverless remote-upload scaffold behavior is not required for this PRD and is not presented as a GitHub Pages upload path.

---

## 13. Tests

Add or maintain tests for:

- Local browser upload form submitting file/text/URL payloads to a test daemon.
- Local daemon token success and failure.
- Payload size and file type rejection.
- Source artifact generation parity with CLI source capture.
- Duplicate content behavior in local capture.
- `github-pages` profile sync excluding upload components and daemon metadata.
- Public strict lint rejecting upload forms, `/api/raw-upload` references, upload tokens, endpoint config, review-only pages, queue leaks, and raw path leaks.
- Deploy preflight rejecting any upload-enabled GitHub Pages profile.
- Static output commit flow producing a reviewable diff without private upload artifacts.

---

## 14. Documentation

Update docs to include:

- The difference between local/private upload and GitHub Pages static publication.
- How to run local Explorer upload with `--with-daemon`.
- How uploaded sources move from queued private raw artifacts to reviewed curated pages.
- How to build and commit static output for GitHub Pages.
- How maintainers review the publication PR.
- A security model stating that GitHub Pages never supports upload functionality.
- Migration guidance for any existing remote upload scaffold, marking it out of scope for GitHub Pages.

---

## 15. Open Questions

1. Should the legacy `llm-wiki upload init --target github` command be removed, hidden, or retained with documentation that it is not a GitHub Pages feature?
2. Should committed static output be the only supported GitHub Pages mode, or should action-built output from committed public-safe content remain supported as a secondary mode?
3. Should local/private hosted upload support authenticated multi-user operation beyond the localhost daemon model?
