# Product Requirements Document: LLM Wiki Standalone Codex PDF Ingestion Experiment

**Product name:** `llm-wiki`
**Implementation target:** Codex directly on the current working branch
**Document status:** Draft implementation PRD
**Created:** 2026-07-02
**Updated:** 2026-07-11
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-codex-native-ingest-automation-prd.md`, `./prds/llm-wiki-auto-ingest-prd.md`, `./prds/llm-wiki-quartz-upload-review-ui-prd.md`
**Required plugin:** `pdf@openai-primary-runtime`
**Purpose:** Define a bounded experiment in which Codex implements and runs a safe PDF extraction stage before curated ingest, producing a validated Markdown artifact without changing the repository's other agent-management workflows.

---

## 1. Executive Summary

`llm-wiki` already captures uploaded files as immutable raw originals and can run local agents to curate Markdown. A PDF original, however, is a binary input and is currently exposed to ingest as a path-only source. Curated ingest must not claim complete evidence until a dedicated extraction step has produced a valid, reviewable Markdown artifact.

This PRD adds a first-class PDF extraction path that uses the installed and enabled `pdf@openai-primary-runtime` Codex plugin:

```text
immutable PDF capture
  -> Codex/plugin readiness preflight
  -> isolated extraction workspace
  -> one validated document.md proposal
  -> CLI-owned metadata.json
  -> validated curated ingest
```

Codex runs against a temporary workspace. The only permitted agent-authored change is the selected extraction run's `document.md`. The CLI rejects every other mutation, verifies that the PDF hash did not change, validates the Markdown, creates metadata itself, and applies the artifact and mirrored extraction state transactionally. No external parser fallback is included.

The work is divided into five independently tested phases. Every phase must demonstrate Red, Green, and Refactor, pass the repository gates, and end in exactly one passing commit.

---

## 2. Experiment Directive and Boundary

Codex will implement this PRD directly on the current working branch. For these five phases, Codex must not invoke `ainative` to plan, split, execute, review, or commit the work.

This experiment does not authorize deleting or rewriting `ainative.yaml`, existing `ainative` commands, artifacts, PRDs, workflows, documentation, or integration points. They remain supported and behaviorally unchanged. The only PRD being redirected to direct Codex implementation is this PDF ingestion PRD.

This is not a general Codex-versus-`ainative` migration. The implementation must preserve a clean path for this feature to be managed through `ainative` later. In particular:

- Shared production code must remain agent-neutral where it represents configuration parsing, proposal application, state synchronization, artifact validation, ingest orchestration, or privacy enforcement.
- Experiment-specific Codex coupling is limited to the `pdf_ingestion` configuration, Codex executable and plugin preflight, PDF extraction task construction and execution, and supporting documentation.
- Existing local-agent and HTTP-provider behavior outside the PDF gate must remain unchanged.
- No existing `ainative` file or workflow may be edited merely to acknowledge this experiment.
- The final implementation report must identify assumptions that need to be formalized before responsibility for this feature returns to `ainative`.

---

## 3. Problem

Captured PDF sources have an immutable `original.pdf`, but the ingest task currently treats that binary as path-only context. This creates several risks:

1. An automated ingest can create curated pages without proving that the complete PDF was available as evidence.
2. Manual or provider workflows can bypass extraction because there is no required canonical artifact.
3. There is no durable record of which plugin, model selection, reasoning effort, or PDF detail produced the text used for curation.
4. Extraction failure is not distinct from the existing queue lifecycle.
5. Review and status surfaces cannot identify missing, stale, or inconsistent PDF artifacts.
6. A broadly writable agent workspace could modify the PDF, queue state, source cards, or curated files unless the extraction proposal boundary is narrower than the normal ingest boundary.
7. Public builds need explicit tests proving that PDFs and their derived private artifacts cannot leak.

The result is an evidence-integrity gap: `ingested` can mean that curated files were written, not that a complete, validated PDF extraction was available to the curator.

---

## 4. Goals

1. Produce a durable Markdown artifact before a PDF is used for curated ingest.
2. Use only `pdf@openai-primary-runtime` for this experimental extraction path.
3. Preflight the configured Codex executable and required plugin before any extraction-related repository mutation.
4. Run Codex in a temporary workspace with an allowlist containing exactly one agent-writable path.
5. Preserve the byte-for-byte PDF original and reject every out-of-policy workspace mutation.
6. Store CLI-generated provenance sufficient to validate and reuse extraction runs safely.
7. Mirror PDF extraction state in the source card and queue record without changing the existing queue lifecycle.
8. Integrate extraction and reuse into automated local Codex ingest, queue batch processing, queue single-source processing, queue watch processing, and upload-triggered automated Codex ingest.
9. Prevent manual and HTTP-provider ingest from bypassing the artifact requirement.
10. Surface readiness, progress, failures, stale artifacts, and retry guidance in CLI and local review surfaces.
11. Keep PDFs, extraction artifacts, metadata, queue state, and private review data out of public profiles and static output.
12. Deliver the implementation through five observable Red-Green-Refactor phases with one green commit per phase.

---

## 5. Non-Goals

- Do not add an external or hosted parser service.
- Do not add a fallback extractor when the required Codex plugin is unavailable or fails.
- Do not install, enable, update, or authenticate Codex or its plugins automatically.
- Do not change extraction requirements for non-PDF sources.
- Do not modify an existing successful extraction run in place.
- Do not define re-extraction/re-curation for an already `ingested` source; the current queue lifecycle has no `ingested -> queued` transition, so that workflow requires a later PRD.
- Do not let Codex generate authoritative `metadata.json`, source-card state, or queue state.
- Do not introduce `blocked` as a PDF extraction status; it remains an ingest queue status only.
- Do not add partial-extraction or human-accepted-partial states in this experiment.
- Do not publish or synchronize raw PDF content merely to make it reviewable.
- Do not redesign generic local-agent execution or HTTP-provider proposal mode.
- Do not change, remove, or migrate unrelated `ainative`-managed work.

---

## 6. Users and Core Stories

### 6.1 Explicit extraction

As a maintainer, I can run:

```bash
llm-wiki extract pdf <source_id>
```

and receive either a validated immutable extraction run or an actionable failure without changing the queue lifecycle.

### 6.2 Controlled extraction settings

As a maintainer, I can override the model selection, reasoning effort, and PDF detail for one run:

```bash
llm-wiki extract pdf <source_id> \
  --pdf-model <model> \
  --pdf-reasoning-effort <effort> \
  --pdf-detail high \
  --force
```

The invocation uses argument arrays, not shell interpolation, and never silently falls back to different settings.

### 6.3 Automated Codex ingest

As a user whose selected ingest agent is the configured PDF Codex agent, I can run:

```bash
llm-wiki ingest <source_id> --auto
```

and `llm-wiki` will reuse a matching extraction or create one before it gives the validated artifact to curated ingest.

### 6.4 Manual and provider safety

As a cautious user, if I request a manual task, manual validation, or an HTTP provider for a PDF without a valid artifact, the command fails before mutation and tells me to run:

```bash
llm-wiki extract pdf <source_id>
```

### 6.5 Review and retry

As a reviewer, I can distinguish queue status from PDF extraction status, inspect non-content provenance, see stale or inconsistent artifact warnings, and copy an exact retry command without exposing private PDF content publicly.

---

## 7. Existing Repository Contracts

This feature extends, and must not weaken, these existing contracts:

- Repository configuration lives in `.llm-wiki/config.yml`; `ainative.yaml` is not repository runtime configuration for this feature.
- Raw originals live under `raw/inputs/<yyyy>/<mm>/<source_id>/original.*` and are immutable.
- PDF sources retain `source_kind: file`; PDF eligibility is not a new source kind.
- Queue records live at `raw/queue/<source_id>.json` and source cards at `raw/inputs/<yyyy>/<mm>/<source_id>/_source.md`.
- The queue lifecycle remains exactly `queued | ingesting | ingested | blocked`.
- Valid queue transitions remain `queued -> ingesting`, `ingesting -> ingested | blocked`, and `blocked -> queued`.
- Local automated ingest uses the repository ingest lock and marks a source `ingested` only after curated proposals pass validation and apply successfully.
- Manual local-agent mode, automated local-agent mode, and explicit HTTP-provider mode remain separate execution modes.
- `--repo`, `--json`, and `--quiet` retain their shared runtime-command semantics.
- Curated Markdown remains the human-reviewable output; raw artifacts are evidence, not public wiki pages.
- Public builds fail closed when raw or private data is selected or copied into static output.

The implementation should extend the existing agent workspace and proposal abstractions rather than duplicate them, but PDF extraction requires its own exact-one-path proposal policy.

---

## 8. Repository Configuration

Add `pdf_ingestion` to `.llm-wiki/config.yml`:

```yaml
pdf_ingestion:
  codex_agent: codex
  required_plugin: pdf@openai-primary-runtime
  # model: optional-model-name
  reasoning_effort: high
  pdf_detail: high
  timeout_seconds: 900
  require_artifact_before_ingest: true
