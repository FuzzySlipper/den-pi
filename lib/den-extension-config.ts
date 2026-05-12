import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReasoningCaptureOptions } from "./den-subagent-pipeline.ts";

const execFileAsync = promisify(execFile);

const projectDenConfigPathCache = new Map<string, string[]>();

export type DenReasoningCaptureConfig = {
  capture_provider_summaries?: boolean;
  capture_raw_local_previews?: boolean;
  preview_chars?: number;
};

export type DenExtensionConfig = {
  version?: number;
  fallback_model?: string;
  reasoning?: DenReasoningCaptureConfig;
  subagents?: Record<string, {
    model?: string;
    tools?: string;
  }>;
};

export type ConfigScope = "project" | "global";

export const DEN_CONFIG_FILENAME = "den-config.json";

export async function loadMergedDenExtensionConfig(cwd: string): Promise<DenExtensionConfig> {
  const globalConfig = await loadDenExtensionConfig("global", cwd);
  const projectConfig = await loadDenExtensionConfig("project", cwd);
  const roles = new Set([
    ...Object.keys(globalConfig.subagents ?? {}),
    ...Object.keys(projectConfig.subagents ?? {}),
  ]);
  const subagents: NonNullable<DenExtensionConfig["subagents"]> = {};
  for (const role of roles) {
    subagents[role] = {
      ...(globalConfig.subagents?.[role] ?? {}),
      ...(projectConfig.subagents?.[role] ?? {}),
    };
  }

  const reasoning = mergeReasoningConfig(globalConfig.reasoning, projectConfig.reasoning);
  return {
    version: 1,
    ...globalConfig,
    ...projectConfig,
    reasoning,
    subagents,
  };
}

export async function loadDenExtensionConfig(scope: ConfigScope, cwd: string): Promise<DenExtensionConfig> {
  const candidates = scope === "project" ? await resolveProjectDenConfigPaths(cwd) : [denConfigPath(scope, cwd)];
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { version: 1, subagents: {} };
}

export async function saveDenExtensionConfig(scope: ConfigScope, cwd: string, config: DenExtensionConfig) {
  const file = denConfigPath(scope, cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cleanDenExtensionConfig(config), null, 2)}\n`, "utf8");
}

/**
 * Return the primary config path for the given scope.
 * For project scope, this is always `cwd/.pi/den-config.json`.
 * For display/discovery of additional worktree-inherited paths, use `denConfigPaths` instead.
 */
export function denConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === "global") return path.join(os.homedir(), ".pi", "agent", DEN_CONFIG_FILENAME);
  return path.join(cwd, ".pi", DEN_CONFIG_FILENAME);
}

/**
 * Return all candidate project config paths in priority order:
 * 1. `cwd/.pi/den-config.json` (local project or primary worktree)
 * 2. The primary worktree's `.pi/den-config.json` when `cwd` is a linked git worktree
 *
 * This allows isolated worktrees to inherit project Den config from the
 * main checkout without manual copying or symlinking.
 */
export async function denConfigPaths(cwd: string): Promise<string[]> {
  return resolveProjectDenConfigPaths(cwd);
}

/**
 * Resolve ordered candidate paths for project-scoped Den config.
 * Successful git discoveries are cached by resolved cwd for the Pi process;
 * non-git fallbacks are intentionally uncached so newly initialized repos can
 * be discovered on a later call.
 *
 * Detection strategy:
 * 1. Always include `<resolved-cwd>/.pi/den-config.json`.
 * 2. Use `git -C <cwd> rev-parse --path-format=absolute --git-common-dir` to
 *    find the shared `.git` directory. For linked worktrees this points to
 *    `<main-worktree>/.git`.
 * 3. If the common dir's parent differs from `cwd`, also try
 *    `<common-dir-parent>/.pi/den-config.json`.
 */
export async function resolveProjectDenConfigPaths(cwd: string): Promise<string[]> {
  const resolvedCwd = path.resolve(cwd);
  const cached = projectDenConfigPathCache.get(resolvedCwd);
  if (cached) return [...cached];

  const localPath = path.join(resolvedCwd, ".pi", DEN_CONFIG_FILENAME);
  const paths: string[] = [localPath];

  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeout: 5_000,
    });
    const commonDir = stdout.trim();
    if (!commonDir) return paths;

    // For a main checkout, commonDir is `<root>/.git` — parent is the worktree root itself.
    // For a linked worktree, commonDir is `<main-worktree>/.git` — parent is the main worktree.
    const commonParent = path.dirname(commonDir);
    const resolved = path.resolve(commonParent);

    // Only add the inherited path if it's genuinely different from cwd.
    if (resolved !== resolvedCwd) {
      const inheritedPath = path.join(commonParent, ".pi", DEN_CONFIG_FILENAME);
      if (!paths.includes(inheritedPath)) {
        paths.push(inheritedPath);
      }
    }

    projectDenConfigPathCache.set(resolvedCwd, [...paths]);
  } catch {
    // Not a git repo or git not available — only use local path. Do not cache
    // this fallback because callers may initialize git in the same directory.
  }

  return paths;
}

export function clearProjectDenConfigPathCache() {
  projectDenConfigPathCache.clear();
}

export function reasoningCaptureOptionsFromConfig(config: DenExtensionConfig): ReasoningCaptureOptions {
  const reasoning = config.reasoning ?? {};
  return {
    captureProviderSummaries: optionalBoolean(reasoning.capture_provider_summaries),
    captureRawLocalPreviews: optionalBoolean(reasoning.capture_raw_local_previews),
    previewChars: optionalFiniteNumber(reasoning.preview_chars),
  };
}

function mergeReasoningConfig(
  globalReasoning?: DenReasoningCaptureConfig,
  projectReasoning?: DenReasoningCaptureConfig,
): DenReasoningCaptureConfig | undefined {
  const merged = {
    ...(globalReasoning ?? {}),
    ...(projectReasoning ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cleanDenExtensionConfig(config: DenExtensionConfig): DenExtensionConfig {
  const cleaned: DenExtensionConfig = { ...config, version: 1 };
  if (cleaned.reasoning && Object.keys(cleaned.reasoning).length === 0) delete cleaned.reasoning;
  if (cleaned.subagents && Object.keys(cleaned.subagents).length === 0) delete cleaned.subagents;
  return cleaned;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
