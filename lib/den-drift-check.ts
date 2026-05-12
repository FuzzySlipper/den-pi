/**
 * Deterministic drift check analysis for delegated coder branches.
 *
 * The pure analysis accepts collected git/task data and returns a risk packet
 * without reading full diffs. Runtime callers can collect git metadata and post
 * the formatted packet to Den.
 *
 * @module den-drift-check
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftRiskLevel = "low" | "medium" | "high";

/**
 * Expected change categories that callers can declare to reduce false-positive
 * drift noise for legitimate large, generated, fixture, or docs work.
 *
 * These categories downgrade matching signals from medium/high to low/medium
 * and mark them as expected, but do not eliminate them from the output.
 */
export const EXPECTED_CHANGE_CATEGORIES = [
  "large_ui",
  "docs",
  "fixtures",
  "generated",
  "schema",
  "config",
  "tests",
] as const;

export type ExpectedChangeCategory = typeof EXPECTED_CHANGE_CATEGORIES[number];

export interface DriftChangedPath {
  path: string;
  status?: string;
  old_path?: string;
  additions?: number;
  deletions?: number;
}

export interface DriftExpectedScope {
  /** Exact file paths or directory prefixes expected for the task. */
  paths?: string[];
  /** Glob-like path patterns using `*` and `**`. */
  globs?: string[];
  /** Human-readable hints captured from the context packet. */
  raw_hints?: string[];
  /** Expected change categories that should reduce noise for matching signals. */
  expected_change_categories?: ExpectedChangeCategory[];
}

export interface DriftCheckInput {
  task_id?: number;
  task_title?: string;
  task_intent?: string;
  implementation_summary?: string;
  branch?: string;
  base_ref?: string;
  base_commit?: string;
  head_commit?: string;
  git_status_short?: string[];
  diff_stat?: string;
  changed_paths?: DriftChangedPath[];
  declared_tests?: string[];
  expected_scope?: DriftExpectedScope;
  collection_errors?: string[];
}

export interface DriftSignal {
  code: string;
  severity: DriftRiskLevel;
  message: string;
  paths?: string[];
  /** True when this signal matches an expected change category and has been noise-reduced. */
  expected?: boolean;
}

export interface DriftScopeComparison {
  has_expected_scope: boolean;
  expected_hints: string[];
  in_scope_paths: string[];
  out_of_scope_paths: string[];
}

export interface DriftCategorySummary {
  suspicious_files: string[];
  test_or_scoring_harness_changes: string[];
  package_project_dependency_changes: string[];
  generated_files: string[];
}

export interface DriftCheckResult {
  risk: DriftRiskLevel;
  reasons: string[];
  recommendation: "proceed" | "flag-for-review";
  signals: DriftSignal[];
  scope: DriftScopeComparison;
  categories: DriftCategorySummary;
  /** Expected change categories declared for this task, used for noise reduction. */
  expected_categories: ExpectedChangeCategory[];
  changed_paths: DriftChangedPath[];
  diffstat_summary: string;
  dirty_status: string[];
  declared_tests: string[];
  branch?: string;
  base_ref?: string;
  base_commit?: string;
  head_commit?: string;
  task_id?: number;
  task_intent?: string;
  implementation_summary?: string;
  collection_errors: string[];
}

export interface DriftCheckPacketMeta {
  type: "drift_check_packet";
  prepared_by: "orchestrator";
  workflow: "expanded_isolation_with_context";
  version: 1;
  task_id: number | null;
  branch: string | null;
  base_ref: string | null;
  base_commit: string | null;
  head_commit: string | null;
  risk: DriftRiskLevel;
  signal_count: number;
  recommendation: "proceed" | "flag-for-review";
}

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

