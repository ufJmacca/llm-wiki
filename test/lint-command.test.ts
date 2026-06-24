import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { captureFileSource, type SourceCaptureSuccess } from "../src/sourceCapture/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type LintIssue = {
  rule_id: string;
  severity: "error" | "warning";
  path: string;
  line?: number;
  message: string;
  fix_hint: string;
  fixable: boolean;
};

type LintFailureEnvelope = {
  ok: false;
  command: "lint";
  repo: string;
  error: {
    code: "lint_failed";
    message: string;
    hint: string;
  };
  issues: LintIssue[];
};

type LintSuccessEnvelope = {
  ok: true;
  command: "lint";
  repo: string;
  data: {
    issues: LintIssue[];
    counts: {
      total: number;
      error: number;
      warning: number;
      fixed: number;
    };
    fixed_paths: string[];
  };
  warnings: string[];
};

const supportsUnreadableFileTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function captureSource(
  wikiDir: string,
  workspaceDir: string,
  title = "Research Note",
  content = `# ${title}\n\nRaw observation.\n`,
): Promise<SourceCaptureSuccess["source"]> {
  const sourcePath = resolve(workspaceDir, `${title}.md`);
  await writeFile(sourcePath, content, "utf8");

  const capture = await captureFileSource({
    repoRoot: wikiDir,
    sourcePath,
    title,
    now: new Date("2026-06-17T11:28:42.778Z"),
    command: `llm-wiki add ${title}.md --title ${title}`,
  });

  expect(capture.ok).toBe(true);
  if (!capture.ok) {
    throw new Error(capture.error.message);
  }

  return capture.value.source;
}

function parseLintFailure(stdout: string[]): LintFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as LintFailureEnvelope;
}

function parseLintSuccess(stdout: string[]): LintSuccessEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as LintSuccessEnvelope;
}

function issueByRule(issues: LintIssue[], ruleId: string): LintIssue {
  const issue = issues.find((candidate) => candidate.rule_id === ruleId);
  expect(issue, `expected lint issue ${ruleId}`).toBeDefined();

  if (issue === undefined) {
    throw new Error(`expected lint issue ${ruleId}`);
  }

  return issue;
}

function issueByRuleAndPath(issues: LintIssue[], ruleId: string, path: string): LintIssue {
  const issue = issues.find((candidate) => candidate.rule_id === ruleId && candidate.path === path);
  expect(issue, `expected lint issue ${ruleId} at ${path}`).toBeDefined();

  if (issue === undefined) {
    throw new Error(`expected lint issue ${ruleId} at ${path}`);
  }

  return issue;
}

function expectStableIssueRecord(issue: LintIssue): void {
  const expectedKeys = ["fix_hint", "fixable", "message", "path", "rule_id", "severity"];
  if ("line" in issue) {
    expectedKeys.push("line");
  }

  expect(Object.keys(issue).sort()).toEqual(expectedKeys.sort());
  expect(issue.rule_id).toEqual(expect.any(String));
  expect(issue.rule_id).not.toHaveLength(0);
  expect(["error", "warning"]).toContain(issue.severity);
  expect(issue.path).toEqual(expect.any(String));
  expect(issue.path).not.toHaveLength(0);
  if ("line" in issue) {
    expect(Number.isInteger(issue.line)).toBe(true);
    expect(issue.line).toBeGreaterThan(0);
  }
  expect(issue.message).toEqual(expect.any(String));
  expect(issue.message).not.toHaveLength(0);
  expect(issue.fix_hint).toEqual(expect.any(String));
  expect(issue.fix_hint).not.toHaveLength(0);
  expect(typeof issue.fixable).toBe("boolean");
}

function expectStableIssueRecords(issues: LintIssue[]): void {
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) {
    expectStableIssueRecord(issue);
  }
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, "utf8");
}

