import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  runAutoIngestBatch,
  runAutoIngestSource,
  runAutoIngestWatch,
  type PdfAutoIngestResult,
} from "../src/autoIngest/index.js";
import { runCli } from "../src/cli.js";
import { startUploadDaemon, UPLOAD_TOKEN_HEADER } from "../src/daemon/index.js";
import {
  ensurePreparedIngestArtifactUnderLock,
  prepareAutomatedIngestArtifact,
} from "../src/ingest/artifact.js";
import { extractPdfSource } from "../src/pdf/extraction.js";
import { readPdfExtractionSourceState } from "../src/pdf/state.js";
import { loadDefaultLocalAgentConfig } from "../src/runtime/config.js";
import { withIngestLock } from "../src/runtime/ingestLock.js";
import { showQueueSource, transitionQueueStatus } from "../src/runtime/queue.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { captureTextSource, captureUploadedFileSource } from "../src/sourceCapture/index.js";
import { pathExists, readTreeSnapshot, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "utf8");
const PLUGIN = "pdf@openai-primary-runtime";
const CANONICAL_EVIDENCE = "CANONICAL_ONLY_EVIDENCE_FROM_THE_PDF";
const STDERR_SECRET = "TOP_SECRET_EXTRACTION_STDERR";
const supportsPermissionFailure = process.platform !== "win32"
  && typeof process.getuid === "function"
  && process.getuid() !== 0;
const execFileAsync = promisify(execFile);

type Fixture = {
  repoRoot: string;
  sourceId: string;
  modePath: string;
  logPath: string;
  executablePath: string;
};

type FakeInvocation = {
  args: string[];
  cwd: string;
  task: string;
};

async function createFixture(workspaceDir: string): Promise<Fixture> {
  const repoRoot = resolve(workspaceDir, "wiki");
  const initialized = await createWiki(repoRoot, {
    agent: "codex",
    obsidian: false,
    dataview: false,
    git: false,
    quartzReady: false,
    force: false,
  });
  expect(initialized.ok).toBe(true);

  const modePath = resolve(workspaceDir, "fake-mode.txt");
  const logPath = resolve(workspaceDir, "fake-codex.jsonl");
  const executablePath = await createCombinedFakeCodex(workspaceDir, repoRoot, modePath, logPath);
  const configPath = resolve(repoRoot, ".llm-wiki/config.yml");
  const config = (await readFile(configPath, "utf8"))
    .replace("    command: codex", `    command: ${JSON.stringify(executablePath)}`)
    .replace("  reasoning_effort: high", "  model: gpt-pdf-test\n  reasoning_effort: high");
  await writeFile(configPath, config, "utf8");
  await writeFile(modePath, "success\n", "utf8");

  const captured = await captureUploadedFileSource({
    repoRoot,
    fileName: "Evidence.pdf",
    title: "PDF Evidence",
    content: PDF_BYTES,
    now: new Date("2026-07-11T08:00:00.000Z"),
  });
  expect(captured.ok).toBe(true);
  if (!captured.ok) throw new Error(captured.error.message);

  return {
    repoRoot,
    sourceId: captured.value.source.source_id,
    modePath,
    logPath,
    executablePath,
  };
}