/** Analyze collected branch metadata for deterministic drift signals. */
export function analyzeDriftCheck(input: DriftCheckInput): DriftCheckResult {
  const changedPaths = normalizeChangedPaths(input.changed_paths ?? []);
  const statusLines = normalizeLines(input.git_status_short ?? []);
  const declaredTests = normalizeLines(input.declared_tests ?? []);
  const collectionErrors = normalizeLines(input.collection_errors ?? []);
  const signals: DriftSignal[] = [];

  const categories = categorizeChangedPaths(changedPaths);
  const scope = compareExpectedScope(changedPaths, input.expected_scope);

  if (collectionErrors.length > 0) {
    signals.push({
      code: "collection_error",
      severity: "high",
      message: `Failed to collect complete git metadata: ${collectionErrors.join("; ")}`,
    });
  }

  if (statusLines.length > 0) {
    signals.push({
      code: "dirty_worktree",
      severity: "high",
      message: "Working tree has uncommitted or untracked changes; review packet may not match branch head.",
      paths: statusLines.map(statusPath),
    });
  }

  if (!input.head_commit) {
    signals.push({
      code: "missing_head_commit",
      severity: "medium",
      message: "Branch head commit was not provided or collected.",
    });
  }

  if (changedPaths.length === 0 && statusLines.length === 0) {
    signals.push({
      code: "empty_diff",
      severity: "medium",
      message: "No changed paths were found against the selected base.",
    });
  }

  if (scope.has_expected_scope && scope.out_of_scope_paths.length > 0) {
    signals.push({
      code: "outside_expected_scope",
      severity: "medium",
      message: "Some changed paths do not match expected scope/path hints from the context packet.",
      paths: scope.out_of_scope_paths,
    });
  }

  if (categories.suspicious_files.length > 0) {
    signals.push({
      code: "suspicious_files",
      severity: categories.suspicious_files.some(isHighSuspicionPath) ? "high" : "medium",
      message: "Changed paths include files that commonly indicate scope drift or sensitive workflow changes.",
      paths: categories.suspicious_files,
    });
  }

  if (categories.test_or_scoring_harness_changes.length > 0) {
    const highHarnessPaths = categories.test_or_scoring_harness_changes.filter(isHighRiskHarnessPath);
    signals.push({
      code: "test_or_scoring_harness_changes",
      severity: highHarnessPaths.length > 0 ? "high" : "medium",
      message: highHarnessPaths.length > 0
        ? "Test/scoring harness or CI files changed; reviewer should confirm this was explicitly requested."
        : "Test files changed; reviewer should confirm they are legitimate coverage rather than masking behavior.",
      paths: categories.test_or_scoring_harness_changes,
    });
  }

  if (categories.package_project_dependency_changes.length > 0) {
    signals.push({
      code: "package_project_dependency_changes",
      severity: "high",
      message: "Package, project, solution, lockfile, or dependency configuration changed.",
      paths: categories.package_project_dependency_changes,
    });
  }

  if (categories.generated_files.length > 0) {
    signals.push({
      code: "generated_files",
      severity: "medium",
      message: "Generated/build artifact paths changed unexpectedly.",
      paths: categories.generated_files,
    });
  }

  if (declaredTests.length === 0) {
    signals.push({
      code: "missing_declared_tests",
      severity: "medium",
      message: "No declared tests were supplied or found in the latest implementation packet.",
    });
  } else if (declaredTests.some(looksLikeSkippedTests)) {
    signals.push({
      code: "tests_skipped_or_failed",
      severity: "high",
      message: "Declared tests mention skipped, failed, or not-run validation.",
    });
  }

  const diffSize = totalChangedLines(changedPaths);
  if (diffSize > 500) {
    signals.push({
      code: "large_diff",
      severity: "medium",
      message: `Diff changes ${diffSize} added/deleted lines; confirm size fits task intent.`,
    });
  }

  // Apply expected change category adjustments to reduce false-positive noise.
  const expectedCategories = normalizeExpectedCategories(input.expected_scope?.expected_change_categories);
  const adjustedSignals = applyExpectedCategoryAdjustments(signals, expectedCategories, changedPaths);

  const risk = maxRisk(adjustedSignals.map((s) => s.severity));
  const reasons = adjustedSignals.map((s) => {
    const prefix = s.expected ? `${s.severity} (expected)` : s.severity;
    return `${prefix}: ${s.message}`;
  });

  return {
    risk,
    reasons,
    recommendation: risk === "low" ? "proceed" : "flag-for-review",
    signals: adjustedSignals,
    scope,
    categories,
    expected_categories: expectedCategories,
    changed_paths: changedPaths,
    diffstat_summary: summarizeDiffstat(input.diff_stat, changedPaths),
    dirty_status: statusLines,
    declared_tests: declaredTests,
    branch: input.branch,
    base_ref: input.base_ref,
    base_commit: input.base_commit,
    head_commit: input.head_commit,
    task_id: input.task_id,
    task_intent: input.task_intent,
    implementation_summary: input.implementation_summary,
    collection_errors: collectionErrors,
  };
}

/** Compare changed paths against optional expected scope hints. */
export function compareExpectedScope(
  changedPaths: DriftChangedPath[],
  expectedScope?: DriftExpectedScope,
): DriftScopeComparison {
  const hints = normalizeExpectedHints(expectedScope);
  const nChangedPaths = normalizeChangedPaths(changedPaths);
  if (hints.paths.length === 0 && hints.globs.length === 0) {
    return {
      has_expected_scope: false,
      expected_hints: hints.raw,
      in_scope_paths: [],
      out_of_scope_paths: [],
    };
  }

  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const entry of nChangedPaths) {
    const changedPath = entry.path;
    // Check path first, then old_path for renames.
    // A rename should be considered in-scope if either the source or
    // destination matches expected scope.
    if (matchesExpectedPath(changedPath, hints.paths, hints.globs)) {
      inScope.push(changedPath);
    } else if (entry.old_path && matchesExpectedPath(entry.old_path, hints.paths, hints.globs)) {
      inScope.push(changedPath);
    } else {
      outOfScope.push(changedPath);
    }
  }

  return {
    has_expected_scope: true,
    expected_hints: hints.raw,
    in_scope_paths: inScope,
    out_of_scope_paths: outOfScope,
  };
}

