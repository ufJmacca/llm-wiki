import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LocalAgentExecutionError,
  runLocalAgentInTemporaryWorkspace,
} from "../src/agents/index.js";
import { createIngestProposalPolicy } from "../src/proposals/index.js";
import { RuntimeCommandError } from "../src/runtime/errors.js";
import type { LocalAgentConfig } from "../src/runtime/config.js";
import { pathExists, withTempWorkspace } from "./helpers/init.js";

type FakeExecInput = {
  source: string;
};

type WorkspaceLog = {
  cwd: string;
  pwd?: string;
  copied?: {
    git: boolean;
    nodeModules: boolean;
    quartzCache: boolean;
    quartzPublic: boolean;
  };
};

function localAgent(overrides: Partial<LocalAgentConfig>): LocalAgentConfig {
  return {
    name: "codex",
    type: "local-exec",
    command: "codex",
    args: ["exec"],
    approvalPolicy: null,
    sandboxMode: null,
    outputMode: null,
    timeoutSeconds: 30,
    ...overrides,
  };
}

async function createFakeExecutable({ source }: FakeExecInput): Promise<{ binDir: string; executablePath: string }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-agent-workspace-bin-"));
  const executablePath = resolve(binDir, "codex");
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return { binDir, executablePath };
}

async function writeRepoFile(repoRoot: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolutePath = resolve(repoRoot, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content);
}

async function readWorkspaceLog(logPath: string): Promise<WorkspaceLog> {
  return JSON.parse(await readFile(logPath, "utf8")) as WorkspaceLog;
}

function expectOutsideRepo(repoRoot: string, path: string): void {
  const relativeToRepo = relative(repoRoot, path);
  expect(relativeToRepo === "" || (!relativeToRepo.startsWith("..") && !isAbsolute(relativeToRepo))).toBe(false);
}

function expectInsideSystemTemp(path: string): void {
  const relativeToTemp = relative(resolve(tmpdir()), path);
  expect(relativeToTemp).not.toBe("");
  expect(relativeToTemp.startsWith("..") || isAbsolute(relativeToTemp)).toBe(false);
}

async function seedRepo(repoRoot: string): Promise<void> {
  await writeRepoFile(repoRoot, ".git/config", "[core]\n\trepositoryformatversion = 0\n");
  await writeRepoFile(repoRoot, ".llm-wiki/config.yml", "features:\n  git: true\n");
  await writeRepoFile(repoRoot, "raw/source.md", "# Raw source\n");
  await writeRepoFile(repoRoot, "curated/index.md", "# Index\n\n- original\n");
  await writeRepoFile(repoRoot, "curated/log.md", "# Log\n");
  await writeRepoFile(repoRoot, "node_modules/heavy/index.js", "module.exports = true;\n");
  await writeRepoFile(repoRoot, "quartz/.quartz-cache/cache.bin", new Uint8Array([1, 2, 3]));
  await writeRepoFile(repoRoot, "quartz/public/index.html", "<!doctype html>\n");
}

