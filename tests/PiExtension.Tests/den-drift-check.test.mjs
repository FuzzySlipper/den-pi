import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeDriftCheck,
  categorizeChangedPaths,
  compareExpectedScope,
  extractDeclaredTestsFromImplementationPacket,
  extractExpectedScopeFromContextPacket,
  extractExpectedChangeCategories,
  extractTaskIntentFromContextPacket,
  formatDriftCheckPacketMessage,
  buildDriftCheckPacketMeta,
  applyExpectedCategoryAdjustments,
  EXPECTED_CHANGE_CATEGORIES,
} from '../../lib/den-drift-check.ts';

test('analyzeDriftCheck keeps scoped source/test changes at medium risk with declared tests', () => {
  const result = analyzeDriftCheck({
    task_id: 937,
    branch: 'task/937-drift-check',
    head_commit: 'abc1234',
    base_ref: 'main',
    changed_paths: [
      { status: 'A', path: 'pi-dev/lib/den-drift-check.ts', additions: 200, deletions: 0 },
      { status: 'A', path: 'tests/PiExtension.Tests/den-drift-check.test.mjs', additions: 80, deletions: 0 },
    ],
    expected_scope: {
      paths: ['pi-dev/lib/den-drift-check.ts', 'tests/PiExtension.Tests/den-drift-check.test.mjs'],
    },
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — pass'],
  });

  // Test file changes are intentionally surfaced, but they should not become
  // high-risk when the harness itself was not changed.
  assert.equal(result.risk, 'medium');
  assert.equal(result.recommendation, 'flag-for-review');
  assert.deepEqual(result.scope.out_of_scope_paths, []);
  assert.ok(result.signals.some((s) => s.code === 'test_or_scoring_harness_changes'));
  assert.ok(!result.signals.some((s) => s.code === 'missing_declared_tests'));
});

test('analyzeDriftCheck flags paths outside expected context scope', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'pi-dev/lib/den-drift-check.ts', additions: 10, deletions: 2 },
      { status: 'M', path: 'src/DenMcp.Server/Program.cs', additions: 20, deletions: 1 },
    ],
    expected_scope: { paths: ['pi-dev/lib/den-drift-check.ts'] },
    declared_tests: ['unit tests pass'],
  });

  assert.equal(result.risk, 'medium');
  assert.deepEqual(result.scope.out_of_scope_paths, ['src/DenMcp.Server/Program.cs']);
  assert.ok(result.signals.some((s) => s.code === 'outside_expected_scope'));
});

test('analyzeDriftCheck raises high risk for package/project/dependency and CI harness changes', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'package.json', additions: 1, deletions: 1 },
      { status: 'M', path: '.github/workflows/ci.yml', additions: 5, deletions: 0 },
      { status: 'M', path: 'tests/scoring/harness.ts', additions: 5, deletions: 5 },
    ],
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — pass'],
  });

  assert.equal(result.risk, 'high');
  assert.ok(result.signals.some((s) => s.code === 'package_project_dependency_changes' && s.severity === 'high'));
  assert.ok(result.signals.some((s) => s.code === 'test_or_scoring_harness_changes' && s.severity === 'high'));
  assert.ok(result.categories.package_project_dependency_changes.includes('package.json'));
});

test('analyzeDriftCheck raises high risk for dirty worktree status but does not block', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    git_status_short: [' M pi-dev/extensions/den-subagent.ts', '?? scratch.txt'],
    changed_paths: [{ status: 'M', path: 'pi-dev/extensions/den-subagent.ts', additions: 8, deletions: 1 }],
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — pass'],
  });

  assert.equal(result.risk, 'high');
  assert.equal(result.recommendation, 'flag-for-review');
  assert.ok(result.signals.some((s) => s.code === 'dirty_worktree'));
});

test('analyzeDriftCheck treats zero fail/skip declared tests as passing', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'pi-dev/lib/den-drift-check.ts', additions: 10, deletions: 1 }],
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — 11 pass, 0 fail, 0 skip'],
  });

  assert.equal(result.risk, 'low');
  assert.ok(!result.signals.some((s) => s.code === 'tests_skipped_or_failed'));
});

test('analyzeDriftCheck flags generated files and skipped or failed declared tests', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'A', path: 'dist/generated/client.min.js', additions: 1000, deletions: 0 }],
    declared_tests: ['Tests not run because build is blocked'],
  });

  assert.equal(result.risk, 'high');
  assert.ok(result.signals.some((s) => s.code === 'generated_files'));
  assert.ok(result.signals.some((s) => s.code === 'tests_skipped_or_failed'));
});

