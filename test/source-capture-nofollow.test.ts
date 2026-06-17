import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const capturedAt = "2026-06-17T11:28:42.778Z";

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("source capture no-follow reads", () => {
  it("rejects a source path swapped to a symlink before bytes are read", async () => {
    const workspaceDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-add-source-race-"));

    try {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "source.md");
      const symlinkTargetPath = resolve(workspaceDir, "target.md");
      await mkdir(resolve(wikiDir, "raw", "queue"), { recursive: true });
      await mkdir(resolve(wikiDir, "curated"), { recursive: true });
      await writeFile(resolve(wikiDir, "curated", "log.md"), "", "utf8");
      await writeFile(sourcePath, "# Source\n", "utf8");
      await writeFile(symlinkTargetPath, "# Target\n", "utf8");

      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let swapped = false;
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        realpath: async (path: Parameters<typeof actualFs.realpath>[0]) => {
          const resolvedPath = await actualFs.realpath(path);

          if (!swapped && typeof path === "string" && path === sourcePath) {
            swapped = true;
            await actualFs.rm(sourcePath, { force: true });
            await actualFs.symlink(symlinkTargetPath, sourcePath);
          }

          return resolvedPath;
        },
      }));

      const { captureFileSource } = await import("../src/sourceCapture/index.js");

      // Act
      const result = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Race",
        now: new Date(capturedAt),
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: {
          code: "SOURCE_PATH_UNSAFE",
          message: `Source path must not be a symlink: ${sourcePath}`,
          path: sourcePath,
          hint: "Pass the real source file path so capture provenance is explicit.",
        },
      });
      expect(await pathExists(resolve(wikiDir, "raw", "inputs"))).toBe(false);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });
});
