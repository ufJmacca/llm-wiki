# Product Requirements Document: LLM Wiki Remote Upload End-to-End

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-23
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`
**Purpose:** Define the production-ready remote upload path from deployed Quartz form to authenticated backend to GitHub pull request.

---

## 1. Executive Summary

`llm-wiki upload init --target github` currently generates a remote upload scaffold. The scaffold includes documentation, config, auth hooks, rate-limit hooks, a serverless handler template, and GitHub write templates. It is explicitly not a hosted service, and the handler remains incomplete around provider-specific request parsing and GitHub App token creation.

This PRD moves remote upload from scaffold-only to an end-to-end deployable workflow. A deployed Quartz site should be able to render an upload form only when a backend is configured. The backend should authenticate the request, validate payload limits, create queued private raw source artifacts, and open a GitHub pull request for review.

---

## 2. Goals

1. Make remote upload usable from deployed Quartz without giving the static site direct write access.
2. Require authentication and rate limiting before accepting upload payloads.
3. Create GitHub pull requests by default, not direct commits.
4. Keep uploaded content queued, private, and unpublished until reviewed.
5. Provide a deployable reference implementation for common serverless runtimes.

---

## 3. Non-Goals

- Build a hosted `llm-wiki` upload service.
- Publish uploaded content directly to GitHub Pages.
- Accept anonymous public upload by default.
- Support arbitrary binary file hosting.
- Implement non-GitHub write targets in this PRD.
- Implement private authenticated Quartz hosting.

---

## 4. Current State

Implemented:

- `llm-wiki upload init --target github`.
- Generated config:
  - `.llm-wiki/upload/github.yml`
  - `.llm-wiki/upload/forms/remote-github.json`
- Generated docs:
  - `docs/remote-upload-github.md`
- Generated backend scaffold:
  - `upload/github/serverless/raw-upload.ts`
  - `upload/github/serverless/auth.ts`
  - `upload/github/serverless/rate-limit.ts`
  - `upload/github/serverless/github.ts`
  - `.env.example`

Gaps:

- No complete serverless runtime adapter.
- No complete GitHub App token creation.
- No tested branch/commit/PR flow against GitHub API.
- No deployed Quartz upload form integration.
- No end-to-end remote upload contract tests.

---

## 5. User Stories

### 5.1 Configure remote upload

As a wiki owner, I want:

```bash
llm-wiki upload init --target github
```

to generate deployable backend code, required secrets documentation, and form configuration.

### 5.2 Deploy backend

As a wiki owner, I want to deploy the generated backend to a serverless runtime, set environment secrets, and expose the endpoint to the deployed Quartz site.

### 5.3 Submit from deployed Quartz

As an authorized uploader, I want to submit a file, URL, or text note from the deployed Quartz upload form.

### 5.4 Review remote upload

As a repo maintainer, I want each remote upload to arrive as a GitHub pull request containing only queued private raw source artifacts and an audit log entry.

---

## 6. Architecture

```text
Deployed Quartz form
  -> Authenticated Upload API
  -> Payload validation
  -> Source artifact builder
  -> GitHub App installation token
  -> Branch creation
  -> Commit raw source files
  -> Open pull request
  -> Return source_id and pr_url
