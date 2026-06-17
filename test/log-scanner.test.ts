import { describe, expect, it } from "vitest";

import { planWikiScaffold } from "../src/scaffold/files.js";
import { parseLogEntries } from "../src/scanner/index.js";

const defaultOptions = {
  agent: "generic",
  obsidian: false,
  dataview: false,
  git: true,
} as const;

describe("runtime log scanner", () => {
  it("ignores the seeded entry-format template and fenced examples", () => {
    // Arrange
    const plannedEntries = new Map(planWikiScaffold(defaultOptions).map((entry) => [entry.path, entry.content]));
    const seededLog = plannedEntries.get("curated/log.md") ?? "";
    const fencedRuntimeExample = `${seededLog}
\`\`\`markdown
## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_example_a1b2c3d4 | Fenced example
\`\`\`
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content: fencedRuntimeExample });

    // Assert
    expect(scan.entries).toEqual([]);
    expect(scan.issues).toEqual([]);
  });

  it("parses runtime headings with ISO UTC timestamps, supported operations, and line metadata", () => {
    // Arrange
    const content = `# Log

## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_research_note_a1b2c3d4 | Research note

- actor: cli
- created:
  - raw/inputs/2026/06/src_2026_06_17_research_note_a1b2c3d4/_source.md
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.entries).toEqual([
      expect.objectContaining({
        path: "curated/log.md",
        line: 3,
        timestamp: "2026-06-17T11:28:42.000Z",
        operation: "add",
        affectedId: "src_2026_06_17_research_note_a1b2c3d4",
        title: "Research note",
      }),
    ]);
    expect(scan.entries[0]?.body).toContain("- actor: cli");
  });

  it("parses runtime headings with explicit ISO timezone offsets", () => {
    // Arrange
    const content = `# Log

## [2026-06-15T10:42:00+10:00] add | src_2026_06_15_karpathy_llm_wiki_a1b2c3 | Karpathy LLM wiki
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.entries).toEqual([
      expect.objectContaining({
        path: "curated/log.md",
        line: 3,
        timestamp: "2026-06-15T10:42:00+10:00",
        operation: "add",
        affectedId: "src_2026_06_15_karpathy_llm_wiki_a1b2c3",
        title: "Karpathy LLM wiki",
      }),
    ]);
  });

  it("ignores runtime headings inside backtick fences that contain tilde examples", () => {
    // Arrange
    const content = `# Log

\`\`\`markdown
~~~markdown
## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_example_a1b2c3 | Fenced example
~~~
\`\`\`

## [2026-06-17T11:30:00.000Z] add | src_2026_06_17_research_note_a1b2c3 | Research note
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.entries).toEqual([
      expect.objectContaining({
        path: "curated/log.md",
        line: 9,
        timestamp: "2026-06-17T11:30:00.000Z",
        affectedId: "src_2026_06_17_research_note_a1b2c3",
        title: "Research note",
      }),
    ]);
  });

  it("ignores runtime headings inside longer backtick fences that contain nested triple fences", () => {
    // Arrange
    const content = `# Log

\`\`\`\`markdown
\`\`\`markdown
## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_example_a1b2c3 | Fenced example
\`\`\`
## [2026-06-17T11:29:00.000Z] add | src_2026_06_17_other_a1b2c3 | Still fenced
\`\`\`\`

## [2026-06-17T11:30:00.000Z] add | src_2026_06_17_research_note_a1b2c3 | Research note
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.entries).toEqual([
      expect.objectContaining({
        path: "curated/log.md",
        line: 10,
        timestamp: "2026-06-17T11:30:00.000Z",
        affectedId: "src_2026_06_17_research_note_a1b2c3",
        title: "Research note",
      }),
    ]);
  });

  it("ignores runtime headings until a matching Markdown closing fence", () => {
    // Arrange
    const content = `# Log

\`\`\`markdown
\`\`\`ts
## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_example_a1b2c3 | Fenced example
    \`\`\`
## [2026-06-17T11:29:00.000Z] add | src_2026_06_17_other_a1b2c3 | Still fenced
\`\`\`

## [2026-06-17T11:30:00.000Z] add | src_2026_06_17_research_note_a1b2c3 | Research note
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.entries).toEqual([
      expect.objectContaining({
        path: "curated/log.md",
        line: 10,
        timestamp: "2026-06-17T11:30:00.000Z",
        affectedId: "src_2026_06_17_research_note_a1b2c3",
        title: "Research note",
      }),
    ]);
  });

  it("rejects impossible ISO calendar dates in runtime headings", () => {
    // Arrange
    const content = `# Log

## [2026-02-31T11:28:42.000Z] add | src_2026_06_17_research_note_a1b2c3d4 | Bad date
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.entries).toEqual([]);
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "LOG_TIMESTAMP_INVALID",
        path: "curated/log.md",
        line: 3,
        hint: expect.stringContaining("Use an ISO timestamp"),
      }),
    ]);
  });

  it("rejects runtime headings with whitespace-only affected IDs or titles", () => {
    // Arrange
    const content = [
      "# Log",
      "",
      "## [2026-06-17T11:28:42.000Z] add |    | Missing ID",
      "## [2026-06-17T11:28:42.000Z] add | src_2026_06_17_research_note_a1b2c3 |    ",
    ].join("\n");

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.entries).toEqual([]);
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "LOG_HEADING_MALFORMED",
        path: "curated/log.md",
        line: 3,
      }),
      expect.objectContaining({
        severity: "error",
        code: "LOG_HEADING_MALFORMED",
        path: "curated/log.md",
        line: 4,
      }),
    ]);
  });

  it("reports malformed runtime headings with structured scanner issues", () => {
    // Arrange
    const content = `# Log

## [2026-06-17 11:28:42] add | src_2026_06_17_research_note_a1b2c3d4 | Bad timestamp
## [2026-06-17T11:28:42.000Z] archive | src_2026_06_17_research_note_a1b2c3d4 | Unsupported operation
## [2026-06-17T11:28:42.000Z] add src_2026_06_17_research_note_a1b2c3d4 Missing separators
`;

    // Act
    const scan = parseLogEntries({ path: "curated/log.md", content });

    // Assert
    expect(scan.entries).toEqual([]);
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "LOG_TIMESTAMP_INVALID",
        path: "curated/log.md",
        line: 3,
        hint: expect.stringContaining("Use an ISO timestamp"),
      }),
      expect.objectContaining({
        severity: "error",
        code: "LOG_OPERATION_UNSUPPORTED",
        path: "curated/log.md",
        line: 4,
        hint: expect.stringContaining("Use a supported operation"),
      }),
      expect.objectContaining({
        severity: "error",
        code: "LOG_HEADING_MALFORMED",
        path: "curated/log.md",
        line: 5,
        hint: expect.stringContaining("Use `## [timestamp] operation | affected-id | title`"),
      }),
    ]);
  });
});
