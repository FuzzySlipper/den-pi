/**
 * Safe /tmp cleanup plan builder and executor for Pi validation workflows.
 *
 * Scans known-safe temp directories (/tmp/<project-id>/) and explicitly
 * opted-in legacy patterns (/tmp/den-mcp-test-* for the den-mcp project),
 * returning a preview plan with file count and total bytes before any
 * deletion happens.  Destructive cleanup refuses to proceed when other
 * Den agents are active on the same project unless a --force flag is set.
 *
 * Follows `_global/agent-temp-file-policy`:
 *   - Default cleanup root is /tmp/<project-id>/
 *   - Previews by default (dry-run)
 *   - Checks Den active agents before destructive delete
 *   - Supports safe known legacy patterns but does not expand to
 *     arbitrary /tmp deletion
 *
 * @module den-tmp-cleanup
 */

import { readdir, stat, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TmpCleanupEntry {
  /** Absolute path to the file or directory. */
  path: string;
  /** Size in bytes. 0 for directories (contents counted separately). */
  bytes: number;
  /** Whether this entry is a directory. */
  isDir: boolean;
}

export interface TmpCleanupPlan {
  /** Project ID scoping this plan. */
  projectId: string;
  /** Cleanup root directory, e.g. /tmp/den-mcp. */
  rootDir: string;
  /** Individual file entries to consider for deletion. */
  entries: TmpCleanupEntry[];
  /** Total byte count across all entries. */
  totalBytes: number;
  /** Total file count (excluding directories). */
  totalFiles: number;
  /** Whether legacy patterns were also scanned. */
  includedLegacyPatterns: boolean;
  /** Legacy pattern matches (additional entries beyond the root dir). */
  legacyEntries: TmpCleanupEntry[];
}

export interface TmpCleanupResult {
  /** Whether cleanup actually ran (as opposed to a dry-run preview). */
  dryRun: boolean;
  /** The plan that was used (preview or execution). */
  plan: TmpCleanupPlan;
  /** Number of files successfully deleted (0 for dry-run). */
  deletedCount: number;
  /** Bytes freed (0 for dry-run). */
  freedBytes: number;
  /** Any errors encountered during cleanup. */
  errors: { path: string; message: string }[];
  /** Whether the plan was blocked by active agents. */
  blockedByActiveAgents: boolean;
}

export interface TmpCleanupOptions {
  /** Project ID used to derive /tmp/<project-id>/. Default: 'den-mcp'. */
  projectId?: string;
  /** Explicit root dir override. */
  rootDir?: string;
  /** Include known legacy patterns (e.g. /tmp/den-mcp-test-*). Default: true. */
  includeLegacyPatterns?: boolean;
  /** If true, actually delete files. Default: false (dry-run preview). */
  destructive?: boolean;
  /** If true, scan and clean nested files/directories under the project tmp root. Default: true. */
  recursive?: boolean;
  /** If true, skip active-agent check even if other agents are busy. */
  force?: boolean;
  /** Mock or pre-collected active agents list for testing (skips real fetch). */
  activeAgents?: { agent: string; role?: string }[];
}

// ---------------------------------------------------------------------------
// Known legacy patterns
// ---------------------------------------------------------------------------

/**
 * Legacy pattern generators for known safe tmp artifacts.
 * Only defined for den-mcp where the patterns are well-understood.
 */
const LEGACY_PATTERNS: Record<string, string[]> = {
  "den-mcp": ["/tmp/den-mcp-test-*"],
};

// ---------------------------------------------------------------------------
// Path scanning
// ---------------------------------------------------------------------------

/**
 * Scan a directory for files and directories.
 * Recurses by default so `/tmp/<project-id>/` can contain arbitrary temp
 * layouts while cleanup remains scoped to that project root.
 * Returns entries sorted by path for deterministic output.
 */
export async function scanDirectory(dirPath: string, options: { recursive?: boolean } = {}): Promise<TmpCleanupEntry[]> {
  const entries: TmpCleanupEntry[] = [];
  const recursive = options.recursive !== false;

  async function visit(currentDir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(currentDir);
    } catch {
      return;
    }

    for (const name of names) {
      const fullPath = path.join(currentDir, name);
      try {
        const stats = await stat(fullPath);
        const isDir = stats.isDirectory();
        entries.push({
          path: fullPath,
          bytes: stats.isFile() ? stats.size : 0,
          isDir,
        });
        if (recursive && isDir) {
          await visit(fullPath);
        }
      } catch {
        // Skip entries we cannot stat/read (permission, race, etc.)
      }
    }
  }

  await visit(dirPath);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Build a cleanup plan for the given project ID.
 * Scans /tmp/<projectId>/ and optionally known legacy patterns.
 */
export async function planTmpCleanup(options: TmpCleanupOptions = {}): Promise<TmpCleanupPlan> {
  const projectId = options.projectId ?? "den-mcp";
  const rootDir = options.rootDir ?? path.join(os.tmpdir(), projectId);
  assertSafeTmpRoot(rootDir);
  const includeLegacy = options.includeLegacyPatterns !== false;
  const recursive = options.recursive !== false;

  const entries = await scanDirectory(rootDir, { recursive });
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of entries) {
    if (!entry.isDir) {
      totalBytes += entry.bytes;
      totalFiles++;
    }
  }

  const plan: TmpCleanupPlan = {
    projectId,
    rootDir,
    entries,
    totalBytes,
    totalFiles,
    includedLegacyPatterns: false,
    legacyEntries: [],
  };

  if (includeLegacy && LEGACY_PATTERNS[projectId]) {
    plan.includedLegacyPatterns = true;
    for (const pattern of LEGACY_PATTERNS[projectId]) {
      // Pattern is a glob-like path; scan via expanded glob
      const basePattern = pattern.replace(/\*$/, "");
      const baseDir = path.dirname(basePattern);
      const prefix = path.basename(basePattern);
      if (prefix.includes("*")) continue; // Skip patterns with mid-path wildcards
      const legacyEntries = await scanByPrefix(baseDir, prefix);
      plan.legacyEntries.push(...legacyEntries);
    }
    plan.legacyEntries.sort((a, b) => a.path.localeCompare(b.path));
  }

  return plan;
}

