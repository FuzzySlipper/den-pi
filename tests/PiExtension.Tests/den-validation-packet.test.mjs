import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  buildValidationPacketMeta,
  classifyFailureNote,
  deriveValidationStatus,
  executeValidationCommand,
  formatCompactValidationSummary,
  formatValidationPacketMessage,
  normalizeDeclaredValidationCommand,
  normalizeDeclaredValidationCommands,
  parseValidationArgs,
  runValidation,
} from '../../lib/den-validation-packet.ts';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// deriveValidationStatus
// ---------------------------------------------------------------------------

test('deriveValidationStatus returns pass when all commands pass', () => {
  const status = deriveValidationStatus([
    { command: 'echo ok', status: 'pass', exit_code: 0, duration_ms: 100, stdout_preview: '', stderr_preview: '' },
    { command: 'echo ok2', status: 'pass', exit_code: 0, duration_ms: 50, stdout_preview: '', stderr_preview: '' },
  ]);
  assert.equal(status, 'pass');
});

test('deriveValidationStatus returns fail when any command fails', () => {
  const status = deriveValidationStatus([
    { command: 'echo ok', status: 'pass', exit_code: 0, duration_ms: 100, stdout_preview: '', stderr_preview: '' },
    { command: 'exit 1', status: 'fail', exit_code: 1, duration_ms: 50, stdout_preview: '', stderr_preview: '' },
  ]);
  assert.equal(status, 'fail');
});

test('deriveValidationStatus returns blocked when all blocked', () => {
  const status = deriveValidationStatus([
    { command: 'missing-cmd', status: 'blocked', exit_code: null, duration_ms: 10, stdout_preview: '', stderr_preview: '', error: 'not found' },
  ]);
  assert.equal(status, 'blocked');
});

test('deriveValidationStatus returns partial when pass and blocked mixed', () => {
  const status = deriveValidationStatus([
    { command: 'echo ok', status: 'pass', exit_code: 0, duration_ms: 100, stdout_preview: '', stderr_preview: '' },
    { command: 'timeout-cmd', status: 'blocked', exit_code: null, duration_ms: 5000, stdout_preview: '', stderr_preview: '', error: 'timed out' },
  ]);
  assert.equal(status, 'partial');
});

test('deriveValidationStatus returns blocked for empty results', () => {
  assert.equal(deriveValidationStatus([]), 'blocked');
});

// ---------------------------------------------------------------------------
// buildValidationPacketMeta
// ---------------------------------------------------------------------------

