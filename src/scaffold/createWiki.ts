import type { InitAgent } from "../config/defaults.js";
import { writeScaffold, type ScaffoldWriteReport } from "../utils/fs.js";
import type { Result } from "../utils/result.js";
import { planWikiScaffold } from "./files.js";

export type CreateWikiOptions = {
  agent: InitAgent;
  obsidian: boolean;
  dataview: boolean;
  git: boolean;
  quartzReady: boolean;
  force: boolean;
};

export async function createWiki(targetDir: string, options: CreateWikiOptions): Promise<Result<ScaffoldWriteReport>> {
  return writeScaffold(targetDir, planWikiScaffold(options), { force: options.force });
}
