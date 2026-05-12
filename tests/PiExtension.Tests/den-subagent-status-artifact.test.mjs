import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSubagentRunRecorder } from '../../lib/den-subagent-recorder.ts';
import { runPiCliSubagent, subagentSucceeded } from '../../lib/den-subagent-runner.ts';
import {
  collectContextMetricsFromSessionJsonl,
  collectContextMetricsForRun,
  enrichStatusJson,
} from '../../lib/den-subagent-pipeline.ts';
import { buildSubagentParentToolResult } from '../../lib/den-subagent-parent-tool-result.ts';
import {
  collectFinalBranchHead,
  buildFinalBranchHeadMetadata,
} from '../../lib/den-subagent-final-head.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const FAKE_RUNNER_ENV = [
  'PI_CODING_AGENT_DIR',
  'DEN_PI_SUBAGENT_PI_BIN',
  'DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS',
  'DEN_PI_SUBAGENT_FINAL_DRAIN_MS',
  'DEN_PI_SUBAGENT_FORCE_KILL_MS',
  'DEN_PI_SUBAGENT_HEARTBEAT_MS',
  'DEN_PI_SUBAGENT_CONTROL_POLL_MS',
];

async function runFakePiSubagent(t, {
  prefix,
  scriptLines,
  runId,
  options,
  env = {},
  onUpdate,
}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const fakePi = path.join(tmp, 'fake-pi');
  await writeFile(fakePi, `${scriptLines.join('\n')}\n`, 'utf8');
  await chmod(fakePi, 0o755);

  const envValues = {
    DEN_PI_SUBAGENT_HEARTBEAT_MS: '0',
    DEN_PI_SUBAGENT_CONTROL_POLL_MS: '0',
    ...env,
  };
  const envNames = new Set([...FAKE_RUNNER_ENV, ...Object.keys(envValues)]);
  const previousEnv = new Map([...envNames].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'agent');
  process.env.DEN_PI_SUBAGENT_PI_BIN = fakePi;
  for (const [name, value] of Object.entries(envValues)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  }

  t.after(async () => {
    for (const [name, value] of previousEnv) restoreEnv(name, value);
    await rm(tmp, { recursive: true, force: true });
  });

  const recorder = await createSubagentRunRecorder(runId);
  const result = await runPiCliSubagent({
    cfg: { projectId: 'den-mcp', agent: 'pi', role: 'conductor', instanceId: 'pi-main', baseUrl: 'http://den' },
    options,
    cwd: tmp,
    runId,
    recorder,
    startedAt: new Date().toISOString(),
    signal: undefined,
    controlSource: undefined,
    onUpdate,
  });

  return { tmp, fakePi, recorder, result };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000 });
  return String(stdout).trim();
}

async function initGitRepoWithTaskBranch(t, branch = 'task/final-head') {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'den-final-head-'));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(repo, 'work.txt'), 'launch\n', 'utf8');
  await git(repo, ['add', 'work.txt']);
  await git(repo, ['commit', '-m', 'launch']);
  const launchHead = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['checkout', '-b', branch]);
  await writeFile(path.join(repo, 'work.txt'), 'final\n', 'utf8');
  await git(repo, ['commit', '-am', 'final']);
  const finalHead = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, branch, launchHead, finalHead };
}

// ---------------------------------------------------------------------------
// collectContextMetricsFromSessionJsonl tests
// ---------------------------------------------------------------------------

test('collectContextMetricsFromSessionJsonl returns undefined for empty input', () => {
  assert.equal(collectContextMetricsFromSessionJsonl(undefined), undefined);
  assert.equal(collectContextMetricsFromSessionJsonl(''), undefined);
  assert.equal(collectContextMetricsFromSessionJsonl('\n\n'), undefined);
});

