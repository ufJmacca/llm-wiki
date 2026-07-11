# Product Requirements Document: LLM Wiki PDF Ingestion and Configurable Parsing

**Product name:** `llm-wiki`
**Implementation target:** `ainative`
**Document status:** Draft implementation PRD
**Created:** 2026-07-02
**Updated:** 2026-07-03
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-auto-ingest-prd.md`, `./prds/llm-wiki-quartz-upload-review-ui-prd.md`
**External parser target:** `ufJmacca/doc-parser`
**Purpose:** Define a PDF ingestion layer that converts uploaded PDFs into durable text artifacts before LLM curation, using only user-configurable `doc-parser` FastAPI parser profiles.

---

## 1. Executive Summary

`llm-wiki` captures uploaded files as immutable raw originals, then ingests sources into curated Markdown. For Markdown and text files, the ingest agent can read the original directly. For PDFs, this is unreliable: a PDF upload may be captured correctly, but the ingest request may only have a binary `original.pdf` path and no complete text representation. Without a required parser artifact, auto-ingest can recover only partial text streams and produce incomplete curated pages.

This PRD adds a first-class PDF extraction stage before curated ingest:

```text
PDF capture -> parser profile -> extracted text artifact -> validated ingest -> curated Markdown
```

The extraction stage must be configurable, but this PRD scopes parsing to the opt-in `doc-parser` API adapter only. The system stores extracted text and extraction metadata as derived raw artifacts while preserving the immutable PDF original.

Default behavior remains private and explicit. API parsing is never automatic unless explicitly configured and selected.

---

## 2. Problem

Current ingest instructions allow agents to read "original or extracted content," but the product does not require a PDF extraction artifact before ingest. This creates several failure modes:

1. Auto-ingest can mark a PDF source as ingested even when extraction was incomplete.
2. The LLM may receive partial compressed PDF text streams instead of a clean document.
3. Table-heavy PDFs, stat blocks, multi-column layouts, scanned PDFs, and image-heavy PDFs lose important values.
4. Review pages do not clearly separate queue status from extraction quality.
5. Users cannot choose a better parser per source without manual side work.
6. The `doc-parser` API cannot be safely integrated because `llm-wiki` currently lacks a parser profile contract, credential policy, asynchronous polling model, and artifact normalization path for parsed chunks.

The result is a misleading status model: `ingested` can mean "curated pages were written," not "the PDF was fully extracted."

---

## 3. Goals

1. Convert PDF uploads into durable, inspectable text artifacts before curated ingest.
2. Add user-configurable PDF parser profiles.
3. Support `doc-parser` API parser profiles through a common parser profile interface.
4. Store extracted text, warnings, and metadata as derived artifacts without modifying `original.pdf`.
5. Make extraction status visible in CLI output, queue state, source cards, upload responses, review pages, and logs.
6. Block or clearly flag auto-ingest when required extraction fails or is partial.
7. Preserve private-by-default raw source handling and public build leak protection.
8. Keep API parsing opt-in, auditable, and secret-safe.

---

## 4. Non-Goals

- Do not mutate raw PDF originals after capture.
- Do not make hosted/API parsing the default.
- Do not store API credentials in committed repo files.
- Do not guarantee perfect extraction for every PDF.
- Do not infer missing source facts from layout gaps or parser uncertainty.
- Do not publish raw PDFs, private extracted text, API request logs, or parser metadata in public profiles.
- Do not require PDF extraction for non-PDF sources.
- Do not add alternate parser engines in this feature.

---

## 5. Users

### 5.1 Research maintainer

Needs inspectable text artifacts with page boundaries, warnings, parser metadata, and enough provenance to review what the LLM saw.

### 5.2 Auto-ingest user

Wants browser uploads and queue workers to avoid "successful" ingests when the underlying PDF extraction failed.

### 5.3 Power user

Wants to configure the `doc-parser` API for difficult PDFs, table-heavy content, scanned documents, or higher-quality Docling-backed chunk extraction.

---

## 6. User Stories

### 6.1 `doc-parser` extraction before ingest

As a maintainer, when I upload a PDF and run:

```bash
llm-wiki ingest <source_id> --auto
```

I want `llm-wiki` to create a text artifact first and pass that artifact to the ingest agent.

### 6.2 Select a `doc-parser` parser profile

As a maintainer, I want to run:

```bash
llm-wiki extract pdf <source_id> --profile doc-parser-api
```

so I can choose a configured `doc-parser` API profile for PDFs with tables, columns, stat blocks, or scanned content.

### 6.3 Use an API parser explicitly

As a power user, I want to configure a `doc-parser` API profile with environment-based credentials and then run:

```bash
llm-wiki extract pdf <source_id> --profile doc-parser-api
```

so hard PDFs can be parsed by the configured `doc-parser` FastAPI service only when I explicitly choose that path.

### 6.4 Review extraction quality

As a reviewer, I want upload results, source badges, and review pages to show extraction status, parser profile, artifact path, and warnings before I trust the curated output.

---

## 7. Current State

Implemented adjacent behavior:

- File uploads create immutable raw originals under `raw/inputs/.../original.*`.
- Source cards record source metadata and visibility.
- Queue JSON tracks source state.
- `llm-wiki ingest <source_id> --auto` runs the configured local agent.
- Auto-ingest can run from local upload or queue processing.
- Review UI work expects browser upload results and source/queue dashboards.

Missing PDF-specific behavior:

- No required PDF extraction step before ingest.
- No extracted text artifact contract.
- No parser profile configuration.
- No `doc-parser` API adapter contract.
- No extraction quality status separate from queue status.
- No explicit public-profile exclusion rules for extracted PDF artifacts.

---

## 8. Proposed Data Model

### 8.1 Raw source folder layout

For PDF sources, derived extraction artifacts should live next to the immutable original:

```text
raw/inputs/<yyyy>/<mm>/<source_id>/
  _source.md
  original.pdf
  extracted/
    pdf/
      <extraction_id>/
        document.md
        metadata.json
        warnings.md
        pages/
          page-0001.md
          page-0002.md
        tables/
          table-0001.csv
