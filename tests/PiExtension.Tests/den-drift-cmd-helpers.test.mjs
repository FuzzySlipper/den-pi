import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSuspiciousHunkCandidate,
  limitHunk,
  parseDriftCheckArgs,
  parseDriftSentinelArgs,
  parseStringList,
  tokenizeArgs,
} from '../../lib/den-drift-cmd-helpers.ts';

// ---------------------------------------------------------------------------
// tokenizeArgs
// ---------------------------------------------------------------------------

test('tokenizeArgs splits on whitespace', () => {
  assert.deepEqual(tokenizeArgs('a b c'), ['a', 'b', 'c']);
});

test('tokenizeArgs respects double quotes', () => {
  assert.deepEqual(tokenizeArgs('"hello world" foo'), ['hello world', 'foo']);
});

test('tokenizeArgs respects single quotes', () => {
  assert.deepEqual(tokenizeArgs("'hello world' foo"), ['hello world', 'foo']);
});

test('tokenizeArgs returns empty array for empty string', () => {
  assert.deepEqual(tokenizeArgs(''), []);
});

test('tokenizeArgs handles mixed quoting', () => {
  assert.deepEqual(tokenizeArgs('--flag "value with spaces" \'another value\' bare'), [
    '--flag', 'value with spaces', 'another value', 'bare',
  ]);
});

// ---------------------------------------------------------------------------
// parseStringList
// ---------------------------------------------------------------------------

test('parseStringList parses JSON array', () => {
  assert.deepEqual(parseStringList('["a","b","c"]'), ['a', 'b', 'c']);
});

test('parseStringList parses comma-separated text', () => {
  assert.deepEqual(parseStringList('foo, bar , baz'), ['foo', 'bar', 'baz']);
});

test('parseStringList parses newline-separated text', () => {
  assert.deepEqual(parseStringList('foo\nbar\nbaz'), ['foo', 'bar', 'baz']);
});

test('parseStringList parses CRLF-separated text', () => {
  assert.deepEqual(parseStringList('foo\r\nbar'), ['foo', 'bar']);
});

test('parseStringList returns undefined for empty string', () => {
  assert.equal(parseStringList(''), undefined);
});

test('parseStringList returns undefined for whitespace-only string', () => {
  assert.equal(parseStringList('   '), undefined);
});

test('parseStringList returns undefined for non-string', () => {
  assert.equal(parseStringList(42), undefined);
});

test('parseStringList filters empty entries', () => {
  assert.deepEqual(parseStringList('a,,b, ,c'), ['a', 'b', 'c']);
});

test('parseStringList parses JSON array of numbers as strings', () => {
  assert.deepEqual(parseStringList('[1, 2, 3]'), ['1', '2', '3']);
});