async function createCombinedFakeCodex(
  workspaceDir: string,
  repoRoot: string,
  modePath: string,
  logPath: string,
): Promise<string> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, "codex");
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const modePath = ${JSON.stringify(modePath)};`,
    `const logPath = ${JSON.stringify(logPath)};`,
    `const ingestLockPath = ${JSON.stringify(resolve(repoRoot, ".llm-wiki/cache/locks/ingest.lock"))};`,
    "const args = process.argv.slice(2);",
    "const mode = fs.readFileSync(modePath, 'utf8').trim();",
    "if (args.includes('plugin')) {",
    "  fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), task: '' }) + '\\n');",
    `  process.stdout.write(JSON.stringify({ installed: [{ pluginId: ${JSON.stringify(PLUGIN)}, installed: true, enabled: mode !== 'plugin-disabled', version: '7.8.9' }], available: [] }));`,
    "  process.exit(0);",
    "}",
    "const task = fs.readFileSync(0, 'utf8');",
    "fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), task }) + '\\n');",
    "if (!fs.existsSync(ingestLockPath)) { console.error('shared ingest lock was not held'); process.exit(22); }",
    "if (task.startsWith('Extract this PDF')) {",
    `  if (mode === 'extract-fail' || mode === 'extract-secret-fail') { console.error(mode === 'extract-secret-fail' ? ${JSON.stringify(STDERR_SECRET)} : 'synthetic extraction failure'); process.exit(23); }`,
    "  const output = task.match(/^Permitted output path: (.+)$/m)?.[1];",
    "  if (!output) process.exit(24);",
    "  fs.mkdirSync(path.dirname(output), { recursive: true });",
    `  fs.writeFileSync(output, '# Canonical PDF\\n\\n' + 'A'.repeat(9000) + '\\n${CANONICAL_EVIDENCE}\\n', 'utf8');`,
    "  process.exit(0);",
    "}",
    `if (mode === 'agent-fail' || mode === 'agent-secret-fail' || (mode === 'pdf-agent-fail' && task.includes('PDF extraction ID:'))) { console.error(mode === 'agent-secret-fail' ? ${JSON.stringify(STDERR_SECRET)} : 'synthetic curator failure'); process.exit(31); }`,
    `if (task.includes('PDF extraction ID:') && !task.includes(${JSON.stringify(CANONICAL_EVIDENCE)})) { console.error('canonical artifact was not provided'); process.exit(32); }`,
    "const sourceId = task.match(/Source ID: (src_[^\\n]+)/)?.[1];",
    "const sourceCard = task.match(/- (raw\\/inputs\\/[^\\n]+\\/_source\\.md)/)?.[1];",
    "if (!sourceId || !sourceCard) process.exit(33);",
    "const cwd = process.cwd();",
    "const title = 'PDF ingest ' + sourceId;",
    "const summary = ['---', 'type: source_summary', 'title: ' + JSON.stringify(title), 'visibility: private', 'source_ids:', '  - ' + sourceId, 'source_id: ' + sourceId, '---', '', '# ' + title, '', 'The canonical PDF artifact supports this summary.', ''].join('\\n');",
    "const index = ['---', 'type: index', 'title: Index', 'visibility: private', 'source_ids: []', '---', '', '# Index', '', '- [[sources/' + sourceId + '|' + title + ']]', ''].join('\\n');",
    "const log = ['# Log', '', '## [2026-07-11T09:00:00.000Z] ingest | ' + sourceId + ' | PDF ingest completed', '', '- actor: codex', '- command: \"llm-wiki ingest ' + sourceId + ' --auto\"', '- git_branch:', '- git_commit:', '- raw_source: ' + sourceCard, '- created:', '  - curated/sources/' + sourceId + '.md', '- updated:', '  - curated/index.md', '- contradictions:', '- follow_ups:', ''].join('\\n');",
    "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
    "fs.writeFileSync(path.join(cwd, 'curated/sources', sourceId + '.md'), summary, 'utf8');",
    "fs.writeFileSync(path.join(cwd, 'curated/index.md'), index, 'utf8');",
    "fs.writeFileSync(path.join(cwd, 'curated/log.md'), log, 'utf8');",
    "",
  ].join("\n"), "utf8");
  await chmod(executablePath, 0o755);
  return executablePath;
}

async function readInvocations(fixture: Fixture): Promise<FakeInvocation[]> {
  if (!(await pathExists(fixture.logPath))) return [];
  return (await readFile(fixture.logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeInvocation);
}

async function createGitBaseline(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "phase3-test"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "phase3@example.invalid"], { cwd: repoRoot });
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "test baseline"], { cwd: repoRoot });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["checkout", "-b", "phase3-ingest"], { cwd: repoRoot });
}

function providerProposals(sourceId: string, sourceCardPath: string): Array<{ path: string; content: string }> {
  const title = `Provider PDF ${sourceId}`;
  return [
    {
      path: `curated/sources/${sourceId}.md`,
      content: [
        "---",
        "type: source_summary",
        `title: ${JSON.stringify(title)}`,
        "visibility: private",
        "source_ids:",
        `  - ${sourceId}`,
        `source_id: ${sourceId}`,
        "---",
        "",
        `# ${title}`,
        "",
        "The validated canonical PDF artifact supports this provider summary.",
        "",
      ].join("\n"),
    },
    {
      path: "curated/index.md",
      content: [
        "---",
        "type: index",
        "title: Index",
        "visibility: private",
        "source_ids: []",
        "---",
        "",
        "# Index",
        "",
        `- [[sources/${sourceId}|${title}]]`,
        "",
      ].join("\n"),
    },
    {
      path: "curated/log.md",
      content: [
        "# Log",
        "",
        `## [2026-07-11T09:30:00.000Z] ingest | ${sourceId} | Provider PDF ingest completed`,
        "",
        "- actor: provider",
        `- command: \"llm-wiki ingest ${sourceId} --provider phase3\"`,
        "- git_branch:",
        "- git_commit:",
        `- raw_source: ${sourceCardPath}`,
        "- created:",
        `  - curated/sources/${sourceId}.md`,
        "- updated:",
        "  - curated/index.md",
        "- contradictions:",
        "- follow_ups:",
        "",
      ].join("\n"),
    },
  ];
}