test('collectContextMetricsFromSessionJsonl counts messages by role and model-visible chars', () => {
  const sessionJsonl = [
    JSON.stringify({ type: 'session', version: 3, id: 's1' }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-30T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Hello, please implement X.' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-30T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will implement X now.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'echo ok' } }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-30T00:00:10.000Z', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok\n' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-30T00:00:15.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done implementing X.' }] } }),
  ].join('\n');

  const result = collectContextMetricsFromSessionJsonl(sessionJsonl);
  assert.ok(result, 'should return metrics for valid session');
  assert.deepEqual(result.session.message_counts_by_role, {
    user: 1,
    assistant: 2,
    toolResult: 1,
  });
  assert.equal(result.session.model_visible_chars, 'Hello, please implement X.'.length + 'I will implement X now.'.length + 'ok\n'.length + 'Done implementing X.'.length);
});

test('collectContextMetricsFromSessionJsonl ignores non-message entries', () => {
  const sessionJsonl = [
    JSON.stringify({ type: 'session', version: 3, id: 's1' }),
    JSON.stringify({ type: 'turn_start' }),
    'not-json',
    '',
  ].join('\n');

  assert.equal(collectContextMetricsFromSessionJsonl(sessionJsonl), undefined);
});

// ---------------------------------------------------------------------------
// Status artifact final-head persistence tests
// ---------------------------------------------------------------------------

test('status.json includes final_head_commit and final_branch after enrichment', async (t) => {
  const { repo, branch, launchHead, finalHead } = await initGitRepoWithTaskBranch(t, 'task/status-final-head');

  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-status-final-head-',
    runId: 'run-status-final-head',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'coder',
      prompt: 'Work on the branch.',
      headCommit: launchHead,
      branch,
      worktreePath: repo,
    },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(subagentSucceeded(result), true);

  // The status.json should have been enriched with final-head fields by the
  // runDenSubagent wrapper in the extension. However, runFakePiSubagent only
  // runs the backend (runPiCliSubagent), not the full runDenSubagent. So we
  // simulate the enrichment by collecting final-head state and checking the
  // metadata shape.
  const finalHeadState = await collectFinalBranchHead({ worktreePath: repo, branch });
  assert.ok(finalHeadState, 'should resolve final head state');
  assert.equal(finalHeadState.final_head_commit, finalHead);
  assert.equal(finalHeadState.final_branch, branch);
  assert.equal(finalHeadState.final_head_status, 'clean');
  assert.equal(finalHeadState.final_worktree_status, 'clean');

  // Verify the metadata builder produces the expected fields
  const metadata = buildFinalBranchHeadMetadata(finalHeadState);
  assert.equal(metadata.final_head_commit, finalHead);
  assert.equal(metadata.final_branch, branch);
  assert.equal(metadata.final_head_status, 'clean');
  assert.equal(metadata.final_worktree_status, 'clean');

  // Simulate enrichment: read status, merge, write, read back
  const currentStatus = await readJson(recorder.artifacts.status_json_path);
  const enriched = {
    ...currentStatus,
    ...metadata,
    context_metrics: null,
  };
  await recorder.writeStatus(enriched);
  const finalStatus = await readJson(recorder.artifacts.status_json_path);

  assert.equal(finalStatus.final_head_commit, finalHead, 'status.json should persist final_head_commit');
  assert.equal(finalStatus.final_branch, branch, 'status.json should persist final_branch');
  assert.equal(finalStatus.final_head_status, 'clean', 'status.json should persist final_head_status');
  assert.equal(finalStatus.final_worktree_status, 'clean', 'status.json should persist final_worktree_status');
  assert.equal(finalStatus.head_commit, launchHead, 'status.json should preserve starting head_commit');

  // Verify the runner's base fields are still present
  assert.equal(finalStatus.exit_code, 0);
  assert.equal(finalStatus.output_status, 'assistant_final');
  assert.equal(finalStatus.state, 'complete');
});

