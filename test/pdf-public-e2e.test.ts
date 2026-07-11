import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { withTempWorkspace } from "./helpers/init.js";

const repoRoot = resolve(import.meta.dirname, "..");
const packagedCli = resolve(repoRoot, "dist/src/cli.js");
const plugin = "pdf@openai-primary-runtime";
const canonicalEvidence = "PACKAGED_PDF_CANONICAL_EVIDENCE";
const pdfBytes = Buffer.from("%PDF-1.7\npackaged public interface\n%%EOF\n", "utf8");

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type FakeInvocation = {
  args: string[];
  cwd: string;
  task: string;
};

type SourceCaptureEnvelope = {
  data: {
    source: {
      source_id: string;
      original_path: string;
      queue_path: string;
      source_card_path: string;
    };
  };
};

type ExtractionEnvelope = {
  data: {
    outcome: "extracted" | "reused";
    extraction_id: string;
    artifact_path: string;
    metadata_path: string;
  };
};

type IngestEnvelope = {
  data: {
    mode: string;
    source: { source_id: string; status: string };
    queue: { status: string };
    pdf?: {
      applicable: boolean;
      outcome: string;
      status: string;
      extraction_id: string;
      artifact_path: string;
    };
  };
};

async function runPackaged(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(process.execPath, [packagedCli, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectCommand);
    child.once("close", (exitCode) => resolveCommand({ exitCode, stdout, stderr }));
  });
}

async function installFakeCodex(workspaceDir: string): Promise<{
  binDir: string;
  logPath: string;
}> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, "codex");
  const logPath = resolve(workspaceDir, "packaged-codex.jsonl");
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const task = fs.readFileSync(0, 'utf8');",
    "const mode = process.env.PACKAGED_CODEX_MODE || 'success';",
    "fs.appendFileSync(process.env.PACKAGED_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd(), task }) + '\\n');",
    "if (args.includes('plugin')) {",
    "  if (mode === 'plugin-fail') { console.error('packaged synthetic plugin-list failure'); process.exit(7); }",
    "  if (mode === 'plugin-malformed') { process.stdout.write('{bad json'); process.exit(0); }",
    "  if (mode === 'plugin-missing') { process.stdout.write(JSON.stringify({ installed: [], available: [] })); process.exit(0); }",
    "  if (mode === 'plugin-disabled') { process.stdout.write(JSON.stringify({ installed: [{ pluginId: 'pdf@openai-primary-runtime', installed: true, enabled: false, version: '9.8.7' }], available: [] })); process.exit(0); }",
    "  process.stdout.write(JSON.stringify({ installed: [{ pluginId: 'pdf@openai-primary-runtime', installed: true, enabled: true, version: '9.8.7' }], available: [] }));",
    "  process.exit(0);",
    "}",
    "if (task.startsWith('Extract this PDF')) {",
    "  if (mode === 'extract-fail') { console.error('packaged synthetic extraction failure'); process.exit(23); }",
    "  const output = task.match(/^Permitted output path: (.+)$/m)?.[1];",
    "  if (!output) process.exit(20);",
    "  fs.mkdirSync(path.dirname(output), { recursive: true });",
    `  fs.writeFileSync(output, '# Packaged PDF\\n\\n${canonicalEvidence}\\n', 'utf8');`,
    "  if (mode === 'sibling') fs.writeFileSync(path.join(path.dirname(output), 'metadata.json'), '{}', 'utf8');",
    "  process.exit(0);",
    "}",
    `if (!task.includes(${JSON.stringify(canonicalEvidence)})) { console.error('canonical PDF artifact missing'); process.exit(21); }`,
    "const sourceId = task.match(/Source ID: (src_[^\\n]+)/)?.[1];",
    "const sourceCard = task.match(/- (raw\\/inputs\\/[^\\n]+\\/_source\\.md)/)?.[1];",
    "if (!sourceId || !sourceCard) process.exit(22);",
    "const title = 'Packaged PDF ingest ' + sourceId;",
    "const summary = ['---', 'type: source_summary', 'title: ' + JSON.stringify(title), 'visibility: private', 'source_ids:', '  - ' + sourceId, 'source_id: ' + sourceId, '---', '', '# ' + title, '', 'The validated packaged PDF artifact supports this summary.', ''].join('\\n');",
    "const index = ['---', 'type: index', 'title: Index', 'visibility: private', 'source_ids: []', '---', '', '# Index', '', '- [[sources/' + sourceId + '|' + title + ']]', ''].join('\\n');",
    `const log = ['# Log', '', '## [2026-07-11T12:00:00.000Z] ingest | ' + sourceId + ' | Packaged PDF ingest completed', '', '- actor: codex', '- command: "llm-wiki ingest ' + sourceId + ' --auto"', '- git_branch:', '- git_commit:', '- raw_source: ' + sourceCard, '- created:', '  - curated/sources/' + sourceId + '.md', '- updated:', '  - curated/index.md', '- contradictions:', '- follow_ups:', ''].join('\\n');`,
    "fs.mkdirSync(path.join(process.cwd(), 'curated/sources'), { recursive: true });",
    "fs.writeFileSync(path.join(process.cwd(), 'curated/sources', sourceId + '.md'), summary, 'utf8');",
    "fs.writeFileSync(path.join(process.cwd(), 'curated/index.md'), index, 'utf8');",
    "fs.writeFileSync(path.join(process.cwd(), 'curated/log.md'), log, 'utf8');",
    "",
  ].join("\n"), "utf8");
  await chmod(executablePath, 0o755);
  return { binDir, logPath };
}

