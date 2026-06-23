import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { LocalAgentConfig } from "../src/runtime/config.js";
import {
  checkLocalAgentAvailability,
  LocalAgentExecutionError,
  runLocalAgentCommand,
} from "../src/agents/index.js";
import { withTempWorkspace } from "./helpers/init.js";

type FakeExecInput = {
  name?: string;
  source: string;
};

type LoggedInvocation = {
  args: string[];
  cwd: string;
  stdin?: string;
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

async function createFakeExecutable({ name = "codex", source }: FakeExecInput): Promise<{ binDir: string; executablePath: string }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-agent-exec-bin-"));
  const executablePath = resolve(binDir, name);
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return { binDir, executablePath };
}

async function withPath<T>(binDir: string, run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  try {
    return await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

async function readInvocationLog(path: string): Promise<LoggedInvocation[]> {
  const source = await readFile(path, "utf8");

  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedInvocation);
}

async function readTextEventually(path: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }

  throw lastError;
}

describe("local agent exec runtime", () => {
  it("reports absolute executable readiness without spawning the command", async () => {
    await withTempWorkspace("llm-wiki-agent-availability-absolute-", async (workspaceDir) => {
      // Arrange
      const markerPath = resolve(workspaceDir, "spawned.txt");
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned", "utf8");
`,
      });

      try {
        // Act
        const availability = await checkLocalAgentAvailability(localAgent({ command: executablePath }));

        // Assert
        expect(availability).toEqual({
          ok: true,
          value: {
            agentName: "codex",
            command: executablePath,
            executablePath,
            resolvedFrom: "absolute",
          },
        });
        await expect(readFile(markerPath, "utf8")).rejects.toThrow();
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("resolves executable names from PATH during readiness checks without spawning them", async () => {
    await withTempWorkspace("llm-wiki-agent-availability-path-", async (workspaceDir) => {
      // Arrange
      const markerPath = resolve(workspaceDir, "path-readiness-spawned.txt");
      const { executablePath, binDir } = await createFakeExecutable({
        name: "codex",
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned", "utf8");
process.stderr.write("readiness spawned PATH executable\\n");
process.exit(91);
`,
      });

      try {
        await withPath(binDir, async () => {
          // Act
          const availability = await checkLocalAgentAvailability(localAgent({ command: "codex" }));

          // Assert
          expect(availability).toEqual({
            ok: true,
            value: {
              agentName: "codex",
              command: "codex",
              executablePath,
              resolvedFrom: "path",
            },
          });
          await expect(readFile(markerPath, "utf8")).rejects.toThrow();
        });
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("resolves PATH and PATHEXT from caller env case-insensitively", async () => {
    // Arrange
    const { executablePath, binDir } = await createFakeExecutable({
      name: "codex.cmd",
      source: "@echo off\n",
    });

    try {
      // Act
      const availability = await checkLocalAgentAvailability(localAgent({ command: "codex" }), {
        env: {
          Path: binDir,
          pathext: ".cmd",
        },
        platform: "win32",
      });

      // Assert
      expect(availability).toEqual({
        ok: true,
        value: {
          agentName: "codex",
          command: "codex",
          executablePath,
          resolvedFrom: "path",
        },
      });
    } finally {
      await rm(binDir, { force: true, recursive: true });
    }
  });

  it("honors case-sensitive PATH keys on POSIX caller env", async () => {
    // Arrange
    const { binDir } = await createFakeExecutable({
      name: "codex",
      source: "#!/bin/sh\nexit 0\n",
    });

    try {
      // Act
      const availability = await checkLocalAgentAvailability(localAgent({ command: "codex" }), {
        env: {
          Path: binDir,
        },
        platform: "linux",
      });

      // Assert
      expect(availability).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_COMMAND_UNAVAILABLE",
          command: "codex",
          executablePath: "codex",
        }),
      });
    } finally {
      await rm(binDir, { force: true, recursive: true });
    }
  });

  it("rejects absolute Windows commands with non-launchable file extensions", async () => {
    // Arrange
    const { executablePath, binDir } = await createFakeExecutable({
      name: "codex.txt",
      source: "#!/bin/sh\nexit 0\n",
    });

    try {
      // Act
      const availability = await checkLocalAgentAvailability(localAgent({ command: executablePath }), {
        platform: "win32",
      });

      // Assert
      expect(availability).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "AGENT_COMMAND_UNAVAILABLE",
          command: executablePath,
          executablePath,
          hint: expect.stringContaining("absolute agent command exists and is executable"),
        }),
      });
    } finally {
      await rm(binDir, { force: true, recursive: true });
    }
  });

  it("does not fall back to the parent PATH when caller env intentionally omits PATH", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-empty-env-path-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      await mkdir(agentCwd, { recursive: true });
      const { binDir } = await createFakeExecutable({
        name: "codex",
        source: "#!/bin/sh\nexit 0\n",
      });

      try {
        await withPath(binDir, async () => {
          // Act
          const failure = await runLocalAgentCommand({
            agent: localAgent({ command: "codex" }),
            cwd: agentCwd,
            taskPrompt: "prompt",
            changesObserved: false,
            env: {
              LLM_WIKI_SANITIZED_ENV: "1",
            },
          }).catch((error: unknown) => error);

          // Assert
          expect(failure).toBeInstanceOf(LocalAgentExecutionError);
          if (!(failure instanceof LocalAgentExecutionError)) {
            throw new Error("Expected LocalAgentExecutionError.");
          }
          expect(failure).toMatchObject({
            code: "AGENT_COMMAND_UNAVAILABLE",
            command: "codex",
            executablePath: "codex",
            timedOut: false,
          });
        });
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("skips PATH candidates that are directories and continues to later executables", async () => {
    // Arrange
    const firstBinDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-agent-exec-dir-candidate-"));
    const directoryCandidatePath = resolve(firstBinDir, "codex");
    await mkdir(directoryCandidatePath);
    const { executablePath, binDir: secondBinDir } = await createFakeExecutable({
      name: "codex",
      source: "#!/bin/sh\nexit 0\n",
    });

    try {
      // Act
      const availability = await checkLocalAgentAvailability(localAgent({ command: "codex" }), {
        pathEnv: `${firstBinDir}${delimiter}${secondBinDir}`,
      });

      // Assert
      expect(availability).toEqual({
        ok: true,
        value: {
          agentName: "codex",
          command: "codex",
          executablePath,
          resolvedFrom: "path",
        },
      });
    } finally {
      await rm(firstBinDir, { force: true, recursive: true });
      await rm(secondBinDir, { force: true, recursive: true });
    }
  });

  it("returns a fast actionable availability error for missing commands", async () => {
    // Arrange
    const agent = localAgent({ command: "llm-wiki-definitely-missing-codex" });

    // Act
    const availability = await checkLocalAgentAvailability(agent, { pathEnv: "" });

    // Assert
    expect(availability).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "AGENT_COMMAND_UNAVAILABLE",
        agentName: "codex",
        command: "llm-wiki-definitely-missing-codex",
        executablePath: "llm-wiki-definitely-missing-codex",
        message: expect.stringContaining("Agent command is not available"),
        hint: expect.stringContaining("PATH"),
      }),
    });
  });

  it("spawns generic agents without a shell, appends the prompt as the final argument, and uses the caller cwd", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-success-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "argv.log");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd()
}) + "\\n", "utf8");
process.stdout.write("done\\n");
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ name: "generic-agent", command: executablePath, args: ["run", "--flag"] }),
          cwd: agentCwd,
          taskPrompt: "write curated output; touch /tmp/should-not-run",
          changesObserved: false,
          env: {
            ...process.env,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
          },
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "generic-agent",
          executablePath,
          args: ["run", "--flag", "write curated output; touch /tmp/should-not-run"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "done\n",
            truncated: false,
          },
          stderr: {
            text: "",
            truncated: false,
          },
        });
        await expect(readInvocationLog(logPath)).resolves.toEqual([
          {
            args: ["run", "--flag", "write curated output; touch /tmp/should-not-run"],
            cwd: agentCwd,
          },
        ]);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("executes configured command names through PATH and reports the resolved executable path", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-path-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "argv.log");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        name: "path-agent",
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd()
}) + "\\n", "utf8");
process.stdout.write("path done\\n");
`,
      });

      try {
        await withPath(binDir, async () => {
          // Act
          const result = await runLocalAgentCommand({
            agent: localAgent({ name: "path-agent", command: "path-agent", args: ["run", "--json"] }),
            cwd: agentCwd,
            taskPrompt: "prompt through PATH",
            changesObserved: false,
            env: {
              ...process.env,
              LLM_WIKI_FAKE_AGENT_LOG: logPath,
            },
          });

          // Assert
          expect(result).toMatchObject({
            agentName: "path-agent",
            executablePath,
            args: ["run", "--json", "prompt through PATH"],
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: {
              text: "path done\n",
              truncated: false,
            },
          });
          await expect(readInvocationLog(logPath)).resolves.toEqual([
            {
              args: ["run", "--json", "prompt through PATH"],
              cwd: agentCwd,
            },
          ]);
        });
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("streams large Codex exec prompts to stdin for non-batch executables", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-codex-large-stdin-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "codex-large-stdin.log");
      const largePrompt = [
        "large generated prompt sentinel",
        "x".repeat(1024 * 1024),
        "final generated prompt sentinel",
      ].join("\n");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("large codex stdin done\\n");
});
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, args: ["exec", "--json"] }),
          cwd: agentCwd,
          taskPrompt: largePrompt,
          changesObserved: false,
          env: {
            ...process.env,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
          },
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["exec", "--json", largePrompt],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "large codex stdin done\n",
            truncated: false,
          },
        });
        const [invocation] = await readInvocationLog(logPath);
        expect(invocation).toEqual({
          args: ["exec", "--json", "-"],
          cwd: agentCwd,
          stdin: largePrompt,
        });
        expect(invocation.args.join(" ")).not.toContain("large generated prompt sentinel");
        expect(invocation.args.join(" ")).not.toContain("final generated prompt sentinel");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("streams large Codex e alias prompts to stdin for non-batch executables", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-codex-e-large-stdin-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "codex-e-large-stdin.log");
      const largePrompt = [
        "large generated prompt sentinel",
        "x".repeat(1024 * 1024),
        "final generated prompt sentinel",
      ].join("\n");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("large codex e stdin done\\n");
});
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, args: ["e", "--json"] }),
          cwd: agentCwd,
          taskPrompt: largePrompt,
          changesObserved: false,
          env: {
            ...process.env,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
          },
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["e", "--json", largePrompt],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "large codex e stdin done\n",
            truncated: false,
          },
        });
        const [invocation] = await readInvocationLog(logPath);
        expect(invocation).toEqual({
          args: ["e", "--json", "-"],
          cwd: agentCwd,
          stdin: largePrompt,
        });
        expect(invocation.args.join(" ")).not.toContain("large generated prompt sentinel");
        expect(invocation.args.join(" ")).not.toContain("final generated prompt sentinel");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("streams large Codex exec prompts to stdin when global flags precede exec", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-codex-leading-flags-stdin-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "codex-leading-flags-stdin.log");
      const largePrompt = [
        "large generated prompt sentinel",
        "x".repeat(1024 * 1024),
        "final generated prompt sentinel",
      ].join("\n");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("leading flags codex stdin done\\n");
});
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, args: ["--sandbox", "workspace-write", "exec", "--json"] }),
          cwd: agentCwd,
          taskPrompt: largePrompt,
          changesObserved: false,
          env: {
            ...process.env,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
          },
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["--sandbox", "workspace-write", "exec", "--json", largePrompt],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "leading flags codex stdin done\n",
            truncated: false,
          },
        });
        const [invocation] = await readInvocationLog(logPath);
        expect(invocation).toEqual({
          args: ["--sandbox", "workspace-write", "exec", "--json", "-"],
          cwd: agentCwd,
          stdin: largePrompt,
        });
        expect(invocation.args.join(" ")).not.toContain("large generated prompt sentinel");
        expect(invocation.args.join(" ")).not.toContain("final generated prompt sentinel");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("streams large Codex exec prompts to stdin when -C precedes exec", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-codex-short-cd-stdin-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const codexCwd = resolve(workspaceDir, "configured-cwd");
      const logPath = resolve(workspaceDir, "codex-short-cd-stdin.log");
      const largePrompt = [
        "large generated prompt sentinel",
        "x".repeat(1024 * 1024),
        "final generated prompt sentinel",
      ].join("\n");
      await mkdir(agentCwd, { recursive: true });
      await mkdir(codexCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("short cd codex stdin done\\n");
});
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, args: ["-C", codexCwd, "exec", "--json"] }),
          cwd: agentCwd,
          taskPrompt: largePrompt,
          changesObserved: false,
          env: {
            ...process.env,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
          },
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["-C", codexCwd, "exec", "--json", largePrompt],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "short cd codex stdin done\n",
            truncated: false,
          },
        });
        const [invocation] = await readInvocationLog(logPath);
        expect(invocation).toEqual({
          args: ["-C", codexCwd, "exec", "--json", "-"],
          cwd: agentCwd,
          stdin: largePrompt,
        });
        expect(invocation.args.join(" ")).not.toContain("large generated prompt sentinel");
        expect(invocation.args.join(" ")).not.toContain("final generated prompt sentinel");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("resolves relative PATH entries from the caller cwd when spawning command names", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-relative-path-cwd-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const relativeBinEntry = `./agent-bin-${process.pid}-${Date.now()}`;
      const agentBinDir = resolve(agentCwd, relativeBinEntry);
      const executablePath = resolve(agentBinDir, "path-agent");
      const logPath = resolve(workspaceDir, "relative-path.log");
      await mkdir(agentBinDir, { recursive: true });
      await writeFile(executablePath, `#!/bin/sh