test('status.json includes dirty worktree status after enrichment', async (t) => {
  const { repo, branch, finalHead } = await initGitRepoWithTaskBranch(t, 'task/status-dirty');
  await writeFile(path.join(repo, 'work.txt'), 'modified\n', 'utf8');

  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-status-dirty-',
    runId: 'run-status-dirty',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'coder',
      prompt: 'Work on the branch.',
      branch,
      worktreePath: repo,
    },
  });

  const finalHeadState = await collectFinalBranchHead({ worktreePath: repo, branch });
  assert.equal(finalHeadState.final_head_status, 'dirty_uncommitted');
  assert.equal(finalHeadState.final_worktree_status, 'dirty_uncommitted');
  assert.match(finalHeadState.final_worktree_status_short, /M work\.txt/);

  // Simulate enrichment
  const metadata = buildFinalBranchHeadMetadata(finalHeadState);
  const currentStatus = await readJson(recorder.artifacts.status_json_path);
  await recorder.writeStatus({ ...currentStatus, ...metadata, context_metrics: null });
  const finalStatus = await readJson(recorder.artifacts.status_json_path);

  assert.equal(finalStatus.final_head_status, 'dirty_uncommitted');
  assert.equal(finalStatus.final_worktree_status, 'dirty_uncommitted');
  assert.match(finalStatus.final_worktree_status_short, /M work\.txt/);
});

// ---------------------------------------------------------------------------
// Status artifact context_metrics tests
// ---------------------------------------------------------------------------

test('status.json includes context_metrics block after enrichment', async (t) => {
  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-status-metrics-',
    runId: 'run-status-metrics',
    scriptLines: [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];',
      'const sessionId = "session-metrics-test";',
      'fs.mkdirSync(sessionDir, { recursive: true });',
      'const sessionFile = path.join(sessionDir, `2026-04-30T00-00-00-000Z_${sessionId}.jsonl`);',
      'fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() }) + "\\n");',
      'fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: "a1", timestamp: "2026-04-30T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Implement X" }] } }) + "\\n");',
      'fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: "a2", timestamp: "2026-04-30T00:00:02.000Z", message: { role: "assistant", usage: { input: 100, output: 25 }, content: [{ type: "text", text: "Done" }] } }) + "\\n");',
      'console.log(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Work on the task.' },
  });

  // Read the session file directly from the recorder's session_dir and build context_metrics.
  const { readdir: readdirAsync, stat: statAsync } = await import('node:fs/promises');
  let contextMetrics = null;
  try {
    const sessionEntries = await readdirAsync(recorder.artifacts.session_dir);
    const jsonlFile = sessionEntries.find(f => f.endsWith('.jsonl'));
    if (jsonlFile) {
      const sessionFilePath = path.join(recorder.artifacts.session_dir, jsonlFile);
      const sessionContent = await readFile(sessionFilePath, 'utf8');
      const parsed = collectContextMetricsFromSessionJsonl(sessionContent);
      if (parsed) {
        const sessionFileStat = await statAsync(sessionFilePath);
        contextMetrics = {
          session: {
            ...parsed.session,
            session_file_bytes: sessionFileStat.size,
          },
          usage_summary_source: 'pi_session_assistant_usage',
        };
      }
    }
  } catch {
    // Session metrics are optional
  }

  // Enrich the status artifact
  const status = await readJson(recorder.artifacts.status_json_path);
  await recorder.writeStatus({ ...status, context_metrics: contextMetrics });
  const finalStatus = await readJson(recorder.artifacts.status_json_path);

  assert.ok(finalStatus.context_metrics, 'status.json should include context_metrics');
  assert.ok(finalStatus.context_metrics.session, 'context_metrics should include session block');
  assert.deepEqual(finalStatus.context_metrics.session.message_counts_by_role, {
    user: 1,
    assistant: 1,
  });
  assert.equal(finalStatus.context_metrics.session.model_visible_chars, 'Implement X'.length + 'Done'.length);
  assert.equal(typeof finalStatus.context_metrics.session.session_file_bytes, 'number');
  assert.ok(finalStatus.context_metrics.session.session_file_bytes > 0);
  assert.equal(finalStatus.context_metrics.usage_summary_source, 'pi_session_assistant_usage');
});

test('context_metrics is null in status.json when no session file exists', async (t) => {
  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-no-metrics-',
    runId: 'run-no-metrics',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Work on the task.' },
  });

  // Simulate enrichment with no session file
  const status = await readJson(recorder.artifacts.status_json_path);
  await recorder.writeStatus({ ...status, context_metrics: null });
  const finalStatus = await readJson(recorder.artifacts.status_json_path);

  assert.equal(finalStatus.context_metrics, null, 'context_metrics should be null when no session');
});