```

Only `original.pdf` is immutable. Extraction runs are derived artifacts. Re-extraction creates a new run directory rather than rewriting old extraction output.

### 8.2 Canonical artifact

`document.md` is the canonical text artifact passed to the ingest agent.

Optional artifacts:

- `pages/page-NNNN.md` for page-level review.
- `tables/table-NNNN.csv` for extracted tabular data.
- `warnings.md` for human-readable extraction limitations.
- `metadata.json` for machine-readable parser metadata.

### 8.3 Extraction metadata

`metadata.json` must include:

```json
{
  "source_id": "src_...",
  "original_path": "raw/inputs/.../original.pdf",
  "original_hash": "sha256:...",
  "extraction_id": "pdfext_...",
  "profile": "doc-parser-api",
  "provider_type": "api",
  "engine": "doc-parser",
  "engine_version": "optional",
  "doc_parser_document_id": "doc-...",
  "doc_parser_status": "succeeded",
  "doc_parser_base_url_origin": "https://parser.example.com",
  "output_format": "markdown",
  "started_at": "2026-07-02T00:00:00.000Z",
  "finished_at": "2026-07-02T00:00:01.000Z",
  "page_count": 120,
  "extracted_page_count": 120,
  "quality_status": "extracted",
  "warnings": [],
  "artifact_path": "raw/inputs/.../extracted/pdf/pdfext_.../document.md"
}
```

For `doc-parser` API runs, metadata should also include non-secret request state such as `doc_parser_document_id`, `doc_parser_status`, `doc_parser_base_url_origin`, polling counts, and whether results came through the direct FastAPI API or the web BFF route.

Secrets, API keys, full request headers, signed URLs, and raw provider debug payloads must not be stored in repo files.

### 8.4 Source card fields

PDF source cards should include an extraction summary:

```yaml
pdf_extraction:
  status: extracted
  selected_extraction_id: pdfext_2026_07_02_doc_parser_001
  selected_artifact: raw/inputs/.../extracted/pdf/pdfext_.../document.md
  profile: doc-parser-api
  provider_type: api
  quality_status: extracted
  warning_count: 0
  updated_at: 2026-07-02T00:00:01.000Z