```

### 8.1 Field contract

| Field | Type | Default or inheritance | Requirement |
| --- | --- | --- | --- |
| `codex_agent` | non-empty string | `codex` | References `agents.<name>` in the same config. It is not `agent.default` and is not a raw executable string. The referenced agent must be `type: local-exec` and use the Codex executable. |
| `required_plugin` | non-empty string | `pdf@openai-primary-runtime` | This is the only supported plugin for the experiment. A different value is a configuration error, not a provider selection mechanism. |
| `model` | optional non-empty string | omitted; inherit the active Codex model | When omitted, do not pass `--model`. Do not invent a fallback model. |
| `reasoning_effort` | non-empty string | `high` | Pass through to Codex. Do not maintain a model-support allowlist because supported values vary by model and Codex version. |
| `pdf_detail` | `auto | low | high` | `high` | Convey through the PDF plugin task, not as an invented Codex CLI flag. |
| `timeout_seconds` | positive integer | `900` | Applies to the extraction Codex process, including graceful termination behavior. It is not part of artifact reuse identity. |
| `require_artifact_before_ingest` | boolean | `true` | Must remain `true` for this experiment. `false` is reported as unsupported rather than permitting a bypass. |

The `pdf_ingestion` mapping may be absent in an older repository. Effective values then use the documented defaults, but extraction readiness still requires a valid referenced `agents.codex` entry and installed plugin. New Codex scaffolds must write the explicit block so the behavior is discoverable.

### 8.2 Agent reference and invocation compatibility

`pdf_ingestion.codex_agent` resolves through the existing local-agent configuration loader. Its configured argument array must contain exactly one `exec` subcommand token. Tokens before `exec` are the configured Codex global prefix; tokens after it are the configured `exec` suffix. A positional prompt, stdin marker, second subcommand, or ambiguous argument shape is invalid for the PDF runner, which supplies its task through one final `-` stdin marker.

Plugin preflight retains the safe configured global prefix, replaces `exec` and its suffix with `plugin list --json`, and invokes the resolved executable directly. Extraction retains both the prefix and suffix, inserts PDF-managed global flags immediately before `exec`, and appends the stdin marker exactly once. This makes argv construction deterministic for tests and ensures that a configured Codex profile affects both plugin discovery and extraction.

Any configured prefix or suffix that already sets `-m`, `--model`, `--model=...`, or a `-c`/`--config` value for `model_reasoning_effort` conflicts with PDF-managed settings and must fail with an actionable configuration error. The implementation must parse these flag forms rather than rely on substring matching, and it must not append duplicate flags and let argument order decide silently.

### 8.3 Configuration compatibility

- Existing repositories remain usable for non-PDF work when `pdf_ingestion` is absent or not ready.
- Existing generic local agents and HTTP providers are not rewritten.
- PDF readiness errors appear in `status` without making the entire status command unusable.
- Commands that actually need a new PDF extraction fail non-zero when PDF configuration or readiness is invalid.
- No credential, token, or authentication material is added to repository configuration.

---

## 9. CLI and Setting Resolution

### 9.1 Extraction command

Register a new command family:

```bash
llm-wiki extract pdf <source_id>
llm-wiki extract pdf <source_id> --pdf-model <model>
llm-wiki extract pdf <source_id> --pdf-reasoning-effort <effort>
llm-wiki extract pdf <source_id> --pdf-detail <auto|low|high>
llm-wiki extract pdf <source_id> --force
```

It also supports the shared `--repo`, `--json`, and `--quiet` options.

The command must:

1. Resolve the repository and validate the source ID.
2. Load the queue record, source card, and original path without mutating them.
3. Confirm that `source_kind` is `file`, the safe normalized original path ends in `.pdf` case-insensitively, and the file begins with a valid PDF signature.
4. Confirm that the queue lifecycle is `queued`. A `blocked` source must first be returned with `llm-wiki queue set-status <source_id> queued`; explicit re-extraction of `ingesting` or `ingested` sources is out of scope.
5. Resolve and validate settings.
6. Complete Codex/plugin preflight and capture the operation's plugin/model comparison descriptors without creating a lock or changing repository files.
7. Acquire the repository ingest lock, then re-read and revalidate the config/agent fingerprint, source, original hash, state, and candidate runs. If the config/agent input changed, release the lock and repeat read-only preflight before proceeding.
8. Check for a reusable artifact against the captured operation descriptors unless `--force` is present.
9. Execute the isolated extraction when no reusable run exists and return `extracted`, `reused`, or a structured failure.

### 9.2 Overrides on automated ingest

Add the same four PDF controls to automated local-agent ingest:

```bash
llm-wiki ingest <source_id> --agent codex \
  [--pdf-model <model>] \
  [--pdf-reasoning-effort <effort>] \
  [--pdf-detail <auto|low|high>] \
  [--force]

llm-wiki ingest <source_id> --auto \
  [--pdf-model <model>] \
  [--pdf-reasoning-effort <effort>] \
  [--pdf-detail <auto|low|high>] \
  [--force]