test('buildValidationPacketMeta produces stable metadata with correct counts', () => {
  const result = {
    task_id: 957,
    branch: 'task/957-validation-packet-producer',
    base_commit: 'abc1234',
    head_commit: 'def5678',
    status: 'pass',
    command_results: [
      { command: 'node --test a.test.mjs', status: 'pass', exit_code: 0, duration_ms: 200, stdout_preview: '', stderr_preview: '' },
      { command: 'git diff --check', status: 'pass', exit_code: 0, duration_ms: 50, stdout_preview: '', stderr_preview: '' },
    ],
    total_duration_ms: 250,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const meta = buildValidationPacketMeta(result);

  assert.equal(meta.type, 'validation_packet');
  assert.equal(meta.prepared_by, 'orchestrator');
  assert.equal(meta.workflow, 'expanded_isolation_with_context');
  assert.equal(meta.version, 1);
  assert.equal(meta.task_id, 957);
  assert.equal(meta.branch, 'task/957-validation-packet-producer');
  assert.equal(meta.head_commit, 'def5678');
  assert.equal(meta.status, 'pass');
  assert.equal(meta.command_count, 2);
  assert.equal(meta.pass_count, 2);
  assert.equal(meta.fail_count, 0);
  assert.equal(meta.blocked_count, 0);
  assert.deepEqual(meta.test_commands, ['node --test a.test.mjs', 'git diff --check']);
  assert.deepEqual(meta.command_statuses, [
    { command: 'node --test a.test.mjs', status: 'pass', exit_code: 0 },
    { command: 'git diff --check', status: 'pass', exit_code: 0 },
  ]);
});

test('buildValidationPacketMeta handles mixed pass/fail/blocked results', () => {
  const result = {
    status: 'fail',
    command_results: [
      { command: 'pass-cmd', status: 'pass', exit_code: 0, duration_ms: 10, stdout_preview: '', stderr_preview: '' },
      { command: 'fail-cmd', status: 'fail', exit_code: 1, duration_ms: 20, stdout_preview: '', stderr_preview: '' },
      { command: 'blocked-cmd', status: 'blocked', exit_code: null, duration_ms: 5, stdout_preview: '', stderr_preview: '' },
    ],
    total_duration_ms: 35,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const meta = buildValidationPacketMeta(result);
  assert.equal(meta.status, 'fail');
  assert.equal(meta.pass_count, 1);
  assert.equal(meta.fail_count, 1);
  assert.equal(meta.blocked_count, 1);
});

test('buildValidationPacketMeta uses null for missing task/branch/commit', () => {
  const result = {
    status: 'pass',
    command_results: [],
    total_duration_ms: 0,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const meta = buildValidationPacketMeta(result);
  assert.equal(meta.task_id, null);
  assert.equal(meta.branch, null);
  assert.equal(meta.head_commit, null);
  assert.equal(meta.base_commit, null);
});

// ---------------------------------------------------------------------------
// formatValidationPacketMessage
// ---------------------------------------------------------------------------

test('formatValidationPacketMessage includes header, status, context, and summary', () => {
  const result = {
    task_id: 957,
    branch: 'task/957-test',
    head_commit: 'abc1234',
    status: 'pass',
    command_results: [
      { command: 'node --test foo.test.mjs', status: 'pass', exit_code: 0, duration_ms: 200, stdout_preview: 'ok', stderr_preview: '' },
    ],
    total_duration_ms: 200,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const message = formatValidationPacketMessage(result);

  assert.ok(message.includes('# Validation Packet'));
  assert.ok(message.includes('**Status:** pass'));
  assert.ok(message.includes('## Context'));
  assert.ok(message.includes('`#957`'));
  assert.ok(message.includes('`task/957-test`'));
  assert.ok(message.includes('`abc1234`'));
  assert.ok(message.includes('## Summary'));
  assert.ok(message.includes('## Command Results'));
  assert.ok(message.includes('node --test foo.test.mjs'));
  assert.ok(message.includes('✅'));
  assert.ok(message.includes('Validation passed'));
});

test('formatValidationPacketMessage shows failure verdict for failed status', () => {
  const result = {
    status: 'fail',
    command_results: [
      { command: 'exit 1', status: 'fail', exit_code: 1, duration_ms: 50, stdout_preview: '', stderr_preview: 'FAIL' },
    ],
    total_duration_ms: 50,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const message = formatValidationPacketMessage(result);
  assert.ok(message.includes('❌'));
  assert.ok(message.includes('Validation failed'));
  assert.ok(message.includes('Review the command results above'));
  assert.ok(!message.includes('do not conflate')); // only in blocked verdict
});

test('formatValidationPacketMessage shows blocked verdict with infrastructure warning', () => {
  const result = {
    status: 'blocked',
    command_results: [
      { command: 'nonexistent-cmd', status: 'blocked', exit_code: null, duration_ms: 5, stdout_preview: '', stderr_preview: '', error: 'command not found' },
    ],
    total_duration_ms: 5,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: ['command not found'],
  };

  const message = formatValidationPacketMessage(result);
  assert.ok(message.includes('⚠️'));
  assert.ok(message.includes('Validation blocked'));
  assert.ok(message.includes('infrastructure issue'));
  assert.ok(message.includes('Infrastructure Errors'));
});

test('formatValidationPacketMessage shows partial verdict for mixed pass/blocked', () => {
  const result = {
    status: 'partial',
    command_results: [
      { command: 'echo ok', status: 'pass', exit_code: 0, duration_ms: 10, stdout_preview: '', stderr_preview: '' },
      { command: 'timeout-cmd', status: 'blocked', exit_code: null, duration_ms: 5000, stdout_preview: '', stderr_preview: '', error: 'timed out' },
    ],
    total_duration_ms: 5010,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const message = formatValidationPacketMessage(result);
  assert.ok(message.includes('Validation partial'));
  assert.ok(message.includes('Pass: 1'));
  assert.ok(message.includes('Blocked: 1'));
});

test('formatValidationPacketMessage omits Context section when no task/branch/commit', () => {
  const result = {
    status: 'pass',
    command_results: [],
    total_duration_ms: 0,
    timestamp: '2026-04-29T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const message = formatValidationPacketMessage(result);
  assert.ok(!message.includes('## Context'));
});

// ---------------------------------------------------------------------------
// executeValidationCommand (integration, using real shell)
// ---------------------------------------------------------------------------

test('executeValidationCommand captures pass for a successful command', async () => {
  const result = await executeValidationCommand('echo hello', { cwd: os.tmpdir() });
  assert.equal(result.status, 'pass');
  assert.equal(result.exit_code, 0);
  assert.ok(result.stdout_preview.includes('hello'));
  assert.equal(result.error, undefined);
});

test('executeValidationCommand captures fail for non-zero exit code', async () => {
  const result = await executeValidationCommand('exit 42', { cwd: os.tmpdir() });
  assert.equal(result.status, 'fail');
  assert.equal(result.exit_code, 42);
});

test('executeValidationCommand captures fail for missing command (sh returns 127)', async () => {
  const result = await executeValidationCommand('this_command_does_not_exist_xyz', { cwd: os.tmpdir() });
  // sh -c "missing_cmd" exits with code 127, not a spawn error
  assert.equal(result.status, 'fail');
  assert.equal(result.exit_code, 127);
});

test('executeValidationCommand captures blocked for timeout', async () => {
  const result = await executeValidationCommand('sleep 10', { cwd: os.tmpdir(), timeout_ms: 200 });
  assert.equal(result.status, 'blocked');
  assert.ok(result.duration_ms < 5000);
});

// ---------------------------------------------------------------------------
// runValidation (integration)
// ---------------------------------------------------------------------------

test('runValidation runs commands sequentially and aggregates results', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-val-test-'));
  try {
    const result = await runValidation({
      cwd: tmp,
      commands: ['echo pass1', 'echo pass2'],
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.command_results.length, 2);
    assert.equal(result.command_results[0].status, 'pass');
    assert.equal(result.command_results[1].status, 'pass');
    assert.ok(result.total_duration_ms > 0);
    assert.ok(result.timestamp);
    assert.deepEqual(result.infrastructure_errors, []);
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { recursive: true }));
  }
});

test('runValidation reports fail when one command fails', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-val-test-'));
  try {
    const result = await runValidation({
      cwd: tmp,
      commands: ['echo pass', 'exit 1', 'echo also-pass'],
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.command_results[0].status, 'pass');
    assert.equal(result.command_results[1].status, 'fail');
    assert.equal(result.command_results[2].status, 'pass');
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { recursive: true }));
  }
});

test('runValidation carries task context through to result', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-val-test-'));
  try {
    const result = await runValidation({
      cwd: tmp,
      task_id: 957,
      branch: 'task/957-test',
      base_commit: 'abc0000',
      head_commit: 'def1111',
      commands: ['echo ok'],
    });

    assert.equal(result.task_id, 957);
    assert.equal(result.branch, 'task/957-test');
    assert.equal(result.base_commit, 'abc0000');
    assert.equal(result.head_commit, 'def1111');
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { recursive: true }));
  }
});