```

### 8.5 Queue fields

Queue JSON should mirror enough extraction state for queue workers and review dashboards:

```json
{
  "pdf_extraction": {
    "required": true,
    "status": "pending",
    "profile": "doc-parser-api",
    "selected_artifact": null,
    "quality_status": null,
    "last_error_code": null,
    "last_error_message": null
  }
}
```

---

## 9. Parser Profiles

Parser profiles are named configurations in `.llm-wiki/config.yml`.

Example:

```yaml
pdf_ingestion:
  enabled: true
  require_text_artifact_before_ingest: true
  default_profile: doc-parser-api
  partial_extraction_policy: block-auto-ingest
  profiles:
    doc-parser-api:
      type: api
      adapter: doc-parser
      base_url_env: DOC_PARSER_API_BASE_URL
      api_key_env: DOC_PARSER_API_KEY
      submit_path: /documents
      status_path_template: /documents/{document_id}
      output_format: markdown
      timeout_seconds: 180
      poll_interval_ms: 1000
      max_poll_seconds: 180
      max_file_mb: 50
      chunker_preset: default
      chunker_options: {}
      retain_remote_copy: true
```

Profile resolution order:

1. Explicit command flag: `--pdf-profile <name>`.
2. Source card override.
3. Upload request override, if the local daemon allows it.
4. Repository default profile.
5. Built-in `doc-parser-api` profile name, which remains unusable until required environment variables are configured.

---

## 10. Parser Provider Type

### 10.1 `doc-parser` API parser profile

The initial API parser profile targets `ufJmacca/doc-parser`, a Docling-backed FastAPI service. It is an asynchronous document workflow, not a synchronous `/parse` endpoint.

Requirements:

- Must be opt-in.
- Must use endpoint and credential environment variables or a local secret store.
- Must not commit secrets.
- Must disclose API usage in CLI output and browser upload UI.
- Must record provider/profile metadata without sensitive request details.
- Must normalize `doc-parser` document metadata and chunks into the same artifact model.
- Must support timeout, size limit, retryability, and clear failure state.

Direct FastAPI workflow:

1. Submit the PDF with `POST {DOC_PARSER_API_BASE_URL}/documents`.
2. Authenticate with `X-Api-Key: {DOC_PARSER_API_KEY}`.
3. Send `multipart/form-data`:
   - `file`: PDF binary.
   - optional `chunker_preset`: Docling chunker preset, for example `default`.
   - optional `chunker_options`: JSON object string for Docling chunker options.
4. Expect HTTP `202 Accepted` with `document_id`, `status`, optional `message`, and optional `chunking_config`.
5. Poll `GET {DOC_PARSER_API_BASE_URL}/documents/{document_id}` with the same `X-Api-Key`.
6. Treat `status: succeeded` as parse completion and read `document`, `status`, and `chunks`.
7. Treat `status: failed` as extraction failure and persist sanitized `document.failure_reason`.
8. Treat timeout before terminal status as `PDF_API_TIMEOUT`.

`doc-parser` request model:

```json
{
  "method": "POST",
  "path": "/documents",
  "headers": {
    "X-Api-Key": "<redacted>",
    "X-Correlation-Id": "optional-source-or-extraction-correlation-id"
  },
  "multipart": {
    "file": "original.pdf",
    "chunker_preset": "default",
    "chunker_options": "{}"
  }
}
```

`doc-parser` submit response model:

```json
{
  "document_id": "doc-...",
  "status": "queued",
  "message": "Document accepted for parsing",
  "chunking_config": {
    "preset": "default",
    "options": {}
  }
}
```

`doc-parser` completion response model:

```json
{
  "document": {
    "document_id": "doc-...",
    "tenant_id": "tenant-...",
    "filename": "original.pdf",
    "content_type": "application/pdf",
    "size_bytes": 12345,
    "page_count": 12,
    "status": "succeeded",
    "failure_reason": null,
    "chunking_config": {
      "preset": "default",
      "options": {}
    }
  },
  "status": "succeeded",
  "chunks": [
    {
      "id": "chunk-...",
      "sequence_index": 0,
      "text": "Extracted text...",
      "page_number": 1,
      "source_region": null,
      "char_start": null,
      "char_end": null,
      "bounding_boxes": []
    }
  ]
}
```

Normalization rules:

- Sort chunks by `sequence_index`.
- Build `document.md` from chunk text in reading order.
- Preserve page boundaries by writing page-level artifacts grouped by `page_number`.
- Preserve chunk metadata in `metadata.json`, including `document_id`, `page_count`, `chunking_config`, and bounding boxes when present.
- Treat empty chunks on `succeeded` as `PDF_TEXT_TOO_SPARSE`.
- Store only sanitized failure reasons and provider metadata.

The web console BFF also exposes `/api/documents/{tenantId}` and `/api/documents/{tenantId}/{documentId}`. `llm-wiki` should prefer the direct FastAPI API for service-to-service extraction. BFF integration is optional and only appropriate when the deployment requires NextAuth tenant access checks rather than direct API key authentication.

---

## 11. Commands

### 11.1 Extract a PDF

Add:

```bash
llm-wiki extract pdf <source_id>
llm-wiki extract pdf <source_id> --profile doc-parser-api
llm-wiki extract pdf <source_id> --force
```

Behavior:

- Validate the source exists.
- Validate the source original is a PDF.
- Resolve the parser profile.
- Check `doc-parser` API credential readiness.
- For `doc-parser` profiles, submit to `POST /documents`, poll `GET /documents/{document_id}`, and normalize chunks into `document.md`.
- Create a new extraction run directory.
- Write `document.md`, `metadata.json`, and optional artifacts.
- Update source card extraction metadata.
- Update queue extraction metadata.
- Append a log entry.
- Print the selected artifact path.

### 11.2 Ingest integration

Extend:

```bash
llm-wiki ingest <source_id>
llm-wiki ingest <source_id> --auto
llm-wiki ingest <source_id> --pdf-profile doc-parser-api
llm-wiki ingest <source_id> --allow-partial-pdf-extraction
```

Behavior:

- If source is not PDF, current behavior is unchanged.
- If source is PDF and extraction is required, verify a valid selected artifact exists.
- If no valid artifact exists, run extraction before invoking the ingest agent.
- If extraction fails, mark source `blocked` and do not write curated pages.
- If extraction is partial, follow `partial_extraction_policy`.
- Pass the text artifact path and extraction warnings into the ingest prompt.
- Require curated source summaries to disclose extraction limitations when warnings exist.

### 11.3 Queue integration

Extend:

```bash
llm-wiki queue ingest --auto
llm-wiki queue ingest --auto --source-id <source_id> --pdf-profile doc-parser-api
```

Behavior:

- Treat required PDF extraction as an eligibility gate.
- A queued PDF is eligible when extraction can run or an accepted artifact exists.
- API configuration failures and quality gate failures mark the source `blocked`.
- Queue output must show extraction failure separately from agent failure.

---

## 12. Browser Upload and Review UI

The local Quartz upload result should show PDF extraction details when the uploaded source is a PDF:

- extraction status
- selected parser profile
- selected artifact path
- warning count
- next extraction command
- next ingest command
- manual retry guidance

Review dashboards should group PDF sources by:

- pending extraction
- running extraction
- extracted
- partial
- failed
- ingested with partial evidence

If an API parser profile is available in the browser UI, the UI must clearly disclose that the PDF will be sent to the configured parser service. Browser selection of API profiles should be disabled by default unless a local/admin configuration explicitly enables it.

---

## 13. Extraction Quality Status

Extraction quality is separate from source queue status.

Allowed statuses:

- `not_required`: source is not a PDF or PDF extraction is disabled.
- `pending`: PDF extraction has not run.
- `running`: extraction is in progress.
- `extracted`: artifact passed minimum checks.
- `partial`: artifact exists but warnings require review.
- `failed`: extraction failed.
- `accepted_partial`: human explicitly allowed partial ingest.

Minimum quality checks:

1. Artifact exists.
2. Artifact is readable.
3. Artifact is non-empty.
4. Metadata original hash matches the current original hash.
5. Parser profile is recorded.
6. Page count and extracted page count are recorded when available.
7. Blank-page ratio does not exceed configured threshold when page count is known.
8. Warnings are preserved.

The ingest agent must not fill missing numeric fields, table values, citations, or structured facts unless they are present in extracted text or explicitly supplied by human review.

---

## 14. Error Handling

Errors must be structured and actionable.

Common error codes:

- `PDF_EXTRACTION_REQUIRED`: ingest attempted without an accepted artifact.
- `PDF_API_NOT_CONFIGURED`: endpoint or credential env var is missing.
- `PDF_API_FAILED`: remote parser failed.
- `PDF_API_TIMEOUT`: remote parser exceeded timeout.
- `PDF_API_FILE_TOO_LARGE`: file exceeds profile limit.
- `PDF_API_DOCUMENT_FAILED`: `doc-parser` returned terminal `failed` status.
- `PDF_API_EMPTY_CHUNKS`: `doc-parser` returned `succeeded` without usable chunks.
- `PDF_ENCRYPTED`: PDF requires a password.
- `PDF_TEXT_TOO_SPARSE`: extracted text is below threshold.
- `PDF_ARTIFACT_STALE`: artifact hash does not match current original.
- `PDF_UNSUPPORTED_PROFILE`: requested parser profile is missing or disabled.

Each error should include:

- source ID
- parser profile
- error code
- short message
- retryability flag
- suggested command when possible

---

## 15. Security and Privacy

1. `doc-parser` API extraction is opt-in and is the only parser path in this PRD.
2. API credentials must come from environment variables or local secret storage.
3. API credentials must never be written to source cards, queue JSON, logs, metadata artifacts, or public static output.
4. Private extracted artifacts inherit the source visibility.
5. Public profiles must exclude:
   - raw originals
   - extracted PDF artifacts
   - source cards for private sources
   - queue state
   - review pages
   - daemon runtime metadata
   - API parser runtime metadata
   - API request/response debug logs
6. Logs may record parser profile and provider type, but not secrets or raw external request payloads.

---

## 16. Validation and Linting

Add lint checks for:

- PDF source has extraction state when extraction is enabled.
- Selected artifact exists when status is `extracted` or `accepted_partial`.
- Selected artifact metadata hash matches source original hash.
- Private extraction artifacts are excluded from public profiles.
- Curated pages generated from partial PDF extraction include `review_status: needs-human-review` or equivalent review metadata.
- Source cards and queue JSON do not contain API credentials.

---

## 17. Acceptance Criteria

1. A PDF upload can produce `extracted/pdf/<extraction_id>/document.md`.
2. `llm-wiki extract pdf <source_id> --profile doc-parser-api` creates a new extraction run.
3. `llm-wiki ingest <source_id> --auto` blocks a PDF when required extraction fails.
4. Users can configure the `doc-parser` API parser profile without committing secrets.
5. The `doc-parser` profile submits PDFs to `POST /documents`, polls `GET /documents/{document_id}`, and converts returned chunks into `document.md`.
6. Queue JSON and source cards record extraction status and selected artifact path.
7. Upload responses and review dashboards expose extraction status.
8. Partial extraction is visible and does not silently become complete evidence.
9. Public profile builds exclude raw PDFs, extracted PDF artifacts, API metadata, and private review data.
10. Re-extraction never modifies `original.pdf`.

---

## 18. Rollout Plan

### Phase 1: `doc-parser` API extraction

- Add PDF parser profile config.
- Add `llm-wiki extract pdf <source_id>`.
- Add env-var credential resolution.
- Submit PDFs to `POST /documents`, poll `GET /documents/{document_id}`, and normalize returned chunks into `document.md`.
- Store `document.md` and `metadata.json`.
- Gate PDF auto-ingest on extraction success.

### Phase 2: Quality gates

- Add sparse-text checks.
- Add `partial` and `accepted_partial`.
- Add review UI status grouping.

### Phase 3: Hardening

- Add timeout and file-size handling.
- Add retries, terminal-failure handling, and empty-chunk handling.

### Phase 4: Browser controls

- Show extraction status in upload result UI.
- Add parser profile visibility.
- Add retry guidance.
- Optionally allow admin-approved parser profile selection from browser upload.

---

## 19. Open Questions

1. Should partial extraction block all auto-ingest by default, or only sources without human-approved override?
2. Should there be a stable pointer file such as `extracted.md`, or should source cards always point to immutable extraction run directories?
3. Should browser uploads be allowed to select API parser profiles, or should API profiles be CLI/admin-only?
4. What quality threshold should turn a `doc-parser` success response into `partial` or `failed`?
5. Should page images be retained for review, or should extraction artifacts remain text/table-only?
6. How should password-protected PDFs be handled without storing passwords?
7. Should additional API parser providers be out of scope permanently or handled by a later PRD?

---

## 20. Implementation Notes for `ainative`

- Keep the implementation centered on a parser profile interface, not on a specific provider.
- Treat `doc-parser` parser profiles as adapters that produce the same artifact contract.
- Add tests around queue eligibility, API config failures, stale artifacts, and partial extraction policy.
- Add `doc-parser` adapter tests for successful submit/poll, terminal failure, timeout, empty chunks, missing `X-Api-Key`, and chunk normalization.
- Preserve the existing raw immutability rule.
- Implement the `doc-parser` adapter as the first API adapter, while keeping the adapter interface provider-neutral.
- Make extraction state explicit enough that review UI and CLI output do not conflate extraction success with ingest success.
