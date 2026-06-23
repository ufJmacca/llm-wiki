# Product Requirements Document: LLM Wiki Deploy, Compatibility, and Scale Hardening

**Product name:** `llm-wiki`
**Document status:** Draft completion PRD
**Created:** 2026-06-23
**Source PRDs:** `./prds/llm-wiki-prd.md`, `./prds/llm-wiki-remaining-work-prd.md`
**Purpose:** Close PRD/code mismatches, clarify operational behavior, and prove non-functional scale and safety targets.

---

## 1. Executive Summary

`llm-wiki` has implemented most MVP operational surfaces: linting, profile-based Quartz sync, GitHub Pages workflow generation, local preflight, status, search, navigation, and upload scaffolds. The remaining hardening work is not primarily new feature surface. It is about compatibility, documentation clarity, PRD/code alignment, and measurable guarantees.

This PRD covers:

- GitHub Pages workflow version alignment.
- Clear deploy status semantics.
- Provider vs agent documentation and diagnostics.
- Public safety regression coverage.
- Performance benchmarks for the scale targets stated in the source PRD.
- Cross-platform and generated-file compatibility checks.

---

## 2. Goals

1. Ensure generated GitHub Pages workflow matches the documented supported action versions.
2. Make `deploy github-pages status` explicit about what it can and cannot know locally.
3. Prevent recurring confusion between `agent.default: codex` and `providers.codex`.
4. Prove performance targets with repeatable benchmark tests.
5. Preserve public profile fail-closed behavior as the repo grows.
6. Keep generated runtime/content artifacts safely ignored and reproducible.

---

## 3. Non-Goals

- Add non-GitHub deploy providers.
- Add private authenticated hosting.
- Replace Quartz.
- Add vector search or SQLite FTS.
- Build hosted telemetry.
- Implement the Codex adapter itself; that is covered by the Codex automation PRD.

---

## 4. Current Variances

### 4.1 GitHub Pages action version

The source PRD references `actions/upload-pages-artifact@v4`. Current implementation generates and validates `actions/upload-pages-artifact@v3`.

Requirement:

- Decide the supported version based on current GitHub Pages action compatibility.
- Update PRD/docs/tests/code to one consistent version.
- Prefer the newest stable official action version unless there is a compatibility reason to pin older.

### 4.2 Deploy status semantics

The PRD says `deploy github-pages status` should show deploy state and workflow hints where available. Current local implementation reports local workflow/profile/quartz/preflight readiness. It does not query GitHub Actions or GitHub Pages live deployment state.

Requirement:

- Keep local-only status useful.
- Rename fields or documentation so users understand it is local readiness unless a future GitHub API integration is added.
- Optionally add a future `--github` mode if GitHub API status is desired.

### 4.3 Agent/provider diagnostics

Current configuration supports:

- `agent.default` for instruction profile,
- `providers.<name>` for HTTP proposal providers.

Requirement:

- Docs and errors must explain this distinction.
- If `--provider codex` is passed while `agent.default: codex` exists but no provider exists, the hint should suggest `--agent codex` after the Codex automation PRD lands, or manual task mode before it lands.

### 4.4 Performance targets

The source PRD defines targets for:

- `status` under 2 seconds for 1,000 Markdown pages,
- `search` under 1 second for 1,000 Markdown pages,
- `index rebuild` under 10 seconds for 5,000 Markdown pages,
- `lint` under 15 seconds for 5,000 Markdown pages,
- `explore sync` under 3 seconds for small changes after dependencies are installed,
- public leak check under 10 seconds for 5,000 pages.

Requirement:

- Add repeatable tests or benchmark scripts that validate or report these targets.
- Avoid brittle CI failures from noisy shared runners by separating strict algorithmic tests from optional benchmark reporting where needed.

---

## 5. Deploy Requirements

### 5.1 Workflow generation

Generated workflow must:

- use least required permissions:
  - `contents: read`,
  - `pages: write`,
  - `id-token: write`,
- support `workflow_dispatch`,
- build from canonical repo state,
- run public profile sync,
- run strict public lint before build,
- upload `quartz/public`,
- deploy through official GitHub Pages deploy action.

The action versions must be defined in one implementation constant or template source and asserted in tests.

### 5.2 Local preflight

`llm-wiki deploy github-pages build-local` must:

1. validate generated workflow,
2. validate deploy and public profiles,
3. sync `github-pages` profile,
4. run strict public lint,
5. build Quartz,
6. preserve CNAME when configured,
7. report setup instructions.

### 5.3 Status wording

`llm-wiki deploy github-pages status` must report local readiness categories:

- workflow: valid/missing/invalid,
- profiles: valid/missing/invalid,
- Quartz runtime: ready/missing runtime/missing dependencies,
- public preflight: pass/fail,
- setup instructions.