test('parseStringList parses mixed newline and comma as newline-first', () => {
  // The regex splits on \r?\n|, — newlines take priority
  const result = parseStringList('a\nb,c');
  assert.deepEqual(result, ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// parseDriftSentinelArgs — basic parsing
// ---------------------------------------------------------------------------

test('parseDriftSentinelArgs parses task ID only', () => {
  const result = parseDriftSentinelArgs('936');
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, undefined);
  assert.equal(result.post_result, undefined);
});

test('parseDriftSentinelArgs parses --base ref', () => {
  const result = parseDriftSentinelArgs('936 --base main');
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, 'main');
});

test('parseDriftSentinelArgs parses --base-ref alias', () => {
  const result = parseDriftSentinelArgs('936 --base-ref HEAD~5');
  assert.equal(result.base_ref, 'HEAD~5');
});

test('parseDriftSentinelArgs parses --base-commit', () => {
  const result = parseDriftSentinelArgs('936 --base-commit abc1234');
  assert.equal(result.base_commit, 'abc1234');
});

test('parseDriftSentinelArgs parses --no-post flag', () => {
  const result = parseDriftSentinelArgs('936 --no-post');
  assert.equal(result.post_result, false);
});

test('parseDriftSentinelArgs parses --post-result flag', () => {
  const result = parseDriftSentinelArgs('936 --post-result');
  assert.equal(result.post_result, true);
});

test('parseDriftSentinelArgs parses session flags', () => {
  assert.equal(parseDriftSentinelArgs('936 --fresh').sessionMode, 'fresh');
  assert.equal(parseDriftSentinelArgs('936 --continue').sessionMode, 'continue');

  const forked = parseDriftSentinelArgs('936 --fork session-1');
  assert.equal(forked.sessionMode, 'fork');
  assert.equal(forked.session, 'session-1');

  const session = parseDriftSentinelArgs('936 --session /tmp/pi-session.jsonl');
  assert.equal(session.sessionMode, 'session');
  assert.equal(session.session, '/tmp/pi-session.jsonl');
});

test('parseDriftSentinelArgs parses --model', () => {
  const result = parseDriftSentinelArgs('936 --model zai/glm-5.1');
  assert.equal(result.model, 'zai/glm-5.1');
});

test('parseDriftSentinelArgs parses --tools', () => {
  const result = parseDriftSentinelArgs('936 --tools read,bash');
  assert.equal(result.tools, 'read,bash');
});

test('parseDriftSentinelArgs parses --cwd', () => {
  const result = parseDriftSentinelArgs('936 --cwd /tmp/worktree');
  assert.equal(result.cwd, '/tmp/worktree');
});

// ---------------------------------------------------------------------------
// parseDriftSentinelArgs — hunks / suspicious-hunks
// ---------------------------------------------------------------------------

test('parseDriftSentinelArgs parses --hunks with JSON array', () => {
  const result = parseDriftSentinelArgs('936 --hunks \'["hunk1","hunk2"]\'');
  assert.deepEqual(result.suspicious_hunks, ['hunk1', 'hunk2']);
});

test('parseDriftSentinelArgs parses --suspicious-hunks alias with text list', () => {
  const result = parseDriftSentinelArgs('936 --suspicious-hunks "hunk1,hunk2,hunk3"');
  assert.deepEqual(result.suspicious_hunks, ['hunk1', 'hunk2', 'hunk3']);
});

// ---------------------------------------------------------------------------
// parseDriftSentinelArgs — combined flags
// ---------------------------------------------------------------------------

test('parseDriftSentinelArgs parses all flags together', () => {
  const result = parseDriftSentinelArgs(
    '936 --base main --base-commit abc123 --model zai/glm-5.1 --tools read --cwd /tmp --post-result --session session-1',
  );
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, 'main');
  assert.equal(result.base_commit, 'abc123');
  assert.equal(result.model, 'zai/glm-5.1');
  assert.equal(result.tools, 'read');
  assert.equal(result.cwd, '/tmp');
  assert.equal(result.post_result, true);
  assert.equal(result.sessionMode, 'session');
  assert.equal(result.session, 'session-1');
});

// ---------------------------------------------------------------------------
// parseDriftSentinelArgs — error cases
// ---------------------------------------------------------------------------

test('parseDriftSentinelArgs throws on missing args', () => {
  assert.throws(() => parseDriftSentinelArgs(undefined), /Usage: \/den-drift-sentinel/);
});

test('parseDriftSentinelArgs throws on empty args', () => {
  assert.throws(() => parseDriftSentinelArgs(''), /Usage: \/den-drift-sentinel/);
});

test('parseDriftSentinelArgs throws on non-numeric task ID', () => {
  assert.throws(() => parseDriftSentinelArgs('abc'), /Usage: \/den-drift-sentinel/);
});

test('parseDriftSentinelArgs throws on zero task ID', () => {
  assert.throws(() => parseDriftSentinelArgs('0'), /Usage: \/den-drift-sentinel/);
});

test('parseDriftSentinelArgs throws on negative task ID', () => {
  assert.throws(() => parseDriftSentinelArgs('-5'), /Usage: \/den-drift-sentinel/);
});

test('parseDriftSentinelArgs throws on unknown flag', () => {
  assert.throws(() => parseDriftSentinelArgs('936 --unknown-flag value'), /Unknown drift-sentinel flag/);
});