```

The backend owns all write authority. The static Quartz site never receives GitHub credentials.

---

## 7. Upload API Contract

### 7.1 Endpoint

```http
POST /api/raw-upload
```

Required request type:

```text
multipart/form-data
```

Supported payloads:

- file: `file`
- text: `text`, `title`
- URL: `url`, optional `title`

### 7.2 Required headers

Authentication scheme is implementation-specific, but the reference backend must support signed requests:

```text
x-llm-wiki-upload-signature
x-llm-wiki-upload-timestamp
x-llm-wiki-uploader
```

The signature must bind:

- HTTP method,
- request path,
- body SHA-256 digest,
- timestamp,
- uploader identity.

### 7.3 Success response

```json
{
  "ok": true,
  "data": {
    "source_id": "src_2026_06_23_upload_title_abc123ef",
    "title": "Upload Title",
    "source_kind": "file",
    "visibility": "private",
    "queue_status": "queued",
    "branch": "llm-wiki/upload/src_2026_06_23_upload_title_abc123ef",
    "pr_url": "https://github.com/owner/repo/pull/123",
    "created_paths": [
      "raw/inputs/2026/06/src_2026_06_23_upload_title_abc123ef/original.md",
      "raw/inputs/2026/06/src_2026_06_23_upload_title_abc123ef/_source.md",
      "raw/queue/src_2026_06_23_upload_title_abc123ef.json"
    ],
    "message": "Raw source uploaded and queued for ingest."
  }
}
```

### 7.4 Failure response

```json
{
  "ok": false,
  "error": {
    "code": "UPLOAD_AUTH_FAILED",
    "message": "Upload authentication failed.",
    "hint": "Sign the upload request with a fresh timestamp."
  },
  "issues": []
}
```

---

## 8. Backend Requirements

### 8.1 Authentication

- Authentication is required by default.
- Requests with missing auth headers return `401`.
- Requests with stale timestamps return `401`.
- Requests with invalid signatures return `401`.
- Secrets come only from environment variables.
- The backend must not log raw upload body contents.

### 8.2 Rate limiting

Default:

- key: uploader identity plus IP when available,
- window: 60 seconds,
- max requests: 30,
- failure: `429`.

The generated scaffold must make the rate-limit store replaceable for production runtimes.

### 8.3 Payload limits

Default limits:

- max file bytes: 25 MiB,
- max text bytes: 1 MiB,
- allowed extensions: `.md`, `.markdown`, `.txt`, `.pdf`,
- allowed MIME types: `text/markdown`, `text/plain`, `application/pdf`.

Oversized or unsupported uploads return `400` or `413` with a structured error.

### 8.4 Source artifact generation

The backend must generate the same logical artifacts as local source capture:

- immutable original under `raw/inputs/YYYY/MM/<source_id>/original.<ext>`,
- source card under `raw/inputs/YYYY/MM/<source_id>/_source.md`,
- queue JSON under `raw/queue/<source_id>.json`,
- log entry appended to `curated/log.md`.

Remote upload source card requirements:

- `visibility: private`,
- `status: queued`,
- `origin: remote-upload:<filename-or-kind>`,
- uploader identity captured in metadata or notes,
- content hash recorded.

### 8.5 GitHub write flow

The default write mode is pull request.

Required flow:

1. Resolve GitHub App installation token from configured app credentials.
2. Read default branch SHA.
3. Create upload branch:

```text
llm-wiki/upload/<source_id>
```

4. Create blobs/tree/commit containing upload artifacts.
5. Open pull request into default branch.
6. Return PR URL in the API response.

The backend must not force-push over an existing upload branch.

### 8.6 Duplicate handling

If content hash already exists:

- prefer returning the existing source ID when discoverable,
- do not create duplicate raw source artifacts,
- if duplicate detection cannot be performed remotely, create a PR and mark the source card with `duplicate_check: pending`.

---

## 9. Quartz Remote Form Requirements

The public or deployed upload form must render only when:

- profile feature `upload: true`,
- remote form config exists,
- backend endpoint is configured outside tracked source or through a safe public config,
- public safety checks pass.

The form must:

- show authenticated upload state,
- support file/text/URL modes,
- show PR URL after success,
- make clear that remote uploads are queued and private,
- never expose secrets or GitHub credentials.

---

## 10. Security Requirements

- No raw upload is published directly.
- No backend secrets are written into repo files.
- No direct commit mode for default scaffold.
- Authentication is required before parsing expensive payloads when the runtime permits.
- Request body must be read with hard byte caps.
- Error messages must not expose secrets.
- Public profile lint must fail if remote backend config leaks private secrets.

---

## 11. Acceptance Criteria

1. `llm-wiki upload init --target github` generates a backend that compiles without manual code edits.
2. The backend can be configured with GitHub App credentials through environment variables.
3. A signed upload request creates a GitHub PR with raw original, source card, queue JSON, and log entry.
4. The PR branch name includes the source ID and does not overwrite existing branches.
5. The API response includes `source_id`, `queue_status`, `branch`, and `pr_url`.
6. Invalid signatures, stale timestamps, oversized payloads, unsupported file types, and rate-limited requests fail with structured errors.
7. Deployed Quartz upload form appears only when remote upload is configured and safe.
8. Public deploy output never includes backend secrets or raw uploaded content.

---

## 12. Tests

Add tests for:

- Generated backend TypeScript compilation.
- Signature verification success and failure.
- Timestamp freshness rejection.
- Rate-limit rejection.
- Payload size and file type rejection.
- Source artifact generation parity with local capture.
- Mock GitHub App token exchange.
- Mock GitHub branch/commit/PR flow.
- Existing branch conflict.
- Duplicate content behavior.
- Quartz remote form config inclusion/exclusion by profile.
- Public lint rejection for unsafe remote upload config.

---

## 13. Documentation

Update docs to include:

- GitHub App setup steps and required permissions.
- Required environment variables.
- Deployment examples for one supported serverless runtime.
- How to configure the deployed Quartz form endpoint.
- How maintainers review upload PRs.
- How uploaded sources are ingested after PR merge.
- Security model and default PR-first behavior.

---

## 14. Open Questions

1. Which serverless runtime should be the first fully supported target?
2. Should direct commit mode ever be supported for trusted private deployments?
3. Should remote URL capture fetch content in the backend or store only a URL source card for later local ingestion?
4. Should remote upload PRs request reviewers automatically when configured?