/** Categorize changed paths into deterministic risk buckets. */
export function categorizeChangedPaths(changedPaths: DriftChangedPath[]): DriftCategorySummary {
  const paths = normalizeChangedPaths(changedPaths).map((p) => p.path);
  return {
    suspicious_files: unique(paths.filter(isSuspiciousPath)),
    test_or_scoring_harness_changes: unique(paths.filter(isTestOrScoringHarnessPath)),
    package_project_dependency_changes: unique(paths.filter(isPackageProjectDependencyPath)),
    generated_files: unique(paths.filter(isGeneratedPath)),
  };
}

// ---------------------------------------------------------------------------
// Formatting / metadata
// ---------------------------------------------------------------------------

/** Format a drift check result as a Den task-thread packet. */
export function formatDriftCheckPacketMessage(result: DriftCheckResult): string {
  const lines: string[] = [
    "# Drift Check Packet",
    "",
    `**Risk:** ${result.risk}`,
    `**Recommendation:** ${result.recommendation}`,
    "",
  ];

  const taskLines: string[] = [];
  if (result.task_id !== undefined) taskLines.push(`- Task: \`#${result.task_id}\``);
  if (result.task_intent) taskLines.push(`- Task intent: ${result.task_intent}`);
  if (result.implementation_summary) taskLines.push(`- Implementation summary: ${result.implementation_summary}`);
  if (taskLines.length > 0) {
    lines.push("## Task", "", ...taskLines, "");
  }

  lines.push("## Branch and Base", "");
  lines.push(`- Branch: ${result.branch ? `\`${result.branch}\`` : "(unknown)"}`);
  lines.push(`- Head commit: ${result.head_commit ? `\`${result.head_commit}\`` : "(unknown)"}`);
  lines.push(`- Base ref: ${result.base_ref ? `\`${result.base_ref}\`` : "(unknown)"}`);
  if (result.base_commit) lines.push(`- Base commit: \`${result.base_commit}\``);
  lines.push("");

  lines.push("## Drift Signals Found", "");
  if (result.signals.length === 0) {
    lines.push("- None.");
  } else {
    for (const signal of result.signals) {
      const pathSuffix = signal.paths && signal.paths.length > 0 ? ` (${signal.paths.join(", ")})` : "";
      const expectedTag = signal.expected ? " *(expected)*" : "";
      lines.push(`- **${signal.severity}** \`${signal.code}\`${expectedTag}: ${signal.message}${pathSuffix}`);
    }
  }
  lines.push("");

  lines.push("## Scope Check", "");
  lines.push(`- Expected scope hints present: ${result.scope.has_expected_scope ? "yes" : "no"}`);
  if (result.scope.expected_hints.length > 0) lines.push(`- Expected hints: ${result.scope.expected_hints.map((h) => `\`${h}\``).join(", ")}`);
  lines.push(`- In-scope changed paths: ${result.scope.in_scope_paths.length}`);
  lines.push(`- Out-of-scope changed paths: ${result.scope.out_of_scope_paths.length}`);
  for (const p of result.scope.out_of_scope_paths) lines.push(`  - \`${p}\``);
  lines.push("");

  if (result.expected_categories.length > 0) {
    lines.push("## Expected Change Categories", "");
    for (const cat of result.expected_categories) {
      lines.push(`- \`${cat}\`: ${expectedCategoryDescription(cat)}`);
    }
    lines.push("- Expected does not mean automatically approved; reviewer should still confirm scope.", "");
  }

  lines.push("## Changed Paths", "");
  if (result.changed_paths.length === 0) {
    lines.push("- None.");
  } else {
    for (const p of result.changed_paths) {
      const status = p.status ? `${p.status} ` : "";
      const counts = p.additions !== undefined || p.deletions !== undefined ? ` (+${p.additions ?? 0}/-${p.deletions ?? 0})` : "";
      const oldPath = p.old_path ? ` from \`${p.old_path}\`` : "";
      lines.push(`- ${status}\`${p.path}\`${oldPath}${counts}`);
    }
  }
  lines.push("");

  lines.push("## Diffstat Summary", "", result.diffstat_summary || "(none)", "");

  lines.push("## Dirty Status", "");
  if (result.dirty_status.length === 0) lines.push("- Clean.");
  else for (const line of result.dirty_status) lines.push(`- \`${line}\``);
  lines.push("");

  lines.push("## Suspicious Categories", "");
  appendCategory(lines, "Suspicious files", result.categories.suspicious_files);
  appendCategory(lines, "Test/scoring harness changes", result.categories.test_or_scoring_harness_changes);
  appendCategory(lines, "Package/project/dependency changes", result.categories.package_project_dependency_changes);
  appendCategory(lines, "Generated files", result.categories.generated_files);
  lines.push("");

  lines.push("## Declared Tests", "");
  if (result.declared_tests.length === 0) lines.push("- None declared/found.");
  else for (const test of result.declared_tests) lines.push(`- ${test}`);
  lines.push("");

  if (result.collection_errors.length > 0) {
    lines.push("## Collection Errors", "");
    for (const error of result.collection_errors) lines.push(`- ${error}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Build stable metadata for a posted drift_check_packet. */
export function buildDriftCheckPacketMeta(result: DriftCheckResult): DriftCheckPacketMeta {
  return {
    type: "drift_check_packet",
    prepared_by: "orchestrator",
    workflow: "expanded_isolation_with_context",
    version: 1,
    task_id: result.task_id ?? null,
    branch: result.branch ?? null,
    base_ref: result.base_ref ?? null,
    base_commit: result.base_commit ?? null,
    head_commit: result.head_commit ?? null,
    risk: result.risk,
    signal_count: result.signals.length,
    recommendation: result.recommendation,
  };
}

// ---------------------------------------------------------------------------
// Context / implementation packet parsing helpers
// ---------------------------------------------------------------------------

/** Extract expected path/scope hints from a coder_context_packet body. */
export function extractExpectedScopeFromContextPacket(content: string): DriftExpectedScope {
  const raw = new Set<string>();
  const paths = new Set<string>();
  const globs = new Set<string>();
  const scopeSections = extractScopeHintSections(content);
  const searchContent = scopeSections.length > 0 ? scopeSections.join("\n") : content;

  for (const value of extractBacktickValues(searchContent)) {
    const cleaned = cleanHint(value);
    if (!cleaned || !looksLikePathHint(cleaned)) continue;
    raw.add(cleaned);
    if (cleaned.includes("*")) globs.add(cleaned);
    else paths.add(cleaned);
  }

  // Also catch bullet-list paths that may not be wrapped in backticks.
  for (const line of searchContent.split("\n")) {
    const bullet = line.trim().match(/^[-*]\s+([^—:]+)(?:\s+[—:].*)?$/);
    if (!bullet) continue;
    const cleaned = cleanHint(bullet[1]);
    if (!cleaned || !looksLikePathHint(cleaned)) continue;
    raw.add(cleaned);
    if (cleaned.includes("*")) globs.add(cleaned);
    else paths.add(cleaned);
  }

  // Extract expected change categories from a dedicated section or constraints.
  const categories = extractExpectedChangeCategories(content);

  return {
    paths: [...paths],
    globs: [...globs],
    raw_hints: [...raw],
    ...(categories.length > 0 ? { expected_change_categories: categories } : {}),
  };
}

/** Extract declared test lines/commands from an implementation packet body. */
export function extractDeclaredTestsFromImplementationPacket(content: string): string[] {
  const section = extractMarkdownSection(content, /tests?\s+run(?:\s+with[^\n]*)?/i);
  if (!section) return [];
  const tests = parseListOrLines(section);
  return tests.length > 0 ? tests : [section.trim()];
}

/** Extract a compact task intent from task/context text. */
export function extractTaskIntentFromContextPacket(content: string): string | undefined {
  const userIntent = extractMarkdownSection(content, /user\s+intent/i);
  if (userIntent) return firstNonEmptyLine(userIntent);
  const taskDescription = extractMarkdownSection(content, /task\s+description/i);
  if (taskDescription) return firstNonEmptyLine(taskDescription);
  return undefined;
}

// ---------------------------------------------------------------------------
// Git collection
// ---------------------------------------------------------------------------

/** Collect drift-check git metadata from a working tree. */
export async function collectGitDriftCheckInput(options: {
  cwd: string;
  task_id?: number;
  task_title?: string;
  task_intent?: string;
  implementation_summary?: string;
  base_ref?: string;
  base_commit?: string;
  declared_tests?: string[];
  expected_scope?: DriftExpectedScope;
}): Promise<DriftCheckInput> {
  const errors: string[] = [];
  const baseRef = options.base_ref ?? options.base_commit ?? "main";

  const status = await gitLines(options.cwd, ["status", "--short"], errors);
  const branch = await gitText(options.cwd, ["branch", "--show-current"], errors);
  const head = await gitText(options.cwd, ["rev-parse", "HEAD"], errors);
  const diffStat = await gitText(options.cwd, ["diff", "--stat", `${baseRef}...HEAD`], errors);
  const nameStatus = await gitLines(options.cwd, ["diff", "--name-status", "--find-renames", `${baseRef}...HEAD`], errors);
  const numstat = await gitLines(options.cwd, ["diff", "--numstat", `${baseRef}...HEAD`], errors);

  const changedPaths = mergeNameStatusAndNumstat(nameStatus, numstat);

  return {
    task_id: options.task_id,
    task_title: options.task_title,
    task_intent: options.task_intent,
    implementation_summary: options.implementation_summary,
    branch,
    base_ref: baseRef,
    base_commit: options.base_commit,
    head_commit: head,
    git_status_short: status,
    diff_stat: diffStat,
    changed_paths: changedPaths,
    declared_tests: options.declared_tests,
    expected_scope: options.expected_scope,
    collection_errors: errors,
  };
}

// ---------------------------------------------------------------------------
// Expected change category extraction from context packets
// ---------------------------------------------------------------------------

/** Extract expected change categories from context packet sections. */
export function extractExpectedChangeCategories(content: string): ExpectedChangeCategory[] {
  const valid = new Set(EXPECTED_CHANGE_CATEGORIES);
  const categories: ExpectedChangeCategory[] = [];

  // Look for a dedicated "Expected change categories" section.
  const section = extractMarkdownSection(content, /expected\s+change\s+categories?|expected\s+categories?/i);
  if (section) {
    for (const value of extractBacktickValues(section)) {
      const cleaned = value.trim().toLowerCase();
      if (valid.has(cleaned as ExpectedChangeCategory)) {
        categories.push(cleaned as ExpectedChangeCategory);
      }
    }
    // Also parse bullet-list items without backticks.
    for (const line of section.split("\n")) {
      const bullet = line.trim().match(/^[-*]\s+([a-z_]+)/i);
      if (bullet) {
        const cleaned = bullet[1].toLowerCase();
        if (valid.has(cleaned as ExpectedChangeCategory)) {
          categories.push(cleaned as ExpectedChangeCategory);
        }
      }
    }
  }

  // Also look in constraints section for backticked category references.
  if (categories.length === 0) {
    const constraints = extractMarkdownSection(content, /constraints|scope\s+boundaries/i);
    if (constraints) {
      for (const value of extractBacktickValues(constraints)) {
        const cleaned = value.trim().toLowerCase();
        if (valid.has(cleaned as ExpectedChangeCategory)) {
          categories.push(cleaned as ExpectedChangeCategory);
        }
      }
    }
  }

  return unique(categories) as ExpectedChangeCategory[];
}

/** Human-readable description for an expected change category. */
function expectedCategoryDescription(category: ExpectedChangeCategory): string {
  switch (category) {
    case "large_ui": return "Large UI/template/front-end changes expected per task scope.";
    case "docs": return "Documentation changes expected per task scope.";
    case "fixtures": return "Test fixture or snapshot updates expected per task scope.";
    case "generated": return "Generated code or artifact updates expected per task scope.";
    case "schema": return "Schema or migration changes expected per task scope.";
    case "config": return "Package/project/dependency configuration changes expected per task scope.";
    case "tests": return "Test file changes expected per task scope.";
  }
}

// ---------------------------------------------------------------------------
// Expected change category adjustments
// ---------------------------------------------------------------------------

/** Normalize and validate expected change categories. */
function normalizeExpectedCategories(categories: ExpectedChangeCategory[] | undefined): ExpectedChangeCategory[] {
  if (!Array.isArray(categories)) return [];
  const valid = new Set(EXPECTED_CHANGE_CATEGORIES);
  return unique(categories.filter((c) => valid.has(c))) as ExpectedChangeCategory[];
}

/** Apply expected change category adjustments to drift signals. */
/** Signal codes that must never have their severity reduced by expected categories. */
const BLOCKING_SIGNAL_CODES: ReadonlySet<string> = new Set([
  "tests_skipped_or_failed",
  "outside_expected_scope",
  "collection_error",
  "dirty_worktree",
  "missing_head_commit",
]);

export function applyExpectedCategoryAdjustments(
  signals: DriftSignal[],
  categories: ExpectedChangeCategory[],
  changedPaths: DriftChangedPath[],
): DriftSignal[] {
  if (categories.length === 0) return signals;
  const catSet = new Set(categories);

  return signals.map((signal) => {
    if (signal.expected) return signal;

    // Blocking signals are never severity-reduced; they can only be marked expected.
    if (BLOCKING_SIGNAL_CODES.has(signal.code)) return signal;

    switch (signal.code) {
      case "large_diff": {
        if (catSet.has("large_ui") || catSet.has("docs")) {
          return {
            ...signal,
            severity: "low",
            expected: true,
            message: `${signal.message} Expected per task scope.`,
          };
        }
        break;
      }

      case "generated_files": {
        const hasGenerated = catSet.has("generated");
        const hasFixtures = catSet.has("fixtures");
        if (hasGenerated && hasFixtures) {
          return {
            ...signal,
            severity: "low",
            expected: true,
            message: `${signal.message} Expected per task scope.`,
          };
        }
        if (hasFixtures) {
          // Only downgrade when ALL paths are fixture-like and none are high-risk harness.
          const paths = signal.paths ?? [];
          const allFixtures = paths.length > 0 && paths.every((p) => isFixturePath(p));
          const anyHighRisk = paths.some((p) => isHighRiskHarnessPath(p));
          if (allFixtures && !anyHighRisk) {
            return {
              ...signal,
              severity: "low",
              expected: true,
              message: `${signal.message} Fixture/snapshot changes expected per task scope.`,
            };
          }
        }
        if (hasGenerated) {
          return {
            ...signal,
            severity: "low",
            expected: true,
            message: `${signal.message} Generated file changes expected per task scope.`,
          };
        }
        break;
      }

      case "suspicious_files": {
        if (catSet.has("schema")) {
          const paths = signal.paths ?? [];
          const allSchema = paths.length > 0 && paths.every((p) => isSchemaRelatedPath(p));
          if (allSchema) {
            return {
              ...signal,
              expected: true,
              message: `${signal.message} Schema changes expected per task scope; reviewer should still confirm scope.`,
            };
          }
        }
        break;
      }

      case "test_or_scoring_harness_changes": {
        if (catSet.has("tests")) {
          if (signal.severity === "high") {
            // High-risk harness changes keep high severity; only mark expected.
            return {
              ...signal,
              severity: "high",
              expected: true,
              message: `${signal.message} Test harness changes expected per task scope; reviewer should confirm.`,
            };
          }
          return {
            ...signal,
            severity: "low",
            expected: true,
            message: `${signal.message} Test changes expected per task scope.`,
          };
        }
        // Handle fixtures expected category for fixture-like test files.
        // Only downgrade when ALL signal paths are fixture-like and none are high-risk.
        if (catSet.has("fixtures")) {
          const paths = signal.paths ?? [];
          const allFixtures = paths.length > 0 && paths.every((p) => isFixturePath(p));
          const anyHighRisk = paths.some((p) => isHighRiskHarnessPath(p));
          if (allFixtures && !anyHighRisk) {
            return {
              ...signal,
              severity: "low",
              expected: true,
              message: `${signal.message} Fixture changes expected per task scope.`,
            };
          }
        }
        break;
      }

      case "package_project_dependency_changes": {
        if (catSet.has("config")) {
          // Package/project/dependency changes keep high severity; only mark expected.
          return {
            ...signal,
            severity: "high",
            expected: true,
            message: `${signal.message} Dependency/config changes expected per task scope; reviewer should confirm.`,
          };
        }
        break;
      }
    }

    return signal;
  });
}

/** Check if a path looks like a test fixture or snapshot file. */
function isFixturePath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return p.includes("/fixtures/")
    || p.includes("/__fixtures__/")
    || p.includes("/__snapshots__/")
    || p.endsWith(".snap")
    || /\.fixture\./.test(p);
}

/** Check if a path is schema-related (migrations, schema dirs). */
function isSchemaRelatedPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return /(^|\/)migrations?\//.test(p)
    || /(^|\/)schemas?\//.test(p)
    || p.includes("schema");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeChangedPaths(paths: DriftChangedPath[]): DriftChangedPath[] {
  return paths
    .map((entry) => ({
      ...entry,
      path: normalizePath(entry.path),
      old_path: entry.old_path ? normalizePath(entry.old_path) : undefined,
    }))
    .filter((entry) => entry.path.length > 0);
}

function normalizeLines(lines: string[] | string): string[] {
  const raw = Array.isArray(lines) ? lines : lines.split("\n");
  return raw.map((line) => line.trim()).filter(Boolean);
}

function normalizePath(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
}

function statusPath(statusLine: string): string {
  return normalizePath(statusLine.slice(3).trim() || statusLine.trim());
}

function normalizeExpectedHints(scope?: DriftExpectedScope): { paths: string[]; globs: string[]; raw: string[] } {
  const rawPaths = unique((scope?.paths ?? []).map(cleanHint).filter(Boolean));
  const rawGlobs = unique((scope?.globs ?? []).map(cleanHint).filter(Boolean));

  // Move glob-like patterns (containing *) from paths into globs so they are
  // matched with globToRegExp instead of literal/directory-prefix comparison.
  // This handles cases like docs/** or tests/PiExtension.Tests/** passed via
  // --expected-paths without requiring the caller to separate globs manually.
  const paths: string[] = [];
  const globs: string[] = [...rawGlobs];
  for (const hint of rawPaths) {
    if (hint.includes("*")) globs.push(hint);
    else paths.push(hint);
  }

  const raw = unique([...(scope?.raw_hints ?? []), ...paths, ...globs].map(cleanHint).filter(Boolean));
  return { paths: unique(paths), globs: unique(globs), raw };
}

function matchesExpectedPath(changedPath: string, paths: string[], globs: string[]): boolean {
  const p = normalizePath(changedPath);
  for (const hint of paths) {
    const h = normalizePath(hint);
    if (p === h) return true;
    if (h.endsWith("/") && p.startsWith(h)) return true;
    if (!hasFileExtension(h) && p.startsWith(`${h}/`)) return true;
  }
  return globs.some((glob) => globToRegExp(normalizePath(glob)).test(p));
}

function hasFileExtension(pathValue: string): boolean {
  const last = pathValue.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last);
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else {
      pattern += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maxRisk(risks: DriftRiskLevel[]): DriftRiskLevel {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function totalChangedLines(paths: DriftChangedPath[]): number {
  return paths.reduce((sum, p) => sum + (p.additions ?? 0) + (p.deletions ?? 0), 0);
}

function summarizeDiffstat(diffStat: string | undefined, paths: DriftChangedPath[]): string {
  const trimmed = (diffStat ?? "").trim();
  if (trimmed) return trimmed;
  if (paths.length === 0) return "";
  const additions = paths.reduce((sum, p) => sum + (p.additions ?? 0), 0);
  const deletions = paths.reduce((sum, p) => sum + (p.deletions ?? 0), 0);
  return `${paths.length} files changed, ${additions} insertions(+), ${deletions} deletions(-)`;
}

function looksLikeSkippedTests(value: string): boolean {
  const v = value.toLowerCase();
  if (/\b(not\s+run|did\s+not\s+run|error|blocked)\b/.test(v)) return true;
  if (/\bfail(?:ed|ure)?\b/.test(v) && !/\b0\s+fail(?:ed|ures?)?\b/.test(v)) return true;
  if (/\bskip(?:ped)?\b/.test(v) && !/\b0\s+skip(?:ped)?\b/.test(v) && !/\bno\s+skips?\b/.test(v)) return true;
  return false;
}

function isSuspiciousPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return p === "agents.md"
    || p.endsWith("/agents.md")
    || p === "deploy-cli.sh"
    || p.includes("/.github/")
    || p.startsWith(".github/")
    || p.includes("secret")
    || p.includes("credential")
    || p.endsWith(".env")
    || p.includes("/.env")
    || /(^|\/)migrations?\//.test(p)
    || /(^|\/)schema(s)?\//.test(p)
    || p.includes("scoring")
    || p.includes("scorecard");
}

function isHighSuspicionPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return p === "agents.md"
    || p.endsWith("/agents.md")
    || p === "deploy-cli.sh"
    || p.includes("/.github/")
    || p.startsWith(".github/")
    || p.includes("secret")
    || p.includes("credential")
    || p.endsWith(".env")
    || p.includes("/.env");
}

function isTestOrScoringHarnessPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return p.startsWith("tests/")
    || p.includes("/tests/")
    || p.endsWith(".test.mjs")
    || p.endsWith(".test.ts")
    || p.endsWith(".spec.ts")
    || p.includes("scoring")
    || p.includes("scorecard")
    || p.includes("harness")
    || p.includes("test-harness")
    || isHighRiskHarnessPath(p);
}

function isHighRiskHarnessPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  return p.startsWith(".github/")
    || p.includes("/.github/")
    || p.includes("scoring")
    || p.includes("scorecard")
    || p.includes("test-harness")
    || p.endsWith("vitest.config.ts")
    || p.endsWith("jest.config.js")
    || p.endsWith("playwright.config.ts")
    || p.endsWith("pytest.ini")
    || p.endsWith(".runsettings");
}

function isPackageProjectDependencyPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  const name = p.split("/").pop() ?? p;
  return name === "package.json"
    || name === "package-lock.json"
    || name === "pnpm-lock.yaml"
    || name === "yarn.lock"
    || name === "bun.lockb"
    || name === "go.mod"
    || name === "go.sum"
    || name === "cargo.toml"
    || name === "cargo.lock"
    || name === "pyproject.toml"
    || name === "poetry.lock"
    || name === "requirements.txt"
    || name === "global.json"
    || name === "nuget.config"
    || name === "directory.packages.props"
    || name === "directory.build.props"
    || name === "directory.build.targets"
    || p.endsWith(".csproj")
    || p.endsWith(".fsproj")
    || p.endsWith(".vbproj")
    || p.endsWith(".sln")
    || p.endsWith(".slnx");
}

function isGeneratedPath(pathValue: string): boolean {
  const p = normalizePath(pathValue).toLowerCase();
  const name = p.split("/").pop() ?? p;
  return p.includes("/generated/")
    || p.includes("/gen/")
    || p.includes("/dist/")
    || p.includes("/build/")
    || p.includes("/bin/")
    || p.includes("/obj/")
    || p.startsWith("dist/")
    || p.startsWith("build/")
    || name.endsWith(".g.cs")
    || name.endsWith(".designer.cs")
    || name.endsWith(".generated.ts")
    || name.endsWith(".generated.js")
    || name.endsWith(".min.js")
    || name.endsWith(".snap");
}

function appendCategory(lines: string[], label: string, paths: string[]) {
  lines.push(`- ${label}: ${paths.length === 0 ? "none" : paths.map((p) => `\`${p}\``).join(", ")}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractBacktickValues(content: string): string[] {
  const values: string[] = [];
  const regex = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) values.push(match[1]);
  return values;
}

function cleanHint(value: string): string {
  return value.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, "").replace(/^\.\//, "");
}

function looksLikePathHint(value: string): boolean {
  const v = value.trim();
  if (!v || v.includes("\n") || v.includes(" ")) return false;
  if (v.startsWith("/") || v.startsWith("task/")) return false;
  if (/^#?\d+$/.test(v)) return false;
  if (/^[0-9a-f]{7,40}$/i.test(v)) return false;
  if (/^[a-z]+:\/\//i.test(v) || v.startsWith("doc:")) return false;
  if (v.includes("...")) return false;

  const commonRepoPrefix = /^(src|tests|test|pi-dev|docs|scripts|\.github|config|tools)\//.test(v);
  return commonRepoPrefix || v.endsWith("/") || /\.[A-Za-z0-9*]+$/.test(v) || v.includes("*");
}

function extractScopeHintSections(content: string): string[] {
  const sections = extractMarkdownSections(content, /(?:scope|file\s+pointers|relevant\s+files|expected\s+paths?|changed\s+paths?|likely\s+files|implementation\s+scope)/i);
  return sections.filter((section) => section.trim().length > 0);
}

function extractMarkdownSection(content: string, heading: RegExp): string | undefined {
  return extractMarkdownSections(content, heading)[0];
}

function extractMarkdownSections(content: string, heading: RegExp): string[] {
  const sections: string[] = [];
  const headingRegex = /^#{1,6}\s+([^\n]+)/gmi;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    if (!heading.test(match[1])) continue;
    const start = headingRegex.lastIndex;
    const rest = content.slice(start);
    const next = rest.match(/\n#{1,6}\s+/m);
    const section = next ? rest.slice(0, next.index) : rest;
    const trimmed = section.trim();
    if (trimmed) sections.push(trimmed);
  }
  return sections;
}

function parseListOrLines(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    items.push(bullet ? bullet[1].trim() : trimmed);
  }
  return items;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split("\n").map((line) => line.trim()).find(Boolean);
}

function mergeNameStatusAndNumstat(nameStatus: string[], numstat: string[]): DriftChangedPath[] {
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of numstat) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? undefined : Number(parts[0]);
    const deletions = parts[1] === "-" ? undefined : Number(parts[1]);
    const pathValue = normalizePath(parts[parts.length - 1]);
    counts.set(pathValue, {
      additions: Number.isFinite(additions) ? additions : undefined,
      deletions: Number.isFinite(deletions) ? deletions : undefined,
    });
  }

  const paths: DriftChangedPath[] = [];
  for (const line of nameStatus) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0];
    const pathValue = normalizePath(parts[parts.length - 1]);
    const oldPath = parts.length > 2 ? normalizePath(parts[1]) : undefined;
    paths.push({
      status,
      path: pathValue,
      old_path: oldPath && oldPath !== pathValue ? oldPath : undefined,
      ...counts.get(pathValue),
    });
  }
  return paths;
}

async function gitText(cwd: string, args: string[], errors: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    const text = String(stdout).trim();
    return text || undefined;
  } catch (error) {
    errors.push(`git ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function gitLines(cwd: string, args: string[], errors: string[]): Promise<string[]> {
  const text = await gitText(cwd, args, errors);
  return text ? normalizeLines(text) : [];
}