```

Automatic extraction is available only when the selected local ingest agent is the agent referenced by `pdf_ingestion.codex_agent`. If another local agent is selected, the PDF artifact gate still applies, but that agent cannot implicitly start this Codex experiment; the error points to the explicit extraction command.

PDF overrides are invalid with prompt-only manual ingest, `--validate`, `--provider`, another local agent, or a direct non-PDF ingest, because those modes never start this extraction path. A valid pre-existing artifact can still be used by manual, validation, provider, or other-agent modes without overrides. Mixed queue batches accept PDF controls and apply them only to PDF items; non-PDF result data reports the controls as not applicable rather than silently treating them as extraction settings.

### 9.3 Overrides on queue processing

Forward the same controls through single-source, batch, and watch processing:

```bash
llm-wiki queue ingest --auto --source-id <source_id> [PDF controls]
llm-wiki queue ingest --auto [--limit <n>] [PDF controls]
llm-wiki queue ingest --auto --watch [PDF controls]
```

For a batch, the resolved settings apply independently to each selected PDF. In watch mode, they apply once to each newly selected queue item. `--force` forces one new extraction for each PDF that the invocation attempts; it must not cause already completed queue items to be selected again.

Upload-triggered auto-ingest uses repository PDF settings. Per-upload or browser-controlled model, effort, detail, and force overrides are out of scope for this experiment.

### 9.4 Resolution order

Resolve each effective setting in this order:

1. Command-line override, when that setting has a flag.
2. `.llm-wiki/config.yml:pdf_ingestion`.
3. The documented default or inheritance behavior.

| Effective setting | CLI | Repository config | Default/inheritance |
| --- | --- | --- | --- |
| model selection | `--pdf-model` | `model` | omit `--model`; inherit active Codex model |
| reasoning effort | `--pdf-reasoning-effort` | `reasoning_effort` | `high` |
| PDF detail | `--pdf-detail` | `pdf_detail` | `high` |
| force new run | `--force` | none | `false` |
| Codex agent | none | `codex_agent` | `codex` |
| plugin | none | `required_plugin` | `pdf@openai-primary-runtime` |
| timeout | none | `timeout_seconds` | `900` |
| artifact gate | none | `require_artifact_before_ingest` | `true` |

Reject empty model values, empty or whitespace-only reasoning effort, invalid PDF detail, unsafe source identifiers, conflicting modes, and PDF flags on modes that cannot extract before starting a process or mutating the repository.

---

## 10. Codex Invocation Contract

### 10.1 Shell-free argument construction

Use `spawn` or the existing equivalent with `shell: false`. The task is sent over standard input. User-controlled model names, effort strings, paths, and source metadata must never be concatenated into a shell command.

For an explicit model, the semantic invocation is:

```text
codex --model <model> -c model_reasoning_effort=<TOML string> exec -
```

For an inherited model, omit both `--model` and its value:

```text
codex -c model_reasoning_effort=<TOML string> exec -
```

The final array is exactly: resolved command; safe configured global prefix; optional `--model` pair; one `-c` reasoning pair; `exec`; safe configured exec suffix; and one final `-`. Approval and sandbox options already owned by the generic runner remain in its documented global-prefix position and must not be duplicated.

The reasoning value is serialized as a real TOML string in one argv item after `-c`. For example, `high` becomes the semantic value:

```text
model_reasoning_effort="high"
```

The serializer must escape quotes, backslashes, and control characters correctly. Displayed shell examples are documentation only and must not be used to construct the process.

### 10.2 No fallback

Codex is the authority on model and reasoning-effort compatibility. If Codex rejects a model, effort, authentication state, plugin call, or combination:

- preserve the exit code and a sanitized stderr tail in the structured error;
- do not retry with a different model or effort;
- do not omit the requested option and try again;
- do not call another parser;
- follow the explicit-versus-automated failure transitions in this PRD.

### 10.3 PDF plugin task

The task passed to Codex must identify:

- the exact required plugin, `pdf@openai-primary-runtime`;
- the one selected PDF input path;
- the resolved `pdf_detail` value;
- the exact permitted `document.md` output path;
- the requirement to preserve complete document content and represent it as Markdown without inventing missing facts;
- the prohibition on writing metadata or changing any other file.

`pdf_detail` is expressed in this task as a plugin input. It is not passed as a generic Codex flag.

---

## 11. Readiness and Plugin Preflight

### 11.1 Executable readiness

Resolve `pdf_ingestion.codex_agent` through `agents.<name>`, then use the existing executable lookup rules. A missing agent entry, unsupported agent type, missing executable, unsafe command configuration, or incompatible PDF-managed flags is not ready.

### 11.2 Plugin readiness command

Before `extract pdf` or an automated Codex artifact-ensure operation can select, reuse, or create an artifact, run the resolved executable with an argument array equivalent to:

```text
codex plugin list --json
```

This is a dedicated read-only preflight, not an `exec` agent task. Parse standard output as JSON and normalize the installed plugin records into:

```json
{
  "id": "pdf@openai-primary-runtime",
  "installed": true,
  "enabled": true,
  "version": "reported-version-or-null"
}
```

The parser must use the documented JSON fields for the supported Codex release. It must not grep stdout, accept a substring match, or infer enabled state from plugin presence. Invalid JSON, an unexpected top-level shape, malformed plugin records, duplicate canonical identifiers, or a missing enabled field is malformed output.

The required plugin must match its canonical identifier exactly and be both installed and enabled. A reported version is stored in extraction metadata. The CLI derives `plugin_descriptor` in the canonical form `<plugin-id>#version:<reported-version>`; when no stable version is reported, the descriptor is `null`. Extraction and immediate ingest may proceed with a null descriptor, but that run is not eligible for future automatic reuse.

The plugin-list process has a fixed 15-second timeout, separate from `pdf_ingestion.timeout_seconds`. `status` may run this dedicated read-only preflight on each invocation, but it must never run `codex exec` or an extraction task. Missing optional PDF readiness is reported as `ready: false` with an actionable readiness issue and does not make unrelated non-PDF repository health fail; malformed explicitly supplied PDF configuration remains a configuration error.

The captured descriptors form the operation snapshot used for reuse comparison and metadata. Repository config/agent changes are detected after lock acquisition as described below. External plugin/authentication state is not serialized by the repository lock; if it changes after a successful preflight and the later extraction task fails, that is a post-attempt Codex failure and follows the normal explicit or automated failure transition rather than being retroactively reported as a mutation-free readiness rejection.

### 11.3 Preflight mutation guarantee

These failures occur before reuse selection or a new extraction attempt begins and leave repository files byte-for-byte unchanged:

- configured Codex executable missing or unavailable;
- plugin-list command failure or timeout;
- malformed plugin-list JSON or schema;
- required plugin missing;
- required plugin disabled;
- unsupported required-plugin configuration.

The CLI never installs, enables, upgrades, or authenticates a plugin.

### 11.4 Status readiness

`llm-wiki status` must remain read-only and report:

- whether `pdf_ingestion` is valid;
- the referenced Codex agent and resolved executable readiness;
- the exact required plugin;
- plugin-list command readiness;
- installed and enabled state;
- reported plugin version or descriptor;
- whether a stable descriptor permits reuse;
- overall PDF extraction readiness;
- actionable issues without making unrelated status data unavailable.

Human and JSON status output must use stable field names and must distinguish readiness from the extraction state of individual sources.

---

## 12. Artifact and Metadata Contract

### 12.1 Run layout

Every successful new extraction is immutable and stored under its source directory:

```text
raw/inputs/<yyyy>/<mm>/<source_id>/
  _source.md
  original.pdf
  extracted/
    pdf/
      <extraction_id>/
        document.md
        metadata.json
```

This experiment requires exactly two files in a successful run directory:

- `document.md`: the canonical agent-authored, CLI-validated artifact used by ingest.
- `metadata.json`: canonical provenance generated by the CLI after `document.md` passes validation.

Codex must not create `metadata.json`. Optional pages, tables, images, warnings, debug logs, or provider payloads are not part of this contract.

`extraction_id` must be unique, filesystem-safe, and generated by the CLI. A successful existing run directory is never overwritten, including under `--force`. Failed attempts must not leave a half-created run directory in the real repository.

### 12.2 Markdown validation

Before applying a proposal, the CLI must prove that `document.md`:

1. is the only workspace mutation;
2. targets the exact selected run path inside the repository;
3. is a regular file, not a symlink or special file;
4. is readable UTF-8 with no NUL bytes;
5. contains non-whitespace Markdown content;
6. still corresponds to an original whose SHA-256 matches the source card, queue record, and pre-execution hash.

Content-quality inference beyond these deterministic checks is out of scope. The curator must not invent facts absent from the artifact.

### 12.3 Metadata schema

The CLI writes canonical, stably serialized JSON with at least:

```json
{
  "schema_version": 1,
  "source_id": "src_...",
  "extraction_id": "pdfext_...",
  "status": "extracted",
  "original_path": "raw/inputs/.../original.pdf",
  "original_hash": "sha256:<64-lowercase-hex>",
  "artifact_path": "raw/inputs/.../extracted/pdf/pdfext_.../document.md",
  "artifact_hash": "sha256:<64-lowercase-hex>",
  "artifact_bytes": 12345,
  "plugin": "pdf@openai-primary-runtime",
  "plugin_version": "reported-version-or-null",
  "plugin_descriptor": "stable-plugin-descriptor-or-null",
  "model_selection": "explicit-or-inherited",
  "requested_model": "model-name-or-null",
  "model_descriptor": "stable-comparison-descriptor-or-null",
  "observed_model": "runtime-reported-model-or-null",
  "reasoning_effort": "high",
  "pdf_detail": "high",
  "codex_agent": "codex",
  "codex_version": "reported-version-or-null",
  "started_at": "2026-07-11T00:00:00.000Z",
  "finished_at": "2026-07-11T00:00:01.000Z"
}
```

`original_hash` uses the same canonical `sha256:<hex>` spelling as the existing `content_hash` and must equal it. Metadata must not contain prompts, extracted content, credentials, full environment values, or unsanitized process output.

### 12.4 Model descriptor

Metadata records both the requested selection and a stable comparison descriptor.

- An explicit model records `model_selection: explicit`, the exact requested value, and a canonical descriptor derived as `explicit:<requested-model>`. This provides the required stable reuse path without claiming that a Codex alias resolved to some unreported internal model.
- An omitted model records `model_selection: inherited` and no requested value; Codex retains control of the active model.
- The bare label `inherited` is not a safe reuse identity because the active Codex model can change outside repository configuration.
- An inherited model receives a non-null descriptor only when a supported read-only Codex configuration/status interface exposes the current effective model before reuse selection. Extraction output may record a model reported by that run for provenance, but a post-run observation alone cannot prove the next run would inherit the same model.
- If no supported pre-execution interface exposes the current effective model, inherited-model artifacts use `model_descriptor: null`, remain valid for immediate/current ingest, and are not auto-reused later.
- The implementation must never claim a concrete inherited model that Codex did not expose.

This conservative rule may create additional runs, but it prevents a changed active Codex model from falsely matching stale provenance.

---

## 13. Source Card and Queue State

### 13.1 Separate state machines

Queue status and PDF extraction status are independent:

| State machine | Allowed values |
| --- | --- |
| queue lifecycle | `queued | ingesting | ingested | blocked` |
| PDF extraction | `pending | running | extracted | failed` |

Do not add PDF states to the queue lifecycle or queue states to `pdf_extraction.status`.

### 13.2 Mirrored state shape

Both the source-card frontmatter and queue JSON contain the same normalized nested object:

```yaml
pdf_extraction:
  required: true
  status: extracted
  extraction_id: pdfext_...
  artifact_path: raw/inputs/.../extracted/pdf/pdfext_.../document.md
  original_hash: sha256:...
  plugin: pdf@openai-primary-runtime
  plugin_version: 1.2.3
  plugin_descriptor: pdf@openai-primary-runtime#version:1.2.3
  model_descriptor: explicit:model-name
  reasoning_effort: high
  pdf_detail: high
  started_at: 2026-07-11T00:00:00.000Z
  finished_at: 2026-07-11T00:00:01.000Z
  updated_at: 2026-07-11T00:00:01.000Z
  last_error_code: null
  last_error_message: null
```

Nullable fields are `null`, not omitted, once state is persisted. `pending` has no run or artifact. `running` identifies the attempted run and resolved settings but has no selected artifact. `extracted` identifies a validated successful run. `failed` identifies the failed attempt, clears the selected artifact, and records a sanitized actionable error.

The implementation may retain a `last_successful_extraction_id` for diagnosis, but only `status: extracted` with a fully validated current `artifact_path` authorizes ingest.

### 13.3 Synchronization

Create a dedicated PDF-state synchronizer. It must:

- validate the nested schema on every command read;
- update queue JSON and source-card frontmatter as one logical transaction with prevalidated writes, snapshots, and rollback on every observed error;
- preserve unrelated frontmatter, queue fields, and source-card body content;
- compare the two nested objects for consistency just as existing queue fields are compared;
- never call a same-state queue transition merely to update PDF state;
- run under the repository ingest lock for every stateful extraction, including explicit extraction, direct automated ingest, queue automation, and upload-triggered automation.

The shared extraction boundary must support caller-owned locking so auto-ingest can call it while already holding the repository ingest lock without attempting a non-reentrant second acquisition. Explicit extraction completes read-only readiness preflight first, then acquires that same lock and holds it through final source/state revalidation, `running`, Codex execution, artifact application, and the terminal `extracted` or `failed` state. After acquiring the lock, every caller re-reads the config/agent fingerprint, source, original hash, mirrored state, and reuse candidate so a pre-lock observation cannot be applied after a race. A changed config/agent fingerprint requires releasing the lock and repeating read-only preflight.

In this PRD, an atomic multi-file application means a logical all-or-nothing command transaction: validate first, stage new content outside authoritative paths, snapshot existing state, commit in a documented order, and roll back every observed write/application error. It does not claim that multiple files change in one filesystem syscall. An interrupted process may leave an unselected staged/orphan run or inconsistent mirrored state; the next locked operation must detect it and apply the recovery rules below before using any artifact.

New PDF captures begin with mirrored `pending` state. For a legacy PDF where both files omit `pdf_extraction`, readers may derive `pending`; the first PDF-aware mutation persists it. One-sided, malformed, or disagreeing state is inconsistent and must not be silently repaired during ingest.

### 13.4 Interrupted `running` recovery

Because every active extraction holds the repository ingest lock, a caller that successfully acquires the lock and then observes persisted `status: running` knows that the previous attempt was interrupted. It must validate that no authoritative successful run was selected, transition the interrupted attempt to `failed` with `PDF_EXTRACTION_INTERRUPTED`, clean or quarantine non-authoritative staging output, and only then begin a new extraction ID when the current command is authorized to retry. The result reports that recovery occurred.

An explicit queued extraction may continue with the new attempt in the same invocation. Resume-capable automated ingest may do the same while preserving the existing `ingesting` lifecycle. A readiness failure occurs before this recovery mutation and therefore leaves the orphaned state unchanged with actionable retry guidance. No caller may treat `running` as reusable or overwrite its extraction ID silently.

### 13.5 Forced-attempt failure

Successful historical run directories remain immutable when a forced or changed-settings attempt fails. The current mirrored state becomes `failed` and must not silently continue to claim the prior run as selected. A later non-forced command may reselect a still-valid matching historical run through the normal reuse validation path.

---

## 14. Isolated Extraction and Atomic Application

### 14.1 Temporary workspace

Run Codex in a minimal temporary workspace outside the tracked repository. Materialize only the selected PDF at its expected safe relative path, the extraction task/instructions needed by the runner, and the parent directories for the one output. Do not copy source cards, queue files, curated content, other raw sources, prior runs, profiles, or unrelated repository files into this workspace. The real repository is never a Codex write root.

The process sandbox confines all possible writes to this minimal temporary workspace; no real repository path is writable. Within the workspace, the PDF extraction proposal policy permits only the selected `document.md` as an admissible final mutation. The complete before/after snapshot and PDF hash checks reject sibling files, input changes, and every other final diff. This is the concrete one-path policy boundary; it does not assume that the generic Codex workspace sandbox provides a portable per-file filesystem ACL.

Create a PDF-specific proposal policy that permits exactly:

```text
raw/inputs/<yyyy>/<mm>/<source_id>/extracted/pdf/<extraction_id>/document.md
```

The policy rejects every create, edit, delete, rename, type change, or symlink outside that path. Explicitly rejected paths include:

- `original.pdf` and every other raw original;
- `_source.md`;
- `raw/queue/**`;
- existing extraction runs;
- `.llm-wiki/**` and `.git/**`;
- `curated/**`;
- Quartz, profiles, review data, and unrelated paths.

It is not sufficient to ignore disallowed diffs. Any sandbox denial or observed out-of-policy final mutation fails the whole extraction, and no temporary workspace mutation is ever applied directly to the real repository.

