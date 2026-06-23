# Product Requirements Document: LLM Wiki Codex-Native Ingest Automation

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-23
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`
**Purpose:** Define the first-class Codex automation path needed to move ingest and query workflows from task generation to validated local agent execution.

---

## 1. Executive Summary

`llm-wiki` currently supports two related but separate concepts:

- `--agent codex` during `llm-wiki init`, which generates Codex-specific instructions.
- `--provider <name>` during `llm-wiki ingest` and `llm-wiki query`, which calls a configured HTTP provider that returns file proposals.

This creates a product gap. A user who initialized with `--agent codex` reasonably expects `llm-wiki ingest <source_id>` to be able to use Codex directly, but the current implementation treats `codex` as an instruction profile, not an executable provider. This causes errors such as `Provider is not configured: codex`.

This PRD adds a first-class local Codex automation path. The CLI must be able to generate an ingest or query task, execute Codex in non-interactive mode, collect proposed file changes, validate them in a temporary workspace, apply them only after validation passes, and update queue/log state deterministically.

---

## 2. Goals

1. Provide a clear automated path for users who configure `agent.default: codex`.
2. Preserve the existing manual task workflow for users who want to copy prompts into any agent.
3. Preserve generic HTTP provider mode for integrations that already return structured file proposals.
4. Make Codex execution safe, inspectable, and rollback-friendly.
5. Ensure every automated ingest produces valid curated output before a source can be marked `ingested`.

---

## 3. Non-Goals

- Build a hosted LLM service.
- Replace generic provider mode.
- Trust unvalidated agent edits.
- Run interactive Codex sessions from inside `llm-wiki`.
- Automatically bypass Codex sandbox, network, or approval controls.
- Implement full multi-agent scheduling.

---

## 4. Current State

Current implementation already includes:

- `llm-wiki ingest <source_id>` task generation.
- `llm-wiki ingest <source_id> --validate` ingest validation.
- `llm-wiki ingest <source_id> --provider <name>` HTTP provider proposal application.
- `llm-wiki query "<question>" --save <path>` task generation.
- `llm-wiki query "<question>" --save <path> --validate`.
- `llm-wiki query "<question>" --save <path> --provider <name>`.
- `AGENTS.md` and optional `CODEX.md` scaffold.

Current gaps:

- No `--agent codex` execution mode.
- No local Codex command adapter.
- No generated config for Codex executable behavior.
- No distinction in user-facing help between provider mode and local agent mode.
- Upload and add workflows stop at queued raw source state unless a human or separately configured provider performs the ingest edits.

---

## 5. User Stories

### 5.1 Ingest with default Codex agent

As a user who initialized with Codex, I want:

```bash
llm-wiki ingest src_2026_06_21_product_requirements_document_llm_wiki_cli_370d9bf83958 --agent codex
```

to run Codex against the generated ingest task, apply valid curated edits, and mark the source `ingested`.

### 5.2 Ingest with config default

As a user with `agent.default: codex`, I want:

```bash
llm-wiki ingest <source_id> --auto
```

to use the configured default agent without also passing `--agent codex`.

### 5.3 Query with file-back

As a user, I want:

```bash
llm-wiki query "What changed in the PRD?" --save curated/questions/prd-changes.md --agent codex
```

to run Codex, create the saved question page, update `curated/index.md`, append `curated/log.md`, and validate the saved answer.

### 5.4 Manual fallback

As a cautious user, I want:

```bash
llm-wiki ingest <source_id> --task-out tasks/ingest.md
```

to remain a prompt-only workflow with no automated agent execution.

---

## 6. Command Model

### 6.1 Ingest

Add:

```bash
llm-wiki ingest <source_id> --agent codex
llm-wiki ingest <source_id> --auto
```

Behavior:

- `--agent codex` executes the Codex local adapter.
- `--auto` resolves `.llm-wiki/config.yml:agent.default` and executes the configured local agent.
- `--provider <name>` remains HTTP-provider proposal mode.
- Passing both `--agent` and `--provider` is an error.
- Passing both `--auto` and `--provider` is an error.
- Passing both `--auto` and `--agent` is an error unless the values resolve to the same configured agent; prefer rejecting this combination for MVP clarity.

### 6.2 Query

Add:

```bash
llm-wiki query "<question>" --save curated/questions/<slug>.md --agent codex
llm-wiki query "<question>" --save curated/questions/<slug>.md --auto
```

Behavior:

- Agent query mode requires `--save`.
- Agent proposals may write only:
  - the requested saved question path,
  - `curated/index.md`,
  - `curated/log.md`.
- Agent proposals must not create or modify source summaries during query mode.

### 6.3 Status and help

Update `llm-wiki status` to report:

- configured default agent,
- whether Codex executable is available,
- whether HTTP providers are configured,
- whether the repo can run `--auto`.

Update command help text to distinguish:

- local agent execution: `--agent codex`, `--auto`,
- external structured provider: `--provider <name>`.

---

## 7. Configuration

Extend `.llm-wiki/config.yml` with optional local agent configuration:

```yaml
agent:
  default: codex