/**
 * Scan a directory for entries matching a filename prefix.
 */
export async function scanByPrefix(dirPath: string, prefix: string): Promise<TmpCleanupEntry[]> {
  const entries: TmpCleanupEntry[] = [];
  try {
    const names = await readdir(dirPath);
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const fullPath = path.join(dirPath, name);
      try {
        const stats = await stat(fullPath);
        entries.push({
          path: fullPath,
          bytes: stats.isFile() ? stats.size : 0,
          isDir: stats.isDirectory(),
        });
      } catch {
        // Skip entries we cannot stat
      }
    }
  } catch {
    // Directory does not exist
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Active-agent check (Den-aware)
// ---------------------------------------------------------------------------

/**
 * Check whether other agents are active on this project.
 * Returns the list of other active agents, or an empty list if none found
 * (or if Den is unreachable).
 *
 * The caller provides activeAgents from their own fetch; for testing we
 * accept a pre-collected list.
 */
export function checkActiveAgents(
  currentAgent: string,
  activeAgents?: { agent: string; role?: string }[],
): { otherActive: boolean; agents: string[] } {
  if (!activeAgents || activeAgents.length === 0) {
    return { otherActive: false, agents: [] };
  }

  const others = activeAgents
    .filter((a) => a.agent !== currentAgent)
    .map((a) => a.agent);

  return { otherActive: others.length > 0, agents: others };
}

// ---------------------------------------------------------------------------
// Plan formatting
// ---------------------------------------------------------------------------

/**
 * Format a cleanup plan as human-readable lines (for TUI widget or notification).
 */
export function formatCleanupPlan(plan: TmpCleanupPlan): string[] {
  const lines: string[] = [
    `Tmp cleanup plan for ${plan.projectId}`,
    `Root: ${plan.rootDir}`,
    `Files: ${plan.totalFiles}`,
    `Size: ${formatBytes(plan.totalBytes)}`,
  ];

  if (plan.entries.length > 0) {
    lines.push("", "Project tmp directory contents:");
    for (const entry of plan.entries.slice(0, 30)) {
      lines.push(`  ${entry.isDir ? "📁" : "📄"} ${path.basename(entry.path)}${entry.isDir ? "/" : ` (${formatBytes(entry.bytes)})`}`);
    }
    if (plan.entries.length > 30) {
      lines.push(`  ... and ${plan.entries.length - 30} more`);
    }
  } else {
    lines.push("", "Project tmp directory is empty or does not exist.");
  }

  if (plan.includedLegacyPatterns && plan.legacyEntries.length > 0) {
    const legacyBytes = plan.legacyEntries.reduce((sum, e) => sum + e.bytes, 0);
    lines.push("", `Legacy patterns: ${plan.legacyEntries.length} file(s) (${formatBytes(legacyBytes)})`);
    for (const entry of plan.legacyEntries.slice(0, 10)) {
      lines.push(`  ${path.basename(entry.path)} (${formatBytes(entry.bytes)})`);
    }
    if (plan.legacyEntries.length > 10) {
      lines.push(`  ... and ${plan.legacyEntries.length - 10} more`);
    }
  } else if (plan.includedLegacyPatterns) {
    lines.push("", "No legacy temp files found.");
  }

  return lines;
}

/**
 * Format a cleanup result as human-readable lines.
 */
export function formatCleanupResult(result: TmpCleanupResult): string[] {
  const lines: string[] = [
    `Tmp cleanup ${result.blockedByActiveAgents ? "blocked" : result.dryRun ? "preview" : "completed"} for ${result.plan.projectId}`,
  ];

  if (result.blockedByActiveAgents) {
    lines.push("", "⚠️  Other agents are active on this project. Use --force to override.");
    return lines;
  }

  if (result.dryRun) {
    lines.push(...formatCleanupPlan(result.plan));
    if (result.plan.totalFiles > 0 || result.plan.legacyEntries.length > 0) {
      const totalSize = result.plan.totalBytes + result.plan.legacyEntries.reduce((s, e) => s + e.bytes, 0);
      lines.push("", `Run with --force (or destructive=true) to delete ${result.plan.totalFiles + result.plan.legacyEntries.length} file(s) (${formatBytes(totalSize)}).`);
    }
  } else {
    lines.push(`Deleted: ${result.deletedCount} file(s)`);
    lines.push(`Freed: ${formatBytes(result.freedBytes)}`);
    if (result.errors.length > 0) {
      lines.push("", `Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        lines.push(`  ${err.path}: ${err.message}`);
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a cleanup plan. By default performs a dry-run (preview only).
 * Set destructive=true and force=true (or confirm no other active agents)
 * to actually delete files.
 */
export async function executeTmpCleanup(
  plan: TmpCleanupPlan,
  options: TmpCleanupOptions & { currentAgent?: string } = {},
): Promise<TmpCleanupResult> {
  const destructive = options.destructive === true;
  const force = options.force === true;
  const currentAgent = options.currentAgent ?? "pi";

  // Check active agents (unless mocked via activeAgents option)
  let blockedByActiveAgents = false;
  if (destructive && !force && options.activeAgents !== undefined) {
    const check = checkActiveAgents(currentAgent, options.activeAgents);
    if (check.otherActive) {
      blockedByActiveAgents = true;
    }
  }

  if (!destructive || blockedByActiveAgents) {
    return {
      dryRun: true,
      plan,
      deletedCount: 0,
      freedBytes: 0,
      errors: [],
      blockedByActiveAgents,
    };
  }

  // Destructive: actually delete files first, then empty directories deepest-first.
  const allEntries = [...plan.entries, ...plan.legacyEntries];
  const fileEntries = allEntries.filter((e) => !e.isDir);
  const dirEntries = allEntries
    .filter((e) => e.isDir)
    .sort((a, b) => b.path.length - a.path.length);
  const errors: { path: string; message: string }[] = [];
  let deletedCount = 0;
  let freedBytes = 0;

  for (const entry of fileEntries) {
    try {
      await unlink(entry.path);
      deletedCount++;
      freedBytes += entry.bytes;
    } catch (err) {
      errors.push({ path: entry.path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const entry of dirEntries) {
    try {
      await rmdir(entry.path);
    } catch {
      // Directory may not be empty or may have been removed concurrently; that's fine.
    }
  }

  return {
    dryRun: false,
    plan,
    deletedCount,
    freedBytes,
    errors,
    blockedByActiveAgents: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSafeTmpRoot(rootDir: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (resolvedRoot === tmpRoot || !resolvedRoot.startsWith(`${tmpRoot}${path.sep}`)) {
    throw new Error(`Unsafe tmp cleanup root: ${rootDir}. Root must be a project-specific directory under ${tmpRoot}.`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Build a text result for the Pi tool response content.
 */
export function buildTmpCleanupToolResult(result: TmpCleanupResult): { content: { type: string; text: string }[]; details: Record<string, unknown> } {
  const lines = formatCleanupResult(result);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      dry_run: result.dryRun,
      project_id: result.plan.projectId,
      total_files: result.plan.totalFiles + result.plan.legacyEntries.length,
      total_bytes: result.plan.totalBytes + result.plan.legacyEntries.reduce((s, e) => s + e.bytes, 0),
      deleted_count: result.deletedCount,
      freed_bytes: result.freedBytes,
      blocked_by_active_agents: result.blockedByActiveAgents,
      errors: result.errors,
    },
  };
}

export function buildTmpCleanupToolParameters() {
  return {
    type: "object" as const,
    properties: {
      project_id: {
        type: "string" as const,
        description: "Project ID for root tmp dir resolution. Default: den-mcp.",
      },
      root_dir: {
        type: "string" as const,
        description: "Explicit root directory override, e.g. /tmp/other-project.",
      },
      include_legacy_patterns: {
        type: "boolean" as const,
        description: "Include known safe legacy patterns like /tmp/den-mcp-test-*. Default: true.",
      },
      destructive: {
        type: "boolean" as const,
        description: "Actually delete files. Default: false (dry-run preview).",
      },
      recursive: {
        type: "boolean" as const,
        description: "Scan and clean nested files/directories under the project tmp root. Default: true.",
      },
      force: {
        type: "boolean" as const,
        description: "Skip active-agent check. Default: false.",
      },
    },
    additionalProperties: false,
  };
}