### 14.2 Original immutability

Hash both copies explicitly. Compute the real selected PDF SHA-256 during source preflight, immediately before application, and after application. Compute the temporary workspace PDF SHA-256 before and after Codex execution. Every value must match the persisted source `content_hash`. Hash verification supplements sandbox and diff enforcement so same-size or timestamp-preserving mutation cannot evade the policy.

### 14.3 Transaction sequence

For an explicit or automated Codex artifact-ensure operation:

1. Read and validate source, config, overrides, and candidate runs without mutation.
2. Complete executable/plugin preflight and resolve the operation's plugin/model comparison descriptors without creating a repository lock or changing repository files.
3. Acquire or confirm caller ownership of the repository ingest lock.
4. Re-read and revalidate the config/agent fingerprint, source, original hash, mirrored state, and candidate runs; restart read-only preflight if the fingerprint changed.
5. Recover an interrupted `running` attempt when present.
6. Select a reusable run against the captured descriptors when permitted; if reused, synchronize its `extracted` state transactionally and return without `codex exec`.
7. For a new run, transactionally mirror `pdf_extraction.status: running`.
8. Create the minimal temporary workspace and run the shell-free Codex task.
9. Inspect the complete workspace diff and reject every mutation except the selected `document.md`.
10. Recompute both PDF-copy hashes and validate the proposed Markdown.
11. Generate `metadata.json` in CLI-owned staging memory or a CLI-only staging directory.
12. Validate the complete proposed run and next mirrored `extracted` state.
13. Transactionally create the immutable real run directory and synchronize `extracted` state.
14. Recompute the real PDF hash and return the artifact result.

If any post-preflight step fails:

- remove or roll back any new real artifact files;
- prevent half-written `document.md`, `metadata.json`, queue JSON, or source-card state;
- preserve prior successful run directories;
- synchronize `pdf_extraction.status: failed` when the state store remains writable;
- surface a state-write error if even the failure state cannot be recorded;
- follow the queue transition rules in Section 16.

Here, rollback means that no partial run or mutually inconsistent authoritative state survives the failed operation. The synchronized terminal `failed` object is the intentional committed failure outcome, not a rollback defect.

The CLI, not Codex, is the only writer of real metadata and state.

---

## 15. Artifact Reuse and Staleness

### 15.1 Reuse identity

A historical extraction may be reused only after current read-only plugin/model descriptor resolution, and only when its directory, `document.md`, and `metadata.json` all validate and these values match the current request exactly:

1. original/source SHA-256;
2. required plugin canonical identifier and stable plugin version or descriptor;
3. stable model comparison descriptor;
4. reasoning effort;
5. PDF detail.

Timeout, timestamps, Codex executable path, and queue status are not reuse identity fields.

If more than one run matches, choose the newest successfully finished run using parsed timestamps and a deterministic extraction-ID tie-breaker. Transactionally select it in mirrored state and return `reused` without running `codex exec`; the read-only plugin preflight has already completed. A reused artifact is still revalidated before ingest.

### 15.2 New-run conditions

Create a new run when:

- no valid matching run exists;
- source content hash changed;
- plugin identifier or stable version/descriptor changed;
- model comparison descriptor changed or cannot be safely resolved;
- reasoning effort changed;
- PDF detail changed;
- `--force` is present.

`--force` always creates a new extraction ID and never overwrites a matching run.

### 15.3 Stale and inconsistent artifacts

An artifact is unusable when any of the following is true:

- `document.md` or `metadata.json` is missing, unreadable, malformed, empty, or a symlink;
- artifact or original hashes do not match metadata;
- metadata source ID, paths, extraction ID, plugin, settings, or status do not match the directory/request;
- mirrored queue and source-card state disagree;
- `status: extracted` points outside the source's extraction directory;
- an artifact is selected while extraction state is `pending`, `running`, or `failed`;

Status, review, and lint must surface the difference between `missing`, `stale`, and `inconsistent`. Ingest treats all three as no valid artifact. It must not silently repair or trust them.

A successful run with a null stable plugin or inherited-model descriptor is valid for immediate ingest in the operation that created it and may remain the selected valid artifact for manual/provider consumption. It is `non_reusable`, not missing, stale, or inconsistent. A later automated ensure operation creates a new run because it cannot prove an identity match.

---

## 16. Ingest and Queue Integration

### 16.1 Canonical ingest input

For a PDF with `require_artifact_before_ingest: true`, curated ingest must use the validated `document.md` as the source content. The binary `original.pdf` remains provenance and immutability evidence; it is not the content passed to the curator. Ingest tasks and validation context must record both paths and the extraction ID.

Non-PDF source behavior is unchanged.

### 16.2 Automated local Codex ingest

For `--agent <name>` or `--auto` resolving to `pdf_ingestion.codex_agent`:

1. Resolve and validate all PDF overrides before queue mutation.
2. Complete executable/plugin preflight and capture the operation's comparison descriptors without creating a lock or changing repository files.
3. Acquire the existing repository ingest lock and re-read the config/agent fingerprint and source/state; restart read-only preflight if the fingerprint changed.
4. Enter or retain queue status `ingesting` only after readiness succeeds and locked revalidation passes.
5. Revalidate and reuse a matching artifact, or run extraction.
6. Pass only the validated canonical artifact to the existing curated ingest core.
7. Validate and transactionally apply curated proposals.
8. Transition queue status to `ingested` only after both extraction and curated ingest succeed.

Upload-triggered automated ingest and queue processing use the same shared worker and must not fork PDF semantics.

### 16.3 Manual and provider gating

Prompt-only manual ingest, `--validate`, an automated local agent other than `pdf_ingestion.codex_agent`, and HTTP-provider mode do not start PDF extraction.

Before branch creation, queue transition, provider request, agent execution, or curated write, these modes must validate the selected artifact. If it is absent, stale, inconsistent, or mismatched, fail with `PDF_ARTIFACT_REQUIRED` or the more specific artifact error and include:

```bash
llm-wiki extract pdf <source_id>
```

A provider cannot return its own PDF artifact to bypass this gate. Once a valid artifact exists, manual or provider curation consumes that same canonical Markdown under its existing proposal policy.

### 16.4 Transition matrix

| Situation | PDF extraction transition | Queue lifecycle transition | Curated writes |
| --- | --- | --- | --- |
| Readiness rejection before attempt | unchanged | unchanged | none |
| Explicit extraction starts | `pending | failed | extracted -> running` | remains `queued` | none |
| Explicit extraction succeeds | `running -> extracted` | remains `queued` | none |
| Explicit extraction execution/policy/validation/apply fails | `running -> failed` | remains `queued` | none |
| Locked retry finds interrupted `running` | `running -> failed`, then a new ID may enter `running` | unchanged (`queued` explicitly or `ingesting` on resume) | none before successful curation |
| Automated ingest reuses artifact | valid state remains or is synchronized to `extracted` | `queued -> ingesting`, then curation continues | only after curated validation |
| Automated ingest extracts successfully | `pending | failed | extracted -> running -> extracted` | `queued -> ingesting`, then curation continues | only after curated validation |
| Automated extraction fails | `running -> failed` | `ingesting -> blocked` | none |
| Extraction succeeds but curation fails | remains `extracted` | `ingesting -> blocked` | rolled back |
| Manual/provider lacks valid artifact | unchanged | unchanged | none |

An explicit extraction command never calls the queue transition API merely to preserve the same queue status. Auto-ingest failure retains the captured raw PDF and any prior successful extraction directories.

### 16.5 Queue batch and watch

