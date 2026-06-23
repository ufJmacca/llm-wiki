import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(resolve(repoRoot, "README.md"), "utf8");
}

describe("README local agent documentation", () => {
  it("documents manual prompts, local Codex execution, auto mode, validation, and HTTP providers", async () => {
    // Arrange
    const requiredCommands = [
      "llm-wiki ingest <source_id>",
      "llm-wiki ingest <source_id> --agent codex",
      "llm-wiki ingest <source_id> --auto",
      "llm-wiki ingest <source_id> --validate",
      "llm-wiki ingest <source_id> --provider local",
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --agent codex',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --auto',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --validate',
      'llm-wiki query "What does this source prove?" --save curated/questions/source-proof.md --provider local',
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const command of requiredCommands) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain("`--agent <name>` runs a configured local CLI agent such as Codex.");
    expect(readme).toContain("`--auto` uses `agent.default` from `.llm-wiki/config.yml`");
    expect(readme).toContain("`--provider <name>` runs an explicit HTTP proposal service");
    expect(readme).toContain("`--provider codex` is not a shortcut for local Codex");
  });

  it("shows the Codex local-agent config needed by older Codex-initialized repositories", async () => {
    // Arrange
    const requiredConfigLines = [
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
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const line of requiredConfigLines) {
      expect(readme).toContain(line);
    }
  });

  it("documents prompt inspection, validation failure recovery, manual Codex execution, and module ownership", async () => {
    // Arrange
    const requiredDocumentation = [
      "llm-wiki ingest <source_id> --task-out tasks/ingest.md",
      'llm-wiki query "What changed in the PRD?" --save curated/questions/prd-changes.md > tasks/query.md',
      "codex exec \"$(cat tasks/ingest.md)\"",
      "If automated ingest or query validation fails, the real repository is left unchanged",
      "Run the matching `--validate` command after making manual fixes",
      "`src/agents/` owns local CLI agent execution",
      "`src/proposals/` owns shared proposal policies",
    ];

    // Act
    const readme = await readReadme();

    // Assert
    for (const expectedText of requiredDocumentation) {
      expect(readme).toContain(expectedText);
    }
  });
});
