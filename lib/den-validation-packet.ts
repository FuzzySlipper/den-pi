/**
 * Validation packet producer for delegated coder workflows.
 *
 * Runs declared test commands in sequence, collects deterministic results, and
 * formats a `validation_packet` for posting to the Den task thread.  The packet
 * carries stable metadata (`type: validation_packet`, workflow/version, task_id,
 * branch/head, test commands, pass/fail/blocked status) and is projected to
 * `validation_completed` lifecycle ops via the task 939 conventions.
 *
 * The first useful producer is an orchestrator-run helper analogous to
 * `den-drift-check`: it executes validation commands, records outcomes, and
 * posts a structured packet.  Failures are visible but never conflated with
 * review approval.
 *
 * @module den-validation-packet
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Overall status of a validation run. */
export type ValidationStatus = "pass" | "fail" | "blocked" | "partial";

/** Result of a single test command execution. */
export interface ValidationCommandResult {
  /** The command that was executed. */
  command: string;
  /** Pass/fail/blocked/skipped status. */
  status: "pass" | "fail" | "blocked" | "skipped";
  /** Exit code (numeric, if available). */
  exit_code: number | null;
  /** Duration in milliseconds. */
  duration_ms: number;
  /** Preview of stdout (bounded). */
  stdout_preview: string;
  /** Preview of stderr (bounded). */
  stderr_preview: string;
  /** Error message if the command could not be executed. */
  error?: string;
}

/** Input for a validation run. */
export interface ValidationRunInput {
  task_id?: number;
  branch?: string;
  base_commit?: string;
  head_commit?: string;
  /** Working directory for command execution. */
  cwd: string;
  /** Test/validation commands to execute. */
  commands: string[];
  /** Timeout per command in milliseconds. Default: 120_000 (2 min). */
  timeout_ms?: number;
  /** Maximum stdout/stderr preview characters. Default: 2000. */
  preview_chars?: number;
  /** Maximum concurrent commands. Default: 1 (sequential). */
  max_concurrency?: number;
}

/** Aggregated result of a validation run. */
export interface ValidationRunResult {
  task_id?: number;
  branch?: string;
  base_commit?: string;
  head_commit?: string;
  /** Overall status derived from individual command results. */
  status: ValidationStatus;
  /** Individual command results in execution order. */
  command_results: ValidationCommandResult[];
  /** Total duration in milliseconds. */
  total_duration_ms: number;
  /** Timestamp of the run. */
  timestamp: string;
  /** Any infrastructure errors (not test failures). */
  infrastructure_errors: string[];
}

