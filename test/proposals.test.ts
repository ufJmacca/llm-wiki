import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyProposalsWithValidation,
  createIngestProposalPolicy,
  createQueryProposalPolicy,
  normalizeFileProposals,
  validateProposalsOnTemporaryRepo,
} from "../src/proposals/index.js";
import { RuntimeCommandError } from "../src/runtime/errors.js";
import { pathExists, withTempWorkspace } from "./helpers/init.js";

async function writeRepoFile(repoRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = resolve(repoRoot, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function expectProposalRejected(action: () => unknown, path: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeCommandError);
    expect(error).toMatchObject({
      code: "PROPOSAL_REJECTED",
      path,
    });
    return;
  }

  throw new Error("Expected proposal rejection.");
}

describe("shared proposal core", () => {
  it("normalizes proposals, sorts paths, and rejects duplicate normalized paths", () => {
    // Arrange
    const policy = createIngestProposalPolicy();

    // Act
    const normalized = normalizeFileProposals(
      {
        files: [
          { path: "curated/topics/b.md", content: "second" },
          { path: "curated/topics/a.md", content: "first" },
        ],
      },
      policy,
    );

    // Assert
    expect(normalized.map((proposal) => proposal.path)).toEqual([
      "curated/topics/a.md",
      "curated/topics/b.md",
    ]);
    expectProposalRejected(
      () => normalizeFileProposals(
        {
          files: [
            { path: "curated/topics/a.md", content: "first" },
            { path: "curated/topics//a.md", content: "duplicate" },
          ],
        },
        policy,
      ),
      "curated/topics/a.md",
    );
  });

  it.each([
    { name: "traversal", path: "curated/../raw/inputs/source.md" },
    { name: "backslash", path: "curated\\topics\\page.md" },
    { name: "absolute", path: "/curated/topics/page.md" },
    { name: "non-curated", path: "raw/inputs/source.md" },
    { name: "non-Markdown", path: "curated/topics/page.txt" },
  ])("rejects unsafe ingest proposal path: $name", ({ path }) => {
    // Arrange
    const policy = createIngestProposalPolicy();

    // Act and Assert
    expectProposalRejected(
      () => normalizeFileProposals({ files: [{ path, content: "content" }] }, policy),
      path,
    );
  });

  it("enforces query proposal output paths with the saved page, index, and log only", () => {
    // Arrange
    const policy = createQueryProposalPolicy("curated/questions/provider-answer.md");

    // Act
    const normalized = normalizeFileProposals(
      {
        files: [
          { path: "curated/log.md", content: "# Log\n" },
          { path: "curated/questions/provider-answer.md", content: "# Answer\n" },
          { path: "curated/index.md", content: "# Index\n" },
        ],
      },
      policy,
    );

    // Assert
    expect(normalized.map((proposal) => proposal.path)).toEqual([
      "curated/index.md",
      "curated/log.md",
      "curated/questions/provider-answer.md",
    ]);
    expectProposalRejected(
      () => normalizeFileProposals(
        {
          files: [
            { path: "curated/questions/provider-answer.md", content: "# Answer\n" },
            { path: "curated/sources/invented.md", content: "# Invented evidence\n" },
          ],
        },
        policy,
      ),
      "curated/sources/invented.md",
    );
  });

  it("appends curated log proposals without duplicating the log title", async () => {
    await withTempWorkspace("llm-wiki-proposal-log-append-", async (repoRoot) => {
      // Arrange
      await writeRepoFile(repoRoot, "curated/log.md", "# Log\n\n## Existing entry\n\n- preserved\n");
      await writeRepoFile(repoRoot, "curated/index.md", "# Index\n");
      const policy = createIngestProposalPolicy();

      // Act
      const result = await applyProposalsWithValidation(
        repoRoot,
        {
          files: [
            { path: "curated/log.md", content: "# Log\n\n## Proposed entry\n\n- appended\n" },
            { path: "curated/index.md", content: "# Index\n\n- updated\n" },
          ],
        },
        policy,
        async () => "validated",
      );
      const log = await readFile(resolve(repoRoot, "curated/log.md"), "utf8");

      // Assert
      expect(result).toEqual({
        appliedPaths: ["curated/index.md", "curated/log.md"],
        validation: "validated",
      });
      expect(log).toBe("# Log\n\n## Existing entry\n\n- preserved\n\n## Proposed entry\n\n- appended\n");
    });
  });

  it("rolls back created and overwritten files when validation fails after safe writes", async () => {
    await withTempWorkspace("llm-wiki-proposal-rollback-", async (repoRoot) => {
      // Arrange
      await writeRepoFile(repoRoot, "curated/index.md", "# Index\n\n- original\n");
      const policy = createIngestProposalPolicy();

      // Act
      const apply = applyProposalsWithValidation(
        repoRoot,
        {
          files: [
            { path: "curated/index.md", content: "# Index\n\n- rewritten\n" },
            { path: "curated/topics/new.md", content: "# New\n" },
          ],
        },
        policy,
        async () => {
          throw new Error("validation failed");
        },
      );

      // Assert
      await expect(apply).rejects.toThrow("validation failed");
      await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      await expect(pathExists(resolve(repoRoot, "curated/topics/new.md"))).resolves.toBe(false);
    });
  });

  it("applies proposals only inside the temporary validation copy", async () => {
    await withTempWorkspace("llm-wiki-proposal-temp-validation-", async (repoRoot) => {
      // Arrange
      await writeRepoFile(repoRoot, "curated/index.md", "# Index\n\n- original\n");
      const policy = createIngestProposalPolicy();

      // Act
      await validateProposalsOnTemporaryRepo(
        repoRoot,
        { files: [{ path: "curated/index.md", content: "# Index\n\n- temp proposal\n" }] },
        policy,
        async (tempRepoRoot) => {
          await expect(readFile(resolve(tempRepoRoot, "curated/index.md"), "utf8")).resolves.toBe(
            "# Index\n\n- temp proposal\n",
          );
        },
      );

      // Assert
      await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
    });
  });
});