describe("agent temporary workspace diff extraction", () => {
  it("runs the agent in a cleaned-up temp repo copy and extracts changed Markdown proposals", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-success-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const logPath = resolve(repoRoot, "workspace-log.json");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const exists = (relativePath) => fs.existsSync(path.join(cwd, relativePath));
fs.writeFileSync(process.env.LLM_WIKI_WORKSPACE_LOG, JSON.stringify({
  cwd,
  copied: {
    git: exists(".git/config"),
    nodeModules: exists("node_modules/heavy/index.js"),
    quartzCache: exists("quartz/.quartz-cache/cache.bin"),
    quartzPublic: exists("quartz/public/index.html")
  }
}), "utf8");
fs.mkdirSync(path.join(cwd, "curated/sources"), { recursive: true });
fs.writeFileSync(path.join(cwd, "curated/sources/source.md"), "# Source\\n\\nsource_ids: [raw/source.md]\\n", "utf8");
fs.writeFileSync(path.join(cwd, "curated/index.md"), "# Index\\n\\n- [[sources/source]]\\n", "utf8");
`,
      });

      try {
        // Act
        const result = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            LLM_WIKI_WORKSPACE_LOG: logPath,
          },
        });
        const log = await readWorkspaceLog(logPath);

        // Assert
        expect(result.proposals.files).toEqual([
          { path: "curated/index.md", content: "# Index\n\n- [[sources/source]]\n" },
          { path: "curated/sources/source.md", content: "# Source\n\nsource_ids: [raw/source.md]\n" },
        ]);
        expect(result.execution).toMatchObject({
          agentName: "codex",
          executablePath,
          exitCode: 0,
        });
        expectInsideSystemTemp(log.cwd);
        expectOutsideRepo(repoRoot, log.cwd);
        await expect(pathExists(log.cwd)).resolves.toBe(false);
        expect(log.copied).toEqual({
          git: false,
          nodeModules: false,
          quartzCache: false,
          quartzPublic: false,
        });
        await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("resets inherited PWD so agents that trust it still write inside the temp workspace", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-pwd-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const logPath = resolve(repoRoot, "workspace-log.json");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const pwd = process.env.PWD;
fs.writeFileSync(process.env.LLM_WIKI_WORKSPACE_LOG, JSON.stringify({ cwd, pwd }), "utf8");
fs.mkdirSync(path.join(pwd, "curated/sources"), { recursive: true });
fs.writeFileSync(path.join(pwd, "curated/sources/pwd.md"), "# PWD\\n\\nsource_ids: [raw/source.md]\\n", "utf8");
`,
      });

      try {
        // Act
        const result = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            PWD: repoRoot,
            LLM_WIKI_WORKSPACE_LOG: logPath,
          },
        });
        const log = await readWorkspaceLog(logPath);

        // Assert
        if (log.pwd === undefined) {
          throw new Error("Expected spawned agent to receive PWD.");
        }
        expect(log.pwd).toBe(log.cwd);
        expectInsideSystemTemp(log.pwd);
        expectOutsideRepo(repoRoot, log.pwd);
        expect(result.proposals.files).toEqual([
          { path: "curated/sources/pwd.md", content: "# PWD\n\nsource_ids: [raw/source.md]\n" },
        ]);
        await expect(pathExists(log.cwd)).resolves.toBe(false);
        await expect(pathExists(resolve(repoRoot, "curated/sources/pwd.md"))).resolves.toBe(false);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("rejects source repo symlinks before launching the agent", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-source-symlink-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      await mkdir(resolve(repoRoot, "curated/sources"), { recursive: true });
      await symlink(resolve(repoRoot, "raw/source.md"), resolve(repoRoot, "curated/sources/escape.md"), "file");
      const launchPath = resolve(repoRoot, "agent-launched.txt");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
fs.writeFileSync(process.env.LLM_WIKI_AGENT_LAUNCHED, "launched\\n", "utf8");
fs.writeFileSync(path.join(cwd, "curated/sources/escape.md"), "# Mutated raw\\n", "utf8");
`,
      });

      try {
        // Act
        const failure = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            LLM_WIKI_AGENT_LAUNCHED: launchPath,
          },
        }).catch((error: unknown) => error);

        // Assert
        expect(failure).toBeInstanceOf(RuntimeCommandError);
        expect(failure).toMatchObject({
          code: "PROPOSAL_REJECTED",
          path: "curated/sources/escape.md",
        });
        expect(String((failure as Error).message)).toContain("source path must not be a symlink");
        await expect(pathExists(launchPath)).resolves.toBe(false);
        await expect(readFile(resolve(repoRoot, "raw/source.md"), "utf8")).resolves.toBe("# Raw source\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("allows a symlinked repository root while still copying the real repo tree", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-root-symlink-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const repoLink = resolve(workspaceDir, "wiki-link");
      await mkdir(repoRoot, { recursive: true });
      await seedRepo(repoRoot);
      await symlink(repoRoot, repoLink, "dir");
      const logPath = resolve(repoRoot, "workspace-log.json");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
fs.writeFileSync(process.env.LLM_WIKI_WORKSPACE_LOG, JSON.stringify({ cwd }), "utf8");
fs.mkdirSync(path.join(cwd, "curated/sources"), { recursive: true });
fs.writeFileSync(path.join(cwd, "curated/sources/source.md"), "# Source\\n\\nsource_ids: [raw/source.md]\\n", "utf8");
`,
      });

      try {
        // Act
        const result = await runLocalAgentInTemporaryWorkspace({
          repoRoot: repoLink,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            LLM_WIKI_WORKSPACE_LOG: logPath,
          },
        });
        const log = await readWorkspaceLog(logPath);

        // Assert
        expect(result.proposals.files).toEqual([
          { path: "curated/sources/source.md", content: "# Source\n\nsource_ids: [raw/source.md]\n" },
        ]);
        expectInsideSystemTemp(log.cwd);
        expectOutsideRepo(repoRoot, log.cwd);
        await expect(pathExists(log.cwd)).resolves.toBe(false);
        await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it.each([
    {
      name: "deletes an existing file",
      path: "curated/index.md",
      script: "fs.unlinkSync(path.join(cwd, 'curated/index.md'));",
    },
    {
      name: "edits raw inputs",
      path: "raw/source.md",
      script: "fs.writeFileSync(path.join(cwd, 'raw/source.md'), '# Mutated raw\\n', 'utf8');",
    },
    {
      name: "edits wiki config",
      path: ".llm-wiki/config.yml",
      script: "fs.writeFileSync(path.join(cwd, '.llm-wiki/config.yml'), 'mutated: true\\n', 'utf8');",
    },
    {
      name: "edits Quartz output",
      path: "quartz/public/agent.html",
      script: "fs.mkdirSync(path.join(cwd, 'quartz/public'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'quartz/public/agent.html'), '<p>agent</p>\\n', 'utf8');",
    },
    {
      name: "creates a non-Markdown file",
      path: "curated/sources/source.txt",
      script: "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'curated/sources/source.txt'), 'not markdown\\n', 'utf8');",
    },
    {
      name: "creates binary Markdown",
      path: "curated/sources/binary.md",
      script: "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'curated/sources/binary.md'), Buffer.from([0xff, 0x00, 0x01]));",
    },
    {
      name: "creates a symlink",
      path: "curated/sources/link.md",
      script: "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true }); fs.symlinkSync('../index.md', path.join(cwd, 'curated/sources/link.md'));",
    },
    {
      name: "creates git metadata",
      path: ".git/hooks/post-commit",
      script: "fs.mkdirSync(path.join(cwd, '.git/hooks'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.git/hooks/post-commit'), '#!/bin/sh\\n', 'utf8');",
    },
    {
      name: "creates a backslash path",
      path: "curated/sources/back\\slash.md",
      script: "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'curated/sources/back\\\\slash.md'), '# Backslash\\n', 'utf8');",
    },
  ])("rejects unsafe agent workspace diffs when the agent $name", async ({ path: rejectedPath, script }) => {
    await withTempWorkspace("llm-wiki-agent-workspace-reject-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
${script}
`,
      });

      try {
        // Act
        const failure = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: process.env,
        }).catch((error: unknown) => error);

        // Assert
        expect(failure).toBeInstanceOf(RuntimeCommandError);
        expect(failure).toMatchObject({
          code: "PROPOSAL_REJECTED",
          path: rejectedPath,
        });
        await expect(readFile(resolve(repoRoot, "raw/source.md"), "utf8")).resolves.toBe("# Raw source\n");
        await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("reports observed temp workspace changes when the agent command exits non-zero", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-failure-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const logPath = resolve(repoRoot, "workspace-log.json");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
fs.writeFileSync(process.env.LLM_WIKI_WORKSPACE_LOG, JSON.stringify({ cwd }), "utf8");
fs.mkdirSync(path.join(cwd, "curated/sources"), { recursive: true });
fs.writeFileSync(path.join(cwd, "curated/sources/source.md"), "# Partial\\n", "utf8");
process.stderr.write("agent failed after editing\\n");
process.exit(17);
`,
      });

      try {
        // Act
        const failure = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            LLM_WIKI_WORKSPACE_LOG: logPath,
          },
        }).catch((error: unknown) => error);
        const log = await readWorkspaceLog(logPath);

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_FAILED",
          exitCode: 17,
          stderrTail: "agent failed after editing\n",
          changesObserved: true,
          changes_observed: true,
        });
        await expect(pathExists(log.cwd)).resolves.toBe(false);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("reports no observed temp workspace changes when the agent command exits non-zero without edits", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-no-change-failure-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const logPath = resolve(repoRoot, "workspace-log.json");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.LLM_WIKI_WORKSPACE_LOG, JSON.stringify({ cwd: process.cwd() }), "utf8");
