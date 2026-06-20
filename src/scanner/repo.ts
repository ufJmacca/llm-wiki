import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import {
  computeContentHash,
  parseLogEntries,
  parseProfile,
  parseQueueItem,
  scanMarkdownDocument,
  type MarkdownDocumentScan,
  type ProfileScan,
  type QueueItem,
  type QueueItemScan,
  type RuntimeLogScan,
} from "./index.js";

export type RepoFile = {
  path: string;
  content_hash: string;
};

export type RepoMarkdownFile = RepoFile & {
  content: string;
  scan: MarkdownDocumentScan;
};

export type RepoQueueFile = RepoFile & {
  content: string;
  scan: QueueItemScan;
};

export type RepoProfileFile = RepoFile & {
  name: string;
  content: string;
  scan: ProfileScan;
};

export type RepoOriginalFile = RepoFile & {
  content: Buffer;
};

export type RepoLogFile = RepoFile & {
  content: string;
  scan: RuntimeLogScan;
};

export type SourceCard = RepoMarkdownFile & {
  source_id: string | null;
  title: string | null;
  status: string | null;
  visibility: string | null;
  content_hash_field: string | null;
};

export type RepoScan = {
  rootDir: string;
  files: RepoFile[];
  linkableFilePaths: string[];
  markdown: RepoMarkdownFile[];
  curatedPages: RepoMarkdownFile[];
  sourceCards: SourceCard[];
  queueFiles: RepoQueueFile[];
  queueItems: Array<RepoQueueFile & { item: QueueItem }>;
  profiles: RepoProfileFile[];
  rawOriginals: RepoOriginalFile[];
  log: RepoLogFile | null;
};

const SKIPPED_ROOTS = [
  ".git",
  ".llm-wiki/cache",
  ".llm-wiki/templates",
  "dist",
  "node_modules",
  "quartz/content",
  "quartz/node_modules",
  "quartz/public",
];
const SKIPPED_FILES = new Set([".llm-wiki/config.yml"]);

export async function scanWikiRepository(rootDir: string): Promise<RepoScan> {
  const { filePaths, linkableFilePaths } = await listInputFiles(rootDir);
  const files: RepoFile[] = [];
  const markdown: RepoMarkdownFile[] = [];
  const queueFiles: RepoQueueFile[] = [];
  const profiles: RepoProfileFile[] = [];
  const rawOriginals: RepoOriginalFile[] = [];
  let log: RepoLogFile | null = null;

  for (const path of filePaths) {
    const absolutePath = resolve(rootDir, path);
    const content = await readFile(absolutePath);
    const file: RepoFile = {
      path,
      content_hash: computeContentHash(content),
    };
    files.push(file);

    const rawOriginal = isRawOriginalPath(path);
    if (rawOriginal) {
      rawOriginals.push({
        ...file,
        content,
      });
    }

    if (isMarkdownPath(path) && isLiveMarkdownPath(path)) {
      const text = content.toString("utf8");
      const markdownFile: RepoMarkdownFile = {
        ...file,
        content: text,
        scan: scanMarkdownDocument({ path, content: text }),
      };
      markdown.push(markdownFile);

      if (path === "curated/log.md") {
        log = {
          ...file,
          content: text,
          scan: parseLogEntries({ path, content: text }),
        };
      }
      continue;
    }

    if (isQueueJsonPath(path)) {
      const text = content.toString("utf8");
      queueFiles.push({
        ...file,
        content: text,
        scan: parseQueueItem({ path, content: text }),
      });
      continue;
    }

    if (isProfilePath(path)) {
      const text = content.toString("utf8");
      profiles.push({
        ...file,
        name: profileNameFromPath(path),
        content: text,
        scan: parseProfile({ path, content: text }),
      });
      continue;
    }

  }

  const sourceCards = markdown.filter(isSourceCardMarkdown).map(toSourceCard);
  const queueItems = queueFiles.flatMap((queueFile) => (queueFile.scan.item ? [{ ...queueFile, item: queueFile.scan.item }] : []));

  return {
    rootDir,
    files: sortByPath(files),
    linkableFilePaths: [...linkableFilePaths].sort(),
    markdown: sortByPath(markdown),
    curatedPages: sortByPath(markdown.filter((file) => file.path.startsWith("curated/"))),
    sourceCards: sortByPath(sourceCards),
    queueFiles: sortByPath(queueFiles),
    queueItems: sortByPath(queueItems),
    profiles: sortByPath(profiles),
    rawOriginals: sortByPath(rawOriginals),
    log,
  };
}

function isMarkdownPath(path: string): boolean {
  return extname(path).toLowerCase() === ".md";
}

function isQueueJsonPath(path: string): boolean {
  return /^raw\/queue\/[^/]+\.json$/.test(path);
}

function isProfilePath(path: string): boolean {
  return /^\.llm-wiki\/profiles\/[^/]+\.ya?ml$/.test(path);
}

function profileNameFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.ya?ml$/, "") ?? path;
}

export function isRawOriginalPath(path: string): boolean {
  return /^raw\/inputs\/.+\/original\.[^/]+$/.test(path);
}

function isLiveMarkdownPath(path: string): boolean {
  if (!path.startsWith("raw/inputs/")) {
    return true;
  }

  return isSourceCardPath(path);
}

function isSourceCardMarkdown(file: RepoMarkdownFile): boolean {
  return isSourceCardPath(file.path);
}

function isSourceCardPath(path: string): boolean {
  return /^raw\/inputs\/.+\/_source\.md$/.test(path);
}

function toSourceCard(file: RepoMarkdownFile): SourceCard {
  const frontmatter = file.scan.frontmatter;

  return {
    ...file,
    source_id: typeof frontmatter?.source_id === "string" ? frontmatter.source_id : null,
    title: typeof frontmatter?.title === "string" ? frontmatter.title : null,
    status: typeof frontmatter?.status === "string" ? frontmatter.status : null,
    visibility: typeof frontmatter?.visibility === "string" ? frontmatter.visibility : null,
    content_hash_field: typeof frontmatter?.content_hash === "string" ? frontmatter.content_hash : null,
  };
}

async function listInputFiles(rootDir: string): Promise<{ filePaths: string[]; linkableFilePaths: string[] }> {
  const paths: string[] = [];
  const linkableFilePaths: string[] = [];

  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = resolve(rootDir, relativeDir);
    const entries = await readdir(absoluteDir);
    for (const entry of entries.sort()) {
      const path = joinRelativePath(relativeDir, entry);
      if (SKIPPED_FILES.has(path)) {
        linkableFilePaths.push(path);
        continue;
      }

      if (shouldSkipRoot(path)) {
        continue;
      }

      const absolutePath = resolve(rootDir, path);
      const pathStat = await lstat(absolutePath);
      if (pathStat.isSymbolicLink()) {
        continue;
      }

      if (pathStat.isDirectory()) {
        await visit(path);
        continue;
      }

      if (pathStat.isFile()) {
        paths.push(toPosixPath(relative(rootDir, absolutePath)));
      }
    }
  }

  await visit("");
  return { filePaths: paths.sort(), linkableFilePaths: linkableFilePaths.sort() };
}

function shouldSkipRoot(path: string): boolean {
  return SKIPPED_ROOTS.some((skippedRoot) => path === skippedRoot || path.startsWith(`${skippedRoot}/`));
}

function joinRelativePath(base: string, entry: string): string {
  return base === "" ? entry : `${base}/${entry}`;
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function sortByPath<T extends { path: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.path.localeCompare(right.path));
}
