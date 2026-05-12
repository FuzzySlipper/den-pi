import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { JsonObject } from "./den-subagent-pipeline.ts";

const execFileAsync = promisify(execFile);
const STATUS_PREVIEW_MAX_CHARS = 4_000;

export type FinalHeadStatus =
  | "clean"
  | "dirty_uncommitted"
  | "branch_mismatch"
  | "branch_mismatch_dirty_uncommitted"
  | "unavailable"
  | "git_error";

export type FinalWorktreeStatus = "clean" | "dirty_uncommitted" | "unavailable" | "unknown";

export type FinalHeadSource = "supplied_branch" | "worktree_head";

export type FinalBranchHeadState = {
  final_head_commit?: string;
  final_head_status: FinalHeadStatus;
  final_head_source?: FinalHeadSource;
  final_branch?: string;
  final_worktree_branch?: string;
  final_branch_matches_worktree?: boolean;
  final_worktree_status: FinalWorktreeStatus;
  final_worktree_status_short?: string;
  final_head_error?: string;
};

export type FinalBranchHeadInput = {
  worktreePath?: string;
  branch?: string;
  cwd?: string;
};

export async function collectFinalBranchHead(input: FinalBranchHeadInput): Promise<FinalBranchHeadState | undefined> {
  const branch = normalizeString(input.branch);
  const worktreePath = normalizeString(input.worktreePath) ?? normalizeString(input.cwd);
  if (!worktreePath && !branch) return undefined;
  if (!worktreePath) {
    return unavailableState("no worktree_path or cwd available for final branch head inspection", branch);
  }

  try {
    const info = await stat(worktreePath);
    if (!info.isDirectory()) {
      return unavailableState(`worktree_path is not a directory: ${worktreePath}`, branch);
    }
  } catch (error) {
    return unavailableState(`worktree_path unavailable: ${formatError(error)}`, branch);
  }

  const errors: string[] = [];
  const inside = await gitText(worktreePath, ["rev-parse", "--is-inside-work-tree"], errors);
  if (inside !== "true") {
    return gitErrorState(errors, branch, "path is not inside a git worktree");
  }

  const worktreeBranch = await gitText(worktreePath, ["branch", "--show-current"], errors)
    ?? await gitText(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], errors);
  const statusShort = await gitText(worktreePath, ["status", "--short"], errors) ?? "";
  const worktreeStatus: FinalWorktreeStatus = statusShort.trim() ? "dirty_uncommitted" : "clean";
  const headSource: FinalHeadSource = branch ? "supplied_branch" : "worktree_head";
  const finalBranch = branch ?? normalizeString(worktreeBranch);
  const commitArgs = branch
    ? ["rev-parse", "--verify", `${branch}^{commit}`]
    : ["rev-parse", "--verify", "HEAD^{commit}"];
  const finalHeadCommit = await gitText(worktreePath, commitArgs, errors);
  if (!finalHeadCommit) {
    return gitErrorState(errors, finalBranch, "could not resolve final HEAD commit", {
      final_head_source: headSource,
      final_worktree_branch: normalizeString(worktreeBranch),
      final_worktree_status: worktreeStatus,
      final_worktree_status_short: boundedStatus(statusShort),
    });
  }

  const branchMatchesWorktree = branch
    ? normalizeBranchForCompare(worktreeBranch) === normalizeBranchForCompare(branch)
    : undefined;
  const mismatch = branchMatchesWorktree === false;
  const finalHeadStatus: FinalHeadStatus = mismatch
    ? (worktreeStatus === "dirty_uncommitted" ? "branch_mismatch_dirty_uncommitted" : "branch_mismatch")
    : worktreeStatus;

  return omitUndefined({
    final_head_commit: finalHeadCommit,
    final_head_status: finalHeadStatus,
    final_head_source: headSource,
    final_branch: finalBranch,
    final_worktree_branch: normalizeString(worktreeBranch),
    final_branch_matches_worktree: branchMatchesWorktree,
    final_worktree_status: worktreeStatus,
    final_worktree_status_short: boundedStatus(statusShort),
  }) as FinalBranchHeadState;
}

export function buildFinalBranchHeadMetadata(state: FinalBranchHeadState | undefined): JsonObject {
  if (!state) return {};
  return omitUndefined({
    final_head_commit: state.final_head_commit ?? null,
    final_head_status: state.final_head_status,
    final_head_source: state.final_head_source ?? null,
    final_branch: state.final_branch ?? null,
    final_worktree_branch: state.final_worktree_branch ?? null,
    final_branch_matches_worktree: state.final_branch_matches_worktree ?? null,
    final_worktree_status: state.final_worktree_status,
    final_worktree_status_short: state.final_worktree_status_short ?? null,
    final_head_error: state.final_head_error ?? null,
  });
}

export function finalBranchHeadInspectionError(error: unknown, input: FinalBranchHeadInput): FinalBranchHeadState {
  return {
    final_head_status: "git_error",
    final_head_source: normalizeString(input.branch) ? "supplied_branch" : "worktree_head",
    final_branch: normalizeString(input.branch),
    final_worktree_status: "unknown",
    final_head_error: formatError(error),
  };
}

function unavailableState(error: string, branch?: string): FinalBranchHeadState {
  return {
    final_head_status: "unavailable",
    final_head_source: branch ? "supplied_branch" : "worktree_head",
    final_branch: branch,
    final_worktree_status: "unavailable",
    final_head_error: error,
  };
}

function gitErrorState(
  errors: string[],
  branch: string | undefined,
  fallback: string,
  extra: Partial<FinalBranchHeadState> = {},
): FinalBranchHeadState {
  return {
    final_head_status: "git_error",
    final_head_source: extra.final_head_source ?? (branch ? "supplied_branch" : "worktree_head"),
    final_branch: branch,
    final_worktree_status: extra.final_worktree_status ?? "unknown",
    final_worktree_branch: extra.final_worktree_branch,
    final_worktree_status_short: extra.final_worktree_status_short,
    final_head_error: errors.length ? errors.join("; ") : fallback,
  };
}

async function gitText(cwd: string, args: string[], errors: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    const text = String(stdout).trim();
    return text || undefined;
  } catch (error) {
    errors.push(`git ${args.join(" ")}: ${formatError(error)}`);
    return undefined;
  }
}

function boundedStatus(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= STATUS_PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, STATUS_PREVIEW_MAX_CHARS).trimEnd()}…`;
}

function normalizeBranchForCompare(value: string | undefined): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized || normalized === "HEAD") return normalized;
  return normalized.replace(/^refs\/heads\//, "");
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function omitUndefined(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
