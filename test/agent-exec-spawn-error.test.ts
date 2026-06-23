import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LocalAgentExecutionError,
  runLocalAgentCommand,
} from "../src/agents/index.js";
import type { LocalAgentConfig } from "../src/runtime/config.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

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

describe("local agent synchronous spawn failures", () => {
  it("wraps synchronous spawn exceptions in structured execution diagnostics", async () => {
    // Arrange
    const workspaceDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-agent-spawn-e2big-"));
    const binDir = resolve(workspaceDir, "bin");
    const agentCwd = resolve(workspaceDir, "repo-copy");
    const executablePath = resolve(binDir, "codex");
    const oversizedPrompt = `generated prompt\n${"x".repeat(1024 * 1024)}`;
    await mkdir(binDir, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executablePath, 0o755);
    spawnMock.mockImplementationOnce(() => {
      const error = new Error("spawn E2BIG: argument list too long") as NodeJS.ErrnoException;
      error.code = "E2BIG";
      throw error;
    });

    try {
      // Act
      const failure = await runLocalAgentCommand({
        agent: localAgent({ command: executablePath, args: ["exec", "--json"] }),
        cwd: agentCwd,
        taskPrompt: oversizedPrompt,
        changesObserved: true,
      }).catch((error: unknown) => error);

      // Assert
      expect(failure).toBeInstanceOf(LocalAgentExecutionError);
      if (!(failure instanceof LocalAgentExecutionError)) {
        throw new Error("Expected LocalAgentExecutionError.");
      }
      expect(failure).toMatchObject({
        code: "AGENT_COMMAND_SPAWN_FAILED",
        agentName: "codex",
        command: executablePath,
        executablePath,
        argsSummary: "exec --json <task-prompt>",
        exitCode: null,
        signal: null,
        timedOut: false,
        stderrTail: "",
        changesObserved: true,
        changes_observed: true,
      });
      expect(failure.message).toContain("E2BIG");
      expect(failure.hint).toContain("configured local agent executable");
      const [spawnedCommand, spawnedArgs, spawnedOptions] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { cwd: string; shell: boolean; stdio: [string, string, string] },
      ];
      expect(spawnedCommand).toBe(executablePath);
      expect(spawnedArgs).toEqual(["exec", "--json", "-"]);
      expect(spawnedArgs.join(" ")).not.toContain("generated prompt");
      expect(spawnedOptions).toMatchObject({
        cwd: agentCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } finally {
      spawnMock.mockReset();
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });
});