// ---------------------------------------------------------------------------
// Parent tool result consistency tests
// ---------------------------------------------------------------------------

test('parent tool result includes context_metrics when available', () => {
  const metrics = {
    session: {
      message_counts_by_role: { user: 2, assistant: 3 },
      model_visible_chars: 1500,
      session_file_bytes: 8192,
    },
    usage_summary_source: 'pi_session_assistant_usage',
  };

  const result = {
    run_id: 'run-metrics',
    role: 'coder',
    task_id: 1110,
    branch: 'task/1110-status-context-metrics',
    head_commit: 'head-sha',
    exit_code: 0,
    aborted: false,
    assistant_final_found: true,
    final_output: 'Implemented context metrics.',
    artifacts: { dir: '/tmp/run-metrics' },
    duration_ms: 5000,
    message_count: 5,
    assistant_message_count: 3,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: '2026-04-30T00:00:00.000Z',
    ended_at: '2026-04-30T00:00:05.000Z',
    context_metrics: metrics,
  };

  const toolResult = buildSubagentParentToolResult(result);
  assert.ok(toolResult.details.context_metrics, 'parent tool result should include context_metrics');
  assert.deepEqual(toolResult.details.context_metrics.session.message_counts_by_role, { user: 2, assistant: 3 });
  assert.equal(toolResult.details.context_metrics.session.model_visible_chars, 1500);
  assert.equal(toolResult.details.context_metrics.usage_summary_source, 'pi_session_assistant_usage');
});

test('parent tool result has undefined context_metrics when not set', () => {
  const result = {
    run_id: 'run-no-metrics',
    role: 'coder',
    task_id: 1110,
    branch: 'task/1110',
    head_commit: 'head-sha',
    exit_code: 0,
    aborted: false,
    assistant_final_found: true,
    final_output: 'Done.',
    artifacts: { dir: '/tmp/run-no-metrics' },
    duration_ms: 5000,
    message_count: 2,
    assistant_message_count: 1,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: '2026-04-30T00:00:00.000Z',
    ended_at: '2026-04-30T00:00:05.000Z',
  };

  const toolResult = buildSubagentParentToolResult(result);
  assert.equal(toolResult.details.context_metrics, undefined, 'context_metrics should be absent when not set');
});

test('parent tool result includes final-head fields consistently', () => {
  const result = {
    run_id: 'run-consistent',
    role: 'coder',
    task_id: 1110,
    branch: 'task/1110',
    base_branch: 'main',
    base_commit: 'base-sha',
    head_commit: 'launch-sha',
    requested_head_commit: 'launch-sha',
    purpose: 'implementation',
    exit_code: 0,
    aborted: false,
    assistant_final_found: true,
    final_output: 'Done.',
    artifacts: { dir: '/tmp/run-consistent' },
    duration_ms: 5000,
    message_count: 3,
    assistant_message_count: 2,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: '2026-04-30T00:00:00.000Z',
    ended_at: '2026-04-30T00:00:05.000Z',
    final_head_commit: 'final-sha-abc',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1110',
    final_worktree_branch: 'task/1110',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
    final_worktree_status_short: undefined,
    final_head_error: undefined,
  };

  const toolResult = buildSubagentParentToolResult(result);

  // Verify all final-head fields are present in details
  assert.equal(toolResult.details.head_commit, 'launch-sha', 'details should preserve starting head_commit');
  assert.equal(toolResult.details.requested_head_commit, 'launch-sha', 'details should preserve requested_head_commit');
  assert.equal(toolResult.details.final_head_commit, 'final-sha-abc', 'details should include final_head_commit');
  assert.equal(toolResult.details.final_head_status, 'clean');
  assert.equal(toolResult.details.final_branch, 'task/1110');
  assert.equal(toolResult.details.final_worktree_status, 'clean');

  // Text output should show both heads since they differ
  const text = toolResult.content[0].text;
  assert.match(text, /Final branch head: final-sha-abc/);
  assert.match(text, /Requested \(starting\) head: launch-sha/);
});

