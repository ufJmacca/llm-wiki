export const SUPPORTED_INIT_AGENTS = ["codex", "claude", "generic"] as const;

export type InitAgent = (typeof SUPPORTED_INIT_AGENTS)[number];

export const DEFAULT_INIT_OPTIONS = {
  agent: "generic",
  obsidian: false,
  dataview: false,
  git: true,
  quartzReady: false,
  force: false,
  json: false,
} as const satisfies {
  agent: InitAgent;
  obsidian: boolean;
  dataview: boolean;
  git: boolean;
  quartzReady: boolean;
  force: boolean;
  json: boolean;
};

export const PUBLIC_PROFILE_REQUIRED_VISIBILITY = "public";

export const PUBLIC_PROFILE_EXCLUDES = [
  "raw/**",
  "raw/queue/**",
  "curated/log.md",
  "curated/sources/**",
  "curated/dashboards/private/**",
  "curated/private/**",
] as const;