async function readInvocations(logPath: string): Promise<FakeInvocation[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeInvocation);
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function readTreeSnapshot(rootDir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = resolve(rootDir, relativeDir);
    const entries = (await readdir(absoluteDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = resolve(rootDir, relativePath);
      if (entry.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = sha256(await readFile(absolutePath));
      }
    }
  }

  await visit("");
  return snapshot;
}

async function createPackagedFixture(workspaceDir: string): Promise<{
  wikiDir: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  source: SourceCaptureEnvelope["data"]["source"];
}> {
  const fake = await installFakeCodex(workspaceDir);
  const wikiDir = resolve(workspaceDir, "wiki");
  const inputPath = resolve(workspaceDir, "Evidence.pdf");
  const env = {
    ...process.env,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    PACKAGED_CODEX_LOG: fake.logPath,
  };
  await writeFile(inputPath, pdfBytes);
  const initialized = await runPackaged(
    ["init", wikiDir, "--agent", "codex", "--no-git", "--json"],
    workspaceDir,
    env,
  );
  expect(initialized).toMatchObject({ exitCode: 0, stderr: "" });
  const added = await runPackaged(
    ["add", inputPath, "--repo", wikiDir, "--title", "Packaged PDF", "--json"],
    workspaceDir,
    env,
  );
  expect(added.exitCode).toBe(0);
  const source = (JSON.parse(added.stdout) as SourceCaptureEnvelope).data.source;
  return { wikiDir, env, logPath: fake.logPath, source };
}