test('parseDriftSentinelArgs throws on flag without value', () => {
  assert.throws(() => parseDriftSentinelArgs('936 --base'), /requires a value/);
});

test('parseDriftSentinelArgs throws on --model without value', () => {
  assert.throws(() => parseDriftSentinelArgs('936 --model'), /requires a value/);
});

test('parseDriftSentinelArgs throws on --fork without session', () => {
  assert.throws(() => parseDriftSentinelArgs('936 --fork'), /requires a session id or path/);
});

// ---------------------------------------------------------------------------
// parseDriftCheckArgs — basic parsing (symmetry check)
// ---------------------------------------------------------------------------

test('parseDriftCheckArgs parses task ID and --base', () => {
  const result = parseDriftCheckArgs('936 --base main');
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, 'main');
});

test('parseDriftCheckArgs parses --no-post and --expected-paths JSON', () => {
  const result = parseDriftCheckArgs('936 --no-post --expected-paths \'["src/a.ts","src/b.ts"]\'');
  assert.equal(result.post_result, false);
  assert.deepEqual(result.expected_paths, ['src/a.ts', 'src/b.ts']);
});

test('parseDriftCheckArgs parses --declared-tests with comma-separated text', () => {
  const result = parseDriftCheckArgs('936 --declared-tests "npm test,npm run lint"');
  assert.deepEqual(result.declared_tests, ['npm test', 'npm run lint']);
});

test('parseDriftCheckArgs parses --summary', () => {
  const result = parseDriftCheckArgs('936 --summary "Fixed the bug"');
  assert.equal(result.implementation_summary, 'Fixed the bug');
});

test('parseDriftCheckArgs throws on invalid task ID', () => {
  assert.throws(() => parseDriftCheckArgs('abc'), /Usage: \/den-drift-check/);
});

test('parseDriftCheckArgs throws on unknown flag', () => {
  assert.throws(() => parseDriftCheckArgs('936 --bogus x'), /Unknown drift-check flag/);
});

test('parseDriftCheckArgs parses all supported flags', () => {
  const result = parseDriftCheckArgs(
    '936 --base main --base-commit abc123 --branch task/936 --head-commit def456 --cwd /tmp --no-post --summary "test summary"',
  );
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, 'main');
  assert.equal(result.base_commit, 'abc123');
  assert.equal(result.branch, 'task/936');
  assert.equal(result.head_commit, 'def456');
  assert.equal(result.cwd, '/tmp');
  assert.equal(result.post_result, false);
  assert.equal(result.implementation_summary, 'test summary');
});

// ---------------------------------------------------------------------------
// isSuspiciousHunkCandidate — positive matches
// ---------------------------------------------------------------------------

test('isSuspiciousHunkCandidate matches tests/ prefix', () => {
  assert.equal(isSuspiciousHunkCandidate('tests/foo.test.ts'), true);
});

test('isSuspiciousHunkCandidate matches /tests/ anywhere', () => {
  assert.equal(isSuspiciousHunkCandidate('src/pkg/tests/bar.test.ts'), true);
});

test('isSuspiciousHunkCandidate matches .github/ prefix', () => {
  assert.equal(isSuspiciousHunkCandidate('.github/workflows/ci.yml'), true);
});

test('isSuspiciousHunkCandidate matches scoring anywhere', () => {
  assert.equal(isSuspiciousHunkCandidate('src/scoring-engine.ts'), true);
});

test('isSuspiciousHunkCandidate matches harness anywhere', () => {
  assert.equal(isSuspiciousHunkCandidate('test-harness/setup.ts'), true);
});

test('isSuspiciousHunkCandidate matches package.json suffix', () => {
  assert.equal(isSuspiciousHunkCandidate('package.json'), true);
});

test('isSuspiciousHunkCandidate matches nested package.json', () => {
  assert.equal(isSuspiciousHunkCandidate('packages/foo/package.json'), true);
});

test('isSuspiciousHunkCandidate matches package-lock.json', () => {
  assert.equal(isSuspiciousHunkCandidate('package-lock.json'), true);
});

test('isSuspiciousHunkCandidate matches .csproj suffix', () => {
  assert.equal(isSuspiciousHunkCandidate('src/App.csproj'), true);
});

