import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(resolve(repoRoot, "README.md"), "utf8");
}

describe("README local agent documentation", () => {
  it("documents manual prompts, local Codex execution, auto mode, validation, and HTTP providers", async () => {
    // Arrange
    const requiredCommands = [
      "llm-wiki ingest <source_id>",
      "llm-wiki ingest <source_id> --agent codex",
      "llm-wiki ingest <source_id> --auto",
      "llm-wiki ingest <source_id> --validate",
      "llm-wiki ingest <source_id> --provider local",
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --agent codex',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --auto',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --validate',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --provider local',
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const command of requiredCommands) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain("`--agent <name>` runs a configured local CLI agent such as Codex.");
    expect(readme).toContain("`--auto` uses `agent.default` from `.llm-wiki/config.yml`");
    expect(readme).toContain("`--provider <name>` runs an explicit HTTP proposal service");
    expect(readme).toContain("`--provider codex` is not a shortcut for local Codex");
  });

  it("shows the Codex local-agent config needed by older Codex-initialized repositories", async () => {
    // Arrange
    const requiredConfigLines = [
      "agent:",
      "  default: codex",
      "agents:",
      "  codex:",
      "    type: local-exec",
      "    command: codex",
      "    args:",
      "      - exec",
      "    approval_policy: never",
      "    sandbox_mode: workspace-write",
      "    output_mode: git-diff",
      "    timeout_seconds: 900",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const line of requiredConfigLines) {
      expect(readme).toContain(line);
    }
  });

  it("documents prompt inspection, validation failure recovery, manual Codex execution, and module ownership", async () => {
    // Arrange
    const requiredDocumentation = [
      "llm-wiki ingest <source_id> --task-out tasks/ingest.md",
      'llm-wiki query "What changed in the PRD?" --save curated/questions/prd-changes.md > tasks/query.md',
      "codex exec \"$(cat tasks/ingest.md)\"",
      "If automated ingest or query validation fails, curated proposal writes are rejected or rolled back",
      "Ingest agent failures can still move the source queue item to `blocked`",
      "query agent failures leave queue state untouched",
      "Run the matching `--validate` command after making manual fixes",
      "`src/agents/` owns local CLI agent execution",
      "`src/proposals/` owns shared proposal policies",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });
});

describe("README GitHub Pages deploy documentation", () => {
  it("documents publisher-only committed Pages deployment instead of CI-side site generation", async () => {
    // Arrange
    const requiredDocumentation = [
      "The generated workflow is publisher-only.",
      "checks out the repository, uploads the committed `quartz/public` directory with `actions/upload-pages-artifact`, and deploys through the official Pages actions.",
      "It does not set up Node, install `llm-wiki` or Quartz dependencies, run Explorer sync, ingest, lint, or build steps, or generate Pages output in CI.",
      "`deploy github-pages` generates the publisher-only Pages workflow/profile pair, validates deploy readiness, and runs the local build/check path used before committing `quartz/public`.",
      "committed Pages output under `quartz/public` remains trackable by Git.",
      "running `build-local`, running `check`, committing `quartz/public`, opening a pull request",
      "`quartz/public/` is generated static Pages output and remains trackable so maintainers can commit it for review before publication.",
    ];
    const removedDocumentation = [
      "sets up Node 22",
      "installs the `llm-wiki` CLI without requiring root npm project files",
      "installs Quartz dependencies under `quartz/`, runs GitHub Pages profile sync, strict public lint, the safe `llm-wiki explore build --profile github-pages` wrapper",
      "runs the local preflight sequence that mirrors CI",
      "`quartz/content/`, `quartz/public/`, `quartz/.quartz-cache/`, and `quartz/quartz/` are generated Explorer/runtime outputs ignored by the wiki scaffold.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
    for (const removedText of removedDocumentation) {
      expect(readme).not.toContain(removedText);
    }
  });

  it("documents the local review-to-PR publication path for GitHub Pages", async () => {
    // Arrange
    const requiredDocumentation = [
      "GitHub Pages is static publication only: it never supports uploads, upload endpoint configuration, upload tokens, runtime daemon metadata, raw originals, private source cards, queue state, or generated review pages.",
      "The supported publication flow is local/private upload, private queue review, ingest into curated Markdown, `llm-wiki deploy github-pages build-local`, `llm-wiki deploy github-pages check`, commit `quartz/public`, open a pull request, merge it, and let GitHub Pages serve the committed static files.",
      "Do not commit raw upload artifacts, `_llm-wiki/runtime/local-daemon.json`, queue internals, or review-only Explorer pages to the Pages payload.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });
});

describe("README local Explorer upload and review documentation", () => {
  it("documents the browser upload workflow, supported modes, local daemon endpoint, and ingest follow-up commands", async () => {
    // Arrange
    const requiredDocumentation = [
      "llm-wiki explore serve --profile local --with-daemon",
      "Open the local Explorer root URL and use the generated upload form to capture a file, pasted text, or URL source.",
      "The browser form submits `multipart/form-data` to the local daemon endpoint recorded in `_llm-wiki/runtime/local-daemon.json`: `<daemon.url>/api/raw-upload`.",
      "File uploads send the `file` field with an optional `title`; pasted text uploads send `text` plus the required `title`; URL uploads send `url` with an optional `title`.",
      "A successful browser upload shows the title, `source_id`, source kind, queue status, source card path, original path, and next ingest command.",
      "llm-wiki ingest <source_id>",
      "llm-wiki ingest <source_id> --auto",
      "Remote/serverless upload scaffolding is outside the v1 GitHub Pages path and is not exposed as a public CLI workflow.",
      "The supported upload path is the loopback daemon started by Explorer.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });

  it("documents upload-triggered auto-ingest, queue batch/watch usage, and local-agent boundaries", async () => {
    // Arrange
    const requiredDocumentation = [
      "llm-wiki explore serve --profile local --with-daemon --auto-ingest-uploads",
      "llm-wiki queue ingest --auto",
      "llm-wiki queue ingest --auto --limit 5",
      "llm-wiki queue ingest --auto --source-id <source_id>",
      "llm-wiki queue ingest --auto --watch",
      "Upload-triggered and queue auto-ingest both resolve `.llm-wiki/config.yml:agent.default` and require that value to name a configured local agent under `agents.<name>`.",
      "Provider-mode auto-ingest is deferred; `--provider <name>` remains an explicit per-command proposal mode and is not used by upload-triggered or queue auto-ingest.",
      "If `agent.default` is missing or does not point at a configured local agent, upload capture can still succeed, the source stays `queued`, and the auto-ingest result reports the missing-agent problem.",
      "`llm-wiki queue ingest --auto` fails before moving queue items to `ingesting` when no default local agent is configured.",
      "If auto-ingest fails during agent execution, proposal extraction, validation, or application, the source is marked `blocked` and the captured raw upload is not rolled back.",
      "Inspect blocked sources with `llm-wiki queue show <source_id>` and review pages. To retry automation, run `llm-wiki queue set-status <source_id> queued` and then `llm-wiki ingest <source_id> --auto`; after manual repairs, run `llm-wiki ingest <source_id> --validate`.",
      "Duplicate uploads do not create a second ingest when the existing source is already `ingested`; if the duplicate is still `queued`, upload-triggered auto-ingest may attempt the existing queue item.",
      "Auto-ingest never builds, commits curated files, snapshots, deploys, publishes, or enables uploads on GitHub Pages.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });

  it("does not advertise removed standalone daemon or remote upload scaffold commands", async () => {
    // Arrange
    const removedPublicCommandDocs = [
      ["llm-wiki", "daemon"].join(" "),
      ["llm-wiki", "upload", "init", "--target", "github"].join(" "),
      ["`daemon`", "starts"].join(" "),
      ["`upload", "init", "--target", "github`"].join(" "),
      ["remote upload scaffold", "generation"].join(" "),
    ];

    // Act
    const readme = await readReadme();

    // Assert
    expect(readme).toContain("The standalone daemon and remote upload scaffold commands are not part of the v1 public CLI.");
    for (const removedText of removedPublicCommandDocs) {
      expect(readme).not.toContain(removedText);
    }
  });

  it("marks legacy remote/serverless scaffold files as unsupported migration debris for GitHub Pages", async () => {
    // Arrange
    const requiredMigrationGuidance = [
      "`upload/github/serverless/README.md`",
      "`upload/github/serverless/functions/raw-upload.ts`",
      "`upload/github/serverless/package.json`",
      "`upload/github/serverless/wrangler.toml`",
      "Treat existing `upload/github/serverless/*` files as unsupported migration debris for GitHub Pages.",
      "They are not a Pages upload path and should not be wired into public or `github-pages` profiles.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredMigrationGuidance) {
      expect(readme).toContain(expectedText);
    }
  });

  it("maps generated review pages to their canonical repository data sources", async () => {
    // Arrange
    const requiredDocumentation = [
      "`llm-wiki explore sync --profile review` and local profile sync generate `_llm-wiki/review/overview.md`, `source-queue.md`, `recent-ingests.md`, `needs-review.md`, `contradictions.md`, `orphans.md`, `stale-pages.md`, `visibility-warnings.md`, and `profile-summary.md`.",
      "Review pages are derived from live repository state rather than hidden caches.",
      "`source-queue.md` and queue counts come from `raw/queue/*.json` joined to raw source cards.",
      "`recent-ingests.md` comes from parsed ingest entries in `curated/log.md`.",
      "`needs-review.md` comes from curated page frontmatter.",
      "`contradictions.md` combines curated frontmatter conflict signals with parsed contradiction entries in `curated/log.md`.",
      "`stale-pages.md` combines `next_review` frontmatter with stale-index lint findings.",
      "`orphans.md` comes from the Markdown link graph/orphan scanner.",
      "`visibility-warnings.md` and `profile-summary.md` come from lint results, profile selection rules, and public/private visibility checks.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });

  it("documents local-only daemon token privacy and public output exclusions", async () => {
    // Arrange
    const requiredDocumentation = [
      "Upload tokens are generated per daemon run, written only to local runtime metadata, and must never be committed.",
      "`_llm-wiki/runtime/local-daemon.json` is generated only for local/review Explorer runtime use and is excluded from public and GitHub Pages output.",
      "Strict public lint validates live repository inputs selected for public output; it does not scan existing local/review artifacts already under `quartz/content`, so run public sync/build before publishing to regenerate Quartz output without local runtime metadata, daemon tokens, queue data, private review pages, raw source cards, or raw originals.",
      "The local daemon binds to loopback (`127.0.0.1`, `localhost`, or `::1`) so browser uploads stay on the same machine by default.",
      "writes local/review preview output under ignored `.llm-wiki/cache/` storage instead of committed `quartz/public`",
      "Local/review Explorer serve writes its preview files under ignored `.llm-wiki/cache/` storage rather than `quartz/public`, which is reserved for committed Pages output.",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });
});