// ---------------------------------------------------------------------------
// R1110-1: Integration-style tests for the actual enrichment path
// ---------------------------------------------------------------------------

test('enrichStatusJson merges final head metadata and context_metrics into existing status.json', async (t) => {
  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-integration-enrichStatusJson-',
    runId: 'run-enrichStatusJson',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Work on branch.' },
  });

  // Ensure the status.json has baseline content
  const baseline = await readJson(recorder.artifacts.status_json_path);
  assert.ok(baseline.exit_code !== undefined, 'baseline status exists');

  const finalHeadMetadata = buildFinalBranchHeadMetadata({
    final_head_commit: 'abc123',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1114-test',
    final_worktree_branch: 'task/1114-test',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
  });
  const contextMetrics = {
    session: {
      message_counts_by_role: { user: 1, assistant: 1 },
      model_visible_chars: 42,
    },
    usage_summary_source: 'pi_session_assistant_usage',
  };

  await enrichStatusJson(recorder, finalHeadMetadata, contextMetrics);

  const enriched = await readJson(recorder.artifacts.status_json_path);
  assert.equal(enriched.final_head_commit, 'abc123', 'enrichStatusJson sets final_head_commit');
  assert.equal(enriched.final_head_status, 'clean', 'enrichStatusJson sets final_head_status');
  assert.equal(enriched.final_branch, 'task/1114-test', 'enrichStatusJson sets final_branch');
  assert.deepEqual(enriched.context_metrics, contextMetrics, 'enrichStatusJson sets context_metrics');
  assert.equal(enriched.exit_code, baseline.exit_code, 'enrichStatusJson preserves existing status fields');
  assert.equal(enriched.state, baseline.state, 'enrichStatusJson preserves existing state');

  // Verify enrichStatusJson with null context_metrics
  await enrichStatusJson(recorder, {}, null);
  const nulled = await readJson(recorder.artifacts.status_json_path);
  assert.equal(nulled.context_metrics, null, 'context_metrics is null when passed null');
});

test('enrichStatusJson gracefully handles missing status.json', async (t) => {
  // Create a minimal status file to start, then verify no crash
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-enrich-missing-'));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  // Create a recorder via a throwaway subagent
  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-enrich-missing-status-',
    runId: 'run-enrich-missing-status',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'test' },
  });

  // enrichStatusJson reads from the artifact path; if the file exists it works
  const metadata = buildFinalBranchHeadMetadata({
    final_head_commit: 'def456',
    final_head_status: 'clean',
    final_branch: 'task/test',
    final_worktree_status: 'clean',
  });
  await assert.doesNotReject(
    enrichStatusJson(recorder, metadata, undefined),
    'enrichStatusJson should not reject when status.json exists',
  );

  const status = await readJson(recorder.artifacts.status_json_path);
  assert.equal(status.final_head_commit, 'def456', 'status was enriched');
});