test('isSuspiciousHunkCandidate matches .slnx suffix', () => {
  assert.equal(isSuspiciousHunkCandidate('den-mcp.slnx'), true);
});

test('isSuspiciousHunkCandidate matches agents.md suffix', () => {
  assert.equal(isSuspiciousHunkCandidate('AGENTS.md'), true);
});

// ---------------------------------------------------------------------------
// isSuspiciousHunkCandidate — negative matches
// ---------------------------------------------------------------------------

test('isSuspiciousHunkCandidate rejects regular source file', () => {
  assert.equal(isSuspiciousHunkCandidate('src/lib/helpers.ts'), false);
});

test('isSuspiciousHunkCandidate rejects README', () => {
  assert.equal(isSuspiciousHunkCandidate('README.md'), false);
});

test('isSuspiciousHunkCandidate rejects random JSON file', () => {
  assert.equal(isSuspiciousHunkCandidate('src/config/data.json'), false);
});

test('isSuspiciousHunkCandidate rejects empty string', () => {
  assert.equal(isSuspiciousHunkCandidate(''), false);
});

test('isSuspiciousHunkCandidate is case-insensitive', () => {
  assert.equal(isSuspiciousHunkCandidate('Tests/Foo.test.ts'), true);
  assert.equal(isSuspiciousHunkCandidate('SRC/SCORING-module.ts'), true);
});

// ---------------------------------------------------------------------------
// limitHunk
// ---------------------------------------------------------------------------

test('limitHunk prefixes with file path header', () => {
  const result = limitHunk('src/foo.ts', 'diff content');
  assert.match(result, /^# src\/foo\.ts\n/);
  assert.ok(result.includes('diff content'));
});

test('limitHunk preserves short diffs unchanged', () => {
  const content = 'a'.repeat(100);
  const result = limitHunk('f.ts', content);
  assert.equal(result, `# f.ts\n${content}`);
});

test('limitHunk truncates long diffs with footer', () => {
  const content = 'a'.repeat(3000);
  const result = limitHunk('f.ts', content);
  assert.ok(result.length < content.length + 100);
  assert.match(result, /\.\.\.\s*\(truncated suspicious hunk for f\.ts\)/);
});

test('limitHunk exactly at boundary is not truncated', () => {
  const content = 'a'.repeat(2500);
  const result = limitHunk('f.ts', content);
  assert.equal(result, `# f.ts\n${content}`);
});

test('limitHunk truncates at 2501 chars', () => {
  const content = 'a'.repeat(2501);
  const result = limitHunk('f.ts', content);
  assert.ok(result.includes('truncated'));
});

// ---------------------------------------------------------------------------
// parseDriftCheckArgs --expected-categories
// ---------------------------------------------------------------------------

test('parseDriftCheckArgs parses --expected-categories with JSON array', () => {
  const result = parseDriftCheckArgs('936 --expected-categories \'["large_ui","fixtures"]\'');
  assert.deepEqual(result.expected_categories, ['large_ui', 'fixtures']);
});

test('parseDriftCheckArgs parses --expected-categories with comma-separated text', () => {
  const result = parseDriftCheckArgs('936 --expected-categories "large_ui,docs,generated"');
  assert.deepEqual(result.expected_categories, ['large_ui', 'docs', 'generated']);
});

test('parseDriftCheckArgs parses --expected-categories with all flags', () => {
  const result = parseDriftCheckArgs(
    '936 --base main --expected-paths \'["src/a.ts"]\' --expected-categories "fixtures,generated" --no-post',
  );
  assert.equal(result.task_id, 936);
  assert.equal(result.base_ref, 'main');
  assert.deepEqual(result.expected_paths, ['src/a.ts']);
  assert.deepEqual(result.expected_categories, ['fixtures', 'generated']);
  assert.equal(result.post_result, false);
});

test('parseDriftCheckArgs expected_categories is undefined when not provided', () => {
  const result = parseDriftCheckArgs('936 --base main');
  assert.equal(result.expected_categories, undefined);
});
