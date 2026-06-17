import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createWiki, type CreateWikiOptions } from "../src/scaffold/createWiki.js";

const defaultOptions: CreateWikiOptions = {
  agent: "generic",
  obsidian: false,
  dataview: false,
  git: true,
  quartzReady: false,
  force: false,
};

type Profile = {
  name: string;
  mode: string;
  include?: string[];
  exclude?: string[];
  visibility?: {
    include_private?: boolean;
    required_value?: string;
  };
  safety?: Record<string, boolean>;
  features?: Record<string, boolean>;
  source_links?: Record<string, boolean>;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readProfile(targetDir: string, profileName: "local" | "review" | "public"): Promise<Profile> {
  const profileContent = await readFile(resolve(targetDir, `.llm-wiki/profiles/${profileName}.yml`), "utf8");

  return parse(profileContent) as Profile;
}

describe("profile privacy scaffold contract", () => {
  it("generates parseable local, review, and public profile YAML files by default", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-profile-yaml-"));
    const targetDir = resolve(parent, "wiki");
    const profilePaths = [
      ".llm-wiki/profiles/local.yml",
      ".llm-wiki/profiles/review.yml",
      ".llm-wiki/profiles/public.yml",
    ] as const;

    try {
      await createWiki(targetDir, defaultOptions);

      // Act
      const profiles = await Promise.all(profilePaths.map((path) => readFile(resolve(targetDir, path), "utf8")));
      const parsedProfiles = profiles.map((content) => parse(content) as Profile);

      // Assert
      for (const profilePath of profilePaths) {
        expect(await pathExists(resolve(targetDir, profilePath)), profilePath).toBe(true);
      }
      expect(parsedProfiles.map((profile) => profile.name)).toEqual(["local", "review", "public"]);
      for (const profile of parsedProfiles) {
        expect(profile.mode, profile.name).toEqual(expect.any(String));
        expect(profile.include, profile.name).toEqual(expect.any(Array));
      }
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("expresses public publishing as explicit visibility-public opt-in", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-profile-public-opt-in-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await createWiki(targetDir, defaultOptions);

      // Act
      const publicProfile = await readProfile(targetDir, "public");

      // Assert
      expect(publicProfile.include).toEqual(["curated/**"]);
      expect(publicProfile.visibility).toMatchObject({
        include_private: false,
        required_value: "public",
      });
      expect(publicProfile.safety).toMatchObject({
        fail_on_private_pages: true,
        fail_on_missing_visibility: true,
      });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("keeps raw inputs, queues, logs, source summaries, and private dashboard paths out of public defaults", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-profile-public-excludes-"));
    const targetDir = resolve(parent, "wiki");
    const requiredPublicExcludes = [
      "raw/**",
      "raw/queue/**",
      "curated/log.md",
      "curated/sources/**",
      "curated/dashboards/private/**",
      "curated/private/**",
    ];

    try {
      await createWiki(targetDir, defaultOptions);

      // Act
      const publicProfile = await readProfile(targetDir, "public");

      // Assert
      expect(publicProfile.exclude).toEqual(expect.arrayContaining(requiredPublicExcludes));
      expect(publicProfile.safety).toMatchObject({
        fail_on_private_pages: true,
        fail_on_private_links: true,
        fail_on_raw_links: true,
        fail_on_public_graph_private_nodes: true,
        fail_on_public_search_private_text: true,
      });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("keeps local and review profiles private-capable without exposing raw originals", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-profile-private-modes-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await createWiki(targetDir, defaultOptions);

      // Act
      const localProfile = await readProfile(targetDir, "local");
      const reviewProfile = await readProfile(targetDir, "review");

      // Assert
      expect(localProfile.visibility).toMatchObject({ include_private: true });
      expect(localProfile.include).toEqual(expect.arrayContaining(["curated/**", "raw/inputs/**/_source.md", "raw/queue/**"]));
      expect(localProfile.exclude).toEqual(expect.arrayContaining(["raw/inputs/**/original.*"]));
      expect(reviewProfile.visibility).toMatchObject({ include_private: true });
      expect(reviewProfile.include).toEqual(expect.arrayContaining(["curated/**", "raw/inputs/**/_source.md", "raw/queue/**"]));
      expect(reviewProfile.exclude).toEqual(expect.arrayContaining(["raw/inputs/**/original.*"]));
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