test('categorizeChangedPaths identifies representative suspicious path cases', () => {
  const categories = categorizeChangedPaths([
    { path: 'AGENTS.md' },
    { path: 'deploy-cli.sh' },
    { path: 'src/DenMcp.Core/DenMcp.Core.csproj' },
    { path: 'tests/PiExtension.Tests/example.test.mjs' },
    { path: 'src/generated/model.g.cs' },
  ]);

  assert.deepEqual(categories.suspicious_files, ['AGENTS.md', 'deploy-cli.sh']);
  assert.deepEqual(categories.package_project_dependency_changes, ['src/DenMcp.Core/DenMcp.Core.csproj']);
  assert.deepEqual(categories.test_or_scoring_harness_changes, ['tests/PiExtension.Tests/example.test.mjs']);
  assert.deepEqual(categories.generated_files, ['src/generated/model.g.cs']);
});

test('compareExpectedScope supports exact paths, directory prefixes, and globs', () => {
  const comparison = compareExpectedScope([
    { path: 'pi-dev/lib/den-drift-check.ts' },
    { path: 'tests/PiExtension.Tests/den-drift-check.test.mjs' },
    { path: 'docs/out-of-scope.md' },
  ], {
    paths: ['pi-dev/lib/den-drift-check.ts', 'tests/PiExtension.Tests/'],
    globs: ['pi-dev/extensions/*.ts'],
  });

  assert.equal(comparison.has_expected_scope, true);
  assert.deepEqual(comparison.in_scope_paths, [
    'pi-dev/lib/den-drift-check.ts',
    'tests/PiExtension.Tests/den-drift-check.test.mjs',
  ]);
  assert.deepEqual(comparison.out_of_scope_paths, ['docs/out-of-scope.md']);
});

// ---------------------------------------------------------------------------
// Directory glob hints in paths array — regression for #1124
// ---------------------------------------------------------------------------

test('compareExpectedScope matches directory globs in paths array (docs/**)', () => {
  const comparison = compareExpectedScope([
    { path: 'docs/pi-orchestrator-context-status.md' },
    { path: 'docs/api/spec.md' },
    { path: 'src/lib/foo.ts' },
  ], {
    paths: ['docs/**'],
  });

  assert.equal(comparison.has_expected_scope, true);
  assert.deepEqual(comparison.in_scope_paths, [
    'docs/pi-orchestrator-context-status.md',
    'docs/api/spec.md',
  ]);
  assert.deepEqual(comparison.out_of_scope_paths, ['src/lib/foo.ts']);
});

test('compareExpectedScope matches directory globs in paths array (tests/**)', () => {
  const comparison = compareExpectedScope([
    { path: 'tests/PiExtension.Tests/den-drift-check.test.mjs' },
    { path: 'tests/PiExtension.Tests/subdir/helper.mjs' },
    { path: 'src/lib/foo.ts' },
  ], {
    paths: ['tests/PiExtension.Tests/**'],
  });

  assert.equal(comparison.has_expected_scope, true);
  assert.deepEqual(comparison.in_scope_paths, [
    'tests/PiExtension.Tests/den-drift-check.test.mjs',
    'tests/PiExtension.Tests/subdir/helper.mjs',
  ]);
  assert.deepEqual(comparison.out_of_scope_paths, ['src/lib/foo.ts']);
});

test('compareExpectedScope matches mixed exact paths and globs in paths array', () => {
  const comparison = compareExpectedScope([
    { path: 'pi-dev/lib/den-drift-check.ts' },
    { path: 'docs/readme.md' },
    { path: 'docs/api/spec.md' },
    { path: 'src/unexpected.ts' },
  ], {
    paths: ['pi-dev/lib/den-drift-check.ts', 'docs/**'],
  });

  assert.equal(comparison.has_expected_scope, true);
  assert.deepEqual(comparison.in_scope_paths, [
    'pi-dev/lib/den-drift-check.ts',
    'docs/readme.md',
    'docs/api/spec.md',
  ]);
  assert.deepEqual(comparison.out_of_scope_paths, ['src/unexpected.ts']);
});

