import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { checkLocalAgentAvailability, type LocalAgentAvailabilityError } from "../agents/index.js";
import { lintWiki, type LintResult } from "../lint/index.js";
import { getPdfReadinessStatus, type PdfReadinessStatus } from "../pdf/readiness.js";
import { scanWikiRepository, type RepoScan } from "../scanner/repo.js";
import { readGitState, type GitState } from "../utils/git.js";
import {
  readWikiConfigSummary,
  readWikiStatusConfigReadiness,
  type LocalAgentConfig,
  type WikiConfigIssue,
  type WikiStatusConfigReadiness,
} from "./config.js";
import { listQueue, type QueueListItem, type QueueListResult } from "./queue.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "./repo.js";

export type StatusLocalAgentItem = {
  name: string;
  type: "local-exec";
  command: string;
  available: boolean;
  availability_error: {
    code: LocalAgentAvailabilityError["code"];
    message: string;
    hint: string;
    executable_path: string;
  } | null;
  timeout_seconds: number | null;
};

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
  agents: {
    default: string | null;
    local: {
      count: number;
      names: string[];
      items: StatusLocalAgentItem[];
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
  pdf_ingestion: PdfReadinessStatus;
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
  const [configSummary, configReadiness, scan, lint, queue, explorer, pdfReadiness] = await Promise.all([
    readWikiConfigSummary(repoRoot),
    readWikiStatusConfigReadiness(repoRoot),
    scanWikiRepository(repoRoot),
    lintWiki(repoRoot),
    readQueueStatus(repoRoot),
    readExplorerStatus(repoRoot),
    getPdfReadinessStatus(repoRoot),
  ]);
  const config = summarizeConfig(configSummary);
  if (configSummary.ok && !pdfReadiness.config_valid && !config.errors.some((issue) => issue.message.includes("pdf_ingestion"))) {
    const issue = pdfReadiness.issues[0];
    if (issue !== undefined) {
      config.valid = false;
      config.errors.push({
        severity: "error",
        code: "wiki_config_invalid",
        message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH} pdf_ingestion config: ${issue.message}`,
        path: WIKI_CONFIG_RELATIVE_PATH,
        hint: issue.hint,
      });
    }
  }
  const agents = await summarizeAgents(configReadiness, repoRoot);
  const providers = configReadiness.providers;
  const auto = summarizeAutoReadiness(agents);
  const git = configSummary.ok ? await readGitState(repoRoot, configSummary.value.gitEnabled) : unknownGitState();
  const profiles = summarizeProfiles(scan);
  const warningCount = lint.counts.warning + git.errors.length + queue.errors.length;
  const errorCount = lint.counts.error + config.errors.length;

  return {
    configPath: WIKI_CONFIG_RELATIVE_PATH,
    config,
    agents,
    providers,
    auto,
    pdf_ingestion: pdfReadiness,
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

async function summarizeAgents(config: WikiStatusConfigReadiness, repoRoot: string): Promise<StatusData["agents"]> {
  const items = await Promise.all(config.localAgents.map((agent) => readLocalAgentStatus(agent, repoRoot)));

  return {
    default: config.agentDefault,
    local: {
      count: items.length,
      names: items.map((item) => item.name).sort(),
      items: items.sort((left, right) => left.name.localeCompare(right.name)),
    },
  };
}

async function readLocalAgentStatus(agent: LocalAgentConfig, repoRoot: string): Promise<StatusLocalAgentItem> {
  const availability = await checkLocalAgentAvailability(agent, { cwd: repoRoot });
  if (availability.ok) {
    return {
      name: agent.name,
      type: agent.type,
      command: agent.command,
      available: true,
      availability_error: null,
      timeout_seconds: agent.timeoutSeconds,
    };
  }

  return {
    name: agent.name,
    type: agent.type,
    command: agent.command,
    available: false,
    availability_error: {
      code: availability.error.code,
      message: availability.error.message,
      hint: availability.error.hint,
      executable_path: availability.error.executablePath,
    },
    timeout_seconds: agent.timeoutSeconds,
  };
}

function summarizeAutoReadiness(agents: StatusData["agents"]): StatusData["auto"] {
  if (agents.default === null) {
    return {
      can_run: false,
      agent: null,
      reason: "Default agent is not configured.",
    };
  }

  const defaultAgent = agents.local.items.find((agent) => agent.name === agents.default);
  if (defaultAgent === undefined) {
    return {
      can_run: false,
      agent: agents.default,
      reason: `Default agent ${agents.default} is not configured as a local agent.`,
    };
  }

  if (!defaultAgent.available) {
    return {
      can_run: false,
      agent: agents.default,
      reason: defaultAgent.availability_error?.message ?? `Default agent ${agents.default} command is unavailable.`,
    };
  }

  return {
    can_run: true,
    agent: agents.default,
    reason: null,
  };
}

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
