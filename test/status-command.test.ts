import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type RuntimeSuccessEnvelope<Command extends string, Data> = {
  ok: true;
  command: Command;
  repo: string;
  data: Data;
  warnings: string[];
};

type RuntimeFailureEnvelope<Command extends string> = {
  ok: false;
  command: Command;
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

type StatusData = {
  config: {
    path: ".llm-wiki/config.yml";
    valid: boolean;
    git_enabled: boolean | null;
    agent_default: string | null;
    local_agents: {
      count: number;
      names: string[];
    };
    providers: {
      count: number;
      names: string[];
    };
    errors: Array<{
      severity: "error";
      code: string;
      message: string;
      path: string;
      hint: string;
    }>;
  };
  agents: {
    default: string | null;
    local: {
      count: number;
      names: string[];
      items: Array<{
        name: string;
        type: "local-exec";
        command: string;
        available: boolean;
        availability_error: null | {
          code: string;
          message: string;
          hint: string;
          executable_path: string;
        };
        timeout_seconds: number | null;
      }>;
    };
  };
  providers: {
    count: number;
    names: string[];
  };
  auto: {
    can_run: boolean;
    agent: string | null;
    reason: string | null;
  };
  health: {
    state: "ok" | "warning" | "error";
    ok: boolean;
    errors: number;
    warnings: number;
  };
  queue: {
    counts: {
      total: number;
      queued: number;
      ingesting: number;
      ingested: number;
      blocked: number;
    };
  };
  lint: {
    ok: boolean;
    counts: {
      total: number;
      error: number;
      warning: number;
      fixed: number;
    };
    error_rule_ids: string[];
    warning_rule_ids: string[];
  };
  git: {
    enabled: boolean | null;
    repository: boolean;
    branch: string | null;
    head: string | null;
    dirty: boolean | null;
    errors: Array<{
      command: string;
      exit_code: number | null;
      stderr: string;
      manual_next_steps: string[];
    }>;
  };
  profiles: {
    total: number;
    valid: number;
    invalid: number;
    names: string[];
    invalid_paths: string[];
  };
  explorer: {
    ready: boolean;
    initialized: boolean;
    quartz_dir_exists: boolean;
    content_dir_exists: boolean;
    manifest_paths: string[];
  };
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
  };
};

type FakeGitCall = {
  args: string[];
  cwd: string;
};

type FakeAgent = {
  binDir: string;
  logPath: string;
  restore: () => void;
};

const supportsUnreadableFileTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

async function initializeWiki(targetDir: string, git = false): Promise<void> {
  const args = git ? ["init", targetDir, "--json"] : ["init", targetDir, "--no-git", "--json"];
  const result = await runCliBuffered(args);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseJsonSuccess<Command extends string, Data>(
  stdout: string[],
): RuntimeSuccessEnvelope<Command, Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeSuccessEnvelope<Command, Data>;
}

function parseJsonFailure<Command extends string>(stdout: string[]): RuntimeFailureEnvelope<Command> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeFailureEnvelope<Command>;
}

async function captureTextSource(wikiDir: string): Promise<string> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Queue Health Note",
    "--text",
    "queued source for status",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  return payload.data.source.source_id;
}

async function createFakeGit(
  behavior: "status-success" | "status-failure",
): Promise<{ binDir: string; logPath: string; restore: () => void }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-status-fake-git-bin-"));
  const gitPath = resolve(binDir, "git");
  const logPath = resolve(binDir, "git.log");
  const oldPath = process.env.PATH;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LLM_WIKI_FAKE_GIT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n", "utf8");
