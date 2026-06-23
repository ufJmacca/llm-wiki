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

async function readPackageManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageManifest;
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
    expect(help).toContain("--validate");
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