test('runValidation handles no commands gracefully', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-val-test-'));
  try {
    const result = await runValidation({ cwd: tmp, commands: [] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.command_results.length, 0);
  } finally {
    await import('node:fs/promises').then((fs) => fs.rm(tmp, { recursive: true }));
  }
});

// ---------------------------------------------------------------------------
// parseValidationArgs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// normalizeDeclaredValidationCommand(s)
// ---------------------------------------------------------------------------

test('normalizeDeclaredValidationCommand extracts backticked commands from packet test lines', () => {
  assert.equal(
    normalizeDeclaredValidationCommand('`node --test tests/PiExtension.Tests/foo.test.mjs` — pass'),
    'node --test tests/PiExtension.Tests/foo.test.mjs',
  );
  assert.equal(
    normalizeDeclaredValidationCommand('- `git diff --check main...HEAD` — 0 errors'),
    'git diff --check main...HEAD',
  );
});

test('normalizeDeclaredValidationCommand strips common result suffixes without backticks', () => {
  assert.equal(
    normalizeDeclaredValidationCommand('node --test tests/PiExtension.Tests/foo.test.mjs — 28 pass'),
    'node --test tests/PiExtension.Tests/foo.test.mjs',
  );
  assert.equal(
    normalizeDeclaredValidationCommand('git diff --check main...HEAD – passed'),
    'git diff --check main...HEAD',
  );
});