describe("lint command", () => {
  it.skipIf(!supportsUnreadableFileTest)("returns a JSON failure envelope when repository scanning fails", async () => {
    await withTempWorkspace("llm-wiki-lint-scan-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const unreadablePath = resolve(wikiDir, "curated/unreadable.md");
      await writeFile(
        unreadablePath,
        "---\ntype: page\ntitle: Unreadable\nvisibility: private\nsource_ids: []\n---\n\n# Unreadable\n",
        "utf8",
      );
      await chmod(unreadablePath, 0o000);

      let result;
      try {
        // Act
        result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      } finally {
        await chmod(unreadablePath, 0o600);
      }

      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "lint",
        repo: wikiDir,
        error: {
          code: "lint_failed",
          message: "Lint failed while scanning repository.",
          hint: expect.any(String),
        },
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          rule_id: "lint_scan_failed",
          severity: "error",
          path: ".",
          fixable: false,
        }),
      ]);
    });
  });

  it("does not treat scaffold templates as live wiki content", async () => {
    await withTempWorkspace("llm-wiki-lint-templates-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).toEqual([]);
    });
  });

  it("reports a missing required runtime log", async () => {
    await withTempWorkspace("llm-wiki-lint-missing-runtime-log-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await rm(resolve(wikiDir, "curated/log.md"));

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRule(payload.issues, "runtime_log_missing")).toMatchObject({
        severity: "error",
        path: "curated/log.md",
        fixable: false,
      });
    });
  });

  it("does not treat captured raw originals as live wiki Markdown", async () => {
    await withTempWorkspace("llm-wiki-lint-raw-originals-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const sourcePath = resolve(workspaceDir, "Raw Note.md");
      await writeFile(sourcePath, "# Raw Note\n\nCaptured raw [[unresolved]] link.\n", "utf8");

      const capture = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Raw Note",
        now: new Date("2026-06-17T11:28:42.778Z"),
        command: "llm-wiki add Raw Note.md --title Raw Note",
      });
      expect(capture.ok).toBe(true);
      if (!capture.ok) {
        throw new Error(capture.error.message);
      }

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).toEqual([
        expect.objectContaining({
          rule_id: "index_stale",
          severity: "warning",
          path: "curated/index.md",
        }),
      ]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "wikilink_broken",
          path: capture.value.source.original_path,
        }),
      );
    });
  });

  it("does not treat raw-derived Markdown as live wiki Markdown", async () => {
    await withTempWorkspace("llm-wiki-lint-raw-derived-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const extractedPath = source.original_path.replace(/\/original\.[^/]+$/, "/extracted.md");
      await writeFile(resolve(wikiDir, extractedPath), "# Extracted\n\nCaptured raw [[unresolved raw link]].\n", "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).toEqual([
        expect.objectContaining({
          rule_id: "index_stale",
          severity: "warning",
          path: "curated/index.md",
        }),
      ]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "wikilink_broken",
          path: extractedPath,
        }),
      );
    });
  });

  it("resolves same-page heading wikilinks against the current page", async () => {
    await withTempWorkspace("llm-wiki-lint-same-page-heading-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/heading-link.md",
        { type: "topic", title: "Heading Link", visibility: "private", source_ids: [source.source_id] },
        "# Heading Link\n\nJump to [[#Details]].\n\n## Details\n\nSame page target.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "wikilink_broken",
          path: "curated/topics/heading-link.md",
        }),
      );
    });
  });

  it("reports wikilinks to existing pages with missing headings", async () => {
    await withTempWorkspace("llm-wiki-lint-target-heading-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/target-page.md",
        { type: "topic", title: "Target Page", visibility: "private", source_ids: [source.source_id] },
        "# Target Page\n\n## Present Heading\n\nTarget content.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/heading-link.md",
        { type: "topic", title: "Heading Link", visibility: "private", source_ids: [source.source_id] },
        "# Heading Link\n\nJump to [[Target Page#Missing Heading]].\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "wikilink_broken", "curated/topics/heading-link.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("reports wikilinks whose normalized target is empty", async () => {
    await withTempWorkspace("llm-wiki-lint-empty-normalized-wikilink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/empty-target.md",
        { type: "topic", title: "Empty Target", visibility: "private", source_ids: [source.source_id] },
        "# Empty Target\n\nBroken punctuation-only link: [[!!!]].\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "wikilink_broken", "curated/topics/empty-target.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("!!!"),
        fixable: false,
      });
    });
  });

  it("checks raw source hash drift from ingested source cards after queue records are removed", async () => {
    await withTempWorkspace("llm-wiki-lint-card-hash-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, source.original_path), "# Research Note\n\nTampered after ingest.\n", "utf8");
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path)).replace("status: queued", "status: ingested"),
        "utf8",
      );
      await rm(resolve(wikiDir, source.queue_path));
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: source.title, visibility: "private", source_ids: [source.source_id] },
        "# Research Note\n\nSummary linked to [[Companion Source Page]].\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/companion-source-page.md",
        { type: "topic", title: "Companion Source Page", visibility: "private", source_ids: [source.source_id] },
        `# Companion Source Page\n\nBack to [[${source.title}]].\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "raw_hash_drift", source.original_path)).toMatchObject({
        severity: "error",
        path: source.original_path,
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "source_card_queue_missing",
          path: source.source_card_path,
        }),
      );
    });
  });

  it("emits stable JSON issue records and fails on critical repo integrity issues", async () => {
    await withTempWorkspace("llm-wiki-lint-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const missingCardSourceId = "src_2026_06_17_missing_card_111111111111";
      const noQueueSourceId = "src_2026_06_17_no_queue_222222222222";
      const ingestedSourceId = "src_2026_06_17_ingested_333333333333";

      await writeFile(resolve(wikiDir, source.original_path), "# Research Note\n\nTampered.\n", "utf8");
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        `---\ntype: [\n---\n\n# Broken source card\n`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, `raw/queue/${missingCardSourceId}.json`),
        `${JSON.stringify(
          {
            kind: "text",
            source_id: missingCardSourceId,
            title: "Missing card",
            source_kind: "text",
            origin: "pasted_text",
            captured_at: "2026-06-17T11:28:42.778Z",
            content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            status: "queued",
            visibility: "private",
            path: `raw/inputs/2026/06/${missingCardSourceId}/_source.md`,
            original_path: `raw/inputs/2026/06/${missingCardSourceId}/original.md`,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(resolve(wikiDir, `raw/inputs/2026/06/${noQueueSourceId}`), { recursive: true });
      await writeFile(
        resolve(wikiDir, `raw/inputs/2026/06/${noQueueSourceId}/_source.md`),
        `---
type: raw_source
source_id: ${noQueueSourceId}
title: No queue
source_kind: text
origin: pasted_text
captured_at: 2026-06-17T11:28:42.778Z
content_hash: sha256:2222222222222222222222222222222222222222222222222222222222222222
status: queued
visibility: private
---

# No queue
`,
        "utf8",
      );
      await mkdir(resolve(wikiDir, `raw/inputs/2026/06/${ingestedSourceId}`), { recursive: true });
      await writeFile(
        resolve(wikiDir, `raw/inputs/2026/06/${ingestedSourceId}/_source.md`),
        `---
type: raw_source
source_id: ${ingestedSourceId}
title: Ingested without summary
source_kind: text
origin: pasted_text
captured_at: 2026-06-17T11:28:42.778Z
content_hash: sha256:3333333333333333333333333333333333333333333333333333333333333333
status: ingested
visibility: private
---

# Ingested without summary
`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, `raw/queue/${ingestedSourceId}.json`),
        `${JSON.stringify(
          {
            kind: "text",
            source_id: ingestedSourceId,
            title: "Ingested without summary",
            source_kind: "text",
            origin: "pasted_text",
            captured_at: "2026-06-17T11:28:42.778Z",
            content_hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            status: "ingested",
            visibility: "private",
            path: `raw/inputs/2026/06/${ingestedSourceId}/_source.md`,
            original_path: `raw/inputs/2026/06/${ingestedSourceId}/original.md`,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/missing-provenance.md",
        { type: "topic", title: "Missing provenance", visibility: "private" },
        "# Missing provenance\n\nLinks to [[Definitely Missing]].\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        `${await readGeneratedFile(wikiDir, "curated/log.md")}\n## [2026-06-17 11:28:42] add | ${source.source_id} | Bad timestamp\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(Object.keys(payload)).toEqual(["ok", "command", "repo", "error", "issues"]);
      expect(payload.error).toEqual({
        code: "lint_failed",
        message: expect.stringContaining("Lint found"),
        hint: "Fix error-severity lint issues, or rerun with --fix for deterministic safe repairs.",
      });
      expectStableIssueRecords(payload.issues);
      expect(issueByRule(payload.issues, "raw_hash_drift")).toMatchObject({
        severity: "error",
        path: source.original_path,
        fixable: false,
      });
      expect(issueByRule(payload.issues, "source_card_malformed")).toMatchObject({
        severity: "error",
        path: source.source_card_path,
        line: 2,
      });
      expect(issueByRule(payload.issues, "queue_source_card_missing")).toMatchObject({
        severity: "error",
        path: `raw/queue/${missingCardSourceId}.json`,
        fixable: false,
      });
      expect(issueByRule(payload.issues, "source_card_queue_missing")).toMatchObject({
        severity: "warning",
        path: `raw/inputs/2026/06/${noQueueSourceId}/_source.md`,
      });
      expect(issueByRule(payload.issues, "ingested_source_summary_missing")).toMatchObject({
        severity: "error",
        path: `raw/inputs/2026/06/${ingestedSourceId}/_source.md`,
      });
      expect(issueByRule(payload.issues, "curated_source_ids_missing")).toMatchObject({
        severity: "error",
        path: "curated/topics/missing-provenance.md",
      });
      expect(issueByRule(payload.issues, "log_heading_malformed")).toMatchObject({
        severity: "error",
        path: "curated/log.md",
      });
      expect(issueByRule(payload.issues, "index_stale")).toMatchObject({
        severity: "warning",
        path: "curated/index.md",
        fix_hint: "Run llm-wiki lint --fix to regenerate deterministic index entries.",
        fixable: true,
      });
      expect(issueByRule(payload.issues, "wikilink_broken")).toMatchObject({
        severity: "error",
        path: "curated/topics/missing-provenance.md",
        line: expect.any(Number),
      });
    });
  });

  it("reports source cards with non-scalar required metadata", async () => {
    await withTempWorkspace("llm-wiki-lint-source-card-scalar-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path)).replace(/^source_id: .+$/m, "source_id: []"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "source_card_malformed", source.source_card_path)).toMatchObject({
        severity: "error",
        fixable: false,
      });
    });
  });

  it("reports source cards with unsupported source_kind values", async () => {
    await withTempWorkspace("llm-wiki-lint-source-card-kind-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await rm(resolve(wikiDir, source.queue_path));
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path)).replace(/^source_kind: .+$/m, "source_kind: weird"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "source_card_malformed", source.source_card_path)).toMatchObject({
        severity: "error",
        message: 'Source card has unsupported source_kind "weird".',
        fix_hint: "Use file, text, or url.",
        fixable: false,
      });
    });
  });

  it("reports queue/source-card metadata mismatches when both artifacts exist", async () => {
    await withTempWorkspace("llm-wiki-lint-queue-mismatch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queuePath = `raw/queue/${source.source_id}.json`;
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, queuePath)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, queuePath),
        `${JSON.stringify({ ...queueRecord, title: "Queue title drift" }, null, 2)}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRule(payload.issues, "queue_source_card_mismatch")).toMatchObject({
        severity: "error",
        path: queuePath,
        message: expect.stringContaining(source.source_id),
        fix_hint: "Use llm-wiki queue set-status or restore matching queue/source-card metadata.",
        fixable: false,
      });
    });
  });

  it("reports queue items missing original_path as malformed queue JSON", async () => {
    await withTempWorkspace("llm-wiki-lint-queue-missing-original-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      delete queueRecord.original_path;
      await writeFile(resolve(wikiDir, source.queue_path), `${JSON.stringify(queueRecord, null, 2)}\n`, "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "queue_item_malformed", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining('missing required string field "original_path"'),
        fix_hint: expect.stringContaining('Add a non-empty "original_path" value'),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "raw_original_missing",
        }),
      );
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          path: "undefined",
        }),
      );
    });
  });

  it("reports queue items with empty original_path extensions as malformed before raw hash checks", async () => {
    await withTempWorkspace("llm-wiki-lint-queue-empty-original-extension-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      const malformedOriginalPath = source.original_path.replace(/original\.[^/]+$/, "original.");
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify({ ...queueRecord, original_path: malformedOriginalPath }, null, 2)}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "queue_item_malformed", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("original_path"),
        fix_hint: "Keep original_path pointed at raw/inputs/YYYY/MM/<source_id>/original.<ext> for the same source ID.",
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "raw_original_missing",
          path: malformedOriginalPath,
        }),
      );
    });
  });

  it("reports queue/source-card origin_url provenance drift for URL captures", async () => {
    await withTempWorkspace("llm-wiki-lint-url-origin-mismatch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path))
          .replace(/^source_kind: file$/m, "source_kind: url")
          .replace(/^origin: .*$/m, "origin: url")
          .replace(/^origin_url: null$/m, "origin_url: https://example.test/original"),
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify(
          {
            ...queueRecord,
            kind: "url",
            source_kind: "url",
            origin: "url",
            origin_url: "https://example.test/edited",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "queue_source_card_mismatch", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("origin_url"),
        fixable: false,
      });
    });
  });

  it("rejects public visibility on raw source cards and queue records", async () => {
    await withTempWorkspace("llm-wiki-lint-raw-source-public-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path)).replace(/^visibility: private$/m, "visibility: public"),
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify({ ...queueRecord, visibility: "public" }, null, 2)}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "raw_sources_default_private", source.source_card_path)).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "raw_sources_default_private", source.queue_path)).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "queue_source_card_mismatch",
        }),
      );
    });
  });

  it("rejects unsupported queue kinds during consistency lint", async () => {
    await withTempWorkspace("llm-wiki-lint-queue-kind-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify({ ...queueRecord, kind: "bogus" }, null, 2)}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "queue_item_malformed", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining('unsupported kind "bogus"'),
        fix_hint: "Use supported kind/source_kind values and keep them aligned.",
        fixable: false,
      });
    });
  });

  it("reports queue files whose filenames do not match their source IDs", async () => {
    await withTempWorkspace("llm-wiki-lint-queue-filename-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueContent = await readGeneratedFile(wikiDir, source.queue_path);
      await writeFile(resolve(wikiDir, "raw/queue/wrong.json"), queueContent, "utf8");
      await rm(resolve(wikiDir, source.queue_path));

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "queue_item_malformed", "raw/queue/wrong.json")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("does not match source ID"),
        fix_hint: "Name queue files as raw/queue/<source_id>.json.",
        fixable: false,
      });
    });
  });

  it("reports curated frontmatter missing, invalid, and malformed cases through lint JSON", async () => {
    await withTempWorkspace("llm-wiki-lint-curated-frontmatter-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "curated/topics"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "curated/topics/no-frontmatter.md"),
        "# No Frontmatter\n\nA curated page with no metadata.\n",
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-type.md",
        { type: "spaceship", title: "Invalid Type", visibility: "private", source_ids: [source.source_id] },
        "# Invalid Type\n\nMetadata has an unsupported type.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/missing-type.md",
        { title: "Missing Type", visibility: "private", source_ids: [source.source_id] },
        "# Missing Type\n\nMetadata is missing type.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/missing-title.md",
        { type: "topic", visibility: "private", source_ids: [source.source_id] },
        "# Missing Title\n\nMetadata is missing title.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/missing-visibility.md",
        { type: "topic", title: "Missing Visibility", source_ids: [source.source_id] },
        "# Missing Visibility\n\nMetadata is missing visibility.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-title.md",
        { type: "topic", title: ["Invalid Title"], visibility: "private", source_ids: [source.source_id] },
        "# Invalid Title\n\nMetadata has a non-string title.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-visibility.md",
        { type: "topic", title: "Invalid Visibility", visibility: "secret", source_ids: [source.source_id] },
        "# Invalid Visibility\n\nMetadata has unsupported visibility.\n",
      );
      await mkdir(resolve(wikiDir, "curated/topics/dist"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "curated/topics/dist/no-frontmatter.md"),
        "# Dist Directory Page\n\nThis page should still be scanned.\n",
        "utf8",
      );
      await mkdir(resolve(wikiDir, "curated/topics/node_modules"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "curated/topics/node_modules/no-frontmatter.md"),
        "# Node Modules Directory Page\n\nThis dependency-shaped path should be skipped.\n",
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "curated/topics/malformed-frontmatter.md"),
        "---\ntype: [\n---\n\n# Malformed Frontmatter\n",
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_missing", "curated/topics/no-frontmatter.md")).toMatchObject({
        severity: "error",
        path: "curated/topics/no-frontmatter.md",
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "frontmatter_type_invalid", "curated/topics/invalid-type.md")).toMatchObject({
        severity: "error",
        path: "curated/topics/invalid-type.md",
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_required_missing", "curated/topics/missing-type.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("type"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_required_missing", "curated/topics/missing-title.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("title"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_required_missing", "curated/topics/missing-visibility.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("visibility"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/invalid-title.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("title"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/invalid-visibility.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("visibility"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_missing", "curated/topics/dist/no-frontmatter.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(payload.issues.some((issue) => issue.path === "curated/topics/node_modules/no-frontmatter.md")).toBe(
        false,
      );
      expect(issueByRuleAndPath(payload.issues, "frontmatter_malformed", "curated/topics/malformed-frontmatter.md")).toMatchObject({
        severity: "error",
        path: "curated/topics/malformed-frontmatter.md",
        line: 2,
        fixable: false,
      });
    });
  });

  it("reports invalid curated source_ids entries through lint JSON", async () => {
    await withTempWorkspace("llm-wiki-lint-curated-source-ids-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-source-ids.md",
        { type: "topic", title: "Invalid Source IDs", visibility: "private", source_ids: [123, "not-a-source-id"] },
        "# Invalid Source IDs\n\nThe provenance array has unusable IDs.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);
      const invalidIssues = payload.issues.filter((issue) => issue.rule_id === "curated_source_ids_invalid");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(invalidIssues).toHaveLength(2);
      expect(invalidIssues).toEqual([
        expect.objectContaining({
          severity: "error",
          path: "curated/topics/invalid-source-ids.md",
          message: expect.stringContaining("entry 0"),
          fixable: false,
        }),
        expect.objectContaining({
          severity: "error",
          path: "curated/topics/invalid-source-ids.md",
          message: expect.stringContaining("entry 1"),
          fixable: false,
        }),
      ]);
    });
  });

  it("counts standard Markdown links as inbound curated links for orphan lint", async () => {
    await withTempWorkspace("llm-wiki-lint-markdown-link-orphans-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linked-target.md",
        { type: "topic", title: "Linked Target", visibility: "private", source_ids: [source.source_id] },
        "# Linked Target\n\nReached through a standard Markdown link.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linking-page.md",
        { type: "topic", title: "Linking Page", visibility: "private", source_ids: [source.source_id] },
        "# Linking Page\n\nSee [Linked Target](linked-target.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "orphan_page",
          path: "curated/topics/linked-target.md",
        }),
      );
    });
  });

  it("ignores self-links when detecting orphan pages", async () => {
    await withTempWorkspace("llm-wiki-lint-self-link-orphans-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/self-linked.md",
        { type: "topic", title: "Self Linked", visibility: "private", source_ids: [source.source_id] },
        "# Self Linked\n\n- [Intro](#intro)\n- [[#Intro]]\n\n## Intro\n\nLocal table of contents only.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.data.issues, "orphan_page", "curated/topics/self-linked.md")).toMatchObject({
        severity: "warning",
        fixable: false,
      });
    });
  });

  it("reports orphan pages through lint JSON without failing the command", async () => {
    await withTempWorkspace("llm-wiki-lint-orphans-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/orphan-page.md",
        { type: "topic", title: "Orphan Page", visibility: "private", source_ids: [source.source_id] },
        "# Orphan Page\n\nNo curated page links here yet.\n",
      );
      const rebuildResult = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      expect(rebuildResult.exitCode).toBe(0);

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.data.issues);
      expect(issueByRule(payload.data.issues, "orphan_page")).toMatchObject({
        severity: "warning",
        path: "curated/topics/orphan-page.md",
        fix_hint: "Link this page from a related curated page or index it intentionally in navigation.",
        fixable: false,
      });
    });
  });

  it("does not run strict public leak checks for ordinary profile lint", async () => {
    await withTempWorkspace("llm-wiki-lint-profile-nonstrict-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).toEqual([]);
    });
  });

  it("reports explicitly requested missing profiles outside strict mode", async () => {
    await withTempWorkspace("llm-wiki-lint-profile-missing-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await rm(resolve(wikiDir, ".llm-wiki/profiles/public.yml"));

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "profile_missing", ".llm-wiki/profiles/public.yml")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("public"),
        fixable: false,
      });
    });
  });

  it("reports duplicate requested profile files during strict lint", async () => {
    await withTempWorkspace("llm-wiki-lint-profile-duplicate-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yaml"), publicProfile, "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "profile_duplicate", ".llm-wiki/profiles/public.yml")).toMatchObject({
        severity: "error",
        message: "Duplicate profile files found for public: .llm-wiki/profiles/public.yml, .llm-wiki/profiles/public.yaml.",
        fix_hint: "Keep exactly one profile file for each name; remove either the .yml or .yaml variant before syncing Quartz content.",
        fixable: false,
      });
    });
  });

  it("surfaces malformed requested profiles outside strict mode", async () => {
    await withTempWorkspace("llm-wiki-lint-profile-malformed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include: [
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "profile_malformed", ".llm-wiki/profiles/public.yml")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
        }),
      );
    });
  });

  it("fails public strict when root curated private pages are selected", async () => {
    await withTempWorkspace("llm-wiki-lint-public-root-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_page_selected", "curated/home.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          path: ".llm-wiki/templates/source-card.md",
        }),
      );
    });
  });

  it("treats profile globstar directories as optional for root curated pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-root-globstar-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/**/*.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_page_selected", "curated/home.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
    });
  });

  it("fails public strict when the public profile requires private visibility", async () => {
    await withTempWorkspace("llm-wiki-lint-public-profile-private-required-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/home.md
exclude: []
visibility:
  include_private: false
  required_value: private
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_profile_visibility_invalid", ".llm-wiki/profiles/public.yml")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("visibility: public"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_private_page_selected", "curated/home.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
    });
  });

  it("ignores scaffold placeholders selected by the generated public profile", async () => {
    await withTempWorkspace("llm-wiki-lint-public-gitkeep-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      for (const title of ["Contradictions", "Home", "Map", "Open Questions"]) {
        const slug = title.toLowerCase().replaceAll(" ", "-");
        await writeCuratedPage(
          wikiDir,
          `curated/${slug}.md`,
          { type: "page", title, visibility: "public", source_ids: [] },
          `# ${title}\n`,
        );
      }
      await writeCuratedPage(
        wikiDir,
        "curated/index.md",
        { type: "index", title: "Index", visibility: "public", source_ids: [] },
        `# Index

## Overview

## Sources

| Source | Status | Summary | Key pages |
|---|---|---|---|

## Concepts

| Page | Summary | Source count | Updated |
|---|---:|---:|---|

## Entities

## Topics

## Questions
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_non_markdown_file_selected",
        }),
      );
      expect(payload.data.issues.filter((issue) => issue.path.endsWith("/.gitkeep"))).toEqual([]);
    });
  });

  it("fails public strict when non-Markdown files are selected", async () => {
    await withTempWorkspace("llm-wiki-lint-public-non-markdown-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/secret.txt
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeFile(resolve(wikiDir, "curated/secret.txt"), "private attachment text\n", "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_non_markdown_file_selected", "curated/secret.txt")).toMatchObject({
        severity: "error",
        path: "curated/secret.txt",
        message: expect.stringContaining("non-Markdown"),
        fixable: false,
      });
    });
  });

  it("fails public strict when selected internal config files are skipped by normal scans", async () => {
    await withTempWorkspace("llm-wiki-lint-public-skipped-config-selected-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - .llm-wiki/**
exclude:
  - .llm-wiki/cache
  - .llm-wiki/cache/**
  - .llm-wiki/templates/**
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_non_markdown_file_selected", ".llm-wiki/config.yml")).toMatchObject({
        severity: "error",
        path: ".llm-wiki/config.yml",
        message: expect.stringContaining("non-Markdown"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_non_markdown_file_selected", ".llm-wiki/schema.yml")).toMatchObject({
        severity: "error",
        path: ".llm-wiki/schema.yml",
        message: expect.stringContaining("non-Markdown"),
        fixable: false,
      });
    });
  });

  it("fails public strict when skipped cache files are selected", async () => {
    await withTempWorkspace("llm-wiki-lint-public-cache-selected-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const rebuildResult = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      expect(rebuildResult.exitCode).toBe(0);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - .llm-wiki/cache/**
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", ".llm-wiki/cache")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("skipped generated/private data"),
        fix_hint: expect.stringContaining(".llm-wiki/cache/**"),
        fixable: false,
      });
    });
  });

  it("treats cache descendant excludes as covering the skipped cache root", async () => {
    await withTempWorkspace("llm-wiki-lint-public-cache-root-excluded-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const rebuildResult = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      expect(rebuildResult.exitCode).toBe(0);
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/index.md
  - .llm-wiki/cache
  - .llm-wiki/cache/**
exclude:
  - .llm-wiki/cache/**
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_skipped_private_path_selected",
          path: ".llm-wiki/cache",
        }),
      );
    });
  });

  it("fails public strict when selected curated pages use raw source metadata", async () => {
    await withTempWorkspace("llm-wiki-lint-public-curated-raw-source-type-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/raw-source-page.md",
        { type: "raw_source", title: "Raw Source Page", visibility: "public", source_ids: [source.source_id] },
        "# Raw Source Page\n\nThis metadata type belongs only to raw source cards.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/raw-source-page.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("raw_source"),
        fix_hint: "Use a curated page type; raw_source is only valid for raw source cards.",
        fixable: false,
      });
    });
  });

  it("fails closed for public strict profile leaks before output can include private or raw content", async () => {
    await withTempWorkspace("llm-wiki-lint-public-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/**
  - raw/queue/**
  - raw/inputs/**/_source.md
  - raw/inputs/**/original.*
  - notes/**
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "notes/private-note.md",
        { type: "page", title: "Private Note", visibility: "private", source_ids: [source.source_id] },
        "# Private Note\n\nPrivate non-curated note.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [[Private Topic]] and [[${source.original_path}|raw original]].\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_page_selected", "curated/topics/private-topic.md")).toMatchObject({
        severity: "error",
        path: "curated/topics/private-topic.md",
        fixable: false,
      });
      expect(issueByRule(payload.issues, "public_raw_original_selected")).toMatchObject({
        severity: "error",
        path: source.original_path,
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_file_selected", source.queue_path)).toMatchObject({
        severity: "error",
        path: source.queue_path,
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_source_card_selected", source.source_card_path)).toMatchObject({
        severity: "error",
        path: source.source_card_path,
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_private_page_selected", "notes/private-note.md")).toMatchObject({
        severity: "error",
        path: "notes/private-note.md",
        fixable: false,
      });
      expect(issueByRule(payload.issues, "public_private_link")).toMatchObject({
        severity: "error",
        path: "curated/topics/public-topic.md",
        line: expect.any(Number),
      });
      expect(issueByRule(payload.issues, "public_raw_link")).toMatchObject({
        severity: "error",
        path: "curated/topics/public-topic.md",
        line: expect.any(Number),
      });
      expect(issueByRule(payload.issues, "public_graph_private_node_leak")).toMatchObject({
        severity: "error",
        path: "curated/topics/public-topic.md",
      });
      expect(issueByRuleAndPath(payload.issues, "public_search_private_text_leak", "curated/topics/private-topic.md")).toMatchObject({
        severity: "error",
        path: "curated/topics/private-topic.md",
      });
      expect(issueByRuleAndPath(payload.issues, "public_search_private_text_leak", "notes/private-note.md")).toMatchObject({
        severity: "error",
        path: "notes/private-note.md",
      });
    });
  });

  it("detects private and raw wikilinks with bracketed aliases in strict public lint", async () => {
    await withTempWorkspace("llm-wiki-lint-public-wikilink-bracket-alias-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [[Private Topic|alias ] text]] and [[${source.original_path}|raw ] original]].\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
      });
    });
  });

  it("resolves relative Markdown links to sibling pages before root curated pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-relative-link-shadow-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/a.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/b.md",
        { type: "page", title: "Root B", visibility: "public", source_ids: [source.source_id] },
        "# Root B\n\nPublic root page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/b.md",
        { type: "topic", title: "Private B", visibility: "private", source_ids: [source.source_id] },
        "# Private B\n\nPrivate sibling page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/a.md",
        { type: "topic", title: "Public A", visibility: "public", source_ids: [source.source_id] },
        "# Public A\n\nLinks to [B](b.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/topics/b.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/a.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[B](b.md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/a.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for public Markdown links to internal config files skipped by normal scans", async () => {
    await withTempWorkspace("llm-wiki-lint-public-skipped-config-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/a.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/a.md",
        { type: "topic", title: "Public A", visibility: "public", source_ids: [source.source_id] },
        "# Public A\n\nLinks to [internal config](../../.llm-wiki/config.yml).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/a.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[internal config](../../.llm-wiki/config.yml)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/a.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("checks resolved public link targets before unresolved raw-path heuristics", async () => {
    await withTempWorkspace("llm-wiki-lint-public-resolved-raw-directory-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/page.md
  - curated/topics/raw/guide.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/raw/guide.md",
        { type: "topic", title: "Raw Guide", visibility: "public", source_ids: [source.source_id] },
        "# Raw Guide\n\nPublic page in a curated raw subdirectory.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/page.md",
        { type: "topic", title: "Page", visibility: "public", source_ids: [source.source_id] },
        "# Page\n\nLinks to [Raw Guide](raw/guide.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_raw_link",
          path: "curated/topics/page.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_link",
          path: "curated/topics/page.md",
        }),
      );
    });
  });

  it("allows resolved public site routes with raw slugs and extensionless root pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-site-routes-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/page.md
  - curated/concepts/raw.md
  - curated/map.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/concepts/raw.md",
        { type: "concept", title: "Raw", visibility: "public", source_ids: [source.source_id] },
        "# Raw\n\nPublic curated route with a raw slug.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/map.md",
        { type: "page", title: "Map", visibility: "public", source_ids: [source.source_id] },
        "# Map\n\nPublic root page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/page.md",
        { type: "topic", title: "Page", visibility: "public", source_ids: [source.source_id] },
        `# Page

Links to [Raw](/concepts/raw) and [Map](/map).

<div title="example data-url=../../raw/foo"></div>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_raw_link",
          path: "curated/topics/page.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_local_file_link",
          path: "curated/topics/page.md",
        }),
      );
    });
  });

  it("fails public strict lint for Markdown links to raw content and private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-markdown-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [private](private-topic.md) and [raw original](../../${source.original_path}).\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private](private-topic.md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw original]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("ignores escaped Markdown link openers during public strict lint", async () => {
    await withTempWorkspace("llm-wiki-lint-public-escaped-markdown-opener-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/public-literals.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/public-literals.md",
        { type: "page", title: "Public Literals", visibility: "public", source_ids: [source.source_id] },
        `# Public Literals

Literal syntax: \\[raw original](../${source.original_path}) and \\[private](private/hidden.md).
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_raw_link",
          path: "curated/public-literals.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_link",
          path: "curated/public-literals.md",
        }),
      );
    });
  });

  it("fails public strict lint for multiline Markdown links to raw content and private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-multiline-markdown-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [private
topic](private-topic.md) and [raw
original](../../${source.original_path}).
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/topics/private-topic.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private\ntopic](private-topic.md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw\noriginal]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for absolute POSIX links into raw content", async () => {
    await withTempWorkspace("llm-wiki-lint-public-posix-raw-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const absoluteRawPath = resolve(wikiDir, source.original_path);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [absolute raw](${absoluteRawPath}).\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[absolute raw]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for entity-encoded Markdown links to raw, private, and local targets", async () => {
    await withTempWorkspace("llm-wiki-lint-public-entity-markdown-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      const encodedRawTarget = `&period;&period;&sol;&period;&period;&sol;${source.original_path.replaceAll("/", "&sol;")}`;
      await writeCuratedPage(
        wikiDir,
        "curated/private/hidden.md",
        { type: "page", title: "Hidden", visibility: "private", source_ids: [source.source_id] },
        "# Hidden\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [raw entity](${encodedRawTarget}), [private entity](..&sol;private&sol;hidden.md), and [local entity](file&colon;&sol;&sol;&sol;tmp&sol;note.txt).
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/private/hidden.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw entity]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private entity]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[local entity]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for blockquoted reference links to raw content and private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-blockquote-reference-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/private/hidden.md",
        { type: "page", title: "Hidden", visibility: "private", source_ids: [source.source_id] },
        "# Hidden\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

> Links to [raw][raw-ref] and [private][private-ref].
> [raw-ref]: ../../${source.original_path}
> [private-ref]: ../private/hidden.md
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw][raw-ref]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private][private-ref]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for raw images nested inside outer Markdown links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-linked-image-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\n[![raw original](../../${source.original_path})](https://example.test/source).\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("![raw original]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for reference-style raw images nested inside outer Markdown links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-inline-linked-reference-image-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "raw/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "raw/assets/secret.png"), "raw", "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

[![raw][raw-ref]](https://example.test/source)

[raw-ref]: ../../raw/assets/secret.png
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const rawLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_raw_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(rawLinkIssues).toHaveLength(1);
      expect(issueByRuleAndPath(rawLinkIssues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("![raw][raw-ref]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for reference-style raw images nested inside outer reference links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-linked-reference-image-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "raw/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "raw/assets/secret.png"), "raw", "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

[![raw][raw-ref]][outer]

[raw-ref]: ../../raw/assets/secret.png
[outer]: https://example.test/source
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("![raw][raw-ref]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for shortcut raw images nested inside outer reference links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-linked-shortcut-image-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "raw/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "raw/assets/secret.png"), "raw", "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

[![raw]][outer]

[raw]: ../../raw/assets/secret.png
[outer]: https://example.test/source
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("![raw]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for shortcut raw images nested inside bracketed shortcut labels", async () => {
    await withTempWorkspace("llm-wiki-lint-public-bracketed-shortcut-image-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "raw/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "raw/assets/secret.png"), "raw", "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

[![raw]]

[raw]: ../../raw/assets/secret.png
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const rawLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_raw_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(rawLinkIssues).toHaveLength(1);
      expect(issueByRuleAndPath(rawLinkIssues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("![raw]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for percent-encoded slash Markdown links to raw originals", async () => {
    await withTempWorkspace("llm-wiki-lint-public-encoded-slash-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const encodedRawTarget = `..%2F..%2F${source.original_path.replaceAll("/", "%2F")}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [raw encoded](${encodedRawTarget}).\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`[raw encoded](${encodedRawTarget})`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for file URL Markdown links to raw originals and local files", async () => {
    await withTempWorkspace("llm-wiki-lint-public-file-url-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalUrl = pathToFileURL(resolve(wikiDir, source.original_path)).href;
      const localNotePath = resolve(workspaceDir, "local note.txt");
      await writeFile(localNotePath, "local-only detail\n", "utf8");
      const localNoteUrl = pathToFileURL(localNotePath).href;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nLinks to [raw file URL](${rawOriginalUrl}) and [local file URL](${localNoteUrl}).\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw file URL]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[local file URL]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for file URL autolinks to raw originals and local files", async () => {
    await withTempWorkspace("llm-wiki-lint-public-autolink-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalUrl = pathToFileURL(resolve(wikiDir, source.original_path)).href;
      const localNotePath = resolve(workspaceDir, "local note.txt");
      await writeFile(localNotePath, "local-only detail\n", "utf8");
      const localNoteUrl = pathToFileURL(localNotePath).href;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic\n\nAutolinks to raw <${rawOriginalUrl}> and local <${localNoteUrl}>.\n`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`<${rawOriginalUrl}>`),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`<${localNoteUrl}>`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for raw HTML href and src links to raw originals and local files", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalUrl = pathToFileURL(resolve(wikiDir, source.original_path)).href;
      const localNotePath = resolve(workspaceDir, "local note.txt");
      await writeFile(localNotePath, "local-only detail\n", "utf8");
      const localNoteUrl = pathToFileURL(localNotePath).href;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<a href="${rawOriginalUrl}">raw original</a>
<img src="${rawOriginalUrl}" alt="raw original">
<iframe src="${localNoteUrl}"></iframe>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "public_raw_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(`href="${rawOriginalUrl}"`),
            fixable: false,
          }),
          expect.objectContaining({
            rule_id: "public_raw_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(`src="${rawOriginalUrl}"`),
            fixable: false,
          }),
          expect.objectContaining({
            rule_id: "public_local_file_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(`src="${localNoteUrl}"`),
            fixable: false,
          }),
        ]),
      );
    });
  });

  it("fails public strict lint for namespaced raw HTML resource links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-namespaced-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawTarget = `../../${source.original_path}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<svg>
  <use xlink:href="${rawTarget}"></use>
</svg>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`xlink:href="${rawTarget}"`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for raw HTML srcset candidates", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-srcset-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawTarget = `../../${source.original_path}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<img
  srcset="safe.png 1x, ${rawTarget} 2x"
  src="safe.png"
  alt="raw original"
>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`srcset="safe.png 1x, ${rawTarget} 2x"`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for raw HTML poster and data resource links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-resource-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawTarget = `../../${source.original_path}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<video poster="${rawTarget}" controls>
  <source src="safe.mp4" type="video/mp4">
</video>
<object data="${rawTarget}" type="text/markdown"></object>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const rawLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_raw_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(rawLinkIssues).toHaveLength(2);
      expect(rawLinkIssues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`poster="${rawTarget}"`),
          expect.stringContaining(`data="${rawTarget}"`),
        ]),
      );
    });
  });

  it("fails public strict lint for raw HTML data-* resource links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-data-attr-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawTarget = `../../${source.original_path}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<div data-url="${rawTarget}" data-src='${rawTarget}'></div>
<a data-href="${rawTarget}">raw original</a>
<img data-srcset="safe.png 1x, ${rawTarget} 2x" alt="raw original">
<img data-lazy-srcset="https://cdn.example/safe.png 1x, ${rawTarget} 2x" alt="raw original">
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const rawLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_raw_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(rawLinkIssues).toHaveLength(5);
      expect(rawLinkIssues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`data-url="${rawTarget}"`),
          expect.stringContaining(`data-src='${rawTarget}'`),
          expect.stringContaining(`data-href="${rawTarget}"`),
          expect.stringContaining(`data-srcset="safe.png 1x, ${rawTarget} 2x"`),
          expect.stringContaining(`data-lazy-srcset="https://cdn.example/safe.png 1x, ${rawTarget} 2x"`),
        ]),
      );
    });
  });

  it("fails public strict lint when generated Quartz content contains upload, review, runtime, or queue leaks", async () => {
    await withTempWorkspace("llm-wiki-lint-public-generated-quartz-leaks-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/index.md",
        { type: "index", title: "Public Index", visibility: "public", source_ids: [] },
        "# Public Index\n\n- [[topics/public-topic|Public Topic]]\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [] },
        "# Public Topic\n\nPublic body.\n",
      );
      await mkdir(resolve(wikiDir, "quartz/content/_llm-wiki/runtime"), { recursive: true });
      await mkdir(resolve(wikiDir, "quartz/content/_llm-wiki/review"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
        `${JSON.stringify(
          {
            enabled: true,
            url: "http://127.0.0.1:32123",
            upload_path: "/api/raw-upload",
            token_header: "x-llm-wiki-upload-token",
            upload_token: "secret-token-that-must-not-be-echoed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/upload.md"),
        "---\ntype: dashboard\ntitle: Upload\nvisibility: private\nllm_wiki_upload: true\n---\n\n# Upload\n",
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/review/overview.md"),
        [
          "---",
          "type: dashboard",
          "title: Private Review Dashboard",
          "visibility: private",
          "llm_wiki_component: LlmWikiReviewPanel",
          "---",
          "",
          "# Private Review Dashboard",
          "",
          "```json",
          JSON.stringify({
            source_id: "src_2026_06_23_private_review_111111",
            queue_path: "raw/queue/src_2026_06_23_private_review_111111.json",
            original_path: "raw/inputs/2026/06/src_2026_06_23_private_review_111111/original.md",
          }),
          "```",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const runtimeIssue = issueByRuleAndPath(
        payload.issues,
        "public_quartz_runtime_metadata_leak",
        "quartz/content/_llm-wiki/runtime/local-daemon.json",
      );
      expect(runtimeIssue).toMatchObject({
        severity: "error",
        message: expect.stringContaining("local daemon metadata"),
        fix_hint: expect.stringContaining("metadata"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_quartz_upload_page_leak", "quartz/content/_llm-wiki/upload.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_quartz_review_page_leak", "quartz/content/_llm-wiki/review/overview.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(payload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "public_quartz_private_data_leak",
            path: "quartz/content/_llm-wiki/review/overview.md",
          }),
        ]),
      );
      expect(JSON.stringify(payload.issues)).not.toContain("secret-token-that-must-not-be-echoed");
    });
  });

  it("fails public strict lint when generated Quartz content contains stale private Markdown frontmatter", async () => {
    await withTempWorkspace("llm-wiki-lint-public-generated-quartz-private-markdown-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/index.md
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/index.md",
        { type: "index", title: "Public Index", visibility: "public", source_ids: [] },
        "# Public Index\n\n- [[topics/public-topic|Public Topic]]\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [] },
        "# Public Topic\n\nPublic body.\n",
      );
      const generatedPath = "quartz/content/curated/topics/stale-private.md";
      await mkdir(resolve(wikiDir, "quartz/content/curated/topics"), { recursive: true });
      await writeFile(
        resolve(wikiDir, generatedPath),
        "---\ntype: topic\ntitle: Stale Private\nvisibility: private\nsource_ids: []\n---\n\n# Stale Private\n\nPrivate body.\n",
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_quartz_private_page_leak", generatedPath)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("non-public Markdown"),
        fix_hint: expect.stringContaining("stale private generated Markdown"),
        fixable: false,
      });
      expect(payload.issues.filter((issue) => issue.path === generatedPath)).toHaveLength(1);
    });
  });

  it.each([
    {
      name: "upload token key",
      fileName: "upload-token-key.md",
      content: "# Generated Public Page\n\nupload_token: secret-token-that-must-not-be-echoed\n",
      expectedMessage: "local upload token metadata",
      secret: "secret-token-that-must-not-be-echoed",
    },
    {
      name: "upload token header",
      fileName: "upload-token-header.md",
      content: "# Generated Public Page\n\nHeader: x-llm-wiki-upload-token\n",
      expectedMessage: "local upload token header metadata",
    },
    {
      name: "raw original path",
      fileName: "raw-original-path.md",
      content: "# Generated Public Page\n\nOriginal: raw/inputs/2026/06/src_2026_06_23_public_leak_111111/original.md\n",
      expectedMessage: "raw original path metadata",
    },
    {
      name: "raw queue path",
      fileName: "raw-queue-path.md",
      content: "# Generated Public Page\n\nQueue: raw/queue/src_2026_06_23_public_leak_111111.json\n",
      expectedMessage: "raw queue metadata",
    },
    {
      name: "queue path key",
      fileName: "queue-path-key.md",
      content: "# Generated Public Page\n\nqueue_path: generated/public-queue.json\n",
      expectedMessage: "raw queue metadata",
    },
    {
      name: "original path key",
      fileName: "original-path-key.md",
      content: "# Generated Public Page\n\noriginal_path: generated/public-original.md\n",
      expectedMessage: "raw queue metadata",
    },
  ])("fails public strict lint when generated Quartz content contains isolated $name marker", async ({ fileName, content, expectedMessage, secret }) => {
    await withTempWorkspace(`llm-wiki-lint-public-generated-quartz-${fileName}-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/index.md
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/index.md",
        { type: "index", title: "Public Index", visibility: "public", source_ids: [] },
        "# Public Index\n\n- [[topics/public-topic|Public Topic]]\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [] },
        "# Public Topic\n\nPublic body.\n",
      );
      const generatedPath = `quartz/content/public/${fileName}`;
      await mkdir(resolve(wikiDir, "quartz/content/public"), { recursive: true });
      await writeFile(resolve(wikiDir, generatedPath), content, "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      const generatedPathIssues = payload.issues.filter((issue) => issue.path === generatedPath);
      expect(generatedPathIssues).toHaveLength(1);
      expect(generatedPathIssues[0]).toMatchObject({
        rule_id: "public_quartz_private_data_leak",
        severity: "error",
        line: 3,
        message: expect.stringContaining(expectedMessage),
        fix_hint: expect.stringContaining("generated runtime, upload, review, raw path, and queue data"),
        fixable: false,
      });
      if (secret) {
        expect(JSON.stringify(payload.issues)).not.toContain(secret);
      }
    });
  });

  it("fails public strict lint for raw HTML media inside Markdown link labels", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-label-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawTarget = `../../${source.original_path}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

[<img src="${rawTarget}" alt="raw original">](https://example.test/source)
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`src="${rawTarget}"`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for entity-encoded raw HTML links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-entity-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const encodedRawTarget = `..&#47;..&#47;${source.original_path.replaceAll("/", "&#47;")}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<a href="${encodedRawTarget}">raw original</a>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`href="${encodedRawTarget}"`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for raw HTML links with backslash path separators", async () => {
    await withTempWorkspace("llm-wiki-lint-public-html-backslash-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalBackslashTarget = `..\\..\\${source.original_path.replaceAll("/", "\\")}`;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<a href='${rawOriginalBackslashTarget}'>raw original</a>
<img src="${rawOriginalBackslashTarget}" alt="raw original">
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "public_raw_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(`href='${rawOriginalBackslashTarget}'`),
            fixable: false,
          }),
          expect.objectContaining({
            rule_id: "public_raw_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(`src="${rawOriginalBackslashTarget}"`),
            fixable: false,
          }),
        ]),
      );
    });
  });

  it("fails public strict lint for Windows drive-letter raw and local links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-windows-drive-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalDriveTarget = `C:\\wiki\\${source.original_path.replaceAll("/", "\\")}`;
      const localDriveTarget = "D:\\notes\\private-note.md";
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [raw drive](${rawOriginalDriveTarget}).
<a href="${localDriveTarget}">local note</a>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`[raw drive](${rawOriginalDriveTarget})`),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining(`href="${localDriveTarget}"`),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for multiline raw HTML links to raw originals and local files", async () => {
    await withTempWorkspace("llm-wiki-lint-public-multiline-html-raw-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const rawOriginalUrl = pathToFileURL(resolve(wikiDir, source.original_path)).href;
      const localNotePath = resolve(workspaceDir, "local note.txt");
      await writeFile(localNotePath, "local-only detail\n", "utf8");
      const localNoteUrl = pathToFileURL(localNotePath).href;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

<a
  class="source"
  href
    =
    "${rawOriginalUrl}"
>raw original</a>
<iframe
  src
    =
    "${localNoteUrl}"
></iframe>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "public_raw_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(rawOriginalUrl),
            fixable: false,
          }),
          expect.objectContaining({
            rule_id: "public_local_file_link",
            severity: "error",
            path: "curated/topics/public-topic.md",
            line: expect.any(Number),
            message: expect.stringContaining(localNoteUrl),
            fixable: false,
          }),
        ]),
      );
    });
  });

  it("fails public strict lint for Markdown links whose labels contain balanced brackets", async () => {
    await withTempWorkspace("llm-wiki-lint-public-balanced-label-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [private [topic]](private-topic.md) and [raw [PDF]](../../${source.original_path}).
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private [topic]](private-topic.md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw [PDF]]"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for URL-encoded Markdown links to private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-private-encoded-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [private encoded](private%20topic.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/topics/private topic.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private encoded](private%20topic.md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for escaped Markdown destinations to private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-private-escaped-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/private/foo).md",
        { type: "topic", title: "Private Escaped Target", visibility: "private", source_ids: [source.source_id] },
        "# Private Escaped Target\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [private escaped](../private/foo\\).md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/private/foo).md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private escaped](../private/foo\\).md)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for extension-like Markdown page links without .md suffix", async () => {
    await withTempWorkspace("llm-wiki-lint-public-private-dotted-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/private/foo.v1.md",
        { type: "topic", title: "Private Dotted Target", visibility: "private", source_ids: [source.source_id] },
        "# Private Dotted Target\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [private dotted](../private/foo.v1).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/private/foo.v1.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private dotted](../private/foo.v1)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for query-suffixed Markdown links to unselected private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-private-query-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [private query](private-topic.md?view=1).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/topics/private-topic.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private query](private-topic.md?view=1)"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for stale-fragment links to private Markdown files", async () => {
    await withTempWorkspace("llm-wiki-lint-public-private-stale-fragment-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [private stale](private-topic.md#old-heading).\n\nAlso [[Private Topic#old-heading]].\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/topics/private-topic.md",
        }),
      );
      const privateLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_private_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(privateLinkIssues).toHaveLength(2);
      expect(privateLinkIssues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("[private stale](private-topic.md#old-heading)"),
          expect.stringContaining("[[Private Topic#old-heading]]"),
        ]),
      );
      const graphLeakIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_graph_private_node_leak" && issue.path === "curated/topics/public-topic.md",
      );
      expect(graphLeakIssues).toHaveLength(2);
    });
  });

  it("fails public strict lint for unresolved raw Markdown links with query strings or fragments", async () => {
    await withTempWorkspace("llm-wiki-lint-public-raw-link-query-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [raw query](../../raw/assets/file.pdf?download=1) and [raw fragment][raw-fragment].

[raw-fragment]: ../../raw/assets/file.pdf#page=1
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      const rawLinkIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_raw_link" && issue.path === "curated/topics/public-topic.md",
      );
      expect(rawLinkIssues).toHaveLength(2);
      expect(rawLinkIssues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("[raw query](../../raw/assets/file.pdf?download=1)"),
          expect.stringContaining("[raw fragment][raw-fragment]"),
        ]),
      );
    });
  });

  it("fails public strict lint for Markdown links to raw paths with balanced parentheses", async () => {
    await withTempWorkspace("llm-wiki-lint-public-balanced-markdown-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await mkdir(resolve(wikiDir, "raw/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "raw/assets/file(1).pdf"), "raw", "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [raw asset](../../raw/assets/file(1).pdf).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("file(1).pdf"),
        fixable: false,
      });
    });
  });

  it("fails public strict lint for reference-style Markdown links to raw content and private pages", async () => {
    await withTempWorkspace("llm-wiki-lint-public-reference-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        { type: "topic", title: "Private Topic", visibility: "private", source_ids: [source.source_id] },
        "# Private Topic\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [private][p] and [raw original][r].

[p]: private-topic.md
[r]: ../../${source.original_path}
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[private][p]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw original][r]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: false,
      });
    });
  });

  it("does not treat Obsidian footnotes as public strict reference links", async () => {
    await withTempWorkspace("llm-wiki-lint-public-footnotes-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/topics/public-topic.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Visible footnote marker[^1].

[^1]: raw notes from private review.
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_raw_link",
          path: "curated/topics/public-topic.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_graph_private_node_leak",
          path: "curated/topics/public-topic.md",
        }),
      );
    });
  });

  it("fixes only deterministic stale index repairs without rewriting raw originals or inventing provenance", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const originalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/fixable-index-entry.md",
        { type: "topic", title: "Fixable Index Entry", visibility: "private", source_ids: [source.source_id] },
        "# Fixable Index Entry\n\nGrounded page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/missing-provenance.md",
        { type: "topic", title: "Missing Provenance", visibility: "private" },
        "# Missing Provenance\n\nNo source IDs yet.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRule(payload.issues, "curated_source_ids_missing")).toMatchObject({
        path: "curated/topics/missing-provenance.md",
        fixable: false,
      });
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toContain("[[topics/fixable-index-entry|Fixable Index Entry]]");
      expect(fixedIndex).not.toContain("[[topics/missing-provenance|Missing Provenance]]");
      expect(await readGeneratedFile(wikiDir, source.original_path)).toBe(originalBefore);

      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintFailure(secondResult.stdout);
      expect(secondResult.exitCode).toBe(1);
      expect(secondPayload.issues.map((issue) => issue.rule_id)).not.toContain("index_stale");
    });
  });

  it("filters invalid curated frontmatter out of deterministic index fixes", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-invalid-index-targets-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/valid-page.md",
        { type: "topic", title: "Valid Page", visibility: "private", source_ids: [source.source_id] },
        "# Valid Page\n\nGrounded page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/raw-source-type.md",
        { type: "raw_source", title: "Raw Source Type", visibility: "private", source_ids: [source.source_id] },
        "# Raw Source Type\n\nInvalid curated type.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/non-string-title.md",
        { type: "topic", title: ["Non String Title"], visibility: "private", source_ids: [source.source_id] },
        "# Non String Title\n\nInvalid title.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-visibility.md",
        { type: "topic", title: "Invalid Visibility", visibility: "secret", source_ids: [source.source_id] },
        "# Invalid Visibility\n\nInvalid visibility.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/invalid-source-id.md",
        { type: "topic", title: "Invalid Source ID", visibility: "private", source_ids: ["not-a-source-id"] },
        "# Invalid Source ID\n\nInvalid provenance.\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expectStableIssueRecords(payload.issues);
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/raw-source-type.md")).toMatchObject({
        severity: "error",
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/non-string-title.md")).toMatchObject({
        severity: "error",
      });
      expect(issueByRuleAndPath(payload.issues, "curated_frontmatter_invalid", "curated/topics/invalid-visibility.md")).toMatchObject({
        severity: "error",
      });
      expect(issueByRuleAndPath(payload.issues, "curated_source_ids_invalid", "curated/topics/invalid-source-id.md")).toMatchObject({
        severity: "error",
      });
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toContain("[[topics/valid-page|Valid Page]]");
      expect(fixedIndex).not.toContain("Raw Source Type");
      expect(fixedIndex).not.toContain("Non String Title");
      expect(fixedIndex).not.toContain("Invalid Visibility");
      expect(fixedIndex).not.toContain("Invalid Source ID");
    });
  });

  it("preserves public index visibility when applying deterministic index fixes", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-public-index-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-page.md",
        { type: "topic", title: "Public Page", visibility: "public", source_ids: [source.source_id] },
        "# Public Page\n\nPublic notes.\n",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toMatch(/^visibility: public$/m);
      expect(fixedIndex).toContain("[[topics/public-page|Public Page]]");
      expect(fixedIndex).not.toContain("| Research Note | queued |  | |");
      expect(fixedIndex).not.toContain("Research Note");
      expect(fixedIndex).not.toContain("queued");
      expect(fixedIndex).not.toContain(source.source_card_path);
      expect(fixedIndex).not.toContain("../raw/");
    });
  });

  it("fails public strict lint when a public index already contains raw source-card metadata", async () => {
    await withTempWorkspace("llm-wiki-lint-public-index-raw-source-metadata-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await captureSource(wikiDir, workspaceDir, "Secret Diagnosis", "# Secret Diagnosis\n\nPrivate raw note.\n");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/index.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      const leakedIndex = indexBefore
        .replace(/^visibility: private$/m, "visibility: public")
        .replace("|---|---|---|---|\n", "|---|---|---|---|\n| Secret Diagnosis | queued | | |\n");
      await writeFile(resolve(wikiDir, "curated/index.md"), leakedIndex, "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      const issue = issueByRuleAndPath(payload.issues, "public_raw_source_metadata_leak", "curated/index.md");
      expectStableIssueRecord(issue);
      expect(issue.line).toEqual(expect.any(Number));
      expect(issue.message).not.toContain("Secret Diagnosis");
    });
  });

  it("does not match public index table headers as raw source-card metadata leaks", async () => {
    await withTempWorkspace("llm-wiki-lint-public-index-header-source-title-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await captureSource(wikiDir, workspaceDir, "Source", "# Source\n\nPrivate raw note.\n");
      await captureSource(wikiDir, workspaceDir, "Status", "# Status\n\nPrivate raw note.\n");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/index.md
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/index.md",
        { type: "index", title: "Index", visibility: "public", source_ids: [] },
        `# Index

## Sources

| Source | Status | Summary | Key pages |
|---|---|---|---|
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_raw_source_metadata_leak",
        }),
      );
    });
  });

  it("filters private curated pages out of deterministic public index fixes", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-public-index-private-pages-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-page.md",
        { type: "topic", title: "Public Page", visibility: "public", source_ids: [source.source_id] },
        "# Public Page\n\nPublic notes.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-page.md",
        { type: "topic", title: "Private Page", visibility: "private", source_ids: [source.source_id] },
        "# Private Page\n\nInternal notes.\n",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toMatch(/^visibility: public$/m);
      expect(fixedIndex).toContain("[[topics/public-page|Public Page]]");
      expect(fixedIndex).not.toContain("[[topics/private-page|Private Page]]");
      expect(fixedIndex).not.toContain("Private Page");
    });
  });

  it("omits reviewed public source summaries from public index rows excluded by default public profile", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-public-summary-index-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-page.md",
        { type: "topic", title: "Public Page", visibility: "public", source_ids: [source.source_id] },
        "# Public Page\n\nPublic notes.\n",
      );
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Research Note Summary", visibility: "public", source_ids: [source.source_id] },
        "# Research Note Summary\n\nReviewed public summary.\n",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      const summaryLink = `[[sources/${source.source_id}|Research Note Summary]]`;
      expect(fixedIndex).toContain("[[topics/public-page|Public Page]]");
      expect(fixedIndex).not.toContain(summaryLink);
      expect(fixedIndex).not.toContain(`| Research Note | queued | ${summaryLink} | |`);
      expect(fixedIndex).not.toContain(source.source_card_path);
      expect(fixedIndex).not.toContain("../raw/");
      const syncResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      expect(syncResult.exitCode).toBe(0);
      expect(syncResult.stderr).toEqual([]);
    });
  });

  it("removes stale excluded source-summary rows from public indexes", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-stale-public-summary-index-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Research Note Summary", visibility: "public", source_ids: [source.source_id] },
        "# Research Note Summary\n\nReviewed public summary.\n",
      );
      const summaryLink = `[[sources/${source.source_id}|Research Note Summary]]`;
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      const staleIndex = indexBefore
        .replace(/^visibility: private$/m, "visibility: public")
        .replace("|---|---|---|---|\n", `|---|---|---|---|\n| ${summaryLink} | | | |\n`);
      await writeFile(resolve(wikiDir, "curated/index.md"), staleIndex, "utf8");

      // Act
      const staleResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const stalePayload = parseLintSuccess(staleResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintSuccess(secondResult.stdout);

      // Assert
      expect(staleResult.exitCode).toBe(0);
      expect(issueByRuleAndPath(stalePayload.data.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toMatch(/^visibility: public$/m);
      expect(fixedIndex).not.toContain(summaryLink);
      expect(fixedIndex).not.toContain("| Research Note Summary |");
      expect(fixedIndex).not.toContain(source.source_card_path);
      expect(fixedIndex).not.toContain("../raw/");
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.issues.map((issue) => issue.rule_id)).not.toContain("index_stale");
    });
  });

  it("places source summaries in the Sources table when applying deterministic index fixes", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-source-summary-index-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Research Note Summary", visibility: "private", source_ids: [source.source_id] },
        "# Research Note Summary\n\nReviewed summary.\n",
      );
      await rm(resolve(wikiDir, "curated/index.md"));

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      const summaryLink = `[[sources/${source.source_id}|Research Note Summary]]`;
      expect(fixedIndex).toContain(`| [[../${source.source_card_path}|Research Note]] | queued | ${summaryLink} | |`);
      const topicsStart = fixedIndex.indexOf("## Topics");
      const questionsStart = fixedIndex.indexOf("## Questions");
      expect(fixedIndex.slice(topicsStart, questionsStart)).not.toContain(summaryLink);
    });
  });

  it("detects stale generated source rows when queue status metadata changes", async () => {
    await withTempWorkspace("llm-wiki-lint-stale-source-row-status-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const initialFixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      expect(initialFixResult.exitCode).toBe(0);
      expect(await readGeneratedFile(wikiDir, "curated/index.md")).toContain(
        `| [[../${source.source_card_path}|Research Note]] | queued |  | |`,
      );
      const statusResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      expect(statusResult.exitCode).toBe(0);

      // Act
      const staleResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const stalePayload = parseLintSuccess(staleResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintSuccess(secondResult.stdout);

      // Assert
      expect(staleResult.exitCode).toBe(0);
      expect(issueByRuleAndPath(stalePayload.data.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toContain(`| [[../${source.source_card_path}|Research Note]] | ingesting |  | |`);
      expect(fixedIndex).not.toContain(`| [[../${source.source_card_path}|Research Note]] | queued |  | |`);
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.issues.map((issue) => issue.rule_id)).not.toContain("index_stale");
    });
  });

  it("fixes stale generated index rows and links when entries are removed", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-extra-index-entries-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/removed-page.md",
        { type: "topic", title: "Removed Page", visibility: "private", source_ids: [source.source_id] },
        "# Removed Page\n\nGrounded page.\n",
      );
      const initialFixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      expect(initialFixResult.exitCode).toBe(0);
      await rm(resolve(wikiDir, "curated/topics/removed-page.md"));

      const staleSourceRow =
        "| [[../raw/inputs/2026/06/src_2026_06_17_removed_deadbeef/_source.md|Removed Source]] | queued |  | |";
      const indexWithRemovedPage = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexWithRemovedPage.replace("|---|---|---|---|\n", `|---|---|---|---|\n${staleSourceRow}\n`),
        "utf8",
      );

      // Act
      const staleResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const stalePayload = parseLintFailure(staleResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintSuccess(secondResult.stdout);

      // Assert
      expect(staleResult.exitCode).toBe(1);
      expect(issueByRuleAndPath(stalePayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toContain(`| [[../${source.source_card_path}|Research Note]] | queued |  | |`);
      expect(fixedIndex).not.toContain("[[topics/removed-page|Removed Page]]");
      expect(fixedIndex).not.toContain("Removed Source");
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.issues.map((issue) => issue.rule_id)).not.toContain("index_stale");
      expect(secondPayload.data.issues.map((issue) => issue.rule_id)).not.toContain("wikilink_broken");
    });
  });

  it("reports a clean wiki with only safe index fixes as successful after --fix", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/clean-page.md",
        { type: "topic", title: "Clean Page", visibility: "private", source_ids: [source.source_id] },
        "# Clean Page\n\nGrounded page linked to [[Companion Page]].\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/companion-page.md",
        { type: "topic", title: "Companion Page", visibility: "private", source_ids: [source.source_id] },
        "# Companion Page\n\nBack to [[Clean Page]].\n",
      );
      await rm(resolve(wikiDir, "curated/index.md"));

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).toEqual([]);
      expect(payload.data.counts).toEqual({
        total: 0,
        error: 0,
        warning: 0,
        fixed: 1,
      });
      expect(payload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(await readGeneratedFile(wikiDir, "curated/index.md")).toContain("[[topics/clean-page|Clean Page]]");
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("surfaces failed stale index rewrites during --fix", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-stale-index-write-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/blocked-index-entry.md",
        { type: "topic", title: "Blocked Index Entry", visibility: "private", source_ids: [source.source_id] },
        "# Blocked Index Entry\n\nGrounded page.\n",
      );
      const indexPath = resolve(wikiDir, "curated/index.md");
      await chmod(indexPath, 0o400);

      let result;
      try {
        // Act
        result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      } finally {
        await chmod(indexPath, 0o600);
      }
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("lint_failed");
      expect(issueByRuleAndPath(payload.issues, "index_fix_failed", "curated/index.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(await readFile(indexPath, "utf8")).not.toContain("[[topics/blocked-index-entry|Blocked Index Entry]]");
    });
  });

  it("does not follow symlinked generated index parents during --fix", async () => {
    await withTempWorkspace("llm-wiki-lint-fix-index-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsideCuratedDir = resolve(workspaceDir, "outside-curated");
      const outsideIndexPath = resolve(outsideCuratedDir, "index.md");
      await initializeWiki(wikiDir);
      await mkdir(outsideCuratedDir, { recursive: true });
      await writeFile(outsideIndexPath, "outside index\n", "utf8");
      await rm(resolve(wikiDir, "curated"), { force: true, recursive: true });
      await symlink(outsideCuratedDir, resolve(wikiDir, "curated"), "dir");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "index_missing", "curated/index.md")).toMatchObject({
        severity: "error",
        fix_hint: "Run llm-wiki lint --fix to regenerate the index.",
        fixable: true,
      });
      expect(await readFile(outsideIndexPath, "utf8")).toBe("outside index\n");
    });
  });

  it("compares escaped source index links after fixing titles with table separators", async () => {
    await withTempWorkspace("llm-wiki-lint-source-pipe-title-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const sourcePath = resolve(workspaceDir, "Source Pipe.md");
      await writeFile(sourcePath, "# Source Pipe\n\nRaw observation.\n", "utf8");
      const capture = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Alpha | Beta",
        now: new Date("2026-06-17T11:28:42.778Z"),
        command: "llm-wiki add Source Pipe.md --title Alpha | Beta",
      });
      expect(capture.ok).toBe(true);
      if (!capture.ok) {
        throw new Error(capture.error.message);
      }
      const source = capture.value.source;

      // Act
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintSuccess(secondResult.stdout);

      // Assert
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(await readGeneratedFile(wikiDir, "curated/index.md")).toContain(`[[../${source.source_card_path}|Alpha \\| Beta]]`);
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.issues).toEqual([]);
    });
  });

  it("normalizes generated index labels with line breaks and control characters", async () => {
    await withTempWorkspace("llm-wiki-lint-index-label-normalization-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const sourcePath = resolve(workspaceDir, "Source Weird.md");
      await writeFile(sourcePath, "# Source Weird\n\nRaw observation.\n", "utf8");
      const capture = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Alpha\nBeta\t| Gamma",
        now: new Date("2026-06-17T11:28:42.778Z"),
        command: "llm-wiki add Source Weird.md --title Alpha Beta | Gamma",
      });
      expect(capture.ok).toBe(true);
      if (!capture.ok) {
        throw new Error(capture.error.message);
      }
      const source = capture.value.source;
      await writeCuratedPage(
        wikiDir,
        "curated/topics/weird-label.md",
        { type: "topic", title: "Topic\nLabel\u0007 | One", visibility: "private", source_ids: [source.source_id] },
        "# Topic Label\n\nGrounded page.\n",
      );

      // Act
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const secondResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const secondPayload = parseLintSuccess(secondResult.stdout);

      // Assert
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      expect(fixedIndex).toContain(`[[../${source.source_card_path}|Alpha Beta \\| Gamma]]`);
      expect(fixedIndex).toContain("[[topics/weird-label|Topic Label \\| One]]");
      expect(fixedIndex).not.toContain("Alpha\nBeta");
      expect(fixedIndex).not.toContain("\u0007");
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.issues.map((issue) => issue.rule_id)).not.toContain("index_stale");
    });
  });
});