It must not imply that it has queried the live GitHub Actions run unless a live mode exists.

---

## 6. Provider and Agent Compatibility Requirements

### 6.1 Config validation

Provider config must continue to reject:

- missing provider entry,
- invalid YAML,
- unsupported provider type,
- missing endpoint,
- missing `api_key_env`,
- embedded secret values,
- unset secret environment variable.

### 6.2 User-facing diagnostics

When a user runs:

```bash
llm-wiki ingest <source_id> --provider codex
```

and `providers.codex` is missing, the error hint should say:

```text
No HTTP provider named codex is configured. If you intended to use the local Codex agent, use --agent codex or run prompt-only ingest without --provider.
```

Before `--agent codex` is implemented, the hint should point to prompt-only manual ingest and provider configuration docs.

### 6.3 Documentation

Docs must include a short matrix:

| Mode | Flag | Config | Behavior |
|---|---|---|---|
| Manual task | none / `--task-out` | `agent.default` optional | Prints or writes agent prompt |
| Local agent | `--agent codex` | `agents.codex` | Runs local Codex adapter |
| HTTP provider | `--provider <name>` | `providers.<name>` | Calls structured proposal service |

---

## 7. Scale and Performance Requirements

### 7.1 Fixture generation

Add deterministic fixture generation for:

- 1,000 curated Markdown pages,
- 5,000 curated Markdown pages,
- source summaries,
- wikilinks,
- private/public visibility combinations,
- queue files,
- log entries.

Fixture generation must be deterministic and not committed as generated bulk fixtures unless there is a specific test-data reason.

### 7.2 Benchmark commands

Add benchmark or test coverage for:

```bash
llm-wiki status --json
llm-wiki search "target phrase" --json
llm-wiki index rebuild
llm-wiki lint --json
llm-wiki lint --profile public --strict --json
llm-wiki explore sync --profile local
```

### 7.3 CI policy

Use two tiers:

- Unit/integration tests assert correctness on moderate fixtures.
- Optional benchmark script reports timings on large fixtures.

If strict timing assertions are used in CI, they must include enough slack to avoid false failures on shared runners.

---

## 8. Public Safety Regression Requirements

Add or preserve regression coverage for:

- raw originals excluded from all public-like profiles,
- raw source cards excluded from public-like profiles,
- private curated pages excluded,
- public pages linking to private pages fail strict lint,
- public pages linking to raw paths fail strict lint,
- generated search/graph/index output contains no private titles or body text,
- daemon runtime metadata excluded from public profiles,
- remote upload secrets excluded from public profiles,
- generated review dashboards excluded unless explicitly public-safe.

---

## 9. Generated Artifact Requirements

Generated artifacts must remain reproducible and safely ignored:

- `quartz/content/`
- `quartz/public/`
- `quartz/quartz/`
- `.llm-wiki/cache/`

Commands that create generated artifacts must:

- validate they are not symlinks to unsafe paths,
- avoid committing generated content by default,
- repair known generated ignore rules when safe,
- fail with actionable errors when ignore rules are unsafe.

---

## 10. Acceptance Criteria

1. GitHub Pages workflow action versions are consistent across PRDs, docs, generated workflow, and tests.
2. `deploy github-pages status` clearly reports local readiness and does not imply live GitHub status.
3. Provider errors explain the difference between HTTP providers and local agents.
4. Documentation includes the manual task vs local agent vs HTTP provider matrix.
5. Benchmark or performance scripts can generate deterministic 1,000-page and 5,000-page repos.
6. Correctness tests pass for large-enough fixtures to catch algorithmic regressions.
7. Public safety tests fail if private/raw content, daemon metadata, or upload secrets can enter public output.
8. Generated artifact ignore rules are verified by tests.

---

## 11. Tests

Add tests for:

- Workflow action version template and validator consistency.
- Local deploy status output wording and JSON shape.
- Provider missing error hint when provider name equals configured default agent.
- Provider config secret rejection.
- Agent/provider docs command examples through snapshot or fixture tests where appropriate.
- Deterministic large fixture generator.
- Search correctness on large fixture.
- Lint correctness on large fixture.
- Public leak checks on large fixture.
- Generated artifact ignore rule repair and unsafe path rejection.

---

## 12. Documentation

Update docs to include:

- GitHub Pages generated workflow version policy.
- What `deploy github-pages status` checks locally.
- How to check live GitHub Actions status manually until a live mode exists.
- Provider vs agent matrix.
- Performance target caveats and benchmark command.
- Generated artifact directory policy.

---

## 13. Open Questions

1. Should live GitHub Actions status be added now through `gh` or GitHub API, or left as future work?
2. Should large benchmark scripts be required in CI or run manually/release-only?
3. Should the source PRD be amended to match the supported Pages artifact action version, or should implementation move to the PRD version?
