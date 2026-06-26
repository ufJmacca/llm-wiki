import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { pathExists, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

describe("remote upload scaffold CLI", () => {
  it("rejects the removed GitHub remote upload scaffold command without writing files", async () => {
    await withTempWorkspace("llm-wiki-upload-removed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");

      // Act
      const result = await runCliBuffered(["upload", "init", "--target", "github", "--repo", wikiDir, "--json"]);

      // Assert
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join("\n")).toContain("unknown command 'upload'");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/upload/forms/remote-github.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/upload/github.yml"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "docs/remote-upload-github.md"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "upload/github/serverless/raw-upload.ts"))).toBe(false);
    });
  });
});