process.stderr.write("agent failed before editing\\n");
process.exit(23);
`,
      });

      try {
        // Act
        const failure = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: {
            ...process.env,
            LLM_WIKI_WORKSPACE_LOG: logPath,
          },
        }).catch((error: unknown) => error);
        const log = await readWorkspaceLog(logPath);

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_FAILED",
          executablePath,
          exitCode: 23,
          stderrTail: "agent failed before editing\n",
          changesObserved: false,
          changes_observed: false,
        });
        await expect(pathExists(log.cwd)).resolves.toBe(false);
        await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("rejects file type changes from regular files to symlinks", async () => {
    await withTempWorkspace("llm-wiki-agent-workspace-type-change-", async (repoRoot) => {
      // Arrange
      await seedRepo(repoRoot);
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
fs.unlinkSync(path.join(cwd, "curated/index.md"));
fs.symlinkSync("log.md", path.join(cwd, "curated/index.md"));
`,
      });

      try {
        // Act
        const failure = await runLocalAgentInTemporaryWorkspace({
          repoRoot,
          agent: localAgent({ command: executablePath }),
          taskPrompt: "Create a source summary.",
          policy: createIngestProposalPolicy(),
          env: process.env,
        }).catch((error: unknown) => error);

        // Assert
        expect(failure).toBeInstanceOf(RuntimeCommandError);
        expect(failure).toMatchObject({
          code: "PROPOSAL_REJECTED",
          path: "curated/index.md",
        });
        await expect(readFile(resolve(repoRoot, "curated/index.md"), "utf8")).resolves.toBe("# Index\n\n- original\n");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });
});