test('compareExpectedScope handles rename where old_path matches expected scope', () => {
  const comparison = compareExpectedScope([
    // Rename: docs/old.md -> docs/new.md; both in docs/** so both in scope
    { path: 'docs/new.md', status: 'R100', old_path: 'docs/old.md' },
    // Rename: unexpected move from in-scope to out-of-scope via old_path
    { path: 'src/moved.ts', status: 'R100', old_path: 'docs/original.ts' },
    // Completely out of scope
    { path: 'lib/unrelated.ts' },
  ], {
    paths: ['docs/**'],
  });

  assert.equal(comparison.has_expected_scope, true);
  // docs/new.md matches docs/** directly; src/moved.ts matches via old_path docs/original.ts
  assert.deepEqual(comparison.in_scope_paths, ['docs/new.md', 'src/moved.ts']);
  assert.deepEqual(comparison.out_of_scope_paths, ['lib/unrelated.ts']);
});

test('compareExpectedScope does not flag rename when BOTH path and old_path are out of scope', () => {
  const comparison = compareExpectedScope([
    { path: 'lib/foo.ts', status: 'R100', old_path: 'lib/bar.ts' },
  ], {
    paths: ['docs/**'],
  });

  assert.equal(comparison.has_expected_scope, true);
  assert.deepEqual(comparison.in_scope_paths, []);
  assert.deepEqual(comparison.out_of_scope_paths, ['lib/foo.ts']);
});

test('analyzeDriftCheck does not flag directory glob paths as out-of-scope (regression #1124)', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'docs/pi-orchestrator-context-status.md' },
      { status: 'M', path: 'tests/PiExtension.Tests/den-drift-check.test.mjs' },
      { status: 'M', path: 'pi-dev/lib/den-drift-check.ts' },
    ],
    expected_scope: {
      paths: ['pi-dev/lib/den-drift-check.ts', 'docs/**', 'tests/PiExtension.Tests/**'],
    },
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — pass'],
  });

  // All paths should be in scope, so no outside_expected_scope signal
  assert.ok(!result.signals.some((s) => s.code === 'outside_expected_scope'),
    `Unexpected out-of-scope signal: ${JSON.stringify(result.signals.filter(s => s.code === 'outside_expected_scope'))}`);
  assert.deepEqual(result.scope.out_of_scope_paths, []);
});

test('analyzeDriftCheck reports out-of-scope when glob does not match', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/DenMcp.Server/Program.cs' },
      { status: 'M', path: 'docs/readme.md' },
    ],
    expected_scope: {
      paths: ['docs/**'],
    },
    declared_tests: ['node --test tests/api.test.mjs — pass'],
  });

  assert.ok(result.signals.some((s) => s.code === 'outside_expected_scope'));
  assert.deepEqual(result.scope.out_of_scope_paths, ['src/DenMcp.Server/Program.cs']);
});

