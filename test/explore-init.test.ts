import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

type ExploreInitEnvelope = {
  ok: true;
  command: "explore.init";
  repo: string;
  data: {
    created_paths: string[];
    install: {
      attempted: boolean;
      ok: boolean;
      command: string;
      cwd: string;
      stdout: string;
      stderr: string;
    };
  };
  warnings: string[];
};

type ExploreInitFailureEnvelope = {
  ok: false;
  command: "explore.init";
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    message: string;
    path: string;
    hint: string;
  }>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseExploreInit(stdout: string[]): ExploreInitEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreInitEnvelope;
}

function parseExploreInitFailure(stdout: string[]): ExploreInitFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreInitFailureEnvelope;
}

function installCallback(args: unknown[]): (error: Error | null, stdout?: string, stderr?: string) => void {
  const callback = args.at(-1);
  expect(callback).toEqual(expect.any(Function));

  return callback as (error: Error | null, stdout?: string, stderr?: string) => void;
}

describe("explore init command", () => {
  it("creates isolated Quartz runtime placeholders and prints exact install instructions without installing by default", async () => {
    await withTempWorkspace("llm-wiki-explore-init-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        ok: true,
        command: "explore.init",
        repo: wikiDir,
        data: {
          install: {
            attempted: false,
            ok: false,
            command: "cd quartz && npm install",
            cwd: resolve(wikiDir, "quartz"),
            stdout: "",
            stderr: "",
          },
        },
        warnings: ["Quartz dependencies were not installed. Run: cd quartz && npm install"],
      });
      expect(payload.data.created_paths).toEqual([
        "quartz/README.md",
        "quartz/components/LlmWikiQueueDashboard.tsx",
        "quartz/components/LlmWikiReviewPanel.tsx",
        "quartz/components/LlmWikiSourceBadge.tsx",
        "quartz/components/LlmWikiUploadForm.tsx",
        "quartz/components/LlmWikiVisibilityWarning.tsx",
        "quartz/package.json",
        "quartz/quartz.config.ts",
        "quartz/quartz.layout.ts",
      ]);
      await expect(readGeneratedFile(wikiDir, "quartz/package.json")).resolves.toContain("\"private\": true");
      await expect(readGeneratedFile(wikiDir, "quartz/quartz.config.ts")).resolves.toContain("LLM Wiki Quartz placeholder");
      await expect(readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx")).resolves.toContain(
        "llm-wiki-review-panel",
      );
    });
  });

  it("prints install instructions in human output when dependency install is not requested", async () => {
    await withTempWorkspace("llm-wiki-explore-init-human-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(result.stdout.join("\n")).toContain("Install dependencies: cd quartz && npm install");
    });
  });

  it("leaves existing Quartz runtime files unchanged when initializing missing placeholders", async () => {
    await withTempWorkspace("llm-wiki-explore-init-existing-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const customPackageJson = "{\"private\": true, \"name\": \"custom-quartz\"}\n";
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/package.json"), customPackageJson, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload.data.created_paths).toContain("quartz/quartz.config.ts");
      expect(payload.data.created_paths).not.toContain("quartz/package.json");
      expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("quartz/package.json")]));
      await expect(readGeneratedFile(wikiDir, "quartz/package.json")).resolves.toBe(customPackageJson);
    });
  });

  it("runs npm install only when --install is supplied", async () => {
    await withTempWorkspace("llm-wiki-explore-init-install-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      execFileMock.mockImplementation((...args: unknown[]) => {
        installCallback(args)(null, "installed\n", "");
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--install", "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledWith("npm", ["install"], { cwd: resolve(wikiDir, "quartz") }, expect.any(Function));
      expect(payload.data.install).toEqual({
        attempted: true,
        ok: true,
        command: "cd quartz && npm install",
        cwd: resolve(wikiDir, "quartz"),
        stdout: "installed\n",
        stderr: "",
      });
      expect(payload.warnings).toEqual([]);
    });
  });

  it("returns a JSON failure envelope when explicit dependency install fails", async () => {
    await withTempWorkspace("llm-wiki-explore-init-install-failure-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      execFileMock.mockImplementation((...args: unknown[]) => {
        installCallback(args)(new Error("install failed"), "", "registry unavailable\n");
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--install", "--json"]);
      const payload = parseExploreInitFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "explore.init",
        repo: wikiDir,
        error: {
          code: "QUARTZ_INSTALL_FAILED",
          message: "Quartz dependency install failed.",
          hint: "Run cd quartz && npm install after fixing the package manager error.",
        },
        issues: [
          {
            severity: "error",
            code: "QUARTZ_INSTALL_FAILED",
            path: "quartz/package.json",
          },
        ],
      });
      expect(await pathExists(resolve(wikiDir, "quartz/package.json"))).toBe(true);
    });
  });

  it("keeps generated wiki ignore rules aligned with generated Quartz content and build output", async () => {
    await withTempWorkspace("llm-wiki-explore-init-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(gitignore).toContain("quartz/content/");
      expect(gitignore).toContain("quartz/public/");
      expect(gitignore).toContain("quartz/.quartz-cache/");
    });
  });
});