/** Stable metadata for a posted validation_packet. */
export interface ValidationPacketMeta {
  type: "validation_packet";
  prepared_by: "orchestrator";
  workflow: "expanded_isolation_with_context";
  version: 1;
  task_id: number | null;
  branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  status: ValidationStatus;
  command_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  test_commands: string[];
  command_statuses: Array<{
    command: string;
    status: "pass" | "fail" | "blocked" | "skipped";
    exit_code: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Execute a single validation command and return a structured result.
 *
 * Infrastructure failures (command not found, timeout, spawn errors) are
 * recorded as `blocked` — distinct from test `fail` — so that downstream
 * consumers can distinguish "tests ran and failed" from "could not run tests".
 */
export async function executeValidationCommand(
  command: string,
  options: {
    cwd: string;
    timeout_ms?: number;
    preview_chars?: number;
  },
): Promise<ValidationCommandResult> {
  const startTime = Date.now();
  const previewChars = options.preview_chars ?? 2000;
  const timeoutMs = options.timeout_ms ?? 120_000;

  // Split command into shell execution for flexibility with pipes, &&, etc.
  const shellArgs = process.platform === "win32"
    ? ["/c", command]
    : ["-c", command];

  try {
    const { stdout, stderr } = await execFileAsync("sh", shellArgs, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: "SIGTERM",
    });

    const durationMs = Date.now() - startTime;
    return {
      command,
      status: "pass",
      exit_code: 0,
      duration_ms: durationMs,
      stdout_preview: truncate(String(stdout ?? ""), previewChars),
      stderr_preview: truncate(String(stderr ?? ""), previewChars),
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;

    // Node throws with .code (numeric) or .status set for non-zero exit codes.
    const exitCode = typeof error.status === "number"
      ? error.status
      : typeof error.code === "number"
        ? error.code
        : null;

    // Timeout (killed) — treat as blocked, not fail.
    if (error.killed === true || (error.signal != null && error.signal !== "")) {
      return {
        command,
        status: "blocked",
        exit_code: exitCode,
        duration_ms: durationMs,
        stdout_preview: truncate(String(error.stdout ?? ""), previewChars),
        stderr_preview: truncate(String(error.stderr ?? ""), previewChars),
        error: `Command timed out after ${timeoutMs}ms (signal: ${error.signal ?? "unknown"})`,
      };
    }

    // Non-zero exit code — the command ran but tests failed.
    if (exitCode !== null) {
      return {
        command,
        status: "fail",
        exit_code: exitCode,
        duration_ms: durationMs,
        stdout_preview: truncate(String(error.stdout ?? ""), previewChars),
        stderr_preview: truncate(String(error.stderr ?? ""), previewChars),
      };
    }

    // Spawn error / command not found — infrastructure failure.
    return {
      command,
      status: "blocked",
      exit_code: null,
      duration_ms: durationMs,
      stdout_preview: "",
      stderr_preview: "",
      error: error.message ?? String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure analysis / aggregation
// ---------------------------------------------------------------------------

/**
 * Derive the overall validation status from individual command results.
 *
 * Rules:
 * - All pass → "pass"
 * - Any fail → "fail"
 * - All blocked (no pass, no fail) → "blocked"
 * - Mix of pass and blocked (no fail) → "partial"
 */
export function deriveValidationStatus(results: ValidationCommandResult[]): ValidationStatus {
  if (results.length === 0) return "blocked";

  const hasPass = results.some((r) => r.status === "pass");
  const hasFail = results.some((r) => r.status === "fail");
  const hasBlocked = results.some((r) => r.status === "blocked");

  if (hasFail) return "fail";
  if (hasBlocked && hasPass) return "partial";
  if (hasBlocked) return "blocked";
  return "pass";
}

/**
 * Run all validation commands sequentially and return the aggregated result.
 */
export async function runValidation(
  input: ValidationRunInput,
): Promise<ValidationRunResult> {
  const startTime = Date.now();
  const infrastructureErrors: string[] = [];
  const commandResults: ValidationCommandResult[] = [];

  for (const command of input.commands) {
    try {
      const result = await executeValidationCommand(command, {
        cwd: input.cwd,
        timeout_ms: input.timeout_ms,
        preview_chars: input.preview_chars,
      });
      commandResults.push(result);
    } catch (error) {
      // Unexpected error in the execution infrastructure itself.
      infrastructureErrors.push(
        `Error running '${command}': ${error instanceof Error ? error.message : String(error)}`,
      );
      commandResults.push({
        command,
        status: "blocked",
        exit_code: null,
        duration_ms: Date.now() - startTime,
        stdout_preview: "",
        stderr_preview: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    task_id: input.task_id,
    branch: input.branch,
    base_commit: input.base_commit,
    head_commit: input.head_commit,
    status: deriveValidationStatus(commandResults),
    command_results: commandResults,
    total_duration_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    infrastructure_errors: infrastructureErrors,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a validation run result as a markdown packet body for posting to
 * the Den task thread.
 */
export function formatValidationPacketMessage(result: ValidationRunResult): string {
  const lines: string[] = [
    "# Validation Packet",
    "",
    `**Status:** ${result.status}`,
    "",
  ];

  // Task/Branch context
  const contextLines: string[] = [];
  if (result.task_id !== undefined) contextLines.push(`- Task: \`#${result.task_id}\``);
  if (result.branch) contextLines.push(`- Branch: \`${result.branch}\``);
  if (result.head_commit) contextLines.push(`- Head commit: \`${result.head_commit}\``);
  if (result.base_commit) contextLines.push(`- Base commit: \`${result.base_commit}\``);
  if (contextLines.length > 0) {
    lines.push("## Context", "", ...contextLines, "");
  }

  // Summary counts
  const passCount = result.command_results.filter((r) => r.status === "pass").length;
  const failCount = result.command_results.filter((r) => r.status === "fail").length;
  const blockedCount = result.command_results.filter((r) => r.status === "blocked").length;

  lines.push("## Summary", "");
  lines.push(`- Commands: ${result.command_results.length}`);
  lines.push(`- Pass: ${passCount}`);
  lines.push(`- Fail: ${failCount}`);
  lines.push(`- Blocked: ${blockedCount}`);
  lines.push(`- Duration: ${formatDuration(result.total_duration_ms)}`);
  lines.push(`- Timestamp: ${result.timestamp}`);
  lines.push("");

  // Command results
  lines.push("## Command Results", "");
  if (result.command_results.length === 0) {
    lines.push("- No commands were executed.");
  } else {
    for (const cmd of result.command_results) {
      const statusIcon = cmd.status === "pass" ? "✅" : cmd.status === "fail" ? "❌" : "⚠️";
      const exitCodeSuffix = cmd.exit_code !== null ? ` (exit ${cmd.exit_code})` : "";
      const durationSuffix = ` (${formatDuration(cmd.duration_ms)})`;
      lines.push(`### ${statusIcon} \`${truncate(cmd.command, 120)}\``, "");
      lines.push(`- Status: **${cmd.status}**${exitCodeSuffix}${durationSuffix}`);

      if (cmd.error) {
        lines.push(`- Error: ${cmd.error}`);
      }

      if (cmd.stdout_preview) {
        lines.push("", "<details><summary>stdout preview</summary>", "");
        lines.push("```");
        lines.push(...truncate(cmd.stdout_preview, 1500).split("\n"));
        lines.push("```");
        lines.push("", "</details>", "");
      }

      if (cmd.stderr_preview) {
        lines.push("<details><summary>stderr preview</summary>", "");
        lines.push("```");
        lines.push(...truncate(cmd.stderr_preview, 1500).split("\n"));
        lines.push("```");
        lines.push("", "</details>", "");
      }

      lines.push("");
    }
  }

  // Infrastructure errors
  if (result.infrastructure_errors.length > 0) {
    lines.push("## Infrastructure Errors", "");
    lines.push("⚠️ Some commands could not be executed due to infrastructure failures (not test failures):", "");
    for (const error of result.infrastructure_errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  // Verdict note
  if (result.status === "fail") {
    lines.push("---", "", "❌ **Validation failed.** One or more test commands reported failures. Review the command results above before requesting review.", "");
  } else if (result.status === "blocked") {
    lines.push("---", "", "⚠️ **Validation blocked.** Test commands could not be executed. This is an infrastructure issue, not a test failure. Do not conflate with review approval.", "");
  } else if (result.status === "partial") {
    lines.push("---", "", "⚠️ **Validation partial.** Some commands passed but others were blocked by infrastructure issues. Review the blocked commands before requesting review.", "");
  } else {
    lines.push("---", "", "✅ **Validation passed.** All test commands succeeded.", "");
  }

  return lines.join("\n");
}

/**
 * Format a concise one-line-per-command validation summary for model-facing tool
 * results.  This is the compact alternative to `formatValidationPacketMessage`
 * which retains full detail in the posted Den packet.
 *
 * Includes:
 * - Overall status, command counts, total duration
 * - One line per command with status icon, command (truncated), duration
 * - For failed/blocked commands: a short failure note (first non-empty line of
 *   stderr or error, truncated)
 * - Message/artifact reference when available
 */
export function formatCompactValidationSummary(
  result: ValidationRunResult,
  options?: {
    message_id?: number | null;
  },
): string {
  const passCount = result.command_results.filter((r) => r.status === "pass").length;
  const failCount = result.command_results.filter((r) => r.status === "fail").length;
  const blockedCount = result.command_results.filter((r) => r.status === "blocked").length;
  const statusIcon = result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : "⚠️";

  const counts = [
    passCount > 0 ? `${passCount} pass` : undefined,
    failCount > 0 ? `${failCount} fail` : undefined,
    blockedCount > 0 ? `${blockedCount} blocked` : undefined,
  ].filter(Boolean).join(", ") || "0 pass";

  const lines: string[] = [];
  lines.push(
    `Validation: ${statusIcon} ${result.status} | ${result.command_results.length} command${result.command_results.length !== 1 ? "s" : ""} (${counts}) | ${formatDuration(result.total_duration_ms)}`,
  );

  if (options?.message_id) {
    lines.push(`Packet: message #${options.message_id}`);
  }

  // Per-command lines
  if (result.command_results.length > 0) {
    lines.push("");
    for (const cmd of result.command_results) {
      const icon = cmd.status === "pass" ? "✅" : cmd.status === "fail" ? "❌" : "⚠️";
      const cmdDisplay = truncate(cmd.command, 100);
      const exitSuffix = cmd.exit_code !== null && cmd.exit_code !== 0 ? ` exit ${cmd.exit_code}` : "";
      const durationSuffix = ` ${formatDuration(cmd.duration_ms)}`;
      let line = `${icon} \`${cmdDisplay}\` — ${cmd.status}${exitSuffix}${durationSuffix}`;

      // Short failure note for non-passing commands
      if (cmd.status !== "pass") {
        const note = classifyFailureNote(cmd);
        if (note) line += `: ${note}`;
      }

      lines.push(line);
    }
  }

  if (result.infrastructure_errors.length > 0) {
    lines.push("");
    lines.push(`⚠️ ${result.infrastructure_errors.length} infrastructure error(s).`);
  }

  lines.push("");
  if (options?.message_id) {
    lines.push("Full stdout/stderr details in the posted validation packet.");
  } else {
    lines.push("Full stdout/stderr details are available by rerunning with verbose=true; no validation packet message was posted.");
  }

  return lines.join("\n");
}

/**
 * Extract a short failure classification note from a failed/blocked command result.
 * Returns the first non-empty line of stderr or the error field, truncated to 120 chars.
 */
export function classifyFailureNote(cmd: ValidationCommandResult): string {
  // Prefer the structured error field for blocked commands.
  if (cmd.error) {
    return truncate(cmd.error, 120);
  }

  // Try stderr first line.
  if (cmd.stderr_preview) {
    const firstLine = cmd.stderr_preview.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine) return truncate(firstLine, 120);
  }

  // Try stdout as last resort.
  if (cmd.stdout_preview) {
    const firstLine = cmd.stdout_preview.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine) return truncate(firstLine, 120);
  }

  return "";
}

/**
 * Build stable metadata for a posted validation_packet.
 */
export function buildValidationPacketMeta(result: ValidationRunResult): ValidationPacketMeta {
  const passCount = result.command_results.filter((r) => r.status === "pass").length;
  const failCount = result.command_results.filter((r) => r.status === "fail").length;
  const blockedCount = result.command_results.filter((r) => r.status === "blocked").length;

  return {
    type: "validation_packet",
    prepared_by: "orchestrator",
    workflow: "expanded_isolation_with_context",
    version: 1,
    task_id: result.task_id ?? null,
    branch: result.branch ?? null,
    base_commit: result.base_commit ?? null,
    head_commit: result.head_commit ?? null,
    status: result.status,
    command_count: result.command_results.length,
    pass_count: passCount,
    fail_count: failCount,
    blocked_count: blockedCount,
    test_commands: result.command_results.map((commandResult) => commandResult.command),
    command_statuses: result.command_results.map((commandResult) => ({
      command: commandResult.command,
      status: commandResult.status,
      exit_code: commandResult.exit_code,
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export interface ParsedValidationArgs {
  task_id: number;
  cwd?: string;
  branch?: string;
  base_commit?: string;
  head_commit?: string;
  /** JSON array or newline/comma-separated list of test commands. */
  commands?: string[];
  /** Timeout per command in ms. */
  timeout_ms?: number;
  /** Don't post to Den. */
  post_result?: boolean;
  /** Return full stdout/stderr previews (tool result / CLI). */
  verbose?: boolean;
}

/**
 * Parse /den-validate CLI arguments into a structured object.
 */
export function parseValidationArgs(args: string | undefined): ParsedValidationArgs {
  const tokens = tokenizeArgList(args ?? "");
  const taskToken = tokens.shift();
  const taskId = Number(taskToken);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Usage: /den-validate <task_id> [--commands <json|text>] [--timeout <ms>] [--cwd <path>] [--branch <name>] [--base-commit <sha>] [--head-commit <sha>] [--verbose] [--no-post]");
  }

  const parsed: ParsedValidationArgs = { task_id: taskId };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--no-post") {
      parsed.post_result = false;
      continue;
    }
    if (token === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    const value = tokens[++i];
    if (!value) throw new Error(`${token} requires a value.`);
    switch (token) {
      case "--cwd": parsed.cwd = value; break;
      case "--branch": parsed.branch = value; break;
      case "--base-commit": parsed.base_commit = value; break;
      case "--head": parsed.head_commit = value; break;
      case "--head-commit": parsed.head_commit = value; break;
      case "--commands": parsed.commands = parseStringListValue(value); break;
      case "--timeout": parsed.timeout_ms = Number(value) || undefined; break;
      default: throw new Error(`Unknown validation flag: ${token}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Declared command normalization
// ---------------------------------------------------------------------------

/**
 * Normalize test lines copied from implementation/context packets into shell
 * commands that can safely be executed. Packet test sections commonly use
 * Markdown like `cmd` — pass; executing that whole line would turn the backticks
 * into shell command substitution and then try to execute the status suffix.
 */
export function normalizeDeclaredValidationCommand(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^(?:none|n\/a|not run|not-run)$/i.test(trimmed)) return undefined;

  const backtickMatch = trimmed.match(/`([^`]+)`/);
  const candidate = backtickMatch?.[1]?.trim() ?? trimmed;
  const withoutStatusSuffix = candidate
    .replace(/\s+(?:—|–)\s*(?:pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|blocked|partial|\d+\s+(?:pass(?:ed)?|fail(?:ed)?|error(?:s)?|skip(?:ped)?)\b.*)$/i, "")
    .trim();

  return withoutStatusSuffix.length > 0 ? withoutStatusSuffix : undefined;
}

/** Normalize and filter declared test command lines from packets. */
export function normalizeDeclaredValidationCommands(lines: string[] | undefined): string[] {
  return (lines ?? [])
    .map((line) => normalizeDeclaredValidationCommand(line))
    .filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... (truncated)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${remainder}s`;
}

function tokenizeArgList(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function parseStringListValue(value: string): string[] | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item: unknown) => String(item).trim()).filter(Boolean);
  } catch {
    // Fall through to delimiter parsing.
  }
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