describe("packaged Codex PDF public interface", () => {
  it("runs the scaffold-documented extraction and automated ingest workflow through the built binary", async () => {
    await withTempWorkspace("llm-wiki-pdf-packaged-e2e-", async (workspaceDir) => {
      const fixture = await createPackagedFixture(workspaceDir);
      const { wikiDir, env, source } = fixture;
      const originalBefore = await readFile(resolve(wikiDir, source.original_path));

      for (const modeArgs of [
        ["ingest", source.source_id],
        ["ingest", source.source_id, "--provider", "local"],
      ]) {
        const gated = await runPackaged([...modeArgs, "--repo", wikiDir, "--json"], workspaceDir, env);
        expect(gated.exitCode).toBe(1);
        expect(JSON.parse(gated.stdout)).toMatchObject({
          error: {
            code: "PDF_ARTIFACT_REQUIRED",
            hint: expect.stringContaining(`llm-wiki extract pdf ${source.source_id}`),
          },
        });
      }

      const extracted = await runPackaged([
        "extract", "pdf", source.source_id,
        "--repo", wikiDir,
        "--pdf-model", "gpt-packaged",
        "--pdf-reasoning-effort", "medium",
        "--pdf-detail", "low",
        "--json",
      ], workspaceDir, env);
      expect(extracted.exitCode).toBe(0);
      const extraction = (JSON.parse(extracted.stdout) as ExtractionEnvelope).data;
      expect(extraction.outcome).toBe("extracted");

      const ingested = await runPackaged([
        "ingest", source.source_id,
        "--repo", wikiDir,
        "--auto",
        "--pdf-model", "gpt-packaged",
        "--pdf-reasoning-effort", "medium",
        "--pdf-detail", "low",
        "--json",
      ], workspaceDir, env);
      expect(ingested.exitCode).toBe(0);
      const ingest = (JSON.parse(ingested.stdout) as IngestEnvelope).data;
      expect(ingest).toMatchObject({
        mode: "agent",
        source: { source_id: source.source_id, status: "ingested" },
        queue: { status: "ingested" },
        pdf: {
          applicable: true,
          outcome: "reused",
          status: "extracted",
          extraction_id: extraction.extraction_id,
          artifact_path: extraction.artifact_path,
        },
      });

      const invocations = await readInvocations(fixture.logPath);
      expect(invocations.map((entry) => {
        if (entry.args.slice(-3).join("\0") === ["plugin", "list", "--json"].join("\0")) return "preflight";
        if (entry.task.startsWith("Extract this PDF")) return "extract";
        return "curate";
      })).toEqual(["preflight", "extract", "preflight", "curate"]);
      expect(invocations.filter((entry) => entry.args.at(-3) === "plugin").map((entry) => entry.args)).toEqual([
        ["--ask-for-approval", "never", "--sandbox", "workspace-write", "plugin", "list", "--json"],
        ["--ask-for-approval", "never", "--sandbox", "workspace-write", "plugin", "list", "--json"],
      ]);
      const extractionInvocations = invocations.filter((entry) => entry.task.startsWith("Extract this PDF"));
      const curatorInvocations = invocations.filter(
        (entry) => entry.task !== "" && !entry.task.startsWith("Extract this PDF"),
      );
      expect(extractionInvocations).toHaveLength(1);
      expect(extractionInvocations[0]?.args).toEqual([
        "--ask-for-approval", "never",
        "--sandbox", "workspace-write",
        "--model", "gpt-packaged",
        "-c", 'model_reasoning_effort="medium"',
        "exec", "-",
      ]);
      expect(extractionInvocations[0]?.task).toContain("PDF detail: low");
      expect(curatorInvocations).toHaveLength(1);
      expect(curatorInvocations[0]?.task).toContain(canonicalEvidence);

      const metadata = JSON.parse(await readFile(resolve(wikiDir, extraction.metadata_path), "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        source_id: source.source_id,
        extraction_id: extraction.extraction_id,
        plugin,
        plugin_version: "9.8.7",
        model_selection: "explicit",
        requested_model: "gpt-packaged",
        model_descriptor: "explicit:gpt-packaged",
        reasoning_effort: "medium",
        pdf_detail: "low",
        original_hash: sha256(pdfBytes),
      });
      const queue = JSON.parse(await readFile(resolve(wikiDir, source.queue_path), "utf8")) as {
        status: string;
        pdf_extraction: Record<string, unknown>;
      };
      const sourceCard = parse((await readFile(resolve(wikiDir, source.source_card_path), "utf8")).match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "") as {
        status: string;
        pdf_extraction: Record<string, unknown>;
      };
      expect(queue.status).toBe("ingested");
      expect(sourceCard.status).toBe("ingested");
      expect(queue.pdf_extraction).toEqual(sourceCard.pdf_extraction);
      expect(queue.pdf_extraction).toMatchObject({ status: "extracted", extraction_id: extraction.extraction_id });
      expect(await readFile(resolve(wikiDir, source.original_path))).toEqual(originalBefore);
      expect(`${extracted.stdout}\n${ingested.stdout}`).not.toContain(canonicalEvidence);

      const publicAssets = resolve(wikiDir, "quartz/public/assets");
      await mkdir(publicAssets, { recursive: true });
      await mkdir(resolve(wikiDir, "quartz/public/raw/queue"), { recursive: true });
      await mkdir(resolve(wikiDir, "quartz/public/_llm-wiki/review"), { recursive: true });
      await writeFile(resolve(publicAssets, "renamed-original.bin"), originalBefore);
      await writeFile(resolve(publicAssets, "renamed-document.txt"), await readFile(resolve(wikiDir, extraction.artifact_path)));
      await writeFile(resolve(publicAssets, "renamed-metadata.txt"), await readFile(resolve(wikiDir, extraction.metadata_path)));
      await writeFile(resolve(wikiDir, `quartz/public/raw/queue/${source.source_id}.json`), JSON.stringify(queue));
      await writeFile(resolve(wikiDir, "quartz/public/_llm-wiki/review/status.html"), "private review state", "utf8");
      const publicLint = await runPackaged(
        ["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"],
        workspaceDir,
        env,
      );
      expect(publicLint.exitCode).toBe(1);
      const lintRules = ((JSON.parse(publicLint.stdout) as { issues: Array<{ rule_id: string }> }).issues)
        .map((issue) => issue.rule_id);
      expect(lintRules).toEqual(expect.arrayContaining([
        "public_static_pdf_original_leak",
        "public_static_pdf_document_leak",
        "public_static_pdf_metadata_leak",
        "public_static_raw_queue_leak",
        "public_static_review_page_leak",
      ]));

      const agents = await readFile(resolve(wikiDir, "AGENTS.md"), "utf8");
      const codex = await readFile(resolve(wikiDir, "CODEX.md"), "utf8");
      const generatedReadme = await readFile(resolve(wikiDir, "README.md"), "utf8");
      expect(agents).toContain("Queue status and PDF extraction status are separate state machines.");
      expect(codex).toContain(plugin);
      expect(codex).toContain("user-managed");
      expect(generatedReadme).toContain("llm-wiki extract pdf <source_id>");
      expect(generatedReadme).toContain("llm-wiki ingest <source_id> --auto");
      expect(generatedReadme).toContain("Original PDFs and `extracted/pdf/**` remain private");
    });
  });

  it("keeps packaged readiness mutation-free and supports inherited, failure, retry, changed-setting, and force paths", async () => {
    await withTempWorkspace("llm-wiki-pdf-packaged-recovery-", async (workspaceDir) => {
      const fixture = await createPackagedFixture(workspaceDir);
      const { wikiDir, env, source } = fixture;
      const queuePath = resolve(wikiDir, source.queue_path);
      const sourceCardPath = resolve(wikiDir, source.source_card_path);
      const originalPath = resolve(wikiDir, source.original_path);
      const pristine = {
        queue: await readFile(queuePath),
        source: await readFile(sourceCardPath),
        original: await readFile(originalPath),
        tree: await readTreeSnapshot(wikiDir),
      };

      const missingExecutable = await runPackaged(
        ["extract", "pdf", source.source_id, "--repo", wikiDir, "--json"],
        workspaceDir,
        { ...env, PATH: "" },
      );
      expect(missingExecutable.exitCode).toBe(1);
      expect(JSON.parse(missingExecutable.stdout)).toMatchObject({ error: { code: "PDF_CODEX_NOT_READY" } });
      expect(await readTreeSnapshot(wikiDir)).toEqual(pristine.tree);

      for (const [mode, code] of [
        ["plugin-fail", "PDF_PLUGIN_LIST_FAILED"],
        ["plugin-missing", "PDF_PLUGIN_MISSING"],
        ["plugin-disabled", "PDF_PLUGIN_DISABLED"],
        ["plugin-malformed", "PDF_PLUGIN_LIST_MALFORMED"],
      ] as const) {
        const result = await runPackaged(
          ["extract", "pdf", source.source_id, "--repo", wikiDir, "--json"],
          workspaceDir,
          { ...env, PACKAGED_CODEX_MODE: mode },
        );
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ error: { code } });
        expect(await readFile(queuePath)).toEqual(pristine.queue);
        expect(await readFile(sourceCardPath)).toEqual(pristine.source);
        expect(await readFile(originalPath)).toEqual(pristine.original);
        expect(await readTreeSnapshot(wikiDir)).toEqual(pristine.tree);
      }

      const inherited = await runPackaged(
        ["extract", "pdf", source.source_id, "--repo", wikiDir, "--json"],
        workspaceDir,
        env,
      );
      expect(inherited.exitCode).toBe(0);
      const inheritedData = (JSON.parse(inherited.stdout) as ExtractionEnvelope).data;
      const inheritedMetadata = JSON.parse(
        await readFile(resolve(wikiDir, inheritedData.metadata_path), "utf8"),
      ) as Record<string, unknown>;
      expect(inheritedMetadata).toMatchObject({
        model_selection: "inherited",
        requested_model: null,
        model_descriptor: null,
      });
      const inheritedAgain = await runPackaged(
        ["extract", "pdf", source.source_id, "--repo", wikiDir, "--json"],
        workspaceDir,
        env,
      );
      const inheritedAgainData = (JSON.parse(inheritedAgain.stdout) as ExtractionEnvelope).data;
      expect(inheritedAgainData.outcome).toBe("extracted");
      expect(inheritedAgainData.extraction_id).not.toBe(inheritedData.extraction_id);
      const inheritedExecs = (await readInvocations(fixture.logPath))
        .filter((entry) => entry.task.startsWith("Extract this PDF"))
        .slice(-2);
      expect(inheritedExecs).toHaveLength(2);
      for (const invocation of inheritedExecs) expect(invocation.args).not.toContain("--model");

      const runsRoot = resolve(wikiDir, source.original_path, "../extracted/pdf");
      const successfulRunsBeforeRejection = await readTreeSnapshot(runsRoot);

      const rejected = await runPackaged(
        ["extract", "pdf", source.source_id, "--repo", wikiDir, "--force", "--json"],
        workspaceDir,
        { ...env, PACKAGED_CODEX_MODE: "sibling" },
      );
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout)).toMatchObject({ error: { code: "PDF_WORKSPACE_MUTATION_REJECTED" } });
      expect(await readFile(originalPath)).toEqual(pristine.original);
      const rejectedQueue = JSON.parse(await readFile(queuePath, "utf8")) as {
        status: string;
        pdf_extraction: Record<string, unknown>;
      };
      const rejectedSource = parse(
        (await readFile(sourceCardPath, "utf8")).match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "",
      ) as { status: string; pdf_extraction: Record<string, unknown> };
      expect(rejectedQueue.status).toBe("queued");
      expect(rejectedSource.status).toBe("queued");
      expect(rejectedQueue.pdf_extraction).toEqual(rejectedSource.pdf_extraction);
      expect(rejectedQueue.pdf_extraction).toMatchObject({
        status: "failed",
        artifact_path: null,
        last_error_code: "PDF_WORKSPACE_MUTATION_REJECTED",
      });
      expect(await readTreeSnapshot(runsRoot)).toEqual(successfulRunsBeforeRejection);

      const retryArgs = [
        "extract", "pdf", source.source_id,
        "--repo", wikiDir,
        "--pdf-model", "gpt-retry",
        "--pdf-reasoning-effort", "high",
        "--pdf-detail", "auto",
        "--json",
      ];
      const retried = await runPackaged(retryArgs, workspaceDir, env);
      expect(retried.exitCode).toBe(0);
      const retriedData = (JSON.parse(retried.stdout) as ExtractionEnvelope).data;
      expect(retriedData.outcome).toBe("extracted");
      const reused = await runPackaged(retryArgs, workspaceDir, env);
      expect((JSON.parse(reused.stdout) as ExtractionEnvelope).data).toMatchObject({
        outcome: "reused",
        extraction_id: retriedData.extraction_id,
      });
      const forced = await runPackaged([...retryArgs.slice(0, -1), "--force", "--json"], workspaceDir, env);
      const forcedData = (JSON.parse(forced.stdout) as ExtractionEnvelope).data;
      expect(forcedData.outcome).toBe("extracted");
      expect(forcedData.extraction_id).not.toBe(retriedData.extraction_id);

      const autoArgs = [
        "ingest", source.source_id,
        "--repo", wikiDir,
        "--auto",
        "--pdf-model", "gpt-changed",
        "--pdf-reasoning-effort", "medium",
        "--pdf-detail", "high",
        "--json",
      ];
      const blocked = await runPackaged(autoArgs, workspaceDir, {
        ...env,
        PACKAGED_CODEX_MODE: "extract-fail",
      });
      expect(blocked.exitCode).toBe(1);
      expect(JSON.parse(blocked.stdout)).toMatchObject({ error: { code: "PDF_CODEX_EXTRACTION_FAILED" } });
      expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
        status: "blocked",
        pdf_extraction: { status: "failed" },
      });
      const requeued = await runPackaged(
        ["queue", "set-status", source.source_id, "queued", "--repo", wikiDir, "--json"],
        workspaceDir,
        env,
      );
      expect(requeued.exitCode).toBe(0);
      const recovered = await runPackaged(autoArgs, workspaceDir, env);
      expect(recovered.exitCode).toBe(0);
      expect((JSON.parse(recovered.stdout) as IngestEnvelope).data).toMatchObject({
        source: { status: "ingested" },
        pdf: { outcome: "extracted", status: "extracted" },
      });
      expect(await readFile(originalPath)).toEqual(pristine.original);
    });
  }, 15_000);
});