- Preflight only the generic default-agent configuration globally; missing PDF readiness must not prevent non-PDF queue work.
- Classify selected sources read-only. For each PDF, run PDF executable/plugin preflight before acquiring that item's stateful lock or moving that item to `ingesting`.
- A PDF readiness rejection produces an unattempted, incomplete/skipped result with both state machines unchanged. It does not stop later non-PDF or PDF items under the existing batch continuation contract.
- Resolve source-specific reuse and extraction under the same lock used for ingest.
- Forward model, effort, detail, and force through single-source, batch, and watch call layers without loss.
- A failed PDF blocks only that attempted item; batch processing follows existing per-item continuation semantics.
- Watch mode applies the same per-item preflight and reports readiness rejection, extraction failure, and curator-agent failure separately.
- Auto-ingest result envelopes retain existing `outcome`, `attempted`, `previous_status`, `final_status`, `applied_paths`, `auto_ingest`, and `error` fields and add nested PDF result data without changing their meaning.

---

## 17. Status, Upload, and Review Surfaces

### 17.1 CLI source and queue output

`extract pdf`, `queue`, `queue show`, `ingest`, and `status` JSON must use stable snake_case fields. Human output must label the two state machines explicitly as `Queue status` and `PDF extraction status`.

Per-source output should expose, when applicable:

- extraction status;
- extraction ID and artifact path;
- required plugin and reported version;
- model selection/descriptor without claiming an unknown inherited model;
- reasoning effort and PDF detail;
- reuse versus new extraction outcome;
- stale, missing, or inconsistent diagnosis;
- sanitized last error;
- exact retry or extraction command.

`--quiet` suppresses normal human output but not non-zero exit status. `--json` emits structured errors and must not mix human progress text into stdout.

### 17.2 Upload result

A newly captured PDF reports `pdf_extraction.status: pending` and the next command. When upload-triggered automated Codex ingest is enabled, the response reports whether extraction was reused, extracted, or failed, while retaining the existing auto-ingest outcome.

The upload response must not include extracted document content, Codex prompts, environment values, or sensitive process output.

### 17.3 Local review UI

Local and review profiles should show:

- separate queue and PDF extraction badges;
- pending/running/extracted/failed status;
- extraction ID, non-sensitive provenance, and artifact path;
- missing/stale/inconsistent warnings;
- retry guidance;
- blocked auto-ingest outcome when extraction failed.

UI state is derived from repository source/queue data. It is not a second authoritative state store. Review presentation must not make raw artifacts public or copy `document.md` into curated pages automatically.

---

## 18. Privacy, Security, and Linting

### 18.1 Private data

The following must remain excluded from every public profile and public static output:

- original PDFs and other raw originals;
- `extracted/pdf/**/document.md`;
- extraction `metadata.json`;
- all queue JSON and operational queue/PDF extraction state, regardless of source visibility;
- private raw source cards under the existing profile rules;
- raw artifact paths, exact operational failure details, and extraction runtime provenance;
- local/review dashboards and private review data;
- Codex prompts, stdout/stderr logs, runtime metadata, environment values, and authentication material.

Local/review status may show non-sensitive provenance and paths, but extracted content is not synchronized by default.

A human may author a normal public curated narrative about source limitations when appropriate, but public pages must not copy raw state objects, private paths, runtime errors, or metadata as a way around these exclusions.

### 18.2 Process safety

- Spawn commands without a shell.
- Treat source titles, paths, model names, effort values, plugin output, and PDF content as untrusted input.
- Resolve and validate all paths inside the repository or temporary workspace.
- Reject symlinks and special files at original, proposal, metadata, and application boundaries.
- Redact secrets and limit captured process output.
- Preserve existing approval, sandbox, timeout, and termination guarantees unless a stricter PDF policy is required.

### 18.3 Lint and build checks

Add deterministic issues for:

- malformed `pdf_ingestion` configuration;
- malformed or disagreeing mirrored `pdf_extraction` state;
- `extracted` state with a missing, unsafe, stale, or invalid run;
- metadata/original/artifact hash mismatch;
- invalid plugin or settings provenance;
- selected artifact outside the source's immutable run tree;
- PDF originals, extraction artifacts, metadata, queue state, or private review data selected for a public profile;
- any of those files found in built public static output.

Public build tests must prove leak rejection, not only rely on include/exclude conventions.

---

## 19. Errors and Failure Reporting

Errors use the existing runtime envelope shape with stable code, message, path or source ID, and actionable hint. Process errors also include the executable, exit code when available, sanitized stderr tail, timeout state, and whether temporary workspace mutations were observed.

Required error categories include:

| Code | Meaning |
| --- | --- |
| `PDF_CONFIG_INVALID` | PDF configuration or managed-flag collision is invalid. |
| `PDF_SOURCE_NOT_PDF` | The source is not an eligible file-backed PDF or has an invalid signature. |
| `PDF_SOURCE_STATUS_INVALID` | Explicit extraction was requested for a source that is not `queued`. |
| `PDF_CODEX_NOT_READY` | Referenced local agent or executable is unavailable. |
| `PDF_PLUGIN_LIST_FAILED` | `plugin list --json` exited non-zero or timed out. |
| `PDF_PLUGIN_LIST_MALFORMED` | Plugin-list output is not valid supported JSON. |
| `PDF_PLUGIN_MISSING` | The exact required plugin is not installed. |
| `PDF_PLUGIN_DISABLED` | The exact required plugin is installed but disabled. |
| `PDF_CODEX_EXTRACTION_FAILED` | Codex rejected settings, authentication, or extraction, or exited non-zero. |
| `PDF_EXTRACTION_TIMEOUT` | The configured extraction timeout expired. |
| `PDF_EXTRACTION_INTERRUPTED` | A prior lock-owning extraction ended while state was `running`. |
| `PDF_WORKSPACE_MUTATION_REJECTED` | Codex changed or deleted any path outside the one allowed target. |
| `PDF_ORIGINAL_CHANGED` | A PDF hash changed or disagreed with persisted source content hash. |
| `PDF_DOCUMENT_INVALID` | Proposed Markdown failed deterministic validation. |
| `PDF_ARTIFACT_REQUIRED` | Ingest mode requires a valid artifact but none is selected. |
| `PDF_ARTIFACT_STALE` | Artifact provenance no longer matches source or effective settings. |
| `PDF_ARTIFACT_INCONSISTENT` | Run files, metadata, source card, or queue record disagree. |
| `PDF_APPLY_FAILED` | Artifact/metadata transaction failed and was rolled back. |
| `PDF_STATE_WRITE_FAILED` | Mirrored extraction state could not be synchronized safely. |

Unsupported model/effort combinations should retain the useful Codex error text under `PDF_CODEX_EXTRACTION_FAILED`; they must not be mislabeled as local validation errors or trigger fallback.

---

## 20. Mandatory Red-Green-Refactor Contract

Every phase independently follows all five steps below.

### 20.1 Red

1. Add the smallest tests that express only the phase's missing behavior before changing production code for that behavior.
2. Run the new targeted tests and observe them fail for the expected missing behavior.
3. Record the test names, exact command, and relevant failure reason or excerpt.
4. If a Red test passes unexpectedly, correct the test or scope until it demonstrates the missing requirement. Do not treat an unexpectedly green test as Red evidence.
5. Do not commit the intentionally failing state.

### 20.2 Green

1. Implement only enough production code to satisfy the new tests.
2. Run the new targeted tests until they pass.
3. Run directly affected existing tests and correct regressions without weakening assertions.
4. Record the targeted commands and results.

### 20.3 Refactor

1. Improve naming, duplication, module boundaries, and test clarity without expanding phase scope.
2. Prefer shared agent-neutral abstractions where behavior is not inherently PDF/Codex-specific.
3. Rerun targeted tests and record that they remained green.

### 20.4 Phase gate

Before each phase commit, run:

1. the phase's targeted tests;
2. `npm run lint`;
3. `npm test`.

