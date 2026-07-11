import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createWiki } from "../src/scaffold/createWiki.js";
import {
  DEFAULT_PDF_INGESTION_CONFIG,
  loadPdfIngestionRuntimeConfig,
  resolvePdfExtractionSettings,
} from "../src/pdf/config.js";
import {
  parseCodexPluginListJson,
  preflightPdfIngestion,
} from "../src/pdf/readiness.js";
import { readTreeSnapshot, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const REQUIRED_PLUGIN = "pdf@openai-primary-runtime";

async function writeConfig(
  repoRoot: string,
  input: {
    command?: string;
    args?: string[];
    pdf?: string[];
  } = {},
): Promise<void> {
  await mkdir(resolve(repoRoot, ".llm-wiki"), { recursive: true });
  const args = input.args ?? ["exec"];
  await writeFile(
    resolve(repoRoot, ".llm-wiki/config.yml"),
    [
      "version: 1",
      "agents:",
      "  codex:",
      "    type: local-exec",
      `    command: ${JSON.stringify(input.command ?? "codex")}`,
      "    args:",
      ...args.map((arg) => `      - ${JSON.stringify(arg)}`),
      ...(input.pdf === undefined ? [] : ["pdf_ingestion:", ...input.pdf.map((line) => `  ${line}`)]),
      "features:",
      "  git: false",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createExecutable(workspaceDir: string, source: string): Promise<string> {
  const executablePath = resolve(workspaceDir, "bin", "codex");
  await mkdir(resolve(workspaceDir, "bin"), { recursive: true });
  await writeFile(executablePath, `#!${process.execPath}\n${source}\n`, "utf8");
  await chmod(executablePath, 0o755);
  return executablePath;
}

describe("PDF ingestion configuration", () => {
  it("applies documented defaults and parses explicit repository values", async () => {
    await withTempWorkspace("llm-wiki-pdf-config-", async (workspaceDir) => {
      const defaultRepo = resolve(workspaceDir, "default");
      await writeConfig(defaultRepo);

      const defaults = await loadPdfIngestionRuntimeConfig(defaultRepo);
      expect(defaults).toMatchObject({
        ok: true,
        value: {
          config: DEFAULT_PDF_INGESTION_CONFIG,
          agent: { name: "codex", type: "local-exec", args: ["exec"] },
          invocation: { globalPrefix: [], execSuffix: [] },
        },
      });

      const explicitRepo = resolve(workspaceDir, "explicit");
      await writeConfig(explicitRepo, {
        args: ["--profile", "wiki", "exec", "--ephemeral"],
        pdf: [
          "codex_agent: codex",
          `required_plugin: ${REQUIRED_PLUGIN}`,
          "model: gpt-5.2",
          "reasoning_effort: medium",
          "pdf_detail: low",
          "timeout_seconds: 123",
          "require_artifact_before_ingest: true",
        ],
      });

      const explicit = await loadPdfIngestionRuntimeConfig(explicitRepo);
      expect(explicit).toMatchObject({
        ok: true,
        value: {
          config: {
            codexAgent: "codex",
            requiredPlugin: REQUIRED_PLUGIN,
            model: "gpt-5.2",
            reasoningEffort: "medium",
            pdfDetail: "low",
            timeoutSeconds: 123,
            requireArtifactBeforeIngest: true,
          },
          invocation: {
            globalPrefix: ["--profile", "wiki"],
            execSuffix: ["--ephemeral"],
          },
        },
      });
    });
  });

  it("resolves CLI values over config and rejects invalid settings", async () => {
    const resolved = resolvePdfExtractionSettings(
      {
        ...DEFAULT_PDF_INGESTION_CONFIG,
        model: "repo-model",
        reasoningEffort: "medium",
        pdfDetail: "low",
      },
      {
        model: "cli-model",
        reasoningEffort: "xhigh",
        pdfDetail: "auto",
        force: true,
      },
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        model: "cli-model",
        reasoningEffort: "xhigh",
        pdfDetail: "auto",
        force: true,
      },
    });

    for (const overrides of [
      { model: " " },
      { reasoningEffort: "\t" },
      { pdfDetail: "ultra" },
    ]) {
      expect(resolvePdfExtractionSettings(DEFAULT_PDF_INGESTION_CONFIG, overrides)).toMatchObject({
        ok: false,
        error: { code: "PDF_CONFIG_INVALID" },
      });
    }
  });

  it.each([
    { pdf: ["required_plugin: another@runtime"], path: "required_plugin" },
    { pdf: ["reasoning_effort: ' '"], path: "reasoning_effort" },
    { pdf: ["pdf_detail: ultra"], path: "pdf_detail" },
    { pdf: ["timeout_seconds: 0"], path: "timeout_seconds" },
    { pdf: ["require_artifact_before_ingest: false"], path: "require_artifact_before_ingest" },
  ])("rejects malformed PDF config at $path", async ({ pdf, path }) => {
    await withTempWorkspace("llm-wiki-pdf-config-invalid-", async (workspaceDir) => {
      await writeConfig(workspaceDir, { pdf });
      expect(await loadPdfIngestionRuntimeConfig(workspaceDir)).toMatchObject({
        ok: false,
        error: {
          code: "PDF_CONFIG_INVALID",
          path: `.llm-wiki/config.yml:pdf_ingestion.${path}`,
        },
      });
    });
  });

  it.each([
    ["missing exec", ["--profile", "wiki"]],
    ["duplicate exec", ["exec", "exec"]],
    ["stdin prompt", ["exec", "-"]],
    ["managed short model", ["-m", "gpt-5", "exec"]],
    ["managed long model", ["--model=gpt-5", "exec"]],
    ["managed reasoning", ["-c", "model_reasoning_effort=\"low\"", "exec"]],
  ])("rejects an unsafe Codex argument shape: %s", async (_name, args) => {
    await withTempWorkspace("llm-wiki-pdf-config-argv-", async (workspaceDir) => {
      await writeConfig(workspaceDir, { args });
      expect(await loadPdfIngestionRuntimeConfig(workspaceDir)).toMatchObject({
        ok: false,
        error: { code: "PDF_CONFIG_INVALID", path: ".llm-wiki/config.yml:agents.codex.args" },
      });
    });
  });

  it("parses exec as a flag value without mistaking it for the subcommand", async () => {
    await withTempWorkspace("llm-wiki-pdf-config-exec-value-", async (workspaceDir) => {
      await writeConfig(workspaceDir, {
        args: ["--profile", "exec", "-c", "xmodel_reasoning_effort=\"kept\"", "exec", "--ephemeral"],
      });

      expect(await loadPdfIngestionRuntimeConfig(workspaceDir)).toMatchObject({
        ok: true,
        value: {
          invocation: {
            globalPrefix: ["--profile", "exec", "-c", "xmodel_reasoning_effort=\"kept\""],
            execSuffix: ["--ephemeral"],
          },
        },
      });
    });
  });

  it("rejects PDF controls on modes that cannot extract before repository mutation", async () => {
    await withTempWorkspace("llm-wiki-pdf-mode-options-", async (workspaceDir) => {
      const repoRoot = resolve(workspaceDir, "wiki");
      const initialized = await createWiki(repoRoot, {
        agent: "generic",
        obsidian: false,
        dataview: false,
        git: false,
        quartzReady: false,
        force: false,
      });
      expect(initialized.ok).toBe(true);
      const before = await readTreeSnapshot(repoRoot);

      for (const args of [
        ["ingest", "src_safe", "--pdf-detail", "high"],
        ["ingest", "src_safe", "--validate", "--force"],
        ["ingest", "src_safe", "--provider", "remote", "--pdf-model", "gpt-5"],
        ["queue", "show", "src_safe", "--force"],
      ]) {
        const result = await runCliBuffered([...args, "--repo", repoRoot, "--json"]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout[0]) as { error: { code: string } }).toMatchObject({
          error: { code: expect.stringMatching(/^(?:PDF_CONFIG_INVALID|QUEUE_INGEST_OPTION_INVALID)$/u) },
        });
        expect(await readTreeSnapshot(repoRoot)).toEqual(before);
      }
    });
  });

  it("rejects invalid PDF override values before resolving or starting Codex", async () => {
    await withTempWorkspace("llm-wiki-pdf-invalid-override-", async (workspaceDir) => {
      const repoRoot = resolve(workspaceDir, "wiki");
      const initialized = await createWiki(repoRoot, {
        agent: "generic",
        obsidian: false,
        dataview: false,
        git: false,
        quartzReady: false,
        force: false,
      });
      expect(initialized.ok).toBe(true);
      const before = await readTreeSnapshot(repoRoot);

      const result = await runCliBuffered([
        "ingest",
        "src_safe",
        "--auto",
        "--pdf-detail",
        "ultra",
        "--repo",
        repoRoot,
        "--json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout[0]) as { error: { code: string }; issues: unknown[] }).toMatchObject({
        error: { code: "PDF_CONFIG_INVALID" },
      });
      expect(await readTreeSnapshot(repoRoot)).toEqual(before);
    });
  });
});

describe("Codex PDF plugin readiness", () => {
  it("strictly parses the supported plugin-list schema and derives a stable descriptor", () => {
    expect(parseCodexPluginListJson(JSON.stringify({
      installed: [
        { pluginId: REQUIRED_PLUGIN, installed: true, enabled: true, version: "1.2.3" },
      ],
      available: [],
    }))).toEqual({
      ok: true,
      value: [
        {
          id: REQUIRED_PLUGIN,
          installed: true,
          enabled: true,
          version: "1.2.3",
          descriptor: `${REQUIRED_PLUGIN}#version:1.2.3`,
        },
      ],
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["unexpected top-level shape", JSON.stringify({ data: [] })],
    ["missing enabled", JSON.stringify({ installed: [{ pluginId: REQUIRED_PLUGIN, installed: true }] })],
    ["duplicate identifier", JSON.stringify({ installed: [
      { pluginId: REQUIRED_PLUGIN, installed: true, enabled: true, version: "1" },
      { pluginId: REQUIRED_PLUGIN, installed: true, enabled: true, version: "2" },
    ] })],
  ])("rejects malformed plugin-list output: %s", (_name, output) => {
    expect(parseCodexPluginListJson(output)).toMatchObject({
      ok: false,
      error: { code: "PDF_PLUGIN_LIST_MALFORMED" },
    });
  });

  it("runs only the configured global prefix plus plugin list --json without mutating the repository", async () => {
    await withTempWorkspace("llm-wiki-pdf-preflight-success-", async (workspaceDir) => {
      const logPath = resolve(workspaceDir, "argv.json");
      const repoRoot = resolve(workspaceDir, "wiki");
      const executable = await createExecutable(workspaceDir, [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
        `process.stdout.write(JSON.stringify({installed:[{pluginId:${JSON.stringify(REQUIRED_PLUGIN)},installed:true,enabled:true,version:'9.8.7'}],available:[]}));`,
      ].join("\n"));
      await writeConfig(repoRoot, {
        command: executable,
        args: ["--profile", "wiki", "exec", "--ephemeral"],
      });
      const before = await readTreeSnapshot(repoRoot);

      const result = await preflightPdfIngestion(repoRoot);

      expect(result).toMatchObject({
        ok: true,
        value: {
          executablePath: executable,
          plugin: {
            id: REQUIRED_PLUGIN,
            installed: true,
            enabled: true,
            version: "9.8.7",
            descriptor: `${REQUIRED_PLUGIN}#version:9.8.7`,
          },
        },
      });
      expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual([
        "--profile",
        "wiki",
        "plugin",
        "list",
        "--json",
      ]);
      expect(await readTreeSnapshot(repoRoot)).toEqual(before);
    });
  });

  it("reports missing referenced agents and executables without repository mutation", async () => {
    await withTempWorkspace("llm-wiki-pdf-preflight-not-ready-", async (workspaceDir) => {
      const missingAgentRepo = resolve(workspaceDir, "missing-agent");
      await mkdir(resolve(missingAgentRepo, ".llm-wiki"), { recursive: true });
      await writeFile(
        resolve(missingAgentRepo, ".llm-wiki/config.yml"),
        "version: 1\nfeatures:\n  git: false\n",
        "utf8",
      );
      const missingAgentBefore = await readTreeSnapshot(missingAgentRepo);
      expect(await preflightPdfIngestion(missingAgentRepo)).toMatchObject({
        ok: false,
        error: { code: "PDF_CODEX_NOT_READY" },
      });
      expect(await readTreeSnapshot(missingAgentRepo)).toEqual(missingAgentBefore);

      const missingExecutableRepo = resolve(workspaceDir, "missing-executable");
      await writeConfig(missingExecutableRepo, { command: resolve(workspaceDir, "missing", "codex") });
      const missingExecutableBefore = await readTreeSnapshot(missingExecutableRepo);
      expect(await preflightPdfIngestion(missingExecutableRepo)).toMatchObject({
        ok: false,
        error: { code: "PDF_CODEX_NOT_READY" },
      });
      expect(await readTreeSnapshot(missingExecutableRepo)).toEqual(missingExecutableBefore);
    });
  });

  it.each([
    {
      name: "non-zero plugin command",
      source: "process.stderr.write('synthetic failure'); process.exit(7);",
      code: "PDF_PLUGIN_LIST_FAILED",
    },
    {
      name: "missing plugin",
      source: "process.stdout.write(JSON.stringify({installed:[],available:[]}));",
      code: "PDF_PLUGIN_MISSING",
    },
    {
      name: "disabled plugin",
      source: `process.stdout.write(JSON.stringify({installed:[{pluginId:${JSON.stringify(REQUIRED_PLUGIN)},installed:true,enabled:false,version:'1'}],available:[]}));`,
      code: "PDF_PLUGIN_DISABLED",
    },
    {
      name: "malformed output",
      source: "process.stdout.write('{}');",
      code: "PDF_PLUGIN_LIST_MALFORMED",
    },
  ])("keeps preflight failure mutation-free: $name", async ({ source, code }) => {
    await withTempWorkspace("llm-wiki-pdf-preflight-failure-", async (workspaceDir) => {
      const repoRoot = resolve(workspaceDir, "wiki");
      const executable = await createExecutable(workspaceDir, source);
      await writeConfig(repoRoot, { command: executable });
      const before = await readTreeSnapshot(repoRoot);

      expect(await preflightPdfIngestion(repoRoot)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(await readTreeSnapshot(repoRoot)).toEqual(before);
    });
  });

  it("bounds plugin discovery with its own timeout", async () => {
    await withTempWorkspace("llm-wiki-pdf-preflight-timeout-", async (workspaceDir) => {
      const repoRoot = resolve(workspaceDir, "wiki");
      const executable = await createExecutable(workspaceDir, "setTimeout(() => {}, 10_000);");
      await writeConfig(repoRoot, { command: executable });

      expect(await preflightPdfIngestion(repoRoot, { timeoutMs: 25 })).toMatchObject({
        ok: false,
        error: {
          code: "PDF_PLUGIN_LIST_FAILED",
          timedOut: true,
        },
      });
    });
  });
});