test('analyzeDriftCheck handles rename with old_path matching scope (regression #1124)', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'R100', path: 'src/renamed.ts', old_path: 'docs/original.ts', additions: 0, deletions: 0 },
      { status: 'M', path: 'pi-dev/lib/den-drift-check.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      paths: ['pi-dev/lib/den-drift-check.ts', 'docs/**'],
    },
    declared_tests: ['node --test tests/foo.test.mjs — pass'],
  });

  // Both paths should be in scope (src/renamed.ts via old_path docs/original.ts)
  assert.ok(!result.signals.some((s) => s.code === 'outside_expected_scope'),
    `Unexpected out-of-scope signal: ${JSON.stringify(result.signals.filter(s => s.code === 'outside_expected_scope'))}`);
  assert.deepEqual(result.scope.out_of_scope_paths, []);
  assert.deepEqual(result.scope.in_scope_paths, ['src/renamed.ts', 'pi-dev/lib/den-drift-check.ts']);
});

test('extractExpectedScopeFromContextPacket reads likely file path hints', () => {
  const packet = `
# Coder Context Packet — task 937

## Scope guidance

Likely files:
- \`pi-dev/lib/den-drift-check.ts\` or similarly named new library.
- \`pi-dev/extensions/den-subagent.ts\` for command/tool wiring.
- \`tests/PiExtension.Tests/den-drift-check.test.mjs\` for representative cases.
- Existing patterns: \`pi-dev/lib/den-implementation-packet.ts\`.
`;

  const scope = extractExpectedScopeFromContextPacket(packet);
  assert.ok(scope.paths.includes('pi-dev/lib/den-drift-check.ts'));
  assert.ok(scope.paths.includes('pi-dev/extensions/den-subagent.ts'));
  assert.ok(scope.paths.includes('tests/PiExtension.Tests/den-drift-check.test.mjs'));
  assert.ok(!scope.paths.includes('937'));
});

test('extractExpectedScopeFromContextPacket ignores constraint-only forbidden paths when scope section exists', () => {
  const packet = `
# Coder Context Packet — task 937

## Scope guidance

Likely files:
- \`pi-dev/lib/den-drift-check.ts\`
- \`tests/PiExtension.Tests/den-drift-check.test.mjs\`

## Important constraints

- Preserve unrelated main-worktree deletion \`deploy-cli.sh\`.
- Do not edit generated \`AGENTS.md\` snapshots.
`;

  const scope = extractExpectedScopeFromContextPacket(packet);
  assert.ok(scope.paths.includes('pi-dev/lib/den-drift-check.ts'));
  assert.ok(scope.paths.includes('tests/PiExtension.Tests/den-drift-check.test.mjs'));
  assert.ok(!scope.paths.includes('deploy-cli.sh'));
  assert.ok(!scope.paths.includes('AGENTS.md'));
});

test('extractDeclaredTestsFromImplementationPacket reads tests run section', () => {
  const packet = `
# Implementation Packet

## Tests Run

- \`node --test tests/PiExtension.Tests/den-drift-check.test.mjs\` — pass
- \`git diff --check main...HEAD\` — pass

## Risk Notes

Low.
`;

  assert.deepEqual(extractDeclaredTestsFromImplementationPacket(packet), [
    '`node --test tests/PiExtension.Tests/den-drift-check.test.mjs` — pass',
    '`git diff --check main...HEAD` — pass',
  ]);
});

test('formatDriftCheckPacketMessage and metadata include risk, paths, and Den packet type', () => {
  const result = analyzeDriftCheck({
    task_id: 937,
    task_intent: 'Add deterministic drift check tooling.',
    implementation_summary: 'Added pure analysis and Pi wiring.',
    branch: 'task/937-drift-check',
    base_ref: 'main',
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'pi-dev/lib/den-drift-check.ts', additions: 5, deletions: 1 }],
    declared_tests: ['node --test tests/PiExtension.Tests/den-drift-check.test.mjs — pass'],
  });

  const message = formatDriftCheckPacketMessage(result);
  const meta = buildDriftCheckPacketMeta(result);

  assert.ok(message.includes('# Drift Check Packet'));
  assert.ok(message.includes('**Risk:** low'));
  assert.ok(message.includes('## Task'));
  assert.ok(message.includes('- Task: `#937`'));
  assert.ok(message.includes('`pi-dev/lib/den-drift-check.ts`'));
  assert.equal(meta.type, 'drift_check_packet');
  assert.equal(meta.task_id, 937);
  assert.equal(meta.risk, 'low');
});

test('formatDriftCheckPacketMessage omits Task section when task fields are absent', () => {
  const result = analyzeDriftCheck({
    branch: 'task/no-task-fields',
    base_ref: 'main',
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'pi-dev/lib/den-drift-check.ts', additions: 1, deletions: 0 }],
  });

  const message = formatDriftCheckPacketMessage(result);

  const h2Headings = message.match(/^## .+$/gm) ?? [];

  assert.ok(message.includes('# Drift Check Packet'));
  assert.ok(!h2Headings.includes('## Task'));
  assert.equal(h2Headings[0], '## Branch and Base');
  assert.match(message, /\*\*Recommendation:\*\* flag-for-review\n\n## Branch and Base/);
});

test('extractTaskIntentFromContextPacket prefers user intent', () => {
  const packet = `
## Task description

Fallback description.

## User intent

Finish delegated-coder workflow foundation before roadmap work.
`;

  assert.equal(
    extractTaskIntentFromContextPacket(packet),
    'Finish delegated-coder workflow foundation before roadmap work.',
  );
});

// ---------------------------------------------------------------------------
// Expected change categories — analysis adjustments
// ---------------------------------------------------------------------------

test('large_ui expected category downgrades large_diff to low risk', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 }],
    expected_scope: {
      paths: ['src/ui/App.tsx'],
      expected_change_categories: ['large_ui'],
    },
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  assert.equal(result.risk, 'low');
  assert.ok(result.expected_categories.includes('large_ui'));
  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.severity, 'low');
  assert.equal(largeDiff.expected, true);
  assert.ok(largeDiff.message.includes('Expected per task scope'));
});

test('docs expected category downgrades large_diff to low risk', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'docs/api.md', additions: 600, deletions: 100 }],
    expected_scope: {
      expected_change_categories: ['docs'],
    },
    declared_tests: ['none needed'],
  });

  assert.equal(result.risk, 'low');
  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.expected, true);
});

test('generated expected category downgrades generated_files to low', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/generated/client.ts', additions: 500, deletions: 100 }],
    expected_scope: {
      expected_change_categories: ['generated'],
    },
    declared_tests: ['node --test tests/api.test.mjs — pass'],
  });

  const genSignal = result.signals.find((s) => s.code === 'generated_files');
  assert.ok(genSignal);
  assert.equal(genSignal.severity, 'low');
  assert.equal(genSignal.expected, true);
});

test('fixtures expected category downgrades test harness signals for fixture paths', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'tests/__fixtures__/response.json', additions: 100, deletions: 0 }],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.mjs — pass'],
  });

  // tests/__fixtures__/ paths are caught by test_or_scoring_harness, not generated_files.
  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  assert.equal(testSignal.severity, 'low');
  assert.equal(testSignal.expected, true);
});

test('fixtures expected does not downgrade non-fixture generated files', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'dist/bundle.min.js', additions: 500, deletions: 0 }],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.mjs — pass'],
  });

  const genSignal = result.signals.find((s) => s.code === 'generated_files');
  assert.ok(genSignal);
  assert.equal(genSignal.severity, 'medium');
  assert.equal(genSignal.expected, undefined);
});

test('tests expected category downgrades non-high test changes to low', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'tests/unit/api.test.ts', additions: 30, deletions: 5 },
    ],
    expected_scope: {
      expected_change_categories: ['tests'],
    },
    declared_tests: ['node --test tests/unit/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  assert.equal(testSignal.severity, 'low');
  assert.equal(testSignal.expected, true);
});

test('tests expected category keeps high-risk harness at high severity', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: '.github/workflows/ci.yml', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['tests'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  // High-risk harness keeps high severity even when expected; only marked expected.
  assert.equal(testSignal.severity, 'high');
  assert.equal(testSignal.expected, true);
});

test('config expected category keeps package changes at high severity but marks expected', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'package.json', additions: 1, deletions: 1 },
    ],
    expected_scope: {
      expected_change_categories: ['config'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const pkgSignal = result.signals.find((s) => s.code === 'package_project_dependency_changes');
  assert.ok(pkgSignal);
  // Package/dependency changes keep high severity even when expected.
  assert.equal(pkgSignal.severity, 'high');
  assert.equal(pkgSignal.expected, true);
  assert.ok(pkgSignal.message.includes('expected per task scope'));
});

test('schema expected category marks suspicious schema files as expected but keeps severity', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/migrations/001_create_users.sql', additions: 10, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['schema'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const suspSignal = result.signals.find((s) => s.code === 'suspicious_files');
  assert.ok(suspSignal);
  assert.equal(suspSignal.expected, true);
  assert.ok(suspSignal.message.includes('Schema changes expected'));
});

test('schema expected category marks all-schema suspicious paths as expected', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/migrations/001_create_users.sql', additions: 10, deletions: 0 },
      { status: 'M', path: 'src/schemas/order.json', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['schema'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const suspSignal = result.signals.find((s) => s.code === 'suspicious_files');
  assert.ok(suspSignal);
  assert.equal(suspSignal.expected, true);
  assert.ok(suspSignal.message.includes('Schema changes expected'));
});

test('schema expected category does NOT mark mixed schema/non-schema suspicious paths as expected', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/migrations/001_create_users.sql', additions: 10, deletions: 0 },
      { status: 'M', path: 'AGENTS.md', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['schema'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const suspSignal = result.signals.find((s) => s.code === 'suspicious_files');
  assert.ok(suspSignal);
  // Mixed paths: schema + non-schema (AGENTS.md) → NOT expected
  assert.equal(suspSignal.expected, undefined);
  assert.ok(!suspSignal.message.includes('Schema changes expected'));
  // AGENTS.md is high-suspicion so severity should be high
  assert.equal(suspSignal.severity, 'high');
});

test('schema expected category does NOT mark suspicious paths when only non-schema paths present', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'AGENTS.md', additions: 5, deletions: 0 },
      { status: 'M', path: 'deploy-cli.sh', additions: 3, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['schema'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const suspSignal = result.signals.find((s) => s.code === 'suspicious_files');
  assert.ok(suspSignal);
  assert.equal(suspSignal.expected, undefined);
});

test('schema expected category with secrets among schema paths does NOT mark expected', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/migrations/001_create_users.sql', additions: 10, deletions: 0 },
      { status: 'M', path: 'src/secret-key.pem', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['schema'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const suspSignal = result.signals.find((s) => s.code === 'suspicious_files');
  assert.ok(suspSignal);
  // secret-key.pem contains "secret" so it's suspicious but NOT schema-related
  assert.equal(suspSignal.expected, undefined);
  assert.equal(suspSignal.severity, 'high');
});

test('without expected categories, large_diff stays at medium', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 }],
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.severity, 'medium');
  assert.equal(largeDiff.expected, undefined);
});

test('invalid categories are ignored', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 }],
    expected_scope: {
      expected_change_categories: ['invalid_category', 'large_ui'],
    },
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  assert.deepEqual(result.expected_categories, ['large_ui']);
  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.severity, 'low');
  assert.equal(largeDiff.expected, true);
});

// ---------------------------------------------------------------------------
// Expected change categories — output format
// ---------------------------------------------------------------------------

test('formatDriftCheckPacketMessage shows expected categories and expected tag', () => {
  const result = analyzeDriftCheck({
    task_id: 1081,
    task_intent: 'Reduce drift noise.',
    branch: 'task/1081-drift-noise',
    base_ref: 'main',
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 }],
    expected_scope: {
      expected_change_categories: ['large_ui'],
    },
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  const message = formatDriftCheckPacketMessage(result);

  // Should show expected categories section
  assert.ok(message.includes('## Expected Change Categories'));
  assert.ok(message.includes('`large_ui`'));
  assert.ok(message.includes('Expected does not mean automatically approved'));

  // Expected signals should show *(expected)* tag
  assert.match(message, /\*\(expected\)\*/);

  // Risk should be low
  assert.ok(message.includes('**Risk:** low'));
});