Do not commit while any check fails. An unrelated existing failure must be reported and blocks the commit; do not hide it, skip it, weaken tests, or add product accommodations solely to make the gate green.

### 20.5 Commit

1. Inspect `git status` and the complete diff.
2. Confirm that no user changes or out-of-phase files are included.
3. Stage only files owned by the phase.
4. Create exactly the specified green commit for that phase.
5. Record the commit hash.

The final result contains five implementation commits in phase order, with no Red-state commits and no bundled cleanup commit.

---

## 21. Phased Implementation

### Phase 1: Configuration, CLI, and readiness

**Red**

Add tests for:

- `pdf_ingestion` parsing, defaults, explicit values, and invalid shapes;
- CLI-over-config-over-default precedence;
- invalid detail, blank effort/model, unsupported plugin, and invalid flag/mode combinations;
- registration and help for `extract pdf` and PDF overrides;
- shell-free parsing of supported plugin-list JSON;
- non-zero, timeout, missing, disabled, duplicate, and malformed plugin-list cases;
- missing referenced Codex agent or executable;
- status JSON and human readiness fields;
- status running only the bounded read-only plugin preflight, never `codex exec`, while preserving unrelated non-PDF health;
- zero repository mutation for every preflight failure.

Suitable suites include `test/config.test.ts`, `test/cli.test.ts`, `test/status-command.test.ts`, and focused new PDF config/readiness tests.

**Green**

- Add typed PDF configuration and setting resolution.
- Scaffold explicit defaults for Codex repositories.
- Register commands/options and validate mode combinations.
- Implement dedicated Codex executable/plugin-list preflight.
- Add PDF readiness to status without breaking other health data.

**Refactor**

Separate config normalization, plugin JSON parsing, and readiness reporting so they are independently testable and shell-free.

**Phase gate**

Run phase tests, affected CLI/status/config tests, `npm run lint`, and `npm test`.

**Commit**

```text
feat: add Codex PDF ingestion configuration
```

### Phase 2: Extraction engine and artifacts

**Red**

Add tests for:

- exact model and TOML reasoning argv construction without a shell;
- inherited model omission and unsupported setting error propagation;
- stable explicit model/plugin descriptors and null-descriptor non-reuse;
- task construction with exact plugin, detail, input, and output;
- minimal workspace, read-only input, runtime write policy, and exact-one-path proposal policy;
- creation/edit/deletion/rename/symlink rejection outside `document.md`;
- PDF hash preservation, including same-size mutation attempts;
- UTF-8, NUL, empty, path, type, and Markdown validation;
- CLI-owned metadata fields and hashes;
- immutable run directories and unique extraction IDs;
- explicit extraction lock ownership, caller-owned non-reentrant use, and post-lock revalidation;
- queued-only explicit extraction, actionable rejection of `blocked | ingesting | ingested`, and zero mutation on rejection;
- interrupted `running` recovery;
- transaction rollback for artifact, metadata, and state failures, with synchronized `failed` as the intended outcome;
- reuse fingerprint matching;
- invalidation when source/plugin/version/model/effort/detail changes;
- unresolved inherited model and plugin-version conservative reuse behavior;
- `--force` creating a new run;
- file and browser PDF capture initializing mirrored `pending` state;
- duplicate capture preserving existing extraction state instead of resetting it.

Use a fake Codex executable and focused extraction tests, reusing generic agent workspace and proposal test patterns where appropriate.

**Green**

- Implement the PDF task builder and dedicated shell-free runner.
- Add the exact-one-path proposal policy and full workspace mutation inspection.
- Validate the original and proposed Markdown.
- Generate canonical metadata in the CLI.
- Add immutable atomic run writes and mirrored PDF state synchronization.
- Initialize mirrored `pending` state during new PDF capture and preserve it on duplicates.
- Acquire the repository ingest lock for standalone extraction and recover interrupted attempts safely.
- Implement validated reuse and `--force`.
- Complete `llm-wiki extract pdf <source_id>`.

**Refactor**

Keep generic workspace snapshot, proposal application, hashing, and transaction helpers agent-neutral; isolate PDF-specific policy, metadata, and task code.

**Phase gate**

Run extraction and affected agent/proposal tests, `npm run lint`, and `npm test`.

**Commit**

```text
feat: extract PDFs with the Codex PDF plugin
```

### Phase 3: Ingest and queue integration

**Red**

Add tests for:

- automated Codex ingest extracting when no artifact exists;
- automated Codex ingest reusing a matching artifact;
- executable/plugin readiness failure before `queued -> ingesting`;
- canonical artifact content reaching curated ingest instead of binary path-only content;
- manual prompt, manual validation, other-agent, and provider artifact gating;
- actionable extraction commands and zero pre-gate mutation/network calls;
- explicit versus automated extraction state transitions;
- `ingesting -> blocked` and zero curated writes on extraction failure;
- retained `extracted` state and curated rollback on curation failure;
- override and force forwarding through direct `--agent`, direct `--auto`, queue source, batch, watch, and upload-triggered auto-ingest repository settings;
- per-PDF readiness rejection leaving that item queued while mixed batch/watch processing continues eligible non-PDF items;
- lock ownership and mirrored-state rollback;
- batch continuation and watch error reporting.

Suitable existing suites include ingest command/agent, auto-ingest worker, queue ingest/watch/runtime, and daemon upload tests.

**Green**

- Add validated PDF artifact context to ingest task construction.
- Ensure/reuse/extract the artifact inside the shared automated Codex ingest path and existing ingest lock.
- Gate manual, validation, other-agent, and provider modes before side effects.
- Forward PDF settings through direct, batch, watch, and upload-triggered worker layers.
- Apply the specified queue and extraction failure transitions.

**Refactor**

Converge all automated paths on one agent-neutral artifact-ensuring boundary with a PDF/Codex extraction adapter; remove duplicated transition and error mapping logic.

**Phase gate**

Run phase tests and affected ingest/queue/upload suites, `npm run lint`, and `npm test`.

**Commit**

```text
feat: integrate PDF extraction with ingest
```

### Phase 4: Review, lint, and privacy

**Red**

Add tests for:

- status and queue data for all four extraction states;
- source-card/queue PDF state disagreement;
- upload result and review presentation;
- missing, stale, malformed, unsafe, and inconsistent run diagnosis;
- extraction provenance and retry guidance without private content;
- local/review profile behavior;
- public profile rejection of PDFs, `document.md`, `metadata.json`, queue state, and private review data;
- static public-output scanning for those leaks;
- lint issues for invalid configuration, state, hashes, paths, and metadata.

Suitable suites include review generation, upload form, profile privacy, lint command, Explorer sync, and Explorer build tests.

**Green**

- Expose PDF state and diagnosis in runtime status, queue, upload, source badges, and review data.
- Add schema consistency, stale-artifact, and provenance lint rules.
- Extend fail-closed public profile and static leak protection.
- Keep artifact contents out of review/API payloads and public output.

**Refactor**

Share normalized read-only PDF status data across CLI, upload, review, and lint while keeping repository files authoritative.

**Phase gate**

Run phase tests and affected review/privacy/build suites, `npm run lint`, and `npm test`.

**Commit**

```text
feat: expose PDF extraction status
```

### Phase 5: Documentation and end-to-end verification

**Red**

Add documentation/help/scaffold assertions and public-interface fake-Codex end-to-end tests for:

- readiness success and missing/disabled/malformed plugin failures;
- exact model/effort argv and detail task forwarding;
- inherited-model behavior;
- successful extraction, metadata/state synchronization, and unchanged PDF hash;
- out-of-policy mutation rejection and rollback;
- automated extraction plus curation;
- explicit failure, automated block, retry, reuse, changed settings, and force;
- manual/provider gate guidance;
- public leak rejection;
- documented experiment boundary and commands.