function expectPdfResult(
  result: PdfAutoIngestResult | null | undefined,
  outcome: PdfAutoIngestResult["outcome"],
): void {
  expect(result).toMatchObject({ applicable: true, outcome });
}

describe("PDF ingest integration", () => {
  it("extracts under automated Codex ingest and gives only canonical Markdown to the curator", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-extract-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const result = await runAutoIngestSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        pdfOverrides: {
          model: "gpt-pdf-test",
          reasoningEffort: "medium",
          pdfDetail: "low",
          force: false,
        },
      });

      expect(result.outcome).toBe("ingested");
      expect(result.attempted).toBe(true);
      expectPdfResult(result.pdf, "extracted");
      expect(await pathExists(resolve(fixture.repoRoot, `curated/sources/${fixture.sourceId}.md`))).toBe(true);

      const invocations = await readInvocations(fixture);
      const extraction = invocations.find((item) => item.task.startsWith("Extract this PDF"));
      const curation = invocations.find((item) => item.task.startsWith("# Ingest task"));
      expect(extraction?.args).toContain("gpt-pdf-test");
      expect(extraction?.args).toContain('model_reasoning_effort="medium"');
      expect(extraction?.task).toContain("PDF detail: low");
      expect(curation?.task).toContain(CANONICAL_EVIDENCE);
      expect(curation?.task).toContain("Canonical PDF artifact path:");
      expect(curation?.task).toContain("PDF extraction ID:");
      expect(curation?.task).not.toContain("Use appropriate extraction or OCR tooling");
    });
  });

  it("reuses a matching extraction without another extraction execution", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-reuse-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const extracted = await extractPdfSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });
      expect(extracted.outcome).toBe("extracted");
      await writeFile(fixture.logPath, "", "utf8");

      const result = await runAutoIngestSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });

      expect(result.outcome).toBe("ingested");
      expectPdfResult(result.pdf, "reused");
      const invocations = await readInvocations(fixture);
      expect(invocations.filter((item) => item.task.startsWith("Extract this PDF"))).toHaveLength(0);
      expect(invocations.filter((item) => item.task.startsWith("# Ingest task"))).toHaveLength(1);
    });
  });

  it("builds a manual task from the complete validated artifact after explicit extraction", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-manual-artifact-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const extracted = await extractPdfSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });

      const result = await runCliBuffered([
        "ingest",
        fixture.sourceId,
        "--repo",
        fixture.repoRoot,
        "--json",
      ]);
      const payload = JSON.parse(result.stdout[0] ?? "{}") as {
        data?: {
          source?: { canonical_artifact?: { extraction_id?: string; artifact_path?: string } };
          context?: { paths?: string[] };
          task?: { prompt?: string };
        };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.data?.source?.canonical_artifact).toMatchObject({
        extraction_id: extracted.extraction_id,
        artifact_path: extracted.artifact_path,
      });
      expect(payload.data?.context?.paths).toContain(extracted.artifact_path);
      expect(payload.data?.task?.prompt).toContain(CANONICAL_EVIDENCE);
      expect(payload.data?.task?.prompt).not.toContain("[truncated]");
      expect(payload.data?.task?.prompt).not.toContain("Use appropriate extraction or OCR tooling");
    });
  });

  it("lets another agent and validation consume an existing canonical artifact without extracting", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-other-agent-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await createGitBaseline(fixture.repoRoot);
      await extractPdfSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });
      const configPath = resolve(fixture.repoRoot, ".llm-wiki/config.yml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "agents:\n  codex:",
          [
            "agents:",
            "  other:",
            "    type: local-exec",
            `    command: ${JSON.stringify(fixture.executablePath)}`,
            "    args:",
            "      - exec",
            "  codex:",
          ].join("\n"),
        ),
        "utf8",
      );
      await writeFile(fixture.logPath, "", "utf8");

      const agentResult = await runCliBuffered([
        "ingest",
        fixture.sourceId,
        "--agent",
        "other",
        "--repo",
        fixture.repoRoot,
        "--json",
      ]);
      const invocations = await readInvocations(fixture);
      const validationResult = await runCliBuffered([
        "ingest",
        fixture.sourceId,
        "--validate",
        "--repo",
        fixture.repoRoot,
        "--json",
      ]);

      expect(agentResult.exitCode).toBe(0);
      expect(invocations.filter((item) => item.task.startsWith("Extract this PDF"))).toHaveLength(0);
      expect(invocations.find((item) => item.task.startsWith("# Ingest task"))?.task).toContain(CANONICAL_EVIDENCE);
      expect(validationResult.stdout).toEqual([expect.stringContaining('"ok":true')]);
      expect(validationResult).toMatchObject({ exitCode: 0, stderr: [] });
    });
  });

  it("rejects PDF readiness before queue mutation and before a curator attempt", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-ready-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, "plugin-disabled\n", "utf8");
      const before = await readTreeSnapshot(fixture.repoRoot);

      const result = await runAutoIngestSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });

      expect(result).toMatchObject({ outcome: "skipped", attempted: false, error: { code: "PDF_PLUGIN_DISABLED" } });
      expectPdfResult(result.pdf, "readiness_rejected");
      expect(await readTreeSnapshot(fixture.repoRoot)).toEqual(before);
      const shown = await showQueueSource(fixture.repoRoot, fixture.sourceId);
      expect(shown.ok && shown.value.queue_record.status).toBe("queued");
      expect((await readInvocations(fixture)).some((item) => item.task.startsWith("# Ingest task"))).toBe(false);
    });
  });

  it("blocks an attempted item on extraction failure without curated writes", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-extract-fail-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, "extract-fail\n", "utf8");

      const result = await runAutoIngestSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });

      expect(result).toMatchObject({ outcome: "blocked", attempted: true, error: { code: "PDF_CODEX_EXTRACTION_FAILED" } });
      expectPdfResult(result.pdf, "failed");
      expect((await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId)).state.status).toBe("failed");
      expect(await pathExists(resolve(fixture.repoRoot, `curated/sources/${fixture.sourceId}.md`))).toBe(false);
    });
  });

  it("retains extracted state and rolls back curated writes when curation fails", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-curator-fail-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, "agent-fail\n", "utf8");

      const result = await runAutoIngestSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });

      expect(result).toMatchObject({ outcome: "blocked", attempted: true });
      expectPdfResult(result.pdf, "extracted");
      expect((await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId)).state.status).toBe("extracted");
      expect(await pathExists(resolve(fixture.repoRoot, `curated/sources/${fixture.sourceId}.md`))).toBe(false);
    });
  });

  it.skipIf(!supportsPermissionFailure)("keeps mirrored PDF state coherent when locked automated state write rolls back", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-state-rollback-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const before = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      const agent = await loadDefaultLocalAgentConfig(fixture.repoRoot);
      expect(agent.ok).toBe(true);
      if (!agent.ok) throw new Error(agent.error.message);
      const prepared = await prepareAutomatedIngestArtifact({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        agent: agent.value,
      });
      const queuePath = resolve(fixture.repoRoot, before.queuePath);

      try {
        await expect(withIngestLock(
          fixture.repoRoot,
          { label: `phase3-rollback:${fixture.sourceId}` },
          (lease) => ensurePreparedIngestArtifactUnderLock(prepared, lease, {
            onReady: async () => {
              const started = await transitionQueueStatus(fixture.repoRoot, fixture.sourceId, "ingesting");
              if (!started.ok) throw new Error(started.error.message);
              await chmod(queuePath, 0o400);
            },
          }),
        )).rejects.toMatchObject({ code: "PDF_STATE_WRITE_FAILED" });
      } finally {
        await chmod(queuePath, 0o600);
      }

      const after = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      expect(after.queueStatus).toBe("ingesting");
      expect(after.state).toEqual(before.state);
      expect(after.queueRecord.pdf_extraction).toEqual(after.sourceCardFrontmatter.pdf_extraction);
      expect((await readInvocations(fixture)).filter((item) => item.task.startsWith("Extract this PDF"))).toHaveLength(0);
    });
  });

  it("gates manual, validation, provider, and other-agent modes before side effects", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-gates-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const before = await readTreeSnapshot(fixture.repoRoot);
      const modes = [
        [],
        ["--validate"],
        ["--provider", "missing-provider"],
        ["--agent", "generic"],
      ];

      for (const mode of modes) {
        const result = await runCliBuffered([
          "ingest",
          fixture.sourceId,
          "--repo",
          fixture.repoRoot,
          ...mode,
          "--json",
        ]);
        expect(result.exitCode).toBe(1);
        const payload = JSON.parse(result.stdout[0] ?? "{}") as { error?: { code?: string; hint?: string } };
        expect(payload.error?.code).toBe("PDF_ARTIFACT_REQUIRED");
        expect(payload.error?.hint).toContain(`llm-wiki extract pdf ${fixture.sourceId}`);
        expect(await readTreeSnapshot(fixture.repoRoot)).toEqual(before);
      }
    });
  });

  it("gates a configured provider before making its HTTP request", async () => {
    await withTempWorkspace("llm-wiki-pdf-provider-gate-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.end(JSON.stringify({ files: [] }));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("provider server did not bind");
      const envName = "LLM_WIKI_PHASE3_PROVIDER_TOKEN";
      const previousToken = process.env[envName];
      process.env[envName] = "private-provider-token";
      await appendFile(resolve(fixture.repoRoot, ".llm-wiki/config.yml"), [
        "",
        "providers:",
        "  phase3:",
        "    type: http",
        `    endpoint: http://127.0.0.1:${address.port}`,
        `    api_key_env: ${envName}`,
        "",
      ].join("\n"), "utf8");
      try {
        const result = await runCliBuffered([
          "ingest",
          fixture.sourceId,
          "--provider",
          "phase3",
          "--repo",
          fixture.repoRoot,
          "--json",
        ]);
        const payload = JSON.parse(result.stdout[0] ?? "{}") as { error?: { code?: string } };

        expect(result.exitCode).toBe(1);
        expect(payload.error?.code).toBe("PDF_ARTIFACT_REQUIRED");
        expect(requestCount).toBe(0);
      } finally {
        if (previousToken === undefined) delete process.env[envName];
        else process.env[envName] = previousToken;
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
        });
      }
    });
  });

  it("sends the complete existing canonical artifact to a configured provider", async () => {
    await withTempWorkspace("llm-wiki-pdf-provider-artifact-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await createGitBaseline(fixture.repoRoot);
      await extractPdfSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });
      const source = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      const requestBodies: string[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: providerProposals(fixture.sourceId, source.sourceCardPath) }));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("provider server did not bind");
      const envName = "LLM_WIKI_PHASE3_PROVIDER_SUCCESS_TOKEN";
      const previousToken = process.env[envName];
      process.env[envName] = "private-provider-token";
      await appendFile(resolve(fixture.repoRoot, ".llm-wiki/config.yml"), [
        "",
        "providers:",
        "  phase3:",
        "    type: http",
        `    endpoint: http://127.0.0.1:${address.port}`,
        `    api_key_env: ${envName}`,
        "",
      ].join("\n"), "utf8");
      try {
        const result = await runCliBuffered([
          "ingest",
          fixture.sourceId,
          "--provider",
          "phase3",
          "--repo",
          fixture.repoRoot,
          "--json",
        ]);

        expect(result.stdout).toEqual([expect.stringContaining('"ok":true')]);
        expect(result).toMatchObject({ exitCode: 0, stderr: [] });
        expect(requestBodies).toHaveLength(1);
        expect(requestBodies[0]).toContain(CANONICAL_EVIDENCE);
        expect(requestBodies[0]).toContain("PDF extraction ID:");
        expect(requestBodies[0]).not.toContain("[truncated]");
      } finally {
        if (previousToken === undefined) delete process.env[envName];
        else process.env[envName] = previousToken;
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
        });
      }
    });
  });

  it("continues a mixed batch after a per-PDF readiness rejection", async () => {
    await withTempWorkspace("llm-wiki-pdf-ingest-batch-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const text = await captureTextSource({
        repoRoot: fixture.repoRoot,
        title: "Eligible text",
        text: "ordinary non-PDF evidence",
        now: new Date("2026-07-11T08:01:00.000Z"),
      });
      expect(text.ok).toBe(true);
      if (!text.ok) throw new Error(text.error.message);
      await writeFile(fixture.modePath, "plugin-disabled\n", "utf8");

      const batch = await runAutoIngestBatch({
        repoRoot: fixture.repoRoot,
        pdfOverrides: { pdfDetail: "auto", force: true },
      });

      expect(batch.results).toHaveLength(2);
      expect(batch.results.find((item) => item.source_id === fixture.sourceId)).toMatchObject({
        outcome: "skipped",
        attempted: false,
        error: { code: "PDF_PLUGIN_DISABLED" },
      });
      expect(batch.results.find((item) => item.source_id === text.value.source.source_id)).toMatchObject({
        outcome: "ingested",
        attempted: true,
        pdf: { applicable: false, outcome: "not_applicable" },
      });
    });
  });

  it.each([
    {
      label: "extraction failure",
      mode: "extract-fail",
      errorCode: "PDF_CODEX_EXTRACTION_FAILED",
      pdfOutcome: "failed",
      pdfStatus: "failed",
    },
    {
      label: "curator failure",
      mode: "pdf-agent-fail",
      errorCode: "AGENT_COMMAND_FAILED",
      pdfOutcome: "extracted",
      pdfStatus: "extracted",
    },
  ])("continues a mixed batch after PDF $label", async ({ mode, errorCode, pdfOutcome, pdfStatus }) => {
    await withTempWorkspace(`llm-wiki-pdf-batch-${mode}-`, async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const text = await captureTextSource({
        repoRoot: fixture.repoRoot,
        title: "Batch continuation text",
        text: "eligible non-PDF batch evidence",
        now: new Date("2026-07-11T08:04:00.000Z"),
      });
      expect(text.ok).toBe(true);
      if (!text.ok) throw new Error(text.error.message);
      await writeFile(fixture.modePath, `${mode}\n`, "utf8");

      const batch = await runAutoIngestBatch({ repoRoot: fixture.repoRoot });

      expect(batch.results.find((item) => item.source_id === fixture.sourceId)).toMatchObject({
        outcome: "blocked",
        attempted: true,
        error: { code: errorCode },
        pdf: { applicable: true, outcome: pdfOutcome, status: pdfStatus },
      });
      expect(batch.results.find((item) => item.source_id === text.value.source.source_id)).toMatchObject({
        outcome: "ingested",
        attempted: true,
      });
    });
  });

  it("keeps non-PDF explicit-agent ingest independent of malformed PDF configuration", async () => {
    await withTempWorkspace("llm-wiki-non-pdf-malformed-pdf-config-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const text = await captureTextSource({
        repoRoot: fixture.repoRoot,
        title: "Non-PDF agent source",
        text: "ordinary agent evidence",
        now: new Date("2026-07-11T08:03:00.000Z"),
      });
      expect(text.ok).toBe(true);
      if (!text.ok) throw new Error(text.error.message);
      const configPath = resolve(fixture.repoRoot, ".llm-wiki/config.yml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace("  pdf_detail: high", "  pdf_detail: impossible"),
        "utf8",
      );

      const result = await runCliBuffered([
        "ingest",
        text.value.source.source_id,
        "--agent",
        "codex",
        "--repo",
        fixture.repoRoot,
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(await pathExists(resolve(
        fixture.repoRoot,
        `curated/sources/${text.value.source.source_id}.md`,
      ))).toBe(true);
    });
  });

  it.each([
    { label: "direct --auto", args: (sourceId: string) => ["ingest", sourceId, "--auto"] },
    { label: "direct --agent", args: (sourceId: string) => ["ingest", sourceId, "--agent", "codex"] },
    {
      label: "queue source",
      args: (sourceId: string) => ["queue", "ingest", "--auto", "--source-id", sourceId],
    },
  ])("forwards model, effort, and detail through $label", async ({ label, args }) => {
    await withTempWorkspace(`llm-wiki-pdf-forward-${label.replaceAll(/[^a-z]+/giu, "-")}-`, async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const model = `gpt-${label.replaceAll(/[^a-z]+/giu, "-")}`;
      const first = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        overrides: { model, reasoningEffort: "low", pdfDetail: "auto" },
      });
      await writeFile(fixture.logPath, "", "utf8");
      const result = await runCliBuffered([
        ...args(fixture.sourceId),
        "--repo",
        fixture.repoRoot,
        "--pdf-model",
        model,
        "--pdf-reasoning-effort",
        "low",
        "--pdf-detail",
        "auto",
        "--force",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const extraction = (await readInvocations(fixture)).find((item) => item.task.startsWith("Extract this PDF"));
      expect(extraction?.args).toContain(model);
      expect(extraction?.args).toContain('model_reasoning_effort="low"');
      expect(extraction?.task).toContain("PDF detail: auto");
      expect((await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId)).state.extraction_id)
        .not.toBe(first.extraction_id);
    });
  });

  it("forwards force through queue batch and creates a new immutable run", async () => {
    await withTempWorkspace("llm-wiki-pdf-forward-batch-force-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const first = await extractPdfSource({ repoRoot: fixture.repoRoot, sourceId: fixture.sourceId });
      await writeFile(fixture.logPath, "", "utf8");

      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--force",
        "--repo",
        fixture.repoRoot,
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const extraction = (await readInvocations(fixture)).filter((item) => item.task.startsWith("Extract this PDF"));
      expect(extraction).toHaveLength(1);
      const state = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      expect(state.state.extraction_id).not.toBe(first.extraction_id);
    });
  });

  it("forwards PDF controls once through watch and reports its PDF result", async () => {
    await withTempWorkspace("llm-wiki-pdf-forward-watch-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const first = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        overrides: { model: "gpt-watch", reasoningEffort: "minimal", pdfDetail: "high" },
      });
      await writeFile(fixture.logPath, "", "utf8");
      const controller = new AbortController();
      const results: Array<{ pdf?: PdfAutoIngestResult }> = [];

      const summary = await runAutoIngestWatch({
        repoRoot: fixture.repoRoot,
        signal: controller.signal,
        pollIntervalMs: 0,
        pdfOverrides: {
          model: "gpt-watch",
          reasoningEffort: "minimal",
          pdfDetail: "high",
          force: true,
        },
        onEvent: (event) => {
          if (event.event === "result") {
            results.push(event.result);
            controller.abort();
          }
        },
      });

      expect(summary.counts.ingested).toBe(1);
      expect(results).toMatchObject([{ pdf: { applicable: true, outcome: "extracted" } }]);
      const extraction = (await readInvocations(fixture)).find((item) => item.task.startsWith("Extract this PDF"));
      expect(extraction?.args).toContain("gpt-watch");
      expect(extraction?.args).toContain('model_reasoning_effort="minimal"');
      expect(extraction?.task).toContain("PDF detail: high");
      expect((await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId)).state.extraction_id)
        .not.toBe(first.extraction_id);
    });
  });

  it("reports a PDF readiness rejection once while watch continues eligible work", async () => {
    await withTempWorkspace("llm-wiki-pdf-watch-continue-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const text = await captureTextSource({
        repoRoot: fixture.repoRoot,
        title: "Watch text",
        text: "eligible watch evidence",
        now: new Date("2026-07-11T08:02:00.000Z"),
      });
      expect(text.ok).toBe(true);
      if (!text.ok) throw new Error(text.error.message);
      await writeFile(fixture.modePath, "plugin-disabled\n", "utf8");
      const controller = new AbortController();
      const results: Array<{ source_id: string; outcome: string; error: { code: string } | null }> = [];

      const summary = await runAutoIngestWatch({
        repoRoot: fixture.repoRoot,
        signal: controller.signal,
        pollIntervalMs: 0,
        onEvent: (event) => {
          if (event.event !== "result") return;
          results.push(event.result);
          if (results.length === 2) controller.abort();
        },
      });

      expect(results).toMatchObject([
        { source_id: fixture.sourceId, outcome: "skipped", error: { code: "PDF_PLUGIN_DISABLED" } },
        { source_id: text.value.source.source_id, outcome: "ingested", error: null },
      ]);
      expect(summary).toMatchObject({
        failure_count: 1,
        exit_code: 1,
        counts: { selected: 2, skipped: 1, ingested: 1 },
      });
    });
  });

  it.each([
    {
      label: "extraction",
      mode: "extract-fail",
      errorCode: "PDF_CODEX_EXTRACTION_FAILED",
      pdfOutcome: "failed",
      pdfStatus: "failed",
    },
    {
      label: "curator",
      mode: "agent-fail",
      errorCode: "AGENT_COMMAND_FAILED",
      pdfOutcome: "extracted",
      pdfStatus: "extracted",
    },
  ])("distinguishes PDF $label failure in watch results", async ({ mode, errorCode, pdfOutcome, pdfStatus }) => {
    await withTempWorkspace(`llm-wiki-pdf-watch-${mode}-`, async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, `${mode}\n`, "utf8");
      const controller = new AbortController();
      const results: Array<{ outcome: string; error: { code: string } | null; pdf?: PdfAutoIngestResult }> = [];

      const summary = await runAutoIngestWatch({
        repoRoot: fixture.repoRoot,
        signal: controller.signal,
        pollIntervalMs: 0,
        onEvent: (event) => {
          if (event.event !== "result") return;
          results.push(event.result);
          controller.abort();
        },
      });

      expect(results).toMatchObject([{
        outcome: "blocked",
        error: { code: errorCode },
        pdf: { applicable: true, outcome: pdfOutcome, status: pdfStatus },
      }]);
      expect(summary).toMatchObject({ failure_count: 1, exit_code: 1, counts: { blocked: 1 } });
    });
  });

  it("forwards queue-watch CLI controls to the shared worker", async () => {
    await withTempWorkspace("llm-wiki-pdf-forward-watch-cli-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const first = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        overrides: { model: "gpt-watch-cli", reasoningEffort: "medium", pdfDetail: "low" },
      });
      await writeFile(fixture.logPath, "", "utf8");
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const stdout: string[] = [];
      try {
        const exitCode = await runCli([
          "queue",
          "ingest",
          "--auto",
          "--watch",
          "--repo",
          fixture.repoRoot,
          "--pdf-model",
          "gpt-watch-cli",
          "--pdf-reasoning-effort",
          "medium",
          "--pdf-detail",
          "low",
          "--force",
          "--json",
        ], {
          stdout: (message) => {
            stdout.push(message);
            const event = JSON.parse(message) as { event?: string };
            if (event.event === "result") {
              const listener = process.listeners("SIGINT").find((candidate) => !beforeSigint.has(candidate));
              listener?.("SIGINT");
            }
          },
          stderr: () => undefined,
          stdin: async () => "",
        });
        expect(exitCode).toBe(0);
        expect(stdout.map((line) => JSON.parse(line) as { event?: string })).toMatchObject([
          { event: "result" },
          { event: "summary" },
        ]);
        const extraction = (await readInvocations(fixture)).find((item) => item.task.startsWith("Extract this PDF"));
        expect(extraction?.args).toContain("gpt-watch-cli");
        expect(extraction?.args).toContain('model_reasoning_effort="medium"');
        expect(extraction?.task).toContain("PDF detail: low");
        expect((await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId)).state.extraction_id)
          .not.toBe(first.extraction_id);
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) process.off("SIGINT", listener);
        }
      }
    });
  });

  it("uses repository PDF settings for upload-triggered auto-ingest", async () => {
    await withTempWorkspace("llm-wiki-pdf-upload-auto-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.logPath, "", "utf8");
      const daemon = await startUploadDaemon({
        repoRoot: fixture.repoRoot,
        port: 0,
        autoIngest: { enabled: true },
      });
      try {
        const form = new FormData();
        form.set("title", "PDF Evidence");
        form.set("file", new Blob([PDF_BYTES], { type: "application/pdf" }), "Evidence.pdf");
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: { [UPLOAD_TOKEN_HEADER]: daemon.uploadToken },
          body: form,
        });
        const payload = await response.json() as {
          data?: { auto_ingest?: { outcome?: string; pdf?: PdfAutoIngestResult } };
        };

        expect(response.status).toBe(200);
        expect(payload.data?.auto_ingest).toMatchObject({
          outcome: "ingested",
          pdf: { applicable: true, outcome: "extracted" },
        });
        const extraction = (await readInvocations(fixture)).find((item) => item.task.startsWith("Extract this PDF"));
        expect(extraction?.args).toContain("gpt-pdf-test");
        expect(extraction?.args).toContain('model_reasoning_effort="high"');
        expect(extraction?.task).toContain("PDF detail: high");
        expect(JSON.stringify(payload)).not.toContain(CANONICAL_EVIDENCE);
      } finally {
        await daemon.close();
      }
    });
  });

  it("redacts PDF process diagnostics from upload-triggered failure results", async () => {
    await withTempWorkspace("llm-wiki-pdf-upload-redaction-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, "extract-secret-fail\n", "utf8");
      const daemon = await startUploadDaemon({
        repoRoot: fixture.repoRoot,
        port: 0,
        autoIngest: { enabled: true },
      });
      try {
        const form = new FormData();
        form.set("title", "PDF Evidence");
        form.set("file", new Blob([PDF_BYTES], { type: "application/pdf" }), "Evidence.pdf");
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: { [UPLOAD_TOKEN_HEADER]: daemon.uploadToken },
          body: form,
        });
        const payload = await response.json() as {
          data?: { auto_ingest?: { outcome?: string; pdf?: PdfAutoIngestResult } };
        };
        const serialized = JSON.stringify(payload);

        expect(response.status).toBe(200);
        expect(payload.data?.auto_ingest).toMatchObject({
          outcome: "blocked",
          pdf: { applicable: true, outcome: "failed", status: "failed" },
        });
        expect(serialized).not.toContain(STDERR_SECRET);
        expect(serialized).not.toContain(fixture.repoRoot);
        expect(serialized).not.toContain(CANONICAL_EVIDENCE);
        expect(serialized).not.toContain("Extract this PDF");
      } finally {
        await daemon.close();
      }
    });
  });

  it("redacts curator diagnostics after upload-triggered PDF extraction succeeds", async () => {
    await withTempWorkspace("llm-wiki-pdf-upload-curator-redaction-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await writeFile(fixture.modePath, "agent-secret-fail\n", "utf8");
      const daemon = await startUploadDaemon({
        repoRoot: fixture.repoRoot,
        port: 0,
        autoIngest: { enabled: true },
      });
      try {
        const form = new FormData();
        form.set("title", "PDF Evidence");
        form.set("file", new Blob([PDF_BYTES], { type: "application/pdf" }), "Evidence.pdf");
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: { [UPLOAD_TOKEN_HEADER]: daemon.uploadToken },
          body: form,
        });
        const payload = await response.json() as {
          data?: { auto_ingest?: { outcome?: string; pdf?: PdfAutoIngestResult } };
        };
        const serialized = JSON.stringify(payload);

        expect(response.status).toBe(200);
        expect(payload.data?.auto_ingest).toMatchObject({
          outcome: "blocked",
          pdf: { applicable: true, outcome: "extracted", status: "extracted" },
        });
        expect(serialized).not.toContain(STDERR_SECRET);
        expect(serialized).not.toContain(fixture.repoRoot);
        expect(serialized).not.toContain(CANONICAL_EVIDENCE);
      } finally {
        await daemon.close();
      }
    });
  });
});