test('formatDriftCheckPacketMessage omits expected categories section when none declared', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 5, deletions: 1 }],
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  const message = formatDriftCheckPacketMessage(result);
  assert.ok(!message.includes('## Expected Change Categories'));
  assert.ok(!message.includes('*(expected)*'));
});

// ---------------------------------------------------------------------------
// Expected change categories — context packet extraction
// ---------------------------------------------------------------------------

test('extractExpectedChangeCategories reads dedicated section', () => {
  const packet = `
# Coder Context Packet

## Expected change categories

- \`large_ui\`
- \`fixtures\`
- \`generated\`
`;

  const categories = extractExpectedChangeCategories(packet);
  assert.deepEqual(categories, ['large_ui', 'fixtures', 'generated']);
});

test('extractExpectedChangeCategories reads from constraints section', () => {
  const packet = `
# Coder Context Packet

## Constraints

Expected categories: \`docs\` and \`schema\`.
`;

  const categories = extractExpectedChangeCategories(packet);
  assert.deepEqual(categories, ['docs', 'schema']);
});

test('extractExpectedChangeCategories returns empty for no matches', () => {
  const packet = `
# Coder Context Packet

## Scope

- \`src/lib/foo.ts\`
`;

  const categories = extractExpectedChangeCategories(packet);
  assert.deepEqual(categories, []);
});

