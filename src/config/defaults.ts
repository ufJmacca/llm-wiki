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