test('normalizeDeclaredValidationCommands filters non-command sentinels', () => {
  assert.deepEqual(
    normalizeDeclaredValidationCommands(['not run', '', 'n/a', '`npm test` — failed']),
    ['npm test'],
  );
});

// ---------------------------------------------------------------------------
// parseValidationArgs
// ---------------------------------------------------------------------------

test('parseValidationArgs parses task_id only', () => {
  const parsed = parseValidationArgs('957');
  assert.equal(parsed.task_id, 957);
  assert.equal(parsed.commands, undefined);
});

test('parseValidationArgs parses --commands as JSON array', () => {
  const parsed = parseValidationArgs('957 --commands \'["echo ok", "npm test"]\'');
  assert.equal(parsed.task_id, 957);
  assert.deepEqual(parsed.commands, ['echo ok', 'npm test']);
});

test('parseValidationArgs parses --no-post flag', () => {
  const parsed = parseValidationArgs('957 --no-post');
  assert.equal(parsed.task_id, 957);
  assert.equal(parsed.post_result, false);
});

test('parseValidationArgs parses branch and commit flags', () => {
  const parsed = parseValidationArgs('957 --branch task/957-test --head-commit abc1234 --base-commit def0000');
  assert.equal(parsed.branch, 'task/957-test');
  assert.equal(parsed.head_commit, 'abc1234');
  assert.equal(parsed.base_commit, 'def0000');
});

test('parseValidationArgs parses --timeout', () => {
  const parsed = parseValidationArgs('957 --timeout 30000');
  assert.equal(parsed.timeout_ms, 30000);
});

test('parseValidationArgs rejects missing task_id', () => {
  assert.throws(() => parseValidationArgs(''), /Usage:/);
  assert.throws(() => parseValidationArgs('abc'), /Usage:/);
});

test('parseValidationArgs rejects unknown flags', () => {
  assert.throws(() => parseValidationArgs('957 --unknown-flag value'), /Unknown validation flag/);
});

// ---------------------------------------------------------------------------
// formatCompactValidationSummary
// ---------------------------------------------------------------------------