test('extractExpectedScopeFromContextPacket includes expected_change_categories', () => {
  const packet = `
# Coder Context Packet

## Expected change categories

- \`large_ui\`
- \`fixtures\`

## Suggested file pointers

- \`src/ui/App.tsx\`
`;

  const scope = extractExpectedScopeFromContextPacket(packet);
  assert.ok(scope.paths.includes('src/ui/App.tsx'));
  assert.ok(scope.expected_change_categories);
  assert.deepEqual(scope.expected_change_categories, ['large_ui', 'fixtures']);
});

test('EXPECTED_CHANGE_CATEGORIES constant contains all valid categories', () => {
  assert.deepEqual([...EXPECTED_CHANGE_CATEGORIES], ['large_ui', 'docs', 'fixtures', 'generated', 'schema', 'config', 'tests']);
});

// ---------------------------------------------------------------------------
// applyExpectedCategoryAdjustments — direct function tests
// ---------------------------------------------------------------------------

test('applyExpectedCategoryAdjustments returns signals unchanged when no categories', () => {
  const signals = [
    { code: 'large_diff', severity: 'medium', message: 'big diff' },
  ];
  const result = applyExpectedCategoryAdjustments(signals, [], []);
  assert.equal(result[0].severity, 'medium');
  assert.equal(result[0].expected, undefined);
});

