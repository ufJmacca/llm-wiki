import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileAsync = promisify(execFile);

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeGitRepository(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: wikiDir });
}

async function installFakeNpm(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const npmPath = resolve(binDir, "npm");
  await writeFile(
    npmPath,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
mkdirSync(resolve(process.cwd(), "quartz"), { recursive: true });
writeFileSync(resolve(process.cwd(), "quartz/build.ts"), "export {}\\n", "utf8");
console.log("installed");
`,
    "utf8",
  );
  await chmod(npmPath, 0o755);
}

async function gitIgnoresPath(wikiDir: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", path], { cwd: wikiDir });
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return false;
    }

    throw error;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

describe("explore runtime ignore rules", () => {
  it("repairs nested Quartz ignore negations that expose the copied runtime tree", async () => {
    await withTempWorkspace("llm-wiki-explore-runtime-ignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), "!quartz/\n!quartz/**\n", "utf8");
      expect(await gitIgnoresPath(wikiDir, "quartz/quartz/build.ts")).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = JSON.parse(result.stdout[0] ?? "{}") as { warnings: string[] };
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(
        expect.arrayContaining(["Repaired nested generated Quartz runtime ignore rule: quartz/.gitignore"]),
      );
      expect(quartzGitignore.trimEnd().endsWith("quartz/")).toBe(true);
      expect(await gitIgnoresPath(wikiDir, "quartz/quartz/build.ts")).toBe(true);
    });
  });

  it("repairs copied runtime ignores when the wiki is inside a parent Git worktree", async () => {
    await withTempWorkspace("llm-wiki-explore-runtime-ignore-parent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeBinDir = resolve(workspaceDir, "bin");
      const originalPath = process.env.PATH;
      await execFileAsync("git", ["init"], { cwd: workspaceDir });
      await initializeWiki(wikiDir);
      await installFakeNpm(fakeBinDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), "!quartz/\n!quartz/**\n", "utf8");
      expect(await gitIgnoresPath(wikiDir, "quartz/quartz/build.ts")).toBe(false);

      try {
        process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;

        // Act
        const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--install", "--json"]);
        const payload = JSON.parse(result.stdout[0] ?? "{}") as { warnings: string[] };
        const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.warnings).toEqual(
          expect.arrayContaining(["Repaired nested generated Quartz runtime ignore rule: quartz/.gitignore"]),
        );
        expect(quartzGitignore.trimEnd().endsWith("quartz/")).toBe(true);
        expect(await gitIgnoresPath(wikiDir, "quartz/quartz/build.ts")).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});