These tests must exercise the still-missing packaged/scaffolded public integration rather than duplicate already-green lower-level tests from Phases 1-4. Run them before Phase 5 production/documentation changes and observe the expected missing-integration failures. If any intended Red case passes, refine the assertion to the unimplemented end-to-end contract without weakening or distorting it.

**Green**

- Update README command/reference material.
- Update CLI help and examples.
- Update scaffolded `AGENTS.md`, `CODEX.md`, and operating-instruction prose. Phase 1 remains the sole owner of scaffolded `pdf_ingestion` configuration behavior.
- Implement only a bounded missing documentation-visible integration exposed by an honestly failing Phase 5 test; otherwise treat the fake-Codex suite as verification.
- Document plugin installation/authentication as user-managed and provide recovery commands.

**Refactor**

Remove duplicated prose and test setup, keep generated documentation deterministic, and rerun the complete end-to-end path.

**Phase gate**

Run documentation and end-to-end tests, `npm run lint`, and `npm test`. This is also the final full repository gate.

**Commit**

```text
docs: complete Codex PDF ingestion experiment
```

---

## 22. Acceptance Tests

The implementation is accepted only when all of the following are automated and passing:

1. A missing Codex executable fails before repository mutation.
2. A missing or disabled required plugin fails before repository mutation.
3. Non-zero, malformed, or schema-invalid `codex plugin list --json` output fails before repository mutation.
4. Plugin preflight completes before reuse selection and before automated ingest enters `ingesting`.
5. CLI, repository, and default precedence produces the expected model, reasoning, and detail settings.
6. An explicit model is passed through `--model`; inherited selection omits it.
7. Reasoning effort is passed through one correctly encoded TOML `-c` value; PDF detail appears in the plugin task.
8. Unsupported model/effort combinations surface the Codex error without shell interpolation, retry downgrade, or fallback.
9. Successful extraction creates exactly `document.md` and CLI-owned `metadata.json` in a new immutable run.
10. Artifact metadata and mirrored source/queue state are synchronized and the PDF hash remains unchanged in both real and temporary copies.
11. Agent creation, modification, deletion, rename, or type change outside the extraction target is rejected and rolled back.
12. A valid artifact is reused only when source hash, plugin/version, stable model descriptor, effort, and detail match.
13. A changed identity setting or `--force` creates a new run without rewriting a previous run.
14. An unresolved inherited model or plugin version never causes a false reuse match, while a just-created valid run remains usable for immediate ingest.
15. A persisted orphaned `running` attempt is recovered only under the repository ingest lock and is never reused or overwritten silently.
16. Automated Codex ingest extracts or reuses first, passes the validated artifact to curation, and reaches `ingested` only after curated validation.
17. Automated extraction failure records PDF `failed`, transitions `ingesting -> blocked`, and writes no curated files.
18. Explicit extraction accepts a queued source; failure records PDF `failed`, leaves it `queued`, and writes no curated files. `blocked`, `ingesting`, and `ingested` sources are rejected without mutation under the intentionally limited experiment lifecycle.
19. Manual, validation, other-agent, and provider modes cannot bypass the artifact requirement and print the actionable extraction command.
20. Batch and watch paths forward all PDF overrides, preflight PDFs per item, preserve per-source failure semantics, and continue eligible non-PDF work when PDF readiness is unavailable.
21. Missing, stale, and inconsistent artifacts are distinct in status/review/lint and are never consumed by ingest.
22. Public profiles and public builds reject leaked PDFs, extraction Markdown, metadata, queue state, and private review data.
23. Every phase's new tests, including Phase 5 documentation and public-interface fake-Codex tests, were observed failing for the expected missing behavior before production implementation and passing afterward.
24. Every phase passed targeted tests, `npm run lint`, and `npm test` before its commit.
25. The result contains the five specified green commits in order and no committed Red state.
26. `ainative.yaml`, existing `ainative` workflows, and unrelated `ainative` behavior remain unchanged.

---

## 23. Documentation Deliverables

Update documentation and generated instructions to explain:

- the standalone experiment boundary;
- required user-managed Codex installation, authentication, and plugin enablement;
- repository configuration and setting precedence;
- explicit extraction, reuse, force, and retry;
- automated ingest and queue override examples;
- the difference between queue status and PDF extraction status;
- manual/provider artifact gating;
- artifact paths and provenance without encouraging publication;
- readiness and common error recovery;
- public privacy guarantees;
- how a future `ainative`-managed workflow could call the same agent-neutral implementation boundary.

Examples must not suggest running `ainative` for these five phases.

---

## 24. Final Implementation Report

Codex must finish the implementation with one report containing:

1. The five commit hashes in phase order beside their exact subjects.
2. For every phase:
   - Red test names, command, and expected observed failure;
   - Green implementation summary and passing targeted/affected tests;
   - Refactor summary and confirmation that tests stayed green;
   - phase-gate results for targeted tests, `npm run lint`, and `npm test`.
3. Final end-to-end and privacy acceptance results.
4. Confirmation that the working tree contains no unintended files.
5. A comparison against the starting revision confirming that `ainative.yaml` and existing `ainative` workflows, commands, artifacts, PRDs other than this redirected PRD, `ainative`-related documentation, and integration points were not deleted or behaviorally rewritten. The explicitly required PDF README/help/scaffold documentation changes are expected.
6. All assumptions that must be formalized before moving the feature back under `ainative`, including at minimum:
   - the supported `codex plugin list --json` schema and plugin-version identity;
   - how a stable inherited model descriptor is discovered;
   - ownership and locking of atomic artifact/state transitions;
   - batch/watch override and force semantics;
   - fake-Codex test fixtures versus supported real Codex versions;
   - the module boundary an `ainative` workflow would invoke without duplicating Codex-specific logic.

Existing unrelated test failures, environmental limitations, or unverified assumptions must be reported explicitly and must not be hidden by weakening tests.

---

## 25. Assumptions

- `pdf@openai-primary-runtime` is required for this experimental path; no external parser fallback exists.
- The model inherits from the active Codex runtime when `model` and `--pdf-model` are omitted.
- A stable model comparison descriptor is required for reuse; unresolved inherited selection is conservatively non-reusable.
- Reasoning effort defaults to `high` and is a non-empty pass-through because model support varies.
- PDF detail defaults to `high` and accepts only `auto`, `low`, or `high`.
- Extraction timeout defaults to 900 seconds and is not part of reuse identity.
- PDF eligibility uses a safe case-insensitive `.pdf` original path plus PDF signature validation; `source_kind` remains `file`.
- Plugin installation, enablement, Codex authentication, and access to any required runtime resources are user-managed.
- Successful extraction runs are immutable; failed attempts do not create authoritative run artifacts.
- Only an `extracted` and fully validated selected artifact authorizes curated ingest.
- Every phase produces exactly one green commit after refactoring; Red-state commits are prohibited.
- `ainative` remains supported elsewhere in the repository and may manage this implementation later.

---

## 26. Questions to Formalize Before Future `ainative` Ownership

These questions do not block the experiment when the conservative behavior above is implemented, but they must be resolved before handing orchestration back to `ainative`:

1. Which Codex CLI versions and exact plugin-list JSON schemas are supported?
2. What is the canonical plugin version or content descriptor when the CLI reports no version?
3. What supported Codex interface exposes the effective inherited model before execution so safe reuse can occur?
4. Should future orchestration persist failed-attempt history outside the current mirrored last-error fields?
5. Should an orchestration retry inherit `--force`, or must force always be re-authorized per invocation?
6. How should an `ainative` phase acquire the repository ingest lock and call the agent-neutral extraction boundary without duplicating CLI behavior?
7. Which evidence format will `ainative` require for Red, Green, Refactor, phase gates, and phase-owned commits?
8. How will future plugin upgrades invalidate or migrate existing artifact reuse descriptors?