test('applyExpectedCategoryAdjustments does not affect unrelated signals', () => {
  const signals = [
    { code: 'dirty_worktree', severity: 'high', message: 'dirty' },
    { code: 'collection_error', severity: 'high', message: 'error' },
    { code: 'missing_head_commit', severity: 'medium', message: 'no head' },
  ];
  const result = applyExpectedCategoryAdjustments(signals, ['large_ui'], []);
  assert.equal(result[0].severity, 'high');
  assert.equal(result[0].expected, undefined);
  assert.equal(result[1].severity, 'high');
  assert.equal(result[1].expected, undefined);
  assert.equal(result[2].severity, 'medium');
  assert.equal(result[2].expected, undefined);
});

test('multiple expected categories can combine to reduce noise', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 },
      { status: 'M', path: 'tests/__snapshots__/api.test.mjs.snap', additions: 100, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['large_ui', 'fixtures'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.severity, 'low');
  assert.equal(largeDiff.expected, true);

  const genFiles = result.signals.find((s) => s.code === 'generated_files');
  assert.ok(genFiles, `Expected generated_files signal; got: ${result.signals.map(s => s.code).join(', ')}`);
  assert.equal(genFiles.severity, 'low');
  assert.equal(genFiles.expected, true);
});

test('blocking signals for out-of-scope paths are not reduced by categories', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 },
      { status: 'M', path: 'src/completely/unrelated/Secret.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      paths: ['src/ui/App.tsx'],
      expected_change_categories: ['large_ui'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  // out-of-scope signal should not be reduced
  const oosSignal = result.signals.find((s) => s.code === 'outside_expected_scope');
  assert.ok(oosSignal);
  assert.equal(oosSignal.expected, undefined);

  // large_diff should be reduced
  const largeDiff = result.signals.find((s) => s.code === 'large_diff');
  assert.ok(largeDiff);
  assert.equal(largeDiff.expected, true);
});

test('reasons include expected tag for adjusted signals', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/ui/App.tsx', additions: 400, deletions: 200 }],
    expected_scope: {
      expected_change_categories: ['large_ui'],
    },
    declared_tests: ['node --test tests/ui.test.mjs — pass'],
  });

  const expectedReason = result.reasons.find((r) => r.includes('(expected)'));
  assert.ok(expectedReason, `Expected a reason with (expected), got: ${JSON.stringify(result.reasons)}`);
});

// ---------------------------------------------------------------------------
// Regression: blocking signals must not be reduced below high
// ---------------------------------------------------------------------------

test('tests_skipped_or_failed severity is never reduced by expected categories', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [{ status: 'M', path: 'src/lib/foo.ts', additions: 10, deletions: 0 }],
    expected_scope: {
      expected_change_categories: ['tests', 'large_ui', 'fixtures', 'generated', 'config', 'schema', 'docs'],
    },
    declared_tests: ['Tests not run — blocked'],
  });

  const skipSignal = result.signals.find((s) => s.code === 'tests_skipped_or_failed');
  assert.ok(skipSignal);
  assert.equal(skipSignal.severity, 'high');
  assert.equal(skipSignal.expected, undefined);
});

test('outside_expected_scope severity is never reduced by expected categories', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'src/ui/App.tsx', additions: 10, deletions: 0 },
      { status: 'M', path: 'src/out/of/scope.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      paths: ['src/ui/App.tsx'],
      expected_change_categories: ['tests', 'large_ui', 'fixtures', 'generated', 'config', 'schema', 'docs'],
    },
    declared_tests: ['node --test tests/foo.test.ts — pass'],
  });

  const oosSignal = result.signals.find((s) => s.code === 'outside_expected_scope');
  assert.ok(oosSignal);
  assert.equal(oosSignal.severity, 'medium');
  assert.equal(oosSignal.expected, undefined);
});

