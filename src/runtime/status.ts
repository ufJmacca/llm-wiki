import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { lintWiki, type LintResult } from "../lint/index.js";
import { scanWikiRepository, type RepoScan } from "../scanner/repo.js";
import { readGitState, type GitState } from "../utils/git.js";
import { readWikiConfigSummary, type WikiConfigIssue } from "./config.js";
import { listQueue, type QueueListItem, type QueueListResult } from "./queue.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "./repo.js";

export type StatusData = {
  configPath: typeof WIKI_CONFIG_RELATIVE_PATH;
  config: {
    path: typeof WIKI_CONFIG_RELATIVE_PATH;
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
    errors: WikiConfigIssue[];
  };
  health: {
    state: "ok" | "warning" | "error";
    ok: boolean;
    errors: number;
    warnings: number;
  };
  queue: {
    counts: QueueListResult["counts"];
    items: Array<Pick<QueueListItem, "source_id" | "title" | "kind" | "status" | "visibility" | "queue_path" | "source_card_path">>;
    errors: Array<{
      code: string;
      message: string;
      path: string;
      hint: string;
    }>;
  };
  lint: {
    ok: boolean;
    counts: LintResult["counts"];
    error_rule_ids: string[];
    warning_rule_ids: string[];
  };
  git: GitState;
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

const EMPTY_QUEUE_COUNTS: QueueListResult["counts"] = {
  total: 0,
  queued: 0,
  ingesting: 0,
  ingested: 0,
  blocked: 0,
};

export async function getWikiStatus(repoRoot: string): Promise<StatusData> {
  const configSummary = await readWikiConfigSummary(repoRoot);
  const [scan, lint, queue, explorer] = await Promise.all([
    scanWikiRepository(repoRoot),
    lintWiki(repoRoot),
    readQueueStatus(repoRoot),
    readExplorerStatus(repoRoot),
  ]);
  const config = summarizeConfig(configSummary);
  const git = configSummary.ok ? await readGitState(repoRoot, configSummary.value.gitEnabled) : unknownGitState();
  const profiles = summarizeProfiles(scan);
  const warningCount = lint.counts.warning + git.errors.length + queue.errors.length;
  const errorCount = lint.counts.error + config.errors.length;

  return {
    configPath: WIKI_CONFIG_RELATIVE_PATH,
    config,
    health: {
      state: errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok",
      ok: errorCount === 0,
      errors: errorCount,
      warnings: warningCount,
    },
    queue,
    lint: {
      ok: lint.counts.error === 0,
      counts: lint.counts,
      error_rule_ids: uniqueSorted(lint.issues.filter((issue) => issue.severity === "error").map((issue) => issue.rule_id)),
      warning_rule_ids: uniqueSorted(lint.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.rule_id)),
    },
    git,
    profiles,
    explorer,
  };
}

type WikiConfigSummaryResult = Awaited<ReturnType<typeof readWikiConfigSummary>>;

function summarizeConfig(config: WikiConfigSummaryResult): StatusData["config"] {
  if (!config.ok) {
    return {
      path: WIKI_CONFIG_RELATIVE_PATH,
      valid: false,
      git_enabled: null,
      agent_default: null,
      local_agents: {
        count: 0,
        names: [],
      },
      providers: {
        count: 0,
        names: [],
      },
      errors: [config.error],
    };
  }

  return {
    path: WIKI_CONFIG_RELATIVE_PATH,
    valid: true,
    git_enabled: config.value.gitEnabled,
    agent_default: config.value.agentDefault,
    local_agents: config.value.localAgents,
    providers: config.value.providers,
    errors: [],
  };
}

function unknownGitState(): GitState {
  return {
    enabled: null,
    repository: false,
    branch: null,
    head: null,
    dirty: null,
    errors: [],
  };
}

function summarizeProfiles(scan: RepoScan): StatusData["profiles"] {
  const invalidProfiles = scan.profiles.filter((profile) => profile.scan.profile === undefined);

  return {
    total: scan.profiles.length,
    valid: scan.profiles.length - invalidProfiles.length,
    invalid: invalidProfiles.length,
    names: scan.profiles.map((profile) => profile.name).sort(),
    invalid_paths: invalidProfiles.map((profile) => profile.path).sort(),
  };
}

async function readQueueStatus(repoRoot: string): Promise<StatusData["queue"]> {
  const queue = await listQueue(repoRoot);
  if (!queue.ok) {
    return {
      counts: EMPTY_QUEUE_COUNTS,
      items: [],
      errors: [
        {
          code: queue.error.code,
          message: queue.error.message,
          path: queue.error.path,
          hint: queue.error.hint,
        },
      ],
    };
  }

  return {
    counts: queue.value.counts,
    items: queue.value.items.map((item) => ({
      source_id: item.source_id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      visibility: item.visibility,
      queue_path: item.queue_path,
      source_card_path: item.source_card_path,
    })),
    errors: [],
  };
}

async function readExplorerStatus(repoRoot: string): Promise<StatusData["explorer"]> {
  const quartzDirExists = await isDirectory(resolve(repoRoot, "quartz"));
  const contentDirExists = await isDirectory(resolve(repoRoot, "quartz/content"));
  const manifestPaths = await listQuartzManifestPaths(repoRoot);
  const initialized = quartzDirExists && (await isFile(resolve(repoRoot, "quartz/package.json")));

  return {
    ready: initialized && contentDirExists && manifestPaths.length > 0,
    initialized,
    quartz_dir_exists: quartzDirExists,
    content_dir_exists: contentDirExists,
    manifest_paths: manifestPaths,
  };
}

async function listQuartzManifestPaths(repoRoot: string): Promise<string[]> {
  const cacheDir = resolve(repoRoot, ".llm-wiki/cache");
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^quartz-manifest\.[^.]+\.json$/.test(entry.name))
      .map((entry) => `.llm-wiki/cache/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