agents:
  codex:
    type: local-exec
    command: codex
    args:
      - exec
    approval_policy: never
    sandbox_mode: workspace-write
    output_mode: git-diff
    timeout_seconds: 900
```

Requirements:

- Existing repos without `agents.codex` must still work in manual task mode.
- `llm-wiki init --agent codex` should scaffold a minimal Codex agent config.
- Secrets must not be written into `.llm-wiki/config.yml`.
- Agent command must be resolved from `PATH` unless explicitly configured as an absolute executable path.
- Unsupported `agents.<name>.type` values must fail with actionable errors.

---

## 8. Codex Adapter Behavior

### 8.1 Execution model

For MVP, the Codex adapter should:

1. Build the existing ingest or query task prompt.
2. Create a temporary working copy of the repo outside the tracked tree.
3. Run Codex in that temporary working copy.
4. Inspect the resulting diff.
5. Convert changed files into structured file proposals.
6. Validate proposals using existing ingest/query validation.
7. Apply proposals to the real repo only after validation passes.
8. Append or preserve log entries through the existing provider proposal log-append behavior.

### 8.2 Command invocation

The default Codex invocation should be:

```bash
codex exec "<task prompt>"
```

If sandbox and approval flags are supported by the installed Codex CLI, the adapter may pass configured flags before the `exec` subcommand. It must not pass deprecated or unsupported flags by default.

The implementation must detect command failures and return actionable errors that include:

- executable path,
- exit code,
- stderr tail,
- whether any repo changes were observed.

### 8.3 Proposal extraction

The adapter should accept file changes from the temporary repo as the proposal set.

Allowed paths:

- Ingest mode: Markdown files under `curated/`.
- Query mode: the requested saved answer path, `curated/index.md`, and `curated/log.md`.

Rejected paths:

- `.git/**`
- `.llm-wiki/**`
- `raw/**`
- `quartz/**`
- non-Markdown files
- absolute paths
- paths outside the repo root

### 8.4 Validation and rollback

- Validate in the temporary repo before applying to the real repo.
- Apply changes to the real repo through the same safe write path used by provider proposals.
- If validation fails, do not modify the real repo.
- If application fails after partial writes, restore original file snapshots.
- Queue status becomes `ingested` only after validation passes and proposals are applied.

---

## 9. Ingest Acceptance Criteria

1. `llm-wiki ingest <queued_source> --agent codex` runs Codex, writes `curated/sources/<source_id>.md`, updates relevant curated pages, updates `curated/index.md`, appends `curated/log.md`, and marks the queue item `ingested`.
2. If Codex edits raw originals, the run is rejected and raw files in the real repo remain unchanged.
3. If Codex omits the source summary, index entry, log entry, or `source_ids`, validation fails and the queue item remains `ingesting` or returns to its previous state according to the existing rollback contract.
4. `--json` output reports mode, agent name, applied paths, validation status, and queue transition.
5. `--quiet` suppresses human prompt output but still exits non-zero on failures.
6. `--provider codex` continues to fail unless a provider named `codex` is explicitly configured; the error hint must suggest `--agent codex` when appropriate.

---

## 10. Query Acceptance Criteria

1. `llm-wiki query "<question>" --save curated/questions/<slug>.md --agent codex` creates a valid saved question page.
2. Query agent mode updates `curated/index.md` and appends `curated/log.md`.
3. Query agent mode rejects proposals outside the query allowed path set.
4. Missing evidence is represented as open questions or limitations, not fabricated source IDs.
5. `--json` output reports saved path, agent name, applied paths, and validation status.

---

## 11. Tests

Add tests for:

- Config parsing for `agents.codex`.
- Helpful error when `--provider codex` is used but only `agent.default: codex` exists.
- Fake Codex executable that edits a temporary repo and exits successfully.
- Fake Codex executable that exits non-zero.
- Fake Codex executable that edits disallowed paths.
- Ingest success path with source summary, index, log, and queue transition.
- Ingest validation failure path with no real repo writes.
- Query success path with saved page, index, and log.
- Query rejected path when agent edits source summaries.
- `status --json` agent readiness fields.

---

## 12. Documentation

Update user documentation to explain:

- `--agent` is for local agent CLIs such as Codex.
- `--provider` is for configured HTTP proposal services.
- `--auto` uses the configured default local agent.
- How to inspect generated task prompts.
- How to recover when automated ingest fails validation.
- How to run Codex manually if users prefer manual control.

---

## 13. Open Questions

1. Should `--auto` be introduced immediately, or should MVP require explicit `--agent codex` until the local agent contract is stable?
2. Should the Codex adapter parse a structured JSON proposal if Codex emits one, or rely only on temporary repo diffs for MVP?
3. Should failed automated ingest restore queue status to `queued` or preserve `ingesting` for review?