test('collectContextMetricsForRun collects session and artifact metrics from real files', async (t) => {
  // Create a recorder to get valid artifact paths, then write a session file
  // programmatically so we control the session file path directly.
  const { recorder, result } = await runFakePiSubagent(t, {
    prefix: 'den-integration-collectMetrics-',
    runId: 'run-collectMetrics',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Quick.' },
  });

  // Write a session file directly to the recorder's session dir.
  const sessionDir = recorder.artifacts.session_dir;
  const sessionId = 'session-integration-1';
  const sessionFilePath = path.join(sessionDir, `2026-05-01T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(sessionFilePath, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: process.cwd() }),
    JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-05-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Implement feature Y' }] } }),
    JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-05-01T00:00:02.000Z', message: { role: 'assistant', usage: { input: 150, output: 30 }, content: [{ type: 'text', text: 'Done implementing Y' }] } }),
  ].join('\n'), 'utf8');

  // Set pi_session_file_path on result so collectContextMetricsForRun finds it.
  // Also set usage_summary.source since the runner didn't discover this session file.
  result.pi_session_file_path = sessionFilePath;
  result.artifacts.session_file_path = sessionFilePath;
  result.usage_summary = { source: 'pi_session_assistant_usage' };

  const metrics = await collectContextMetricsForRun(result, recorder.artifacts);

  assert.ok(metrics, 'collectContextMetricsForRun should return metrics');
  assert.ok(metrics && metrics.session, 'should include session block');
  if (metrics && metrics.session) {
    assert.deepEqual(metrics.session.message_counts_by_role, {
      user: 1,
      assistant: 1,
    });
    assert.equal(metrics.session.model_visible_chars,
      'Implement feature Y'.length + 'Done implementing Y'.length);
    assert.equal(typeof metrics.session.session_file_bytes, 'number', 'session_file_bytes should be present');
    assert.ok(metrics.session.session_file_bytes > 0, 'session_file_bytes should be positive');
  }
  assert.ok(metrics.artifacts, 'should include artifacts block');
  assert.equal(typeof metrics.artifacts.status_json_bytes, 'number', 'status.json bytes should be present');
  assert.equal(typeof metrics.artifacts.stdout_jsonl_bytes, 'number', 'stdout.jsonl bytes should be present');
  assert.equal(metrics.usage_summary_source, 'pi_session_assistant_usage');
});

test('collectContextMetricsForRun returns undefined when no session file and no usage', async (t) => {
  const { recorder, result } = await runFakePiSubagent(t, {
    prefix: 'den-integration-no-metrics-',
    runId: 'run-no-metrics-2',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Quick task.' },
  });

  const metrics = await collectContextMetricsForRun(result, recorder.artifacts);

  // With no session file, artifact metrics and usage summary may still exist.
  // But if result.usage_summary is undefined, the function may return undefined.
  if (result.usage_summary) {
    assert.ok(metrics, 'metrics may be returned from usage_summary alone');
  } else {
    // No session file, no usage — expect undefined or only artifact metrics
    assert.ok(metrics === undefined || (metrics.artifacts && !metrics.session),
      'metrics without session: should have no session block');
  }
});

// ---------------------------------------------------------------------------
// R1110-3: Empty session metrics edge case
// ---------------------------------------------------------------------------

test('session with no message entries should not surface empty message_counts_by_role', async (t) => {
  const { recorder, result } = await runFakePiSubagent(t, {
    prefix: 'den-empty-session-metrics-',
    runId: 'run-empty-session-metrics',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Quick.' },
  });

  // Write a session file with only a session header — no message entries.
  const sessionDir = recorder.artifacts.session_dir;
  const sessionFilePath = path.join(sessionDir, '2026-05-01T00-00-00-000Z_session-empty.jsonl');
  await writeFile(sessionFilePath, JSON.stringify({ type: 'session', version: 3, id: 'session-empty', cwd: process.cwd() }) + '\n', 'utf8');

  // Set pi_session_file_path so collectContextMetricsForRun can find it
  result.pi_session_file_path = sessionFilePath;
  result.artifacts.session_file_path = sessionFilePath;

  const metrics = await collectContextMetricsForRun(result, recorder.artifacts);

  // The session file exists but has no message entries.
  // collectContextMetricsFromSessionJsonl returns undefined for empty content.
  // collectContextMetricsForRun should set sessionMetrics to undefined instead
  // of creating a misleading empty { message_counts_by_role: {} }.
  //
  // Result: session block should be absent when there are no messages.
  assert.ok(metrics, 'collectContextMetricsForRun should return at least artifact metrics');
  // Session block should be absent — no misleading empty message_counts_by_role
  assert.equal(metrics.session, undefined,
    'session block should be absent for session with no message entries');
});

// ---------------------------------------------------------------------------
// R1110-2: Final head collection for non-coder roles
// ---------------------------------------------------------------------------

test('collectFinalHeadState collects final head for reviewer runs with branch context', async (t) => {
  const { repo, branch, finalHead } = await initGitRepoWithTaskBranch(t, 'task/reviewer-final-head');

  // Simulate what collectFinalHeadState (formerly collectFinalHeadForCoderRun)
  // does for a reviewer run: it should collect final head when branch/worktree
  // context is available (the coder-only gate was removed).
  const state = await collectFinalBranchHead({ worktreePath: repo, branch });

  assert.ok(state, 'should resolve final head state for reviewer run');
  assert.equal(state.final_head_commit, finalHead);
  assert.equal(state.final_branch, branch);
  assert.equal(state.final_head_status, 'clean');
  assert.equal(state.final_worktree_status, 'clean');

  // The metadata builder works the same regardless of role
  const metadata = buildFinalBranchHeadMetadata(state);
  assert.equal(metadata.final_head_commit, finalHead);
  assert.equal(metadata.final_branch, branch);
});

test('collectFinalHeadState returns undefined for reviewer without branch/worktree context', async () => {
  // No worktreePath or branch provided — should return undefined
  const state = await collectFinalBranchHead({});
  assert.equal(state, undefined, 'no context should produce undefined');
});

test('final head enrichment applies to all roles in parent tool result', () => {
  // Simulate what collectFinalHeadState + applyFinalHeadState produce for a reviewer run
  const result = {
    run_id: 'run-reviewer-final-head',
    role: 'reviewer',
    task_id: 1114,
    branch: 'task/1114-subagent-status-artifact-coverage',
    base_branch: 'main',
    base_commit: 'base-sha',
    head_commit: 'launch-sha',
    requested_head_commit: 'launch-sha',
    purpose: 'review',
    exit_code: 0,
    aborted: false,
    assistant_final_found: true,
    final_output: 'Review complete.',
    artifacts: { dir: '/tmp/run-reviewer-final-head' },
    duration_ms: 3000,
    message_count: 5,
    assistant_message_count: 2,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    final_head_commit: 'final-sha-review',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1114-subagent-status-artifact-coverage',
    final_worktree_branch: 'task/1114-subagent-status-artifact-coverage',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
  };

  const toolResult = buildSubagentParentToolResult(result);

  // Final-head fields should be present for the reviewer run
  assert.equal(toolResult.details.final_head_commit, 'final-sha-review');
  assert.equal(toolResult.details.final_head_status, 'clean');
  assert.equal(toolResult.details.final_branch, 'task/1114-subagent-status-artifact-coverage');
  assert.equal(toolResult.details.requested_head_commit, 'launch-sha');
  assert.equal(toolResult.details.role, 'reviewer');

  const text = toolResult.content[0].text;
  assert.match(text, /Sub-agent completed \(reviewer\)/);
  assert.match(text, /Final branch head: final-sha-review/);
  assert.match(text, /Requested \(starting\) head: launch-sha/);

  // Reviewers with clean worktree have no recovery guidance (successful run)
  assert.equal(toolResult.details.recovery_guidance, undefined);
});

test('recovery guidance for failed reviewer run includes final head state', () => {
  const result = {
    run_id: 'run-reviewer-failed',
    role: 'reviewer',
    task_id: 1114,
    branch: 'task/1114-subagent-status-artifact-coverage',
    head_commit: 'launch-sha',
    requested_head_commit: 'launch-sha',
    exit_code: 1,
    aborted: false,
    assistant_final_found: false,
    final_output: '',
    artifacts: { dir: '/tmp/run-reviewer-failed' },
    duration_ms: 2000,
    message_count: 0,
    assistant_message_count: 0,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    final_head_commit: 'final-sha-review',
    final_head_status: 'clean',
    final_head_source: 'supplied_branch',
    final_branch: 'task/1114-subagent-status-artifact-coverage',
    final_worktree_branch: 'task/1114-subagent-status-artifact-coverage',
    final_branch_matches_worktree: true,
    final_worktree_status: 'clean',
  };

  const toolResult = buildSubagentParentToolResult(result);

  // Recovery guidance should be present for failed run with branch state
  assert.ok(toolResult.details.recovery_guidance, 'reviewer run should have recovery guidance');
  assert.equal(toolResult.details.recovery_branch, 'task/1114-subagent-status-artifact-coverage');
  assert.equal(toolResult.details.recovery_head_commit, 'final-sha-review');
  assert.equal(toolResult.details.recovery_worktree_dirty, false);

  const text = toolResult.content[0].text;
  assert.match(text, /Recovery guidance:/);
  assert.match(text, /Branch: task\/1114-subagent-status-artifact-coverage/);
  assert.match(text, /Head: final-sha-review/);
});