test('dirty_worktree severity is never reduced by expected categories', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    git_status_short: [' M src/lib/foo.ts'],
    changed_paths: [{ status: 'M', path: 'src/lib/foo.ts', additions: 5, deletions: 0 }],
    expected_scope: {
      expected_change_categories: ['tests', 'large_ui', 'fixtures', 'generated', 'config', 'schema', 'docs'],
    },
    declared_tests: ['node --test tests/foo.test.ts — pass'],
  });

  const dirtySignal = result.signals.find((s) => s.code === 'dirty_worktree');
  assert.ok(dirtySignal);
  assert.equal(dirtySignal.severity, 'high');
  assert.equal(dirtySignal.expected, undefined);
});

test('high-risk harness with tests expected keeps high severity (not medium)', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: '.github/workflows/ci.yml', additions: 5, deletions: 0 },
      { status: 'M', path: 'tests/scoring/harness.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['tests'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  assert.equal(testSignal.severity, 'high');
  assert.equal(testSignal.expected, true);
  // Overall risk should be high
  assert.equal(result.risk, 'high');
});

test('package changes with config expected keeps high severity', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'package.json', additions: 1, deletions: 1 },
      { status: 'M', path: 'package-lock.json', additions: 10, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['config'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const pkgSignal = result.signals.find((s) => s.code === 'package_project_dependency_changes');
  assert.ok(pkgSignal);
  assert.equal(pkgSignal.severity, 'high');
  assert.equal(pkgSignal.expected, true);
  assert.equal(result.risk, 'high');
});

// ---------------------------------------------------------------------------
// Regression: fixture/test downgrades require ALL paths to be fixture-like
// ---------------------------------------------------------------------------

test('fixtures category does not downgrade test_or_scoring_harness when only some paths are fixtures', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'tests/__fixtures__/data.json', additions: 10, deletions: 0 },
      { status: 'M', path: 'tests/unit/api.test.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  // Should NOT be reduced because not ALL paths are fixtures
  assert.equal(testSignal.expected, undefined);
});

test('fixtures category does not downgrade generated_files when only some paths are fixtures', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'tests/__snapshots__/api.test.mjs.snap', additions: 10, deletions: 0 },
      { status: 'M', path: 'dist/bundle.min.js', additions: 500, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const genSignal = result.signals.find((s) => s.code === 'generated_files');
  assert.ok(genSignal);
  // Not all generated paths are fixtures, so should not be reduced
  assert.equal(genSignal.expected, undefined);
});

test('fixtures category downgrades test harness when ALL paths are fixtures and non-high-risk', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'tests/__fixtures__/data.json', additions: 10, deletions: 0 },
      { status: 'M', path: 'tests/__snapshots__/api.test.mjs.snap', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  // ALL paths are fixtures and none are high-risk, so downgrade is OK
  assert.equal(testSignal.severity, 'low');
  assert.equal(testSignal.expected, true);
});

test('fixtures category does not downgrade when high-risk harness path is present', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'tests/__fixtures__/data.json', additions: 10, deletions: 0 },
      { status: 'M', path: 'tests/scoring/harness.ts', additions: 5, deletions: 0 },
    ],
    expected_scope: {
      expected_change_categories: ['fixtures'],
    },
    declared_tests: ['node --test tests/api.test.ts — pass'],
  });

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  // scoring/harness is high-risk, so should not be reduced even though some paths are fixtures
  assert.equal(testSignal.expected, undefined);
});

test('combined blocking signals stay high even with all expected categories', () => {
  const result = analyzeDriftCheck({
    head_commit: 'abc1234',
    changed_paths: [
      { status: 'M', path: 'package.json', additions: 1, deletions: 1 },
      { status: 'M', path: '.github/workflows/ci.yml', additions: 5, deletions: 0 },
    ],
    declared_tests: ['Tests not run'],
    expected_scope: {
      expected_change_categories: ['tests', 'config'],
    },
  });

  // All three blocking signals must stay high
  assert.equal(result.risk, 'high');

  const pkgSignal = result.signals.find((s) => s.code === 'package_project_dependency_changes');
  assert.ok(pkgSignal);
  assert.equal(pkgSignal.severity, 'high');
  assert.equal(pkgSignal.expected, true);

  const testSignal = result.signals.find((s) => s.code === 'test_or_scoring_harness_changes');
  assert.ok(testSignal);
  assert.equal(testSignal.severity, 'high');
  assert.equal(testSignal.expected, true);

  const skipSignal = result.signals.find((s) => s.code === 'tests_skipped_or_failed');
  assert.ok(skipSignal);
  assert.equal(skipSignal.severity, 'high');
  assert.equal(skipSignal.expected, undefined);
});
