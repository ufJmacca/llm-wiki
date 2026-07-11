import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  type?: unknown;
  bin?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const ciWorkflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageManifest;
}

async function readCiWorkflow(): Promise<string> {
  return readFile(ciWorkflowPath, "utf8");
}

function runNodeScript(scriptPath: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveCommand({ exitCode, stdout, stderr });
    });
  });
}

describe("llm-wiki CLI baseline", () => {
  it("declares the package contract required for the CLI binary", async () => {
    // Arrange
    const expectedScripts = ["build", "lint", "prepare", "prepack", "test"];

    // Act
    const manifest = await readPackageManifest();

    // Assert
    expect(manifest.name).toBe("llm-wiki");
    expect(manifest.type).toBe("module");
    expect(manifest.engines?.node).toBe(">=22");
    expect(manifest.bin?.["llm-wiki"]).toBe("./dist/src/cli.js");
    expect(manifest.dependencies?.yaml).toEqual(expect.any(String));
    expect(manifest.devDependencies?.yaml).toBeUndefined();
    for (const script of expectedScripts) {
      expect(manifest.scripts?.[script]).toEqual(expect.any(String));
    }
  });

  it("keeps package scripts and CI aligned with the Node 22 merge gate", async () => {
    // Arrange
    const expectedCiRuns = ["npm ci", "npm run lint", "npm test", "npm run build"];

    // Act
    const manifest = await readPackageManifest();
    const ciWorkflow = await readCiWorkflow();
    const runIndexes = expectedCiRuns.map((command) => ciWorkflow.indexOf(`run: ${command}`));

    // Assert
    expect(manifest.engines?.node).toBe(">=22");
    expect(manifest.scripts).toMatchObject({
      lint: "tsc -p tsconfig.json --noEmit",
      test: "npm run build && vitest run",
      build: "tsc -p tsconfig.json",
    });
    expect(ciWorkflow).toContain("node-version: 22");
    expect(runIndexes.every((index) => index >= 0)).toBe(true);
    expect(runIndexes).toEqual([...runIndexes].sort((left, right) => left - right));
  });

  it("prints version information without invoking scaffold behavior", async () => {
    // Arrange
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Act
    const exitCode = await runCli(["--version"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    // Assert
    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["llm-wiki 0.0.0"]);
    expect(stderr).toEqual([]);
  });

  it("omits removed daemon and upload commands from root help", async () => {
    // Arrange
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Act
    const exitCode = await runCli(["--help"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    const help = stdout.join("\n");

    // Assert
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(help).toContain("explore");
    expect(help).toContain("deploy");
    expect(help).not.toMatch(/\bdaemon\b/);
    expect(help).not.toMatch(/\bupload\b/);
  });

  it("exits non-zero for removed standalone daemon and upload commands", async () => {
    // Arrange
    const daemonOutput = { stdout: [] as string[], stderr: [] as string[] };
    const uploadOutput = { stdout: [] as string[], stderr: [] as string[] };

    // Act
    const daemonExitCode = await runCli(["daemon"], {
      stdout: (message) => daemonOutput.stdout.push(message),
      stderr: (message) => daemonOutput.stderr.push(message),
    });
    const uploadExitCode = await runCli(["upload", "init", "--target", "github"], {
      stdout: (message) => uploadOutput.stdout.push(message),
      stderr: (message) => uploadOutput.stderr.push(message),
    });

    // Assert
    expect(daemonExitCode).toBeGreaterThan(0);
    expect(uploadExitCode).toBeGreaterThan(0);
    expect(daemonOutput.stdout).toEqual([]);
    expect(uploadOutput.stdout).toEqual([]);
    expect(daemonOutput.stderr.join("\n")).toContain("unknown command 'daemon'");
    expect(uploadOutput.stderr.join("\n")).toContain("unknown command 'upload'");
  });

  it("describes ingest manual, local agent, auto, validation, and HTTP provider modes in help", async () => {
    // Arrange
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Act
    const exitCode = await runCli(["ingest", "--help"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    const help = stdout.join("\n");

    // Assert
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(help).toContain("manual prompt");
    expect(help).toContain("--agent <name>");
    expect(help).toContain("local agent execution");
    expect(help).toContain("--auto");
    expect(help).toMatch(/configured default local\s+agent/);
    expect(help).toContain("--provider <name>");
    expect(help).toContain("HTTP provider");
    expect(help).not.toContain("--provider codex");
    expect(help).toContain("--validate");
    expect(help).toContain("--pdf-model <model>");
    expect(help).toContain("--pdf-reasoning-effort <effort>");
    expect(help).toContain("--pdf-detail <detail>");
    expect(help).toContain("--force");
  });

  it("registers the extract pdf command family and shared runtime controls", async () => {
    const root = { stdout: [] as string[], stderr: [] as string[] };
    const rootExitCode = await runCli(["extract", "--help"], {
      stdout: (message) => root.stdout.push(message),
      stderr: (message) => root.stderr.push(message),
    });
    const pdf = { stdout: [] as string[], stderr: [] as string[] };
    const pdfExitCode = await runCli(["extract", "pdf", "--help"], {
      stdout: (message) => pdf.stdout.push(message),
      stderr: (message) => pdf.stderr.push(message),
    });

    expect(rootExitCode).toBe(0);
    expect(pdfExitCode).toBe(0);
    expect(root.stderr).toEqual([]);
    expect(pdf.stderr).toEqual([]);
    expect(root.stdout.join("\n")).toContain("pdf");
    expect(pdf.stdout.join("\n")).toContain("<source_id>");
    expect(pdf.stdout.join("\n")).toContain("--pdf-model <model>");
    expect(pdf.stdout.join("\n")).toContain("--pdf-reasoning-effort <effort>");
    expect(pdf.stdout.join("\n")).toContain("--pdf-detail <detail>");
    expect(pdf.stdout.join("\n")).toContain("--force");
    expect(pdf.stdout.join("\n")).toContain("--repo <path>");
    expect(pdf.stdout.join("\n")).toContain("--json");
    expect(pdf.stdout.join("\n")).toContain("--quiet");

    const queue = { stdout: [] as string[], stderr: [] as string[] };
    const queueExitCode = await runCli(["queue", "--help"], {
      stdout: (message) => queue.stdout.push(message),
      stderr: (message) => queue.stderr.push(message),
    });
    expect(queueExitCode).toBe(0);
    expect(queue.stderr).toEqual([]);
    expect(queue.stdout.join("\n")).toContain("--pdf-model <model>");
    expect(queue.stdout.join("\n")).toContain("--pdf-reasoning-effort <effort>");
    expect(queue.stdout.join("\n")).toContain("--pdf-detail <detail>");
    expect(queue.stdout.join("\n")).toContain("--force");
  });

  it("describes query manual, local agent, auto, validation, and HTTP provider modes in help", async () => {
    // Arrange
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Act
    const exitCode = await runCli(["query", "--help"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    const help = stdout.join("\n");

    // Assert
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(help).toContain("manual prompt");
    expect(help).toContain("--agent <name>");
    expect(help).toContain("local agent execution");
    expect(help).toContain("--auto");
    expect(help).toMatch(/configured default local\s+agent/);
    expect(help).toContain("--provider <name>");
    expect(help).toContain("HTTP provider");
    expect(help).not.toContain("--provider codex");
    expect(help).toContain("--validate");
  });

  it("runs the built package binary from a clean working directory", async () => {
    // Arrange
    const manifest = await readPackageManifest();
    const binTarget = manifest.bin?.["llm-wiki"];
    expect(binTarget).toEqual(expect.any(String));
    const binPath = resolve(repoRoot, binTarget as string);
    const workingDirectory = await mkdtemp(resolve(tmpdir(), "llm-wiki-bin-"));
    let result: CommandResult;
    let workingDirectoryEntries: string[];

    try {
      // Act
      result = await runNodeScript(binPath, ["--version"], workingDirectory);
      workingDirectoryEntries = await readdir(workingDirectory);
    } finally {
      await rm(workingDirectory, { force: true, recursive: true });
    }

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("llm-wiki 0.0.0\n");
    expect(result.stderr).toBe("");
    expect(workingDirectoryEntries).toEqual([]);
  });

  it("runs when invoked through an npm-style bin symlink", async () => {
    // Arrange
    const manifest = await readPackageManifest();
    const binTarget = manifest.bin?.["llm-wiki"];
    expect(binTarget).toEqual(expect.any(String));
    const binPath = resolve(repoRoot, binTarget as string);
    const workingDirectory = await mkdtemp(resolve(tmpdir(), "llm-wiki-bin-link-"));
    const linkPath = resolve(workingDirectory, "llm-wiki");
    let result: CommandResult;

    try {
      await symlink(binPath, linkPath, "file");

      // Act
      result = await runNodeScript(linkPath, ["--version"], workingDirectory);
    } finally {
      await rm(workingDirectory, { force: true, recursive: true });
    }

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("llm-wiki 0.0.0\n");
    expect(result.stderr).toBe("");
  });
});