if (args[0] === "init") {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  process.exit(0);
}
if (${JSON.stringify(behavior)} === "status-failure" && args[0] === "status") {
  console.error("fatal: repository ownership check failed");
  process.exit(128);
}
if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
  process.stdout.write("true\\n");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
  process.stdout.write("main\\n");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--short") {
  process.stdout.write("abc1234\\n");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--porcelain") {
  process.stdout.write(" M curated/home.md\\n");
  process.exit(0);
}
process.exit(0);
`;

  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  process.env.LLM_WIKI_FAKE_GIT_LOG = logPath;

  return {
    binDir,
    logPath,
    restore: () => {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      delete process.env.LLM_WIKI_FAKE_GIT_LOG;
    },
  };
}

async function createFakeAgentCommand(commandName = "codex"): Promise<FakeAgent> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-status-fake-agent-bin-"));
  const executableName = process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const commandPath = resolve(binDir, executableName);
  const logPath = resolve(binDir, `${commandName}.log`);
  const oldPath = process.env.PATH;
  const oldLog = process.env.LLM_WIKI_FAKE_AGENT_LOG;
  const script = process.platform === "win32"
    ? "@echo off\r\necho executed>>\"%LLM_WIKI_FAKE_AGENT_LOG%\"\r\nexit /b 0\r\n"
    : "#!/usr/bin/env sh\nprintf executed >> \"$LLM_WIKI_FAKE_AGENT_LOG\"\n";

  await writeFile(commandPath, script, "utf8");
  await chmod(commandPath, 0o755);
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  process.env.LLM_WIKI_FAKE_AGENT_LOG = logPath;

  return {
    binDir,
    logPath,
    restore: () => {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }

      if (oldLog === undefined) {
        delete process.env.LLM_WIKI_FAKE_AGENT_LOG;
      } else {
        process.env.LLM_WIKI_FAKE_AGENT_LOG = oldLog;
      }
    },
  };
}

async function readFakeGitLog(logPath: string): Promise<FakeGitCall[]> {
  const log = await readFile(logPath, "utf8");

  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeGitCall);
}

describe("status command", () => {
  it("reports health, queue, lint, optional Git, profiles, and Explorer readiness in stable JSON", async () => {
    await withTempWorkspace("llm-wiki-status-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const sourceId = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toEqual({
        state: "warning",
        ok: true,
        errors: 0,
        warnings: 1,
      });
      expect(payload.data.queue.counts).toEqual({
        total: 1,
        queued: 1,
        ingesting: 0,
        ingested: 0,
        blocked: 0,
      });
      expect(payload.data.lint).toMatchObject({
        ok: true,
        counts: {
          total: 1,
          error: 0,
          warning: 1,
          fixed: 0,
        },
        error_rule_ids: [],
        warning_rule_ids: ["index_stale"],
      });
      expect(payload.data.git).toMatchObject({
        enabled: false,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
        errors: [],
      });
      expect(payload.data.profiles).toMatchObject({
        total: 3,
        valid: 3,
        invalid: 0,
        names: ["local", "public", "review"],
        invalid_paths: [],
      });
      expect(payload.data.explorer).toEqual({
        ready: false,
        initialized: false,
        quartz_dir_exists: false,
        content_dir_exists: false,
        manifest_paths: [],
      });
      expect(JSON.stringify(payload.data)).toContain(sourceId);
    });
  });

  it("reports configured provider and local agent names without requiring provider secrets", async () => {
    await withTempWorkspace("llm-wiki-status-config-summary-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      delete process.env.LLM_WIKI_STATUS_PROVIDER_SECRET;
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.replace("default: generic", "default: codex").trimEnd(),
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: codex",
          "providers:",
          "  remote:",
          "    type: http",
          "    endpoint: https://provider.example.invalid/proposals",
          "    api_key_env: LLM_WIKI_STATUS_PROVIDER_SECRET",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.config).toMatchObject({
        valid: true,
        agent_default: "codex",
        local_agents: {
          count: 1,
          names: ["codex"],
        },
        providers: {
          count: 1,
          names: ["remote"],
        },
      });
    });
  });

  it("reports local agent readiness, provider summary, and auto readiness in JSON without executing agents", async () => {
    await withTempWorkspace("llm-wiki-status-agent-ready-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const fakeAgent = await createFakeAgentCommand("codex");
      try {
        delete process.env.LLM_WIKI_STATUS_PROVIDER_SECRET;
        const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
        const config = await readFile(configPath, "utf8");
        await writeFile(
          configPath,
          [
            config.replace("default: generic", "default: codex").trimEnd(),
            "agents:",
            "  codex:",
            "    type: local-exec",
            "    command: codex",
            "    args:",
            "      - exec",
            "    timeout_seconds: 900",
            "providers:",
            "  remote:",
            "    type: http",
            "    endpoint: https://provider.example.invalid/proposals",
            "    api_key_env: LLM_WIKI_STATUS_PROVIDER_SECRET",
            "",
          ].join("\n"),
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.agents).toEqual({
          default: "codex",
          local: {
            count: 1,
            names: ["codex"],
            items: [
              {
                name: "codex",
                type: "local-exec",
                command: "codex",
                available: true,
                availability_error: null,
                timeout_seconds: 900,
              },
            ],
          },
        });
        expect(payload.data.providers).toEqual({
          count: 1,
          names: ["remote"],
        });
        expect(payload.data.auto).toEqual({
          can_run: false,
          agent: "codex",
          reason: expect.stringContaining("Local agent execution is not implemented yet"),
        });
        await expect(readFile(fakeAgent.logPath, "utf8")).rejects.toThrow();
      } finally {
        fakeAgent.restore();
        await rm(fakeAgent.binDir, { force: true, recursive: true });
      }
    });
  });

  it("resolves relative PATH entries from the target repo root when status runs from another directory", async () => {
    await withTempWorkspace("llm-wiki-status-agent-relative-path-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const runDir = resolve(workspaceDir, "outside");
      await initializeWiki(wikiDir);
      await mkdir(runDir);

      const binDir = resolve(wikiDir, "bin");
      const executableName = process.platform === "win32" ? "codex.cmd" : "codex";
      const commandPath = resolve(binDir, executableName);
      await mkdir(binDir);
      await writeFile(
        commandPath,
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/usr/bin/env sh\nexit 0\n",
        "utf8",
      );
      await chmod(commandPath, 0o755);

      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.replace("default: generic", "default: codex").trimEnd(),
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: codex",
          "    timeout_seconds: 900",
          "",
        ].join("\n"),
        "utf8",
      );

      const oldCwd = process.cwd();
      const oldPath = process.env.PATH;
      try {
        process.chdir(runDir);
        process.env.PATH = "bin";

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.agents.local.items).toEqual([
          expect.objectContaining({
            name: "codex",
            command: "codex",
            available: true,
            availability_error: null,
            timeout_seconds: 900,
          }),
        ]);
        expect(payload.data.auto).toEqual({
          can_run: false,
          agent: "codex",
          reason: expect.stringContaining("Local agent execution is not implemented yet"),
        });
      } finally {
        process.chdir(oldCwd);
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    });
  });

  it("reports missing local agent commands and explains why --auto cannot run", async () => {
    await withTempWorkspace("llm-wiki-status-agent-missing-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const oldPath = process.env.PATH;
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.replace("default: generic", "default: codex").trimEnd(),
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: llm-wiki-status-missing-codex",
          "    timeout_seconds: 120",
          "",
        ].join("\n"),
        "utf8",
      );

      try {
        process.env.PATH = "";

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.agents.local.items).toEqual([
          expect.objectContaining({
            name: "codex",
            command: "llm-wiki-status-missing-codex",
            available: false,
            availability_error: expect.objectContaining({
              code: "AGENT_COMMAND_UNAVAILABLE",
              executable_path: "llm-wiki-status-missing-codex",
              message: expect.stringContaining("Agent command is not available"),
            }),
            timeout_seconds: 120,
          }),
        ]);
        expect(payload.data.auto).toEqual({
          can_run: false,
          agent: "codex",
          reason: expect.stringContaining("Agent command is not available"),
        });
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    });
  });

  it("reports a missing default agent target as an --auto readiness failure", async () => {
    await withTempWorkspace("llm-wiki-status-auto-missing-default-target-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.agents).toMatchObject({
        default: "generic",
        local: {
          count: 0,
          names: [],
          items: [],
        },
      });
      expect(payload.data.auto).toEqual({
        can_run: false,
        agent: "generic",
        reason: "Default agent generic is not configured as a local agent.",
      });
    });
  });

  it("keeps status JSON stable when the configured default agent has an unsupported type", async () => {
    await withTempWorkspace("llm-wiki-status-auto-unsupported-agent-type-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.replace("default: generic", "default: codex").trimEnd(),
          "agents:",
          "  codex:",
          "    type: http",
          "    command: codex",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
      });
      expect(payload.data.config.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("Agent type must be local-exec"),
          hint: expect.stringContaining("type: local-exec"),
        }),
      ]);
      expect(payload.data.agents).toMatchObject({
        default: "codex",
        local: {
          count: 0,
          names: [],
          items: [],
        },
      });
      expect(payload.data.auto).toEqual({
        can_run: false,
        agent: "codex",
        reason: "Default agent codex is not configured as a local agent.",
      });
    });
  });

  it("keeps status JSON stable when provider config is malformed", async () => {
    await withTempWorkspace("llm-wiki-status-provider-malformed-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.trimEnd(),
          "providers:",
          "  - remote",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
      });
      expect(payload.data.providers).toEqual({
        count: 0,
        names: [],
      });
      expect(payload.data.config.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("providers must be a mapping"),
        }),
      ]);
    });
  });

  it("reports agent, provider, and --auto readiness in human status output", async () => {
    await withTempWorkspace("llm-wiki-status-agent-ready-human-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const fakeAgent = await createFakeAgentCommand("codex");
      try {
        const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
        const config = await readFile(configPath, "utf8");
        await writeFile(
          configPath,
          [
            config.replace("default: generic", "default: codex").trimEnd(),
            "agents:",
            "  codex:",
            "    type: local-exec",
            "    command: codex",
            "    timeout_seconds: 900",
            "providers:",
            "  remote:",
            "    type: http",
            "    endpoint: https://provider.example.invalid/proposals",
            "    api_key_env: LLM_WIKI_STATUS_PROVIDER_SECRET",
            "",
          ].join("\n"),
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir]);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(result.stdout).toHaveLength(1);
        expect(result.stdout[0]).toContain("Default agent: codex");
        expect(result.stdout[0]).toContain("Codex executable: available");
        expect(result.stdout[0]).toContain("HTTP providers: 1 (remote)");
        expect(result.stdout[0]).toContain("--auto: blocked (Local agent execution is not implemented yet");
        await expect(readFile(fakeAgent.logPath, "utf8")).rejects.toThrow();
      } finally {
        fakeAgent.restore();
        await rm(fakeAgent.binDir, { force: true, recursive: true });
      }
    });
  });

  it("surfaces malformed wiki config as a health error instead of treating Git as disabled", async () => {
    await withTempWorkspace("llm-wiki-status-config-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), "features:\n  git: [\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("Could not parse .llm-wiki/config.yml"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it("surfaces non-boolean Git config as invalid instead of treating Git as disabled", async () => {
    await withTempWorkspace("llm-wiki-status-config-git-type-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), 'features:\n  git: "true"\n', "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("features.git must be a boolean"),
            hint: expect.stringContaining("features.git to true or false"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it.each([
    ["empty file", "", "config root must be a mapping"],
    ["array root", "[]\n", "config root must be a mapping"],
    ["array features", "features: []\n", "features must be a mapping"],
  ])("surfaces structurally malformed wiki config as invalid: %s", async (_label, configSource, expectedMessage) => {
    await withTempWorkspace("llm-wiki-status-config-shape-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), configSource, "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining(expectedMessage),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("surfaces unreadable wiki config as a health error instead of a scan failure", async () => {
    await withTempWorkspace("llm-wiki-status-config-unreadable-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      await chmod(configPath, 0o000);

      let result;
      try {
        try {
          await readFile(configPath);
          return;
        } catch {
          // Permission enforcement varies by runtime user; when enforced, assert the CLI contract below.
        }

        // Act
        result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      } finally {
        await chmod(configPath, 0o600).catch(() => undefined);
      }

      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_unreadable",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("Could not read .llm-wiki/config.yml"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it("reports Explorer as ready when Quartz content and a profile manifest are present", async () => {
    await withTempWorkspace("llm-wiki-status-explorer-ready-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content"), { recursive: true });
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/package.json"), "{\"name\":\"llm-wiki-quartz\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "{\"profile\":\"local\"}\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.explorer).toEqual({
        ready: true,
        initialized: true,
        quartz_dir_exists: true,
        content_dir_exists: true,
        manifest_paths: [".llm-wiki/cache/quartz-manifest.local.json"],
      });
    });
  });

  it("does not report Explorer as ready when Quartz paths have the wrong file type", async () => {
    await withTempWorkspace("llm-wiki-status-explorer-file-types-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/content"), "not a directory\n", "utf8");
      await writeFile(resolve(wikiDir, "quartz/package.json"), "{\"name\":\"llm-wiki-quartz\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "{\"profile\":\"local\"}\n", "utf8");
      await mkdir(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.review.json"));

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.explorer).toEqual({
        ready: false,
        initialized: true,
        quartz_dir_exists: true,
        content_dir_exists: false,
        manifest_paths: [".llm-wiki/cache/quartz-manifest.local.json"],
      });
    });
  });

  it("keeps status usable for malformed profiles and reports profile validity through lint health", async () => {
    await withTempWorkspace("llm-wiki-status-profile-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "name: public\ninclude: curated/**\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
      });
      expect(payload.data.profiles).toMatchObject({
        total: 3,
        valid: 2,
        invalid: 1,
        invalid_paths: [".llm-wiki/profiles/public.yml"],
      });
      expect(payload.data.lint.error_rule_ids).toContain("profile_malformed");
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("returns a JSON failure envelope when status scanning fails", async () => {
    await withTempWorkspace("llm-wiki-status-scan-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const unreadablePath = resolve(wikiDir, "curated/unreadable.md");
      await writeFile(
        unreadablePath,
        "---\ntype: page\ntitle: Unreadable\nvisibility: private\nsource_ids: []\n---\n\n# Unreadable\n",
        "utf8",
      );
      await chmod(unreadablePath, 0o000);

      let result;
      try {
        try {
          await readFile(unreadablePath);
          return;
        } catch {
          // Permission enforcement varies by runtime user; when enforced, assert the CLI contract below.
        }

        // Act
        result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      } finally {
        await chmod(unreadablePath, 0o600).catch(() => undefined);
      }

      const payload = parseJsonFailure<"status">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "status",
        repo: wikiDir,
        error: {
          code: "status_failed",
          message: "Status failed while scanning repository.",
          hint: expect.any(String),
        },
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "status_scan_failed",
          severity: "error",
          path: ".",
        }),
      ]);
    });
  });

  it("reports branch, head, dirty state, and command-level Git errors when Git is enabled", async () => {
    await withTempWorkspace("llm-wiki-status-git-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("status-success");
      try {
        await initializeWiki(wikiDir, true);

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.data.git).toMatchObject({
          enabled: true,
          repository: true,
          branch: "main",
          head: "abc1234",
          dirty: true,
          errors: [],
        });
        expect(gitCalls.map((call) => call.args)).toEqual(
          expect.arrayContaining([
            ["rev-parse", "--is-inside-work-tree"],
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ["rev-parse", "--short", "HEAD"],
            ["status", "--porcelain"],
          ]),
        );
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("keeps status usable when a Git command fails and includes manual next steps", async () => {
    await withTempWorkspace("llm-wiki-status-git-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("status-failure");
      try {
        await initializeWiki(wikiDir, true);

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.data.health).toMatchObject({
          state: "warning",
          ok: true,
        });
        expect(payload.data.git.errors).toEqual([
          expect.objectContaining({
            command: "git status --porcelain",
            exit_code: 128,
            stderr: "fatal: repository ownership check failed",
            manual_next_steps: expect.arrayContaining([expect.stringContaining("git status --porcelain")]),
          }),
        ]);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });
});
