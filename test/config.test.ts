import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadDefaultLocalAgentConfig,
  loadLocalAgentConfig,
  readWikiConfigSummary,
  readWikiGitConfig,
} from "../src/runtime/config.js";
import { withTempWorkspace } from "./helpers/init.js";

async function writeWikiConfig(repoRoot: string, source: string): Promise<void> {
  await mkdir(resolve(repoRoot, ".llm-wiki"), { recursive: true });
  await writeFile(resolve(repoRoot, ".llm-wiki/config.yml"), source, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("runtime config local agents", () => {
  it("parses a configured Codex local-exec agent with MVP execution fields", async () => {
    await withTempWorkspace("llm-wiki-config-agent-valid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "agent:",
          "  default: codex",
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: codex",
          "    args:",
          "      - exec",
          "    approval_policy: never",
          "    sandbox_mode: workspace-write",
          "    output_mode: git-diff",
          "    timeout_seconds: 900",
          "features:",
          "  git: false",
          "",
        ].join("\n"),
      );

      // Act
      const result = await loadDefaultLocalAgentConfig(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: true,
        value: {
          name: "codex",
          type: "local-exec",
          command: "codex",
          args: ["exec"],
          approvalPolicy: "never",
          sandboxMode: "workspace-write",
          outputMode: "git-diff",
          timeoutSeconds: 900,
        },
      });
    });
  });

  it("accepts absolute executable paths without running the agent command", async () => {
    await withTempWorkspace("llm-wiki-config-agent-absolute-command-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: /opt/codex/bin/codex",
          "features:",
          "  git: false",
          "",
        ].join("\n"),
      );

      // Act
      const result = await loadLocalAgentConfig(wikiDir, "codex");

      // Assert
      expect(result).toMatchObject({
        ok: true,
        value: {
          name: "codex",
          command: "/opt/codex/bin/codex",
          args: [],
        },
      });
    });
  });

  it("loads the requested local agent without validating unrelated malformed agents", async () => {
    await withTempWorkspace("llm-wiki-config-agent-explicit-valid-extra-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "agent:",
          "  default: codex",
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: codex",
          "  experimental:",
          "    type: local-exec",
          "    command: \"\"",
          "features:",
          "  git: false",
          "",
        ].join("\n"),
      );

      // Act
      const explicitResult = await loadLocalAgentConfig(wikiDir, "codex");
      const defaultResult = await loadDefaultLocalAgentConfig(wikiDir);
      const summaryResult = await readWikiConfigSummary(wikiDir);

      // Assert
      expect(explicitResult).toMatchObject({
        ok: true,
        value: {
          name: "codex",
          type: "local-exec",
          command: "codex",
        },
      });
      expect(defaultResult).toMatchObject({
        ok: true,
        value: {
          name: "codex",
          type: "local-exec",
          command: "codex",
        },
      });
      expect(summaryResult).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "wiki_config_invalid",
          message: expect.stringContaining("Agent command must not be empty."),
          hint: expect.any(String),
        }),
      });
    });
  });

  it.each([
    {
      name: "top-level api key",
      extraYaml: "    api_key: sk-test-secret-must-not-live-in-config",
      expectedPath: ".llm-wiki/config.yml:agents.codex.api_key",
    },
    {
      name: "provider-shaped api key env",
      extraYaml: "    api_key_env: sk-test-secret-must-not-live-in-config",
      expectedPath: ".llm-wiki/config.yml:agents.codex.api_key_env",
    },
    {
      name: "nested environment secret",
      extraYaml: ["    env:", "      OPENAI_API_KEY: sk-test-secret-must-not-live-in-config"].join("\n"),
      expectedPath: ".llm-wiki/config.yml:agents.codex.env.OPENAI_API_KEY",
    },
  ])("rejects local agent configs with secret-like fields: $name", async ({ extraYaml, expectedPath }) => {
    await withTempWorkspace("llm-wiki-config-agent-secret-field-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "agents:",
          "  codex:",
          "    type: local-exec",
          "    command: codex",
          extraYaml,
          "features:",
          "  git: false",
          "",
        ].join("\n"),
      );

      // Act
      const result = await loadLocalAgentConfig(wikiDir, "codex");

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_CONFIG_INVALID",
          path: expectedPath,
          message: "Agent config must not contain secret-like fields.",
          hint: expect.stringContaining("environment"),
        }),
      });
      expect(JSON.stringify(result)).not.toContain("sk-test-secret-must-not-live-in-config");
    });
  });

  it("rejects a default agent when the matching agents entry is missing", async () => {
    await withTempWorkspace("llm-wiki-config-agent-missing-default-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        ["version: 1", "agent:", "  default: codex", "features:", "  git: false", ""].join("\n"),
      );

      // Act
      const result = await loadDefaultLocalAgentConfig(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_CONFIG_MISSING",
          path: ".llm-wiki/config.yml:agents.codex",
          message: "Local agent is not configured: codex.",
          hint: expect.stringContaining("agents.codex"),
        }),
      });
    });
  });

  it.each([
    {
      name: "unsupported agent type",
      source: ["agents:", "  codex:", "    type: http", "    command: codex", ""].join("\n"),
      expectedMessage: "Agent type must be local-exec.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.type",
    },
    {
      name: "empty commands",
      source: ["agents:", "  codex:", "    type: local-exec", "    command: \"\"", ""].join("\n"),
      expectedMessage: "Agent command must not be empty.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.command",
    },
    {
      name: "relative executable paths",
      source: ["agents:", "  codex:", "    type: local-exec", "    command: bin/codex", ""].join("\n"),
      expectedMessage: "Agent command must be a PATH command name or an absolute executable path.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.command",
    },
    {
      name: "non-array args",
      source: ["agents:", "  codex:", "    type: local-exec", "    command: codex", "    args: exec", ""].join("\n"),
      expectedMessage: "Agent args must be an array of strings when present.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.args",
    },
    {
      name: "invalid timeouts",
      source: [
        "agents:",
        "  codex:",
        "    type: local-exec",
        "    command: codex",
        "    timeout_seconds: 0",
        "",
      ].join("\n"),
      expectedMessage: "Agent timeout_seconds must be a positive integer when present.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.timeout_seconds",
    },
    {
      name: "unsupported output modes",
      source: [
        "agents:",
        "  codex:",
        "    type: local-exec",
        "    command: codex",
        "    output_mode: json",
        "",
      ].join("\n"),
      expectedMessage: "Agent output_mode must be git-diff when present.",
      expectedPath: ".llm-wiki/config.yml:agents.codex.output_mode",
    },
  ])("rejects malformed local agent config: $name", async ({ source, expectedMessage, expectedPath }) => {
    await withTempWorkspace("llm-wiki-config-agent-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(wikiDir, source);

      // Act
      const result = await loadLocalAgentConfig(wikiDir, "codex");

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_CONFIG_INVALID",
          path: expectedPath,
          message: expectedMessage,
          hint: expect.any(String),
        }),
      });
    });
  });

  it("rejects empty local agent names when summarizing all configured agents", async () => {
    await withTempWorkspace("llm-wiki-config-summary-empty-agent-name-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        ["agents:", "  \"\":", "    type: local-exec", "    command: codex", ""].join("\n"),
      );

      // Act
      const result = await readWikiConfigSummary(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "wiki_config_invalid",
          message: expect.stringContaining("Agent name must not be empty."),
          hint: expect.stringContaining("non-empty"),
        }),
      });
    });
  });

  it("surfaces malformed YAML as an actionable agent config error", async () => {
    await withTempWorkspace("llm-wiki-config-agent-yaml-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(wikiDir, "agents:\n  codex: [\n");

      // Act
      const result = await loadLocalAgentConfig(wikiDir, "codex");

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_CONFIG_INVALID",
          path: ".llm-wiki/config.yml",
          message: "Wiki config YAML could not be parsed.",
          hint: expect.stringContaining("YAML"),
        }),
      });
    });
  });

  it("summarizes configured providers and local agents without requiring provider secrets or running agent commands", async () => {
    await withTempWorkspace("llm-wiki-config-summary-safe-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeAgentPath = resolve(workspaceDir, "fake-codex");
      const invocationPath = resolve(workspaceDir, "agent-invoked.log");
      delete process.env.LLM_WIKI_MISSING_PROVIDER_SECRET;
      await writeFile(
        fakeAgentPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n', 'utf8');`,
          "process.exit(42);",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeAgentPath, 0o755);
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "agent:",
          "  default: codex",
          "agents:",
          "  codex:",
          "    type: local-exec",
          `    command: ${fakeAgentPath}`,
          "providers:",
          "  remote:",
          "    type: http",
          "    endpoint: https://provider.example.invalid/proposals",
          "    api_key_env: LLM_WIKI_MISSING_PROVIDER_SECRET",
          "features:",
          "  git: true",
          "",
        ].join("\n"),
      );

      // Act
      const result = await readWikiConfigSummary(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: true,
        value: {
          gitEnabled: true,
          agentDefault: "codex",
          localAgents: {
            count: 1,
            names: ["codex"],
          },
          providers: {
            count: 1,
            names: ["remote"],
          },
        },
      });
      expect(await pathExists(invocationPath)).toBe(false);
    });
  });

  it.each([
    {
      name: "non-object provider entry",
      source: ["version: 1", "providers:", "  local: []", ""].join("\n"),
      expectedMessage: "Provider config must be a mapping.",
    },
    {
      name: "missing provider type",
      source: [
        "version: 1",
        "providers:",
        "  local:",
        "    endpoint: https://provider.example.invalid/proposals",
        "    api_key_env: LLM_WIKI_STATUS_PROVIDER_SECRET",
        "",
      ].join("\n"),
      expectedMessage: "Provider type must be http.",
    },
    {
      name: "missing provider api key env",
      source: [
        "version: 1",
        "providers:",
        "  local:",
        "    type: http",
        "    endpoint: https://provider.example.invalid/proposals",
        "",
      ].join("\n"),
      expectedMessage: "Provider api_key_env must be an environment variable name.",
    },
  ])("rejects malformed provider summaries before counting them: $name", async ({ source, expectedMessage }) => {
    await withTempWorkspace("llm-wiki-config-summary-invalid-provider-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(wikiDir, source);

      // Act
      const result = await readWikiConfigSummary(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "wiki_config_invalid",
          message: expect.stringContaining(expectedMessage),
          hint: expect.stringContaining("providers"),
        }),
      });
    });
  });

  it("reads git config without validating optional agent or provider sections", async () => {
    await withTempWorkspace("llm-wiki-config-git-only-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await writeWikiConfig(
        wikiDir,
        [
          "version: 1",
          "features:",
          "  git: true",
          "agents: []",
          "providers: []",
          "",
        ].join("\n"),
      );

      // Act
      const result = await readWikiGitConfig(wikiDir);

      // Assert
      expect(result).toEqual({
        ok: true,
        value: {
          gitEnabled: true,
        },
      });
    });
  });
});