test('formatCompactValidationSummary produces concise pass summary', () => {
  const result = {
    task_id: 1108,
    branch: 'task/1108-test',
    head_commit: 'abc1234',
    status: 'pass',
    command_results: [
      { command: 'node --test tests/PiExtension.Tests/den-validation-packet.test.mjs', status: 'pass', exit_code: 0, duration_ms: 200, stdout_preview: 'ok', stderr_preview: '' },
      { command: 'git diff --check', status: 'pass', exit_code: 0, duration_ms: 50, stdout_preview: '', stderr_preview: '' },
    ],
    total_duration_ms: 250,
    timestamp: '2026-04-30T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const summary = formatCompactValidationSummary(result, { message_id: 42 });

  // Header line
  assert.match(summary, /Validation: ✅ pass \| 2 commands/);
  assert.match(summary, /2 pass/);
  assert.match(summary, /250ms/);
  assert.match(summary, /Packet: message #42/);

  // Per-command lines
  assert.match(summary, /✅ `node --test/);
  assert.match(summary, /✅ `git diff --check/);

  // Does NOT include stdout/stderr previews
  assert.doesNotMatch(summary, /stdout preview/);
  assert.doesNotMatch(summary, /stderr preview/);
  assert.doesNotMatch(summary, /<details>/);

  // References posted packet for full details
  assert.match(summary, /Full stdout\/stderr details in the posted validation packet/);

  // Should be compact - well under 1000 chars
  assert.ok(summary.length < 1000, `compact summary should be short, got ${summary.length}`);
});

test('formatCompactValidationSummary includes short failure note for failed commands', () => {
  const result = {
    status: 'fail',
    command_results: [
      { command: 'node --test foo.test.mjs', status: 'pass', exit_code: 0, duration_ms: 100, stdout_preview: '', stderr_preview: '' },
      { command: 'node --test bar.test.mjs', status: 'fail', exit_code: 1, duration_ms: 80, stdout_preview: '', stderr_preview: 'not ok 1 - test something\n  ---\n  actual: false' },
    ],
    total_duration_ms: 180,
    timestamp: '2026-04-30T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const summary = formatCompactValidationSummary(result, { message_id: 43 });

  assert.match(summary, /Validation: ❌ fail/);
  assert.match(summary, /1 pass, 1 fail/);
  assert.match(summary, /❌ `node --test bar.test.mjs` — fail exit 1/);
  // Should include the first line of stderr as a failure note
  assert.match(summary, /not ok 1 - test something/);

  // Does not include full stderr
  assert.doesNotMatch(summary, /actual: false/);
});

test('formatCompactValidationSummary handles blocked commands with error note', () => {
  const result = {
    status: 'blocked',
    command_results: [
      { command: 'missing-tool', status: 'blocked', exit_code: null, duration_ms: 10, stdout_preview: '', stderr_preview: '', error: 'Command timed out after 5000ms' },
    ],
    total_duration_ms: 10,
    timestamp: '2026-04-30T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const summary = formatCompactValidationSummary(result);

  assert.match(summary, /Validation: ⚠️ blocked/);
  assert.match(summary, /1 blocked/);
  assert.match(summary, /⚠️ `missing-tool` — blocked/);
  assert.match(summary, /Command timed out/);
  assert.match(summary, /rerunning with verbose=true/);
});

test('formatCompactValidationSummary handles empty commands', () => {
  const result = {
    status: 'blocked',
    command_results: [],
    total_duration_ms: 0,
    timestamp: '2026-04-30T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const summary = formatCompactValidationSummary(result);

  assert.match(summary, /0 commands/);
  assert.match(summary, /0 pass/);
  assert.match(summary, /rerunning with verbose=true/);
  assert.match(summary, /no validation packet message was posted/);
});

test('formatCompactValidationSummary is much shorter than full packet message', () => {
  const longStdout = 'line\n'.repeat(100);
  const result = {
    task_id: 1108,
    status: 'fail',
    command_results: [
      { command: 'node --test large.test.mjs', status: 'fail', exit_code: 1, duration_ms: 500, stdout_preview: longStdout, stderr_preview: longStdout },
    ],
    total_duration_ms: 500,
    timestamp: '2026-04-30T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const fullMessage = formatValidationPacketMessage(result);
  const compactSummary = formatCompactValidationSummary(result, { message_id: 99 });

  // Compact should be dramatically shorter
  assert.ok(compactSummary.length < fullMessage.length / 5,
    `compact (${compactSummary.length}) should be < 1/5 of full (${fullMessage.length})`);

  // Full message includes the large preview
  assert.ok(fullMessage.length > 1000, 'full packet should include stdout/stderr');

  // Compact does NOT include the repetitive stdout
  assert.doesNotMatch(compactSummary, /line\nline/);
});

test('formatCompactValidationSummary shows partial status for mixed pass and blocked', () => {
  const result = {
    task_id: 1113,
    branch: 'task/1113-test',
    head_commit: 'abc1234',
    status: 'partial',
    command_results: [
      { command: 'node --test tests/foo.test.mjs', status: 'pass', exit_code: 0, duration_ms: 200, stdout_preview: 'ok', stderr_preview: '' },
      { command: 'node --test tests/bar.test.mjs', status: 'blocked', exit_code: null, duration_ms: 5000, stdout_preview: '', stderr_preview: '', error: 'Command timed out after 5000ms' },
      { command: 'git diff --check', status: 'pass', exit_code: 0, duration_ms: 50, stdout_preview: '', stderr_preview: '' },
    ],
    total_duration_ms: 5250,
    timestamp: '2026-05-01T12:00:00.000Z',
    infrastructure_errors: [],
  };

  const summary = formatCompactValidationSummary(result, { message_id: 100 });

  // Header shows partial status
  assert.match(summary, /Validation: ⚠️ partial/);
  assert.match(summary, /3 commands/);
  assert.match(summary, /2 pass, 1 blocked/);
  assert.match(summary, /5\.3s/);
  assert.match(summary, /Packet: message #100/);

  // Per-command lines show correct icons and includes failure note for blocked
  assert.match(summary, /✅ `node --test tests\/foo.test.mjs`/);
  assert.match(summary, /⚠️ `node --test tests\/bar.test.mjs` — blocked/);
  assert.match(summary, /Command timed out after 5000ms/);
  assert.match(summary, /✅ `git diff --check`/);

  // Does NOT include infrastructure errors section
  assert.doesNotMatch(summary, /infrastructure error/);

  // Should still be compact
  assert.ok(summary.length < 1000, `compact partial summary should be short, got ${summary.length}`);
});

test('formatCompactValidationSummary includes infrastructure errors section when present', () => {
  const result = {
    status: 'pass',
    command_results: [
      { command: 'node --test tests/foo.test.mjs', status: 'pass', exit_code: 0, duration_ms: 200, stdout_preview: 'ok', stderr_preview: '' },
    ],
    total_duration_ms: 200,
    timestamp: '2026-05-01T12:00:00.000Z',
    infrastructure_errors: ['error1', 'error2'],
  };

  const summary = formatCompactValidationSummary(result);

  // Normal pass summary still works
  assert.match(summary, /Validation: ✅ pass/);
  assert.match(summary, /1 command/);
  assert.match(summary, /1 pass/);

  // Infrastructure errors section appears
  assert.match(summary, /⚠️ 2 infrastructure error\(s\)\./);

  // Shows rerunning hint (no message_id)
  assert.match(summary, /rerunning with verbose=true/);
  assert.doesNotMatch(summary, /posted validation packet/);

  // Should still be compact
  assert.ok(summary.length < 1000, `compact summary with infra errors should be short, got ${summary.length}`);
});

test('formatCompactValidationSummary shows infrastructure errors alongside partial status', () => {
  const result = {
    task_id: 1113,
    status: 'partial',
    command_results: [
      { command: 'echo ok', status: 'pass', exit_code: 0, duration_ms: 10, stdout_preview: '', stderr_preview: '' },
      { command: 'broken-cmd', status: 'blocked', exit_code: null, duration_ms: 5, stdout_preview: '', stderr_preview: '', error: 'not found' },
    ],
    total_duration_ms: 15,
    timestamp: '2026-05-01T12:00:00.000Z',
    infrastructure_errors: ['broken-cmd: command not found'],
  };

  const summary = formatCompactValidationSummary(result);

  // Header shows partial status with mixed counts
  assert.match(summary, /Validation: ⚠️ partial/);
  assert.match(summary, /2 commands/);
  assert.match(summary, /1 pass, 1 blocked/);

  // Per-command lines
  assert.match(summary, /✅ `echo ok`/);
  assert.match(summary, /⚠️ `broken-cmd`/);

  // Infrastructure errors line
  assert.match(summary, /⚠️ 1 infrastructure error\(s\)\./);

  // Should still be compact
  assert.ok(summary.length < 1000, `compact partial+infra summary should be short, got ${summary.length}`);
});

// ---------------------------------------------------------------------------
// classifyFailureNote
// ---------------------------------------------------------------------------

test('classifyFailureNote returns error field for blocked commands', () => {
  const note = classifyFailureNote({
    command: 'timeout-cmd',
    status: 'blocked',
    exit_code: null,
    duration_ms: 5000,
    stdout_preview: '',
    stderr_preview: '',
    error: 'Command timed out after 120000ms',
  });
  assert.equal(note, 'Command timed out after 120000ms');
});

test('classifyFailureNote returns first non-empty stderr line for failed commands', () => {
  const note = classifyFailureNote({
    command: 'failing-test',
    status: 'fail',
    exit_code: 1,
    duration_ms: 100,
    stdout_preview: '',
    stderr_preview: 'not ok 1 - test foo\n  ---\n  actual: false',
  });
  assert.equal(note, 'not ok 1 - test foo');
});

test('classifyFailureNote falls back to stdout if no stderr', () => {
  const note = classifyFailureNote({
    command: 'test-cmd',
    status: 'fail',
    exit_code: 1,
    duration_ms: 50,
    stdout_preview: 'FAIL: expected 42 got 0\nmore output',
    stderr_preview: '',
  });
  assert.equal(note, 'FAIL: expected 42 got 0');
});

test('classifyFailureNote truncates long notes', () => {
  const longError = 'x'.repeat(200);
  const note = classifyFailureNote({
    command: 'cmd',
    status: 'blocked',
    exit_code: null,
    duration_ms: 10,
    stdout_preview: '',
    stderr_preview: '',
    error: longError,
  });
  assert.ok(note.length <= 140, `note should be truncated, got ${note.length}`); // 120 + '... (truncated)'
  assert.match(note, /\.\.\./);
});

test('classifyFailureNote returns empty string when no error/stderr/stdout', () => {
  const note = classifyFailureNote({
    command: 'echo ok',
    status: 'pass',
    exit_code: 0,
    duration_ms: 10,
    stdout_preview: '',
    stderr_preview: '',
  });
  assert.equal(note, '');
});