printf '%s\\n' "$(pwd)" > "$LLM_WIKI_FAKE_AGENT_LOG"
printf '%s\\n' "$1" >> "$LLM_WIKI_FAKE_AGENT_LOG"
printf '%s\\n' "$2" >> "$LLM_WIKI_FAKE_AGENT_LOG"
printf 'relative path cwd\\n'
`, "utf8");
      await chmod(executablePath, 0o755);

      // Act
      const result = await runLocalAgentCommand({
        agent: localAgent({ name: "path-agent", command: "path-agent", args: ["run"] }),
        cwd: agentCwd,
        taskPrompt: "prompt through cwd-relative PATH",
        changesObserved: false,
        env: {
          LLM_WIKI_FAKE_AGENT_LOG: logPath,
          PATH: relativeBinEntry,
        },
      });

      // Assert
      expect(result).toMatchObject({
        agentName: "path-agent",
        executablePath,
        args: ["run", "prompt through cwd-relative PATH"],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: {
          text: "relative path cwd\n",
          truncated: false,
        },
      });
      await expect(readFile(logPath, "utf8")).resolves.toBe([
        agentCwd,
        "run",
        "prompt through cwd-relative PATH",
        "",
      ].join("\n"));
    });
  });

  it("launches Windows batch shims through ComSpec when PATH resolves a .cmd executable", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-windows-shim-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "cmd.log");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        name: "codex.cmd",
        source: "@echo off\n",
      });
      const fakeCmdPath = resolve(workspaceDir, "fake-cmd");
      await writeFile(fakeCmdPath, `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("batch shim done\\n");
});
`, "utf8");
      await chmod(fakeCmdPath, 0o755);

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: "codex", args: ["exec", "--flag"] }),
          cwd: agentCwd,
          taskPrompt: "prompt & %VALUE%",
          changesObserved: false,
          env: {
            ...process.env,
            ComSpec: fakeCmdPath,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            PATHEXT: ".cmd",
          },
          platform: "win32",
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["exec", "--flag", "prompt & %VALUE%"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "batch shim done\n",
            truncated: false,
          },
        });
        await expect(readInvocationLog(logPath)).resolves.toEqual([
          {
            args: [
              "/d",
              "/s",
              "/c",
              `""${executablePath}" "exec" "--flag" "-""`,
            ],
            cwd: agentCwd,
            stdin: "prompt & %VALUE%",
          },
        ]);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("preserves the prompt as the final argv value for non-Codex Windows batch shims", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-windows-shim-argv-prompt-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "cmd-argv-prompt.log");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        name: "batch-agent.cmd",
        source: "@echo off\n",
      });
      const fakeCmdPath = resolve(workspaceDir, "fake-cmd");
      await writeFile(fakeCmdPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd()
}) + "\\n", "utf8");
process.stdout.write("generic batch shim done\\n");
`, "utf8");
      await chmod(fakeCmdPath, 0o755);

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ name: "batch-agent", command: "batch-agent", args: ["run"] }),
          cwd: agentCwd,
          taskPrompt: "prompt final arg",
          changesObserved: false,
          env: {
            ...process.env,
            ComSpec: fakeCmdPath,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            PATHEXT: ".cmd",
          },
          platform: "win32",
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "batch-agent",
          executablePath,
          args: ["run", "prompt final arg"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "generic batch shim done\n",
            truncated: false,
          },
        });
        await expect(readInvocationLog(logPath)).resolves.toEqual([
          {
            args: [
              "/d",
              "/s",
              "/c",
              `""${executablePath}" "run" "prompt final arg""`,
            ],
            cwd: agentCwd,
          },
        ]);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("keeps large Windows batch shim prompts out of the cmd.exe command line", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-windows-shim-large-prompt-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const logPath = resolve(workspaceDir, "cmd-large-prompt.log");
      const largePrompt = [
        "large generated prompt sentinel",
        "x".repeat(9_000),
        "final generated prompt sentinel",
      ].join("\n");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        name: "codex.cmd",
        source: "@echo off\n",
      });
      const fakeCmdPath = resolve(workspaceDir, "fake-cmd");
      await writeFile(fakeCmdPath, `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.LLM_WIKI_FAKE_AGENT_LOG, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin
  }) + "\\n", "utf8");
  process.stdout.write("large batch shim done\\n");
});
`, "utf8");
      await chmod(fakeCmdPath, 0o755);

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: "codex", args: ["exec", "--json"] }),
          cwd: agentCwd,
          taskPrompt: largePrompt,
          changesObserved: false,
          env: {
            ...process.env,
            ComSpec: fakeCmdPath,
            LLM_WIKI_FAKE_AGENT_LOG: logPath,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            PATHEXT: ".cmd",
          },
          platform: "win32",
        });

        // Assert
        expect(result).toMatchObject({
          agentName: "codex",
          executablePath,
          args: ["exec", "--json", largePrompt],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: {
            text: "large batch shim done\n",
            truncated: false,
          },
        });
        const [invocation] = await readInvocationLog(logPath);
        expect(invocation).toEqual({
          args: [
            "/d",
            "/s",
            "/c",
            `""${executablePath}" "exec" "--json" "-""`,
          ],
          cwd: agentCwd,
          stdin: largePrompt,
        });
        expect(invocation.args.join(" ")).not.toContain("large generated prompt sentinel");
        expect(invocation.args.join(" ")).not.toContain("final generated prompt sentinel");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("uses process-tree termination when timed-out Windows batch shims are launched through cmd", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-windows-shim-timeout-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const taskkillLogPath = resolve(workspaceDir, "taskkill.log");
      await mkdir(agentCwd, { recursive: true });
      const { binDir: agentBinDir } = await createFakeExecutable({
        name: "codex.cmd",
        source: "@echo off\n",
      });
      const fakeCmdPath = resolve(workspaceDir, "fake-cmd");
      await writeFile(fakeCmdPath, `#!/usr/bin/env node
process.stderr.write("shim wrapper running\\n");
process.on("SIGTERM", () => {
  process.stderr.write("wrapper ignored SIGTERM\\n");
});
setInterval(() => {}, 1000);
`, "utf8");
      await chmod(fakeCmdPath, 0o755);
      const { binDir: taskkillBinDir } = await createFakeExecutable({
        name: "taskkill",
        source: `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LLM_WIKI_TASKKILL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
`,
      });

      try {
        await withPath(taskkillBinDir, async () => {
          // Act
          const failure = await runLocalAgentCommand({
            agent: localAgent({ command: "codex", timeoutSeconds: 1 }),
            cwd: agentCwd,
            taskPrompt: "prompt",
            changesObserved: true,
            env: {
              ...process.env,
              ComSpec: fakeCmdPath,
              LLM_WIKI_TASKKILL_LOG: taskkillLogPath,
              PATH: `${agentBinDir}${delimiter}${process.env.PATH ?? ""}`,
              PATHEXT: ".cmd",
            },
            platform: "win32",
            timeoutKillGraceMs: 50,
          }).catch((error: unknown) => error);

          // Assert
          expect(failure).toBeInstanceOf(LocalAgentExecutionError);
          if (!(failure instanceof LocalAgentExecutionError)) {
            throw new Error("Expected LocalAgentExecutionError.");
          }
          expect(failure).toMatchObject({
            code: "AGENT_COMMAND_TIMEOUT",
            signal: "SIGKILL",
            timedOut: true,
            changesObserved: true,
            changes_observed: true,
          });
          const taskkillInvocations = (await readTextEventually(taskkillLogPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]);
          expect(taskkillInvocations).toContainEqual([
            "/pid",
            expect.stringMatching(/^\d+$/u),
            "/t",
            "/f",
          ]);
        });
      } finally {
        await rm(agentBinDir, { force: true, recursive: true });
        await rm(taskkillBinDir, { force: true, recursive: true });
      }
    });
  });

  it("throws diagnostics for non-zero exits including stderr tail and caller-supplied change state", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-nonzero-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
for (let i = 0; i < 40; i += 1) {
  process.stderr.write("noise-" + i + "\\n");
}
process.stderr.write("diagnostic-tail\\n");
process.exit(23);
`,
      });

      try {
        // Act
        const failure = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, args: ["exec"] }),
          cwd: agentCwd,
          taskPrompt: "prompt",
          changesObserved: true,
          outputLimitBytes: 96,
        }).catch((error: unknown) => error);

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        if (!(failure instanceof LocalAgentExecutionError)) {
          throw new Error("Expected LocalAgentExecutionError.");
        }
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_FAILED",
          agentName: "codex",
          executablePath,
          argsSummary: "exec <task-prompt>",
          exitCode: 23,
          signal: null,
          timedOut: false,
          changesObserved: true,
          changes_observed: true,
        });
        expect(failure.stderrTail).toContain("diagnostic-tail");
        expect(failure.stderrTail).not.toContain("noise-0");
        expect(Buffer.byteLength(failure.stderrTail, "utf8")).toBeLessThanOrEqual(96);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("enforces timeout_seconds and reports timeout diagnostics", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-timeout-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
process.stderr.write("still running\\n");
setTimeout(() => process.exit(0), 5000);
`,
      });

      try {
        // Act
        const failure = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, timeoutSeconds: 1 }),
          cwd: agentCwd,
          taskPrompt: "prompt",
          changesObserved: false,
        }).catch((error: unknown) => error);

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        if (!(failure instanceof LocalAgentExecutionError)) {
          throw new Error("Expected LocalAgentExecutionError.");
        }
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_TIMEOUT",
          executablePath,
          argsSummary: "exec <task-prompt>",
          exitCode: null,
          timedOut: true,
          changesObserved: false,
          changes_observed: false,
        });
        expect(failure.signal).toMatch(/^SIG/);
        expect(failure.stderrTail).toContain("still running");
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("hard-kills SIGTERM-resistant agents after the timeout grace period", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-timeout-hard-kill-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
process.stderr.write("ignoring SIGTERM\\n");
process.on("SIGTERM", () => {
  process.stderr.write("ignored SIGTERM\\n");
});
setInterval(() => {}, 1000);
`,
      });

      try {
        // Act
        const startedAt = Date.now();
        const failure = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, timeoutSeconds: 1 }),
          cwd: agentCwd,
          taskPrompt: "prompt",
          changesObserved: true,
          timeoutKillGraceMs: 50,
        }).catch((error: unknown) => error);
        const elapsedMs = Date.now() - startedAt;

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        if (!(failure instanceof LocalAgentExecutionError)) {
          throw new Error("Expected LocalAgentExecutionError.");
        }
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_TIMEOUT",
          executablePath,
          argsSummary: "exec <task-prompt>",
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
          changesObserved: true,
          changes_observed: true,
        });
        expect(failure.stderrTail).toContain("ignoring SIGTERM");
        expect(elapsedMs).toBeLessThan(2_500);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("terminates child processes before returning timeout diagnostics", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-timeout-child-process-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      const childMarkerPath = resolve(workspaceDir, "child-survived.txt");
      await mkdir(agentCwd, { recursive: true });
      const childScript = `
const fs = require("node:fs");
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(childMarkerPath)}, "child survived", "utf8");
}, 1500);
`;
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
const { spawn } = require("node:child_process");
process.stderr.write("spawned child\\n");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
  stdio: "ignore"
});
child.unref();
process.on("SIGTERM", () => {
  process.stderr.write("parent ignored SIGTERM\\n");
});
setInterval(() => {}, 1000);
`,
      });

      try {
        // Act
        const failure = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath, timeoutSeconds: 1 }),
          cwd: agentCwd,
          taskPrompt: "prompt",
          changesObserved: true,
          timeoutKillGraceMs: 50,
        }).catch((error: unknown) => error);
        await delay(800);

        // Assert
        expect(failure).toBeInstanceOf(LocalAgentExecutionError);
        if (!(failure instanceof LocalAgentExecutionError)) {
          throw new Error("Expected LocalAgentExecutionError.");
        }
        expect(failure).toMatchObject({
          code: "AGENT_COMMAND_TIMEOUT",
          executablePath,
          argsSummary: "exec <task-prompt>",
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
          changesObserved: true,
          changes_observed: true,
        });
        expect(failure.stderrTail).toContain("spawned child");
        await expect(readFile(childMarkerPath, "utf8")).rejects.toThrow();
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });

  it("bounds captured stdout and stderr so large agent output is truncated", async () => {
    await withTempWorkspace("llm-wiki-agent-exec-bounded-output-", async (workspaceDir) => {
      // Arrange
      const agentCwd = resolve(workspaceDir, "repo-copy");
      await mkdir(agentCwd, { recursive: true });
      const { executablePath, binDir } = await createFakeExecutable({
        source: `#!/usr/bin/env node
process.stdout.write("stdout-start-" + "x".repeat(5000) + "-stdout-end");
process.stderr.write("stderr-start-" + "y".repeat(5000) + "-stderr-end");
`,
      });

      try {
        // Act
        const result = await runLocalAgentCommand({
          agent: localAgent({ command: executablePath }),
          cwd: agentCwd,
          taskPrompt: "prompt",
          changesObserved: false,
          outputLimitBytes: 128,
        });

        // Assert
        expect(result.stdout).toEqual({
          text: expect.stringContaining("-stdout-end"),
          truncated: true,
          maxBytes: 128,
        });
        expect(result.stdout.text).not.toContain("stdout-start");
        expect(Buffer.byteLength(result.stdout.text, "utf8")).toBeLessThanOrEqual(128);
        expect(result.stderr).toEqual({
          text: expect.stringContaining("-stderr-end"),
          truncated: true,
          maxBytes: 128,
        });
        expect(result.stderr.text).not.toContain("stderr-start");
        expect(Buffer.byteLength(result.stderr.text, "utf8")).toBeLessThanOrEqual(128);
      } finally {
        await rm(binDir, { force: true, recursive: true });
      }
    });
  });
});
