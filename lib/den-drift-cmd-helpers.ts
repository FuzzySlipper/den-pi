/**
 * Drift sentinel/check CLI arg parsing and suspicious hunk selection helpers.
 *
 * Extracted from the den-subagent extension for direct unit testing without
 * broadening the public extension surface.
 *
 * @module den-drift-cmd-helpers
 */

// ---------------------------------------------------------------------------
// Shared arg tokenization and list parsing
// ---------------------------------------------------------------------------

/** Tokenize a CLI argument string, respecting single/double quotes. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/** Parse a string that may be JSON array, newline-separated, or comma-separated. */
export function parseStringList(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map((item: unknown) => String(item).trim()).filter(Boolean);
  } catch {
    // Fall through to delimiter parsing.
  }
  return trimmed.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Drift sentinel CLI arg parsing
// ---------------------------------------------------------------------------

export interface ParsedDriftSentinelArgs {
  task_id: number;
  cwd?: string;
  base_ref?: string;
  base_commit?: string;
  suspicious_hunks?: string[];
  model?: string;
  tools?: string;
  post_result?: boolean;
  sessionMode?: "fresh" | "continue" | "fork" | "session";
  session?: string;
}

/** Parse /den-drift-sentinel CLI arguments into a structured object. */
export function parseDriftSentinelArgs(args: string | undefined): ParsedDriftSentinelArgs {
  const tokens = tokenizeArgs(args ?? "");
  const taskToken = tokens.shift();
  const taskId = Number(taskToken);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Usage: /den-drift-sentinel <task_id> [--base <ref>] [--base-commit <sha>] [--hunks <json|text>] [--no-post|--post-result] [--fresh|--continue|--fork <session>|--session <session>]");
  }

  const parsed: ParsedDriftSentinelArgs = { task_id: taskId };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--no-post") {
      parsed.post_result = false;
      continue;
    }
    if (token === "--post-result") {
      parsed.post_result = true;
      continue;
    }
    if (token === "--fresh") {
      parsed.sessionMode = "fresh";
      continue;
    }
    if (token === "--continue") {
      parsed.sessionMode = "continue";
      continue;
    }
    if (token === "--fork" || token === "--session") {
      const session = tokens[++i];
      if (!session) throw new Error(`${token} requires a session id or path.`);
      parsed.sessionMode = token === "--fork" ? "fork" : "session";
      parsed.session = session;
      continue;
    }
    const value = tokens[++i];
    if (!value) throw new Error(`${token} requires a value.`);
    switch (token) {
      case "--cwd": parsed.cwd = value; break;
      case "--base": parsed.base_ref = value; break;
      case "--base-ref": parsed.base_ref = value; break;
      case "--base-commit": parsed.base_commit = value; break;
      case "--hunks":
      case "--suspicious-hunks": parsed.suspicious_hunks = parseStringList(value); break;
      case "--model": parsed.model = value; break;
      case "--tools": parsed.tools = value; break;
      default: throw new Error(`Unknown drift-sentinel flag: ${token}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Drift check CLI arg parsing
// ---------------------------------------------------------------------------

export interface ParsedDriftCheckArgs {
  task_id: number;
  cwd?: string;
  base_ref?: string;
  base_commit?: string;
  branch?: string;
  head_commit?: string;
  expected_paths?: string[];
  expected_categories?: string[];
  declared_tests?: string[];
  implementation_summary?: string;
  post_result?: boolean;
}

/** Parse /den-drift-check CLI arguments into a structured object. */
export function parseDriftCheckArgs(args: string | undefined): ParsedDriftCheckArgs {
  const tokens = tokenizeArgs(args ?? "");
  const taskToken = tokens.shift();
  const taskId = Number(taskToken);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Usage: /den-drift-check <task_id> [--base <ref>] [--base-commit <sha>] [--declared-tests <text>] [--expected-paths <json|csv>] [--expected-categories <json|csv>] [--no-post]");
  }

  const parsed: ParsedDriftCheckArgs = { task_id: taskId };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--no-post") {
      parsed.post_result = false;
      continue;
    }
    const value = tokens[++i];
    if (!value) throw new Error(`${token} requires a value.`);
    switch (token) {
      case "--cwd": parsed.cwd = value; break;
      case "--base": parsed.base_ref = value; break;
      case "--base-ref": parsed.base_ref = value; break;
      case "--base-commit": parsed.base_commit = value; break;
      case "--branch": parsed.branch = value; break;
      case "--head": parsed.head_commit = value; break;
      case "--head-commit": parsed.head_commit = value; break;
      case "--expected-paths": parsed.expected_paths = parseStringList(value); break;
      case "--expected-categories": parsed.expected_categories = parseStringList(value); break;
      case "--declared-tests": parsed.declared_tests = parseStringList(value); break;
      case "--summary": parsed.implementation_summary = value; break;
      default: throw new Error(`Unknown drift-check flag: ${token}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Suspicious hunk selection helpers
// ---------------------------------------------------------------------------

const HUNK_MAX_CHARS = 2_500;

/** Determine whether a changed file path is a suspicious hunk candidate. */
export function isSuspiciousHunkCandidate(pathValue: string): boolean {
  const p = pathValue.toLowerCase();
  return p.startsWith("tests/")
    || p.includes("/tests/")
    || p.startsWith(".github/")
    || p.includes("scoring")
    || p.includes("harness")
    || p.endsWith("package.json")
    || p.endsWith("package-lock.json")
    || p.endsWith(".csproj")
    || p.endsWith(".slnx")
    || p.endsWith("agents.md");
}

/** Truncate a git hunk diff to a bounded character limit with a truncation footer. */
export function limitHunk(filePath: string, text: string): string {
  const bounded = text.length <= HUNK_MAX_CHARS ? text : `${text.slice(0, HUNK_MAX_CHARS)}\n... (truncated suspicious hunk for ${filePath})`;
  return `# ${filePath}\n${bounded}`;
}
